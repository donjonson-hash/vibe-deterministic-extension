// LLM transports for the patch-format spike. Each provider gets one system and one
// user message and returns raw text plus token usage; grading happens elsewhere.

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
}

export type Provider = (request: ChatRequest) => Promise<ChatResult>;

export interface OllamaOptions {
  baseUrl: string;
  numCtx: number;
  timeoutMs: number;
}

/**
 * Native Ollama /api/chat. The OpenAI-compatible /v1 endpoint cannot set num_ctx,
 * and Ollama silently truncates prompts longer than the model's default context.
 */
export function ollamaProvider(model: string, options: OllamaOptions): Provider {
  return async ({ system, user, json }) => {
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
    };
    const inputTokens = data.prompt_eval_count ?? 0;
    if (inputTokens >= options.numCtx) {
      throw new Error(`Prompt reached num_ctx (${inputTokens} >= ${options.numCtx}); input was probably truncated`);
    }
    return {
      text: data.message?.content ?? "",
      inputTokens,
      outputTokens: data.eval_count ?? 0,
      latencyMs: Date.now() - started,
    };
  };
}

export interface OpenAiCompatibleOptions {
  baseUrl: string;
  apiKey: string;
  timeoutMs: number;
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
        temperature: 0,
        seed: 42,
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
      choices?: Array<{ message?: { content?: string } }>;
      usage?: { prompt_tokens?: number; completion_tokens?: number };
    };
    return {
      text: data.choices?.[0]?.message?.content ?? "",
      inputTokens: data.usage?.prompt_tokens ?? 0,
      outputTokens: data.usage?.completion_tokens ?? 0,
      latencyMs: Date.now() - started,
    };
  };
}
