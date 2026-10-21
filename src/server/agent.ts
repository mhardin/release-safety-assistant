import { Agent, callable } from "agents";
import {
  AUTO_ROLLBACK,
  buildPlan,
  gateEventType,
  isExecutable,
  type GateDecision,
  type RolloutOutcome,
  type RolloutParams,
  type RolloutProgress,
  type RolloutState,
} from "../shared/rollout";
import { clip } from "../shared/text";
import type { Action, AgentState, ChatMessage, KnownPattern, LlmVerdict, RuleResult, Verdict } from "../shared/types";
import { combineVerdict } from "../triage/combine";
import { HISTORY_WINDOW_DAYS, applyHistory, summarizeHistory, type PastIncident } from "../triage/history";
import { classifyWithLlm } from "../triage/llm";
import { extractSignals } from "../triage/rules";

const MAX_MESSAGES = 50;
/** Workflow binding name in wrangler.jsonc. */
const WORKFLOW = "ROLLOUT_WORKFLOW";

/** One row of per-service failure history in the agent's SQLite database. */
export interface IncidentRow {
  id: string;
  created_at: number;
  kind: string;
  cause: string;
  confidence: number;
  action: string;
  signature: string;
  summary: string;
  outcome: string | null;
}

/**
 * ReleaseAgent is a Durable Object: Cloudflare runs exactly one instance per
 * name, and the client connects with the service name (e.g. "checkout-api"),
 * so each service gets its own chat, state, and SQLite history.
 *
 * - `this.state` / `setState` holds the chat transcript and the active rollout,
 *   and is pushed to every connected browser over the agent's WebSocket.
 * - `this.sql` is the Durable Object's embedded SQLite database, used for the
 *   longer-lived incident history.
 * - Actions (retry, rollback, staged rollout) run as a RolloutWorkflow; the
 *   Workflow reports back through the onWorkflow* callbacks below.
 */
export class ReleaseAgent extends Agent<Env, AgentState> {
  initialState: AgentState = { service: "", messages: [], busy: false, rollout: null };

  /**
   * The LLM step. Kept as a field so integration tests can swap in a fake
   * instead of calling Workers AI (which needs a Cloudflare login and isn't deterministic).
   */
  classify: (input: string, rules: RuleResult, history: KnownPattern | null) => Promise<LlmVerdict | null> = (
    input,
    rules,
    history,
  ) => classifyWithLlm(this.env.AI, input, rules, history);

  async onStart() {
    this.sql`CREATE TABLE IF NOT EXISTS incidents (
      id TEXT PRIMARY KEY,
      created_at INTEGER NOT NULL,
      kind TEXT NOT NULL,
      cause TEXT NOT NULL,
      confidence REAL NOT NULL,
      action TEXT NOT NULL,
      signature TEXT NOT NULL,
      summary TEXT NOT NULL,
      outcome TEXT
    )`;
    this.sql`CREATE INDEX IF NOT EXISTS incidents_by_signature ON incidents (signature, created_at)`;
    if (!this.state.service) this.setState({ ...this.state, service: this.name });

    // A Durable Object can be restarted mid-triage (deploy, eviction, crash).
    // `busy` is persisted, so without this the UI would stay locked forever.
    if (this.state.busy) {
      this.addMessage({ role: "assistant", text: "The previous triage was interrupted before it finished. Please submit it again." }, false);
    }
    // Rollouts need no equivalent here: the Workflow keeps running on its own.
    // If its final callback is lost, startAction reconciles with the platform.
  }

  // ---- Triage ---------------------------------------------------------------

  /** Triage a pasted log or change description. Called from the browser over RPC. */
  @callable()
  async triage(input: string): Promise<Verdict> {
    const text = input.trim();
    if (!text) throw new Error("Paste a log or describe a change.");
    // A Durable Object only serializes storage work: while one triage awaits
    // the model, another request can run. Allow one triage at a time.
    if (this.state.busy) throw new Error("A triage is already running for this service; wait for it to finish.");

    // Chat state is broadcast in full on every change, so keep stored logs small.
    this.addMessage({ role: "user", text: clip(text, 1_000, 4_000) }, true);
    try {
      const rules = extractSignals(text);
      // Looked up before this incident is stored, so it only sees earlier ones.
      const pattern = this.knownPattern(rules.signature);
      const llm = await this.classify(text, rules, pattern);
      const incidentId = crypto.randomUUID();
      const verdict: Verdict = { ...applyHistory(combineVerdict(rules, llm), pattern), incidentId };

      this.sql`INSERT INTO incidents (id, created_at, kind, cause, confidence, action, signature, summary)
        VALUES (${incidentId}, ${Date.now()}, ${verdict.kind}, ${verdict.cause}, ${verdict.confidence},
                ${verdict.action}, ${verdict.signature}, ${summarize(text)})`;

      this.addMessage({ role: "assistant", text: verdict.reasoning, verdict }, false);
      return verdict;
    } catch (err) {
      this.addMessage({ role: "assistant", text: `Triage failed: ${(err as Error).message}` }, false);
      throw err;
    }
  }

  /** Most recent incidents for this service, newest first. */
  @callable()
  async history(limit = 20): Promise<IncidentRow[]> {
    const n = Math.min(Math.max(1, Math.floor(limit) || 1), 100);
    return this.sql<IncidentRow>`SELECT * FROM incidents ORDER BY created_at DESC LIMIT ${n}`;
  }

  /** Earlier incidents of this service with the same failure signature. */
  private knownPattern(signature: string): KnownPattern | null {
    if (signature === "none") return null;
    const since = Date.now() - HISTORY_WINDOW_DAYS * 24 * 60 * 60 * 1000;
    const past = this.sql<PastIncident>`SELECT action, outcome, created_at FROM incidents
      WHERE signature = ${signature} AND created_at > ${since} ORDER BY created_at DESC LIMIT 50`;
    return summarizeHistory(signature, past);
  }

  // ---- Executing the recommended action -------------------------------------

  /**
   * Start the Workflow for an incident's recommended action. One rollout per
   * service at a time. `failAt` simulates a failing health check at that step.
   */
  @callable()
  async startAction(incidentId: string, failAt?: string): Promise<string> {
    const [incident] = this.sql<IncidentRow>`SELECT * FROM incidents WHERE id = ${incidentId}`;
    if (!incident) throw new Error("Unknown incident.");
    const action = incident.action as Action;
    if (!isExecutable(action)) throw new Error("Fix forward happens on the branch; there is nothing to execute.");
    if (this.state.rollout && !this.state.rollout.outcome) await this.reconcileRollout(this.state.rollout);
    if (this.state.rollout && !this.state.rollout.outcome) throw new Error("A rollout is already in progress for this service.");

    const plan = buildPlan(action);
    if (failAt && !plan.some((s) => s.id === failAt && s.kind === "run")) throw new Error(`Unknown step "${failAt}".`);

    // Record the rollout before starting the Workflow, so progress callbacks
    // that arrive while runWorkflow is still awaiting have state to update.
    const instanceId = `rollout-${crypto.randomUUID()}`;
    const previous = this.state.rollout ?? null;
    const rollout: RolloutState = {
      instanceId,
      incidentId,
      action,
      failAt: failAt ?? null,
      steps: plan.map((s) => ({ ...s, status: "pending" })),
      pendingGate: null,
      outcome: null,
      startedAt: Date.now(),
    };
    this.setState({ ...this.state, rollout });

    try {
      const params: RolloutParams = { incidentId, action, ...(failAt ? { failAt } : {}) };
      await this.runWorkflow(WORKFLOW, params, { id: instanceId, metadata: { incidentId } });
    } catch (err) {
      this.setState({ ...this.state, rollout: previous });
      throw err;
    }
    return instanceId;
  }

  /** Approve or reject the gate the rollout is currently waiting at. */
  @callable()
  async decideGate(gateId: string, approved: boolean): Promise<void> {
    const rollout = this.state.rollout;
    if (!rollout || rollout.outcome || rollout.pendingGate !== gateId) {
      throw new Error("That gate is not waiting for a decision.");
    }
    // Clear the pending gate before sending, so a double-click can't send twice.
    this.setState({ ...this.state, rollout: { ...rollout, pendingGate: null } });
    const decision: GateDecision = { approved };
    try {
      await this.sendWorkflowEvent(WORKFLOW, rollout.instanceId, { type: gateEventType(gateId), payload: decision });
    } catch (err) {
      // The Workflow is still waiting: reopen the gate so the decision can be retried.
      const current = this.currentRollout(rollout.instanceId);
      if (current && !current.outcome) this.setState({ ...this.state, rollout: { ...current, pendingGate: gateId } });
      throw err;
    }
  }

  /**
   * Workflow callbacks are best-effort. If the final one was lost, the rollout
   * would look active forever, so ask the platform for the instance's real
   * status. Skipped for young rollouts, whose instance may not exist yet.
   */
  private async reconcileRollout(rollout: RolloutState) {
    if (Date.now() - rollout.startedAt < 60_000) return;
    let status: string;
    let output: unknown;
    try {
      ({ status, output } = await (await this.env.ROLLOUT_WORKFLOW.get(rollout.instanceId)).status());
    } catch {
      status = "not found";
    }
    if (status === "complete" && output) {
      this.finishRollout(rollout.instanceId, output as RolloutOutcome);
    } else if (["errored", "terminated", "complete", "not found"].includes(status)) {
      this.finishRollout(rollout.instanceId, { result: "failed", detail: `The workflow ended (${status}) without reporting back.` });
    }
  }

  // ---- Workflow callbacks ---------------------------------------------------

  async onWorkflowProgress(_workflowName: string, workflowId: string, progress: unknown): Promise<void> {
    const rollout = this.currentRollout(workflowId);
    if (!rollout) return;
    const p = progress as RolloutProgress;

    const known = rollout.steps.some((s) => s.id === p.stepId);
    if (!known && p.stepId !== AUTO_ROLLBACK.id) return;
    const steps = known
      ? rollout.steps.map((s) => (s.id === p.stepId ? { ...s, status: p.status, health: p.health ?? s.health } : s))
      : [...rollout.steps, { ...AUTO_ROLLBACK, status: p.status, health: p.health }];

    // A "waiting" report opens that gate; any later report about it closes it.
    const pendingGate = p.status === "waiting" ? p.stepId : rollout.pendingGate === p.stepId ? null : rollout.pendingGate;
    this.setState({ ...this.state, rollout: { ...rollout, steps, pendingGate } });
  }

  async onWorkflowComplete(_workflowName: string, workflowId: string, result?: unknown): Promise<void> {
    this.finishRollout(workflowId, result as RolloutOutcome);
  }

  async onWorkflowError(_workflowName: string, workflowId: string, error: string): Promise<void> {
    this.finishRollout(workflowId, { result: "failed", detail: `The workflow failed: ${error}` });
  }

  private finishRollout(workflowId: string, outcome: RolloutOutcome) {
    const rollout = this.currentRollout(workflowId);
    if (!rollout || rollout.outcome) return; // already recorded (callbacks can repeat)

    // The outcome is what makes history useful: did the recommended action work?
    this.sql`UPDATE incidents SET outcome = ${outcome.result} WHERE id = ${rollout.incidentId}`;
    this.setState({ ...this.state, rollout: { ...rollout, outcome, pendingGate: null } });
    this.addMessage({ role: "assistant", text: `${ACTION_NAMES[rollout.action]} ${outcome.result.replace("_", " ")}: ${outcome.detail}` });
  }

  private currentRollout(workflowId: string): RolloutState | null {
    const rollout = this.state.rollout;
    return rollout && rollout.instanceId === workflowId ? rollout : null;
  }

  private addMessage(msg: Omit<ChatMessage, "id" | "at">, busy = this.state.busy) {
    const messages = [...this.state.messages, { ...msg, id: crypto.randomUUID(), at: Date.now() }].slice(-MAX_MESSAGES);
    this.setState({ ...this.state, messages, busy });
  }
}

const ACTION_NAMES: Record<RolloutState["action"], string> = {
  retry: "Retry",
  rollback: "Rollback",
  staged_rollout: "Staged rollout",
};

/** First meaningful line of the input, for compact history rows. */
function summarize(text: string): string {
  const line = text.split(/\r?\n/).find((l) => /error|fail|exception/i.test(l)) ?? text.split(/\r?\n/)[0];
  return line.trim().slice(0, 160);
}
