// Deterministic grading of one model response. Nothing here executes model output.
// Gates come from the extension pipeline itself (src/check/proposal.ts), so the spike
// measures exactly what ships.
import { extractFencedBlocks } from "../../src/check/fences";
import { checkProposal } from "../../src/check/proposal";
import { compareCode } from "../../src/check/semanticDiff";

export { extractFencedBlocks };

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

function evaluate(raw: string, format: Format, source: string, fileName: string): AttemptOutcome {
  const check = checkProposal({ answer: raw, format, source, fileName });
  return check.stage === "ok" ? { stage: "ok", patchedCode: check.result } : { stage: check.stage, error: check.error };
}

/** Format A: JSON with search/replace blocks; a patch aimed at another file is rejected */
export function evaluateSearchReplace(raw: string, source: string, fileName: string): AttemptOutcome {
  return evaluate(raw, "sr", source, fileName);
}

/** Format B: the complete updated file inside one fenced code block */
export function evaluateWholeFile(raw: string, source: string, fileName: string): AttemptOutcome {
  return evaluate(raw, "wf", source, fileName);
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
  const report = compareCode(source, code, task.file);
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
