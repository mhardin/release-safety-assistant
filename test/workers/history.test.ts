import { getAgentByName } from "agents";
import { introspectWorkflow, runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { describe, expect, it, vi } from "vitest";
import type { ReleaseAgent } from "../../src/server/agent";
import { SAMPLES } from "../../src/shared/samples";
import type { KnownPattern } from "../../src/shared/types";
import { extractSignals } from "../../src/triage/rules";

// History built the real way: triage a failure, run the recommended retry
// through the Workflow, and let the outcome land in SQLite. Later triage of
// the same failure for the same service should use it.

let counter = 0;

async function freshAgent() {
  const stub = await getAgentByName(env.ReleaseAgent, `history-${++counter}`);
  const seen: (KnownPattern | null)[] = [];
  await runInDurableObject(stub, (agent: ReleaseAgent) => {
    agent.classify = async (_input, _rules, history) => {
      seen.push(history); // what the model would have been told
      return null;
    };
  });
  return { stub, seen };
}

/** Triage the same registry timeout, then run its retry to completion. */
async function failAndRetry(stub: DurableObjectStub<ReleaseAgent>, retryFails = false) {
  const verdict = await stub.triage(SAMPLES.environmentFailure);
  await stub.startAction(verdict.incidentId!, retryFails ? "rerun" : undefined);
  await vi.waitFor(
    async () => {
      const r = await runInDurableObject(stub, (agent: ReleaseAgent) => agent.state.rollout);
      if (!r?.outcome) throw new Error("retry still running");
    },
    { timeout: 10_000, interval: 25 },
  );
  return verdict;
}

describe("history-aware triage", () => {
  it("recognizes a failure that retry has fixed before as known flaky", async () => {
    await using wf = await introspectWorkflow(env.ROLLOUT_WORKFLOW);
    await wf.modifyAll(async (m) => {
      await m.disableSleeps();
    });
    const { stub, seen } = await freshAgent();

    const first = await failAndRetry(stub);
    expect(first.history).toBeUndefined();
    await failAndRetry(stub);

    const third = await stub.triage(SAMPLES.environmentFailure);
    expect(third.history).toMatchObject({ occurrences: 2, retriesSucceeded: 2, label: "flaky" });
    expect(third.confidence).toBeGreaterThan(first.confidence);
    expect(third.reasoning).toMatch(/Known flaky pattern/);

    // The model was told too, and only about earlier incidents.
    expect(seen.map((h) => h?.occurrences ?? 0)).toEqual([0, 1, 2]);
  });

  it("warns when retry did not fix the same failure last time", async () => {
    await using wf = await introspectWorkflow(env.ROLLOUT_WORKFLOW);
    await wf.modifyAll(async (m) => {
      await m.disableSleeps();
    });
    const { stub } = await freshAgent();

    const first = await failAndRetry(stub, true);
    const second = await stub.triage(SAMPLES.environmentFailure);
    expect(second.history?.label).toBe("persistent");
    expect(second.confidence).toBeLessThan(first.confidence);
  });

  it("keeps history per service", async () => {
    const a = await freshAgent();
    const b = await freshAgent();
    await a.stub.triage(SAMPLES.environmentFailure);
    expect((await a.stub.triage(SAMPLES.environmentFailure)).history?.occurrences).toBe(1);
    expect((await b.stub.triage(SAMPLES.environmentFailure)).history).toBeUndefined();
  });
});

describe("history window", () => {
  it("ignores incidents older than 30 days", async () => {
    const { stub } = await freshAgent();
    const signature = extractSignals(SAMPLES.environmentFailure).signature;
    await runInDurableObject(stub, (agent: ReleaseAgent) => {
      const old = Date.now() - 31 * 24 * 60 * 60 * 1000;
      agent.sql`INSERT INTO incidents (id, created_at, kind, cause, confidence, action, signature, summary, outcome)
        VALUES ('old-1', ${old}, 'failure_log', 'environment', 0.9, 'retry', ${signature}, 'old', 'succeeded')`;
    });
    expect((await stub.triage(SAMPLES.environmentFailure)).history).toBeUndefined();
  });
});
