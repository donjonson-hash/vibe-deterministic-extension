// Patch-format spike runner: one model, one response format, all tasks, sequentially.
// Usage: node dist-spike/spike/patch-eval/run.js --provider ollama --model qwen2.5-coder:7b-32k --format sr
import * as fs from "node:fs";
import * as path from "node:path";
import { parseArgs } from "node:util";
import { ContextManager } from "../../src/core/contextManager";
import { DETERMINISTIC_SYSTEM_PROMPT, buildUserPrompt } from "../../src/llm/promptTemplates";
import { computeDeterministicHash } from "../../src/utils/crypto";
import { AttemptOutcome, EvalTask, Format, GradedResponse, gradeResponse, redactSecrets, ungraded } from "./grade";
import { Provider, anthropicProvider, ollamaProvider, openAiCompatibleProvider } from "./providers";

export const WHOLE_FILE_SYSTEM_PROMPT = `You edit a single source file for a vibe-coding tool.
CRITICAL RULES:
1. Respond with the COMPLETE updated file in exactly one fenced code block, and nothing else.
2. Change only what the intent requires. Keep every other line, comment and formatting exactly as it is.
3. NEVER use 'any', 'eval()', 'new Function()', or 'debugger'.`;

const SPIKE_DIR = path.resolve(__dirname, "../../../spike/patch-eval");

/** Raw responses live next to their results file: <dir>/raw/<name>/ (regrade.ts relies on this) */
export function rawDirFor(outFile: string): string {
  return path.join(path.dirname(outFile), "raw", path.basename(outFile, ".jsonl"));
}

function buildWholeFileUser(task: EvalTask, source: string, errorFeedback?: string): string {
  const sections = [`=== VIBE INTENT ===\n${task.intent}`, `=== FILE: ${task.file} ===\n${source}`];
  if (errorFeedback) {
    sections.push(`=== PREVIOUS PIPELINE ERROR (MUST FIX) ===\n${errorFeedback}`);
  }
  return sections.join("\n\n");
}

function makeProvider(values: Record<string, string | undefined>, sampling: boolean): Provider {
  const model = values.model!;
  const timeoutMs = Number(values["timeout-ms"] ?? 600_000);
  if (values.provider === "ollama") {
    return ollamaProvider(model, {
      baseUrl: values["base-url"] ?? "http://127.0.0.1:11434",
      numCtx: Number(values["num-ctx"] ?? 16384),
      numPredict: Number(values["num-predict"] ?? 8192),
      timeoutMs,
    });
  }
  if (values.provider === "openai-compat") {
    const keyEnv = values["api-key-env"] ?? "OPENAI_API_KEY";
    const apiKey = process.env[keyEnv] ?? "";
    if (!apiKey) {
      // The variable name comes from the command line; keep it out of logs
      throw new Error("The API key environment variable (--api-key-env, default OPENAI_API_KEY) is empty");
    }
    return openAiCompatibleProvider(model, {
      baseUrl: values["base-url"] ?? "https://api.openai.com/v1",
      apiKey,
      timeoutMs,
      sampling,
    });
  }
  if (values.provider === "anthropic") {
    if (!process.env.ANTHROPIC_API_KEY) {
      throw new Error("Environment variable ANTHROPIC_API_KEY is empty");
    }
    const effort = (values.effort ?? "medium") as "low" | "medium" | "high" | "xhigh" | "max";
    return anthropicProvider(model, { effort, timeoutMs });
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
      "num-predict": { type: "string" },
      "timeout-ms": { type: "string" },
      "api-key-env": { type: "string" },
      effort: { type: "string" },
      "no-sampling": { type: "boolean", default: false },
      repeat: { type: "string", default: "1" },
      "price-in": { type: "string", default: "0" },
      "price-out": { type: "string", default: "0" },
    },
  });
  if (!values.provider || !values.model || (values.format !== "sr" && values.format !== "wf")) {
    throw new Error("Required: --provider ollama|openai-compat|anthropic --model <id> --format sr|wf");
  }
  const format = values.format as Format;
  const { "no-sampling": noSampling, ...stringValues } = values;
  const provider = makeProvider(stringValues, !noSampling);
  const retries = Number(values.retries);
  const priceIn = Number(values["price-in"]);
  const priceOut = Number(values["price-out"]);
  const repeat = Number(values.repeat);

  const allTasks = JSON.parse(fs.readFileSync(path.join(SPIKE_DIR, "tasks.json"), "utf8")) as EvalTask[];
  const wanted = values.tasks ? new Set(values.tasks.split(",")) : null;
  const tasks = wanted ? allTasks.filter((t) => wanted.has(t.id)) : allTasks;

  const runId = `${values.model.replace(/[^\w.-]+/g, "_")}-${format}`;
  const outFile = values.out ?? path.join(SPIKE_DIR, "results", `${runId}.jsonl`);
  const rawDir = rawDirFor(outFile);
  // The results file is truncated, so stale raw responses from an earlier run must go too
  fs.rmSync(rawDir, { recursive: true, force: true });
  fs.mkdirSync(rawDir, { recursive: true });
  fs.writeFileSync(outFile, "");

  const systemPrompt = format === "sr" ? DETERMINISTIC_SYSTEM_PROMPT : WHOLE_FILE_SYSTEM_PROMPT;
  const contextManager = new ContextManager();

  for (let rep = 1; rep <= repeat; rep++) for (const task of tasks) {
    const source = fs.readFileSync(path.join(SPIKE_DIR, "fixtures", task.file), "utf8");
    const context = contextManager.extractFileContext(task.file, source);
    const attempts: Array<Omit<AttemptOutcome, "patchedCode"> & { inputTokens: number; outputTokens: number; latencyMs: number }> = [];
    let graded: GradedResponse = ungraded({ stage: "transport", error: "not attempted" });
    let errorFeedback: string | undefined;

    for (let attempt = 0; attempt <= retries; attempt++) {
      const user =
        format === "sr"
          ? buildUserPrompt({ intent: task.intent, context, sourceCode: source, errorFeedback })
          : buildWholeFileUser(task, source, errorFeedback);
      let usage = { inputTokens: 0, outputTokens: 0, latencyMs: 0 };
      try {
        const result = await provider({ system: systemPrompt, user, json: format === "sr" });
        // Billed even when the response is incomplete, so usage is recorded first
        usage = { inputTokens: result.inputTokens, outputTokens: result.outputTokens, latencyMs: result.latencyMs };
        fs.writeFileSync(path.join(rawDir, `${task.id}-r${rep}-${attempt}.txt`), result.text);
        graded = result.incomplete
          ? ungraded({ stage: "incomplete", error: `Response stopped early: ${result.incomplete}` })
          : gradeResponse(task, format, result.text, source);
      } catch (err) {
        // Node's fetch reports "fetch failed"; the cause says why (e.g. UND_ERR_HEADERS_TIMEOUT)
        const cause = err instanceof Error && err.cause instanceof Error ? ` (${(err.cause as { code?: string }).code ?? err.cause.message})` : "";
        graded = ungraded({ stage: "transport", error: (err instanceof Error ? err.message : String(err)) + cause });
      }
      const outcome: AttemptOutcome = graded.outcome;
      attempts.push({ stage: outcome.stage, error: outcome.error && redactSecrets(outcome.error).slice(0, 500), ...usage });
      // Transport and early stops are not something the model can fix from an error message
      if (outcome.stage === "ok" || outcome.stage === "transport" || outcome.stage === "incomplete") break;
      errorFeedback = outcome.error;
    }

    const inputTokens = attempts.reduce((s, a) => s + a.inputTokens, 0);
    const outputTokens = attempts.reduce((s, a) => s + a.outputTokens, 0);
    const record = {
      task: task.id,
      rep,
      file: task.file,
      provider: values.provider,
      model: values.model,
      format,
      promptHash: computeDeterministicHash(systemPrompt).slice(0, 12),
      attempts,
      finalStage: graded.outcome.stage,
      attemptsUsed: attempts.length,
      maxAttempts: retries + 1,
      intentPassed: graded.intentPassed,
      failedChecks: graded.failedChecks,
      collateral: graded.collateral,
      changedLines: graded.changedLines,
      inputTokens,
      outputTokens,
      costUsd: (inputTokens * priceIn + outputTokens * priceOut) / 1_000_000,
      latencyMs: attempts.reduce((s, a) => s + a.latencyMs, 0),
    };
    fs.appendFileSync(outFile, JSON.stringify(record) + "\n");
    const mark = record.finalStage === "ok" ? (record.intentPassed ? "PASS" : "OK-but-intent-missed") : `FAIL@${record.finalStage}`;
    console.log(`${task.id} r${rep} ${mark} attempts=${record.attemptsUsed} lines=${record.changedLines ?? "-"} collateral=${record.collateral.length} ${(record.latencyMs / 1000).toFixed(1)}s`);
  }
  console.log(`Results: ${outFile}`);
}

if (require.main === module) {
  main().catch((err) => {
    // Provider HTTP errors can echo key fragments
    console.error(redactSecrets(err instanceof Error ? err.message : String(err)));
    process.exit(1);
  });
}
