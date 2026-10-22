export interface CodePatch {
  targetFile: string;
  searchBlock: string;
  replaceBlock: string;
  explanation: string;
}

export interface DeterministicLLMResponse {
  intentSummary: string;
  patches: CodePatch[];
}

/**
 * Ошибка нарушения схемы ответа LLM — её можно вернуть модели на исправление (AutoFixLoop)
 */
export class SchemaValidationError extends Error {
  constructor(message: string) {
    super(`SchemaValidationError: ${message}`);
    this.name = "SchemaValidationError";
  }
}

const PATCH_STRING_FIELDS = ["targetFile", "searchBlock", "replaceBlock", "explanation"] as const;

export function validateSchema(rawJson: string): DeterministicLLMResponse {
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawJson);
  } catch (err) {
    throw new SchemaValidationError(
      `Ответ LLM не является валидным JSON (${err instanceof Error ? err.message : String(err)})`
    );
  }

  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new SchemaValidationError("Ответ LLM должен быть JSON-объектом");
  }

  const candidate = parsed as Record<string, unknown>;
  if (typeof candidate.intentSummary !== "string" || candidate.intentSummary.length === 0) {
    throw new SchemaValidationError("Поле intentSummary должно быть непустой строкой");
  }
  if (!Array.isArray(candidate.patches)) {
    throw new SchemaValidationError("Поле patches должно быть массивом");
  }

  const patches: CodePatch[] = candidate.patches.map((patch: unknown, index: number) => {
    if (typeof patch !== "object" || patch === null) {
      throw new SchemaValidationError(`patches[${index}] должен быть объектом`);
    }
    const fields = patch as Record<string, unknown>;
    for (const field of PATCH_STRING_FIELDS) {
      if (typeof fields[field] !== "string") {
        throw new SchemaValidationError(`patches[${index}].${field} должен быть строкой`);
      }
    }
    if ((fields.searchBlock as string).length === 0) {
      throw new SchemaValidationError(`patches[${index}].searchBlock не может быть пустым`);
    }
    return {
      targetFile: fields.targetFile as string,
      searchBlock: fields.searchBlock as string,
      replaceBlock: fields.replaceBlock as string,
      explanation: fields.explanation as string,
    };
  });

  return { intentSummary: candidate.intentSummary, patches };
}
