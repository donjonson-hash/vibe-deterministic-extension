// Line-ending policy for edits: the pipeline works on LF text and writes results back in
// the source file's own style, so unchanged lines keep their exact bytes.

export type EolStyle = "lf" | "crlf" | "cr" | "none" | "mixed";

const EOL_TEXT: Record<"lf" | "crlf" | "cr", string> = { lf: "\n", crlf: "\r\n", cr: "\r" };

export function detectEol(raw: string): EolStyle {
  const endings = new Set(raw.match(/\r\n|\r|\n/g) ?? []);
  if (endings.size === 0) return "none";
  if (endings.size > 1) return "mixed";
  const [only] = endings;
  return only === "\r\n" ? "crlf" : only === "\r" ? "cr" : "lf";
}

export function toLf(text: string): string {
  return text.replace(/\r\n|\r/g, "\n");
}

/**
 * Converts LF text to the given style. `none` keeps LF (a file without line breaks gains
 * LF ones). `mixed` cannot be reproduced and is rejected: callers must not round-trip it.
 */
export function fromLf(text: string, style: EolStyle): string {
  if (style === "mixed") {
    throw new RangeError("Mixed line endings cannot be restored from LF text");
  }
  if (style === "lf" || style === "none") return text;
  return text.replace(/\n/g, EOL_TEXT[style]);
}
