# Contributing to TraceDiff

Everyone on the team must follow these steps exactly. Skipping any step
causes lint/format conflicts in PRs.

## 1. Prerequisites

Install these globally once:

```bash
# Install Bun (Windows — run in PowerShell)
powershell -c "irm bun.sh/install.ps1 | iex"

# Install pnpm
npm install -g pnpm

# Verify
bun --version    # should be 1.x
pnpm --version   # should be 9.x or 11.x
```

## 2. Clone + install

```bash
git clone <repo-url>
cd trace-diff

# Install all dependencies
pnpm install

# Install git hooks (pre-commit Biome check, pre-push typecheck)
# Use 'bun run' — pnpm 11 blocks scripts from packages with install scripts
bun run hooks:install
```

**Do not use `npm install` or `yarn`.** The repo uses a pnpm lockfile
(`pnpm-lock.yaml`). Using npm generates a `package-lock.json` and causes
merge conflicts.

**Use `bun run` not `pnpm run` for all scripts in this repo.** pnpm 11
blocks execution when any dependency has an unapproved install script
(lefthook does). `bun run` has no such restriction and just works.

## 3. Verify setup

```bash
# Run tests (0 tests, 0 failures on a fresh clone)
bun test

# Run linter (exit 0 = clean)
bun run lint

# Run formatter check
bun run format:check
```

If all three exit with no errors, you're good to go.

## Available scripts

```
bun run dev              # Run CLI directly
bun test                 # Run test suite
bun run bench            # Run benchmark matrix
bun run build            # Bundle Lambda handlers → dist/lambda/
bun run lint             # Biome lint check (no auto-fix)
bun run lint:fix         # Biome lint + auto-fix
bun run format           # Biome format + auto-fix
bun run format:check     # Biome format check only (no changes)
bun run check            # Biome lint + format together (run before pushing)
bun run typecheck        # tsc --noEmit
bun run hooks:install    # Install git pre-commit/pre-push hooks (once per clone)
```

## Linting + formatting (Biome)

We use Biome — one tool that handles both linting and formatting. It
replaces ESLint + Prettier. Every contributor gets the same output
automatically.

**Rules enforced:**
- No `any` — use `unknown` instead
- No unused variables or imports
- No `console.log` in `src/core/` or `src/rules/` (use the CLI output layer)
- Double quotes for strings
- 2-space indentation
- Trailing commas in multi-line structures
- Semicolons required

**Fix before committing:**

```bash
bun run lint:fix && bun run format
```

**VS Code setup:** install the Biome extension (search `biomejs.biome` in
the Extensions panel). `.vscode/settings.json` is already committed with:

```json
{
  "editor.defaultFormatter": "biomejs.biome",
  "editor.formatOnSave": true,
  "editor.codeActionsOnSave": {
    "quickfix.biome": "explicit"
  }
}
```

Disable ESLint and Prettier extensions if you have them — they will
conflict with Biome and produce divergent formatting that shows up as
noise in diffs.

## Project structure

```
tracediff/
├── src/
│   ├── core/               # Merkle builder, diff engine, matcher, hash, types
│   ├── rules/               # Equivalence-rule registry + 5 built-in rules
│   ├── parsers/              # Input parsers: nested JSON, flat spans, OTel
│   ├── cli/                  # CLI entry point + terminal/JSON/HTML output formatters
│   ├── viz/                  # Reserved for visualization work (HTML report lives in src/cli/format-html.ts)
│   ├── lambda/                # AWS Lambda handlers (submit-job, get-job, diff-worker…)
│   └── bench/                  # Synthetic trace generator + benchmark runner
├── test/                   # Unit + integration tests incl. lambda handlers (bun test)
│   └── setup.ts            # Test preload: conditional AWS-SDK mocks (see Tests)
├── frontend/               # Single-file web app (unified diff tree + KPI bar + detail panel)
├── fixtures/               # Sample traces for tests and local demo
├── docs/                   # Jekyll docs portal & Architecture Guide (docs/architecture.md)
├── infra/
│   ├── template.yaml       # SAM/CloudFormation — all AWS resources
│   └── deploy.sh           # One-command: bun build → sam build → sam deploy
├── dist/lambda/            # Bundled Lambda handlers (git-ignored, built by bun run build)
├── .vscode/
│   └── settings.json       # Biome format-on-save for the whole team
├── package.json
├── tsconfig.json           # strict, esnext, moduleResolution: bundler (Bun-compatible)
├── bunfig.toml             # Bun test config (coverage enabled + test preload)
├── biome.json              # Lint + format rules (single source of truth)
├── .editorconfig           # Line endings + indent baseline for all editors
├── .gitattributes          # Enforce LF line endings (Biome requires LF)
└── .gitignore
```

## Tests

```bash
bun test                         # Run all tests (unit + lambda handlers)
bun test test/diff.test.ts       # Run a single file
bun test --coverage              # With coverage report
bun test --watch                 # Re-run on file change
```

Test files live in `test/`; integration tests use fixtures from
`fixtures/`. `test/setup.ts` (wired via `bunfig.toml` preload) registers
faithful AWS-SDK fakes, but only when the real SDK can't be resolved
(Bun + pnpm symlinks on Windows) — healthy platforms test against the
real modules.

Bun auto-loads a repo-root `.env` if present. Keep AWS keys out of git
(`.env` is git-ignored); note that a deployment `.env` changes which
branches lambda handlers take under test.

## AWS deployment

Requires AWS CLI configured + SAM CLI installed.

```bash
# Full deploy (build + deploy)
bash infra/deploy.sh

# Build Lambda handlers only
bun run build
```

The deploy script:
1. `bun build … --target=node --outdir=dist/lambda` — bundle all handlers to plain JS
2. `sam build` — package using the pre-built JS (no tsc, no webpack)
3. `sam deploy --guided` — interactive on first run; uses `samconfig.toml` after

## Conflict prevention guide

**The rules:**
- `pnpm install` after every pull — don't assume your `node_modules` is current
- Never commit `dist/` — it's git-ignored, always rebuilt
- Never commit `node_modules/` — same
- Run `bun run check` before every push — catches lint + format before CI does
- Coordinate on `infra/template.yaml` — CloudFormation conflicts are painful to resolve

**Branch ownership (30h hackathon):**

```
main          ← stable, always deployable
├── core      ← Maaz:      src/core/, src/rules/, src/parsers/
├── aws       ← Divyansh:  src/lambda/, infra/
└── frontend  ← Lavanya:   frontend/, src/viz/, src/bench/generate.ts
```

Merge to `main` at each phase milestone checkpoint.

**Common conflict causes — and how we prevent them:**

| Cause | Prevention |
|---|---|
| CRLF vs LF line endings | `.gitattributes` forces `eol=lf` (Biome rejects CRLF) |
| Inconsistent quotes / indentation | Biome enforces on save — never reformat manually |
| Both editing `package.json` | One person owns scripts at a time |
| Both editing `src/core/types.ts` | Freeze after Phase 1 — it's the shared contract |
| Stale `pnpm-lock.yaml` | Always run `pnpm install` after pulling |