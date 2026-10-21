# ADR 0004: History-aware triage by failure signature and outcome

- Status: Accepted
- Date: 2026-10-21

## Context

The same failure keeps coming back: a flaky registry, a runner pool that
loses machines, a test that times out under load. A developer who has seen it
three times knows "just retry"; the tool should know too. It should also
know the opposite: if retrying didn't fix it last time, "it's the
environment, retry" is bad advice.

## Decision

1. **Match by failure signature.** Each incident stores the normalized
   signature from the rules (top signal's rule id + its log line with
   numbers, ids, paths, and timestamps stripped). Same signature, same
   failure. Indexed in SQLite on `(signature, created_at)`.
2. **Record outcomes.** When a Workflow finishes, its result
   (`succeeded`, `failed`, `rolled_back`, …) is written to the incident row.
   Retry outcomes are the useful signal: they are a cheap, real experiment on
   whether the failure was transient.
3. **Summarize the last 30 days** for the service into a known pattern:
   - `flaky`: retry fixed it at least twice and never failed to;
   - `persistent`: retry has failed to fix it at least once;
   - `recurring`: seen before, no conclusion yet.
4. **Use it in two places:**
   - in the model's prompt, so its reasoning can weigh it;
   - in a pure `applyHistory` step after the rules + model merge:
     `flaky` raises confidence in environment (and turns unknown into
     environment); `persistent` lowers confidence in environment;
     **history never overrides change evidence**, since a test that fails
     for a real bug can also have been flaky in the past.
5. History is looked up **before** the new incident is stored, so a verdict
   only reflects earlier incidents.

## Consequences

- The answer improves with use, per service, without retraining anything.
- Failures that no rule matches get the signature `none` and no history.
  Matching those would need fuzzy similarity (e.g. embeddings in Vectorize).
- Labels use fixed thresholds (2 successes / 1 failure), not statistics.
  With more data, per-signature retry success rates could set confidence
  directly.
- History is per service. A registry outage hitting six services at once
  is invisible to each of them; a cross-service store (D1 or Analytics
  Engine) would surface it.
