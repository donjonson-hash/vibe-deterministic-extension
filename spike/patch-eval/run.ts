// Patch-format spike runner: one model, one response format, all tasks, sequentially.
// Usage: node dist-spike/spike/patch-eval/run.js --provider ollama --model qwen2.5-coder:7b-32k --format sr
import * as fs from "node:fs";
import * as path from "node:path";
import { parseArgs } from "node:util";
import { ContextManager } from "../../src/core/contextManager";
import { DETERMINISTIC_SYSTEM_PROMPT, buildUserPrompt } from "../../src/llm/promptTemplates";
import { computeDeterministicHash } from "../../src/utils/crypto";
import {
  AttemptOutcome,
  EvalTask,
  changedLineCount,
  checkIntent,
  collateralChanges,
  evaluateSearchReplace,
  evaluateWholeFile,
} from "./grade";
import { Provider, ollamaProvider, openAiCompatibleProvider } from "./providers";

export const WHOLE_FILE_SYSTEM_PROMPT = `You edit a single source file for a vibe-coding tool.
CRITICAL RULES:
1. Respond with the COMPLETE updated file in exactly one fenced code block, and nothing else.
2. Change only what the intent requires. Keep every other line, comment and formatting exactly as it is.
3. NEVER use 'any', 'eval()', 'new Function()', or 'debugger'.`;

type Format = "sr" | "wf";

const SPIKE_DIR = path.resolve(__dirname, "../../../spike/patch-eval");

function buildWholeFileUser(task: EvalTask, source: string, errorFeedback?: string): string {
  const sections = [`=== VIBE INTENT ===\n${task.intent}`, `=== FILE: ${task.file} ===\n${source}`];
  if (errorFeedback) {
    sections.push(`=== PREVIOUS PIPELINE ERROR (MUST FIX) ===\n${errorFeedback}`);
  }
  return sections.join("\n\n");
}

function makeProvider(values: Record<string, string | undefined>): Provider {
  const model = values.model!;
  const timeoutMs = Number(values["timeout-ms"] ?? 600_000);
  if (values.provider === "ollama") {
    return ollamaProvider(model, {
      baseUrl: values["base-url"] ?? "http://127.0.0.1:11434",
      numCtx: Number(values["num-ctx"] ?? 16384),
      timeoutMs,
    });
  }
  if (values.provider === "openai-compat") {
    const keyEnv = values["api-key-env"] ?? "OPENAI_API_KEY";
    const apiKey = process.env[keyEnv] ?? "";
    if (!apiKey) {
      throw new Error(`Environment variable ${keyEnv} is empty`);
    }
    return openAiCompatibleProvider(model, {
      baseUrl: values["base-url"] ?? "https://api.openai.com/v1",
      apiKey,
      timeoutMs,
    });
  }
  throw new Error(`Unknown --provider ${values.provider}`);
}

async function main(): Promise<void> {
  const { values } = parseArgs({
    options: {
      provider: { type: "string" },
      model: { type: "string" },
      format: { type: "string" },
      tasks: { type: "string" },
      retries: { type: "string", default: "2" },
      out: { type: "string" },
      "base-url": { type: "string" },
      "num-ctx": { type: "string" },
      "timeout-ms": { type: "string" },
      "api-key-env": { type: "string" },
      "price-in": { type: "string", default: "0" },
      "price-out": { type: "string", default: "0" },
    },
  });
  if (!values.provider || !values.model || (values.format !== "sr" && values.format !== "wf")) {
    throw new Error("Required: --provider ollama|openai-compat --model <id> --format sr|wf");
  }
  const format = values.format as Format;
  const provider = makeProvider(values);
  const retries = Number(values.retries);
  const priceIn = Number(values["price-in"]);
  const priceOut = Number(values["price-out"]);

  const allTasks = JSON.parse(fs.readFileSync(path.join(SPIKE_DIR, "tasks.json"), "utf8")) as EvalTask[];
  const wanted = values.tasks ? new Set(values.tasks.split(",")) : null;
  const tasks = wanted ? allTasks.filter((t) => wanted.has(t.id)) : allTasks;

  const runId = `${values.model.replace(/[^\w.-]+/g, "_")}-${format}`;
  const outFile = values.out ?? path.join(SPIKE_DIR, "results", `${runId}.jsonl`);
  const rawDir = path.join(SPIKE_DIR, "results", "raw", runId);
  fs.mkdirSync(rawDir, { recursive: true });
  fs.writeFileSync(outFile, "");

  const systemPrompt = format === "sr" ? DETERMINISTIC_SYSTEM_PROMPT : WHOLE_FILE_SYSTEM_PROMPT;
  const contextManager = new ContextManager();

  for (const task of tasks) {
    const source = fs.readFileSync(path.join(SPIKE_DIR, "fixtures", task.file), "utf8");
    const context = contextManager.extractFileContext(task.file, source);
    const attempts: Array<Omit<AttemptOutcome, "patchedCode"> & { inputTokens: number; outputTokens: number; latencyMs: number }> = [];
    let finalOutcome: AttemptOutcome = { stage: "transport", error: "not attempted" };
    let errorFeedback: string | undefined;

    for (let attempt = 0; attempt <= retries; attempt++) {
      const user =
        format === "sr"
          ? buildUserPrompt({ intent: task.intent, context, sourceCode: source, errorFeedback })
          : buildWholeFileUser(task, source, errorFeedback);
      let outcome: AttemptOutcome;
      let usage = { inputTokens: 0, outputTokens: 0, latencyMs: 0 };
      try {
        const result = await provider({ system: systemPrompt, user, json: format === "sr" });
        usage = { inputTokens: result.inputTokens, outputTokens: result.outputTokens, latencyMs: result.latencyMs };
        fs.writeFileSync(path.join(rawDir, `${task.id}-${attempt}.txt`), result.text);
        outcome = format === "sr"
          ? evaluateSearchReplace(result.text, source, task.file)
          : evaluateWholeFile(result.text, source, task.file);
      } catch (err) {
        outcome = { stage: "transport", error: err instanceof Error ? err.message : String(err) };
      }
      attempts.push({ stage: outcome.stage, error: outcome.error?.slice(0, 500), ...usage });
      finalOutcome = outcome;
      // Transport failures are infrastructure, not something the model can fix
      if (outcome.stage === "ok" || outcome.stage === "transport") break;
      errorFeedback = outcome.error;
    }

    const code = finalOutcome.patchedCode;
    const failedChecks = code ? checkIntent(task, code) : [];
    const collateral = code ? collateralChanges(task, source, code) : [];
    const inputTokens = attempts.reduce((s, a) => s + a.inputTokens, 0);
    const outputTokens = attempts.reduce((s, a) => s + a.outputTokens, 0);
    const record = {
      task: task.id,
      file: task.file,
      provider: values.provider,
      model: values.model,
      format,
      promptHash: computeDeterministicHash(systemPrompt).slice(0, 12),
      attempts,
      finalStage: finalOutcome.stage,
      attemptsUsed: attempts.length,
      intentPassed: Boolean(code) && failedChecks.length === 0,
      failedChecks,
      collateral,
      changedLines: code ? changedLineCount(source, code) : null,
      inputTokens,
      outputTokens,
      costUsd: (inputTokens * priceIn + outputTokens * priceOut) / 1_000_000,
      latencyMs: attempts.reduce((s, a) => s + a.latencyMs, 0),
    };
    fs.appendFileSync(outFile, JSON.stringify(record) + "\n");
    const mark = record.finalStage === "ok" ? (record.intentPassed ? "PASS" : "OK-but-intent-missed") : `FAIL@${record.finalStage}`;
    console.log(`${task.id} ${mark} attempts=${record.attemptsUsed} lines=${record.changedLines ?? "-"} collateral=${collateral.length} ${(record.latencyMs / 1000).toFixed(1)}s`);
  }
  console.log(`Results: ${outFile}`);
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
