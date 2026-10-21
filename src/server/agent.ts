import { Agent, callable } from "agents";
import { clip } from "../shared/text";
import type { AgentState, ChatMessage, LlmVerdict, RuleResult, Verdict } from "../shared/types";
import { combineVerdict } from "../triage/combine";
import { classifyWithLlm } from "../triage/llm";
import { extractSignals } from "../triage/rules";

const MAX_MESSAGES = 50;

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
 * - `this.state` / `setState` holds the chat transcript and is pushed to every
 *   connected browser over the agent's WebSocket.
 * - `this.sql` is the Durable Object's embedded SQLite database, used for the
 *   longer-lived incident history.
 */
export class ReleaseAgent extends Agent<Env, AgentState> {
  initialState: AgentState = { service: "", messages: [], busy: false };

  /**
   * The LLM step. Kept as a field so integration tests can swap in a fake
   * instead of calling Workers AI (which needs a Cloudflare login and isn't deterministic).
   */
  classify: (input: string, rules: RuleResult) => Promise<LlmVerdict | null> = (input, rules) =>
    classifyWithLlm(this.env.AI, input, rules);

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
    if (!this.state.service) this.setState({ ...this.state, service: this.name });

    // A Durable Object can be restarted mid-triage (deploy, eviction, crash).
    // `busy` is persisted, so without this the UI would stay locked forever.
    if (this.state.busy) {
      this.addMessage({ role: "assistant", text: "The previous triage was interrupted before it finished. Please submit it again." }, false);
    }
  }

  /** Triage a pasted log or change description. Called from the browser over RPC. */
  @callable()
  async triage(input: string): Promise<Verdict> {
    const text = input.trim();
    if (!text) throw new Error("Paste a log or describe a change.");

    // Chat state is broadcast in full on every change, so keep stored logs small.
    this.addMessage({ role: "user", text: clip(text, 1_000, 4_000) }, true);
    try {
      const rules = extractSignals(text);
      const llm = await this.classify(text, rules);
      const verdict = combineVerdict(rules, llm);

      this.sql`INSERT INTO incidents (id, created_at, kind, cause, confidence, action, signature, summary)
        VALUES (${crypto.randomUUID()}, ${Date.now()}, ${verdict.kind}, ${verdict.cause}, ${verdict.confidence},
                ${verdict.action}, ${verdict.signature}, ${summarize(text)})`;

      this.addMessage({ role: "assistant", text: verdict.reasoning, verdict }, false);
      return verdict;
    } catch (err) {
      this.addMessage({ role: "assistant", text: `Triage failed: ${(err as Error).message}` }, false);
      throw err;
    }
  }

  @callable()
  async history(limit = 20): Promise<IncidentRow[]> {
    return this.sql<IncidentRow>`SELECT * FROM incidents ORDER BY created_at DESC LIMIT ${limit}`;
  }

  private addMessage(msg: Omit<ChatMessage, "id" | "at">, busy: boolean) {
    const messages = [...this.state.messages, { ...msg, id: crypto.randomUUID(), at: Date.now() }].slice(-MAX_MESSAGES);
    this.setState({ ...this.state, messages, busy });
  }
}

/** First meaningful line of the input, for compact history rows. */
function summarize(text: string): string {
  const line = text.split(/\r?\n/).find((l) => /error|fail|exception/i.test(l)) ?? text.split(/\r?\n/)[0];
  return line.trim().slice(0, 160);
}
