# TraceDiff

> Structural diffing of execution traces — find which differences are **bugs** and which are **noise**, in O(N + D·log N) instead of O(N²m²).
---

## What It Does

Given two execution traces (function calls, spans, log lines, state transitions — up to millions of events each), TraceDiff tells you:

- **Semantic diffs** — real behavioral changes: a DB query returning 0 rows, a new span appearing, an HTTP 200 turning into a 500
- **Noise** — timestamp jitter, rotated request IDs, reordered concurrent operations
- **Uncertain** — large numeric changes that might or might not matter

**Core idea:** Merkle-hash each trace tree after normalizing with pluggable equivalence rules. Identical subtrees → identical hashes → skip in O(1). The top-down walk visits only the ~0.1% that actually changed.

```
Trace A (100K events) ──► Merkle build ──┐
                                          ├──► Diff walk ──► 3 semantic diffs (0.3ms)
Trace B (100K events) ──► Merkle build ──┘    98.3% of nodes skipped
```

---

## Tech Stack

| Layer | Tool | Why |
|-------|------|-----|
| Language | TypeScript | Hackathon speed + type safety |
| Runtime (local) | **Bun** | Native TS execution, built-in test runner, fast |
| Package manager | **pnpm** | Fast installs, strict `node_modules`, no phantom deps |
| Linting + Formatting | **Biome** | Single tool replaces ESLint + Prettier, zero config drift |
| Lambda runtime | Node 22.x | AWS-official, stable — Bun bundles handlers before deploy |
| Lambda bundler | `bun build --target=node` | Single JS file per handler, no webpack |
| Infra | SAM + CloudFormation | One template, one deploy command |

---

## Contributor Setup

> **Everyone on the team must follow these steps exactly.** Skipping any step causes lint/format conflicts in PRs.

### 1. Prerequisites

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

### 2. Clone + Install

```bash
git clone <repo-url>
cd trace-diff

# Install all dependencies
pnpm install

# Install git hooks (pre-commit Biome check, pre-push typecheck)
# Use 'bun run' — pnpm 11 blocks scripts from packages with install scripts
bun run hooks:install
```

> **Do not use `npm install` or `yarn`.** The repo uses a pnpm lockfile (`pnpm-lock.yaml`).
> Using npm generates a `package-lock.json` and causes merge conflicts.

> **Use `bun run` not `pnpm run` for all scripts in this repo.**
> pnpm 11 blocks execution when any dependency has an unapproved install script (lefthook does).
> `bun run` has no such restriction and just works.

### 3. Verify Setup

```bash
# Run tests (0 tests, 0 failures on a fresh clone)
bun test

# Run linter (exit 0 = clean)
bun run lint

# Run formatter check
bun run format:check
```

If all three exit with no errors, you're good to go.

---

## Available Scripts

```bash
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

---

## Linting + Formatting (Biome)

We use **[Biome](https://biomejs.dev/)** — one tool that handles both linting and formatting.
It replaces ESLint + Prettier. Every contributor gets the same output automatically.

### Rules enforced

- No `any` — use `unknown` instead
- No unused variables or imports
- No `console.log` in `src/core/` or `src/rules/` (use CLI output layer)
- Double quotes for strings
- 2-space indentation
- Trailing commas in multi-line structures
- Semicolons required

### Fix before committing

```bash
bun run lint:fix && bun run format
```

### VS Code setup

Install the **Biome extension**: search `biomejs.biome` in the Extensions panel.

Add this to your **workspace** `.vscode/settings.json` (already committed in the repo):

```json
{
  "editor.defaultFormatter": "biomejs.biome",
  "editor.formatOnSave": true,
  "editor.codeActionsOnSave": {
    "quickfix.biome": "explicit"
  }
}
```

> **Disable ESLint and Prettier extensions** if you have them — they will conflict with Biome and produce divergent formatting that shows up as noise in diffs.

---

## Project Structure

```
tracediff/
├── src/
│   ├── core/               # Merkle builder, diff engine, matcher, hash, types
│   ├── rules/              # Equivalence rules registry + 5 built-in + Bedrock LLM rule
│   ├── parsers/            # Input parsers: nested JSON, flat spans, OTel
│   ├── cli/                # CLI entry point + terminal/JSON output formatters
│   ├── viz/                # Self-contained HTML visualization template
│   ├── lambda/             # AWS Lambda handlers (submit-job, get-job, diff-worker…)
│   └── bench/              # Synthetic trace generator + benchmark runner
├── test/                   # Unit + integration tests (bun test)
├── fixtures/               # Sample traces for tests and local demo
├── infra/
│   ├── template.yaml       # SAM/CloudFormation — all AWS resources
│   └── deploy.sh           # One-command: bun build → sam build → sam deploy
├── dist/lambda/            # Bundled Lambda handlers (git-ignored, built by bun run build)
├── .vscode/
│   └── settings.json       # Biome format-on-save for the whole team
├── package.json
├── tsconfig.json           # strict, esnext, moduleResolution: bundler (Bun-compatible)
├── bunfig.toml             # Bun test config (coverage enabled)
├── biome.json              # Lint + format rules (single source of truth)
├── .editorconfig           # Line endings + indent baseline for all editors
└── .gitignore
```

---

## Running the CLI

```bash
# Auto-detect format, all default rules
bun run src/cli/main.ts trace_a.json trace_b.json

# With stats + specific rules (short flags: -r, -s)
bun run src/cli/main.ts trace_a.json trace_b.json \
  -r ignore-timestamps,canonicalize-ids,numeric-tolerance \
  -s

# List available equivalence rules
bun run src/cli/main.ts --list-rules

# Show noise diffs + write shareable HTML report
bun run src/cli/main.ts trace_a.json trace_b.json --include-noise --html-out report.html

# JSON output for machine consumption (short flag: -o)
bun run src/cli/main.ts trace_a.json trace_b.json -o json > diff.json

# Disable colors (also respects NO_COLOR=1)
bun run src/cli/main.ts trace_a.json trace_b.json --no-color

# Exit codes: 0 = no semantic diffs  |  1 = semantic diffs found  |  2 = error
```

Full options: `bun run src/cli/main.ts --help`.
Compare flags: `-f/--format tree|flat|otel`, `-r/--rules <list>`, `--no-rules`,
`--ignore-fields <list>`, `--tolerance 5%`, `--max-depth 1000`.
Output flags: `-o/--output terminal|json|html`, `-s/--stats`, `--include-noise`,
`--html-out <path>`, `-q/--quiet`, `--no-color`.

---

## Generating Test Traces

```bash
# 100K nodes, 5 injected semantic diffs
bun run src/bench/generate.ts --size 100000 --diffs 5 --output fixtures/demo/

# 1M nodes for large-scale benchmark
bun run src/bench/generate.ts --size 1000000 --diffs 100 --output fixtures/large/
```

Output per run: `trace_a.json`, `trace_b.json`, `expected_diffs.json` (ground truth).

---

## Tests

```bash
bun test                         # Run all tests
bun test test/merkle.test.ts     # Run a single file
bun test --coverage              # With coverage report
bun test --watch                 # Re-run on file change
```

Test files: `test/`. Integration tests use fixtures from `fixtures/`.

---

## Benchmarks

```bash
bun run bench
bun run bench -- --include-huge --csv /tmp/bench.csv
```

Runs the default matrix `1K/5, 10K/50, 100K/100` (deterministic seeds).
Add `--include-huge` for the opt-in 1M-node cell (needs GBs of RAM).
Outputs a formatted table + `bench-results.csv` (override with `--csv <path>`).

| Nodes | Diffs | Skip % | Diff Time | Total |
|-------|-------|--------|-----------|-------|
| 1K | 5 | ~98% | < 1ms | ~12ms |
| 100K | 100 | ~98.3% | 0.3ms | ~213ms |
| 1M | 100 | ~99.99% | < 1ms | ~12s |

---

## AWS Deployment

> Requires AWS CLI configured + SAM CLI installed.

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

---

## Conflict Prevention Guide

### The rules

1. **`pnpm install` after every pull** — don't assume your `node_modules` is current
2. **Never commit `dist/`** — it's git-ignored, always rebuilt
3. **Never commit `node_modules/`** — same
4. **Run `bun run check` before every push** — catches lint + format before CI does
5. **Coordinate on `infra/template.yaml`** — CloudFormation conflicts are painful to resolve

### Branch ownership (30h hackathon)

```
main          ← stable, always deployable
├── core      ← Maaz:    src/core/, src/rules/, src/parsers/
├── aws       ← Divyansh: src/lambda/, infra/, src/rules/semantic-llm.ts
└── frontend  ← Lavanya:  frontend/, src/viz/, src/bench/generate.ts
```

Merge to `main` at each phase milestone checkpoint.

### Common conflict causes — and how we prevent them

| Cause | Prevention |
|-------|-----------|
| CRLF vs LF line endings | `.editorconfig` enforces `end_of_line = lf` |
| Inconsistent quotes / indentation | Biome enforces on save — never reformat manually |
| Both editing `package.json` | One person owns scripts at a time |
| Both editing `src/core/types.ts` | Freeze after Phase 1 — it's the shared contract |
| Stale `pnpm-lock.yaml` | Always run `pnpm install` after pulling |

---

## How It Works

### 1. Normalize
Each node passes through rules in priority order:

| Rule | What it does |
|------|-------------|
| `ignore-timestamps` | Strip timestamp, start_time, end_time fields |
| `canonicalize-ids` | Replace UUID/hex values with `__ID_N__` |
| `numeric-tolerance` | Bucket numbers within 5% jitter |
| `sort-concurrent` | Sort children of parallel spans by type::label |
| `semantic-llm` | Amazon Bedrock judges free-text log equivalence |

### 2. Build Merkle Tree
```
h(leaf) = SHA-256(normalize(content))
h(node) = SHA-256(normalize(content) ‖ h(child_1) ‖ h(child_2) ‖ …)
```
If `h(A) == h(B)`, the entire subtree is identical — skip in O(1).

### 3. Diff Walk
Top-down DFS with an explicit stack (no recursion → no stack overflow at 100K depth):
- Hash match → skip entire subtree
- Otherwise → 4-phase children matching (hash → signature → position → residuals)
- Recurse only into mismatched children

### 4. Classify
Each raw diff goes through `rule.classify()` → `semantic | noise | uncertain`.

### Complexity

| Operation | Naive | TraceDiff | Speedup (N=1M, D=100) |
|-----------|-------|-----------|----------------------|
| Subtree equality | O(N) | O(1) | 1,000,000× |
| Full diff | O(N²m²) | O(N + D·log N) | ~100,000× |
| Children matching | O(k²) | O(k) | k× |

---

## AWS Architecture

```
Frontend (Amplify Hosting)
    │ HTTP
    ▼
API Gateway
 ├── POST /jobs        → Lambda: submit-job → Step Functions
 │                              └─ Map state (10× parallel)
 │                                     └─ Lambda: diff-worker
 │                                            ├─ S3 (read traces)
 │                                            └─ DynamoDB (write results)
 └── GET  /jobs/{id}   → Lambda: get-job → DynamoDB

S3          — trace uploads + Merkle cache
DynamoDB    — jobs table + results table  
Bedrock     — Claude Haiku for semantic-llm rule
Amplify     — static frontend hosting (auto-deploy from GitHub)
```

---

## License

MIT
