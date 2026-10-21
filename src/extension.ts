import * as vscode from "vscode";
import { VibeStateMachine } from "./core/stateMachine";
import { ContextManager } from "./core/contextManager";
import { validateSchema } from "./llm/schemaParser";
import { AstValidator } from "./pipeline/astValidator";
import { runWithAutoFix } from "./pipeline/autoFixLoop";

export function activate(context: vscode.ExtensionContext) {
  const stateMachine = new VibeStateMachine();
  const contextManager = new ContextManager();
  const astValidator = new AstValidator();

  const disposable = vscode.commands.registerCommand("vibe.executeIntent", async () => {
    const editor = vscode.window.activeTextEditor;
    const currentCode = editor?.document.getText() ?? "export function hello() {\n  // old\n}\n";
    const currentFile = editor?.document.fileName ?? "src/index.ts";

    const intent = await vscode.window.showInputBox({
      prompt: "Опишите ваш вайб-интент (например: Добавь кеширование в сервис)",
    });

    if (!intent) return;

    try {
      stateMachine.transitionTo("COLLECTING_CONTEXT");
      const fileContext = contextManager.extractFileContext(currentFile, currentCode);

      const verifiedPatch = await runWithAutoFix(
        stateMachine,
        async (errorFeedback) => {
          // Вызов LLM с контекстом AST и хешем состояния
          return JSON.stringify({
            intentSummary: `${intent} [hash: ${fileContext.contextHash.slice(0, 8)}]`,
            patches: [
              {
                targetFile: currentFile,
                searchBlock: "// old",
                replaceBlock: "const cached = true; return cached;",
                explanation: errorFeedback ? `Fixed error: ${errorFeedback}` : "Initial AST-verified patch",
              },
            ],
          });
        },
        async (rawJson) => {
          try {
            const parsed = validateSchema(rawJson);
            for (const patch of parsed.patches) {
              const astCheck = astValidator.applyAndValidatePatch(currentCode, patch);
              if (!astCheck.valid) {
                return { valid: false, error: astCheck.errors.join("; ") };
              }
            }
            return { valid: true };
          } catch (err: any) {
            return { valid: false, error: err.message };
          }
        }
      );

      vscode.window.showInformationMessage(`AST-проверка пройдена! Патч: ${verifiedPatch}`);
    } catch (error: any) {
      vscode.window.showErrorMessage(`Отказ конвейера безопасности: ${error.message}`);
    } finally {
      stateMachine.transitionTo("IDLE");
    }
  });

  context.subscriptions.push(disposable);
}

export function deactivate() {}
