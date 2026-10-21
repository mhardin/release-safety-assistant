// Measure triage accuracy on the labeled cases in eval/cases.ts.
//
//   npm run eval                               # against `npm run dev` (localhost:5173)
//   npm run eval -- --host <app>.workers.dev   # against a deployment
//
// Each case is scored twice:
// - rules only: the deterministic pass, computed locally (no model)
// - full: the real app over its agent connection (rules + Llama 3.3 + merge
//   policy). Each case gets its own throwaway service, so cases can't
//   influence each other through history.
// Writes eval/results.md. This calls the real model, so it isn't run in CI.

import { AgentClient } from "agents/client";
import { writeFileSync } from "node:fs";
import type { Verdict } from "../src/shared/types";
import { combineVerdict } from "../src/triage/combine";
import { MODEL } from "../src/triage/llm";
import { extractSignals } from "../src/triage/rules";
import { CASES, type EvalCase } from "./cases";

const host = process.argv.includes("--host") ? process.argv[process.argv.indexOf("--host") + 1] : "localhost:5173";
const runId = Date.now().toString(36);

interface Row {
  c: EvalCase;
  rules: Verdict;
  full: Verdict | null;
  error?: string;
  ms: number;
}

async function triageLive(c: EvalCase, i: number): Promise<Verdict> {
  const client = new AgentClient({ agent: "release-agent", name: `eval-${runId}-${i}`, host });
  try {
    await new Promise((resolve, reject) => {
      client.addEventListener("open", resolve, { once: true });
      setTimeout(() => reject(new Error("connect timeout")), 15_000);
    });
    return (await client.call("triage", [c.input])) as unknown as Verdict;
  } finally {
    client.close();
  }
}

const rows: Row[] = [];
for (const [i, c] of CASES.entries()) {
  const rules = combineVerdict(extractSignals(c.input), null);
  const start = Date.now();
  try {
    const full = await triageLive(c, i);
    rows.push({ c, rules, full, ms: Date.now() - start });
  } catch (err) {
    rows.push({ c, rules, full: null, error: (err as Error).message, ms: Date.now() - start });
  }
  const r = rows.at(-1)!;
  console.log(`${mark(r.full?.action === c.action)} ${c.id.padEnd(34)} ${r.full ? `${r.full.cause}/${r.full.action}` : r.error}`);
}

const score = (pick: (r: Row) => Verdict | null, field: "cause" | "action") =>
  rows.filter((r) => pick(r)?.[field] === r.c[field]).length;

const n = rows.length;
const summary = [
  `| | Cause correct | Action correct |`,
  `|---|---|---|`,
  `| Rules only | ${pct(score((r) => r.rules, "cause"))} | ${pct(score((r) => r.rules, "action"))} |`,
  `| Full (rules + ${MODEL.split("/").pop()}) | ${pct(score((r) => r.full, "cause"))} | ${pct(score((r) => r.full, "action"))} |`,
].join("\n");

const latencies = rows.filter((r) => r.full).map((r) => r.ms).sort((a, b) => a - b);
const median = latencies[Math.floor(latencies.length / 2)] ?? 0;

const table = rows.map((r) => {
  const f = r.full;
  const full = f ? `${mark(f.cause === r.c.cause)} ${f.cause} · ${mark(f.action === r.c.action)} ${f.action} · ${Math.round(f.confidence * 100)}% · ${f.source}` : `error: ${r.error}`;
  return `| ${r.c.id} | ${r.c.note} | ${r.c.cause} · ${r.c.action} | ${mark(r.rules.cause === r.c.cause)} ${r.rules.cause} · ${mark(r.rules.action === r.c.action)} ${r.rules.action} | ${full} |`;
});

const report = `# Triage evaluation

Run ${new Date().toISOString()} against \`${host}\`, model \`${MODEL}\`, ${n} cases.
Median end-to-end latency ${(median / 1000).toFixed(1)}s.

${summary}

| Case | Note | Expected | Rules only | Full |
|---|---|---|---|---|
${table.join("\n")}
`;

writeFileSync(new URL("./results.md", import.meta.url), report);
console.log(`\n${summary}\n\nWrote eval/results.md`);
process.exit(0);

function pct(k: number) {
  return `${k}/${n} (${Math.round((k / n) * 100)}%)`;
}

function mark(ok: boolean) {
  return ok ? "✓" : "✗";
}
