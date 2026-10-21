import * as vscode from "vscode";
import { VibeStateMachine } from "./core/stateMachine";
import { validateSchema } from "./llm/schemaParser";
import { runWithAutoFix } from "./pipeline/autoFixLoop";

export function activate(context: vscode.ExtensionContext) {
  const stateMachine = new VibeStateMachine();

  const disposable = vscode.commands.registerCommand("vibe.executeIntent", async () => {
    const intent = await vscode.window.showInputBox({
      prompt: "Опишите ваш вайб-интент (например: Добавь кеширование в сервис)",
    });

    if (!intent) return;

    try {
      stateMachine.transitionTo("COLLECTING_CONTEXT");

      const verifiedPatch = await runWithAutoFix(
        stateMachine,
        async (errorFeedback) => {
          // Заглушка вызова LLM с temperature = 0
          return JSON.stringify({
            intentSummary: intent,
            patches: [
              {
                targetFile: "src/index.ts",
                searchBlock: "// old",
                replaceBlock: "// new deterministic code",
                explanation: errorFeedback ? "Fixed previous error" : "Initial patch",
              },
            ],
          });
        },
        async (rawJson) => {
          try {
            validateSchema(rawJson);
            return { valid: true };
          } catch (err: any) {
            return { valid: false, error: err.message };
          }
        }
      );

      vscode.window.showInformationMessage(`Патч успешно проверен и готов: ${verifiedPatch}`);
    } catch (error: any) {
      vscode.window.showErrorMessage(`Отказ системы безопасности: ${error.message}`);
    } finally {
      stateMachine.transitionTo("IDLE");
    }
  });

  context.subscriptions.push(disposable);
}

export function deactivate() {}
