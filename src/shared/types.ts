// Types shared by the Worker (agent, triage, workflow) and the React client.

import type { RolloutState } from "./rollout";

/** Where the failure most likely came from. */
export type Cause = "change" | "environment" | "unknown";

/** What the developer pasted: a failing log, or a description of a change to ship. */
export type InputKind = "failure_log" | "change_description";

/** Where a failure happened: pre-merge CI, or a deploy to a live environment. */
export type PipelineStage = "ci" | "deploy";

/**
 * retry: re-run the failed job or deploy step.
 * rollback: return a live environment to the previous version.
 * fix_forward: a pre-merge CI failure caused by the change; nothing is
 *   deployed, so the fix is a new commit and the merge stays blocked.
 * staged_rollout: ship a change through canary -> 25% -> 100% with gates.
 */
export type Action = "retry" | "rollback" | "fix_forward" | "staged_rollout";

/** One piece of evidence found by a deterministic rule. */
export interface Signal {
  rule: string; // stable rule id, e.g. "network"
  cause: Exclude<Cause, "unknown">;
  weight: number; // how strongly this rule points at its cause
  line: string; // the log line that matched (trimmed)
}

export interface RuleResult {
  kind: InputKind;
  stage: PipelineStage;
  signals: Signal[];
  /** Normalized fingerprint of the top signal, used to find repeat failures. */
  signature: string;
  /** Lines that look like instructions to the AI (possible prompt injection). */
  suspicious: string[];
}

/** What we accept back from the LLM after validation. */
export interface LlmVerdict {
  kind: InputKind;
  cause: Cause;
  confidence: number; // 0..1
  evidence: string[];
  reasoning: string;
}

/** Final triage result shown to the developer and stored in history. */
export interface Verdict {
  kind: InputKind;
  stage: PipelineStage;
  cause: Cause;
  confidence: number; // 0..1
  action: Action;
  evidence: string[];
  reasoning: string;
  signature: string;
  source: "rules" | "llm" | "rules+llm";
  /** Set by the agent once the verdict is stored; used to act on it. */
  incidentId?: string;
  /** Earlier incidents with the same signature for this service, if any. */
  history?: KnownPattern;
}

/** What this service's history says about a failure signature. */
export interface KnownPattern {
  signature: string;
  occurrences: number; // earlier incidents with this signature, in the window
  lastSeen: number; // epoch ms
  retriesSucceeded: number;
  retriesFailed: number;
  label: "flaky" | "persistent" | "recurring";
}

export interface ChatMessage {
  id: string;
  role: "user" | "assistant";
  text: string;
  verdict?: Verdict;
  at: number; // epoch ms
}

/** Agent state, synced to every connected client. */
export interface AgentState {
  service: string;
  messages: ChatMessage[];
  busy: boolean;
  /** The current or most recent rollout for this service. */
  rollout: RolloutState | null;
}
