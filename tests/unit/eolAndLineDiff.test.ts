import { test } from "node:test";
import * as assert from "node:assert/strict";
import { detectEol, fromLf, toLf } from "../../src/core/eol";
import { DiffLimitError, LINE_DIFF_LIMITS, LineDiff, diffLines, toHunks } from "../../src/core/lineDiff";

test("detectEol distinguishes LF, CRLF, CR, none and mixed", () => {
  assert.equal(detectEol("a\nb\n"), "lf");
  assert.equal(detectEol("a\r\nb\r\n"), "crlf");
  assert.equal(detectEol("a\rb"), "cr");
  assert.equal(detectEol("abc"), "none");
  assert.equal(detectEol("a\r\nb\n"), "mixed");
});

test("toLf/fromLf round-trip every uniform style byte-for-byte", () => {
  for (const raw of ["a\nb\n", "a\r\nb\r\n", "a\rb\r", "single line", ""]) {
    assert.equal(fromLf(toLf(raw), detectEol(raw)), raw);
  }
  assert.throws(() => fromLf("a\nb", "mixed"), RangeError);
});

// Small deterministic PRNG so the property test is reproducible
function* lcg(seed: number) {
  let state = seed >>> 0;
  for (;;) {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    yield state / 2 ** 32;
  }
}

function lcsLength(a: string[], b: string[]): number {
  let prev = new Array<number>(b.length + 1).fill(0);
  for (let i = 1; i <= a.length; i++) {
    const cur = new Array<number>(b.length + 1).fill(0);
    for (let j = 1; j <= b.length; j++) cur[j] = a[i - 1] === b[j - 1] ? prev[j - 1] + 1 : Math.max(prev[j], cur[j - 1]);
    prev = cur;
  }
  return prev[b.length];
}

function rebuild(diff: LineDiff, side: "a" | "b"): string[] {
  return diff.rows.filter((r) => r.kind === "equal" || r.kind === (side === "a" ? "removed" : "added")).map((r) => r.text);
}

test("diffLines is a minimal edit script that rebuilds both sides (seeded property test)", () => {
  const random = lcg(42);
  const pick = () => "abcde"[Math.floor(random.next().value! * 5)];
  for (let round = 0; round < 300; round++) {
    const a = Array.from({ length: Math.floor(random.next().value! * 12) }, pick);
    const b = Array.from({ length: Math.floor(random.next().value! * 12) }, pick);
    const diff = diffLines(a.map((l) => l + "\n").join(""), b.map((l) => l + "\n").join(""));
    assert.deepEqual(rebuild(diff, "a"), a);
    assert.deepEqual(rebuild(diff, "b"), b);
    const lcs = lcsLength(a, b);
    assert.equal(diff.removed, a.length - lcs, `not minimal: ${a.join("")} -> ${b.join("")}`);
    assert.equal(diff.added, b.length - lcs, `not minimal: ${a.join("")} -> ${b.join("")}`);
  }
});

test("rows are deterministic, numbered, and list removals before additions in a block", () => {
  const before = "keep\nold one\nold two\nkeep too\n";
  const after = "keep\nnew one\nkeep too\n";
  const diff = diffLines(before, after);
  assert.deepEqual(diffLines(before, after), diff);
  assert.deepEqual(
    diff.rows.map((r) => [r.kind, r.aLine, r.bLine, r.text]),
    [
      ["equal", 1, 1, "keep"],
      ["removed", 2, null, "old one"],
      ["removed", 3, null, "old two"],
      ["added", null, 2, "new one"],
      ["equal", 4, 3, "keep too"],
    ]
  );
});

test("a dropped final newline shows as a changed last line", () => {
  const diff = diffLines("a\nb\n", "a\nb");
  assert.equal(diff.aFinalNewline, true);
  assert.equal(diff.bFinalNewline, false);
  assert.deepEqual(diff.rows.map((r) => r.kind), ["equal", "removed", "added"]);
  assert.equal(diffLines("", "").rows.length, 0);
});

test("CR input and over-limit inputs are rejected, not approximated", () => {
  assert.throws(() => diffLines("a\r\nb", "a"), TypeError);
  const tooLong = "x\n".repeat(LINE_DIFF_LIMITS.maxLines + 1);
  assert.throws(() => diffLines(tooLong, ""), DiffLimitError);
  const left = Array.from({ length: 2100 }, (_, i) => `a${i}\n`).join("");
  const right = Array.from({ length: 2100 }, (_, i) => `b${i}\n`).join("");
  assert.throws(() => diffLines(left, right), (err: unknown) => err instanceof DiffLimitError && err.code === "diff-limit-exceeded");
});

test("toHunks keeps context and merges nearby changes", () => {
  const before = Array.from({ length: 20 }, (_, i) => `l${i + 1}`).join("\n") + "\n";
  const after = before.replace("l5\n", "L5\n").replace("l8\n", "L8\n").replace("l18\n", "L18\n");
  const hunks = toHunks(diffLines(before, after), 3);
  assert.equal(hunks.length, 2);
  assert.deepEqual([hunks[0].aStart, hunks[0].aCount, hunks[0].bStart, hunks[0].bCount], [2, 10, 2, 10]);
  assert.deepEqual([hunks[1].aStart, hunks[1].aCount], [15, 6]);
  assert.equal(toHunks(diffLines(before, before)).length, 0);
});
