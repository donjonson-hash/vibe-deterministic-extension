// Aggregates spike JSONL results into a Markdown table.
// Usage: node dist-spike/spike/patch-eval/summarize.js results/*.jsonl
import * as fs from "node:fs";

interface RunRecord {
  task: string;
  model: string;
  format: string;
  attempts: Array<{ stage: string }>;
  finalStage: string;
  attemptsUsed: number;
  intentPassed: boolean;
  collateral: string[];
  changedLines: number | null;
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
  latencyMs: number;
}

const pct = (n: number, total: number) => (total ? `${Math.round((100 * n) / total)}%` : "-");

const groups = new Map<string, RunRecord[]>();
for (const file of process.argv.slice(2)) {
  for (const line of fs.readFileSync(file, "utf8").split("\n").filter(Boolean)) {
    const record = JSON.parse(line) as RunRecord;
    const key = `${record.model} | ${record.format}`;
    groups.set(key, [...(groups.get(key) ?? []), record]);
  }
}

console.log("| Model | Format | N | OK 1st try | OK ≤2 retries | Intent met | Clean | Avg attempts | Median changed lines | Tokens in/out | Cost $ | Avg s/task |");
console.log("|---|---|---|---|---|---|---|---|---|---|---|---|");
for (const [key, records] of [...groups.entries()].sort()) {
  const n = records.length;
  const firstTry = records.filter((r) => r.attempts[0]?.stage === "ok").length;
  const ok = records.filter((r) => r.finalStage === "ok").length;
  const intent = records.filter((r) => r.intentPassed).length;
  const clean = records.filter((r) => r.intentPassed && r.collateral.length === 0).length;
  const attempts = records.reduce((s, r) => s + r.attemptsUsed, 0) / n;
  const lines = records.map((r) => r.changedLines).filter((v): v is number => v !== null).sort((a, b) => a - b);
  const median = lines.length ? lines[Math.floor(lines.length / 2)] : "-";
  const tin = records.reduce((s, r) => s + r.inputTokens, 0);
  const tout = records.reduce((s, r) => s + r.outputTokens, 0);
  const cost = records.reduce((s, r) => s + r.costUsd, 0);
  const secs = records.reduce((s, r) => s + r.latencyMs, 0) / n / 1000;
  console.log(
    `| ${key} | ${n} | ${pct(firstTry, n)} | ${pct(ok, n)} | ${pct(intent, n)} | ${pct(clean, n)} | ${attempts.toFixed(2)} | ${median} | ${tin}/${tout} | ${cost.toFixed(3)} | ${secs.toFixed(1)} |`
  );
}

console.log("\nFailure stages per attempt (all attempts):\n");
for (const [key, records] of [...groups.entries()].sort()) {
  const stages = new Map<string, number>();
  for (const r of records) for (const a of r.attempts) if (a.stage !== "ok") stages.set(a.stage, (stages.get(a.stage) ?? 0) + 1);
  const text = [...stages.entries()].map(([s, c]) => `${s}: ${c}`).join(", ") || "none";
  console.log(`- ${key}: ${text}`);
}
