import { useState } from "react";
import { HEALTH_LIMITS, buildPlan, type RolloutState, type RolloutStepView, type StepStatus } from "../shared/rollout";
import type { Verdict } from "../shared/types";

const START_LABEL = {
  retry: "Retry the job",
  rollback: "Roll back",
  staged_rollout: "Start staged rollout",
} as const;

/** Buttons under the latest verdict: start its recommended action, optionally simulating a failure. */
export function ActionControls({
  verdict,
  disabled,
  onStart,
}: {
  verdict: Verdict;
  disabled: boolean;
  onStart: (failAt?: string) => void;
}) {
  const [failAt, setFailAt] = useState("");

  if (verdict.action === "fix_forward") {
    return (
      <p className="guidance">
        {verdict.cause === "change"
          ? "This failed in pre-merge CI and points at the change, so there's nothing to roll back. Fix it on the branch"
          : "Retrying hasn't fixed this before, so don't merge on a retry. Find the cause (or escalate the environment issue)"}{" "}
        and keep the merge blocked until CI is green.
      </p>
    );
  }

  const runSteps = buildPlan(verdict.action).filter((s) => s.kind === "run");
  return (
    <div className="action-controls">
      <button type="button" className="primary" disabled={disabled} onClick={() => onStart(failAt || undefined)}>
        {START_LABEL[verdict.action]}
      </button>
      <label>
        Simulate{" "}
        <select value={failAt} onChange={(e) => setFailAt(e.target.value)} disabled={disabled}>
          <option value="">all checks healthy</option>
          {runSteps.map((s) => (
            <option key={s.id} value={s.id}>
              failure at {stepName(s)}
            </option>
          ))}
        </select>
      </label>
    </div>
  );
}

const STATUS_ICON: Record<StepStatus, string> = {
  pending: "○",
  running: "◐",
  waiting: "⏸",
  passed: "✓",
  approved: "✓",
  failed: "✗",
  rejected: "✗",
};

/** Live view of the current rollout: each step's status and health, and approval buttons at gates. */
export function RolloutPanel({
  rollout,
  onDecide,
}: {
  rollout: RolloutState;
  onDecide: (gateId: string, approved: boolean) => void;
}) {
  const title = { retry: "Retry", rollback: "Rollback", staged_rollout: "Staged rollout" }[rollout.action];
  return (
    <section className={`rollout ${rollout.outcome ? `done result-${rollout.outcome.result}` : ""}`} aria-live="polite">
      <div className="rollout-head">
        <strong>{title}</strong>
        <span className="muted">{rollout.outcome ? rollout.outcome.result.replace("_", " ") : "in progress"}</span>
        {rollout.failAt && <span className="muted">· simulating failure at {rollout.failAt}</span>}
      </div>
      <ol className="steps">
        {rollout.steps.map((s) => (
          <li key={s.id} className={`step status-${s.status}`}>
            <span className="icon">{STATUS_ICON[s.status]}</span>
            <span className="label">{stepName(s)}</span>
            {s.health && <HealthBadge step={s} />}
            {rollout.pendingGate === s.id && (
              <span className="gate-buttons">
                <button type="button" className="primary" onClick={() => onDecide(s.id, true)}>Approve</button>
                <button type="button" onClick={() => onDecide(s.id, false)}>Reject</button>
              </span>
            )}
          </li>
        ))}
      </ol>
      {rollout.outcome && <p className="outcome">{rollout.outcome.detail}</p>}
    </section>
  );
}

function HealthBadge({ step }: { step: RolloutStepView }) {
  const h = step.health!;
  return (
    <span className={`health ${h.healthy ? "ok" : "bad"}`}
      title={`Limits: error rate ≤ ${HEALTH_LIMITS.maxErrorRate * 100}%, p99 ≤ ${HEALTH_LIMITS.maxP99Ms}ms`}>
      {(h.errorRate * 100).toFixed(1)}% errors · p99 {h.p99Ms}ms
    </span>
  );
}

function stepName(s: { label: string; trafficPercent?: number }) {
  return s.trafficPercent ? `${s.label} (${s.trafficPercent}%)` : s.label;
}
