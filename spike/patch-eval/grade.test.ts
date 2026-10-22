import { test } from "node:test";
import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import {
  EvalTask,
  changedLineCount,
  checkIntent,
  collateralChanges,
  evaluateSearchReplace,
  evaluateWholeFile,
  extractFencedBlocks,
  gradeResponse,
  redactSecrets,
} from "./grade";

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

test("T08 regression: an equivalent guard `!(maxRetries >= 1)` meets the intent", () => {
  const t08 = tasks.find((t) => t.id === "T08")!;
  const original = fs.readFileSync(path.join(SPIKE_DIR, "fixtures", t08.file), "utf8");
  const anchor = "): Promise<string> {\n";
  for (const guard of ["!(maxRetries >= 1)", "maxRetries < 1"]) {
    const raw = JSON.stringify({
      intentSummary: "x",
      patches: [{
        targetFile: t08.file,
        searchBlock: anchor,
        replaceBlock: `${anchor}  if (${guard}) {\n    throw new RangeError("maxRetries must be at least 1");\n  }\n`,
        explanation: "",
      }],
    });
    const graded = gradeResponse(t08, "sr", raw, original);
    assert.equal(graded.outcome.stage, "ok", guard);
    assert.deepEqual(graded.failedChecks, [], guard);
  }
});

test("search/replace patches for another file are rejected like in the extension", () => {
  const foreign = JSON.stringify({ intentSummary: "x", patches: [{ targetFile: "other.ts", searchBlock: "maxRetries = 3", replaceBlock: "maxRetries = 2", explanation: "" }] });
  const outcome = evaluateSearchReplace(foreign, source, task.file);
  assert.equal(outcome.stage, "apply");
  assert.match(outcome.error!, /TargetFileMismatch/);
  const withPath = foreign.replace("other.ts", "src/pipeline/autoFixLoop.ts");
  assert.equal(evaluateSearchReplace(withPath, source, task.file).stage, "ok");
});

test("fenced blocks: backticks inside lines are content, longer fences may contain ```", () => {
  const inline = "const fence = /^```json/;\n// strip ``` wrappers\n";
  assert.deepEqual(extractFencedBlocks("```ts\n" + inline + "```"), [inline.replace(/\n$/, "")]);
  const nested = "````md\n```ts\nconst a = 1;\n```\n````";
  assert.deepEqual(extractFencedBlocks(nested), ["```ts\nconst a = 1;\n```"]);
  assert.deepEqual(extractFencedBlocks("text ```ts not a fence```"), []);
  assert.deepEqual(extractFencedBlocks("~~~\nx\n~~~"), ["x"]);
});

test("gradeResponse matches the individual grading steps", () => {
  const raw = srResponse("maxRetries = 3", "maxRetries = 2");
  const graded = gradeResponse(task, "sr", raw, source);
  const outcome = evaluateSearchReplace(raw, source, task.file);
  assert.equal(graded.outcome.stage, outcome.stage);
  assert.deepEqual(graded.failedChecks, checkIntent(task, outcome.patchedCode!));
  assert.deepEqual(graded.collateral, collateralChanges(task, source, outcome.patchedCode!));
  assert.equal(graded.changedLines, changedLineCount(source, outcome.patchedCode!));
});

test("stored errors are scrubbed of credentials", () => {
  const openAi401 = 'HTTP 401: {"error":{"message":"Incorrect API key provided: sk-proj-****abcd. You can find your API key at ..."}}';
  assert.doesNotMatch(redactSecrets(openAi401), /abcd/);
  assert.doesNotMatch(redactSecrets("Authorization: Bearer abc.def.ghi"), /abc\.def/);
  assert.doesNotMatch(redactSecrets('{"x-api-key": "secret-value-123"}'), /secret-value-123/);
  assert.equal(redactSecrets("TS1005 - ';' expected."), "TS1005 - ';' expected.");
});
