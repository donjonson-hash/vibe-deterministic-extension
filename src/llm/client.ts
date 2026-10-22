import { computeDeterministicHash } from "../utils/crypto";
import { DETERMINISTIC_SYSTEM_PROMPT, buildUserPrompt, PromptBuildInput } from "./promptTemplates";
import { DeterministicLLMResponse, validateSchema } from "./schemaParser";

export interface LLMRequestPayload {
  model: string;
  temperature: 0;
  top_p: 1;
  seed: number;
  response_format: { type: "json_object" };
  messages: Array<{ role: "system" | "user"; content: string }>;
}

export type LLMTransport = (payload: LLMRequestPayload) => Promise<string>;

export interface LLMExecutionResult {
  rawJson: string;
  parsed: DeterministicLLMResponse;
  requestHash: string;
  cacheHit: boolean;
}

export interface DeterministicLLMClientOptions {
  model?: string;
  seed?: number;
  apiEndpoint?: string;
  apiKey?: string;
  requestTimeoutMs?: number;
  transport?: LLMTransport;
}

export class DeterministicLLMClient {
  private readonly model: string;
  private readonly seed: number;
  private readonly apiEndpoint: string;
  private readonly apiKey: string;
  private readonly requestTimeoutMs: number;
  private readonly transport: LLMTransport;
  private readonly responseCache = new Map<string, string>();

  constructor(options: DeterministicLLMClientOptions = {}) {
    this.model = options.model ?? "gpt-4o-mini";
    this.seed = options.seed ?? 42;
    this.apiEndpoint = options.apiEndpoint ?? "https://api.openai.com/v1/chat/completions";
    this.apiKey = options.apiKey ?? process.env.VIBE_LLM_API_KEY ?? "";
    this.requestTimeoutMs = options.requestTimeoutMs ?? 60_000;
    this.transport = options.transport ?? this.defaultHttpTransport.bind(this);
  }

  /**
   * Формирует строго детерминированный запрос (temperature = 0) с проверкой SHA-256 кеша
   */
  public async generatePatch(input: PromptBuildInput): Promise<LLMExecutionResult> {
    const userPrompt = buildUserPrompt(input);

    const payload: LLMRequestPayload = {
      model: this.model,
      temperature: 0,
      top_p: 1,
      seed: this.seed,
      response_format: { type: "json_object" },
      messages: [
        { role: "system", content: DETERMINISTIC_SYSTEM_PROMPT },
        { role: "user", content: userPrompt },
      ],
    };

    const requestHash = computeDeterministicHash(JSON.stringify(payload));

    // Используем кеш только если нет ошибки от предыдущей попытки
    if (!input.errorFeedback && this.responseCache.has(requestHash)) {
      const cachedRaw = this.responseCache.get(requestHash)!;
      return {
        rawJson: cachedRaw,
        parsed: validateSchema(cachedRaw),
        requestHash,
        cacheHit: true,
      };
    }

    const rawOutput = await this.transport(payload);
    const sanitizedJson = this.stripMarkdownFences(rawOutput);
    const parsed = validateSchema(sanitizedJson);

    // Сохраняем в кеш только валидный по схеме JSON
    this.responseCache.set(requestHash, sanitizedJson);

    return {
      rawJson: sanitizedJson,
      parsed,
      requestHash,
      cacheHit: false,
    };
  }

  /**
   * Удаляет случайные ```json ... ``` обертки, если модель их добавила
   */
  public stripMarkdownFences(text: string): string {
    const trimmed = text.trim();
    const fenceMatch = trimmed.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
    return fenceMatch ? fenceMatch[1].trim() : trimmed;
  }

  /**
   * false — клиент работает в локальном демо-режиме (VIBE_LLM_API_KEY не задан)
   */
  public hasApiKey(): boolean {
    return this.apiKey.length > 0;
  }

  public getCacheSize(): number {
    return this.responseCache.size;
  }

  public clearCache(): void {
    this.responseCache.clear();
  }

  private async defaultHttpTransport(payload: LLMRequestPayload): Promise<string> {
    if (!this.apiKey) {
      // Локальный детерминированный fallback, если API-ключ не задан
      return JSON.stringify({
        intentSummary: "Local deterministic fallback patch",
        patches: [
          {
            targetFile: "src/index.ts",
            searchBlock: "// old",
            replaceBlock: "const cached: boolean = true; return cached;",
            explanation: `Generated deterministically with seed ${payload.seed}`,
          },
        ],
      });
    }

    const response = await fetch(this.apiEndpoint, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${this.apiKey}`,
      },
      body: JSON.stringify(payload),
      // Без таймаута зависший endpoint навсегда блокирует конвейер
      signal: AbortSignal.timeout(this.requestTimeoutMs),
    });

    if (!response.ok) {
      throw new Error(`LLM HTTP Error ${response.status}: ${await response.text()}`);
    }

    const data = (await response.json()) as {
      choices?: Array<{ message?: { content?: string } }>;
    };
    const content = data.choices?.[0]?.message?.content;
    if (!content) {
      throw new Error("Empty response from LLM endpoint");
    }
    return content;
  }
}
