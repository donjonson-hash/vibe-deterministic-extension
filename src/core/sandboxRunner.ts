import * as vm from "node:vm";
import * as ts from "typescript";

export interface SandboxExecutionResult {
  success: boolean;
  exports: Record<string, unknown>;
  logs: string[];
  error?: string;
  executionTimeMs: number;
}

export class SandboxRunner {
  private readonly defaultTimeoutMs: number;

  constructor(defaultTimeoutMs = 500) {
    this.defaultTimeoutMs = defaultTimeoutMs;
  }

  /**
   * Транспилирует TypeScript в памяти и выполняет в изолированном V8-контексте без доступа к ОС
   */
  public executeIsolated(
    tsCode: string,
    assertionScript?: string,
    timeoutMs = this.defaultTimeoutMs
  ): SandboxExecutionResult {
    const startTime = Date.now();
    const logs: string[] = [];

    try {
      const transpiled = ts.transpileModule(tsCode, {
        compilerOptions: {
          module: ts.ModuleKind.CommonJS,
          target: ts.ScriptTarget.ES2022,
          strict: true,
        },
      });

      const fullJsCode = assertionScript
        ? `${transpiled.outputText}\n;\n${assertionScript}`
        : transpiled.outputText;

      const moduleExports: Record<string, unknown> = {};
      const sandboxContext = vm.createContext({
        exports: moduleExports,
        module: { exports: moduleExports },
        console: {
          log: (...args: unknown[]) => logs.push(args.map(String).join(" ")),
          warn: (...args: unknown[]) => logs.push(args.map(String).join(" ")),
          error: (...args: unknown[]) => logs.push(args.map(String).join(" ")),
        },
      });

      const script = new vm.Script(fullJsCode, { filename: "sandbox.vm.js" });
      script.runInContext(sandboxContext, { timeout: timeoutMs });

      return {
        success: true,
        exports: (sandboxContext.module as { exports: Record<string, unknown> }).exports,
        logs,
        executionTimeMs: Date.now() - startTime,
      };
    } catch (err: any) {
      return {
        success: false,
        exports: {},
        logs,
        error: err?.message ?? String(err),
        executionTimeMs: Date.now() - startTime,
      };
    }
  }
}
