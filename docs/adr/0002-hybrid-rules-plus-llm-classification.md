# ADR 0002: Hybrid classification — deterministic rules plus LLM

- Status: Accepted
- Date: 2026-10-21

## Context

The core question is "did this fail because of the change, or because of the
environment?", with a confidence level and evidence. Getting it wrong is
costly in both directions: blaming the environment hides a real bug behind a
retry, and blaming the change rolls back good work.

An LLM (Llama 3.3 70B on Workers AI) reads unstructured logs well, but it can
hallucinate evidence, be overconfident, or fail outright. Workers AI JSON mode
can return "JSON Mode couldn't be met", and it doesn't stream. Regex rules are
predictable, cheap, and testable, but shallow.

## Decision

Run both, then merge them in a pure function:

1. `extractSignals` (rules.ts) matches known patterns (ETIMEDOUT, DNS,
   registry 5xx, runner lost → environment; compile errors, assertions,
   runtime exceptions, failed migrations → change). Each match has a weight
   and the exact line. It also derives a normalized **failure signature**
   (numbers, ids, paths, and timestamps stripped) for history lookups.
2. The LLM gets the log (head + tail truncated) **and** the rule hits as
   hints, and must answer in a JSON schema. Its output is validated
   (`parseLlmVerdict`); anything malformed is treated as no answer.
3. `combineVerdict` merges them:
   - LLM unavailable → rules verdict (`source: "rules"`).
   - No rules fired → LLM verdict, confidence capped at 0.75.
   - Agree → average plus 0.1, capped at 0.95.
   - Disagree → the more confident side, minus 0.2, with the conflict stated
     in the reasoning.
4. The action follows from the verdict: environment → retry, change → roll
   back, unknown → retry once to tell them apart, change description →
   staged rollout.

## Consequences

- The system always answers, and the merge policy is unit-tested without
  calling a model.
- Confidence comes from a stated policy, not the model's self-report alone,
  so it can be explained and tuned.
- The rules need upkeep. History (Milestone 3) should show which signatures
  recur and whether the recommended action worked, which is the data needed
  to tune weights.
- The confidence numbers are heuristics, not calibrated probabilities.
  Calibrating them against labeled outcomes is future work.
