import { test, describe } from "node:test";
import * as assert from "node:assert/strict";
import { applySearchReplace } from "../../src/utils/patch";
import { validateSchema, SchemaValidationError } from "../../src/llm/schemaParser";
import { AstValidator } from "../../src/pipeline/astValidator";
import { LinterRunner } from "../../src/pipeline/linterRunner";
import { runWithAutoFix } from "../../src/pipeline/autoFixLoop";
import { VibeStateMachine } from "../../src/core/stateMachine";
import { SandboxRunner } from "../../src/core/sandboxRunner";
import { SemanticDiffEngine } from "../../src/ui/semanticDiff";
import { TimeMachine } from "../../src/ui/timeMachine";
import { CommandCenter } from "../../src/ui/commandCenter";

describe("Регрессии найденных ошибок", () => {
  test("applySearchReplace не интерпретирует $& и $1 в replaceBlock", () => {
    const res = applySearchReplace("const a = 1; // X", "// X", "s.replace(/a/, '$&$1$$');");
    assert.ok(res.ok);
    assert.equal(res.code, "const a = 1; s.replace(/a/, '$&$1$$');");
  });

  test("applySearchReplace отклоняет пустой и неоднозначный searchBlock", () => {
    assert.deepEqual(applySearchReplace("abc", "", "x"), { ok: false, reason: "EMPTY_SEARCH", occurrences: 0 });
    assert.deepEqual(applySearchReplace("a; a;", "a;", "b;"), { ok: false, reason: "AMBIGUOUS", occurrences: 2 });
  });

  test("AstValidator и TimeMachine сообщают о неоднозначном блоке", () => {
    const code = "let x = 1;\nlet y = 1;\n";
    const patch = { targetFile: "a.ts", searchBlock: "= 1;", replaceBlock: "= 2;", explanation: "" };
    const ast = new AstValidator().applyAndValidatePatch(code, patch);
    assert.equal(ast.valid, false);
    assert.ok(ast.errors[0].includes("SearchBlockAmbiguous"));

    const tm = new TimeMachine();
    assert.throws(() => tm.applyTransaction("x", [{ filePath: "a.ts", content: code }], [patch]), /неоднозначен/);
    assert.equal(tm.getHistory().length, 0);
  });

  test("validateSchema проверяет поля каждого патча и оборачивает ошибки JSON", () => {
    assert.throws(() => validateSchema("not json"), SchemaValidationError);
    assert.throws(() => validateSchema(JSON.stringify({ intentSummary: "x", patches: [null] })), SchemaValidationError);
    assert.throws(
      () => validateSchema(JSON.stringify({ intentSummary: "x", patches: [{ targetFile: "a.ts", searchBlock: 1 }] })),
      /searchBlock/
    );
  });

  test("AutoFixLoop повторяет попытку, если LLM вернула ответ, нарушающий схему", async () => {
    const sm = new VibeStateMachine();
    let attempts = 0;
    const result = await runWithAutoFix(
      sm,
      async (feedback) => {
        attempts++;
        if (attempts === 1) {
          return validateSchema("{ broken").intentSummary;
        }
        assert.ok(feedback?.includes("SchemaValidationError"));
        return "ok";
      },
      async () => ({ valid: true })
    );
    assert.equal(result, "ok");
    assert.equal(attempts, 2);
  });

  test("AutoFixLoop не повторяет сетевые ошибки и переводит автомат в FAILED", async () => {
    const sm = new VibeStateMachine();
    await assert.rejects(
      runWithAutoFix(sm, async () => { throw new Error("LLM HTTP Error 401"); }, async () => ({ valid: true })),
      /401/
    );
    assert.equal(sm.getState(), "FAILED");
  });

  test("LinterRunner ловит Function() без new и globalThis.eval()", () => {
    const res = new LinterRunner().lintCode(`const f = Function("return 1"); globalThis.eval("1");`);
    const rules = res.violations.map((v) => v.ruleId).sort();
    assert.deepEqual(rules, ["no-eval", "no-new-func"]);
  });

  test("lintPatch блокирует только новые нарушения, а не уже существующие в файле", () => {
    const linter = new LinterRunner();
    const original = `export function legacy(x: any) { return x; }\n// TODO\n`;
    const clean = original.replace("// TODO", "export const y: number = 1;");
    const dirty = original.replace("// TODO", "export const z: any = 1;");

    assert.equal(linter.lintPatch(original, clean).passed, true);
    const res = linter.lintPatch(original, dirty);
    assert.equal(res.passed, false);
    assert.equal(res.violations.length, 1);
    assert.equal(res.violations[0].line, 2);
  });

  test("SandboxRunner не отдает process хоста через конструкторы", () => {
    const sandbox = new SandboxRunner(200);
    const probes = [
      `(console.log as any).constructor("return process")()`,
      `(globalThis as any).constructor.constructor("return process")()`,
      `(exports as any).constructor.constructor("return process")()`,
    ];
    for (const probe of probes) {
      const res = sandbox.executeIsolated(probe);
      assert.equal(res.success, false, probe);
      assert.ok(res.error?.includes("Code generation from strings disallowed"), probe);
    }
  });

  test("SandboxRunner исполняет модули с импортами через инертные заглушки", () => {
    const res = new SandboxRunner(200).executeIsolated(`
      import { readFileSync } from "fs";
      import express from "express";
      const app = express();
      app.listen(3000);
      export const read = () => readFileSync("x");
    `);
    assert.equal(res.success, true, res.error);
    assert.equal(res.exportTypes.read, "function");
  });

  test("SandboxRunner прерывает бесконечную цепочку промисов по таймауту", () => {
    const res = new SandboxRunner().executeIsolated(
      `const loop = (): Promise<void> => Promise.resolve().then(loop); loop();`,
      undefined,
      100
    );
    assert.equal(res.success, false);
    assert.ok(res.error?.includes("timed out"));
  });

  test("SandboxRunner переживает исчерпание памяти в песочнице без падения хоста", async () => {
    const res = new SandboxRunner(3000).executeIsolated(
      `const chunks: string[] = []; while (true) { chunks.push("x".repeat(1_000_000)); }`
    );
    assert.equal(res.success, false);
    // Даем событию 'error' воркера дойти до хоста: без обработчика процесс бы упал
    await new Promise((resolve) => setTimeout(resolve, 50));
  });

  test("SandboxRunner сообщает о необработанном отклонении промиса", () => {
    const res = new SandboxRunner().executeIsolated(`Promise.reject(new Error("boom"));`);
    assert.equal(res.success, false);
    assert.ok(res.error?.includes("boom"));
  });

  test("SemanticDiffEngine замечает изменения верхнеуровневых вызовов", () => {
    const report = new SemanticDiffEngine().compareCode(`app.listen(80);`, `app.listen(8080);`, "server.ts");
    assert.equal(report.changes.length, 1);
    assert.equal(report.changes[0].kind, "statement");
    assert.equal(report.riskLevel, "MEDIUM");
  });

  test("CommandCenter распознает BUGFIX по слову 'почини' в начале фразы", () => {
    assert.equal(new CommandCenter().parseCommand("Почини авторизацию").category, "BUGFIX");
  });

  test("Голосовой ввод сохраняет имена файлов для targetMentions", () => {
    const cmd = new CommandCenter().parseCommand("ну добавь кеширование в auth.ts пожалуйста", true);
    assert.deepEqual(cmd.targetMentions, ["auth.ts"]);
  });
});
