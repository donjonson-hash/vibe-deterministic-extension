import { test, describe } from "node:test";
import * as assert from "node:assert/strict";
import { LinterRunner } from "../../src/pipeline/linterRunner";
import { SandboxRunner } from "../../src/core/sandboxRunner";

describe("LinterRunner & SandboxRunner (Security & Isolation)", () => {
  const linter = new LinterRunner();
  const sandbox = new SandboxRunner(200);

  test("LinterRunner должен пропускать чистый типизированный код", () => {
    const cleanCode = `export function multiply(a: number, b: number): number { return a * b; }`;
    const res = linter.lintCode(cleanCode);
    assert.equal(res.passed, true);
    assert.equal(res.violations.length, 0);
  });

  test("LinterRunner должен блокировать eval(), debugger и тип any", () => {
    const badCode = `
      export function unsafe(input: any) {
        debugger;
        return eval(input);
      }
    `;
    const res = linter.lintCode(badCode);
    assert.equal(res.passed, false);
    const rules = res.violations.map((v) => v.ruleId);
    assert.ok(rules.includes("no-explicit-any"));
    assert.ok(rules.includes("no-debugger"));
    assert.ok(rules.includes("no-eval"));
  });

  test("SandboxRunner должен изолированно исполнять код и проверять assertions", () => {
    const tsCode = `
      export function add(x: number, y: number): number {
        console.log("adding", x, y);
        return x + y;
      }
    `;
    const res = sandbox.executeIsolated(
      tsCode,
      `if (exports.add(2, 3) !== 5) { throw new Error("Assertion failed"); }`
    );

    assert.equal(res.success, true);
    assert.deepEqual(res.logs, ["adding 2 3"]);
    assert.equal(typeof res.exports.add, "function");
  });

  test("SandboxRunner должен прерывать бесконечный цикл по таймауту", () => {
    const infiniteLoopCode = `
      export function hang(): void {
        while (true) {}
      }
      hang();
    `;
    const res = sandbox.executeIsolated(infiniteLoopCode, undefined, 100);
    assert.equal(res.success, false);
    assert.ok(res.error?.includes("Script execution timed out"));
  });
});
