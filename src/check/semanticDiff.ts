// Structural diff of top-level entities. AST fields preserve ASI and expressions;
// only location, comment and literal presentation metadata are excluded.
import type { ImportDeclaration, Node, Statement } from "@babel/types";
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
  /** For a modified import: bindings it no longer provides */
  removedSpecifiers?: string[];
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
  /** Import bindings, e.g. "readFile as readFile", "* as path", "default as React" */
  specifiers?: string[];
}

function importSpecifiers(declaration: ImportDeclaration): string[] {
  return declaration.specifiers.map((specifier) => {
    if (specifier.type === "ImportDefaultSpecifier") return `default as ${specifier.local.name}`;
    if (specifier.type === "ImportNamespaceSpecifier") return `* as ${specifier.local.name}`;
    const imported = specifier.imported.type === "Identifier" ? specifier.imported.name : specifier.imported.value;
    return `${imported} as ${specifier.local.name}`;
  });
}

const OTHER_KEY = "statement:<top-level>";

// Babel owns these objects; only its location/comment/literal presentation metadata
// is omitted. Serialize iteratively: valid left-deep expressions can outgrow the
// JavaScript call stack even though the parser and iterative AST walker accept them.
const IGNORED_AST_FIELDS = new Set(['start', 'end', 'loc', 'extra', 'leadingComments',
  'trailingComments', 'innerComments', 'comments', 'tokens', 'errors']);

function canonical(node: Node): string {
  type Task = { value: unknown } | { text: string };
  const stack: Task[] = [{ value: node }];
  const output: string[] = [];
  while (stack.length > 0) {
    const task = stack.pop()!;
    if ('text' in task) {
      output.push(task.text);
      continue;
    }
    const value = task.value;
    if (value === null || typeof value !== 'object') {
      // JSON's array semantics use null for missing/undefined entries. Undefined
      // object fields are excluded below, exactly as by the previous replacer.
      output.push(JSON.stringify(value) ?? 'null');
      continue;
    }
    if (Array.isArray(value)) {
      output.push('[');
      stack.push({ text: ']' });
      for (let index = value.length - 1; index >= 0; index--) {
        stack.push({ value: value[index] });
        if (index > 0) stack.push({ text: ',' });
      }
      continue;
    }
    const object = value as Record<string, unknown>;
    const keys = Object.keys(object).filter(key => !IGNORED_AST_FIELDS.has(key)
      && object[key] !== undefined && typeof object[key] !== 'function' && typeof object[key] !== 'symbol');
    output.push('{');
    stack.push({ text: '}' });
    for (let index = keys.length - 1; index >= 0; index--) {
      const key = keys[index];
      stack.push({ value: object[key] });
      stack.push({ text: `${index > 0 ? ',' : ''}${JSON.stringify(key)}:` });
    }
  }
  return output.join('');
}

function extractEntities(code: string, fileName: string): Map<string, Entity> {
  const ast = parseSource(code, fileName);

  const entities = new Map<string, Entity>();
  // Overloads, merged interfaces, repeated `var` and several imports from one module share a
  // key: they are combined, so a change to any of them is a change to the entity
  const register = (kind: SemanticEntityKind, name: string, isExported: boolean, node: Node, prefix = "", specifiers?: string[]) => {
    const key = `${kind}:${name}`;
    const canonicalText = prefix + canonical(node);
    const previous = entities.get(key);
    entities.set(
      key,
      previous
        ? {
            ...previous,
            isExported: previous.isExported || isExported,
            canonicalText: `${previous.canonicalText} ; ${canonicalText}`,
            specifiers: specifiers && [...(previous.specifiers ?? []), ...specifiers],
          }
        : { kind, name, isExported, canonicalText, specifiers }
    );
  };
  // Other top-level code (calls, `export default expr`, `export { a }`) is one entity, so a
  // change like `app.listen(80)` -> `app.listen(8080)` is not mistaken for formatting
  const others: Statement[] = [];
  const order = ast.program.body.map(statement => {
    const n = statement.type === 'ExportNamedDeclaration' && statement.declaration ? statement.declaration : statement;
    if (n.type === 'VariableDeclaration') return n.declarations.map(d => canonical(d.id)).join(',');
    if ('id' in n && n.id) return `${n.type}:${canonical(n.id as Node)}`;
    if (n.type === 'ImportDeclaration') return `import:${n.source.value}`;
    return n.type;
  });
  entities.set('statement:<evaluation-order>', {kind: 'statement', name: '<evaluation-order>',
    isExported: false, canonicalText: JSON.stringify(order)});

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
        register("import", declaration.source.value, false, statement, "", importSpecifiers(declaration));
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
            // The declarator alone omits `const`/`let`/`var` and `declare`; both are semantic
            register("variable", declarator.id.name, isExported, declarator, `${declaration.declare ? "declare " : ""}${declaration.kind} `);
            registered = true;
          }
        }
        if (registered && declaration.declarations.every(d => d.id.type === "Identifier")) continue;
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
      // Additions/removals already have their own entries. Report relative order separately.
      if (key === 'statement:<evaluation-order>') {
        const a = JSON.parse(entity.canonicalText) as string[];
        const b = JSON.parse(next.canonicalText) as string[];
        if (JSON.stringify([...a].sort()) !== JSON.stringify([...b].sort())) continue;
      }
      const kept = new Set(next.specifiers ?? []);
      const removedSpecifiers = entity.specifiers?.filter((specifier) => !kept.has(specifier));
      changes.push({
        kind: next.kind,
        name: next.name,
        changeType: "MODIFIED",
        isExported: entity.isExported || next.isExported,
        summary: `Изменена логика ${next.kind} "${next.name}"`,
        ...(removedSpecifiers ? { removedSpecifiers } : {}),
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
      ? `[${riskLevel}] Смысловых изменений AST не обнаружено (структура разобранного кода совпадает; это не доказательство эквивалентности)`
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
 * removed, and imports that lose bindings. Adding a binding to an import is routine and is not
 * flagged. Without the user's intent we cannot know what was requested, so these are flagged
 * rather than blocked (spike 2026-10-22: a whole-file answer silently rewrote an unrelated import).
 */
export function attentionReasons(report: SemanticDiffReport): string[] {
  return report.changes.flatMap((c) => {
    if (c.changeType === "REMOVED") return [c.summary];
    if (c.kind === "import" && c.removedSpecifiers && c.removedSpecifiers.length > 0) {
      return [`Из import "${c.name}" удалено: ${c.removedSpecifiers.join(", ")}`];
    }
    return [];
  });
}
