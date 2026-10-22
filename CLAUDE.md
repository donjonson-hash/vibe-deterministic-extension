# CLAUDE.md

Read first: `docs/PROJECT.md` (product, goal, risks) and `docs/decisions/` (ADRs).

## Status

`main` holds the final VS Code prototype (v0.1.0, PR #1 merged, 40/40 tests).
The product is moving to a Chrome MV3 extension in the deterministic-extensions
family: `docs/decisions/0001-chrome-mv3-llm-adapters.md` (Accepted). MVP scope
and stages: `docs/ROADMAP.md`. Do not invest in the VS Code code path; port pure
modules and their tests. Update this file when the Chrome stack lands.

## Target stack (Chrome MV3, ADR-0003, accepted)

- TypeScript strict, bundled with esbuild 0.28.2 (exact pin).
- Parser: `@babel/parser` 8.0.7 + `typescript` plugin in a module worker.
  Not the `typescript` compiler: 7.x is native-only, 6.0 is the last JS line.
- Diff: own deterministic line diff in the pure core (`line-myers-v1`, explicit
  limits, no time cutoffs), rendered read-only via `textContent`.
- deterministic-extensions core is vendored unchanged (`.mjs` + provenance,
  SHA-256) and typed via a local `.d.ts`. Core and pipeline modules never import
  `chrome.*` or the DOM (they are reused by the MCP server, ADR-0002).

## Stack (current `main`)

- TypeScript 5 (strict), CommonJS output to `dist/`, VS Code API `^1.90`.
- Runtime dependency: `typescript` Compiler API (AST, transpile).
- Tests: built-in `node:test`, compiled via `tsconfig.test.json` to `dist-tests/`.
- CI: `.github/workflows/release.yml` (Node 20: `npm ci`, typecheck, test, build);
  `.github/workflows/codeql.yml` (CodeQL for JS/TS and Actions on PRs to `main`).

## Commands

```bash
npm ci
npm run typecheck
npm test
npm run build   # -> dist/extension.js
```

Patch-format spike (`spike/patch-eval/`, report in `docs/spikes/`):

```bash
npm run spike:build
node --test dist-spike/spike/patch-eval/grade.test.js
node dist-spike/spike/patch-eval/summarize.js spike/patch-eval/results/*.jsonl
node dist-spike/spike/patch-eval/regrade.js   # after grader changes, no model calls
```

Paid runs read keys from a gitignored `.env` (`node --env-file=.env ...`).

There is no linter yet.
Manual run: open the folder in VS Code and press F5 (Extension Development Host).

## Layout

```
src/extension.ts   VS Code entry, command registration
src/core/          context extraction (AST), state machine, sandbox (worker_threads + node:vm)
src/llm/           LLM client, prompt templates, JSON schema validation
src/pipeline/      syntax check, security lint, auto-fix loop
src/ui/            intent parsing, voice normalizer, semantic diff, snapshots
src/utils/         sha256, hash-chain logger
tests/unit/        one test file per subsystem
```

## Conventions

- Code, comments, commits, branch names: English. User-facing strings and docs: Russian.
- Conventional Commits, one branch per task, PR into `main`.
- Bug -> failing regression test first, then the fix.
- Never claim LLM determinism; determinism lives in validation and application.
- Never execute LLM-generated or user code as a "check" in new work
  (family rule, see deterministic-extensions `DETERMINISM.md`).
- API keys: never in code, logs, tests or fixtures.

## Family contract (applies to the Chrome target)

Source of truth: https://github.com/donjonson-hash/deterministic-extensions
(`AGENTS.md`, `DETERMINISM.md`, `docs/CORE-API.md`). In short: pure core without
DOM/network/clock/random/locale; raw documents kept separately from comparison
text; whole-command validation before state change; consumed IDs stay consumed
after Undo; async results are checked against the revision and full context; base
operations work without an LLM; an installed-extension browser check beats a
local-page check.
