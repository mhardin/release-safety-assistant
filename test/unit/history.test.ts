import { describe, expect, it } from "vitest";
import { SAMPLES } from "../../src/shared/samples";
import type { KnownPattern, Verdict } from "../../src/shared/types";
import { combineVerdict } from "../../src/triage/combine";
import { applyHistory, describeForPrompt, summarizeHistory, type PastIncident } from "../../src/triage/history";
import { buildMessages } from "../../src/triage/llm";
import { extractSignals } from "../../src/triage/rules";

const retry = (outcome: string | null, at = 1): PastIncident => ({ action: "retry", outcome, created_at: at });

describe("summarizeHistory", () => {
  it("returns nothing for a first occurrence or an unsigned failure", () => {
    expect(summarizeHistory("network:x", [])).toBeNull();
    expect(summarizeHistory("none", [retry("succeeded")])).toBeNull();
  });

  it("labels a failure that retry keeps fixing as flaky", () => {
    const p = summarizeHistory("network:x", [retry("succeeded", 5), retry("succeeded", 9), retry(null, 7)]);
    expect(p).toMatchObject({ occurrences: 3, retriesSucceeded: 2, retriesFailed: 0, lastSeen: 9, label: "flaky" });
  });

  it("labels a failure that retry has failed to fix as persistent, even if it once worked", () => {
    expect(summarizeHistory("network:x", [retry("succeeded"), retry("succeeded"), retry("failed")])?.label).toBe("persistent");
  });

  it("labels other repeats as recurring", () => {
    expect(summarizeHistory("network:x", [retry("succeeded")])?.label).toBe("recurring");
    expect(summarizeHistory("compile:x", [{ action: "fix_forward", outcome: null, created_at: 1 }])?.label).toBe("recurring");
  });
});

const pattern = (over: Partial<KnownPattern>): KnownPattern => ({
  signature: "network:x",
  occurrences: 3,
  lastSeen: 1,
  retriesSucceeded: 0,
  retriesFailed: 0,
  label: "recurring",
  ...over,
});

const envVerdict = (): Verdict => combineVerdict(extractSignals(SAMPLES.environmentFailure), null);

describe("applyHistory", () => {
  it("leaves a first occurrence unchanged", () => {
    expect(applyHistory(envVerdict(), null)).toEqual(envVerdict());
  });

  it("raises confidence for a known flaky failure and says why", () => {
    const before = envVerdict();
    const v = applyHistory(before, pattern({ label: "flaky", retriesSucceeded: 3 }));
    expect(v.cause).toBe("environment");
    expect(v.confidence).toBeGreaterThan(before.confidence);
    expect(v.reasoning).toMatch(/Known flaky pattern.*retrying fixed it 3 times/);
    expect(v.history?.label).toBe("flaky");
  });

  it("turns an unknown cause into environment when retry has repeatedly fixed it", () => {
    const unknown = combineVerdict(extractSignals("job failed for no clear reason"), null);
    expect(unknown.cause).toBe("unknown");
    const v = applyHistory(unknown, pattern({ label: "flaky", retriesSucceeded: 2 }));
    expect(v).toMatchObject({ cause: "environment", action: "retry", confidence: 0.7 });
  });

  it("never overrides evidence that the change caused the failure", () => {
    const change = combineVerdict(extractSignals(SAMPLES.changeFailure), null);
    const v = applyHistory(change, pattern({ label: "flaky", retriesSucceeded: 5 }));
    expect(v.cause).toBe("change");
    expect(v.confidence).toBe(change.confidence);
  });

  it("lowers confidence when retry has not fixed this failure before", () => {
    const before = envVerdict();
    const v = applyHistory(before, pattern({ label: "persistent", retriesFailed: 2 }));
    expect(v.confidence).toBeCloseTo(before.confidence - 0.2);
    expect(v.reasoning).toMatch(/retrying did not fix it 2 times/);
  });

  it("ignores history for change descriptions", () => {
    const desc = combineVerdict(extractSignals(SAMPLES.changeDescription), null);
    expect(applyHistory(desc, pattern({ label: "flaky" }))).toEqual(desc);
  });
});

describe("history in the prompt", () => {
  it("tells the model what happened before", () => {
    const rules = extractSignals(SAMPLES.environmentFailure);
    const content = buildMessages(SAMPLES.environmentFailure, rules, pattern({ retriesSucceeded: 2 }))[1].content;
    expect(content).toContain("seen 3 times in the last 30 days; retry succeeded 2 times");
    expect(describeForPrompt(null)).toMatch(/No earlier failures/);
  });
});
