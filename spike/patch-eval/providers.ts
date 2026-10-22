// LLM transports for the patch-format spike. Each provider gets one system and one
// user message and returns raw text plus token usage; grading happens elsewhere.
import Anthropic from "@anthropic-ai/sdk";

export interface ChatRequest {
  system: string;
  user: string;
  /** Ask the provider for a JSON object response when it supports it */
  json: boolean;
}

export interface ChatResult {
  text: string;
  inputTokens: number;
  outputTokens: number;
  latencyMs: number;
  /** Set when the provider stopped early (refusal, output limit); usage is still billed */
  incomplete?: string;
}

export type Provider = (request: ChatRequest) => Promise<ChatResult>;

export interface OllamaOptions {
  baseUrl: string;
  numCtx: number;
  timeoutMs: number;
}

/** Room left for the answer when checking that a prompt fits num_ctx */
const OLLAMA_OUTPUT_RESERVE_TOKENS = 4096;

/**
 * Native Ollama /api/chat. The OpenAI-compatible /v1 endpoint cannot set num_ctx,
 * and Ollama silently truncates prompts longer than the context.
 * prompt_eval_count excludes a KV-cached prefix, so it can't detect truncation (and
 * undercounts input tokens on retries); a conservative estimate of ~3 characters per
 * token is checked before sending instead.
 */
export function ollamaProvider(model: string, options: OllamaOptions): Provider {
  return async ({ system, user, json }) => {
    const estimatedTokens = Math.ceil((system.length + user.length) / 3);
    if (estimatedTokens > options.numCtx - OLLAMA_OUTPUT_RESERVE_TOKENS) {
      throw new Error(`Prompt (~${estimatedTokens} tokens) does not fit num_ctx ${options.numCtx} with output reserve`);
    }
    const started = Date.now();
    const response = await fetch(`${options.baseUrl}/api/chat`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model,
        stream: false,
        ...(json ? { format: "json" } : {}),
        options: { temperature: 0, seed: 42, num_ctx: options.numCtx },
        messages: [
          { role: "system", content: system },
          { role: "user", content: user },
        ],
      }),
      signal: AbortSignal.timeout(options.timeoutMs),
    });
    if (!response.ok) {
      throw new Error(`Ollama HTTP ${response.status}: ${await response.text()}`);
    }
    const data = (await response.json()) as {
      message?: { content?: string };
      prompt_eval_count?: number;
      eval_count?: number;
      done_reason?: string;
    };
    return {
      text: data.message?.content ?? "",
      inputTokens: data.prompt_eval_count ?? 0,
      outputTokens: data.eval_count ?? 0,
      latencyMs: Date.now() - started,
      ...(data.done_reason === "length" ? { incomplete: "done_reason=length" } : {}),
    };
  };
}

export interface OpenAiCompatibleOptions {
  baseUrl: string;
  apiKey: string;
  timeoutMs: number;
  /** Reasoning models (e.g. current OpenAI ones) reject temperature/seed; omit them */
  sampling: boolean;
}

/**
 * OpenAI Chat Completions shape: OpenAI, Gemini OpenAI-compat, OpenRouter, LM Studio, vLLM.
 */
export function openAiCompatibleProvider(model: string, options: OpenAiCompatibleOptions): Provider {
  return async ({ system, user, json }) => {
    const started = Date.now();
    const response = await fetch(`${options.baseUrl}/chat/completions`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(options.apiKey ? { Authorization: `Bearer ${options.apiKey}` } : {}),
      },
      body: JSON.stringify({
        model,
        ...(options.sampling ? { temperature: 0, seed: 42 } : {}),
        ...(json ? { response_format: { type: "json_object" } } : {}),
        messages: [
          { role: "system", content: system },
          { role: "user", content: user },
        ],
      }),
      signal: AbortSignal.timeout(options.timeoutMs),
    });
    if (!response.ok) {
      throw new Error(`HTTP ${response.status}: ${await response.text()}`);
    }
    const data = (await response.json()) as {
      choices?: Array<{ message?: { content?: string }; finish_reason?: string }>;
      usage?: { prompt_tokens?: number; completion_tokens?: number };
    };
    const finishReason = data.choices?.[0]?.finish_reason;
    return {
      text: data.choices?.[0]?.message?.content ?? "",
      inputTokens: data.usage?.prompt_tokens ?? 0,
      outputTokens: data.usage?.completion_tokens ?? 0,
      latencyMs: Date.now() - started,
      ...(finishReason === "length" || finishReason === "content_filter"
        ? { incomplete: `finish_reason=${finishReason}` }
        : {}),
    };
  };
}

/** Same shape that validateSchema() accepts; structured outputs enforce it server-side */
const PATCH_RESPONSE_SCHEMA = {
  type: "object",
  properties: {
    intentSummary: { type: "string" },
    patches: {
      type: "array",
      items: {
        type: "object",
        properties: {
          targetFile: { type: "string" },
          searchBlock: { type: "string" },
          replaceBlock: { type: "string" },
          explanation: { type: "string" },
        },
        required: ["targetFile", "searchBlock", "replaceBlock", "explanation"],
        additionalProperties: false,
      },
    },
  },
  required: ["intentSummary", "patches"],
  additionalProperties: false,
};

export interface AnthropicOptions {
  effort: "low" | "medium" | "high" | "xhigh" | "max";
  timeoutMs: number;
}

/**
 * Claude Messages API via the official SDK. Server-side refusal fallbacks are left off
 * on purpose: a fallback would answer with a different model and blur the measurement.
 */
export function anthropicProvider(model: string, options: AnthropicOptions): Provider {
  // Reads ANTHROPIC_API_KEY (or another configured credential) from the environment
  const client = new Anthropic({ timeout: options.timeoutMs, maxRetries: 2 });
  return async ({ system, user, json }) => {
    const started = Date.now();
    const response = await client.messages.create({
      model,
      max_tokens: 16000,
      system,
      messages: [{ role: "user", content: user }],
      output_config: {
        effort: options.effort,
        ...(json ? { format: { type: "json_schema" as const, schema: PATCH_RESPONSE_SCHEMA } } : {}),
      },
    });
    const text = response.content
      .filter((block): block is Anthropic.TextBlock => block.type === "text")
      .map((block) => block.text)
      .join("");
    return {
      text,
      inputTokens: response.usage.input_tokens,
      outputTokens: response.usage.output_tokens,
      latencyMs: Date.now() - started,
      ...(response.stop_reason === "refusal" || response.stop_reason === "max_tokens"
        ? { incomplete: `stop_reason=${response.stop_reason}` }
        : {}),
    };
  };
}
