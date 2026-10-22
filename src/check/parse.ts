// Shared Babel parsing for the checks. Pure: no DOM, no chrome.*, no Node APIs, so the same
// code runs in the extension worker, in tests and in a future MCP server (ADR-0002, ADR-0003).
import { ParseResult, ParserOptions, parse } from "@babel/parser";
import type { File, Node } from "@babel/types";

export type SourceLanguage = "ts" | "tsx" | "js" | "jsx";

const EXTENSIONS: Record<string, { language: SourceLanguage; sourceType: ParserOptions["sourceType"] }> = {
  ts: { language: "ts", sourceType: "module" },
  mts: { language: "ts", sourceType: "module" },
  cts: { language: "ts", sourceType: "commonjs" },
  tsx: { language: "tsx", sourceType: "module" },
  js: { language: "js", sourceType: "unambiguous" },
  mjs: { language: "js", sourceType: "module" },
  cjs: { language: "js", sourceType: "commonjs" },
  jsx: { language: "jsx", sourceType: "module" },
};

export class UnsupportedFileError extends Error {
  readonly code = "unsupported-file";
  constructor(fileName: string) {
    super(`UnsupportedFile: only TypeScript and JavaScript files are supported, got "${fileName}"`);
    this.name = "UnsupportedFileError";
  }
}

export function isSupportedFile(fileName: string): boolean {
  return extensionOf(fileName) in EXTENSIONS;
}

function extensionOf(fileName: string): string {
  const match = fileName.toLowerCase().match(/\.([a-z]+)$/);
  return match ? match[1] : "";
}

/** Parser options per file type; JSX is enabled for .js too (common in React code) */
export function parserOptions(fileName: string, tokens = false): ParserOptions {
  const entry = EXTENSIONS[extensionOf(fileName)];
  if (!entry) throw new UnsupportedFileError(fileName);
  const typescript = entry.language === "ts" || entry.language === "tsx";
  const plugins: NonNullable<ParserOptions["plugins"]> = typescript ? ["typescript"] : [];
  if (entry.language !== "ts") plugins.push("jsx");
  plugins.push("decorators");
  return { sourceType: entry.sourceType, plugins, tokens, errorRecovery: false };
}

/** Throws Babel's SyntaxError (with `loc`) on the first syntax error */
export function parseSource(code: string, fileName: string, tokens = false): ParseResult<File> {
  return parse(code, parserOptions(fileName, tokens));
}

const SKIPPED_KEYS = new Set(["loc", "start", "end", "extra", "range", "leadingComments", "trailingComments", "innerComments", "comments", "tokens", "errors"]);

/** Visits every AST node in source order, iteratively (no recursion limit on deep code) */
export function walk(root: Node, visit: (node: Node) => void): void {
  const stack: Node[] = [root];
  while (stack.length > 0) {
    const node = stack.pop()!;
    visit(node);
    const children: Node[] = [];
    for (const key of Object.keys(node)) {
      if (SKIPPED_KEYS.has(key)) continue;
      const value = (node as unknown as Record<string, unknown>)[key];
      if (Array.isArray(value)) {
        for (const item of value) if (isNode(item)) children.push(item);
      } else if (isNode(value)) {
        children.push(value);
      }
    }
    for (let i = children.length - 1; i >= 0; i--) stack.push(children[i]);
  }
}

function isNode(value: unknown): value is Node {
  return typeof value === "object" && value !== null && typeof (value as { type?: unknown }).type === "string";
}
