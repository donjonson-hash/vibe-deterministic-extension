import { test, describe } from "node:test";
import * as assert from "node:assert/strict";
import { DeterministicLLMClient, LLMRequestPayload } from "../../src/llm/client";
import { ContextManager } from "../../src/core/contextManager";

describe("DeterministicLLMClient & PromptTemplates", () => {
  const contextManager = new ContextManager();
  const sampleCode = `export function getUser(): string {\n  // TODO\n  return "guest";\n}`;
  const sampleContext = contextManager.extractFileContext("user.ts", sampleCode);

  test("должен передавать строго temperature=0, seed=42 и json_object в транспорт", async () => {
    let capturedPayload: LLMRequestPayload | undefined;

    const client = new DeterministicLLMClient({
      model: "gpt-4o-mini",
      seed: 42,
      transport: async (payload) => {
        capturedPayload = payload;
        return JSON.stringify({
          intentSummary: "Add user caching",
          patches: [
            {
              targetFile: "user.ts",
              searchBlock: "// TODO",
              replaceBlock: "const role = 'admin';",
              explanation: "Set role",
            },
          ],
        });
      },
    });

    const result = await client.generatePatch({
      intent: "Add caching",
      context: sampleContext,
      sourceCode: sampleCode,
    });

    assert.ok(capturedPayload);
    assert.equal(capturedPayload.temperature, 0);
    assert.equal(capturedPayload.top_p, 1);
    assert.equal(capturedPayload.seed, 42);
    assert.equal(capturedPayload.response_format.type, "json_object");
    assert.equal(result.cacheHit, false);
    assert.equal(result.parsed.patches.length, 1);
  });

  test("должен возвращать ответ из SHA-256 кеша при повторном идентичном запросе без вызова сети", async () => {
    let networkCalls = 0;

    const client = new DeterministicLLMClient({
      transport: async () => {
        networkCalls++;
        return JSON.stringify({
          intentSummary: "Cached response",
          patches: [],
        });
      },
    });

    const first = await client.generatePatch({
      intent: "Optimize imports",
      context: sampleContext,
      sourceCode: sampleCode,
    });
    const second = await client.generatePatch({
      intent: "Optimize imports",
      context: sampleContext,
      sourceCode: sampleCode,
    });

    assert.equal(networkCalls, 1);
    assert.equal(first.cacheHit, false);
    assert.equal(second.cacheHit, true);
    assert.equal(first.requestHash, second.requestHash);
  });

  test("должен очищать Markdown-обертки ```json и обходить кеш при наличии errorFeedback", async () => {
    let networkCalls = 0;

    const client = new DeterministicLLMClient({
      transport: async (payload) => {
        networkCalls++;
        const userMsg = payload.messages[1].content;
        return "```json\n" + JSON.stringify({
          intentSummary: userMsg.includes("MUST FIX") ? "Fixed version" : "Initial",
          patches: [],
        }) + "\n```";
      },
    });

    await client.generatePatch({
      intent: "Refactor",
      context: sampleContext,
      sourceCode: sampleCode,
    });

    const retryWithError = await client.generatePatch({
      intent: "Refactor",
      context: sampleContext,
      sourceCode: sampleCode,
      errorFeedback: "TS1005: ';' expected",
    });

    assert.equal(networkCalls, 2);
    assert.equal(retryWithError.cacheHit, false);
    assert.equal(retryWithError.parsed.intentSummary, "Fixed version");
  });
});
