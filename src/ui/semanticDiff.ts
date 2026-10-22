import * as ts from "typescript";
import { computeDeterministicHash } from "../utils/crypto";

export type SemanticEntityKind =
  | "import"
  | "function"
  | "class"
  | "interface"
  | "type"
  | "variable";

export type ChangeType = "ADDED" | "MODIFIED" | "REMOVED";
export type RiskLevel = "LOW" | "MEDIUM" | "HIGH";

export interface SemanticChange {
  kind: SemanticEntityKind;
  name: string;
  changeType: ChangeType;
  isExported: boolean;
  beforeHash?: string;
  afterHash?: string;
  summary: string;
}

export interface SemanticDiffReport {
  fileName: string;
  changes: SemanticChange[];
  riskLevel: RiskLevel;
  formattedSummary: string;
}

interface ExtractedEntity {
  kind: SemanticEntityKind;
  name: string;
  isExported: boolean;
  canonicalText: string;
  hash: string;
}

export class SemanticDiffEngine {
  private readonly printer = ts.createPrinter({
    removeComments: true,
    newLine: ts.NewLineKind.LineFeed,
  });

  /**
   * Извлекает верхнеуровневые смысловые блоки из AST с нормализацией форматирования
   */
  private extractEntities(sourceCode: string, fileName: string): Map<string, ExtractedEntity> {
    const sourceFile = ts.createSourceFile(
      fileName,
      sourceCode,
      ts.ScriptTarget.ES2022,
      true
    );

    const entities = new Map<string, ExtractedEntity>();

    const hasExportModifier = (node: ts.Node): boolean => {
      if (!ts.canHaveModifiers(node)) return false;
      const modifiers = ts.getModifiers(node);
      return modifiers?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword) ?? false;
    };

    const registerEntity = (
      kind: SemanticEntityKind,
      name: string,
      isExported: boolean,
      node: ts.Node
    ) => {
      const canonicalText = this.printer
        .printNode(ts.EmitHint.Unspecified, node, sourceFile)
        .replace(/\s+/g, " ")
        .trim();

      const key = `${kind}:${name}`;
      entities.set(key, {
        kind,
        name,
        isExported,
        canonicalText,
        hash: computeDeterministicHash(canonicalText),
      });
    };

    for (const stmt of sourceFile.statements) {
      if (ts.isImportDeclaration(stmt) && ts.isStringLiteral(stmt.moduleSpecifier)) {
        registerEntity("import", stmt.moduleSpecifier.text, false, stmt);
      } else if (ts.isFunctionDeclaration(stmt) && stmt.name) {
        registerEntity("function", stmt.name.text, hasExportModifier(stmt), stmt);
      } else if (ts.isClassDeclaration(stmt) && stmt.name) {
        registerEntity("class", stmt.name.text, hasExportModifier(stmt), stmt);
      } else if (ts.isInterfaceDeclaration(stmt) && stmt.name) {
        registerEntity("interface", stmt.name.text, hasExportModifier(stmt), stmt);
      } else if (ts.isTypeAliasDeclaration(stmt) && stmt.name) {
        registerEntity("type", stmt.name.text, hasExportModifier(stmt), stmt);
      } else if (ts.isVariableStatement(stmt)) {
        const isExported = hasExportModifier(stmt);
        for (const decl of stmt.declarationList.declarations) {
          if (ts.isIdentifier(decl.name)) {
            registerEntity("variable", decl.name.text, isExported, decl);
          }
        }
      }
    }

    return entities;
  }

  /**
   * Сравнивает старый и новый код на уровне AST и формирует смысловой отчет
   */
  public compareCode(
    beforeCode: string,
    afterCode: string,
    fileName = "virtual.ts"
  ): SemanticDiffReport {
    const beforeMap = this.extractEntities(beforeCode, fileName);
    const afterMap = this.extractEntities(afterCode, fileName);
    const changes: SemanticChange[] = [];

    // 1. Поиск удаленных и измененных блоков
    for (const [key, beforeEntity] of beforeMap.entries()) {
      const afterEntity = afterMap.get(key);
      if (!afterEntity) {
        changes.push({
          kind: beforeEntity.kind,
          name: beforeEntity.name,
          changeType: "REMOVED",
          isExported: beforeEntity.isExported,
          beforeHash: beforeEntity.hash,
          summary: `Удален ${beforeEntity.isExported ? "экспортируемый " : ""}${beforeEntity.kind} "${beforeEntity.name}"`,
        });
      } else if (
        beforeEntity.hash !== afterEntity.hash ||
        beforeEntity.isExported !== afterEntity.isExported
      ) {
        changes.push({
          kind: afterEntity.kind,
          name: afterEntity.name,
          changeType: "MODIFIED",
          isExported: beforeEntity.isExported || afterEntity.isExported,
          beforeHash: beforeEntity.hash,
          afterHash: afterEntity.hash,
          summary: `Изменена логика ${afterEntity.kind} "${afterEntity.name}"`,
        });
      }
    }

    // 2. Поиск добавленных блоков
    for (const [key, afterEntity] of afterMap.entries()) {
      if (!beforeMap.has(key)) {
        changes.push({
          kind: afterEntity.kind,
          name: afterEntity.name,
          changeType: "ADDED",
          isExported: afterEntity.isExported,
          afterHash: afterEntity.hash,
          summary: `Добавлен ${afterEntity.isExported ? "экспортируемый " : ""}${afterEntity.kind} "${afterEntity.name}"`,
        });
      }
    }

    // Детерминированная сортировка по имени для стабильного вывода
    changes.sort((a, b) => a.name.localeCompare(b.name));

    const riskLevel = this.calculateRiskLevel(changes);
    const formattedSummary =
      changes.length === 0
        ? `[${riskLevel}] Смысловых изменений AST не обнаружено (только форматирование или комментарии)`
        : `[Риск: ${riskLevel}] ${changes.map((c) => c.summary).join(" | ")}`;

    return {
      fileName,
      changes,
      riskLevel,
      formattedSummary,
    };
  }

  private calculateRiskLevel(changes: SemanticChange[]): RiskLevel {
    if (changes.some((c) => c.changeType === "REMOVED" || (c.changeType === "MODIFIED" && c.isExported))) {
      return "HIGH";
    }
    if (changes.some((c) => c.changeType === "MODIFIED")) {
      return "MEDIUM";
    }
    return "LOW";
  }
}
