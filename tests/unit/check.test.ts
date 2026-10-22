import { test, describe } from "node:test";
import * as assert from "node:assert/strict";
import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { extractFencedBlocks, extractJsonAnswer } from "../../src/check/fences";
import { lintCode, lintPatch } from "../../src/check/lint";
import { UnsupportedFileError, isSupportedFile, parserOptions } from "../../src/check/parse";
import { checkProposal } from "../../src/check/proposal";
import { attentionReasons, compareCode } from "../../src/check/semanticDiff";
import { checkSyntax } from "../../src/check/syntax";

describe("syntax (Babel)", () => {
  test("accepts valid TS, TSX, JS with JSX, decorators and CommonJS", () => {
    assert.deepEqual(checkSyntax("export const a: number = 1;\n", "a.ts").errors, []);
    assert.equal(checkSyntax("export const C = () => <div>{1}</div>;\n", "c.tsx").valid, true);
    assert.equal(checkSyntax("const v = <b/>;\n", "v.js").valid, true);
    assert.equal(checkSyntax("@dec class A { @m x = 1 }\n", "d.ts").valid, true);
    assert.equal(checkSyntax("module.exports = { a: 1 };\n", "m.cjs").valid, true);
  });

  test("reports the first error with a 1-based line and column", () => {
    const result = checkSyntax("export function f(): boolean {\n  return (true;\n}\n", "f.ts");
    assert.equal(result.valid, false);
    assert.match(result.errors[0], /^f\.ts \(2,\d+\): /);
    assert.doesNotMatch(result.errors[0], /\(\d+:\d+\)$/);
  });

  test("rejects unsupported file types instead of guessing a parser", () => {
    assert.throws(() => parserOptions("styles.css"), UnsupportedFileError);
    // Review finding: extensions must not resolve through Object.prototype
    for (const name of ["notes.constructor", "a.tostring", "b.__proto__", "c.hasownproperty"]) {
      assert.equal(isSupportedFile(name), false, name);
      assert.throws(() => parserOptions(name), UnsupportedFileError, name);
    }
    assert.equal(isSupportedFile("App.TSX"), true);
  });
});

describe("lint (Babel)", () => {
  test("passes clean typed code", () => {
    assert.equal(lintCode("export function sum(a: number, b: number): number { return a + b; }\n", "s.ts").passed, true);
  });

  test("blocks eval, Function, debugger and any, including global aliases", () => {
    const code = `const x: any = 1;\neval("1");\nglobalThis.eval("2");\nwindow["eval"]("3");\nconst f = Function("return 1");\nnew Function("a");\ndebugger;\n`;
    const rules = lintCode(code, "bad.ts").violations.map((v) => `${v.ruleId}@${v.line}`);
    assert.deepEqual(rules, [
      "no-explicit-any@1",
      "no-eval@2",
      "no-eval@3",
      "no-eval@4",
      "no-new-func@5",
      "no-new-func@6",
      "no-debugger@7",
    ]);
  });

  test("indirect eval forms and string timers are caught; eval as a property name is not", () => {
    const code = `(0, eval)("1");\nconst e = eval;\nobj[eval];\nsetTimeout("run()", 10);\nsetInterval(\`tick()\`, 5);\n`;
    assert.deepEqual(lintCode(code, "i.ts").violations.map((v) => `${v.ruleId}@${v.line}`), [
      "no-eval@1",
      "no-eval@2",
      "no-eval@3",
      "no-implied-eval@4",
      "no-implied-eval@5",
    ]);
    const harmless = `const o = { eval: 1 };\nclass K { eval() { return o.eval; } }\nsetTimeout(() => 1, 10);\nconst t: Function = () => 1;\n`;
    assert.deepEqual(lintCode(harmless, "h.ts").violations, []);
  });

  test("lintPatch matches Babel line numbering when a file contains U+2028", () => {
    // Babel counts U+2028 as a line terminator; the baseline must use the same lines
    const original = 'const s = "a\u2028b";\nexport function legacy(x: any) { return x; }\n';
    const patched = original + "export const ok = 1;\n";
    assert.equal(lintPatch(original, patched, "u.ts").passed, true);
  });

  test("lintPatch blocks only violations the original did not have", () => {
    const original = "export function legacy(x: any): any { return x; }\n";
    const clean = original + "export const ok = 1;\n";
    const dirty = original + "export const bad: any = 2;\n";
    assert.equal(lintPatch(original, clean, "l.ts").passed, true);
    const result = lintPatch(original, dirty, "l.ts");
    assert.equal(result.violations.length, 1);
    assert.equal(result.violations[0].line, 2);
  });
});

describe("semantic diff (Babel tokens)", () => {
  test("ignores whitespace, line breaks and comments", () => {
    const before = `// old\nexport function compute(a: number): number {\n  return a * 2;\n}\n`;
    const after = `/* new */\nexport function compute(  a: number ): number { return a * 2; }\n`;
    const report = compareCode(before, after, "math.ts");
    assert.equal(report.changes.length, 0);
    assert.equal(report.riskLevel, "LOW");
  });

  test("classifies ADDED, MODIFIED and REMOVED entities with risk", () => {
    const before = `import { readFileSync } from "fs";\nexport function keepMe(): number { return 1; }\nfunction modifyMe(): number { return 10; }\nfunction deleteMe(): void {}\n`;
    const after = `import { readFileSync } from "fs";\nimport * as path from "path";\nexport function keepMe(): number { return 1; }\nfunction modifyMe(): number { return 20; }\nexport class NewService {}\n`;
    const report = compareCode(before, after, "service.ts");
    const find = (kind: string, name: string) => report.changes.find((c) => c.kind === kind && c.name === name)?.changeType;
    assert.equal(find("import", "path"), "ADDED");
    assert.equal(find("class", "NewService"), "ADDED");
    assert.equal(find("function", "modifyMe"), "MODIFIED");
    assert.equal(find("function", "deleteMe"), "REMOVED");
    assert.equal(report.riskLevel, "HIGH");
    assert.deepEqual(attentionReasons(report), ['Удален function "deleteMe"']);
  });

  test("internal-only modification is MEDIUM; top-level calls and export toggles are changes", () => {
    assert.equal(compareCode("function h(): number { return 1; }\n", "function h(): number { return 2; }\n", "i.ts").riskLevel, "MEDIUM");
    const calls = compareCode("app.listen(80);\n", "app.listen(8080);\n", "server.ts");
    assert.deepEqual(calls.changes.map((c) => `${c.changeType} ${c.kind} ${c.name}`), ["MODIFIED statement <top-level>"]);
    const exported = compareCode("function f() {}\n", "export function f() {}\n", "e.ts");
    assert.equal(exported.changes[0].changeType, "MODIFIED");
    assert.equal(exported.changes[0].isExported, true);
  });

  test("overloads, merged declarations and declaration kinds are compared", () => {
    const overloads = `export function f(a: string): void;\nexport function f(a: number): void;\nexport function f(a: unknown): void {}\n`;
    const changed = overloads.replace("f(a: string): void;", "f(a: boolean): void;");
    assert.deepEqual(compareCode(overloads, changed, "o.ts").changes.map((c) => `${c.changeType} ${c.name}`), ["MODIFIED f"]);
    const merged = `interface A { x: number }\ninterface A { y: string }\n`;
    assert.equal(compareCode(merged, merged.replace("y: string", "y: number"), "m.ts").changes.length, 1);
    const kind = compareCode("export const CONFIG = { a: 1 };\n", "export let CONFIG = { a: 1 };\n", "k.ts");
    assert.deepEqual(kind.changes.map((c) => `${c.changeType} ${c.kind} ${c.name}`), ["MODIFIED variable CONFIG"]);
  });

  test("a rewritten import needs attention (spike T19: import * as ts → import ts = require)", () => {
    const report = compareCode(`import * as ts from "typescript";\nexport const a = 1;\n`, `import ts = require("typescript");\nexport const a = 1;\n`, "x.ts");
    assert.deepEqual(report.changes.map((c) => `${c.changeType} ${c.kind} ${c.name}`), ["ADDED statement <top-level>", "REMOVED import typescript"]);
    assert.equal(attentionReasons(report).length, 1);
    // Adding a binding is routine; losing one needs attention
    const added = compareCode(`import { a } from "m";\n`, `import { a, b } from "m";\n`, "y.ts");
    assert.equal(added.changes[0].changeType, "MODIFIED");
    assert.deepEqual(attentionReasons(added), []);
    const lost = compareCode(`import { a, b } from "m";\n`, `import { a } from "m";\n`, "y.ts");
    assert.deepEqual(attentionReasons(lost), ['Из import "m" удалено: b as b']);
    const renamed = compareCode(`import * as fs from "fs";\n`, `import fs from "fs";\n`, "y.ts");
    assert.deepEqual(attentionReasons(renamed), ['Из import "fs" удалено: * as fs']);
  });
});

describe("checkProposal", () => {
  const source = "export function hello(): boolean {\n  // old\n  return false;\n}\n";
  const sr = (searchBlock: string, replaceBlock: string, targetFile = "hello.ts") =>
    JSON.stringify({ intentSummary: "flip", patches: [{ targetFile, searchBlock, replaceBlock, explanation: "" }] });

  test("a valid search/replace answer yields the result, semantic report and line diff", () => {
    const check = checkProposal({ answer: sr("return false;", "return true;"), format: "sr", source, fileName: "hello.ts" });
    assert.equal(check.stage, "ok");
    assert.equal(check.result, source.replace("return false;", "return true;"));
    assert.equal(check.intentSummary, "flip");
    assert.equal(check.semantic?.riskLevel, "HIGH");
    assert.deepEqual([check.diff?.removed, check.diff?.added], [1, 1]);
    assert.deepEqual(check.attention, []);
  });

  test("failures are attributed to format, apply, syntax and lint", () => {
    const stage = (answer: string, format: "sr" | "wf" = "sr") => checkProposal({ answer, format, source, fileName: "hello.ts" }).stage;
    assert.equal(stage("not json"), "format");
    assert.equal(stage(sr("missing", "x")), "apply");
    assert.equal(stage(sr("return false;", "return true;", "other.ts")), "apply");
    assert.equal(stage(sr("return false;", "return (true;")), "syntax");
    assert.equal(stage(sr("return false;", "const v: any = 1; return v;")), "lint");
    assert.equal(stage("```ts\n" + source + "```", "wf"), "apply");
    assert.equal(stage("no fence", "wf"), "format");
  });

  test("CRLF files stay CRLF in both formats, even when the model answers with LF", () => {
    const crlf = source.replace(/\n/g, "\r\n");
    const viaSr = checkProposal({ answer: sr("return false;", "return true;"), format: "sr", source: crlf, fileName: "hello.ts" });
    assert.equal(viaSr.result, crlf.replace("return false;", "return true;"));
    const lfFile = source.replace("return false;", "return true;").replace(/\n$/, "");
    const viaWf = checkProposal({ answer: "```ts\n" + lfFile + "\n```", format: "wf", source: crlf, fileName: "hello.ts" });
    assert.equal(viaWf.result, crlf.replace("return false;", "return true;"));
    // A multi-line searchBlock sent with LF still matches the CRLF file
    const multi = checkProposal({ answer: sr("  // old\n  return false;", "  return true;"), format: "sr", source: crlf, fileName: "hello.ts" });
    assert.equal(multi.result, "export function hello(): boolean {\r\n  return true;\r\n}\r\n");
  });

  test("mixed line endings: exact search/replace works on raw text, whole-file is refused", () => {
    const mixed = "const a = 1;\r\nconst b = 2;\nconst c = 3;\n";
    const ok = checkProposal({ answer: sr("const b = 2;", "const b = 20;", "m.ts"), format: "sr", source: mixed, fileName: "m.ts" });
    assert.equal(ok.result, "const a = 1;\r\nconst b = 20;\nconst c = 3;\n");
    const wf = checkProposal({ answer: "```ts\nconst a = 1;\nconst b = 20;\nconst c = 3;\n```", format: "wf", source: mixed, fileName: "m.ts" });
    assert.equal(wf.stage, "format");
    assert.match(wf.error!, /MixedLineEndings/);
  });

  test("an original that does not parse disables the lint baseline and the semantic diff", () => {
    const broken = "export const a = (1;\nexport const b = 2;\n";
    const check = checkProposal({ answer: sr("export const a = (1;", "export const a = 1;", "b.ts"), format: "sr", source: broken, fileName: "b.ts" });
    assert.equal(check.stage, "ok");
    assert.equal(check.semantic, undefined);
    assert.equal(check.attention.length, 1);
  });

  test("CR-only and no-line-break files keep their style", () => {
    const cr = source.replace(/\n/g, "\r");
    const viaCr = checkProposal({ answer: sr("return false;", "return true;"), format: "sr", source: cr, fileName: "hello.ts" });
    assert.equal(viaCr.result, cr.replace("return false;", "return true;"));
    const oneLine = "export const a = 1;";
    const grown = checkProposal({ answer: sr("export const a = 1;", "export const a = 1;\nexport const b = 2;", "one.ts"), format: "sr", source: oneLine, fileName: "one.ts" });
    assert.equal(grown.result, "export const a = 1;\nexport const b = 2;");
  });

  test("a search/replace answer pasted with chat prose around the JSON block is accepted", () => {
    const answer = "Here is the patch:\n\n```json\n" + sr("return false;", "return true;") + "\n```\n\nLet me know if it works.";
    assert.equal(checkProposal({ answer, format: "sr", source, fileName: "hello.ts" }).stage, "ok");
    // Two JSON blocks are ambiguous and are not guessed
    const two = "```json\n{}\n```\n```json\n{}\n```";
    assert.equal(extractJsonAnswer(two), two);
  });

  test("unsupported files are rejected up front", () => {
    assert.equal(checkProposal({ answer: sr("a", "b", "x.css"), format: "sr", source: "a", fileName: "x.css" }).stage, "format");
  });
});

test("fenced blocks: line fences only, longer fences may contain ```", () => {
  assert.deepEqual(extractFencedBlocks("```ts\nconst f = /^```json/;\n```"), ["const f = /^```json/;"]);
  assert.deepEqual(extractFencedBlocks("````md\n```ts\nx\n```\n````"), ["```ts\nx\n```"]);
  assert.deepEqual(extractFencedBlocks("```ts\r\na\r\n```\r\n"), ["a"]);
});

test("vendored deterministic-extensions core matches its provenance hashes", () => {
  const dir = path.resolve(__dirname, "../../../src/vendor/deterministic-extensions");
  const provenance = JSON.parse(fs.readFileSync(path.join(dir, "provenance.json"), "utf8")) as { files: Record<string, string> };
  const present = fs.readdirSync(dir).filter((f) => f.endsWith(".mjs")).sort();
  assert.deepEqual(present, Object.keys(provenance.files).sort());
  for (const [file, sha256] of Object.entries(provenance.files)) {
    assert.equal(createHash("sha256").update(fs.readFileSync(path.join(dir, file))).digest("hex"), sha256, file);
  }
});
