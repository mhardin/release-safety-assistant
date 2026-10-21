import { describe, expect, it } from "vitest";
import type { LlmVerdict } from "../../src/shared/types";
import { SAMPLES } from "../../src/shared/samples";
import { chooseAction, combineVerdict, scoreRules } from "../../src/triage/combine";
import { parseLlmVerdict, truncate } from "../../src/triage/llm";
import { extractSignals, normalizeLine } from "../../src/triage/rules";

const llm = (over: Partial<LlmVerdict>): LlmVerdict => ({
  kind: "failure_log",
  cause: "environment",
  confidence: 0.8,
  evidence: ["model evidence"],
  reasoning: "Model reasoning.",
  ...over,
});

describe("extractSignals", () => {
  it("flags a registry timeout as environment", () => {
    const r = extractSignals(SAMPLES.environmentFailure);
    expect(r.kind).toBe("failure_log");
    expect(r.signals.map((s) => s.rule)).toContain("network");
    expect(r.signals.every((s) => s.cause === "environment")).toBe(true);
    expect(r.signature.startsWith("network:")).toBe(true);
  });

  it("flags a failing assertion as change", () => {
    const r = extractSignals(SAMPLES.changeFailure);
    expect(r.signals.map((s) => s.rule)).toEqual(["assertion"]);
    expect(scoreRules(r).cause).toBe("change");
  });

  it("treats text with no failure words as a change description", () => {
    const r = extractSignals(SAMPLES.changeDescription);
    expect(r.kind).toBe("change_description");
    expect(r.signals).toEqual([]);
    expect(r.signature).toBe("none");
  });

  it("orders signals strongest first", () => {
    const r = extractSignals(SAMPLES.mixedFailure);
    const weights = r.signals.map((s) => s.weight);
    expect(weights).toEqual([...weights].sort((a, b) => b - a));
  });
});

describe("pipeline stage", () => {
  it("treats test and install logs as pre-merge CI", () => {
    expect(extractSignals(SAMPLES.changeFailure).stage).toBe("ci");
    expect(extractSignals(SAMPLES.environmentFailure).stage).toBe("ci");
  });

  it("recognizes deploy logs", () => {
    expect(extractSignals(SAMPLES.mixedFailure).stage).toBe("deploy");
    expect(extractSignals("kubectl rollout status deploy/api\nerror: timed out").stage).toBe("deploy");
  });

  it("recommends fix-forward for a failing test and rollback for a crashing deploy", () => {
    expect(combineVerdict(extractSignals(SAMPLES.changeFailure), null).action).toBe("fix_forward");
    expect(combineVerdict(extractSignals(SAMPLES.mixedFailure), null).action).toBe("rollback");
  });
});

describe("normalizeLine", () => {
  it("gives the same signature to the same failure on different runs", () => {
    const a = normalizeLine("2026-10-21T14:02:11Z connect ETIMEDOUT 104.16.27.34:443 for req 3f9c2ab91");
    const b = normalizeLine("2026-10-22T09:15:40Z connect ETIMEDOUT 104.16.80.2:443 for req 77de01c4f");
    expect(a).toBe(b);
  });

  it("collapses paths and quoted values", () => {
    expect(normalizeLine(`Cannot find module './utils' from src/app/index.ts`)).toBe("cannot find module * from <path>");
  });
});

describe("scoreRules", () => {
  it("returns unknown with zero confidence when nothing matched", () => {
    expect(scoreRules({ kind: "failure_log", stage: "ci", signals: [], signature: "none", suspicious: [] })).toEqual({ cause: "unknown", confidence: 0 });
  });

  it("is less confident when signals conflict", () => {
    const pure = scoreRules(extractSignals(SAMPLES.changeFailure + "\nTypeError: x is not a function"));
    const mixed = scoreRules(extractSignals(SAMPLES.changeFailure + "\nconnect ETIMEDOUT 1.2.3.4:443"));
    expect(mixed.confidence).toBeLessThan(pure.confidence);
  });
});

describe("chooseAction", () => {
  it("maps cause and pipeline stage to action", () => {
    expect(chooseAction("failure_log", "environment", "ci")).toBe("retry");
    expect(chooseAction("failure_log", "environment", "deploy")).toBe("retry");
    expect(chooseAction("failure_log", "unknown", "deploy")).toBe("retry");
    expect(chooseAction("failure_log", "change", "deploy")).toBe("rollback");
    // Nothing was deployed pre-merge, so there is nothing to roll back.
    expect(chooseAction("failure_log", "change", "ci")).toBe("fix_forward");
    expect(chooseAction("change_description", "unknown", "ci")).toBe("staged_rollout");
  });
});

describe("combineVerdict", () => {
  const envRules = extractSignals(SAMPLES.environmentFailure);

  it("falls back to rules when the LLM is unavailable", () => {
    const v = combineVerdict(envRules, null);
    expect(v).toMatchObject({ cause: "environment", action: "retry", source: "rules" });
    expect(v.evidence[0]).toMatch(/^\[network\]/);
  });

  it("raises confidence when rules and model agree", () => {
    const v = combineVerdict(envRules, llm({ confidence: 0.7 }));
    expect(v.source).toBe("rules+llm");
    expect(v.confidence).toBeGreaterThan(0.7);
    expect(v.confidence).toBeLessThanOrEqual(0.95);
  });

  it("drops model evidence that repeats a line the rules already matched", () => {
    const v = combineVerdict(envRules, llm({ evidence: ["npm ERR! code ETIMEDOUT", "a line only the model saw"] }));
    expect(v.evidence.filter((e) => e.includes("npm ERR! code ETIMEDOUT"))).toHaveLength(1);
    expect(v.evidence).toContain("a line only the model saw");
  });

  it("caps model confidence when no rule corroborates it", () => {
    const rules = extractSignals("something odd happened and the job failed");
    const v = combineVerdict(rules, llm({ cause: "change", confidence: 0.99 }));
    expect(v).toMatchObject({ cause: "change", confidence: 0.75, source: "llm", action: "fix_forward" });
  });

  it("discounts confidence and explains when rules and model disagree", () => {
    const v = combineVerdict(envRules, llm({ cause: "change", confidence: 0.95 }));
    expect(v.cause).toBe("change");
    expect(v.confidence).toBe(0.75);
    expect(v.reasoning).toMatch(/pattern rules pointed at environment/);
  });

  it("recommends a staged rollout for change descriptions", () => {
    const rules = extractSignals(SAMPLES.changeDescription);
    const v = combineVerdict(rules, llm({ kind: "change_description", cause: "unknown", confidence: 0.6 }));
    expect(v.action).toBe("staged_rollout");
  });
});

describe("parseLlmVerdict", () => {
  it("accepts a JSON string or an object", () => {
    const obj = { kind: "failure_log", cause: "change", confidence: 0.6, evidence: ["a"], reasoning: "r" };
    expect(parseLlmVerdict(JSON.stringify(obj))).toEqual(obj);
    expect(parseLlmVerdict(obj)).toEqual(obj);
  });

  it("rejects malformed output", () => {
    expect(parseLlmVerdict("not json")).toBeNull();
    expect(parseLlmVerdict({ kind: "failure_log", cause: "cosmic-rays", confidence: 1 })).toBeNull();
    expect(parseLlmVerdict({ kind: "failure_log", cause: "change", confidence: "high" })).toBeNull();
  });

  it("clamps confidence and drops non-string evidence", () => {
    const v = parseLlmVerdict({ kind: "failure_log", cause: "change", confidence: 7, evidence: ["ok", 3], reasoning: "r" });
    expect(v?.confidence).toBe(1);
    expect(v?.evidence).toEqual(["ok"]);
  });
});

describe("truncate", () => {
  it("keeps head and tail of long logs", () => {
    const long = "H".repeat(5_000) + "T".repeat(20_000);
    const out = truncate(long);
    expect(out.startsWith("H".repeat(2_000))).toBe(true);
    expect(out.endsWith("T".repeat(10_000))).toBe(true);
    expect(out).toContain("chars omitted");
  });
});
