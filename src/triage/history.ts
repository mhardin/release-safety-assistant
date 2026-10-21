import type { KnownPattern, Verdict } from "../shared/types";
import { chooseAction } from "./combine";

// Per-service memory: has this exact failure (same signature) happened before,
// and did retrying it work? This is what turns "a timeout" into "the npm
// registry timeout we've retried successfully three times this month".

export const HISTORY_WINDOW_DAYS = 30;

/** The fields of a past incident that history needs. */
export interface PastIncident {
  action: string;
  outcome: string | null;
  created_at: number;
}

export function summarizeHistory(signature: string, past: PastIncident[]): KnownPattern | null {
  if (signature === "none" || past.length === 0) return null;

  const retries = past.filter((p) => p.action === "retry");
  const retriesSucceeded = retries.filter((p) => p.outcome === "succeeded").length;
  const retriesFailed = retries.filter((p) => p.outcome === "failed").length;

  return {
    signature,
    occurrences: past.length,
    lastSeen: Math.max(...past.map((p) => p.created_at)),
    retriesSucceeded,
    retriesFailed,
    // flaky: retry keeps fixing it. persistent: retry has failed to fix it.
    label: retriesFailed > 0 ? "persistent" : retriesSucceeded >= 2 ? "flaky" : "recurring",
  };
}

/**
 * Adjust a verdict using history. History corroborates or casts doubt; it
 * never overrides evidence that the change caused the failure.
 */
export function applyHistory(verdict: Verdict, pattern: KnownPattern | null): Verdict {
  if (!pattern || verdict.kind === "change_description") return verdict;

  const seen = `Seen ${pattern.occurrences} time${pattern.occurrences === 1 ? "" : "s"} before in the last ${HISTORY_WINDOW_DAYS} days`;
  const withHistory = (changes: Partial<Verdict>, note: string): Verdict => {
    const cause = changes.cause ?? verdict.cause;
    return {
      ...verdict,
      ...changes,
      confidence: round(changes.confidence ?? verdict.confidence),
      // The action follows the (possibly changed) cause unless set explicitly.
      action: changes.action ?? chooseAction(verdict.kind, cause, verdict.stage),
      reasoning: `${verdict.reasoning} ${note}`,
      history: pattern,
    };
  };

  if (pattern.label === "flaky" && verdict.cause !== "change") {
    return withHistory(
      { cause: "environment", confidence: Math.min(0.95, Math.max(verdict.confidence, 0.6) + 0.1) },
      `Known flaky pattern: ${seen.toLowerCase()}, and retrying fixed it ${pattern.retriesSucceeded} times.`,
    );
  }

  // Retrying again is bad advice. In a deploy, return to the known-good
  // version; in CI, keep the merge blocked until the cause is found.
  if (pattern.label === "persistent" && verdict.cause !== "change") {
    return withHistory(
      {
        cause: "unknown",
        confidence: Math.max(0.3, verdict.confidence - 0.2),
        action: verdict.stage === "deploy" ? "rollback" : "fix_forward",
      },
      `Caution: ${seen.toLowerCase()}, and retrying did not fix it ${pattern.retriesFailed} time${pattern.retriesFailed === 1 ? "" : "s"}, so another retry is unlikely to help.`,
    );
  }

  return withHistory({}, `${seen}.`);
}

/** One line for the model's prompt, so it can weigh history too. */
export function describeForPrompt(pattern: KnownPattern | null): string {
  if (!pattern) return "No earlier failures with this signature for this service.";
  return `This failure signature was seen ${pattern.occurrences} times in the last ${HISTORY_WINDOW_DAYS} days; retry succeeded ${pattern.retriesSucceeded} times and failed ${pattern.retriesFailed} times.`;
}

function round(n: number): number {
  return Math.round(n * 100) / 100;
}
