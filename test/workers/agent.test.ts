import { getAgentByName } from "agents";
import { runInDurableObject } from "cloudflare:test";
import { env, exports } from "cloudflare:workers";
import { describe, expect, it, vi } from "vitest";
import type { ReleaseAgent } from "../../src/server/agent";
import { SAMPLES } from "../../src/shared/samples";
import type { LlmVerdict, RuleResult } from "../../src/shared/types";

// These tests run inside workerd with a real ReleaseAgent Durable Object and
// SQLite storage. There is no AI binding: each test either swaps in a fake
// classifier or deliberately leaves the real one to fail.

type Classifier = (input: string, rules: RuleResult) => Promise<LlmVerdict | null>;

let counter = 0;
/** A fresh agent per test, so tests don't share history. */
async function agentFor(classifier?: Classifier) {
  const stub = await getAgentByName(env.ReleaseAgent, `svc-${++counter}`);
  if (classifier) {
    await runInDurableObject(stub, (agent: ReleaseAgent) => {
      agent.classify = classifier;
    });
  }
  return stub;
}

const verdict = (over: Partial<LlmVerdict> = {}): LlmVerdict => ({
  kind: "failure_log",
  cause: "environment",
  confidence: 0.8,
  evidence: ["model evidence line"],
  reasoning: "Registry timed out.",
  ...over,
});

describe("ReleaseAgent.triage", () => {
  it("combines rules with the model, persists the incident, and updates chat state", async () => {
    const fake = vi.fn<Classifier>(async () => verdict());
    const stub = await agentFor(fake);

    const result = await stub.triage(SAMPLES.environmentFailure);

    expect(result).toMatchObject({ cause: "environment", action: "retry", source: "rules+llm" });

    // The model received the rule hints, not just the raw log.
    const [, rules] = fake.mock.calls[0];
    expect(rules.signals.map((s) => s.rule)).toContain("network");

    const history = await stub.history();
    expect(history).toHaveLength(1);
    expect(history[0]).toMatchObject({ cause: "environment", action: "retry", outcome: null });
    expect(history[0].signature).toMatch(/^network:/);

    const state = await runInDurableObject(stub, (agent: ReleaseAgent) => agent.state);
    expect(state.busy).toBe(false);
    expect(state.messages.map((m) => m.role)).toEqual(["user", "assistant"]);
    expect(state.messages[1].verdict?.cause).toBe("environment");
  });

  it("falls back to rules when the model returns nothing usable", async () => {
    const stub = await agentFor(async () => null);
    const result = await stub.triage(SAMPLES.changeFailure);
    expect(result).toMatchObject({ cause: "change", action: "rollback", source: "rules" });
  });

  it("falls back to rules when the real Workers AI call fails", async () => {
    // No fake: classifyWithLlm runs for real, env.AI is missing, and the error must be contained.
    const stub = await agentFor();
    vi.spyOn(console, "error").mockImplementation(() => {});
    const result = await stub.triage(SAMPLES.environmentFailure);
    expect(result.source).toBe("rules");
    expect(result.cause).toBe("environment");
  });

  it("records the error in chat and clears busy when triage throws", async () => {
    const stub = await agentFor(async () => {
      throw new Error("boom");
    });
    // Throwing paths are called inside the object rather than over RPC: over RPC
    // the test harness also reports the object's own rejection as unhandled.
    await runInDurableObject(stub, (agent: ReleaseAgent) =>
      expect(agent.triage(SAMPLES.changeFailure)).rejects.toThrow("boom"),
    );

    const state = await runInDurableObject(stub, (agent: ReleaseAgent) => agent.state);
    expect(state.busy).toBe(false);
    expect(state.messages.at(-1)?.text).toBe("Triage failed: boom");
    expect(await stub.history()).toHaveLength(0);
  });

  it("rejects empty input without calling the model", async () => {
    const fake = vi.fn<Classifier>(async () => verdict());
    const stub = await agentFor(fake);
    await runInDurableObject(stub, (agent: ReleaseAgent) =>
      expect(agent.triage("   ")).rejects.toThrow(/Paste a log/),
    );
    expect(fake).not.toHaveBeenCalled();
  });

  it("stores only the head and tail of a huge log in chat state", async () => {
    const stub = await agentFor(async () => null);
    await stub.triage("noise line\n".repeat(50_000) + SAMPLES.environmentFailure);
    const state = await runInDurableObject(stub, (agent: ReleaseAgent) => agent.state);
    expect(state.messages[0].text.length).toBeLessThan(6_000);
    expect(state.messages[0].text).toContain("exit code 1");
  });

  it("clears a busy flag left behind by a restart mid-triage", async () => {
    const stub = await agentFor();
    const state = await runInDurableObject(stub, async (agent: ReleaseAgent) => {
      // Simulate state persisted by a triage that never finished.
      agent.setState({ ...agent.state, busy: true });
      await agent.onStart();
      return agent.state;
    });
    expect(state.busy).toBe(false);
    expect(state.messages.at(-1)?.text).toMatch(/interrupted/);
  });

  it("keeps history separate per service", async () => {
    const a = await agentFor(async () => null);
    const b = await agentFor(async () => null);
    await a.triage(SAMPLES.environmentFailure);
    await a.triage(SAMPLES.changeFailure);
    await b.triage(SAMPLES.mixedFailure);
    expect(await a.history()).toHaveLength(2);
    expect(await b.history()).toHaveLength(1);
  });
});

describe("Worker routing", () => {
  it.each(["Checkout%20API", "a%2Fb", "-x", ""])("rejects invalid service name %j", async (name) => {
    const res = await exports.default.fetch(`http://localhost/agents/release-agent/${name}`);
    expect(res.status).toBe(400);
  });

  it("rejects unknown agent paths", async () => {
    const res = await exports.default.fetch("http://localhost/agents/admin");
    expect(res.status).toBe(400);
  });

  it("routes a valid service name to the agent", async () => {
    const res = await exports.default.fetch("http://localhost/agents/release-agent/checkout-api");
    expect(res.status).not.toBe(400);
  });
});
