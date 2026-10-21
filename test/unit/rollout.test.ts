import { describe, expect, it } from "vitest";
import { HEALTH_LIMITS, buildPlan, evaluateHealth, gateEventType, isExecutable, simulateMetrics } from "../../src/shared/rollout";

describe("buildPlan", () => {
  it("puts an approval gate between every traffic increase of a staged rollout", () => {
    const plan = buildPlan("staged_rollout");
    expect(plan.map((s) => s.kind)).toEqual(["run", "gate", "run", "gate", "run"]);
    expect(plan.filter((s) => s.kind === "run").map((s) => s.trafficPercent)).toEqual([5, 25, 100]);
  });

  it("runs retry and rollback as a single step", () => {
    expect(buildPlan("retry").map((s) => s.id)).toEqual(["rerun"]);
    expect(buildPlan("rollback").map((s) => s.id)).toEqual(["rollback"]);
  });

  it("gives every gate its own event type", () => {
    const gates = buildPlan("staged_rollout").filter((s) => s.kind === "gate");
    expect(new Set(gates.map((g) => gateEventType(g.id))).size).toBe(gates.length);
  });

  it("treats fix-forward as not executable", () => {
    expect(isExecutable("fix_forward")).toBe(false);
    expect(isExecutable("rollback")).toBe(true);
  });
});

describe("health", () => {
  it("fails a step that exceeds either limit", () => {
    expect(evaluateHealth({ errorRate: 0.002, p99Ms: 300 }).healthy).toBe(true);
    expect(evaluateHealth({ errorRate: HEALTH_LIMITS.maxErrorRate + 0.001, p99Ms: 300 }).healthy).toBe(false);
    expect(evaluateHealth({ errorRate: 0.002, p99Ms: HEALTH_LIMITS.maxP99Ms + 1 }).healthy).toBe(false);
  });

  it("simulates healthy metrics except at the chosen failure step, deterministically", () => {
    for (const s of buildPlan("staged_rollout").filter((s) => s.kind === "run")) {
      expect(evaluateHealth(simulateMetrics(s.id)).healthy).toBe(true);
      expect(evaluateHealth(simulateMetrics(s.id, s.id)).healthy).toBe(false);
      expect(simulateMetrics(s.id)).toEqual(simulateMetrics(s.id));
    }
  });
});
