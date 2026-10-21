// Types shared by the Worker (agent, triage, workflow) and the React client.

/** Where the failure most likely came from. */
export type Cause = "change" | "environment" | "unknown";

/** What the developer pasted: a failing log, or a description of a change to ship. */
export type InputKind = "failure_log" | "change_description";

export type Action = "retry" | "rollback" | "staged_rollout";

/** One piece of evidence found by a deterministic rule. */
export interface Signal {
  rule: string; // stable rule id, e.g. "network"
  cause: Exclude<Cause, "unknown">;
  weight: number; // how strongly this rule points at its cause
  line: string; // the log line that matched (trimmed)
}

export interface RuleResult {
  kind: InputKind;
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
  cause: Cause;
  confidence: number; // 0..1
  action: Action;
  evidence: string[];
  reasoning: string;
  signature: string;
  source: "rules" | "llm" | "rules+llm";
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
}
