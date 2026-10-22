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
      // 1. Запрет eval() (требование безопасности и Chrome Web Store Manifest V3)
      if (
        ts.isCallExpression(node) &&
        ts.isIdentifier(node.expression) &&
        node.expression.text === "eval"
      ) {
        report(node, "no-eval", "Использование eval() строго запрещено политикой безопасности");
      }

      // 2. Запрет конструктора new Function()
      if (
        ts.isNewExpression(node) &&
        ts.isIdentifier(node.expression) &&
        node.expression.text === "Function"
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

  public formatViolations(result: LintResult): string {
    return result.violations
      .map((v) => `[${v.ruleId}] Строка ${v.line}:${v.column} - ${v.message}`)
      .join("; ");
  }
}
