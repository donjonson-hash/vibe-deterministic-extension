import { test } from "node:test";
import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { EvalTask, changedLineCount, checkIntent, collateralChanges, evaluateSearchReplace, evaluateWholeFile } from "./grade";

const SPIKE_DIR = path.resolve(__dirname, "../../../spike/patch-eval");
const tasks = JSON.parse(fs.readFileSync(path.join(SPIKE_DIR, "tasks.json"), "utf8")) as EvalTask[];
const task = tasks.find((t) => t.id === "T07")!;
const source = fs.readFileSync(path.join(SPIKE_DIR, "fixtures", task.file), "utf8");

const srResponse = (searchBlock: string, replaceBlock: string) =>
  JSON.stringify({ intentSummary: "x", patches: [{ targetFile: task.file, searchBlock, replaceBlock, explanation: "" }] });

test("a correct search/replace patch passes gates, intent and has no collateral", () => {
  const outcome = evaluateSearchReplace(srResponse("maxRetries = 3", "maxRetries = 2"), source, task.file);
  assert.equal(outcome.stage, "ok");
  assert.deepEqual(checkIntent(task, outcome.patchedCode!), []);
  assert.deepEqual(collateralChanges(task, source, outcome.patchedCode!), []);
  assert.equal(changedLineCount(source, outcome.patchedCode!), 2);
});

test("search/replace failures are attributed to the right stage", () => {
  assert.equal(evaluateSearchReplace("not json", source, task.file).stage, "format");
  assert.equal(evaluateSearchReplace(srResponse("maxRetries = 9", "x"), source, task.file).stage, "apply");
  assert.equal(evaluateSearchReplace(srResponse("lastError", "lastError2"), source, task.file).stage, "apply");
  assert.equal(evaluateSearchReplace(srResponse("maxRetries = 3", "maxRetries = (2"), source, task.file).stage, "syntax");
  assert.equal(evaluateSearchReplace(srResponse("maxRetries = 3", "maxRetries: any = 2"), source, task.file).stage, "lint");
});

test("whole-file responses: one fence required, untouched final newline kept", () => {
  const edited = source.replace("maxRetries = 3", "maxRetries = 2").replace(/\n$/, "");
  const outcome = evaluateWholeFile("```ts\n" + edited + "\n```", source, task.file);
  assert.equal(outcome.stage, "ok");
  assert.equal(changedLineCount(source, outcome.patchedCode!), 2);
  assert.equal(evaluateWholeFile("no fence", source, task.file).stage, "format");
  assert.equal(evaluateWholeFile("```ts\n" + source + "```", source, task.file).stage, "apply");
});

test("intent misses and collateral changes are detected", () => {
  const noIntent = source.replace("console.warn", "console.info");
  assert.notDeepEqual(checkIntent(task, noIntent), []);
  const other = { ...task, touch: [] };
  assert.deepEqual(collateralChanges(other, source, source.replace("maxRetries = 3", "maxRetries = 2")), [
    "MODIFIED function runWithAutoFix",
  ]);
});

test("every task's checks fail on its unmodified fixture", () => {
  for (const t of tasks) {
    const original = fs.readFileSync(path.join(SPIKE_DIR, "fixtures", t.file), "utf8");
    assert.notDeepEqual(checkIntent(t, original), [], `${t.id} passes without any change`);
  }
});
