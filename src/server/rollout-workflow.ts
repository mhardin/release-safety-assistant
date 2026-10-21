import { AgentWorkflow, type AgentWorkflowEvent, type AgentWorkflowStep } from "agents/workflows";
import {
  AUTO_ROLLBACK,
  buildPlan,
  evaluateHealth,
  gateEventType,
  simulateMetrics,
  type ExecutableAction,
  type GateDecision,
  type Health,
  type PlanStep,
  type RolloutOutcome,
  type RolloutParams,
  type RolloutProgress,
} from "../shared/rollout";
import type { ReleaseAgent } from "./agent";

// How long each step runs before its health is checked. Short for demos; a
// real canary would bake for many minutes.
export const BAKE_TIME = "10 seconds";
// An unanswered gate rolls back rather than leaving traffic half-shifted forever.
export const GATE_TIMEOUT = "1 hour";

/**
 * Executes a retry, rollback, or staged rollout as a durable Workflow.
 *
 * Each `step.do` result is persisted, so if the Workflow is interrupted it
 * resumes after the last completed step instead of re-applying changes. While
 * waiting at a gate it consumes no compute. Code outside steps (like
 * progress reports) can run again on replay; that's safe, though the UI may
 * briefly show an older status.
 *
 * Deploys and metrics are simulated; `apply:*` is where a real deploy API call would go.
 */
export class RolloutWorkflow extends AgentWorkflow<ReleaseAgent, RolloutParams, RolloutProgress> {
  async run(event: AgentWorkflowEvent<RolloutParams>, step: AgentWorkflowStep): Promise<RolloutOutcome> {
    const { action, failAt } = event.payload;
    const outcome = await this.execute(action, failAt, step);
    await step.reportComplete(outcome);
    return outcome;
  }

  private async execute(action: ExecutableAction, failAt: string | undefined, step: AgentWorkflowStep): Promise<RolloutOutcome> {
    for (const s of buildPlan(action)) {
      if (s.kind === "gate") {
        await this.progress({ stepId: s.id, status: "waiting" });
        const decision = await this.waitForGate(step, s.id);
        await this.progress({ stepId: s.id, status: decision === "approved" ? "approved" : "rejected" });
        if (decision !== "approved") {
          await this.autoRollback(step);
          return {
            result: decision,
            failedStep: s.id,
            detail: decision === "rejected" ? "Promotion was rejected; rolled back." : `No decision within ${GATE_TIMEOUT}; rolled back.`,
          };
        }
        continue;
      }

      await this.progress({ stepId: s.id, status: "running" });
      const health = await this.runAndCheck(step, s, failAt);
      await this.progress({ stepId: s.id, status: health.healthy ? "passed" : "failed", health });

      if (!health.healthy) {
        // Health failures roll back without waiting for a human: safety actions shouldn't need approval.
        if (action === "staged_rollout") {
          await this.autoRollback(step);
          return { result: "rolled_back", failedStep: s.id, detail: `${s.label} failed its health check; rolled back automatically.` };
        }
        return {
          result: "failed",
          failedStep: s.id,
          detail: action === "retry"
            ? "The job failed again on retry, so this is probably not a transient environment issue."
            : "The service is still unhealthy after rolling back.",
        };
      }
    }

    const success: Record<ExecutableAction, string> = {
      retry: "The job passed on retry, which points to a transient environment issue.",
      rollback: "Rolled back; the service is healthy on the previous version.",
      staged_rollout: "Rolled out to 100% with all health checks passing.",
    };
    return { result: "succeeded", detail: success[action] };
  }

  private async runAndCheck(step: AgentWorkflowStep, s: PlanStep, failAt?: string): Promise<Health> {
    await step.do(`apply:${s.id}`, async () => ({ applied: s.id, trafficPercent: s.trafficPercent ?? null }));
    await step.sleep(`bake:${s.id}`, BAKE_TIME);
    return step.do(`health:${s.id}`, async () => evaluateHealth(simulateMetrics(s.id, failAt)));
  }

  private async autoRollback(step: AgentWorkflowStep) {
    await this.progress({ stepId: AUTO_ROLLBACK.id, status: "running" });
    const health = await this.runAndCheck(step, AUTO_ROLLBACK);
    await this.progress({ stepId: AUTO_ROLLBACK.id, status: health.healthy ? "passed" : "failed", health });
  }

  /**
   * Progress only drives the UI. It's an RPC to the agent outside any step, so
   * a failure here would otherwise fail the Workflow mid-rollout, skipping the
   * automatic rollback. Log and carry on instead.
   */
  private async progress(p: RolloutProgress) {
    try {
      await this.reportProgress(p);
    } catch (err) {
      console.warn("Progress report failed", err);
    }
  }

  private async waitForGate(step: AgentWorkflowStep, gateId: string): Promise<"approved" | "rejected" | "timed_out"> {
    try {
      const event = await step.waitForEvent<GateDecision>(`gate:${gateId}`, { type: gateEventType(gateId), timeout: GATE_TIMEOUT });
      return event.payload.approved ? "approved" : "rejected";
    } catch {
      // waitForEvent throws when the timeout expires. Any failure while waiting
      // is treated the same way: no decision, so the caller rolls back.
      return "timed_out";
    }
  }
}
