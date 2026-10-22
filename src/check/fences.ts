/**
 * Fenced code blocks per CommonMark: a fence is a line of 3+ backticks or tildes, closed by
 * a line of the same character at least as long. Backticks inside lines are content.
 */
export function extractFencedBlocks(raw: string): string[] {
  const lines = raw.split("\n");
  const blocks: string[] = [];
  let open: { char: string; length: number; start: number } | null = null;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].replace(/\r$/, "");
    if (!open) {
      const opening = line.match(/^ {0,3}(`{3,}|~{3,})([^`]*)$/);
      if (opening) open = { char: opening[1][0], length: opening[1].length, start: i + 1 };
      continue;
    }
    const closing = line.match(/^ {0,3}(`{3,}|~{3,})\s*$/);
    if (closing && closing[1][0] === open.char && closing[1].length >= open.length) {
      blocks.push(lines.slice(open.start, i).map((l) => l.replace(/\r$/, "")).join("\n"));
      open = null;
    }
  }
  return blocks;
}

/**
 * The JSON part of an answer: bare JSON, JSON in one fence, or (as pasted from a chat) the
 * single fenced block that holds a JSON object amid prose. Otherwise the trimmed text is
 * returned and fails JSON parsing with a clear error.
 */
export function extractJsonAnswer(text: string): string {
  const trimmed = text.trim();
  if (trimmed.startsWith("{")) return trimmed;
  const objects = extractFencedBlocks(trimmed)
    .map((block) => block.trim())
    .filter((block) => block.startsWith("{"));
  return objects.length === 1 ? objects[0] : trimmed;
}
