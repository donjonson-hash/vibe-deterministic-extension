// Semantic diff of top-level entities. An entity's canonical text is its token sequence
// without comments, so formatting and comment edits are not reported as changes.
import type { Node, Statement } from "@babel/types";
import { compareOrdinal } from "../utils/patch";
import { parseSource } from "./parse";

export type SemanticEntityKind = "import" | "function" | "class" | "interface" | "type" | "variable" | "statement";
export type ChangeType = "ADDED" | "MODIFIED" | "REMOVED";
export type RiskLevel = "LOW" | "MEDIUM" | "HIGH";

export interface SemanticChange {
  kind: SemanticEntityKind;
  name: string;
  changeType: ChangeType;
  isExported: boolean;
  summary: string;
}

export interface SemanticDiffReport {
  fileName: string;
  changes: SemanticChange[];
  riskLevel: RiskLevel;
  formattedSummary: string;
}

interface Entity {
  kind: SemanticEntityKind;
  name: string;
  isExported: boolean;
  canonicalText: string;
}

interface Token {
  start: number;
  end: number;
  type: unknown;
}

const OTHER_KEY = "statement:<top-level>";

function isComment(token: Token): boolean {
  return token.type === "CommentLine" || token.type === "CommentBlock";
}

/** Index of the first token starting at or after `position` */
function lowerBound(tokens: Token[], position: number): number {
  let low = 0;
  let high = tokens.length;
  while (low < high) {
    const mid = (low + high) >>> 1;
    if (tokens[mid].start < position) low = mid + 1;
    else high = mid;
  }
  return low;
}

function extractEntities(code: string, fileName: string): Map<string, Entity> {
  const ast = parseSource(code, fileName, true);
  const tokens = ((ast.tokens ?? []) as Token[]).filter((token) => !isComment(token));
  const canonical = (node: Node): string => {
    const parts: string[] = [];
    for (let i = lowerBound(tokens, node.start ?? 0); i < tokens.length && tokens[i].end <= (node.end ?? 0); i++) {
      parts.push(code.slice(tokens[i].start, tokens[i].end));
    }
    return parts.join(" ");
  };

  const entities = new Map<string, Entity>();
  const register = (kind: SemanticEntityKind, name: string, isExported: boolean, node: Node) => {
    entities.set(`${kind}:${name}`, { kind, name, isExported, canonicalText: canonical(node) });
  };
  // Other top-level code (calls, `export default expr`, `export { a }`) is one entity, so a
  // change like `app.listen(80)` -> `app.listen(8080)` is not mistaken for formatting
  const others: Statement[] = [];

  for (const statement of ast.program.body) {
    // The exported wrapper is the canonical node, so toggling `export` is a change
    let declaration: Node = statement;
    let isExported = false;
    if (statement.type === "ExportNamedDeclaration" && statement.declaration) {
      declaration = statement.declaration;
      isExported = true;
    } else if (
      statement.type === "ExportDefaultDeclaration" &&
      (statement.declaration.type === "FunctionDeclaration" || statement.declaration.type === "ClassDeclaration") &&
      statement.declaration.id
    ) {
      declaration = statement.declaration;
      isExported = true;
    }

    switch (declaration.type) {
      case "ImportDeclaration":
        register("import", declaration.source.value, false, statement);
        continue;
      case "FunctionDeclaration":
      case "TSDeclareFunction":
        if (declaration.id) {
          register("function", declaration.id.name, isExported, statement);
          continue;
        }
        break;
      case "ClassDeclaration":
        if (declaration.id) {
          register("class", declaration.id.name, isExported, statement);
          continue;
        }
        break;
      case "TSInterfaceDeclaration":
        register("interface", declaration.id.name, isExported, statement);
        continue;
      case "TSTypeAliasDeclaration":
        register("type", declaration.id.name, isExported, statement);
        continue;
      case "VariableDeclaration": {
        let registered = false;
        for (const declarator of declaration.declarations) {
          if (declarator.id.type === "Identifier") {
            register("variable", declarator.id.name, isExported, declarator);
            registered = true;
          }
        }
        if (registered) continue;
        break;
      }
      case "EmptyStatement":
        continue;
    }
    others.push(statement);
  }

  if (others.length > 0) {
    entities.set(OTHER_KEY, {
      kind: "statement",
      name: "<top-level>",
      isExported: others.some((s) => s.type === "ExportNamedDeclaration" || s.type === "ExportDefaultDeclaration" || s.type === "ExportAllDeclaration"),
      canonicalText: others.map(canonical).join(" "),
    });
  }
  return entities;
}

/** Throws Babel's SyntaxError when either side does not parse; run the syntax gate first */
export function compareCode(beforeCode: string, afterCode: string, fileName: string): SemanticDiffReport {
  const before = extractEntities(beforeCode, fileName);
  const after = extractEntities(afterCode, fileName);
  const changes: SemanticChange[] = [];

  for (const [key, entity] of before) {
    const next = after.get(key);
    if (!next) {
      changes.push({
        kind: entity.kind,
        name: entity.name,
        changeType: "REMOVED",
        isExported: entity.isExported,
        summary: `Удален ${entity.isExported ? "экспортируемый " : ""}${entity.kind} "${entity.name}"`,
      });
    } else if (entity.canonicalText !== next.canonicalText || entity.isExported !== next.isExported) {
      changes.push({
        kind: next.kind,
        name: next.name,
        changeType: "MODIFIED",
        isExported: entity.isExported || next.isExported,
        summary: `Изменена логика ${next.kind} "${next.name}"`,
      });
    }
  }
  for (const [key, entity] of after) {
    if (!before.has(key)) {
      changes.push({
        kind: entity.kind,
        name: entity.name,
        changeType: "ADDED",
        isExported: entity.isExported,
        summary: `Добавлен ${entity.isExported ? "экспортируемый " : ""}${entity.kind} "${entity.name}"`,
      });
    }
  }

  changes.sort((a, b) => compareOrdinal(a.name, b.name) || compareOrdinal(a.kind, b.kind));
  const riskLevel = calculateRiskLevel(changes);
  const formattedSummary =
    changes.length === 0
      ? `[${riskLevel}] Смысловых изменений AST не обнаружено (только форматирование или комментарии)`
      : `[Риск: ${riskLevel}] ${changes.map((c) => c.summary).join(" | ")}`;
  return { fileName, changes, riskLevel, formattedSummary };
}

function calculateRiskLevel(changes: SemanticChange[]): RiskLevel {
  if (changes.some((c) => c.changeType === "REMOVED" || (c.changeType === "MODIFIED" && c.isExported))) return "HIGH";
  if (changes.some((c) => c.changeType === "MODIFIED")) return "MEDIUM";
  return "LOW";
}

/**
 * Changes that need an explicit confirmation before a proposal can be accepted: anything
 * removed, and existing imports rewritten. Without the user's intent we cannot know what was
 * requested, so these are flagged rather than blocked (spike 2026-10-22: a whole-file answer
 * silently rewrote an unrelated import).
 */
export function attentionReasons(report: SemanticDiffReport): string[] {
  return report.changes
    .filter((c) => c.changeType === "REMOVED" || (c.kind === "import" && c.changeType === "MODIFIED"))
    .map((c) => c.summary);
}
