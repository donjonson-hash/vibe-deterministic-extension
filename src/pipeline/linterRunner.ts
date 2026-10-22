import * as ts from "typescript";

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

export class LinterRunner {
  /**
   * Статический анализ AST на запрещенные конструкции и нарушение детерминизма
   */
  public lintCode(sourceCode: string, fileName = "virtual.ts"): LintResult {
    const sourceFile = ts.createSourceFile(
      fileName,
      sourceCode,
      ts.ScriptTarget.ES2022,
      true
    );

    const violations: LintViolation[] = [];

    const report = (node: ts.Node, ruleId: string, message: string) => {
      const { line, character } = sourceFile.getLineAndCharacterOfPosition(
        node.getStart(sourceFile)
      );
      violations.push({
        ruleId,
        message,
        line: line + 1,
        column: character + 1,
      });
    };

    const visit = (node: ts.Node) => {
      // 1. Запрет eval() (требование безопасности и Chrome Web Store Manifest V3),
      //    включая globalThis.eval(...) / window.eval(...)
      if (ts.isCallExpression(node) && LinterRunner.calleeName(node.expression) === "eval") {
        report(node, "no-eval", "Использование eval() строго запрещено политикой безопасности");
      }

      // 2. Запрет конструктора Function: и `new Function(...)`, и `Function(...)` без new
      if (
        (ts.isNewExpression(node) || ts.isCallExpression(node)) &&
        LinterRunner.calleeName(node.expression) === "Function"
      ) {
        report(node, "no-new-func", "Динамическая генерация кода через new Function() запрещена");
      }

      // 3. Запрет забытых debugger-инструкций
      if (node.kind === ts.SyntaxKind.DebuggerStatement) {
        report(node, "no-debugger", "Инструкция debugger не допускается в финальном патче");
      }

      // 4. Запрет явного типа `any` для сохранения строгой типизации
      if (node.kind === ts.SyntaxKind.AnyKeyword) {
        report(node, "no-explicit-any", "Использование типа 'any' запрещено — укажите строгий тип");
      }

      ts.forEachChild(node, visit);
    };

    visit(sourceFile);

    return {
      passed: violations.length === 0,
      violations,
    };
  }

  /**
   * Линтит результат патча, но блокирует только НОВЫЕ нарушения.
   * Уже существующие в файле `any`/`debugger` не должны навсегда блокировать любой патч.
   */
  public lintPatch(originalCode: string, patchedCode: string, fileName = "virtual.ts"): LintResult {
    const sourceLine = (code: string) => {
      const lines = code.split("\n");
      return (v: LintViolation) => `${v.ruleId}|${(lines[v.line - 1] ?? "").trim()}`;
    };

    const baselineKey = sourceLine(originalCode);
    const baseline = new Map<string, number>();
    for (const v of this.lintCode(originalCode, fileName).violations) {
      const key = baselineKey(v);
      baseline.set(key, (baseline.get(key) ?? 0) + 1);
    }

    const patchedKey = sourceLine(patchedCode);
    const violations = this.lintCode(patchedCode, fileName).violations.filter((v) => {
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

  private static calleeName(expression: ts.Expression): string | undefined {
    if (ts.isIdentifier(expression)) {
      return expression.text;
    }
    if (ts.isPropertyAccessExpression(expression) && ts.isIdentifier(expression.name)) {
      const owner = expression.expression;
      if (ts.isIdentifier(owner) && ["globalThis", "window", "self", "global"].includes(owner.text)) {
        return expression.name.text;
      }
    }
    return undefined;
  }

  public formatViolations(result: LintResult): string {
    return result.violations
      .map((v) => `[${v.ruleId}] Строка ${v.line}:${v.column} - ${v.message}`)
      .join("; ");
  }
}
