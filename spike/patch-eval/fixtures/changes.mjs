// A chunk includes complete lines for rendering. Its changes identify the actual
// edited characters, so labels must be based on those narrower ranges.
const clamp = (position, doc) => Math.max(0, Math.min(doc.length, position));

// This describes characters only, not semantic equivalence: indentation and
// spaces inside string literals can change a program. Keep line breaks and all
// other whitespace significant, and never modify the editor documents here.
function onlySpacesOrTabsChanged(chunk, docA, docB) {
  const a = docA.sliceString(clamp(chunk.fromA, docA), clamp(chunk.toA, docA));
  const b = docB.sliceString(clamp(chunk.fromB, docB), clamp(chunk.toB, docB));
  return a !== b && a.replace(/[ \t]/g, '') === b.replace(/[ \t]/g, '');
}

function describeSide(chunk, changes, doc, side) {
  const base = chunk[`from${side}`];
  const spans = changes.map(change => ({
    from: clamp(base + change[`from${side}`], doc),
    to: clamp(base + change[`to${side}`], doc)
  }));
  const from = Math.min(...spans.map(span => span.from));
  const to = Math.max(...spans.map(span => span.to));
  const empty = spans.every(span => span.from === span.to);
  const ranges = [];
  for (const span of spans) {
    if (span.from === span.to) continue;
    // Appending a complete line can be represented as "\nnew line". The
    // unchanged preceding line should not be listed as changed in that case.
    const start = span.to > span.from + 1 && doc.sliceString(span.from, span.from + 1) === '\n'
      ? span.from + 1 : span.from;
    const first = doc.lineAt(start).number;
    const last = doc.lineAt(Math.max(start, span.to - 1)).number;
    const previous = ranges.at(-1);
    if (previous && first <= previous.endLine + 1) previous.endLine = Math.max(last, previous.endLine);
    else ranges.push({ startLine: first, endLine: last });
  }
  const anchor = doc.lineAt(from);
  const startLine = ranges[0]?.startLine ?? anchor.number;
  const endLine = ranges.at(-1)?.endLine ?? startLine;
  let label;
  if (empty) {
    if (!doc.length) label = 'empty file';
    else if (from === doc.length) label = `end of file (line ${anchor.number})`;
    else if (from === anchor.from) label = `before line ${anchor.number}`;
    else label = `line ${anchor.number}, column ${from - anchor.from + 1}`;
  } else {
    const numbers = ranges.map(range => range.startLine === range.endLine
      ? String(range.startLine) : `${range.startLine}–${range.endLine}`).join(', ');
    label = `${ranges.length === 1 && startLine === endLine ? 'line' : 'lines'} ${numbers}`;
  }
  return { from, to, startLine, endLine, empty, ranges, label };
}

export function buildChangeItems(chunks, docA, docB) {
  return chunks.map((chunk, index) => {
    const changes = chunk.changes.length ? chunk.changes : [{
      fromA: 0, toA: chunk.toA - chunk.fromA,
      fromB: 0, toB: chunk.toB - chunk.fromB
    }];
    const a = describeSide(chunk, changes, docA, 'A');
    const b = describeSide(chunk, changes, docB, 'B');
    const whitespaceOnly = onlySpacesOrTabsChanged(chunk, docA, docB);
    const kind = whitespaceOnly ? 'Spaces / tabs changed'
      : a.empty && !b.empty ? 'Added in B' : b.empty && !a.empty ? 'Removed from B' : 'Changed';
    const previewDoc = b.empty ? docA : docB;
    const previewSide = b.empty ? a : b;
    let preview = '';
    for (let line = previewSide.startLine; line <= previewSide.endLine && !preview; line++) {
      preview = previewDoc.line(line).text.trim().slice(0, 110);
    }
    preview ||= 'Blank line / line break';
    const label = `A: ${a.label} · B: ${b.label}`;
    return { chunk, index, kind, whitespaceOnly, a, b, label, preview, summary: `${kind} — ${label}` };
  });
}
