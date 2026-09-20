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
│   ├── rules/              # Equivalence-rule registry + 5 built-in rules
│   ├── parsers/            # Input parsers: nested JSON, flat spans, OTel
│   ├── cli/                # CLI entry point + terminal/JSON/HTML output formatters
│   ├── viz/                # Reserved for visualization work (HTML report lives in src/cli/format-html.ts)
│   ├── lambda/             # AWS Lambda handlers (submit-job, get-job, diff-worker…)
│   └── bench/              # Synthetic trace generator + benchmark runner
├── test/                   # Unit + integration tests incl. lambda handlers (bun test)
│   └── setup.ts            # Test preload: conditional AWS-SDK mocks (see Tests)
├── frontend/               # Single-file web app (unified diff tree + KPI bar + detail panel)
├── fixtures/               # Sample traces for tests and local demo
├── docs/                   # Jekyll docs site (performance notes, hash experiment, engineering log)
├── infra/
│   ├── template.yaml       # SAM/CloudFormation — all AWS resources
│   └── deploy.sh           # One-command: bun build → sam build → sam deploy
├── dist/lambda/            # Bundled Lambda handlers (git-ignored, built by bun run build)
├── .vscode/
│   └── settings.json       # Biome format-on-save for the whole team
├── ARCHITECTURE.md         # Visual guide: how the engine works, with diagrams
├── package.json
├── tsconfig.json           # strict, esnext, moduleResolution: bundler (Bun-compatible)
├── bunfig.toml             # Bun test config (coverage enabled + test preload)
├── biome.json              # Lint + format rules (single source of truth)
├── .editorconfig           # Line endings + indent baseline for all editors
├── .gitattributes          # Enforce LF line endings (Biome requires LF)
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
bun test                         # Run all tests (unit + lambda handlers)
bun test test/diff.test.ts       # Run a single file
bun test --coverage              # With coverage report
bun test --watch                 # Re-run on file change
```

Test files live in `test/`; integration tests use fixtures from `fixtures/`.
`test/setup.ts` (wired via `bunfig.toml` preload) registers faithful AWS-SDK
fakes, but only when the real SDK can't be resolved (Bun + pnpm symlinks on
Windows) — healthy platforms test against the real modules.

> Bun auto-loads a repo-root `.env` if present. Keep AWS keys out of git
> (`.env` is git-ignored); note that a deployment `.env` changes which
> branches lambda handlers take under test.

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

### Live Deployed Environment (`dev`)

| Resource | Value |
|---|---|
| **API Gateway Endpoint** | `https://adw2m5fxnj.execute-api.us-east-1.amazonaws.com/dev/` |
| **Region** | `us-east-1` |
| **S3 Upload Bucket** | `tracediff-uploads-140023404870-dev` |
| **DynamoDB Jobs Table** | `tracediff-jobs-dev` |
| **DynamoDB Results Table** | `tracediff-results-dev` |
| **Step Functions ARN** | `arn:aws:states:us-east-1:140023404870:stateMachine:DiffStateMachine-2ryHzalVPc5N` |

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
├── aws       ← Divyansh: src/lambda/, infra/
└── frontend  ← Lavanya:  frontend/, src/viz/, src/bench/generate.ts
```

Merge to `main` at each phase milestone checkpoint.

### Common conflict causes — and how we prevent them

| Cause | Prevention |
|-------|-----------|
| CRLF vs LF line endings | `.gitattributes` forces `eol=lf` (Biome rejects CRLF) |
| Inconsistent quotes / indentation | Biome enforces on save — never reformat manually |
| Both editing `package.json` | One person owns scripts at a time |
| Both editing `src/core/types.ts` | Freeze after Phase 1 — it's the shared contract |
| Stale `pnpm-lock.yaml` | Always run `pnpm install` after pulling |

---

## How It Works

> Visual version with diagrams: [`ARCHITECTURE.md`](ARCHITECTURE.md) — read it before you demo, explain, or change the engine.

### 1. Normalize
Each node passes through the active rules (single fused pass; custom rules fall back to sequential application):

| Rule | What it does |
|------|-------------|
| `ignore-timestamps` | Normalize timestamp fields — numeric and string-encoded (`timestamp_raw`, `db.timestamp_iso`); `time_zone` / `date_of_birth` stay semantic |
| `canonicalize-ids` | Replace UUID/hex ID values with a fixed `__TRACEDIFF_ID__` sentinel |
| `numeric-tolerance` | Bucket numbers within 5% jitter (exact comparison deferred to classify) |
| `sort-concurrent` | Sort children of parallel spans (by label, then id) before hashing |
| `ignore-fields` | Drop user-specified attribute keys (`--ignore-fields`) |

### 2. Build Merkle Tree
Two fingerprints per node — this is what separates "identical" from "same after rules":

```
norm(node) = SHA-256(normalize(content) ‖ norm(child_1) ‖ …)
raw(node)  = SHA-256(raw content       ‖ raw(child_1)  ‖ …)
```

- `norm` differs → **diverges**: a real difference, keep walking
- `norm` matches, `raw` differs → **noise**: something changed, a rule vouched for it — skip with a note
- Both match → **identical**: skip silently

Either way, a hash match skips the whole subtree in O(1).

### 3. Diff Walk
Top-down DFS with an explicit stack (no recursion → no stack overflow at 100K depth):
- Hash match → skip entire subtree (`nodesSkipped`)
- Otherwise → 2-pass children matching (exact hash buckets, then same-label pairing to avoid false add/remove pairs)
- Removed / depth-capped subtrees are reported whole (`nodesBulkReported`, never counted as skips)
- Recurse only into genuinely diverged children

Invariant: `traceASize == nodesVisited + nodesSkipped + nodesBulkReported`.
`skipPercentage` counts only genuine Merkle skips.

### 4. Classify
Each raw diff goes through `rule.classify()` → `semantic | noise | uncertain`.
Multiple changed fields on one node collapse into a single diff with worst-wins significance.

### Complexity

| Operation | Naive | TraceDiff | Speedup (N=1M, D=100) |
|-----------|-------|-----------|----------------------|
| Subtree equality | O(N) | O(1) | 1,000,000× |
| Full diff | O(N²m²) | O(N + D·log N) | ~100,000× |
| Children matching | O(k²) | O(k) | k× |

---

## AWS Architecture

```
Frontend (S3 static hosting + CloudFront)
    │ HTTP
    ▼
API Gateway
 ├── POST /jobs        → Lambda: submit-job → Step Functions
 │                              └─ Map state (10× parallel)
 │                                     └─ Lambda: diff-worker
 │                                            ├─ S3 (read traces)
 │                                            └─ DynamoDB (write results)
 └── GET  /jobs/{id}   → Lambda: get-job → DynamoDB

S3          — trace uploads + static frontend hosting
CloudFront  — CDN in front of the frontend bucket (invalidated on deploy)
DynamoDB    — jobs table + results table
```

### Frontend

`frontend/` is a single-file app (`index.html`, Tailwind CDN + vanilla JS, no build step —
`aws s3 sync` deploys it as-is). One unified diff tree rooted at the common root,
colored per node state (unchanged / noise / added / removed / semantic / uncertain);
unchanged and noise subtrees render collapsed GitHub-diff style. KPI bar leads with
skip %, then semantic/uncertain/noise badges, sizes, and timing; clicking any row
opens the detail panel (description, side-by-side attributes, `classifiedBy` rule tag).

```bash
# Point it at any backend without redeploying
https://<your-cloudfront-host>/?api=https://<api-gateway-host>/dev
```

It includes a 1-click benchmark demo (deterministic ~1K-span checkout pair with
5 injected regressions), trace upload with format auto-detect, rule toggles with
tolerance/ignore-fields inputs, search + group-by + significance filters, and a
live Step Functions pipeline view. Every value comes from the backend or your
files — no mock diff data.

---

## License

MIT
