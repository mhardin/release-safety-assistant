import type { LlmVerdict, RuleResult } from "../shared/types";

export const MODEL = "@cf/meta/llama-3.3-70b-instruct-fp8-fast";

// Keep the prompt well inside the model's 24k-token context. Most useful
// evidence in CI logs is near the end, so keep a little of the head and more
// of the tail.
const HEAD_CHARS = 2_000;
const TAIL_CHARS = 10_000;

// Workers AI JSON mode: the model must return an object matching this schema.
export const VERDICT_SCHEMA = {
  type: "object",
  properties: {
    kind: { type: "string", enum: ["failure_log", "change_description"] },
    cause: { type: "string", enum: ["change", "environment", "unknown"] },
    confidence: { type: "number", minimum: 0, maximum: 1 },
    evidence: { type: "array", items: { type: "string" }, maxItems: 5 },
    reasoning: { type: "string" },
  },
  required: ["kind", "cause", "confidence", "evidence", "reasoning"],
} as const;

const SYSTEM_PROMPT = `You are a release-safety assistant for a platform engineering team.
A developer gives you either a failing CI/deploy log or a description of a change they want to ship.

For a failing log, decide whether the failure was most likely caused by:
- "change": the code or config change under test (compile errors, failing assertions, new exceptions, bad migrations), or
- "environment": infrastructure or dependencies outside the change (network timeouts, DNS, registry or upstream 5xx, rate limits, lost runners, full disks), or
- "unknown": not enough evidence.

For a change description, set kind to "change_description", cause to "unknown", and use reasoning to name the main rollout risks.

Rules:
- Quote short, exact log lines as evidence. Never invent lines.
- confidence is 0 to 1. Use below 0.5 when evidence is thin or mixed.
- Pattern-matching hints are provided; they can be wrong, so weigh them against the log.
- Keep reasoning to 2-3 sentences.`;

export function buildMessages(input: string, rules: RuleResult) {
  const hints = rules.signals.length
    ? rules.signals.map((s) => `- ${s.rule} (${s.cause}): ${s.line}`).join("\n")
    : "- none matched";
  return [
    { role: "system", content: SYSTEM_PROMPT },
    { role: "user", content: `Pattern-matching hints:\n${hints}\n\nInput:\n"""\n${truncate(input)}\n"""` },
  ];
}

export function truncate(input: string): string {
  if (input.length <= HEAD_CHARS + TAIL_CHARS) return input;
  return `${input.slice(0, HEAD_CHARS)}\n... [${input.length - HEAD_CHARS - TAIL_CHARS} chars omitted] ...\n${input.slice(-TAIL_CHARS)}`;
}

/**
 * Validate the model's output instead of trusting it. Returns null on
 * anything malformed so the caller can fall back to the rules verdict.
 */
export function parseLlmVerdict(raw: unknown): LlmVerdict | null {
  let v: unknown = raw;
  if (typeof v === "string") {
    try {
      v = JSON.parse(v);
    } catch {
      return null;
    }
  }
  if (!v || typeof v !== "object") return null;
  const o = v as Record<string, unknown>;

  const kinds = ["failure_log", "change_description"];
  const causes = ["change", "environment", "unknown"];
  if (!kinds.includes(o.kind as string) || !causes.includes(o.cause as string)) return null;
  if (typeof o.confidence !== "number" || Number.isNaN(o.confidence)) return null;

  return {
    kind: o.kind as LlmVerdict["kind"],
    cause: o.cause as LlmVerdict["cause"],
    confidence: Math.min(1, Math.max(0, o.confidence)),
    evidence: Array.isArray(o.evidence) ? o.evidence.filter((e): e is string => typeof e === "string").slice(0, 5) : [],
    reasoning: typeof o.reasoning === "string" ? o.reasoning : "",
  };
}

/** Ask Llama 3.3 for a structured verdict. Returns null if the call or the output fails. */
export async function classifyWithLlm(ai: Ai, input: string, rules: RuleResult): Promise<LlmVerdict | null> {
  try {
    const result = await ai.run(MODEL, {
      messages: buildMessages(input, rules),
      response_format: { type: "json_schema", json_schema: VERDICT_SCHEMA },
      max_tokens: 600,
      temperature: 0.1,
    });
    return parseLlmVerdict((result as { response?: unknown }).response);
  } catch (err) {
    // JSON mode can fail with "JSON Mode couldn't be met"; network calls can fail too.
    console.error("LLM classification failed", err);
    return null;
  }
}
