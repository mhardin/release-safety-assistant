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
  { id: "runtime-exception", cause: "change", weight: 2, pattern: /TypeError|ReferenceError|NullPointerException|Cannot read propert(y|ies) of (undefined|null)|is not a function/i },
  { id: "missing-module", cause: "change", weight: 1.5, pattern: /Cannot find module|Module not found|ERESOLVE unable to resolve/i },
  { id: "lint", cause: "change", weight: 1.5, pattern: /\d+ problems? \(\d+ errors?|eslint.*\berror\b/i },
  { id: "migration", cause: "change", weight: 2, pattern: /migration failed|column "?\w+"? does not exist|relation "?\w+"? does not exist/i },
  { id: "crashloop", cause: "change", weight: 1.5, pattern: /CrashLoopBackOff/ },
];

const FAILURE_WORDS = /\b(error|fail(ed|ure)?|exception|fatal|panic|exit code [1-9])\b/i;

/** Scan input line by line; each rule fires at most once, on its first match. */
export function extractSignals(input: string): RuleResult {
  const lines = input.split(/\r?\n/);
  const signals: Signal[] = [];

  for (const rule of RULES) {
    const line = lines.find((l) => rule.pattern.test(l));
    if (line) {
      signals.push({ rule: rule.id, cause: rule.cause, weight: rule.weight, line: line.trim().slice(0, 240) });
    }
  }

  // Strongest signal first so the signature and evidence lead with it.
  signals.sort((a, b) => b.weight - a.weight);

  const kind = signals.length === 0 && !FAILURE_WORDS.test(input) ? "change_description" : "failure_log";
  const signature = signals.length > 0 ? `${signals[0].rule}:${normalizeLine(signals[0].line)}` : "none";

  return { kind, signals, signature };
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
