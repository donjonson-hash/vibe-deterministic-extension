// Deterministic line diff (policy line-myers-v1): a minimal edit script by Myers' O(ND)
// algorithm over LF-normalized text. Same inputs always give the same rows; there is no
// time-based cutoff, and inputs beyond the explicit limits are rejected, not approximated.

export const LINE_DIFF_POLICY = "line-myers-v1";

export const LINE_DIFF_LIMITS = Object.freeze({
  /** Matches the deterministic-extensions document line limit */
  maxLines: 4000,
  /** Edit distance in lines; bounds the backtracking trace to ~maxEdits² integers */
  maxEdits: 2000,
});

export type DiffRowKind = "equal" | "removed" | "added";

export interface DiffRow {
  kind: DiffRowKind;
  /** 1-based line in the original text, null for added rows */
  aLine: number | null;
  /** 1-based line in the result text, null for removed rows */
  bLine: number | null;
  text: string;
}

export interface LineDiff {
  policy: typeof LINE_DIFF_POLICY;
  rows: DiffRow[];
  added: number;
  removed: number;
  /** Whether each text ends with a line break; a change shows as a changed last line */
  aFinalNewline: boolean;
  bFinalNewline: boolean;
}

export interface DiffHunk {
  aStart: number;
  aCount: number;
  bStart: number;
  bCount: number;
  rows: DiffRow[];
}

export class DiffLimitError extends RangeError {
  readonly code = "diff-limit-exceeded";
  constructor(message: string) {
    super(message);
    this.name = "DiffLimitError";
  }
}

function splitLines(text: string): { lines: string[]; finalNewline: boolean } {
  if (text.includes("\r")) {
    throw new TypeError("diffLines expects LF-normalized text");
  }
  if (text.length === 0) return { lines: [], finalNewline: false };
  const finalNewline = text.endsWith("\n");
  const lines = (finalNewline ? text.slice(0, -1) : text).split("\n");
  return { lines, finalNewline };
}

/** Comparison keys: the last line without a final newline differs from the same text with one */
function lineKeys(lines: string[], finalNewline: boolean, ids: Map<string, number>): Int32Array {
  const keys = new Int32Array(lines.length);
  lines.forEach((line, index) => {
    const key = index === lines.length - 1 && !finalNewline ? `${line}\u0000no-eol` : line;
    let id = ids.get(key);
    if (id === undefined) {
      id = ids.size;
      ids.set(key, id);
    }
    keys[index] = id;
  });
  return keys;
}

export function diffLines(before: string, after: string): LineDiff {
  const a = splitLines(before);
  const b = splitLines(after);
  for (const [side, split] of [["original", a], ["result", b]] as const) {
    if (split.lines.length > LINE_DIFF_LIMITS.maxLines) {
      throw new DiffLimitError(`The ${side} has ${split.lines.length} lines; the limit is ${LINE_DIFF_LIMITS.maxLines}`);
    }
  }

  const ids = new Map<string, number>();
  const ak = lineKeys(a.lines, a.finalNewline, ids);
  const bk = lineKeys(b.lines, b.finalNewline, ids);

  // Common prefix and suffix need no search
  let prefix = 0;
  while (prefix < ak.length && prefix < bk.length && ak[prefix] === bk[prefix]) prefix++;
  let suffix = 0;
  while (
    suffix < ak.length - prefix &&
    suffix < bk.length - prefix &&
    ak[ak.length - 1 - suffix] === bk[bk.length - 1 - suffix]
  ) suffix++;

  const n = ak.length - prefix - suffix;
  const m = bk.length - prefix - suffix;
  const A = (i: number) => ak[prefix + i];
  const B = (j: number) => bk[prefix + j];

  // Forward Myers search; trace[d] holds v[k] for k in [-d, d] after step d
  const max = n + m;
  const v = new Int32Array(2 * max + 3);
  const offset = max + 1;
  const trace: Int32Array[] = [];
  let distance = -1;
  for (let d = 0; d <= max; d++) {
    if (d > LINE_DIFF_LIMITS.maxEdits) {
      throw new DiffLimitError(`More than ${LINE_DIFF_LIMITS.maxEdits} changed lines; the diff is not shown`);
    }
    let done = false;
    for (let k = -d; k <= d; k += 2) {
      let x = k === -d || (k !== d && v[offset + k - 1] < v[offset + k + 1]) ? v[offset + k + 1] : v[offset + k - 1] + 1;
      let y = x - k;
      while (x < n && y < m && A(x) === B(y)) {
        x++;
        y++;
      }
      v[offset + k] = x;
      if (x >= n && y >= m) done = true;
    }
    trace.push(v.slice(offset - d, offset + d + 1));
    if (done) {
      distance = d;
      break;
    }
  }

  // Backtrack from (n, m) to (0, 0); rows are collected in reverse
  type Step = { kind: DiffRowKind; ai: number; bi: number };
  const reversed: Step[] = [];
  let x = n;
  let y = m;
  for (let d = distance; d > 0; d--) {
    const prev = trace[d - 1];
    const at = (k: number) => prev[k + d - 1];
    const k = x - y;
    const prevK = k === -d || (k !== d && at(k - 1) < at(k + 1)) ? k + 1 : k - 1;
    const prevX = at(prevK);
    const prevY = prevX - prevK;
    while (x > prevX && y > prevY) {
      reversed.push({ kind: "equal", ai: x - 1, bi: y - 1 });
      x--;
      y--;
    }
    if (prevK === k + 1) {
      reversed.push({ kind: "added", ai: -1, bi: y - 1 });
    } else {
      reversed.push({ kind: "removed", ai: x - 1, bi: -1 });
    }
    x = prevX;
    y = prevY;
  }
  while (x > 0 && y > 0) {
    reversed.push({ kind: "equal", ai: x - 1, bi: y - 1 });
    x--;
    y--;
  }

  const rows: DiffRow[] = [];
  const equalRow = (i: number, j: number): DiffRow => ({ kind: "equal", aLine: i + 1, bLine: j + 1, text: a.lines[i] });
  for (let i = 0; i < prefix; i++) rows.push(equalRow(i, i));

  // Inside each change block, list removed rows before added ones (canonical reading order)
  let block: DiffRow[] = [];
  const flush = () => {
    block.sort((l, r) => (l.kind === r.kind ? 0 : l.kind === "removed" ? -1 : 1));
    rows.push(...block);
    block = [];
  };
  for (let index = reversed.length - 1; index >= 0; index--) {
    const step = reversed[index];
    if (step.kind === "equal") {
      flush();
      rows.push(equalRow(prefix + step.ai, prefix + step.bi));
    } else if (step.kind === "removed") {
      block.push({ kind: "removed", aLine: prefix + step.ai + 1, bLine: null, text: a.lines[prefix + step.ai] });
    } else {
      block.push({ kind: "added", aLine: null, bLine: prefix + step.bi + 1, text: b.lines[prefix + step.bi] });
    }
  }
  flush();
  for (let i = suffix; i > 0; i--) {
    rows.push(equalRow(a.lines.length - i, b.lines.length - i));
  }

  return {
    policy: LINE_DIFF_POLICY,
    rows,
    added: rows.filter((r) => r.kind === "added").length,
    removed: rows.filter((r) => r.kind === "removed").length,
    aFinalNewline: a.finalNewline,
    bFinalNewline: b.finalNewline,
  };
}

/** Groups changed rows with `context` unchanged lines around them, unified-diff style */
export function toHunks(diff: LineDiff, context = 3): DiffHunk[] {
  const changed = diff.rows.map((row) => row.kind !== "equal");
  const hunks: DiffHunk[] = [];
  let index = 0;
  while (index < diff.rows.length) {
    if (!changed[index]) {
      index++;
      continue;
    }
    const start = Math.max(0, index - context);
    let end = index;
    // Extend while the next change is within 2 * context unchanged rows
    for (;;) {
      while (end < diff.rows.length && changed[end]) end++;
      let gap = end;
      while (gap < diff.rows.length && !changed[gap] && gap - end < 2 * context) gap++;
      if (gap < diff.rows.length && changed[gap]) {
        end = gap;
        continue;
      }
      break;
    }
    const stop = Math.min(diff.rows.length, end + context);
    const rows = diff.rows.slice(start, stop);
    const firstA = rows.find((r) => r.aLine !== null)?.aLine ?? lastLineBefore(diff.rows, start, "a") + 1;
    const firstB = rows.find((r) => r.bLine !== null)?.bLine ?? lastLineBefore(diff.rows, start, "b") + 1;
    hunks.push({
      aStart: firstA,
      aCount: rows.filter((r) => r.aLine !== null).length,
      bStart: firstB,
      bCount: rows.filter((r) => r.bLine !== null).length,
      rows,
    });
    index = stop;
  }
  return hunks;
}

function lastLineBefore(rows: DiffRow[], index: number, side: "a" | "b"): number {
  for (let i = index - 1; i >= 0; i--) {
    const line = side === "a" ? rows[i].aLine : rows[i].bLine;
    if (line !== null) return line;
  }
  return 0;
}
