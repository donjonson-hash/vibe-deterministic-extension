import * as vscode from "vscode";
import { VibeStateMachine } from "./core/stateMachine";
import { ContextManager } from "./core/contextManager";
import { SandboxRunner } from "./core/sandboxRunner";
import { DeterministicLLMClient } from "./llm/client";
import { validateSchema } from "./llm/schemaParser";
import { AstValidator } from "./pipeline/astValidator";
import { LinterRunner } from "./pipeline/linterRunner";
import { runWithAutoFix } from "./pipeline/autoFixLoop";
import { CommandCenter } from "./ui/commandCenter";
import { TimeMachine } from "./ui/timeMachine";
import { SemanticDiffEngine } from "./ui/semanticDiff";
import { DeterministicLogger } from "./utils/logger";

export function activate(context: vscode.ExtensionContext) {
  const logger = new DeterministicLogger();
  const stateMachine = new VibeStateMachine();
  const contextManager = new ContextManager();
  const astValidator = new AstValidator();
  const linterRunner = new LinterRunner();
  const sandboxRunner = new SandboxRunner();
  const commandCenter = new CommandCenter();
  const timeMachine = new TimeMachine();
  const semanticDiff = new SemanticDiffEngine();
  const llmClient = new DeterministicLLMClient();

  logger.info("Extension", "Vibe Deterministic Extension activated");

  const executeDisposable = vscode.commands.registerCommand("vibe.executeIntent", async () => {
    const editor = vscode.window.activeTextEditor;
    const currentCode = editor?.document.getText() ?? "export function hello(): boolean {\n  // old\n  return false;\n}\n";
    const currentFile = editor?.document.fileName ?? "src/index.ts";

    const rawInput = await vscode.window.showInputBox({
      prompt: "Введите или надиктуйте вайб-интент (например: Добавь кеширование в сервис)",
    });

    if (!rawInput) return;

    const parsedCommand = commandCenter.parseCommand(rawInput);
    logger.info("CommandCenter", `Parsed [${parsedCommand.category}] ${parsedCommand.commandId}`);

    if (parsedCommand.category === "ROLLBACK") {
      await vscode.commands.executeCommand("vibe.rollbackLast");
      return;
    }

    try {
      stateMachine.transitionTo("COLLECTING_CONTEXT");
      const fileContext = contextManager.extractFileContext(currentFile, currentCode);

      const verifiedPatch = await runWithAutoFix(
        stateMachine,
        async (errorFeedback) => {
          const result = await llmClient.generatePatch({
            intent: `[${parsedCommand.category}] ${parsedCommand.canonicalIntent}`,
            context: fileContext,
            sourceCode: currentCode,
            errorFeedback,
          });
          return result.rawJson;
        },
        async (rawJson) => {
          try {
            const parsed = validateSchema(rawJson);
            for (const patch of parsed.patches) {
              const astCheck = astValidator.applyAndValidatePatch(currentCode, patch);
              if (!astCheck.valid || !astCheck.patchedCode) {
                return { valid: false, error: astCheck.errors.join("; ") };
              }

              const lintCheck = linterRunner.lintCode(astCheck.patchedCode, patch.targetFile);
              if (!lintCheck.passed) {
                return { valid: false, error: linterRunner.formatViolations(lintCheck) };
              }

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
        parsedCommand.canonicalIntent,
        [{ filePath: currentFile, content: currentCode }],
        parsedPatch.patches
      );

      const updatedCode = tx.updatedFiles.get(currentFile) ?? currentCode;
      const diffReport = semanticDiff.compareCode(currentCode, updatedCode, currentFile);
      logger.info("Pipeline", `Applied snapshot ${tx.snapshot.id} (${diffReport.riskLevel})`);

      vscode.window.showInformationMessage(
        `${diffReport.formattedSummary} (Снапшот: ${tx.snapshot.id})`
      );
    } catch (error: any) {
      logger.error("Pipeline", error.message);
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
      logger.info("TimeMachine", `Rolled back to ${restored.id}`);
      vscode.window.showInformationMessage(
        `Откат выполнен к снапшоту [${restored.id}] (интент: "${restored.intent}")`
      );
    } catch (error: any) {
      logger.error("TimeMachine", error.message);
      vscode.window.showErrorMessage(`Ошибка отката TimeMachine: ${error.message}`);
    }
  });

  context.subscriptions.push(executeDisposable, rollbackDisposable);
}

export function deactivate() {}
