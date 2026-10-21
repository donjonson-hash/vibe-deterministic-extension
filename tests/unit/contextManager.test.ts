import { test, describe } from "node:test";
import * as assert from "node:assert/strict";
import { ContextManager } from "../../src/core/contextManager";

describe("ContextManager (Deterministic AST Extraction)", () => {
  const manager = new ContextManager();

  const sampleCode = `
    import { readFileSync } from "fs";
    import * as path from "path";

    export interface UserConfig {
      id: string;
    }

    export class AuthService {
      public login(): boolean { return true; }
    }

    function internalHelper() {}
  `;

  test("должен точно извлекать импорты, экспорты и объявления из AST", () => {
    const ctx = manager.extractFileContext("auth.ts", sampleCode);

    assert.deepEqual(ctx.imports, ["fs", "path"]);
    assert.deepEqual(ctx.exportedSymbols, ["UserConfig", "AuthService"]);
    assert.deepEqual(ctx.functionsAndClasses, ["UserConfig", "AuthService", "internalHelper"]);
    assert.equal(ctx.contextHash.length, 64);
  });

  test("должен выдавать идентичный SHA-256 хеш при повторных вызовах (детерминизм)", () => {
    const ctx1 = manager.extractFileContext("auth.ts", sampleCode);
    const ctx2 = manager.extractFileContext("auth.ts", sampleCode);

    assert.equal(ctx1.contextHash, ctx2.contextHash);
  });
});
