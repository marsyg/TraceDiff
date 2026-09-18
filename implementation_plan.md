# TraceDiff — Hackathon Implementation Plan
### WeMakeDevs "First Commit" · Bharat Builds Tour · Sept 17–20, 2026

> **Team:** Lavanya Varshney · Divyansh Gupta · Maaz Ahmad  
> **Track:** Ship It (AWS deployed, live URL)  
> **Effective Time Budget:** ~30 hours remaining from now (Sept 18, 05:28 IST)  
> **Submission Deadline:** Sept 20, 2026

---

## Toolchain Decision

| Concern | Tool | Rationale |
|---------|------|----------|
| **Local runtime** | **Bun** | Runs TypeScript natively — no `tsx` transpile step, visibly faster CLI startup in demo video |
| **Test runner** | **`bun test`** | Built into Bun, zero config, Jest-compatible API |
| **Package manager** | **pnpm** | Faster installs, strict `node_modules`, no downside over npm |
| **Lambda runtime** | **Node 22.x** | AWS-official, battle-tested — no risky community Bun layer during hackathon |
| **Lambda build** | **`bun build --target=node`** | Bundles handlers into single JS files; no `tsc` or webpack needed |
| **CLI binary** | **`bun run src/cli/main.ts`** | Direct TS execution, fast cold start |

> [!WARNING]
> Do **not** use the community Bun Lambda runtime layer. If it breaks at 2am you lose hours. Bundle to Node-compatible JS with `bun build --target=node --outdir=dist/lambda` and deploy to Node 22. Bun is purely a local DX + build tool.

---

## 0. What We're Building

Structural diffing of execution traces (function calls, spans, log lines, state transitions — hundreds of thousands to millions of events). Given **Trace A** (baseline) and **Trace B** (canary/failing), find:

- Which differences are **semantic** (real behavioral change — bugs, regressions)
- Which are **noise** (timestamp jitter, rotated request IDs, reordered concurrent ops)

**Core insight:** Merkle-hash each trace tree after normalizing with pluggable rules. Identical subtrees → identical hashes → skip in O(1). Top-down walk visits only the ~0.1% that differs. O(N + D·log N) vs O(N²m²) for naive tree-edit-distance.

**No standalone library does this today.** We're building it.

---

## 1. Judging Alignment Map

| Criterion | Our Answer |
|-----------|-----------|
| **Idea & Impact** | Generic primitive for CI regression gating, chaos engineering comparison, replay debugging (rr, Replay.io). Real gap: Jaeger/Tempo visualize one trace, nobody diffs two at scale. |
| **Built on AWS** | S3 (trace storage) + Lambda (diff engine) + Step Functions Map (parallel chunked diff) + DynamoDB (job results) + API Gateway (REST) + Amplify (frontend) + Bedrock (LLM equivalence rule) |
| **Learning** | Step Functions Map-state orchestration + Bedrock-as-equivalence-rule are genuine new services for the team |
| **Execution** | Phase 1–3 solid before touching Phase 4. One working feature > five half-done. |
| **Demo Video** | Script: "1M events, sub-second localization." Show the Merkle skip % live. |

---

## 2. Architecture Overview

```
┌──────────────────────────────────────────────────────────────┐
│                    FRONTEND (Amplify Hosting)                 │
│  Upload traces → Poll job status → Render diff tree          │
│  Green=match, Red=semantic, Yellow=noise, Gray=uncertain      │
└─────────────────────────┬────────────────────────────────────┘
                          │ REST (API Gateway)
                          ▼
┌─────────────────────────────────────────────────────────────┐
│                    API Gateway (REST)                        │
│  POST /jobs  ·  GET /jobs/{id}  ·  GET /jobs/{id}/results   │
└──────┬──────────────────────────────────────┬───────────────┘
       │                                      │
       ▼                                      ▼
┌─────────────┐                    ┌──────────────────────────┐
│   Lambda    │                    │     DynamoDB             │
│  (submit)   │──► Step Functions ─│  jobs table              │
│  · validate │    (orchestrate)   │  results table           │
│  · create   │         │          └──────────────────────────┘
│    job      │         ▼
└─────────────┘  ┌──────────────────────────────────────────┐
                 │  Step Functions — Map State               │
                 │  Split trace into subtree chunks          │
                 │  Invoke Lambda[diff-worker] in parallel   │
                 │  Aggregate results                        │
                 └─────────────┬────────────────────────────┘
                               │
                               ▼
                    ┌──────────────────────┐
                    │  Lambda [diff-worker] │
                    │  · Load chunks from S3│
                    │  · Build Merkle tree  │
                    │  · Run diff engine    │
                    │  · Apply equiv rules  │
                    │    (incl. Bedrock LLM)│
                    │  · Write to DynamoDB  │
                    └──────────────────────┘
                               ▲
                    ┌──────────┴──────────┐
                    │        S3           │
                    │  trace-uploads/     │
                    │  merkle-cache/      │
                    └─────────────────────┘
```

---

## 3. Repository Structure

```
tracediff/
├── src/
│   ├── core/
│   │   ├── types.ts            # All type definitions (TraceNode, MerkleNode, DiffResult…)
│   │   ├── merkle.ts           # Iterative post-order Merkle builder
│   │   ├── diff.ts             # Top-down diff engine (iterative DFS)
│   │   ├── match.ts            # 4-phase children matcher
│   │   └── hash.ts             # Hash abstraction + canonical serializer
│   ├── rules/
│   │   ├── types.ts            # EquivalenceRule interface
│   │   ├── registry.ts         # registerRule(), createRules(), listRules()
│   │   ├── ignore-timestamps.ts
│   │   ├── canonicalize-ids.ts
│   │   ├── numeric-tolerance.ts
│   │   ├── sort-concurrent.ts
│   │   ├── ignore-fields.ts
│   │   └── semantic-llm.ts     # Bedrock-backed LLM rule (Phase 4)
│   ├── parsers/
│   │   ├── json-tree.ts        # Nested JSON with children arrays
│   │   ├── json-flat.ts        # Flat spans {id, parentId} → tree
│   │   └── otel.ts             # OpenTelemetry JSON export
│   ├── cli/
│   │   ├── main.ts             # Entry point + arg parsing (zero deps)
│   │   ├── output-terminal.ts  # ANSI colored output
│   │   └── output-json.ts      # Machine-readable JSON
│   ├── viz/
│   │   └── template.html       # Self-contained interactive HTML viz
│   ├── lambda/
│   │   ├── submit-job.ts       # Lambda: POST /jobs handler
│   │   ├── get-job.ts          # Lambda: GET /jobs/{id} handler
│   │   └── diff-worker.ts      # Lambda: Step Functions Map worker
│   ├── bench/
│   │   ├── generate.ts         # Synthetic trace generator (test oracle)
│   │   └── run.ts              # Benchmark runner + matrix output
│   └── index.ts                # npm library entry point
├── infra/
│   ├── template.yaml           # SAM/CloudFormation template
│   └── deploy.sh               # One-command deploy script
├── test/
│   ├── hash.test.ts
│   ├── merkle.test.ts
│   ├── match.test.ts
│   ├── rules.test.ts
│   ├── diff.test.ts
│   └── integration.test.ts
├── fixtures/
│   ├── small-identical/
│   ├── small-diff/
│   ├── medium-concurrent/
│   └── otel-sample/
├── package.json                # type:module, pnpm workspaces, aws-sdk (only runtime dep)
├── tsconfig.json               # strict, ES2022, Bundler (Bun-compatible)
├── bunfig.toml                 # Bun config: test paths, preload
└── README.md
```

---

## 4. Core Type Definitions

```typescript
// src/core/types.ts — exact spec

interface TraceNode {
  id: string;
  type: string;             // "span" | "call" | "log" | "state_change"
  label: string;
  attributes: Record<string, unknown>;
  children: TraceNode[];
  depth: number;
  subtreeSize: number;
  raw?: unknown;
}

interface MerkleNode {
  hash: string;             // H(normalize(content) || childHashes)
  trace: TraceNode;
  children: MerkleNode[];
  subtreeSize: number;
}

type DiffType = "added" | "removed" | "modified" | "moved" | "reordered";
type Significance = "semantic" | "noise" | "uncertain";

interface DiffResult {
  type: DiffType;
  pathA?: string[];
  pathB?: string[];
  nodeA?: TraceNode;
  nodeB?: TraceNode;
  significance: Significance;
  classifiedBy?: string;       // rule name that classified it
  description: string;
  depth: number;
  affectedSubtreeSize: number;
}

interface DiffSummary {
  traceASize: number;
  traceBSize: number;
  nodesVisited: number;
  nodesSkipped: number;
  skipPercentage: number;
  diffs: DiffResult[];
  semantic: DiffResult[];
  noise: DiffResult[];
  uncertain: DiffResult[];
  timing: {
    parseMs: number;
    treeBuildMs: number;
    merkleBuildMs: number;
    diffMs: number;
    totalMs: number;
  };
}

interface EquivalenceRule {
  name: string;
  description: string;
  priority: number;            // lower = applied first
  normalize(node: TraceNode): TraceNode;
  shouldSortChildren?(node: TraceNode): boolean;
  childSortKey?(child: TraceNode): string;
  classify?(nodeA: TraceNode, nodeB: TraceNode): Significance | null;
}

interface TraceDiffConfig {
  rules: string[];
  ruleConfig: Record<string, Record<string, unknown>>;
  maxDepth: number;            // default: 1000
  maxChildrenForFullMatch: number;  // default: 10000
  hashAlgorithm: "sha256" | "xxhash64";
  outputFormat: "terminal" | "json" | "html";
  includeNoise: boolean;
}
```

---

## 5. Phased Build Plan

> **Color legend:** 🔴 Critical path · 🟡 Important · 🟢 Differentiator · ⚪ Stretch

---

### Phase 0 — Project Bootstrap
**Duration:** 30 min · **Owner:** Any · **Deadline:** Sept 18, 07:00 IST

**Goal:** Runnable skeleton, everyone can start in parallel.

**Tasks:**
- [ ] Init with pnpm + Bun:
  ```bash
  pnpm init
  # Add Bun types and TypeScript; NO tsx, NO vitest
  pnpm add -D typescript @types/node bun-types
  ```
- [ ] `tsconfig.json`:
  ```json
  { "compilerOptions": { "strict": true, "module": "Bundler",
    "moduleResolution": "Bundler", "target": "ES2022",
    "types": ["bun-types"] } }
  ```
  > `module: "Bundler"` is correct for Bun — do NOT use `NodeNext` (causes `.js` extension errors with Bun's resolver)
- [ ] `bunfig.toml`:
  ```toml
  [test]
  preload = []
  coverage = true
  ```
- [ ] `package.json` scripts:
  ```json
  {
    "scripts": {
      "dev":   "bun run src/cli/main.ts",
      "test":  "bun test",
      "bench": "bun run src/bench/run.ts",
      "build": "bun build src/lambda/submit-job.ts src/lambda/get-job.ts src/lambda/diff-worker.ts --target=node --outdir=dist/lambda"
    }
  }
  ```
- [ ] Runtime deps: **zero** (AWS SDK v3 only in Lambda handlers — pnpm add it inside `src/lambda/` or as optional dep)
- [ ] Create directory skeleton (all dirs, empty `.gitkeep`)
- [ ] `fixtures/` — place 2 hand-crafted small JSON traces (10 nodes each)
- [ ] Smoke test: `bun run src/core/types.ts` — should print nothing and exit 0

**Output:** `pnpm test` (alias for `bun test`) runs (0 tests, 0 failures), `pnpm build` produces `dist/lambda/*.js`.

---

### Phase 1 — Core Engine (Local, No AWS) 🔴
**Duration:** 6 hours · **Owner:** Maaz + Divyansh · **Deadline:** Sept 18, 14:00 IST

This is the heart of the project. Everything else depends on it.

#### 1A — Hash Utility + Canonical Serializer (45 min)

**File:** `src/core/hash.ts`

```typescript
// Critical: JSON.stringify is NOT deterministic (key insertion order).
// Must sort object keys recursively.
function canonicalSerialize(obj: unknown): string {
  if (obj === null || typeof obj !== "object") return JSON.stringify(obj);
  if (Array.isArray(obj)) return "[" + obj.map(canonicalSerialize).join(",") + "]";
  const keys = Object.keys(obj as object).sort();
  return "{" + keys.map(k =>
    JSON.stringify(k) + ":" + canonicalSerialize((obj as Record<string,unknown>)[k])
  ).join(",") + "}";
}

export function computeHash(input: string): string {
  // Bun exposes Node's 'crypto' module natively — no polyfill needed
  return createHash("sha256").update(input).digest("hex");
}
```

**Tests (`hash.test.ts`):**
- `{b:1,a:2}` and `{a:2,b:1}` → same hash ✓
- Different content → different hash ✓
- Same input twice → same hash (deterministic) ✓

#### 1B — Equivalence Rules (1.5 hours)

**File:** `src/rules/types.ts` + `src/rules/registry.ts` + 5 rule files

| Rule | `normalize()` | `classify()` |
|------|--------------|-------------|
| `ignore-timestamps` | Strip `timestamp/time/ts/start_time/end_time/date` fields | Both differ only in these fields → `"noise"` |
| `canonicalize-ids` | Replace UUID/hex-token patterns with `__ID_N__` (counter-stable) | Differ only in IDs → `"noise"` |
| `numeric-tolerance` | Round to N significant figures (default 5%) | Within tolerance → `"noise"`, >100× diff → `"semantic"`, else `"uncertain"` |
| `sort-concurrent` | Sort children of `type==="parallel"` spans by `type::label` | — |
| `ignore-fields` | Strip user-specified attribute keys (glob support via `minimatch`-free impl) | — |

**Registry:**
```typescript
export function createRules(names: string[], config: RuleConfig): EquivalenceRule[] {
  return names
    .map(n => BUILTIN_RULES[n]?.(config[n] ?? {}))
    .filter(Boolean)
    .sort((a, b) => a.priority - b.priority);
}
```

**Tests (`rules.test.ts`):**
- Each rule: normalize idempotent (`N(N(x)) === N(x)`) ✓
- `ignore-timestamps`: strip fields → same hash ✓
- `canonicalize-ids`: two nodes with different UUIDs → same hash ✓
- `numeric-tolerance`: 45 vs 47 → noise, 45 vs 4500 → semantic ✓

#### 1C — Merkle Tree Builder (1.5 hours)

**File:** `src/core/merkle.ts`

**Algorithm:** Iterative post-order traversal (stack-based — handles depth 100K without stack overflow).

```
function buildMerkleTree(root, rules, config):
  resultMap = Map<TraceNode, MerkleNode>
  stack = [{ node: root, phase: "push_children" }]

  while stack not empty:
    { node, phase } = stack.peek()
    
    if phase === "push_children":
      top.phase = "compute_hash"
      push children (reverse order) with phase "push_children"
    else: // phase === "compute_hash"
      stack.pop()
      merkleChildren = node.children.map(c => resultMap.get(c))
      
      normalized = applyRulesInPriority(node, rules)
      if shouldSort: sort merkleChildren by sortKey
      
      hashInput = canonicalSerialize({
        type: normalized.type,
        label: normalized.label,
        attributes: normalized.attributes
      }) + "||" + merkleChildren.map(c => c.hash).join("|")
      
      resultMap.set(node, {
        hash: computeHash(hashInput),
        trace: node,
        children: merkleChildren,
        subtreeSize: 1 + sum(merkleChildren.map(c => c.subtreeSize))
      })

  return resultMap.get(root)
```

**Tests (`merkle.test.ts`):**
- Identical trees → same root hash ✓
- Change one leaf → root hash changes, sibling hashes unchanged ✓
- Deep tree (depth 10K) → no stack overflow ✓
- After `ignore-timestamps`: two trees differing only in timestamps → same root hash ✓

#### 1D — Diff Engine + Children Matcher (2 hours)

**File:** `src/core/diff.ts` + `src/core/match.ts`

**Diff Engine** — Iterative top-down DFS:

```
function diffTrees(merkleA, merkleB, rules, config) → DiffSummary:
  stack = [{ a: merkleA, b: merkleB, pathA: [root.label], pathB: [root.label], depth: 0 }]
  diffs = []
  nodesVisited = 0; nodesSkipped = 0

  while stack not empty:
    { a, b, pathA, pathB, depth } = stack.pop()
    nodesVisited++

    if a.hash === b.hash:               // FAST PATH
      nodesSkipped += a.subtreeSize
      continue

    if depth > config.maxDepth:         // DEPTH GUARD
      diffs.push({ type: "modified", significance: "uncertain",
                   description: "Subtree differs (depth limit)" })
      continue

    if a.children.length === 0 && b.children.length === 0:  // LEAF
      diffs.push(buildLeafDiff(a, b, pathA, pathB, depth))
      continue

    { matched, removed, added } = matchChildren(a, b, config)

    for [childA, childB] of matched:
      stack.push({ a: childA, b: childB,
                   pathA: [...pathA, childA.trace.label],
                   pathB: [...pathB, childB.trace.label],
                   depth: depth + 1 })

    for child of removed: diffs.push({ type: "removed", ... })
    for child of added:   diffs.push({ type: "added",   ... })

  // POST-CLASSIFY all diffs via rules
  for diff of diffs:
    for rule of rules:
      if rule.classify && diff.nodeA && diff.nodeB:
        sig = rule.classify(diff.nodeA.trace, diff.nodeB.trace)
        if sig: diff.significance = sig; diff.classifiedBy = rule.name; break

  return buildSummary(diffs, nodesVisited, nodesSkipped, ...)
```

**4-Phase Children Matcher:**

```
function matchChildren(a, b, config):
  // Phase 1: Exact hash match — O(k) via Map
  bByHash = new Map(b.children.map((c,i) => [c.hash, i]))
  
  // Phase 2: Signature match — type::label for remaining
  bBySig = new Map(unmatched b.children, c => `${c.trace.type}::${c.trace.label}`)
  
  // Phase 3: Positional fallback — pair i-th with i-th
  
  // Phase 4: Residuals → removed/added
```

**Tests (`diff.test.ts`):**
- Identical trees → 0 diffs, 100% skip ✓
- Add one node to B → exactly 1 "added" diff ✓  
- Remove one node from A → exactly 1 "removed" diff ✓
- Modify one attribute → exactly 1 "modified" diff ✓
- Depth limit at 5 → uncertain diff at boundary ✓
- Timestamps only → noise diffs, 0 semantic ✓

**Output:** `bun test` passes all unit tests. `bun run src/cli/main.ts fixtures/small-diff/a.json fixtures/small-diff/b.json` produces colored terminal output.

---

### Phase 2 — Parsers + Synthetic Generator 🔴
**Duration:** 3 hours · **Owner:** Lavanya · **Deadline:** Sept 18, 17:00 IST

#### 2A — Three Parsers with Auto-Detection (1.5 hours)

**File:** `src/parsers/`

| Parser | Detection | Input |
|--------|-----------|-------|
| `json-tree.ts` | `"children" in root` | Nested JSON |
| `json-flat.ts` | `Array.isArray(input)` | `{id, parentId, type, label, attributes}[]` |
| `otel.ts` | `"resourceSpans" in root` | OTel Collector JSON export |

**OTel Parser** builds tree from `resourceSpans[*].scopeSpans[*].spans[*]` using `parentSpanId` linking. Creates synthetic root `"trace"` node.

**Auto-detect:**
```typescript
export function autoDetect(raw: unknown): TraceNode {
  if (Array.isArray(raw)) return parseFlatSpans(raw);
  if (raw && typeof raw === "object") {
    if ("resourceSpans" in raw) return parseOtel(raw);
    if ("children" in raw) return parseJsonTree(raw);
  }
  throw new Error("Unknown trace format");
}
```

#### 2B — Synthetic Trace Generator (1.5 hours)

**File:** `src/bench/generate.ts` — this is the test oracle.

```bash
bun run src/bench/generate.ts --size 100000 --diffs 5 --output fixtures/demo/
```

**Output:** `trace_a.json`, `trace_b.json`, `expected_diffs.json`

**Algorithm:**
1. Generate random tree: configurable `--size`, `--depth`, `--branching`
2. Deep-clone → Trace B
3. **Inject noise** (never appear in `expected_diffs.json`):
   - Rotate all UUID/hex attribute values
   - Shift all timestamps by random delta
   - Add ±jitter to numeric attributes within tolerance
   - Reorder children of nodes marked `type=concurrent`
4. **Inject semantic diffs** (recorded in `expected_diffs.json`):
   - Modify attribute values beyond tolerance
   - Add new span subtrees
   - Remove existing span subtrees

**Integration test:** Feed generated traces through the engine, assert all expected diffs found and zero false positives.

---

### Phase 3 — CLI + Terminal Output 🔴
**Duration:** 1.5 hours · **Owner:** Maaz · **Deadline:** Sept 18, 19:00 IST

**File:** `src/cli/main.ts`

**Zero-dependency arg parser** (no `commander`, no `yargs`):

```
tracediff <file_a> <file_b> [options]

  --format  tree|flat|otel    Input format (default: auto)
  --output  terminal|json|html
  --rules   <list>            Comma-separated rule names
  --no-rules                  Raw structural diff
  --ignore-fields <list>      Attribute keys to ignore
  --tolerance <pct>           Numeric tolerance (default: 5%)
  --max-depth <n>             (default: 1000)
  --stats                     Print timing breakdown
  --html-out <path>           Write HTML visualization to file
  -q, --quiet                 Exit code only

Exit: 0 = no semantic diffs, 1 = semantic diffs, 2 = error
```

**Terminal Output** (ANSI, no chalk):

```
tracediff v0.1.0

Trace A: baseline.json (14,523 nodes)
Trace B: canary.json   (14,527 nodes)
Rules:   ignore-timestamps, canonicalize-ids, numeric-tolerance(5%), sort-concurrent

━━━ Diff Results ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

 SEMANTIC  3 differences found

  1. MODIFIED  root > api-gateway > user-service > db-query
     - attributes.db.rows_returned: 42 → 0

  2. ADDED     root > api-gateway > user-service > cache-miss-fallback
     + New span: cache-miss-fallback (3 children, 12 total nodes)

  3. MODIFIED  root > api-gateway > response
     - attributes.http.status_code: 200 → 500

 UNCERTAIN  1 difference

  4. MODIFIED  root > api-gateway > auth-middleware
     ~ attributes.token_validation_ms: 12 → 89 (641% change)

━━━ Statistics ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

  Nodes compared:    247 of 14,527 (1.7%)
  Nodes skipped:     14,280 (98.3%) via Merkle match
  Parse time:        124 ms
  Merkle build:      89 ms
  Diff time:         0.3 ms
  Total:             213 ms
```

**At end of Phase 3, core MVP is feature-complete locally.** Pause and do a sanity demo with the 100K generated trace.

---

### Phase 4 — AWS Infrastructure 🔴
**Duration:** 4 hours · **Owner:** Divyansh · **Deadline:** Sept 18, 23:00 IST

> [!IMPORTANT]
> AWS credits must be applied before this phase. One form per team, filled by team leader.

#### 4A — S3 + DynamoDB Setup (30 min)

**S3 Bucket:** `tracediff-uploads-{accountId}`
- Two prefixes: `traces/` (raw uploads) and `merkle-cache/` (serialized Merkle trees)
- CORS configured for Amplify domain
- Max object size: 500 MB

**DynamoDB Tables:**

| Table | PK | SK | Attributes |
|-------|----|----|-----------|
| `tracediff-jobs` | `jobId` | — | `status`, `traceAKey`, `traceBKey`, `rules`, `createdAt`, `ttl` |
| `tracediff-results` | `jobId` | `diffIndex` | `type`, `significance`, `pathA`, `pathB`, `description`, `classifiedBy` |

#### 4B — Lambda Functions (1.5 hours)

**`submit-job` Lambda** (`POST /jobs`):
```
Input:  { traceAKey, traceBKey, rules, config }
Action: Create DynamoDB job record (status=PENDING)
        Start Step Functions execution
Output: { jobId, status }
```

**`get-job` Lambda** (`GET /jobs/{id}`):
```
Input:  jobId path param
Action: Read DynamoDB job + paginate results
Output: { jobId, status, summary, diffs[] }
```

**`diff-worker` Lambda** (Step Functions Map task):
```
Input:  { jobId, traceAKey, traceBKey, rules, chunkIndex, totalChunks }
Action: Download traces from S3
        Build Merkle tree (or load from merkle-cache/)
        Run diff engine on subtree chunk
        Write results to DynamoDB (batch write)
        Update job status
Output: { chunkIndex, diffsFound, nodesVisited }
```

**Lambda config:**
- Runtime: `nodejs22.x` ← Node 22, **not** Bun runtime (stability during hackathon)
- Memory: 3008 MB (diff-worker), 512 MB (others)
- Timeout: 15 min (diff-worker), 30 s (others)
- Layer: None — handlers bundled to single JS files via `bun build --target=node`
- Build step before SAM deploy:
  ```bash
  bun build src/lambda/submit-job.ts src/lambda/get-job.ts \
            src/lambda/diff-worker.ts src/lambda/aggregate.ts \
            src/lambda/update-status.ts src/lambda/presign.ts \
            --target=node --outdir=dist/lambda
  ```

#### 4C — Step Functions State Machine (1.5 hours)

```json
{
  "StartAt": "LoadTraces",
  "States": {
    "LoadTraces": {
      "Type": "Task",
      "Resource": "arn:aws:lambda:::function:tracediff-load-traces",
      "Next": "MapDiff"
    },
    "MapDiff": {
      "Type": "Map",
      "ItemsPath": "$.chunks",
      "MaxConcurrency": 10,
      "Iterator": {
        "StartAt": "DiffChunk",
        "States": {
          "DiffChunk": {
            "Type": "Task",
            "Resource": "arn:aws:lambda:::function:tracediff-diff-worker",
            "End": true
          }
        }
      },
      "Next": "AggregateResults"
    },
    "AggregateResults": {
      "Type": "Task",
      "Resource": "arn:aws:lambda:::function:tracediff-aggregate",
      "Next": "UpdateJobStatus"
    },
    "UpdateJobStatus": {
      "Type": "Task",
      "Resource": "arn:aws:lambda:::function:tracediff-update-status",
      "End": true
    }
  }
}
```

**Map concurrency = 10** (respects Lambda concurrency limits on free tier/credits).

#### 4D — API Gateway (30 min)

| Method | Path | Lambda |
|--------|------|--------|
| `POST` | `/jobs` | `submit-job` |
| `GET` | `/jobs/{id}` | `get-job` |
| `GET` | `/jobs/{id}/results` | `get-job` (paginated) |
| `GET` | `/presign` | `presign` (S3 presigned URL for direct upload) |

CORS enabled for Amplify domain. Throttle: 100 req/s burst.

#### 4E — SAM Template (30 min)

**File:** `infra/template.yaml` — single CloudFormation/SAM template defining all resources.

`infra/deploy.sh` — one-command deploy:
```bash
#!/usr/bin/env bash
set -e
# 1. Bundle Lambda handlers with Bun
bun build src/lambda/submit-job.ts src/lambda/get-job.ts \
          src/lambda/diff-worker.ts src/lambda/aggregate.ts \
          src/lambda/update-status.ts src/lambda/presign.ts \
          --target=node --outdir=dist/lambda
# 2. SAM build (uses pre-built JS, no tsc)
sam build
# 3. Deploy
sam deploy --guided
```

> `sam build` must point at `dist/lambda/` as `CodeUri` in `template.yaml` — no `sam build` TypeScript compilation needed since Bun already bundled everything.

**Output:** API Gateway URL → hardcode in frontend `.env`.

---

### Phase 5 — Frontend (Amplify) 🟡
**Duration:** 3 hours · **Owner:** Lavanya · **Deadline:** Sept 19, 03:00 IST

**Technology:** Plain HTML + Vanilla CSS + Vanilla JS (single `index.html` for speed). Amplify Hosting via GitHub auto-deploy.

#### 5A — Upload & Job Submission (45 min)

```
[Drop Zone: Trace A] [Drop Zone: Trace B]
[Rules: ✓ ignore-timestamps ✓ canonicalize-ids ✓ numeric-tolerance]
[Tolerance: 5%] [Max Depth: 1000]
[▶ Compare Traces]
```

Flow:
1. Get presigned S3 URLs from `/presign`
2. Upload both files directly to S3 (bypass API Gateway 10 MB limit)
3. `POST /jobs` with S3 keys + config
4. Start polling `GET /jobs/{id}` every 2 s
5. Show progress bar: "Building Merkle trees… Diffing… Done"

#### 5B — Diff Results Panel (1 hour)

**Left column:** Diff list
```
3 semantic  1 uncertain  14,280 skipped (98.3%)

● MODIFIED  db-query — rows_returned: 42 → 0
● ADDED     cache-miss-fallback (12 nodes)
● MODIFIED  response — status_code: 200 → 500
◐ UNCERTAIN auth — token_validation_ms: 12 → 89
```

**Right column:** Split tree view
- Trace A on left, Trace B on right
- Nodes color-coded: 🟢 green (hash match, collapsed), 🔴 red (semantic diff), 🟡 yellow/uncertain, ➕/➖ added/removed
- Collapsed matched subtrees: "... 4,523 identical nodes"
- Click diff in list → scroll both panes to node
- Click node → expand attribute panel below

#### 5C — Statistics Banner (15 min)

```
14,527 events  ·  3 semantic diffs  ·  98.3% skipped  ·  0.3ms diff time  ·  213ms total
```

#### 5D — Amplify Deploy (30 min)

- Connect GitHub repo to Amplify
- Auto-deploy on push to `main`
- Set `VITE_API_URL` env var in Amplify console (or hardcode for hackathon speed)
- Get live URL → submit in project form

---

### Phase 6 — Local HTML Visualization (CLI `--html-out`) 🟡
**Duration:** 2 hours · **Owner:** Maaz · **Deadline:** Sept 19, 06:00 IST

**File:** `src/viz/template.html` — fully self-contained (no CDN, no external deps).

**Data injection:** CLI replaces `__DIFF_DATA__` placeholder with JSON:
```typescript
const html = template.replace("__DIFF_DATA__", JSON.stringify(summary));
```

**Key implementation details:**
- Virtual scroll: only render visible rows + 20-row buffer, fixed 28px row height → handles 1M-node trees
- Auto-expand diff paths: walk root → each diff node, expand all ancestors on load
- Synchronized scroll: left and right panes scroll together
- Lazy attributes: only include full attribute data for diff nodes (not all 1M nodes)

**Animated Diff Discovery Mode** (`?animate=true`):
1. Start with trees collapsed
2. 50ms per step: expand level-by-level as algorithm "visits" it
3. Green flash on Merkle-matched (skipped) subtrees
4. Red pulse on divergence found
5. Live counter: "Nodes visited: 247 / 14,527"
6. ~5 seconds total → viscerally demonstrates the algorithm for the demo video

---

### Phase 7 — Bedrock LLM Rule (Differentiator) 🟢
**Duration:** 2 hours · **Owner:** Divyansh · **Deadline:** Sept 19, 09:00 IST

**File:** `src/rules/semantic-llm.ts`

**Use case:** Two log messages with different wording but same meaning:
- `"User authentication succeeded for ID: abc123"`
- `"Auth OK — user abc123 logged in"`

Exact-match → "semantic diff". LLM rule → "noise" (same meaning).

**Implementation:**

```typescript
export const semanticLlmRule: EquivalenceRule = {
  name: "semantic-llm",
  description: "Uses Amazon Bedrock to judge semantic equivalence of log messages",
  priority: 100,  // runs last, only if other rules didn't classify

  normalize(node: TraceNode): TraceNode {
    return node;  // no normalization; classification only
  },

  async classify(nodeA: TraceNode, nodeB: TraceNode): Promise<Significance | null> {
    // Only apply to log nodes with string message attributes
    if (nodeA.type !== "log" || nodeB.type !== "log") return null;
    
    const msgA = String(nodeA.attributes.message ?? nodeA.label);
    const msgB = String(nodeB.attributes.message ?? nodeB.label);
    if (msgA === msgB) return "noise";  // fast path
    
    const prompt = `Are these two log messages semantically equivalent?
Message A: "${msgA}"
Message B: "${msgB}"
Answer with exactly one word: "equivalent" or "different". No explanation.`;
    
    const response = await bedrockClient.invokeModel({
      modelId: "anthropic.claude-3-haiku-20240307-v1:0",
      body: JSON.stringify({ messages: [{ role: "user", content: prompt }], max_tokens: 10 })
    });
    
    const text = parseBedrockResponse(response);
    return text.includes("equivalent") ? "noise" : "semantic";
  }
};
```

**Demo script:**
```bash
# Two traces with same behavior, different log wording
bun run src/cli/main.ts trace_a.json trace_b.json --rules semantic-llm --stats
# → 0 semantic diffs (LLM classified log differences as noise)
# vs without rule: 2 semantic diffs
```

This is the main judging differentiator for **Learning** and **Idea/Impact** criteria.

---

### Phase 8 — Benchmark Runner + Performance Validation 🟡
**Duration:** 1 hour · **Owner:** Any · **Deadline:** Sept 19, 11:00 IST

**File:** `src/bench/run.ts`

**Benchmark matrix:**

| N | D | D/N | Expected diff time | Memory |
|---|---|-----|-------------------|--------|
| 1,000 | 5 | 0.5% | < 1ms | < 10 MB |
| 10,000 | 50 | 0.5% | < 5ms | < 50 MB |
| 100,000 | 100 | 0.1% | < 50ms | < 400 MB |
| 1,000,000 | 100 | 0.01% | < 2s | < 4 GB |

**Assertions:** All expected diffs found, 0 false positives.

**Output:** Formatted table + `bench-results.csv` (paste into README).

These numbers go in the demo video and README. They're the "1M events, sub-second diff" talking point.

---

### Phase 9 — npm Library Entry Point 🟡
**Duration:** 30 min · **Owner:** Any · **Deadline:** Sept 19, 12:00 IST

**File:** `src/index.ts`

```typescript
// Convenience API for library consumers
export async function tracediff(
  traceA: TraceNode | unknown,
  traceB: TraceNode | unknown,
  options: Partial<TraceDiffConfig> = {}
): Promise<DiffSummary> {
  const config = mergeConfig(DEFAULT_CONFIG, options);
  const rules = createRules(config.rules, config.ruleConfig);
  const nodeA = isTraceNode(traceA) ? traceA : autoDetect(traceA);
  const nodeB = isTraceNode(traceB) ? traceB : autoDetect(traceB);
  const merkleA = buildMerkleTree(nodeA, rules, config);
  const merkleB = buildMerkleTree(nodeB, rules, config);
  return diffTrees(merkleA, merkleB, rules, config);
}

// Re-export everything public
export type { TraceNode, MerkleNode, DiffResult, DiffSummary, EquivalenceRule, TraceDiffConfig };
export { buildMerkleTree, diffTrees, matchChildren, createRules };
export { BUILTIN_RULES } from "./rules/registry.js";
```

---

### Phase 10 — Integration Tests + Final Polish 🟡
**Duration:** 1.5 hours · **Owner:** Maaz · **Deadline:** Sept 19, 14:00 IST

**Integration test suite (`test/integration.test.ts`):**

| Test | Assert |
|------|--------|
| Self-diff always empty | 100% skip, 0 diffs |
| Noise injection → 0 semantic diffs | `summary.semantic.length === 0` |
| Every injected semantic diff found | Compare with `expected_diffs.json` |
| CLI exit codes | `0` identical, `1` semantic diff, `2` error |
| JSON output is valid | `JSON.parse(stdout)` succeeds |
| HTML output is valid HTML | Contains `<!DOCTYPE html>` |
| 100K trace completes < 5s | `summary.timing.totalMs < 5000` |

**Property-based tests:**
- Randomly generated traces: self-diff always empty
- Randomly inject noise only: always 0 semantic diffs
- Randomly inject N diffs: always find exactly N semantic diffs

---

### Phase 11 — Demo Prep + README 🔴
**Duration:** 2 hours · **Owner:** All · **Deadline:** Sept 19, 18:00 IST

#### README Must Include:

```markdown
# tracediff

Structural diffing of execution traces. O(N + D·log N) vs O(N²m²).

## Quick Start
pnpm install
bun run src/cli/main.ts trace_a.json trace_b.json --stats

## Benchmark Results
| Nodes | Diffs | Skip % | Diff Time | Total |
|-------|-------|--------|-----------|-------|
| 1K    | 5     | 98.3%  | < 1ms     | 12ms  |
| 100K  | 100   | 98.3%  | 0.3ms     | 213ms |
| 1M    | 100   | 99.99% | 1ms       | ~12s  |

## AWS Architecture
[diagram]

## How It Works
[algorithm explanation with the Merkle skip insight]
```

#### Demo Script (3-minute video):

```
0:00–0:30  Problem setup
  "Two execution traces. 100,000 events each. One passing, one failing."
  "Which differences are bugs, which are timestamp jitter?"

0:30–1:00  CLI demo
  $ bun run src/cli/main.ts demo/trace_a.json demo/trace_b.json --stats
  → Show: 3 semantic diffs, 98.3% skipped, diff time 0.3ms

1:00–2:00  Web visualization
  Open diff.html → animated discovery mode (?animate=true)
  Watch nodes flash green (skip) → red (found)
  Click on semantic diff → see attribute panel
  "This is how it finds 3 diffs out of 100,000 events in 0.3ms"

2:00–2:30  Bedrock demo
  Change rule: add --rules semantic-llm
  $ bun run src/cli/main.ts demo/trace_a.json demo/trace_b.json --rules semantic-llm --stats
  Show same traces → 0 semantic diffs (LLM classified log messages as equivalent)
  "Custom equivalence rules. Even LLM-backed ones."

2:30–3:00  Architecture + pitch
  Show AWS architecture diagram
  "Lambda + Step Functions Map for parallel diff of 1M-event traces"
  "This is an npm library. Import tracediff, pass two traces."
  "No standalone library does this today."
```

---

## 6. Timeline Summary

| Phase | Duration | Owner | Deadline (IST) | Status |
|-------|----------|-------|----------------|--------|
| 0 — Bootstrap | 30 min | Any | Sept 18, 07:00 | ⬜ |
| 1A — Hash + Serializer | 45 min | Maaz | Sept 18, 08:00 | ⬜ |
| 1B — Rules | 1.5h | Divyansh | Sept 18, 10:00 | ⬜ |
| 1C — Merkle Builder | 1.5h | Maaz | Sept 18, 12:00 | ⬜ |
| 1D — Diff Engine | 2h | Maaz+Divyansh | Sept 18, 14:00 | ⬜ |
| 2A — Parsers | 1.5h | Lavanya | Sept 18, 16:00 | ⬜ |
| 2B — Generator | 1.5h | Lavanya | Sept 18, 17:30 | ⬜ |
| 3 — CLI | 1.5h | Maaz | Sept 18, 19:00 | ⬜ |
| **🛑 MILESTONE: Local MVP done** | — | All | **Sept 18, 19:00** | ⬜ |
| 4 — AWS Infra | 4h | Divyansh | Sept 18, 23:00 | ⬜ |
| 5 — Frontend (Amplify) | 3h | Lavanya | Sept 19, 03:00 | ⬜ |
| 6 — HTML Viz (CLI) | 2h | Maaz | Sept 19, 06:00 | ⬜ |
| 7 — Bedrock LLM Rule | 2h | Divyansh | Sept 19, 09:00 | ⬜ |
| 8 — Benchmarks | 1h | Any | Sept 19, 11:00 | ⬜ |
| 9 — npm entry point | 30min | Any | Sept 19, 12:00 | ⬜ |
| 10 — Integration tests | 1.5h | Maaz | Sept 19, 14:00 | ⬜ |
| **🛑 MILESTONE: Full MVP done** | — | All | **Sept 19, 14:00** | ⬜ |
| 11 — Demo + README | 2h | All | Sept 19, 18:00 | ⬜ |
| 🎬 Demo video recording | — | All | Sept 19, 20:00 | ⬜ |
| **📤 SUBMIT** | — | Leader | **Sept 20** | ⬜ |

---

## 7. Risk Register

| Risk | Probability | Impact | Mitigation |
|------|-------------|--------|-----------|
| AWS credits not applied in time | Low | High | Apply immediately; use sandbox if blocked |
| Step Functions Map too slow for demo | Medium | Medium | Fallback: single Lambda, no chunking |
| Bedrock API latency kills demo | Medium | Low | Cache LLM results; it's bonus only |
| 1M-node trace OOM in Lambda | Medium | Medium | Use 3008 MB Lambda; stream large traces |
| Frontend deploy fails | Low | Medium | Fallback: show CLI + local HTML |
| Demo video shaky | High | High | Script exactly, record 3 takes, pick best |

---

## 8. Definition of Done

> [!IMPORTANT]
> **Minimum to submit (Ship It track):**
> 1. ✅ Core engine works locally (Phase 1–3)
> 2. ✅ At least Lambda + API Gateway + S3 deployed on AWS with a live URL (Phase 4 partial)
> 3. ✅ Frontend shows diff results from the API (Phase 5 partial)
> 4. ✅ 3-minute demo video recorded
> 5. ✅ README with architecture diagram + benchmark numbers

> [!TIP]
> **What pushes you to first place:**
> - Step Functions Map state working at 1M-node scale
> - Bedrock LLM rule demo
> - Animated diff discovery in the HTML viz
> - npm library publishable
> - Blog post on AWS Builder Center

---

## 9. Complexity Guarantees (For Demo/README)

| Operation | Naive | TraceDiff | Speedup (D=100, N=1M) |
|-----------|-------|-----------|----------------------|
| Subtree equality | O(N) | O(1) hash | 1,000,000× |
| Full tree diff | O(N²m²) | O(N + D·log N) | ~100,000× |
| Children matching | O(k²) | O(k) | k× |
| First divergence | O(N) | O(log N) | ~50× |
| Identical traces | O(N) | O(1) | 1,000,000× |

**Back-of-envelope for 1M nodes, D=100 diffs:**
- Tree depth: log₁₀(10⁶) = 6
- Nodes visited by diff walk: 100 × 6 = 600 out of 1,000,000 (99.94% skip)
- Children matching ops: 600 × 10 = 6,000 total — **microseconds**
- Bottleneck: JSON parse + SHA-256 Merkle build (~6–12 seconds)
- Diff walk itself: **< 1ms** — effectively instant
