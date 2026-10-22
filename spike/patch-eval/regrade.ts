// Re-grades saved results from the raw responses after a grader or check fix.
// Grading is deterministic, so this needs no new model calls.
// Usage: node dist-spike/spike/patch-eval/regrade.js
import * as fs from "node:fs";
import * as path from "node:path";
import { EvalTask, GradedResponse, gradeResponse, redactSecrets } from "./grade";
import { rawDirFor } from "./run";

const SPIKE_DIR = path.resolve(__dirname, "../../../spike/patch-eval");
const RESULTS = path.join(SPIKE_DIR, "results");
const tasks = new Map(
  (JSON.parse(fs.readFileSync(path.join(SPIKE_DIR, "tasks.json"), "utf8")) as EvalTask[]).map((t) => [t.id, t])
);

interface StoredAttempt {
  stage: string;
  error?: string;
}

function rawResponse(rawDir: string, taskId: string, rep: number, attempt: number): string {
  // Runs started before --repeat existed saved raw files without the rep suffix
  const candidates = [`${taskId}-r${rep}-${attempt}.txt`, `${taskId}-${attempt}.txt`].map((c) => path.join(rawDir, c));
  const found = candidates.find((p) => fs.existsSync(p));
  if (!found) {
    throw new Error(`Missing raw response for ${taskId} r${rep} attempt ${attempt} in ${rawDir}`);
  }
  return fs.readFileSync(found, "utf8");
}

let changed = 0;
let wouldRetry = 0;
for (const file of fs.readdirSync(RESULTS).filter((f) => f.endsWith(".jsonl"))) {
  const resultsFile = path.join(RESULTS, file);
  const rawDir = rawDirFor(resultsFile);
  const lines = fs.readFileSync(resultsFile, "utf8").split("\n").filter(Boolean);
  const updated = lines.map((line) => {
    const record = JSON.parse(line);
    const task = tasks.get(record.task)!;
    const source = fs.readFileSync(path.join(SPIKE_DIR, "fixtures", task.file), "utf8");
    const rep = record.rep ?? 1;

    // Every attempt is re-graded; transport and early stops have nothing to grade
    let final: GradedResponse | null = null;
    let needed = record.attempts.length;
    const attempts = record.attempts.map((attempt: StoredAttempt, index: number) => {
      if (attempt.stage === "transport" || attempt.stage === "incomplete" || final?.outcome.stage === "ok") {
        return attempt;
      }
      const graded = gradeResponse(task, record.format, rawResponse(rawDir, record.task, rep, index), source);
      final = graded;
      if (graded.outcome.stage === "ok") needed = index + 1;
      return {
        ...attempt,
        stage: graded.outcome.stage,
        error: graded.outcome.error && redactSecrets(graded.outcome.error).slice(0, 500),
      };
    });

    const next = { ...record, attempts };
    if (final) {
      const graded: GradedResponse = final;
      Object.assign(next, {
        finalStage: graded.outcome.stage,
        // Attempts the current grader needs; attempts[] keeps every request actually sent (and paid)
        attemptsUsed: needed,
        intentPassed: graded.intentPassed,
        failedChecks: graded.failedChecks,
        collateral: graded.collateral,
        changedLines: graded.changedLines,
      });
      // Records written before maxAttempts was stored used the default --retries 2
      const retriesLeft = record.attempts.length < (record.maxAttempts ?? 3);
      if (graded.outcome.stage !== "ok" && record.finalStage === "ok" && retriesLeft) {
        wouldRetry++;
        console.warn(`${file} ${record.task} r${rep}: now fails, but the live run stopped early; re-run to measure retries`);
      }
    }
    const serialized = JSON.stringify(next);
    if (serialized !== line) {
      changed++;
      console.log(`${file} ${record.task} r${rep}: stage ${record.finalStage} -> ${next.finalStage}, intent ${record.intentPassed} -> ${next.intentPassed}, attempts ${record.attemptsUsed} -> ${next.attemptsUsed}`);
    }
    return serialized;
  });
  fs.writeFileSync(resultsFile, updated.join("\n") + "\n");
}
console.log(`Re-graded records changed: ${changed}; records needing a live re-run: ${wouldRetry}`);
