// Security lint on the patched file. Only NEW violations block a patch: existing ones in the
// user's file must not block every change forever.
import type { Expression, Node } from "@babel/types";
import { LINE_TERMINATOR, NodeContext, parseSource, walk } from "./parse";

export interface LintViolation {
  ruleId: string;
  message: string;
  line: number;
  column: number;
}

export interface LintResult {
  passed: boolean;
  violations: LintViolation[];
}

const GLOBAL_OBJECTS = new Set(["globalThis", "window", "self", "global"]);

/** `eval`, `globalThis.eval`, `window["eval"]`, `(0, eval)` → "eval" */
function calleeName(callee: Expression | Node): string | undefined {
  if (callee.type === "SequenceExpression") return calleeName(callee.expressions[callee.expressions.length - 1]);
  if (callee.type === "Identifier") return callee.name;
  if (callee.type === "MemberExpression" && callee.object.type === "Identifier" && GLOBAL_OBJECTS.has(callee.object.name)) {
    if (!callee.computed && callee.property.type === "Identifier") return callee.property.name;
    if (callee.computed && callee.property.type === "StringLiteral") return callee.property.value;
  }
  return undefined;
}

/** Throws Babel's SyntaxError when the code does not parse; run the syntax gate first */
export function lintCode(code: string, fileName: string): LintResult {
  const ast = parseSource(code, fileName);
  const violations: LintViolation[] = [];
  const report = (node: Node, ruleId: string, message: string) => {
    const start = node.loc?.start ?? { line: 0, column: 0 };
    violations.push({ ruleId, message, line: start.line, column: start.column + 1 });
  };

  walk(ast.program, (node, context) => {
    const isCall = node.type === "CallExpression" || node.type === "OptionalCallExpression";
    // Any value reference to eval: calls, `(0, eval)(x)`, `const e = eval`, `globalThis.eval`
    if (isEvalReference(node, context)) {
      report(node, "no-eval", "Использование eval() строго запрещено политикой безопасности");
    }
    // String code passed to timers is evaluated like eval
    if (
      isCall &&
      ["setTimeout", "setInterval"].includes(calleeName(node.callee) ?? "") &&
      (node.arguments[0]?.type === "StringLiteral" || node.arguments[0]?.type === "TemplateLiteral")
    ) {
      report(node, "no-implied-eval", "Строка с кодом в setTimeout/setInterval исполняется как eval()");
    }
    if ((isCall || node.type === "NewExpression") && calleeName(node.callee) === "Function") {
      report(node, "no-new-func", "Динамическая генерация кода через new Function() запрещена");
    }
    if (node.type === "DebuggerStatement") {
      report(node, "no-debugger", "Инструкция debugger не допускается в финальном патче");
    }
    if (node.type === "TSAnyKeyword") {
      report(node, "no-explicit-any", "Использование типа 'any' запрещено — укажите строгий тип");
    }
  });

  return { passed: violations.length === 0, violations };
}

function isEvalReference(node: Node, { parent, key }: NodeContext): boolean {
  if (node.type === "MemberExpression") {
    return calleeName(node) === "eval";
  }
  if (node.type !== "Identifier" || node.name !== "eval" || !parent) return false;
  // Names that are not references: `x.eval`, `{ eval: 1 }`, `class { eval() {} }`
  if ((parent.type === "MemberExpression" || parent.type === "OptionalMemberExpression") && key === "property" && !parent.computed) return false;
  if ((parent.type === "ObjectProperty" || parent.type === "ObjectMethod" || parent.type === "ClassMethod" || parent.type === "ClassProperty") && key === "key" && !parent.computed) return false;
  return true;
}

/** Violations in `patched` that `original` did not already have (matched by rule and line text) */
export function lintPatch(original: string, patched: string, fileName: string): LintResult {
  const keyFor = (code: string) => {
    const lines = code.split(LINE_TERMINATOR);
    return (v: LintViolation) => `${v.ruleId}|${(lines[v.line - 1] ?? "").trim()}`;
  };

  const baselineKey = keyFor(original);
  const baseline = new Map<string, number>();
  for (const v of lintCode(original, fileName).violations) {
    const key = baselineKey(v);
    baseline.set(key, (baseline.get(key) ?? 0) + 1);
  }

  const patchedKey = keyFor(patched);
  const violations = lintCode(patched, fileName).violations.filter((v) => {
    const key = patchedKey(v);
    const remaining = baseline.get(key) ?? 0;
    if (remaining > 0) {
      baseline.set(key, remaining - 1);
      return false;
    }
    return true;
  });

  return { passed: violations.length === 0, violations };
}

export function formatViolations(result: LintResult): string {
  return result.violations.map((v) => `[${v.ruleId}] Строка ${v.line}:${v.column} - ${v.message}`).join("; ");
}
