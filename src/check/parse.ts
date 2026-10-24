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
  return Object.hasOwn(EXTENSIONS, extensionOf(fileName));
}

function extensionOf(fileName: string): string {
  const match = fileName.toLowerCase().match(/\.([a-z]+)$/);
  return match ? match[1] : "";
}

/** Parser options per file type; JSX is enabled for .js too (common in React code) */
export function parserOptions(fileName: string, tokens = false): ParserOptions {
  // Own keys only: "x.constructor" must not resolve through Object.prototype
  if (!isSupportedFile(fileName)) throw new UnsupportedFileError(fileName);
  const entry = EXTENSIONS[extensionOf(fileName)];
  const typescript = entry.language === "ts" || entry.language === "tsx";
  const plugins: NonNullable<ParserOptions["plugins"]> = typescript ? ["typescript"] : [];
  if (entry.language !== "ts") plugins.push("jsx");
  plugins.push("decorators");
  return { sourceType: entry.sourceType, plugins, tokens, errorRecovery: false };
}

// One proposal check parses the original and the candidate for syntax, lint and the
// semantic diff; a tiny memo makes that one parse per side. Results are read-only.
const PARSE_CACHE_SIZE = 4;
const parseCache = new Map<string, ParseResult<File>>();

/**
 * Throws Babel's SyntaxError (with `loc`) on the first syntax error. Tokens are always
 * collected so every caller can share one parse; callers must not mutate the result.
 */
export function parseSource(code: string, fileName: string): ParseResult<File> {
  const key = `${fileName}\u0000${code}`;
  const cached = parseCache.get(key);
  if (cached) {
    // Refresh recency
    parseCache.delete(key);
    parseCache.set(key, cached);
    return cached;
  }
  const result = parse(code, parserOptions(fileName, true));
  parseCache.set(key, result);
  if (parseCache.size > PARSE_CACHE_SIZE) parseCache.delete(parseCache.keys().next().value!);
  return result;
}

const SKIPPED_KEYS = new Set(["loc", "start", "end", "extra", "range", "leadingComments", "trailingComments", "innerComments", "comments", "tokens", "errors"]);

/** Where a node sits in its parent: needed to tell `x.eval` (a property name) from `eval` */
export interface NodeContext {
  parent: Node | null;
  key: string | null;
}

/** Visits every AST node in source order, iteratively (no recursion limit on deep code) */
export function walk(root: Node, visit: (node: Node, context: NodeContext) => void): void {
  const stack: Array<{ node: Node; context: NodeContext }> = [{ node: root, context: { parent: null, key: null } }];
  while (stack.length > 0) {
    const { node, context } = stack.pop()!;
    visit(node, context);
    const children: Array<{ node: Node; context: NodeContext }> = [];
    for (const key of Object.keys(node)) {
      if (SKIPPED_KEYS.has(key)) continue;
      const value = (node as unknown as Record<string, unknown>)[key];
      if (Array.isArray(value)) {
        for (const item of value) if (isNode(item)) children.push({ node: item, context: { parent: node, key } });
      } else if (isNode(value)) {
        children.push({ node: value, context: { parent: node, key } });
      }
    }
    for (let i = children.length - 1; i >= 0; i--) stack.push(children[i]);
  }
}

/** Line terminators as Babel counts them for `loc.line` (ECMAScript LineTerminatorSequence) */
export const LINE_TERMINATOR = /\r\n|[\n\r\u2028\u2029]/;

function isNode(value: unknown): value is Node {
  return typeof value === "object" && value !== null && typeof (value as { type?: unknown }).type === "string";
}
