// Syntax gate: the patched file must parse. No type checking (see ADR-0003).
import { parseSource } from "./parse";

export interface SyntaxResult {
  valid: boolean;
  errors: string[];
}

export function checkSyntax(code: string, fileName: string): SyntaxResult {
  try {
    parseSource(code, fileName);
    return { valid: true, errors: [] };
  } catch (err) {
    return { valid: false, errors: [describeSyntaxError(err, fileName)] };
  }
}

function describeSyntaxError(err: unknown, fileName: string): string {
  if (!(err instanceof Error)) return `${fileName}: ${String(err)}`;
  const loc = (err as { loc?: { line: number; column: number } }).loc;
  if (!loc) return `${fileName}: ${err.message}`;
  // Babel appends "(line:column)"; the position is reported in front instead
  const message = err.message.replace(/\s*\(\d+:\d+\)$/, "");
  return `${fileName} (${loc.line},${loc.column + 1}): ${message}`;
}
