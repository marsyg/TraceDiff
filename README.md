# TraceDiff

Structural diffing of execution traces — find which differences are bugs
and which are noise, in **O(N + D·log N)** instead of O(N²·m²).

```
Trace A (100K events) ──► Merkle build ──┐
                                          ├──► Diff walk ──► 3 semantic diffs (0.3ms)
Trace B (100K events) ──► Merkle build ──┘    98.3% of nodes skipped
```

## What it does

Given two execution traces (function calls, spans, log lines, state
transitions — up to millions of events each), TraceDiff tells you:

- **Semantic diffs** — real behavioral changes: a DB query returning 0 rows,
  a new span appearing, an HTTP 200 turning into a 500
- **Noise** — timestamp jitter, rotated request IDs, reordered concurrent
  operations
- **Uncertain** — large numeric changes that might or might not matter

Core idea: Merkle-hash each trace tree after normalizing with pluggable
equivalence rules. Identical subtrees → identical hashes → skip in O(1).
The top-down walk visits only the ~0.1% that actually changed.

## Use cases

- **CI regression gating** — diff a new deploy's trace against the last
  known-good baseline; block the deploy if anything comes back `semantic`.
- **Canary / shadow comparison** — mirror real traffic to old and new
  versions, diff traces sharing a correlation ID, catch behavioral drift
  before full rollout.
- **Postmortem debugging** — diff a failing run against a passing one for
  the same input; skip the noise, go straight to what actually diverged.

## Quick start

```bash
# Auto-detect format, all default rules
bun run src/cli/main.ts trace_a.json trace_b.json

# With stats + specific rules
bun run src/cli/main.ts trace_a.json trace_b.json \
  -r ignore-timestamps,canonicalize-ids,numeric-tolerance -s

# Shareable HTML report, noise included
bun run src/cli/main.ts trace_a.json trace_b.json --include-noise --html-out report.html

# Machine-readable output
bun run src/cli/main.ts trace_a.json trace_b.json -o json > diff.json
```

Exit codes: `0` = no semantic diffs · `1` = semantic diffs found · `2` = error.
Full options: `bun run src/cli/main.ts --help`.

Generate synthetic test traces:

```bash
bun run src/bench/generate.ts --size 100000 --diffs 5 --output fixtures/demo/
```

## Benchmarks

| Nodes | Diffs | Skip % | Diff time | Total |
|---|---|---|---|---|
| 1K | 5 | ~98% | < 1ms | ~12ms |
| 100K | 100 | ~98.3% | 0.3ms | ~213ms |
| 1M | 100 | ~99.99% | < 1ms | ~12s |

`Total` includes parsing and the Merkle build; the diff walk itself
(`Diff time`) stays sub-millisecond regardless of trace size — that gap
between the two columns at 1M nodes *is* the pitch: divergence-finding
cost is proportional to the size of the diff, not the size of the trace.

Run it yourself: `bun run bench` (add `--include-huge` for the 1M-node cell).

## Architecture

> *"Under the hood, equal fingerprints mean equal subtrees. Diff cost scales with the size of the change, not the size of the trace."*

We construct a **Merkle tree per trace** to prune identical branches immediately in $O(1)$, walking only the true divergences. TraceDiff is fully implemented across **two complementary workflows**: a **local developer CLI** for instant diffs and CI regression gating, and a **live web application deployed on AWS** using Lambda, Step Functions, S3, and DynamoDB to handle massive distributed traces.

### 1. Merkle Pruning Engine (Equal Fingerprints = Equal Subtrees)

- Each trace is normalized by pluggable equivalence rules (suppressing timestamp jitter, UUID rotation, and float drift) and transformed into a Merkle tree.
- Every node carries dual SHA-256 digests (raw byte digest + normalized semantic digest).
- **Equal fingerprints mean equal subtrees**: matching hashes are pruned immediately in $O(1)$ without descending.
- The diff walk only explores true divergences — diff cost scales with the size of the change ($O(D \log N)$), never the size of the trace ($N$).
- Surviving divergences are classified into **Semantic**, **Noise**, or **Uncertain**.

```mermaid
flowchart TD
    subgraph MerkleBuild["1. Merkle Tree Construction"]
        TA["Trace A (Baseline)"] --> MA["Merkle Tree A<br/>• Raw Hash (byte digest)<br/>• Normalized Hash (rule-normalized)"]
        TB["Trace B (Target)"] --> MB["Merkle Tree B<br/>• Raw Hash (byte digest)<br/>• Normalized Hash (rule-normalized)"]
    end

    MA --> CMP{"Equal Fingerprints?<br/>(Hashes match?)"}
    MB --> CMP

    CMP -->|"Yes (Equal subtrees)"| PRUNE["⚡ Prune Branch Immediately (O(1))<br/>Skip identical subtrees without traversal"]
    CMP -->|"No (Divergence)"| WALK["Walk Diverging Subtrees<br/>Cost scales with size of change O(D log N),<br/>NOT size of trace N"]

    WALK --> CLASSIFY["Classify Divergence<br/>• Semantic: Behavioral regression<br/>• Noise: Safe jitter / rotated IDs<br/>• Uncertain: Tolerance threshold exceeded"]
```

### 2. Two Implemented Workflows (Local CLI & AWS Cloud Architecture)

TraceDiff's engine powers two unified production workflows:

```mermaid
flowchart TD
    subgraph CoreEngine["Core Merkle Diff Engine"]
        CORE["Merkle Diff Walk & Normalization Rules<br/>(Prunes identical branches in O(1) · Classifies Semantic / Noise / Uncertain)"]
    end

    subgraph WF1["Workflow 1: Local Developer CLI"]
        DEV["Developer / CI Pipeline"] -->|"bun run src/cli/main.ts"| CLI["Local CLI Engine"]
        CLI --> CORE
        CORE -->|"Instant diff"| TERM["Terminal Output<br/>(Colored diff & KPIs)"]
        CORE -->|"Repro bundle"| REPRO["Standalone Repro Artifacts<br/>(repro.sh cURL & Vitest)"]
        CORE -->|"Shareable report"| HTML["Interactive HTML Report<br/>(--html-out report.html)"]
    end

    subgraph WF2["Workflow 2: Live AWS Cloud Web App (Massive Traces)"]
        USER["Browser Web Visualizer<br/>(marsyg.github.io/TraceDiff)"] -->|"1. Direct S3 presigned upload"| S3[("Amazon S3<br/>(Bypasses API Gateway limits)")]
        USER -->|"2. POST /jobs"| AGW["API Gateway"]
        AGW --> SFN["AWS Step Functions<br/>(Map-State Concurrency)"]
        S3 --> SFN
        SFN --> L1["DiffWorker Lambda 1"]
        SFN --> L2["DiffWorker Lambda 2"]
        SFN --> LN["DiffWorker Lambda ..."]
        L1 & L2 & LN --> CORE
        L1 & L2 & LN -->|"Batch write diffs"| DBR[("DynamoDB Results Table<br/>(Paginated divergences)")]
        SFN --> LAGGR["Aggregate Lambda<br/>+ FinOps Cost Model"]
        LAGGR --> DBJ[("DynamoDB Jobs Table<br/>(Job state & summary)")]
        DBJ & DBR -->|"Paginated diff tree & FinOps"| USER
    end
```

Both diagrams above are deliberately high level — step-by-step walkthroughs,
edge cases, and the full dual-hash derivation are in the in-depth docs below.

**In-depth reference:** [docs/architecture.md](docs/architecture.md)
(dual-hash formulas, 3-tier indexing, complexity tables) or the
[Live Docs Portal](https://marsyg.github.io/TraceDiff/docs/) for the
full visual guide — tree diagrams, edge cases, animated walkthroughs.

## Live deployment (dev)

| Resource | Value |
|---|---|
| API Gateway Endpoint | https://adw2m5fxnj.execute-api.us-east-1.amazonaws.com/dev/ |
| Region | us-east-1 |
| S3 Upload Bucket | `tracediff-uploads-140023404870-dev` |
| DynamoDB Jobs Table | `tracediff-jobs-dev` |
| DynamoDB Results Table | `tracediff-results-dev` |
| Step Functions ARN | `arn:aws:states:us-east-1:140023404870:stateMachine:DiffStateMachine-2ryHzalVPc5N` |



## Contributing

Setup, scripts, lint/format rules, project structure, and branch ownership
→ **[CONTRIBUTING.md](CONTRIBUTING.md)**.

## License

MIT
