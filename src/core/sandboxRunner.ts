import { MessageChannel, Worker, receiveMessageOnPort } from "node:worker_threads";
import * as ts from "typescript";

export interface SandboxExecutionResult {
  success: boolean;
  /** Имена экспортов модуля и их `typeof` (функции нельзя передать из воркера) */
  exportTypes: Record<string, string>;
  logs: string[];
  error?: string;
  executionTimeMs: number;
}

const STATE_IDLE = 0;
const STATE_STARTED = 1;
const STATE_DONE = 2;
const WORKER_STARTUP_TIMEOUT_MS = 10_000;

/**
 * Код окружения выполняется ВНУТРИ vm-контекста, поэтому console/require/exports — объекты
 * чужого realm. Если передать в контекст объекты или функции хоста, то через
 * `console.log.constructor("return process")()` проверяемый код получает `process`.
 * Единственная внешняя функция (hostLog) доступна только из замыкания и получает строки.
 */
const SANDBOX_BOOTSTRAP = `(function (hostLog) {
  "use strict";
  const format = (args) => args.map((a) => String(a)).join(" ");
  const log = (...args) => { hostLog(format(args)); };
  globalThis.console = Object.freeze({ log, info: log, warn: log, error: log, debug: log });

  // Зависимости модуля заменяются инертной заглушкой: проверяется только то,
  // что сам модуль вычисляется без исключений, без доступа к fs/net/child_process.
  const inert = new Proxy(function () {}, {
    get: (_target, key) => (key === "then" ? undefined : key === Symbol.toPrimitive ? () => "" : inert),
    apply: () => inert,
    construct: () => inert,
  });
  globalThis.require = () => inert;
  globalThis.process = Object.freeze({ env: Object.freeze({}), argv: Object.freeze([]), platform: "sandbox" });

  const moduleExports = {};
  globalThis.exports = moduleExports;
  globalThis.module = { exports: moduleExports };
})`;

/**
 * Воркер: отдельный V8-изолят, который хост может принудительно завершить.
 * Это закрывает то, что не умеет таймаут node:vm: бесконечные цепочки промисов
 * и раздувание памяти (resourceLimits).
 */
const WORKER_SOURCE = `
"use strict";
const { workerData } = require("node:worker_threads");
const vm = require("node:vm");
const { code, bootstrap, port, state } = workerData;

const logs = [];
let failure;

const describeError = (err) => {
  // Ошибки из контекста — объекты другого realm; читаем только собственное data-свойство,
  // геттер или toString() снова выполнили бы код песочницы
  if (typeof err === "object" && err !== null) {
    const descriptor = Object.getOwnPropertyDescriptor(err, "message");
    return descriptor && typeof descriptor.value === "string" ? descriptor.value : "[sandbox error]";
  }
  return typeof err === "function" ? "[sandbox error]" : String(err);
};

const finish = (result) => {
  port.postMessage(result);
  Atomics.store(state, 0, ${STATE_DONE});
  Atomics.notify(state, 0);
};

process.on("unhandledRejection", (reason) => {
  failure = failure ?? "Unhandled promise rejection: " + describeError(reason);
});

Atomics.store(state, 0, ${STATE_STARTED});
Atomics.notify(state, 0);

try {
  // Основа контекста без прототипа: иначе globalThis.constructor.constructor — Function воркера
  const context = vm.createContext(Object.create(null), {
    codeGeneration: { strings: false, wasm: false },
  });
  vm.runInContext(bootstrap, context)((line) => logs.push(typeof line === "string" ? line : "[non-string log]"));
  new vm.Script(code, { filename: "sandbox.vm.js" }).runInContext(context);

  // Даем отработать микрозадачам модуля; бесконечную цепочку промисов прервет хост
  setImmediate(() => {
    if (failure) {
      finish({ success: false, logs, exportTypes: {}, error: failure });
      return;
    }
    try {
      const moduleExports = new vm.Script("module.exports").runInContext(context);
      const exportTypes = {};
      for (const key of Object.keys(moduleExports)) {
        exportTypes[key] = typeof moduleExports[key];
      }
      finish({ success: true, logs, exportTypes });
    } catch (err) {
      finish({ success: false, logs, exportTypes: {}, error: describeError(err) });
    }
  });
} catch (err) {
  finish({ success: false, logs, exportTypes: {}, error: describeError(err) });
}
`;

export class SandboxRunner {
  private readonly defaultTimeoutMs: number;

  constructor(defaultTimeoutMs = 500) {
    this.defaultTimeoutMs = defaultTimeoutMs;
  }

  /**
   * Транспилирует TypeScript в памяти и выполняет в отдельном воркере и V8-контексте
   * с таймаутом и лимитом памяти. Вызов синхронный: хост ждет результат через Atomics.wait.
   * ВАЖНО: node:vm — не граница безопасности (см. документацию Node.js); это защита
   * от случайных ошибок, зависаний и утечек, а не полноценная изоляция вредоносного кода.
   */
  public executeIsolated(
    tsCode: string,
    assertionScript?: string,
    timeoutMs = this.defaultTimeoutMs
  ): SandboxExecutionResult {
    const startTime = Date.now();
    const fail = (error: string): SandboxExecutionResult => ({
      success: false,
      exportTypes: {},
      logs: [],
      error,
      executionTimeMs: Date.now() - startTime,
    });

    let jsCode: string;
    try {
      const transpiled = ts.transpileModule(tsCode, {
        compilerOptions: {
          module: ts.ModuleKind.CommonJS,
          target: ts.ScriptTarget.ES2022,
          strict: true,
        },
      });
      jsCode = assertionScript
        ? `${transpiled.outputText}\n;\n${assertionScript}`
        : transpiled.outputText;
    } catch (err: unknown) {
      return fail(err instanceof Error ? err.message : String(err));
    }

    const state = new Int32Array(new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT));
    const { port1, port2 } = new MessageChannel();
    const worker = new Worker(WORKER_SOURCE, {
      eval: true,
      workerData: { code: jsCode, bootstrap: SANDBOX_BOOTSTRAP, port: port2, state },
      transferList: [port2],
      env: {},
      stdout: true,
      stderr: true,
      resourceLimits: { maxOldGenerationSizeMb: 64, maxYoungGenerationSizeMb: 16 },
    });
    worker.unref();
    // Без обработчика 'error' (например, ERR_WORKER_OUT_OF_MEMORY) падает весь процесс хоста
    worker.on("error", () => undefined);

    try {
      // Время старта воркера не входит в бюджет исполнения кода
      Atomics.wait(state, 0, STATE_IDLE, WORKER_STARTUP_TIMEOUT_MS);
      if (Atomics.load(state, 0) === STATE_IDLE) {
        return fail("Sandbox worker failed to start");
      }

      Atomics.wait(state, 0, STATE_STARTED, timeoutMs);
      const message = receiveMessageOnPort(port1)?.message as
        | Omit<SandboxExecutionResult, "executionTimeMs">
        | undefined;

      if (Atomics.load(state, 0) !== STATE_DONE || !message) {
        // Воркер, убитый по лимиту памяти, тоже не успевает ответить
        return fail(`Script execution timed out after ${timeoutMs}ms (or exceeded the sandbox memory limit)`);
      }

      return { ...message, executionTimeMs: Date.now() - startTime };
    } finally {
      port1.close();
      void worker.terminate();
    }
  }
}
