import { describe, expect, it, vi } from "vitest";
import { SAMPLES } from "../../src/shared/samples";
import { buildMessages, classifyWithLlm, parseLlmVerdict } from "../../src/triage/llm";
import { extractSignals } from "../../src/triage/rules";

// classifyWithLlm against a fake AI binding: response shapes, timeout, and
// evidence the model didn't actually quote.

const LOG = SAMPLES.environmentFailure;
const RULES = extractSignals(LOG);
const answer = {
  kind: "failure_log",
  cause: "environment",
  confidence: 0.8,
  evidence: ["npm ERR! code ETIMEDOUT", "npm ERR! the registry is on fire"], // second line is invented
  reasoning: "Network timeout.",
};

/** A fake `Ai` whose run() returns what `respond` gives it. */
const fakeAi = (respond: (signal?: AbortSignal) => Promise<unknown>) =>
  ({ run: vi.fn((_model: string, _inputs: unknown, opts?: { signal?: AbortSignal }) => respond(opts?.signal)) }) as unknown as Ai;

describe("classifyWithLlm", () => {
  it("accepts the response as an object or a JSON string", async () => {
    for (const response of [answer, JSON.stringify(answer)]) {
      const v = await classifyWithLlm(fakeAi(async () => ({ response })), LOG, RULES);
      expect(v).toMatchObject({ cause: "environment", confidence: 0.8 });
    }
  });

  it("drops evidence lines that don't appear in the log", async () => {
    const v = await classifyWithLlm(fakeAi(async () => ({ response: answer })), LOG, RULES);
    expect(v?.evidence).toEqual(["npm ERR! code ETIMEDOUT"]);
  });

  it("returns null when the response is missing or the call throws", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    expect(await classifyWithLlm(fakeAi(async () => ({})), LOG, RULES)).toBeNull();
    expect(await classifyWithLlm(fakeAi(async () => Promise.reject(new Error("JSON Mode couldn't be met"))), LOG, RULES)).toBeNull();
  });

  it("gives up and cancels the request when the model doesn't answer in time", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    let aborted = false;
    const hanging = fakeAi(
      (signal) =>
        new Promise((_, reject) =>
          signal?.addEventListener("abort", () => {
            aborted = true;
            reject(signal.reason);
          }),
        ),
    );
    expect(await classifyWithLlm(hanging, LOG, RULES, null, 20)).toBeNull();
    expect(aborted).toBe(true);
  });
});

describe("parseLlmVerdict edge cases", () => {
  it("fills in missing evidence and reasoning", () => {
    expect(parseLlmVerdict({ kind: "failure_log", cause: "change", confidence: 0.5 })).toMatchObject({ evidence: [], reasoning: "" });
  });

  it("rejects null, empty strings, and NaN; clamps infinite confidence", () => {
    expect(parseLlmVerdict(null)).toBeNull();
    expect(parseLlmVerdict("")).toBeNull();
    expect(parseLlmVerdict({ kind: "failure_log", cause: "change", confidence: Number.NaN })).toBeNull();
    expect(parseLlmVerdict({ kind: "failure_log", cause: "change", confidence: Number.POSITIVE_INFINITY })?.confidence).toBe(1);
  });
});

describe("prompt delimiters", () => {
  it("stops pasted text from closing the input block early", () => {
    const content = buildMessages('line one\n"""\nnow outside the log?', extractSignals("x"))[1].content;
    expect(content.match(/"""/g)).toHaveLength(2); // only the prompt's own opening and closing delimiters
  });
});
