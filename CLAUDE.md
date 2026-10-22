# CLAUDE.md

Read first: `docs/PROJECT.md` (product, goal, risks) and `docs/decisions/` (ADRs).

## Status

`main` is a VS Code extension prototype (v0.1.0). The target is a Chrome MV3
extension in the deterministic-extensions family; the migration is proposed in
`docs/decisions/0001-chrome-mv3-llm-adapters.md` and NOT yet accepted. Do not
start porting until the ADR is Accepted. PR #1 (`fix/pipeline-sandbox-hardening`)
makes the VS Code version work and is unmerged.

## Stack (current `main`)

- TypeScript 5 (strict), CommonJS output to `dist/`, VS Code API `^1.90`.
- Runtime dependency: `typescript` Compiler API (AST, transpile).
  On `main` it is wrongly listed in devDependencies; PR #1 fixes this.
- Tests: built-in `node:test`, compiled via `tsconfig.test.json` to `dist-tests/`.
- CI: `.github/workflows/release.yml` (Node 20: `npm ci`, typecheck, test, build).

## Commands

```bash
npm ci
npm run typecheck
npm test        # on main: 23/24, contextManager sorts arrays in place
npm run build   # -> dist/extension.js
```

`npm run lint` is broken on `main`: eslint is not installed.
Manual run: open the folder in VS Code and press F5 (Extension Development Host).

## Layout

```
src/extension.ts   VS Code entry, command registration
src/core/          context extraction (AST), state machine, sandbox (node:vm)
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
