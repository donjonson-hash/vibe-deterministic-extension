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

/** A JSON answer wrapped in a single ```json fence is unwrapped; anything else is returned trimmed */
export function stripJsonFence(text: string): string {
  const trimmed = text.trim();
  const fence = trimmed.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
  return fence ? fence[1].trim() : trimmed;
}
