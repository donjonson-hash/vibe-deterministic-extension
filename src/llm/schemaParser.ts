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

export function validateSchema(rawJson: string): DeterministicLLMResponse {
  const parsed = JSON.parse(rawJson);
  if (!parsed.intentSummary || !Array.isArray(parsed.patches)) {
    throw new Error("SchemaValidationError: Ответ LLM нарушает строгую JSON-схему");
  }
  return parsed as DeterministicLLMResponse;
}
