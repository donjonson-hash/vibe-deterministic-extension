// Re-grades saved results from the raw responses after a grader or check fix.
// Grading is deterministic, so this needs no new model calls.
// Usage: node dist-spike/spike/patch-eval/regrade.js
import * as fs from "node:fs";
import * as path from "node:path";
import {
  AttemptOutcome,
  EvalTask,
  changedLineCount,
  checkIntent,
  collateralChanges,
  evaluateSearchReplace,
  evaluateWholeFile,
} from "./grade";

const SPIKE_DIR = path.resolve(__dirname, "../../../spike/patch-eval");
const RESULTS = path.join(SPIKE_DIR, "results");
const tasks = new Map(
  (JSON.parse(fs.readFileSync(path.join(SPIKE_DIR, "tasks.json"), "utf8")) as EvalTask[]).map((t) => [t.id, t])
);

let changed = 0;
for (const file of fs.readdirSync(RESULTS).filter((f) => f.endsWith(".jsonl"))) {
  const rawDir = path.join(RESULTS, "raw", file.replace(/\.jsonl$/, ""));
  const lines = fs.readFileSync(path.join(RESULTS, file), "utf8").split("\n").filter(Boolean);
  const updated = lines.map((line) => {
    const record = JSON.parse(line);
    const task = tasks.get(record.task)!;
    const source = fs.readFileSync(path.join(SPIKE_DIR, "fixtures", task.file), "utf8");
    const attempt = record.attemptsUsed - 1;
    // Runs started before --repeat existed saved raw files without the rep suffix
    const candidates = [`${record.task}-r${record.rep ?? 1}-${attempt}.txt`, `${record.task}-${attempt}.txt`];
    const rawFile = candidates.map((c) => path.join(rawDir, c)).find((p) => fs.existsSync(p));
    if (!rawFile || record.finalStage === "transport") return line;

    const raw = fs.readFileSync(rawFile, "utf8");
    const outcome: AttemptOutcome =
      record.format === "sr" ? evaluateSearchReplace(raw, source, task.file) : evaluateWholeFile(raw, source, task.file);
    const code = outcome.patchedCode;
    const failedChecks = code ? checkIntent(task, code) : [];
    const next = {
      ...record,
      finalStage: outcome.stage,
      intentPassed: Boolean(code) && failedChecks.length === 0,
      failedChecks,
      collateral: code ? collateralChanges(task, source, code) : [],
      changedLines: code ? changedLineCount(source, code) : null,
    };
    const serialized = JSON.stringify(next);
    if (serialized !== line) {
      changed++;
      console.log(`${file} ${record.task} r${record.rep ?? 1}: intent ${record.intentPassed} -> ${next.intentPassed}, stage ${record.finalStage} -> ${next.finalStage}`);
    }
    return serialized;
  });
  fs.writeFileSync(path.join(RESULTS, file), updated.join("\n") + "\n");
}
console.log(`Re-graded records changed: ${changed}`);
