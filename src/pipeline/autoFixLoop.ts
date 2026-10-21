import { VibeStateMachine } from "../core/stateMachine";

export async function runWithAutoFix(
  stateMachine: VibeStateMachine,
  generateFn: (errorFeedback?: string) => Promise<string>,
  validateFn: (patchJson: string) => Promise<{ valid: boolean; error?: string }>,
  maxRetries = 3
): Promise<string> {
  let lastError: string | undefined;

  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    stateMachine.transitionTo(attempt === 1 ? "GENERATING_LLM" : "AUTO_FIX_LOOP");
    const rawResponse = await generateFn(lastError);

    stateMachine.transitionTo("VALIDATING_PIPELINE");
    const validation = await validateFn(rawResponse);

    if (validation.valid) {
      stateMachine.transitionTo("APPLIED");
      return rawResponse;
    }

    lastError = validation.error;
    console.warn(`[AutoFixLoop] Попытка ${attempt}/${maxRetries} отклонена конвейером: ${lastError}`);
  }

  stateMachine.transitionTo("FAILED");
  throw new Error(`Превышен лимит попыток (${maxRetries}). Последняя ошибка: ${lastError}`);
}
