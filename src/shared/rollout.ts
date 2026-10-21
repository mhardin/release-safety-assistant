import type { Action } from "./types";

// Pure rollout model shared by the Workflow (which executes it), the Agent
// (which tracks it in state), and the UI (which renders it).

/** Actions the Workflow can execute. fix_forward is a code change, not an operation. */
export type ExecutableAction = Exclude<Action, "fix_forward">;

export interface PlanStep {
  id: string;
  label: string;
  /** run: change something, then check health. gate: wait for a human decision. */
  kind: "run" | "gate";
  trafficPercent?: number;
}

export function buildPlan(action: ExecutableAction): PlanStep[] {
  switch (action) {
    case "retry":
      return [{ id: "rerun", label: "Re-run the failed job", kind: "run" }];
    case "rollback":
      return [{ id: "rollback", label: "Roll back to the previous version", kind: "run" }];
    case "staged_rollout":
      return [
        { id: "canary", label: "Canary", kind: "run", trafficPercent: 5 },
        { id: "promote-25", label: "Approve promotion to 25%", kind: "gate" },
        { id: "partial", label: "Partial", kind: "run", trafficPercent: 25 },
        { id: "promote-100", label: "Approve promotion to 100%", kind: "gate" },
        { id: "full", label: "Full", kind: "run", trafficPercent: 100 },
      ];
  }
}

/** Run when a staged rollout fails a health check or a gate is rejected or times out. */
export const AUTO_ROLLBACK: PlanStep = { id: "auto-rollback", label: "Automatic rollback", kind: "run" };

export function isExecutable(action: Action): action is ExecutableAction {
  return action !== "fix_forward";
}

/** Each gate gets its own event type, so a stray approval can't be consumed by a later gate. */
export function gateEventType(gateId: string): string {
  return `gate-${gateId}`;
}

// ---- Health checks ----------------------------------------------------------

export interface Metrics {
  errorRate: number; // fraction of requests failing
  p99Ms: number;
}

export interface Health extends Metrics {
  healthy: boolean;
}

export const HEALTH_LIMITS = { maxErrorRate: 0.01, maxP99Ms: 800 };

export function evaluateHealth(m: Metrics): Health {
  return { ...m, healthy: m.errorRate <= HEALTH_LIMITS.maxErrorRate && m.p99Ms <= HEALTH_LIMITS.maxP99Ms };
}

/**
 * Stand-in for querying real metrics after a step bakes. Deterministic so
 * demos and tests are repeatable; `failAt` lets the UI simulate a bad step.
 */
export function simulateMetrics(stepId: string, failAt?: string): Metrics {
  const jitter = [...stepId].reduce((n, c) => n + c.charCodeAt(0), 0) % 7; // stable per step
  if (stepId === failAt) return { errorRate: 0.062, p99Ms: 1_450 + jitter * 10 };
  return { errorRate: 0.002 + jitter / 10_000, p99Ms: 310 + jitter * 12 };
}

// ---- State shared with the UI -----------------------------------------------

export type StepStatus = "pending" | "running" | "waiting" | "passed" | "failed" | "approved" | "rejected";

export interface RolloutStepView extends PlanStep {
  status: StepStatus;
  health?: Health;
}

/** What the Workflow reports to the Agent as it goes. */
export interface RolloutProgress {
  stepId: string;
  status: StepStatus;
  health?: Health;
}

export interface RolloutParams {
  incidentId: string;
  action: ExecutableAction;
  failAt?: string;
}

export interface GateDecision {
  approved: boolean;
}

export type RolloutResult = "succeeded" | "failed" | "rolled_back" | "rejected" | "timed_out";

export interface RolloutOutcome {
  result: RolloutResult;
  detail: string;
  failedStep?: string;
}

export interface RolloutState {
  instanceId: string;
  incidentId: string;
  action: ExecutableAction;
  failAt: string | null;
  steps: RolloutStepView[];
  /** The gate currently waiting for a decision, if any. */
  pendingGate: string | null;
  outcome: RolloutOutcome | null;
  startedAt: number;
}
