export type SearchReplaceResult =
  | { ok: true; code: string }
  | { ok: false; reason: "EMPTY_SEARCH" | "NOT_FOUND" | "AMBIGUOUS"; occurrences: number };

/**
 * Детерминированная замена searchBlock -> replaceBlock.
 * Требует ровно одно вхождение блока и не интерпретирует `$&`, `$1`, `$$` в replaceBlock
 * (String.prototype.replace со строкой-заменой искажает такой код).
 */
export function applySearchReplace(
  source: string,
  searchBlock: string,
  replaceBlock: string
): SearchReplaceResult {
  if (searchBlock.length === 0) {
    return { ok: false, reason: "EMPTY_SEARCH", occurrences: 0 };
  }

  const first = source.indexOf(searchBlock);
  if (first === -1) {
    return { ok: false, reason: "NOT_FOUND", occurrences: 0 };
  }

  if (source.indexOf(searchBlock, first + 1) !== -1) {
    const occurrences = source.split(searchBlock).length - 1;
    return { ok: false, reason: "AMBIGUOUS", occurrences };
  }

  return {
    ok: true,
    code: source.slice(0, first) + replaceBlock + source.slice(first + searchBlock.length),
  };
}

/**
 * Ординальное (не зависящее от локали ОС) сравнение строк для стабильной сортировки
 */
export function compareOrdinal(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}
