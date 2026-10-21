import { test, describe } from "node:test";
import * as assert from "node:assert/strict";
import { AstValidator } from "../../src/pipeline/astValidator";
import { VibeStateMachine } from "../../src/core/stateMachine";
import { runWithAutoFix } from "../../src/pipeline/autoFixLoop";

describe("AstValidator & AutoFixLoop Pipeline", () => {
  const validator = new AstValidator();
  const originalCode = `export function calculate(a: number, b: number): number {\n  // TODO\n  return a + b;\n}`;

  test("должен успешно пропускать синтаксически корректный патч", () => {
    const result = validator.applyAndValidatePatch(originalCode, {
      targetFile: "math.ts",
      searchBlock: "// TODO",
      replaceBlock: "const sum = a + b;",
      explanation: "Add intermediate variable",
    });

    assert.equal(result.valid, true);
    assert.equal(result.errors.length, 0);
    assert.ok(result.patchedCode?.includes("const sum = a + b;"));
  });

  test("должен блокировать патч со сломанным синтаксисом (незакрытая скобка)", () => {
    const result = validator.applyAndValidatePatch(originalCode, {
      targetFile: "math.ts",
      searchBlock: "// TODO",
      replaceBlock: "if (a > 0 { return a;",
      explanation: "Broken syntax patch from LLM",
    });

    assert.equal(result.valid, false);
    assert.ok(result.errors.length > 0);
    assert.ok(result.errors[0].includes("TS1005"));
  });

  test("должен отклонять патч, если searchBlock не найден в исходном коде", () => {
    const result = validator.applyAndValidatePatch(originalCode, {
      targetFile: "math.ts",
      searchBlock: "// NON_EXISTENT_BLOCK",
      replaceBlock: "return 0;",
      explanation: "Hallucinated search block",
    });

    assert.equal(result.valid, false);
    assert.ok(result.errors[0].includes("SearchBlockNotFound"));
  });

  test("AutoFixLoop должен автоматически исправлять ошибку LLM со второй попытки", async () => {
    const stateMachine = new VibeStateMachine();
    let attempts = 0;

    const finalResponse = await runWithAutoFix(
      stateMachine,
      async (errorFeedback) => {
        attempts++;
        if (attempts === 1) {
          // 1-я попытка: LLM генерирует сломанный синтаксис
          return "const x = ;";
        }
        // 2-я попытка: LLM получила errorFeedback и исправила код
        assert.ok(errorFeedback?.includes("TS1109"));
        return "const x = 42;";
      },
      async (candidateCode) => {
        const check = validator.validateSyntax(candidateCode, "retry.ts");
        return { valid: check.valid, error: check.errors.join("; ") };
      },
      3
    );

    assert.equal(attempts, 2);
    assert.equal(finalResponse, "const x = 42;");
    assert.equal(stateMachine.getState(), "APPLIED");
  });
});
