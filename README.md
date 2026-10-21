# Release Safety Assistant

Paste a failing CI or deploy log, or describe a change, and get a verdict:
**was it the change, or the environment?** The verdict comes with a confidence
level, the evidence lines it used, and a recommended next action. Then run
that action as a durable Workflow that pauses for human approval at each gate.
Built on Cloudflare Workers, the Agents SDK (Durable Objects), Workflows, and
Workers AI (Llama 3.3 70B).

> Work in progress. Milestones 1 (triage + history) and 2 (gated rollout
> Workflow) are done. History-aware triage and deployment come next.

## Actions

| Verdict | Recommended action | What runs |
|---|---|---|
| Environment / unknown cause | **Retry** | Re-run the job once; the outcome tells you whether it was transient |
| Change-caused, in a **deploy** | **Roll back** | Roll back, then check health |
| Change-caused, in **pre-merge CI** | **Fix forward** | Nothing: nothing shipped, so fix on the branch and keep the merge blocked |
| A change you plan to ship | **Staged rollout** | Canary 5% → *gate* → 25% → *gate* → 100%, with a health check after each step |

A failed health check rolls back automatically. A rejected gate, or one
nobody answers within an hour, also rolls back. Deploys and metrics are
simulated; the UI's "Simulate" menu forces a health failure at a chosen step.
Each outcome is saved to the incident's history.

## Run locally

Requires Node 20+ and a free Cloudflare account. Workers AI runs on
Cloudflare even during local dev, so log in once:

```bash
npm install
npx wrangler login
npm run dev        # http://localhost:5173
npm test           # unit + Workers integration tests
```

## Testing

`npm test` runs two Vitest projects. CI (GitHub Actions) runs typecheck,
both test projects, and the build on every push and PR.

| Project | Runs in | Covers |
|---|---|---|
| `unit` (`test/unit/`) | Node | Rules, failure signatures, the rules + LLM merge policy, LLM output validation |
| `unit` | | Rollout plans and health checks |
| `workers` (`test/workers/`) | workerd, via `@cloudflare/vitest-plugin` | `ReleaseAgent` as a real Durable Object: SQLite persistence, chat state, error paths, per-service isolation, routing |
| `workers` | | `RolloutWorkflow` end to end: approve/reject gates, automatic rollback on health failure, gate timeout, double-click and concurrency guards |

**How the LLM is handled in tests:** there is no AI binding in tests, so CI
needs no Cloudflare credentials and results are deterministic. Each test
swaps `ReleaseAgent.classify` for a fake, and one test leaves the real
`classifyWithLlm` in place to check that a failing AI call falls back to the
rules verdict. Whether Llama actually follows the JSON schema is not covered
by these tests; that needs an evaluation set run against the real model.

## Layout

| Path | What it is |
|---|---|
| `src/server/index.ts` | Worker entry; routes `/agents/*` to agents |
| `src/server/agent.ts` | `ReleaseAgent`: one Durable Object per service; chat and rollout state, SQLite history, starts the Workflow and handles gate decisions |
| `src/server/rollout-workflow.ts` | `RolloutWorkflow`: durable steps, bake sleeps, approval gates, automatic rollback |
| `src/shared/rollout.ts` | Pure rollout plan, health thresholds, simulated metrics, shared state types |
| `src/triage/rules.ts` | Deterministic failure-pattern rules and failure signatures |
| `src/triage/llm.ts` | Workers AI prompt, JSON schema, output validation |
| `src/triage/combine.ts` | Merges rules + LLM into the final verdict and action |
| `src/client/` | React chat UI |
| `docs/adr/` | Architecture decision records |
