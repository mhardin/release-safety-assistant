import type { Action, Cause, InputKind, LlmVerdict, PipelineStage, RuleResult, Verdict } from "../shared/types";

// Merge the deterministic rule result with the (optional) LLM verdict.
// Rules are cheap and predictable but shallow; the LLM reads context but can be
// wrong or unavailable. Agreement raises confidence, disagreement lowers it, and
// the system still answers when the LLM fails.

export interface RuleScore {
  cause: Cause;
  confidence: number;
}

/** Weigh environment vs. change signals into a cause and a confidence. */
export function scoreRules(rules: RuleResult): RuleScore {
  let env = 0;
  let change = 0;
  for (const s of rules.signals) {
    if (s.cause === "environment") env += s.weight;
    else change += s.weight;
  }
  const total = env + change;
  if (total === 0 || env === change) return { cause: "unknown", confidence: 0 };

  const margin = Math.abs(env - change) / total; // 1 = all signals agree
  const strength = Math.min(1, total / 3); // a single weak signal isn't conclusive
  return {
    cause: env > change ? "environment" : "change",
    confidence: round(0.5 + 0.4 * margin * strength),
  };
}

export function chooseAction(kind: InputKind, cause: Cause, stage: PipelineStage): Action {
  if (kind === "change_description") return "staged_rollout";
  // Environment failures are usually transient: retry. When unsure, a single
  // retry is the cheapest way to tell the two causes apart.
  if (cause !== "change") return "retry";
  // A change-caused failure won't go away on retry. In a live environment, roll
  // back; in pre-merge CI nothing shipped, so fix forward and keep the merge blocked.
  return stage === "deploy" ? "rollback" : "fix_forward";
}

export function combineVerdict(rules: RuleResult, llm: LlmVerdict | null): Verdict {
  const ruleScore = scoreRules(rules);
  const ruleEvidence = [
    ...rules.suspicious.map((line) => `[injection] ${line}`),
    ...rules.signals.map((s) => `[${s.rule}] ${s.line}`),
  ];
  // If the text reports a failure, never let the model downgrade it to a change
  // description: that would recommend a staged rollout for a broken build.
  const kind = rules.kind === "failure_log" ? "failure_log" : (llm?.kind ?? rules.kind);
  // Instruction-like text in the log means the model may have been steered.
  const distrustModel = rules.suspicious.length > 0;
  const distrustNote = distrustModel
    ? " The input contains text addressed to the AI, so the model's opinion is given less weight."
    : "";

  if (!llm) {
    return finish({
      kind,
      cause: ruleScore.cause,
      confidence: ruleScore.confidence,
      evidence: ruleEvidence,
      reasoning: ruleScore.cause === "unknown"
        ? "No known failure patterns matched and the model was unavailable."
        : `Matched ${rules.signals.length} known pattern(s) pointing at ${ruleScore.cause}. The model was unavailable.`,
      source: "rules",
    }, rules);
  }

  // The model often quotes the same lines the rules matched; keep the rule's labeled copy.
  const ruleLines = [...rules.signals.map((s) => s.line), ...rules.suspicious];
  const llmOnly = llm.evidence.filter((e) => !ruleLines.some((line) => line.includes(e.trim())));
  const evidence = dedupe([...ruleEvidence, ...llmOnly]);

  // No rule fired: trust the model, but cap confidence since nothing corroborates it.
  if (ruleScore.cause === "unknown") {
    const cap = distrustModel ? 0.5 : 0.75;
    return finish({ kind, cause: llm.cause, confidence: Math.min(llm.confidence, cap), evidence, reasoning: llm.reasoning + distrustNote, source: "llm" }, rules);
  }

  // Rules and model agree: confidence goes up.
  if (llm.cause === ruleScore.cause) {
    const confidence = Math.min(0.95, (llm.confidence + ruleScore.confidence) / 2 + 0.1);
    return finish({ kind, cause: llm.cause, confidence, evidence, reasoning: llm.reasoning + distrustNote, source: "rules+llm" }, rules);
  }

  // They disagree: take the more confident side, discount it, and say so.
  // A possibly-steered model never overrides the rules.
  const llmWins = !distrustModel && llm.confidence > ruleScore.confidence;
  const winner = llmWins ? llm : ruleScore;
  return finish({
    kind,
    cause: winner.cause,
    confidence: Math.max(0.3, winner.confidence - 0.2),
    evidence,
    reasoning: `${llm.reasoning} Note: the pattern rules pointed at ${ruleScore.cause} while the model said ${llm.cause}; ${llmWins ? "going with the model" : "going with the rules"} at reduced confidence.${distrustNote}`,
    source: "rules+llm",
  }, rules);
}

function finish(v: Omit<Verdict, "action" | "signature" | "stage">, rules: RuleResult): Verdict {
  return {
    ...v,
    confidence: round(v.confidence),
    stage: rules.stage,
    action: chooseAction(v.kind, v.cause, rules.stage),
    signature: rules.signature,
  };
}

function round(n: number): number {
  return Math.round(n * 100) / 100;
}

function dedupe(items: string[]): string[] {
  return [...new Set(items)].slice(0, 8);
}
