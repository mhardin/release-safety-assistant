# Release Safety Assistant

Paste a failing CI or deploy log, or describe a change, and get a verdict:
**was it the change, or the environment?** The verdict comes with a confidence
level, the evidence lines it used, and a recommended next action (retry, roll
back, or staged rollout). Built on Cloudflare Workers, the Agents SDK (Durable
Objects), and Workers AI (Llama 3.3 70B).

> Work in progress. Milestone 1 (chat → triage → persisted history) is done.
> The gated rollout Workflow and history-aware triage come next.

## Run locally

Requires Node 20+ and a free Cloudflare account. Workers AI runs on
Cloudflare even during local dev, so log in once:

```bash
npm install
npx wrangler login
npm run dev        # http://localhost:5173
npm test           # unit tests for the triage logic
```

## Layout

| Path | What it is |
|---|---|
| `src/server/index.ts` | Worker entry; routes `/agents/*` to agents |
| `src/server/agent.ts` | `ReleaseAgent`: one Durable Object per service; chat state + SQLite history |
| `src/triage/rules.ts` | Deterministic failure-pattern rules and failure signatures |
| `src/triage/llm.ts` | Workers AI prompt, JSON schema, output validation |
| `src/triage/combine.ts` | Merges rules + LLM into the final verdict and action |
| `src/client/` | React chat UI |
| `docs/adr/` | Architecture decision records |
