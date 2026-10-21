import { getAgentByName } from "agents";
import { introspectWorkflow, runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { describe, expect, it, vi } from "vitest";
import type { ReleaseAgent } from "../../src/server/agent";
import type { RolloutState } from "../../src/shared/rollout";
import { SAMPLES } from "../../src/shared/samples";

// The real RolloutWorkflow runs in workerd, started and tracked by a real
// ReleaseAgent. Sleeps are disabled so 10s bake times don't slow the suite.
// Gates are decided through the agent, exactly as the UI does.

let counter = 0;

/** A fresh agent with one triaged incident; the sample decides the recommended action. */
async function agentWithIncident(sample: string) {
  const stub = await getAgentByName(env.ReleaseAgent, `rollout-${++counter}`);
  await runInDurableObject(stub, (agent: ReleaseAgent) => {
    agent.classify = async () => null; // rules only; no AI binding in tests
  });
  const verdict = await stub.triage(sample);
  return { stub, incidentId: verdict.incidentId!, action: verdict.action };
}

const rolloutOf = (stub: DurableObjectStub<ReleaseAgent>) =>
  runInDurableObject(stub, (agent: ReleaseAgent) => agent.state.rollout);

/** Poll agent state until the rollout matches, e.g. reaches a gate or finishes. */
function waitForRollout(stub: DurableObjectStub<ReleaseAgent>, ready: (r: RolloutState) => boolean) {
  return vi.waitFor(
    async () => {
      const r = await rolloutOf(stub);
      if (!r || !ready(r)) throw new Error(`rollout not ready: ${JSON.stringify(r?.steps.map((s) => s.status))}`);
      return r;
    },
    { timeout: 10_000, interval: 25 },
  );
}

const statusOf = (r: RolloutState) => Object.fromEntries(r.steps.map((s) => [s.id, s.status]));

async function workflowsWithoutSleeps() {
  const wf = await introspectWorkflow(env.ROLLOUT_WORKFLOW);
  await wf.modifyAll(async (m) => {
    await m.disableSleeps();
  });
  return wf;
}

describe("staged rollout", () => {
  it("pauses at each gate and completes when both are approved", async () => {
    await using _wf = await workflowsWithoutSleeps();
    const { stub, incidentId, action } = await agentWithIncident(SAMPLES.changeDescription);
    expect(action).toBe("staged_rollout");

    await stub.startAction(incidentId);

    // Canary runs, then the rollout stops and waits for a human.
    let r = await waitForRollout(stub, (r) => r.pendingGate === "promote-25");
    expect(statusOf(r)).toMatchObject({ canary: "passed", "promote-25": "waiting", partial: "pending" });
    expect(r.steps[0].health?.healthy).toBe(true);

    await stub.decideGate("promote-25", true);
    r = await waitForRollout(stub, (r) => r.pendingGate === "promote-100");
    expect(statusOf(r)).toMatchObject({ "promote-25": "approved", partial: "passed", full: "pending" });

    await stub.decideGate("promote-100", true);
    r = await waitForRollout(stub, (r) => !!r.outcome);
    expect(r.outcome?.result).toBe("succeeded");
    expect(statusOf(r)).toEqual({ canary: "passed", "promote-25": "approved", partial: "passed", "promote-100": "approved", full: "passed" });

    // The outcome is written back to the incident history.
    const [incident] = await stub.history();
    expect(incident.outcome).toBe("succeeded");
  });

  it("rolls back when a gate is rejected", async () => {
    await using _wf = await workflowsWithoutSleeps();
    const { stub, incidentId } = await agentWithIncident(SAMPLES.changeDescription);
    await stub.startAction(incidentId);
    await waitForRollout(stub, (r) => r.pendingGate === "promote-25");

    await stub.decideGate("promote-25", false);
    const r = await waitForRollout(stub, (r) => !!r.outcome);

    expect(r.outcome).toMatchObject({ result: "rejected", failedStep: "promote-25" });
    expect(statusOf(r)).toMatchObject({ "promote-25": "rejected", partial: "pending", "auto-rollback": "passed" });
    expect((await stub.history())[0].outcome).toBe("rejected");
  });

  it("rolls back automatically, without asking, when a health check fails", async () => {
    await using _wf = await workflowsWithoutSleeps();
    const { stub, incidentId } = await agentWithIncident(SAMPLES.changeDescription);
    await stub.startAction(incidentId, "partial");

    await waitForRollout(stub, (r) => r.pendingGate === "promote-25");
    await stub.decideGate("promote-25", true);
    const r = await waitForRollout(stub, (r) => !!r.outcome);

    expect(r.outcome).toMatchObject({ result: "rolled_back", failedStep: "partial" });
    expect(r.steps.find((s) => s.id === "partial")?.health).toMatchObject({ healthy: false });
    // The next gate was never offered; rollback ran instead.
    expect(statusOf(r)).toMatchObject({ partial: "failed", "promote-100": "pending", full: "pending", "auto-rollback": "passed" });
  });

  // forceEventTimeout makes the test runtime log "uncaught WorkflowTimeoutError"
  // from its own timer; the workflow does catch it, as the outcome shows.
  it("rolls back when nobody answers a gate before it times out", async () => {
    await using wf = await workflowsWithoutSleeps();
    await wf.modifyAll(async (m) => {
      await m.forceEventTimeout({ name: "gate:promote-25" });
    });
    const { stub, incidentId } = await agentWithIncident(SAMPLES.changeDescription);
    await stub.startAction(incidentId);

    const r = await waitForRollout(stub, (r) => !!r.outcome);
    expect(r.outcome).toMatchObject({ result: "timed_out", failedStep: "promote-25" });
    expect(statusOf(r)).toMatchObject({ "auto-rollback": "passed" });
  });
});

describe("retry", () => {
  it("records success when the job passes on retry", async () => {
    await using _wf = await workflowsWithoutSleeps();
    const { stub, incidentId, action } = await agentWithIncident(SAMPLES.environmentFailure);
    expect(action).toBe("retry");

    await stub.startAction(incidentId);
    const r = await waitForRollout(stub, (r) => !!r.outcome);
    expect(r.outcome?.result).toBe("succeeded");
    expect((await stub.history())[0].outcome).toBe("succeeded");
  });

  it("records failure when the job fails again, with no rollback for a retry", async () => {
    await using _wf = await workflowsWithoutSleeps();
    const { stub, incidentId } = await agentWithIncident(SAMPLES.environmentFailure);
    await stub.startAction(incidentId, "rerun");
    const r = await waitForRollout(stub, (r) => !!r.outcome);
    expect(r.outcome?.result).toBe("failed");
    expect(r.steps.map((s) => s.id)).toEqual(["rerun"]);
  });
});

describe("guards", () => {
  // Throwing paths are called inside the object (see agent.test.ts for why).

  it("only accepts a decision for the gate that is currently waiting", async () => {
    await using _wf = await workflowsWithoutSleeps();
    const { stub, incidentId } = await agentWithIncident(SAMPLES.changeDescription);
    await stub.startAction(incidentId);
    await waitForRollout(stub, (r) => r.pendingGate === "promote-25");

    await runInDurableObject(stub, async (agent: ReleaseAgent) => {
      await expect(agent.decideGate("promote-100", true)).rejects.toThrow(/not waiting/);
      await agent.decideGate("promote-25", true);
      // A second click on the same gate is refused instead of approving the next one.
      await expect(agent.decideGate("promote-25", true)).rejects.toThrow(/not waiting/);
    });
  });

  it("allows one rollout per service at a time", async () => {
    await using _wf = await workflowsWithoutSleeps();
    const { stub, incidentId } = await agentWithIncident(SAMPLES.changeDescription);
    await stub.startAction(incidentId);
    await runInDurableObject(stub, (agent: ReleaseAgent) =>
      expect(agent.startAction(incidentId)).rejects.toThrow(/already in progress/),
    );
  });

  it("has nothing to execute for fix-forward", async () => {
    const { stub, incidentId, action } = await agentWithIncident(SAMPLES.changeFailure);
    expect(action).toBe("fix_forward");
    await runInDurableObject(stub, (agent: ReleaseAgent) =>
      expect(agent.startAction(incidentId)).rejects.toThrow(/nothing to execute/),
    );
  });

  it("rejects an unknown step to simulate failure at", async () => {
    const { stub, incidentId } = await agentWithIncident(SAMPLES.changeDescription);
    await runInDurableObject(stub, (agent: ReleaseAgent) =>
      expect(agent.startAction(incidentId, "promote-25")).rejects.toThrow(/Unknown step/),
    );
  });
});

describe("callbacks and recovery", () => {
  it("records a Workflow error and allows a new rollout afterwards", async () => {
    await using _wf = await workflowsWithoutSleeps();
    const { stub, incidentId } = await agentWithIncident(SAMPLES.changeDescription);
    await stub.startAction(incidentId);
    const r = await waitForRollout(stub, (r) => r.pendingGate === "promote-25");

    await runInDurableObject(stub, (agent: ReleaseAgent) => agent.onWorkflowError("ROLLOUT_WORKFLOW", r.instanceId, "boom"));

    const after = await rolloutOf(stub);
    expect(after?.outcome).toMatchObject({ result: "failed", detail: expect.stringContaining("boom") });
    expect((await stub.history())[0].outcome).toBe("failed");
    expect(await stub.startAction(incidentId)).not.toBe(r.instanceId);
  });

  it("ignores callbacks for other rollouts and unknown steps", async () => {
    await using _wf = await workflowsWithoutSleeps();
    const { stub, incidentId } = await agentWithIncident(SAMPLES.changeDescription);
    await stub.startAction(incidentId);
    const before = await waitForRollout(stub, (r) => r.pendingGate === "promote-25");

    const after = await runInDurableObject(stub, async (agent: ReleaseAgent) => {
      await agent.onWorkflowProgress("ROLLOUT_WORKFLOW", "rollout-other", { stepId: "canary", status: "failed" });
      await agent.onWorkflowComplete("ROLLOUT_WORKFLOW", "rollout-other", { result: "succeeded", detail: "x" });
      await agent.onWorkflowProgress("ROLLOUT_WORKFLOW", before.instanceId, { stepId: "mystery", status: "running" });
      return agent.state.rollout;
    });
    expect(after).toEqual(before);
  });

  it("reopens the gate if the decision can't be delivered", async () => {
    await using _wf = await workflowsWithoutSleeps();
    const { stub, incidentId } = await agentWithIncident(SAMPLES.changeDescription);
    await stub.startAction(incidentId);
    await waitForRollout(stub, (r) => r.pendingGate === "promote-25");

    const pendingGate = await runInDurableObject(stub, async (agent: ReleaseAgent) => {
      agent.sendWorkflowEvent = async () => {
        throw new Error("network down");
      };
      await expect(agent.decideGate("promote-25", true)).rejects.toThrow("network down");
      return agent.state.rollout?.pendingGate;
    });
    expect(pendingGate).toBe("promote-25"); // the user can try again instead of waiting for the timeout
  });

  // Looking up an instance that never existed makes the local Workflows engine
  // log "Engine was never started" / "instance.not_found"; the agent catches it.
  it("clears a rollout whose Workflow ended without reporting back", async () => {
    const { stub, incidentId } = await agentWithIncident(SAMPLES.changeDescription);
    await runInDurableObject(stub, (agent: ReleaseAgent) => {
      // A rollout from two minutes ago whose final callback never arrived.
      agent.setState({
        ...agent.state,
        rollout: {
          instanceId: "rollout-lost",
          incidentId,
          action: "staged_rollout",
          failAt: null,
          steps: [],
          pendingGate: null,
          outcome: null,
          startedAt: Date.now() - 120_000,
        },
      });
    });

    await using _wf = await workflowsWithoutSleeps();
    const id = await stub.startAction(incidentId); // no "already in progress"
    expect(id).not.toBe("rollout-lost");
    const messages = await runInDurableObject(stub, (agent: ReleaseAgent) => agent.state.messages.map((m) => m.text));
    expect(messages.some((t) => t.includes("without reporting back"))).toBe(true);
  });
});
