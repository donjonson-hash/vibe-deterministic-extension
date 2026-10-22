// One proposal (from an LLM or pasted from a chat) checked against one file. Pure and
// synchronous: the extension runs it in a worker, tests and the spike call it directly.
//
// Stages, in order: format (parse the answer) → apply → syntax → lint (new violations only).
// The semantic diff and the line diff describe an accepted candidate; they never block it,
// but `attention` lists changes that need an explicit confirmation.
import { detectEol, fromLf, toLf } from "../core/eol";
import { DiffLimitError, LineDiff, diffLines } from "../core/lineDiff";
import { SchemaValidationError, validateSchema } from "../llm/schemaParser";
import { applySearchReplace, isSameFile } from "../utils/patch";
import { extractFencedBlocks, stripJsonFence } from "./fences";
import { formatViolations, lintCode, lintPatch } from "./lint";
import { isSupportedFile } from "./parse";
import { SemanticDiffReport, attentionReasons, compareCode } from "./semanticDiff";
import { checkSyntax } from "./syntax";

/** sr: JSON with search/replace blocks; wf: the whole file in one fenced code block */
export type ProposalFormat = "sr" | "wf";
export type ProposalStage = "ok" | "format" | "apply" | "syntax" | "lint";

export interface ProposalInput {
  /** The answer text exactly as received */
  answer: string;
  format: ProposalFormat;
  /** The file's raw text (without BOM, which belongs to the document) */
  source: string;
  fileName: string;
}

export interface ProposalCheck {
  stage: ProposalStage;
  /** Why the proposal was rejected; suitable as feedback for an auto-fix retry */
  error?: string;
  intentSummary?: string;
  /** Set when stage is ok: the new file text in the source's own line endings */
  result?: string;
  semantic?: SemanticDiffReport;
  diff?: LineDiff;
  /** Non-blocking findings that must be confirmed explicitly before accepting */
  attention: string[];
}

const reject = (stage: Exclude<ProposalStage, "ok">, error: string): ProposalCheck => ({ stage, error, attention: [] });

export function checkProposal(input: ProposalInput): ProposalCheck {
  const { answer, format, source, fileName } = input;
  if (!isSupportedFile(fileName)) {
    return reject("format", `UnsupportedFile: only TypeScript and JavaScript files are supported, got "${fileName}"`);
  }

  // Uniform line endings are normalized to LF and restored afterwards, so a CRLF file stays
  // CRLF. Mixed endings cannot be restored: only exact search/replace on the raw text is safe.
  const eol = detectEol(source);
  const mixed = eol === "mixed";
  const normalize = (text: string) => (mixed ? text : toLf(text));
  const sourceText = normalize(source);

  let candidate: string;
  let intentSummary: string | undefined;
  if (format === "sr") {
    let parsed;
    try {
      parsed = validateSchema(stripJsonFence(answer));
    } catch (err) {
      return reject("format", err instanceof SchemaValidationError ? err.message : `SchemaValidationError: ${String(err)}`);
    }
    if (parsed.patches.length === 0) return reject("format", "SchemaValidationError: patches is empty");
    intentSummary = parsed.intentSummary;

    candidate = sourceText;
    for (const [index, patch] of parsed.patches.entries()) {
      if (!isSameFile(patch.targetFile, fileName)) {
        return reject("apply", `TargetFileMismatch: patches[${index}] targets "${patch.targetFile}", only "${fileName}" may be changed`);
      }
      const applied = applySearchReplace(candidate, normalize(patch.searchBlock), normalize(patch.replaceBlock));
      if (!applied.ok) {
        const what =
          applied.reason === "AMBIGUOUS"
            ? `occurs ${applied.occurrences} times; it must be unique`
            : applied.reason === "EMPTY_SEARCH"
              ? "is empty"
              : "was not found in the current file (after previous patches)";
        return reject("apply", `${applied.reason}: patches[${index}].searchBlock ${what}: ${JSON.stringify(patch.searchBlock).slice(0, 400)}`);
      }
      candidate = applied.code;
    }
  } else {
    if (mixed) {
      return reject("format", "MixedLineEndings: this file mixes CRLF/LF/CR; a whole-file answer would change them. Use search/replace blocks.");
    }
    const blocks = extractFencedBlocks(answer);
    if (blocks.length !== 1) {
      return reject("format", `FormatError: expected exactly one fenced code block with the whole file, got ${blocks.length}`);
    }
    candidate = toLf(blocks[0]);
    // The fence swallows the last line break; keep the original final-newline convention
    if (sourceText.endsWith("\n") && !candidate.endsWith("\n")) candidate += "\n";
  }

  if (candidate === sourceText) {
    return reject("apply", "NoChange: the result is identical to the original file");
  }

  // Checks and diffs always work on LF text
  const beforeLf = toLf(sourceText);
  const afterLf = toLf(candidate);
  const syntax = checkSyntax(afterLf, fileName);
  if (!syntax.valid) return reject("syntax", syntax.errors.join("; "));

  const attention: string[] = [];
  const originalParses = checkSyntax(beforeLf, fileName).valid;
  // Without a parsable original there is no lint baseline: every violation counts
  const lint = originalParses ? lintPatch(beforeLf, afterLf, fileName) : lintCode(afterLf, fileName);
  if (!lint.passed) return reject("lint", formatViolations(lint));

  let semantic: SemanticDiffReport | undefined;
  if (originalParses) {
    semantic = compareCode(beforeLf, afterLf, fileName);
    attention.push(...attentionReasons(semantic));
  } else {
    attention.push("Исходный файл не разбирается: смысловой дифф недоступен");
  }

  let diff: LineDiff | undefined;
  try {
    diff = diffLines(beforeLf, afterLf);
  } catch (err) {
    if (!(err instanceof DiffLimitError)) throw err;
    attention.push(`Построчный дифф не показан: ${err.message}`);
  }

  return {
    stage: "ok",
    intentSummary,
    result: mixed ? candidate : fromLf(candidate, eol),
    semantic,
    diff,
    attention,
  };
}
