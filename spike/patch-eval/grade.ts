// Deterministic grading of one model response. Nothing here executes model output:
// it is parsed, applied to the fixture in memory, syntax-checked and linted.
import { validateSchema } from "../../src/llm/schemaParser";
import { AstValidator } from "../../src/pipeline/astValidator";
import { LinterRunner } from "../../src/pipeline/linterRunner";
import { SemanticDiffEngine } from "../../src/ui/semanticDiff";
import { applySearchReplace, isSameFile } from "../../src/utils/patch";

/** `incomplete`: the provider stopped early (refusal, output limit); like `transport`, not retried */
export type Stage = "ok" | "transport" | "incomplete" | "format" | "apply" | "syntax" | "lint";
export type Format = "sr" | "wf";

export interface AttemptOutcome {
  stage: Stage;
  error?: string;
  patchedCode?: string;
}

export interface IntentCheck {
  contains?: string;
  matches?: string;
  notMatches?: string;
}

export interface EvalTask {
  id: string;
  file: string;
  intent: string;
  checks: IntentCheck[];
  /** Top-level entities the intent is expected to change */
  touch: string[];
}

export interface GradedResponse {
  outcome: AttemptOutcome;
  intentPassed: boolean;
  failedChecks: string[];
  collateral: string[];
  changedLines: number | null;
}

const astValidator = new AstValidator();
const linter = new LinterRunner();
const semanticDiff = new SemanticDiffEngine();

function stripJsonFences(text: string): string {
  const trimmed = text.trim();
  const fence = trimmed.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
  return fence ? fence[1].trim() : trimmed;
}

function verify(source: string, candidate: string, fileName: string): AttemptOutcome {
  if (candidate === source) {
    return { stage: "apply", error: "NoChange: the result is identical to the original file" };
  }
  const syntax = astValidator.validateSyntax(candidate, fileName);
  if (!syntax.valid) {
    return { stage: "syntax", error: syntax.errors.join("; ") };
  }
  const lint = linter.lintPatch(source, candidate, fileName);
  if (!lint.passed) {
    return { stage: "lint", error: linter.formatViolations(lint) };
  }
  return { stage: "ok", patchedCode: candidate };
}

/**
 * Format A: JSON with search/replace blocks, applied in order. Like src/extension.ts,
 * a patch aimed at another file is rejected (TargetFileMismatch).
 */
export function evaluateSearchReplace(raw: string, source: string, fileName: string): AttemptOutcome {
  let parsed;
  try {
    parsed = validateSchema(stripJsonFences(raw));
  } catch (err) {
    return { stage: "format", error: err instanceof Error ? err.message : String(err) };
  }
  if (parsed.patches.length === 0) {
    return { stage: "format", error: "SchemaValidationError: patches is empty" };
  }

  let code = source;
  for (const [index, patch] of parsed.patches.entries()) {
    if (!isSameFile(patch.targetFile, fileName)) {
      return {
        stage: "apply",
        error: `TargetFileMismatch: patches[${index}] targets "${patch.targetFile}", only "${fileName}" may be changed`,
      };
    }
    const applied = applySearchReplace(code, patch.searchBlock, patch.replaceBlock);
    if (!applied.ok) {
      const what =
        applied.reason === "AMBIGUOUS"
          ? `occurs ${applied.occurrences} times; it must be unique`
          : "was not found in the current file (after previous patches)";
      return {
        stage: "apply",
        error: `${applied.reason}: patches[${index}].searchBlock ${what}: ${JSON.stringify(patch.searchBlock).slice(0, 400)}`,
      };
    }
    code = applied.code;
  }
  return verify(source, code, fileName);
}

/**
 * Fenced code blocks per CommonMark: a fence is a line of 3+ backticks or tildes, closed by
 * a line of the same character at least as long. Backticks inside lines are file content.
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
      blocks.push(lines.slice(open.start, i).join("\n"));
      open = null;
    }
  }
  return blocks;
}

/** Format B: the complete updated file inside one fenced code block */
export function evaluateWholeFile(raw: string, source: string, fileName: string): AttemptOutcome {
  const blocks = extractFencedBlocks(raw);
  if (blocks.length !== 1) {
    return {
      stage: "format",
      error: `FormatError: expected exactly one fenced code block with the whole file, got ${blocks.length}`,
    };
  }
  let candidate = blocks[0];
  // Keep the original final newline convention; the fence swallows the last line break
  if (source.endsWith("\n") && !candidate.endsWith("\n")) {
    candidate += "\n";
  }
  return verify(source, candidate, fileName);
}

export function checkIntent(task: EvalTask, code: string): string[] {
  const failed: string[] = [];
  for (const check of task.checks) {
    if (check.contains !== undefined && !code.includes(check.contains)) {
      failed.push(`contains ${JSON.stringify(check.contains)}`);
    }
    if (check.matches !== undefined && !new RegExp(check.matches, "i").test(code)) {
      failed.push(`matches /${check.matches}/`);
    }
    if (check.notMatches !== undefined && new RegExp(check.notMatches).test(code)) {
      failed.push(`notMatches /${check.notMatches}/`);
    }
  }
  return failed;
}

/** Changed lines by LCS: the size of a minimal line diff */
export function changedLineCount(before: string, after: string): number {
  const a = before.split("\n");
  const b = after.split("\n");
  let previous = new Array<number>(b.length + 1).fill(0);
  for (let i = 1; i <= a.length; i++) {
    const current = new Array<number>(b.length + 1).fill(0);
    for (let j = 1; j <= b.length; j++) {
      current[j] = a[i - 1] === b[j - 1] ? previous[j - 1] + 1 : Math.max(previous[j], current[j - 1]);
    }
    previous = current;
  }
  const lcs = previous[b.length];
  return a.length - lcs + (b.length - lcs);
}

/** Top-level entities that changed although the task did not ask for it */
export function collateralChanges(task: EvalTask, source: string, code: string): string[] {
  const report = semanticDiff.compareCode(source, code, task.file);
  return report.changes
    .filter((change) => !task.touch.includes(change.name))
    .map((change) => `${change.changeType} ${change.kind} ${change.name}`);
}

/** The whole grading pipeline for one raw response; shared by run.ts and regrade.ts */
export function gradeResponse(task: EvalTask, format: Format, raw: string, source: string): GradedResponse {
  const outcome =
    format === "sr" ? evaluateSearchReplace(raw, source, task.file) : evaluateWholeFile(raw, source, task.file);
  const code = outcome.patchedCode;
  const failedChecks = code ? checkIntent(task, code) : [];
  return {
    outcome,
    intentPassed: Boolean(code) && failedChecks.length === 0,
    failedChecks,
    collateral: code ? collateralChanges(task, source, code) : [],
    changedLines: code ? changedLineCount(source, code) : null,
  };
}

/** Grading for a run that produced no gradable response (transport or incomplete) */
export function ungraded(outcome: AttemptOutcome): GradedResponse {
  return { outcome, intentPassed: false, failedChecks: [], collateral: [], changedLines: null };
}

/**
 * Error text is stored in committed results: strip anything that looks like a credential
 * (OpenAI echoes a masked key tail on 401, headers may appear in proxy errors).
 */
export function redactSecrets(text: string): string {
  return text
    .replace(/\b(sk|rk|pk)-[A-Za-z0-9_*.-]{4,}/g, "[redacted-key]")
    .replace(/\b(Bearer)\s+[^\s"']+/gi, "$1 [redacted]")
    .replace(/((?:api[_-]?key|x-api-key|authorization)["']?\s*[:=]\s*["']?)[^\s"',}]+/gi, "$1[redacted]");
}
