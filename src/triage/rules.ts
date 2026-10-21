import type { RuleResult, Signal } from "../shared/types";

// Deterministic first pass over a log. Each rule is a regex with the cause it
// points at and a weight. Rules are intentionally simple and explainable; the
// LLM handles everything they miss.

interface Rule {
  id: string;
  cause: Signal["cause"];
  weight: number;
  pattern: RegExp;
}

export const RULES: Rule[] = [
  // Environment / infrastructure
  { id: "network", cause: "environment", weight: 2, pattern: /ETIMEDOUT|ECONNRESET|ECONNREFUSED|EAI_AGAIN|socket hang up|connection reset by peer/i },
  { id: "dns", cause: "environment", weight: 2, pattern: /getaddrinfo ENOTFOUND|Temporary failure in name resolution|DNS resolution failed|no such host/i },
  { id: "upstream-5xx", cause: "environment", weight: 2, pattern: /\b50[234]\b.{0,40}(Bad Gateway|Service Unavailable|Gateway Time-?out)|npm ERR! code E50[234]/i },
  { id: "rate-limit", cause: "environment", weight: 2, pattern: /429 Too Many Requests|rate limit (exceeded|reached)|toomanyrequests/i },
  { id: "disk-full", cause: "environment", weight: 2, pattern: /No space left on device|ENOSPC/i },
  { id: "runner-lost", cause: "environment", weight: 2.5, pattern: /lost communication with the server|runner has received a shutdown signal|agent (was )?disconnected|executor (was )?lost/i },
  { id: "registry-pull", cause: "environment", weight: 2, pattern: /ImagePullBackOff|ErrImagePull|failed to pull image/i },
  { id: "tls", cause: "environment", weight: 1.5, pattern: /certificate has expired|x509:|TLS handshake timeout/i },
  { id: "oom", cause: "environment", weight: 1, pattern: /OOMKilled|out of memory|exit code 137/i },

  // The change itself
  { id: "compile", cause: "change", weight: 3, pattern: /error TS\d+|SyntaxError|cannot find symbol|compilation failed|undefined reference to/i },
  { id: "assertion", cause: "change", weight: 2, pattern: /AssertionError|assertion failed|Expected[^\n]{0,80}(Received|but (got|was))|expect\(.+\)\.to/i },
  { id: "runtime-exception", cause: "change", weight: 2, pattern: /TypeError|ReferenceError|NullPointerException|Cannot read propert(y|ies) of (undefined|null)|is not a function|^panic: |index out of range/i },
  { id: "missing-module", cause: "change", weight: 1.5, pattern: /Cannot find module|Module not found|ERESOLVE unable to resolve/i },
  { id: "lint", cause: "change", weight: 1.5, pattern: /\d+ problems? \(\d+ errors?|eslint.*\berror\b/i },
  { id: "migration", cause: "change", weight: 2, pattern: /migration failed|column "?\w+"? does not exist|relation "?\w+"? does not exist/i },
  { id: "crashloop", cause: "change", weight: 1.5, pattern: /CrashLoopBackOff/ },
];

// Text that reports a failure ("the build failed", "Error: ...", "FAILED"), as
// opposed to a change description that mentions one ("fix the failing test",
// "retry failed payments", "improve error handling").
const FAILURE_REPORTS = [
  /\b(build|job|step|tests?|deploy(ment)?|pipeline|run|release|ci|check|upgrade|install)\b[^.\n]{0,40}\b(failed|broke|crashed)\b/i,
  /\b\d+ (failed|failing)\b|exit code:? [1-9]|^\s*(error|fatal|panic)\b/im,
  /[A-Za-z]*(Error|Exception):|\bFAIL(ED|URE)?\b|ERR!|Traceback/, // case-sensitive: log output, not prose
];

// Logs are untrusted input: a test, a dependency, or an attacker can print
// text aimed at the model. Lines like these are flagged and never reach it.
const INSTRUCTION_PATTERN =
  /ignore (all |any |your |the )?(previous|prior|above|earlier) instructions|\b(note|message|instructions?) (to|for) (the )?(ai|assistant|llm|model|triage)\b|system (override|prompt)|\b(classify|mark|label|treat) (it|this)( failure| issue)? as\b|\bconfidence\s*[=:]\s*(1(\.0+)?|100%?)\b/i;

// Evidence that the log comes from a deploy to a live environment rather than
// pre-merge CI. Only a deploy can be rolled back.
const DEPLOY_PATTERN =
  /\bdeploy(ing|ed|ment)\b|\brollout\b|\breplicas?\b|kubectl|helm (upgrade|install)|CrashLoopBackOff|progress deadline|\bcanary\b|\bpod\/|\bto (prod|production|staging)\b/i;

/** Scan input line by line; each rule fires at most once, on its first match. */
export function extractSignals(input: string): RuleResult {
  const lines = input.split(/\r?\n/);
  const signals: Signal[] = [];
  const suspicious = lines.filter((l) => INSTRUCTION_PATTERN.test(l)).map((l) => l.trim().slice(0, 240));

  for (const rule of RULES) {
    const line = lines.find((l) => rule.pattern.test(l));
    if (line) {
      signals.push({ rule: rule.id, cause: rule.cause, weight: rule.weight, line: line.trim().slice(0, 240) });
    }
  }

  // Strongest signal first so the signature and evidence lead with it.
  signals.sort((a, b) => b.weight - a.weight);

  const reportsFailure = FAILURE_REPORTS.some((re) => re.test(input));
  const kind = signals.length === 0 && !reportsFailure ? "change_description" : "failure_log";
  const signature = signals.length > 0 ? `${signals[0].rule}:${normalizeLine(signals[0].line)}` : "none";

  const stage = DEPLOY_PATTERN.test(input) ? "deploy" : "ci";

  return { kind, stage, signals, signature, suspicious };
}

/** Replace flagged lines before the input is sent to the model. */
export function redactInstructions(input: string): string {
  return input
    .split(/\r?\n/)
    .map((l) => (INSTRUCTION_PATTERN.test(l) ? "[line removed: it contained instructions addressed to the AI]" : l))
    .join("\n");
}

/**
 * Strip the parts of a log line that change between runs (timestamps, numbers,
 * hex ids, paths, quoted values) so the same failure gets the same signature.
 */
export function normalizeLine(line: string): string {
  return line
    .toLowerCase()
    .replace(/\d{4}-\d{2}-\d{2}[t ][\d:.]+z?/g, "") // ISO timestamps
    .replace(/(["'`]).*?\1/g, "*") // quoted values
    .replace(/(?:[a-z]:)?(?:[\w.-]*\/)+[\w.-]+/g, "<path>") // file paths and URLs
    .replace(/\b[0-9a-f]{7,}\b/g, "<hex>") // commit shas, request ids
    .replace(/\d+/g, "N")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 120);
}
