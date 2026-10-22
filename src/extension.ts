import * as vscode from "vscode";
import { VibeStateMachine } from "./core/stateMachine";
import { ContextManager } from "./core/contextManager";
import { SandboxRunner } from "./core/sandboxRunner";
import { DeterministicLLMClient } from "./llm/client";
import { CodePatch, validateSchema } from "./llm/schemaParser";
import { AstValidator } from "./pipeline/astValidator";
import { LinterRunner } from "./pipeline/linterRunner";
import { runWithAutoFix } from "./pipeline/autoFixLoop";
import { CommandCenter } from "./ui/commandCenter";
import { TimeMachine, VibeSnapshot } from "./ui/timeMachine";
import { SemanticDiffEngine } from "./ui/semanticDiff";
import { DeterministicLogger } from "./utils/logger";

const SUPPORTED_LANGUAGES = new Set(["typescript", "typescriptreact", "javascript", "javascriptreact"]);

export function activate(context: vscode.ExtensionContext) {
  const output = vscode.window.createOutputChannel("Vibe Deterministic");
  const logger = new DeterministicLogger((entry) =>
    output.appendLine(`[${entry.level}] ${entry.module}: ${entry.message} #${entry.entryHash.slice(0, 8)}`)
  );
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
  if (!llmClient.hasApiKey()) {
    logger.warn("LLM", "VIBE_LLM_API_KEY не задан — используется локальный демо-ответ");
  }

  const executeDisposable = vscode.commands.registerCommand("vibe.executeIntent", async () => {
    if (stateMachine.getState() !== "IDLE") {
      vscode.window.showWarningMessage("Vibe: конвейер уже выполняется, дождитесь завершения.");
      return;
    }

    const editor = vscode.window.activeTextEditor;
    if (!editor) {
      vscode.window.showWarningMessage("Vibe: откройте TypeScript/JavaScript файл в редакторе.");
      return;
    }

    const document = editor.document;
    if (!SUPPORTED_LANGUAGES.has(document.languageId)) {
      vscode.window.showWarningMessage(
        `Vibe: язык "${document.languageId}" не поддерживается (только TypeScript/JavaScript).`
      );
      return;
    }

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

    // Снимок документа на момент запроса: LLM видит именно эту версию
    const currentCode = document.getText();
    const documentVersion = document.version;
    const fileKey = document.uri.toString();
    const relativePath = vscode.workspace.asRelativePath(document.uri, false);

    // В контексте LLM только один файл, поэтому патчи к другим файлам отклоняются
    const resolvePatches = (patches: CodePatch[]): CodePatch[] => {
      for (const patch of patches) {
        if (!isSameFile(patch.targetFile, relativePath)) {
          throw new Error(
            `TargetFileMismatch: Патч для "${patch.targetFile}" отклонен — разрешено изменять только "${relativePath}"`
          );
        }
      }
      return patches.map((patch) => ({ ...patch, targetFile: fileKey }));
    };

    try {
      stateMachine.transitionTo("COLLECTING_CONTEXT");
      const fileContext = contextManager.extractFileContext(relativePath, currentCode);

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
            if (parsed.patches.length === 0) {
              return { valid: false, error: "EmptyPatch: Ответ не содержит ни одного патча" };
            }
            const patches = resolvePatches(parsed.patches);

            // Патчи применяются последовательно — проверяем ровно тот код, который будет записан
            let candidateCode = currentCode;
            for (const patch of patches) {
              const astCheck = astValidator.applyAndValidatePatch(candidateCode, {
                ...patch,
                targetFile: relativePath,
              });
              if (!astCheck.valid || astCheck.patchedCode === undefined) {
                return { valid: false, error: astCheck.errors.join("; ") };
              }
              candidateCode = astCheck.patchedCode;
            }

            const lintCheck = linterRunner.lintPatch(currentCode, candidateCode, relativePath);
            if (!lintCheck.passed) {
              return { valid: false, error: linterRunner.formatViolations(lintCheck) };
            }

            const sandboxCheck = sandboxRunner.executeIsolated(candidateCode);
            if (!sandboxCheck.success) {
              return { valid: false, error: `SandboxError: ${sandboxCheck.error}` };
            }
            return { valid: true };
          } catch (err: unknown) {
            return { valid: false, error: errorMessage(err) };
          }
        }
      );

      if (document.version !== documentVersion) {
        throw new Error("Файл был изменен во время генерации патча — запустите интент заново");
      }

      const parsedPatch = validateSchema(verifiedPatch);
      const tx = timeMachine.applyTransaction(
        parsedCommand.canonicalIntent,
        [{ filePath: fileKey, content: currentCode }],
        resolvePatches(parsedPatch.patches)
      );

      const updatedCode = tx.updatedFiles.get(fileKey) ?? currentCode;
      const applied = await replaceDocumentContent(document.uri, updatedCode);
      if (!applied) {
        timeMachine.rollbackLast();
        throw new Error("VS Code отклонил WorkspaceEdit — файл не изменен");
      }

      const diffReport = semanticDiff.compareCode(currentCode, updatedCode, relativePath);
      logger.info("Pipeline", `Applied snapshot ${tx.snapshot.id} (${diffReport.riskLevel})`);

      vscode.window.showInformationMessage(
        `${diffReport.formattedSummary} (Снапшот: ${tx.snapshot.id})`
      );
    } catch (error: unknown) {
      logger.error("Pipeline", errorMessage(error));
      vscode.window.showErrorMessage(`Отказ конвейера безопасности: ${errorMessage(error)}`);
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

      await restoreSnapshot(restored);
      logger.info("TimeMachine", `Rolled back to ${restored.id}`);
      vscode.window.showInformationMessage(
        `Откат выполнен к снапшоту [${restored.id}] (интент: "${restored.intent}")`
      );
    } catch (error: unknown) {
      logger.error("TimeMachine", errorMessage(error));
      vscode.window.showErrorMessage(`Ошибка отката TimeMachine: ${errorMessage(error)}`);
    }
  });

  context.subscriptions.push(output, executeDisposable, rollbackDisposable);
}

export function deactivate() {}

async function replaceDocumentContent(uri: vscode.Uri, content: string): Promise<boolean> {
  const document = await vscode.workspace.openTextDocument(uri);
  const fullRange = new vscode.Range(
    document.positionAt(0),
    document.positionAt(document.getText().length)
  );
  const edit = new vscode.WorkspaceEdit();
  edit.replace(uri, fullRange, content);
  return vscode.workspace.applyEdit(edit);
}

async function restoreSnapshot(snapshot: VibeSnapshot): Promise<void> {
  for (const file of snapshot.files) {
    const applied = await replaceDocumentContent(vscode.Uri.parse(file.filePath), file.content);
    if (!applied) {
      throw new Error(`Не удалось восстановить ${file.filePath}`);
    }
  }
}

function isSameFile(targetFile: string, relativePath: string): boolean {
  const normalize = (p: string) => p.replace(/\\/g, "/").replace(/^\.\//, "");
  const target = normalize(targetFile);
  const relative = normalize(relativePath);
  return target === relative || relative.endsWith(`/${target}`) || target.endsWith(`/${relative}`);
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
