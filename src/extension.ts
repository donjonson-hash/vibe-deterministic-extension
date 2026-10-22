import * as vscode from "vscode";
import { VibeStateMachine } from "./core/stateMachine";
import { ContextManager } from "./core/contextManager";
import { SandboxRunner } from "./core/sandboxRunner";
import { validateSchema } from "./llm/schemaParser";
import { AstValidator } from "./pipeline/astValidator";
import { LinterRunner } from "./pipeline/linterRunner";
import { runWithAutoFix } from "./pipeline/autoFixLoop";
import { TimeMachine } from "./ui/timeMachine";

export function activate(context: vscode.ExtensionContext) {
  const stateMachine = new VibeStateMachine();
  const contextManager = new ContextManager();
  const astValidator = new AstValidator();
  const linterRunner = new LinterRunner();
  const sandboxRunner = new SandboxRunner();
  const timeMachine = new TimeMachine();

  const executeDisposable = vscode.commands.registerCommand("vibe.executeIntent", async () => {
    const editor = vscode.window.activeTextEditor;
    const currentCode = editor?.document.getText() ?? "export function hello(): boolean {\n  // old\n  return false;\n}\n";
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
          return JSON.stringify({
            intentSummary: `${intent} [hash: ${fileContext.contextHash.slice(0, 8)}]`,
            patches: [
              {
                targetFile: currentFile,
                searchBlock: "// old",
                replaceBlock: "const cached: boolean = true; return cached;",
                explanation: errorFeedback ? `Fixed error: ${errorFeedback}` : "Initial verified patch",
              },
            ],
          });
        },
        async (rawJson) => {
          try {
            const parsed = validateSchema(rawJson);
            for (const patch of parsed.patches) {
              // 1. Проверка синтаксиса AST
              const astCheck = astValidator.applyAndValidatePatch(currentCode, patch);
              if (!astCheck.valid || !astCheck.patchedCode) {
                return { valid: false, error: astCheck.errors.join("; ") };
              }

              // 2. Проверка правил линтера и безопасности
              const lintCheck = linterRunner.lintCode(astCheck.patchedCode, patch.targetFile);
              if (!lintCheck.passed) {
                return { valid: false, error: linterRunner.formatViolations(lintCheck) };
              }

              // 3. Запуск в изолированной песочнице
              const sandboxCheck = sandboxRunner.executeIsolated(astCheck.patchedCode);
              if (!sandboxCheck.success) {
                return { valid: false, error: `SandboxError: ${sandboxCheck.error}` };
              }
            }
            return { valid: true };
          } catch (err: any) {
            return { valid: false, error: err.message };
          }
        }
      );

      const parsedPatch = validateSchema(verifiedPatch);
      const tx = timeMachine.applyTransaction(
        intent,
        [{ filePath: currentFile, content: currentCode }],
        parsedPatch.patches
      );

      vscode.window.showInformationMessage(
        `Патч прошел AST + Linter + Sandbox! Снапшот: ${tx.snapshot.id}`
      );
    } catch (error: any) {
      vscode.window.showErrorMessage(`Отказ конвейера безопасности: ${error.message}`);
    } finally {
      stateMachine.transitionTo("IDLE");
    }
  });

  const rollbackDisposable = vscode.commands.registerCommand("vibe.rollbackLast", async () => {
    try {
      const restored = timeMachine.rollbackLast();
      if (!restored) {
        vscode.window.showWarningMessage("TimeMachine: История снапшотов пуста.");
        return;
      }
      vscode.window.showInformationMessage(
        `Откат выполнен к снапшоту [${restored.id}] (интент: "${restored.intent}")`
      );
    } catch (error: any) {
      vscode.window.showErrorMessage(`Ошибка отката TimeMachine: ${error.message}`);
    }
  });

  context.subscriptions.push(executeDisposable, rollbackDisposable);
}

export function deactivate() {}
