import * as ts from "typescript";
import { computeDeterministicHash } from "../utils/crypto";
import { compareOrdinal } from "../utils/patch";

export interface ExtractedContext {
  fileName: string;
  imports: string[];
  exportedSymbols: string[];
  functionsAndClasses: string[];
  contextHash: string;
}

export class ContextManager {
  /**
   * Детерминированно извлекает структуру файла через TypeScript AST без участия LLM
   */
  public extractFileContext(fileName: string, sourceCode: string): ExtractedContext {
    const sourceFile = ts.createSourceFile(
      fileName,
      sourceCode,
      ts.ScriptTarget.ES2022,
      true
    );

    const imports: string[] = [];
    const exportedSymbols: string[] = [];
    const functionsAndClasses: string[] = [];

    const visit = (node: ts.Node) => {
      // Извлекаем все import-декларации
      if (ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier)) {
        imports.push(node.moduleSpecifier.text);
      }

      // Извлекаем функции, классы и интерфейсы
      if (
        (ts.isFunctionDeclaration(node) ||
          ts.isClassDeclaration(node) ||
          ts.isInterfaceDeclaration(node)) &&
        node.name
      ) {
        const name = node.name.text;
        functionsAndClasses.push(name);

        const isExported = node.modifiers?.some(
          (m) => m.kind === ts.SyntaxKind.ExportKeyword
        );
        if (isExported) {
          exportedSymbols.push(name);
        }
      }

      ts.forEachChild(node, visit);
    };

    visit(sourceFile);

    const canonicalPayload = JSON.stringify({
      fileName,
      // Сортируем копии: возвращаемые массивы сохраняют порядок объявлений в файле
      imports: [...imports].sort(compareOrdinal),
      exportedSymbols: [...exportedSymbols].sort(compareOrdinal),
      functionsAndClasses: [...functionsAndClasses].sort(compareOrdinal),
      sourceCode,
    });

    return {
      fileName,
      imports,
      exportedSymbols,
      functionsAndClasses,
      contextHash: computeDeterministicHash(canonicalPayload),
    };
  }
}
