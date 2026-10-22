import { test, describe } from "node:test";
import * as assert from "node:assert/strict";
import { SemanticDiffEngine } from "../../src/ui/semanticDiff";

describe("SemanticDiffEngine (AST Semantic Comparison & Risk Scoring)", () => {
  const engine = new SemanticDiffEngine();

  test("должен игнорировать изменения пробелов, переносов строк и комментариев", () => {
    const before = `
      // Старый комментарий
      export function compute(a: number): number {
        return a * 2;
      }
    `;
    const after = `
      /* Новый многострочный комментарий */
      export function compute(  a: number ): number { return a * 2; }
    `;

    const report = engine.compareCode(before, after, "math.ts");
    assert.equal(report.changes.length, 0);
    assert.equal(report.riskLevel, "LOW");
  });

  test("должен точно распознавать ADDED, MODIFIED и REMOVED сущности в AST", () => {
    const before = `
      import { readFileSync } from "fs";
      export function keepMe(): number { return 1; }
      function modifyMe(): number { return 10; }
      function deleteMe(): void {}
    `;

    const after = `
      import { readFileSync } from "fs";
      import * as path from "path";
      export function keepMe(): number { return 1; }
      function modifyMe(): number { return 20; }
      export class NewService {}
    `;

    const report = engine.compareCode(before, after, "service.ts");

    const addedImport = report.changes.find((c) => c.kind === "import" && c.name === "path");
    const addedClass = report.changes.find((c) => c.kind === "class" && c.name === "NewService");
    const modifiedFn = report.changes.find((c) => c.kind === "function" && c.name === "modifyMe");
    const removedFn = report.changes.find((c) => c.kind === "function" && c.name === "deleteMe");

    assert.equal(addedImport?.changeType, "ADDED");
    assert.equal(addedClass?.changeType, "ADDED");
    assert.equal(modifiedFn?.changeType, "MODIFIED");
    assert.equal(removedFn?.changeType, "REMOVED");
    assert.equal(report.riskLevel, "HIGH");
  });

  test("должен присваивать уровень риска MEDIUM при изменении только внутренних (неэкспортируемых) функций", () => {
    const before = `function helper(): number { return 1; }`;
    const after = `function helper(): number { return 2; }`;

    const report = engine.compareCode(before, after, "internal.ts");
    assert.equal(report.changes.length, 1);
    assert.equal(report.riskLevel, "MEDIUM");
  });
});
