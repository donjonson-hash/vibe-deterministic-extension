import * as ts from "typescript";
import { CodePatch } from "../llm/schemaParser";
import { applySearchReplace } from "../utils/patch";

export interface AstValidationResult {
  valid: boolean;
  patchedCode?: string;
  errors: string[];
}

export class AstValidator {
  /**
   * Проверяет синтаксическую целостность TypeScript/JavaScript кода в памяти
   */
  public validateSyntax(sourceCode: string, fileName = "virtual.ts"): AstValidationResult {
    const result = ts.transpileModule(sourceCode, {
      fileName,
      reportDiagnostics: true,
      compilerOptions: {
        target: ts.ScriptTarget.ES2022,
        module: ts.ModuleKind.CommonJS,
        strict: true,
      },
    });

    const diagnostics = result.diagnostics ?? [];
    if (diagnostics.length === 0) {
      return { valid: true, patchedCode: sourceCode, errors: [] };
    }

    const errors = diagnostics.map((diag) => {
      const message = ts.flattenDiagnosticMessageText(diag.messageText, "\n");
      if (diag.file && diag.start !== undefined) {
        const { line, character } = diag.file.getLineAndCharacterOfPosition(diag.start);
        return `${fileName} (${line + 1},${character + 1}): TS${diag.code} - ${message}`;
      }
      return `TS${diag.code} - ${message}`;
    });

    return { valid: false, errors };
  }

  /**
   * Применяет патч к исходному коду в памяти и сразу валидирует AST результата
   */
  public applyAndValidatePatch(originalCode: string, patch: CodePatch): AstValidationResult {
    const applied = applySearchReplace(originalCode, patch.searchBlock, patch.replaceBlock);
    if (!applied.ok) {
      const message =
        applied.reason === "AMBIGUOUS"
          ? `SearchBlockAmbiguous: Блок "${patch.searchBlock}" встречается ${applied.occurrences} раз(а) в файле ${patch.targetFile} — нужен уникальный фрагмент`
          : `SearchBlockNotFound: Не найден целевой блок кода "${patch.searchBlock}" в файле ${patch.targetFile}`;
      return { valid: false, errors: [message] };
    }

    return this.validateSyntax(applied.code, patch.targetFile);
  }
}
