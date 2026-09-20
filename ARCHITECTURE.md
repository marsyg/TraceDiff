
# How `tracediff` Works — Visual Guide

> Read this before you demo it, explain it, or change it.
> Every diagram renders as-is on GitHub, VS Code, and Obsidian.

---

## TL;DR — the 30-second version

We compare two **execution traces** (trees of events) and report only what actually changed.

The trick: give every subtree a **fingerprint** (a hash). If two subtrees have the same fingerprint, they're identical — skip the whole thing without looking inside. Since real traces are 95–99% identical between runs, we only walk the ~1% that differs.

Cost scales with **change size**, not **trace size**.

```mermaid
flowchart LR
  A["Trace A<br/>1,000,000 nodes"] --> H1["Fingerprint<br/>every subtree"]
  B["Trace B<br/>1,000,000 nodes"] --> H2["Fingerprint<br/>every subtree"]
  H1 --> D{"Compare<br/>fingerprints"}
  H2 --> D
  D -->|"99.9% match"| S["Skip"]
  D -->|"0.1% differ"| W["Walk + report"]
  S --> R["Result:<br/>3 semantic diffs<br/>0.3 ms"]
  W --> R

  classDef skip fill:#3fb950,stroke:#2d8a3e,color:#fff
  classDef walk fill:#f85149,stroke:#c0392b,color:#fff
  class S skip
  class W walk
```

---

## 📑 Architecture Index

<div style="background: rgba(22, 27, 34, 0.7); border: 1px solid var(--border, #30363d); border-radius: 8px; padding: 1.25rem 1.75rem; margin: 1.5rem 0 2rem 0;">

* **Core Conceptual Foundations**:
  * [§ 1. What a trace actually is](#1-what-a-trace-actually-is)
  * [§ 2. Why a naive diff is too slow](#2-why-a-naive-diff-is-too-slow)
  * [§ 3. The insight: fingerprint every subtree](#3-the-insight-fingerprint-every-subtree)
  * [§ 4. One change ripples up](#4-one-change-ripples-up)
* **Diff Engine Mechanics**:
  * [§ 5. The diff walk — top-down, skip the matches](#5-the-diff-walk--top-down-skip-the-matches)
  * [§ 6. Concrete walkthrough — a small tree](#6-concrete-walkthrough--a-small-tree)
  * [§ 7. Three verdicts per node (raw vs. normalized)](#7-three-verdicts-per-node)
  * [§ 8. Skip accounting — the three buckets](#8-skip-accounting--the-three-buckets)
  * [§ 9. Why depth matters for skip %](#9-why-depth-matters-for-skip-)
  * [§ 10. Complexity — the win](#10-complexity--the-win)
* **Pipelines & Cloud Architecture**:
  * [§ 11. Local single-process pipeline](#11-local-single-process-pipeline)
  * [§ 12. Distributed Cloud Architecture (AWS Serverless Engine)](#12-distributed-cloud-architecture-aws-serverless-engine)
    * [12.1 Phase 1: Ingestion & Storage Lifecycle](#121-phase-1-ingestion--direct-storage-lifecycle)
    * [12.2 Phase 2: Distributed Map-State & Query Pipeline](#122-phase-2-distributed-map-state--query-pipeline)
    * [12.3 Consolidated End-to-End Cloud Blueprint](#123-consolidated-end-to-end-cloud-blueprint)
    * [12.4 Key Architectural Pillars](#124-key-architectural-pillars)
* **System Indexing & Reference**:
  * [§ 13. Indexing Architecture — How TraceDiff Localizes Divergences in O(1)](#13-indexing-architecture--how-tracediff-localizes-divergences-in-o1)
    * [13.1 Tier 1: Subtree Merkle Indexing](#131-tier-1-subtree-merkle-indexing-cryptographic-hash-index)
    * [13.2 Tier 2: Sibling Alignment Bucket Indexing](#132-tier-2-in-memory-sibling-alignment-indexing-srccorematch-childrents)
    * [13.3 Tier 3: Cloud Range Indexing in DynamoDB](#133-tier-3-cloud-range-indexing-in-dynamodb-resultstable)
  * [Cheat sheet](#cheat-sheet)
  * [One diagram to rule them all](#one-diagram-to-rule-them-all)

</div>

---

## 1. What a trace actually is

An execution trace is a **tree of events**. Each node is one thing the program did — a function call, a database query, an HTTP request, a log line.

```mermaid
flowchart TD
  R["root"] --> AG["api-gateway"]
  R --> RES["response"]
  AG --> AUTH["auth-middleware"]
  AG --> US["user-service"]
  US --> DB["db-query"]
  US --> FMT["format-response"]

  classDef leaf fill:#1c2128,stroke:#30363d,color:#8b949e
  classDef branch fill:#161b22,stroke:#58a6ff,color:#e6edf3
  class R branch
  class AG,RES,AUTH,US,DB,FMT branch
```

Each node carries **attributes** — the data that actually varies between runs:

```mermaid
flowchart LR
  N["db-query<br/>rows_returned: 42<br/>sql: SELECT * FROM users<br/>duration_ms: 12"]
```

The tree structure is stable across runs. The attributes are what change.

---

## 2. Why a naive diff is too slow

### Naive approach 1: text diff

`diff trace_a.json trace_b.json` treats traces as flat text. One shifted timestamp cascades into thousands of spurious diffs because everything below it is now "different."

### Naive approach 2: full tree comparison

Walk every node in A, find its match in B, compare. That's **O(N²)** — for N = 1,000,000, that's 10¹² operations, roughly 15 minutes, and 8 TB of working memory.

```mermaid
flowchart TD
  NA["Naive: compare every node"] --> N1["1,000,000 × 1,000,000"]
  N1 --> N2["10¹² operations"]
  N2 --> N3["~15 minutes"]
  N3 --> N4["Not viable"]

  classDef bad fill:#f85149,stroke:#c0392b,color:#fff
  class N4 bad
```

The problem: **99.9% of the comparisons are between things that are already identical.** We're paying full price to confirm what a hash could tell us in O(1).

---

## 3. The insight: fingerprint every subtree

Instead of comparing nodes, compute a **fingerprint** for each node that summarizes everything underneath it.

```
fingerprint(leaf)  = hash(leaf's content)
fingerprint(node)  = hash(node's content + fingerprints of all children)
```

A parent's fingerprint **depends on its children's fingerprints**. Change any leaf, and the change **ripples up to the root**.

```mermaid
flowchart TD
  subgraph build["Bottom-up: children first, then parent"]
    L1["leaf a1<br/>h = 4f2a"]
    L2["leaf a2<br/>h = 9b31"]
    L3["leaf b1<br/>h = c7e0"]
    L4["leaf b2<br/>h = 1d88"]

    A["A<br/>h = hash(content + 4f2a + 9b31)"]
    B["B<br/>h = hash(content + c7e0 + 1d88)"]
    R["root<br/>h = hash(content + h_A + h_B)"]

    L1 --> A
    L2 --> A
    L3 --> B
    L4 --> B
    A --> R
    B --> R
  end

  classDef leaf fill:#1c2128,stroke:#30363d,color:#8b949e
  classDef branch fill:#161b22,stroke:#58a6ff,color:#e6edf3
  classDef root fill:#161b22,stroke:#bc8cff,color:#e6edf3
  class L1,L2,L3,L4 leaf
  class A,B branch
  class R root
```

**The crucial property:** if `fingerprint(X) == fingerprint(Y)`, then subtree X is **identical** to subtree Y — with probability 1 − 2⁻²⁵⁶. No need to look inside.

---

## 4. One change ripples up

Change one leaf, and every ancestor's fingerprint changes. Siblings and their subtrees are untouched.

```mermaid
flowchart TD
  subgraph before["Before — Trace A"]
    direction TB
    RA["root<br/>h = AAA"] --> AA["A<br/>h = aaa"]
    RA --> BA["B<br/>h = bbb"]
    AA --> A1A["a1<br/>h = 111"]
    AA --> A2A["a2<br/>h = 222"]
    BA --> B1A["b1<br/>h = 333"]
    BA --> B2A["b2<br/>h = 444"]
  end

  subgraph after["After — Trace B (a1 changed)"]
    direction TB
    RB["root<br/>h = ZZZ"] --> AB["A<br/>h = xxx"]
    RB --> BB["B<br/>h = bbb"]
    AB --> A1B["a1<br/>h = 999"]
    AB --> A2B["a2<br/>h = 222"]
    BB --> B1B["b1<br/>h = 333"]
    BB --> B2B["b2<br/>h = 444"]
  end

  classDef changed fill:#f85149,stroke:#c0392b,color:#fff
  classDef same fill:#3fb950,stroke:#2d8a3e,color:#fff
  class A1B,AB,RB changed
  class BA,BB,B1A,B2A,B1B,B2B,A2A,A2B,A1A same
```

Green = fingerprint unchanged (subtree is identical, can be skipped).  
Red = fingerprint changed (something below here differs).

**B's entire subtree has the same fingerprint on both sides.** That's 3 nodes (B, b1, b2) we never have to look at.

---

## 5. The diff walk — top-down, skip the matches

Now the actual algorithm. Start at the roots. Compare fingerprints. If they match, **stop** — nothing below could possibly differ. If they don't match, recurse into children.

```mermaid
flowchart TD
  Start([Compare root A vs root B]) --> HashCheck{Fingerprints<br/>match?}
  HashCheck -->|Yes| Skip["Skip entire subtree<br/>nodesSkipped += size - 1"]
  HashCheck -->|No| Children["Match children by<br/>fingerprint, then signature"]
  Children --> Pairs["For each matched pair:<br/>push onto stack"]
  Children --> Rem["Unmatched in A → 'removed'"]
  Children --> Add["Unmatched in B → 'added'"]
  Pairs --> Recurse{Stack<br/>empty?}
  Recurse -->|No| Pop["Pop next pair"]
  Pop --> HashCheck
  Recurse -->|Yes| Done([Done])

  classDef skip fill:#3fb950,stroke:#2d8a3e,color:#fff
  classDef diff fill:#f85149,stroke:#c0392b,color:#fff
  class Skip skip
  class Rem,Add diff
```

It's an **iterative DFS** with an explicit stack, not recursion — so the walk itself never grows the call stack, no matter how deep the trace goes. (Note: the Merkle *build* in `src/core/merkle-tree.ts` is recursive — bottom-up needs children before parents — so extreme chain-depth is bounded there, not here. Real traces are wide and shallow, which is also what makes §9 work.)

---

## 6. Concrete walkthrough — a small tree

Let's run the algorithm by hand on a 7-node tree. Change one leaf.

```mermaid
flowchart TD
  R["root"] --> A["A"]
  R --> B["B"]
  A --> a1["a1"]
  A --> a2["a2"]
  B --> b1["b1"]
  B --> b2["b2"]
```

**Trace A** fingerprints: `root=AAA, A=aaa, B=bbb, a1=111, a2=222, b1=333, b2=444`  
**Trace B** fingerprints: `root=ZZZ, A=xxx, B=bbb, a1=999, a2=222, b1=333, b2=444`

### The walk, step by step

> Pop order below follows the real engine: matched pairs are pushed in
> child order, so the stack (LIFO) visits the *last* sibling first.
> Any order yields the same buckets and counts.

```mermaid
sequenceDiagram
  autonumber
  participant Stack
  participant Engine
  participant Result

  Note over Stack: [{rootA, rootB}]
  Stack->>Engine: pop(rootA, rootB)
  Engine->>Engine: AAA ≠ ZZZ → descend
  Engine->>Engine: match children: A↔A, B↔B
  Note over Stack: push A pair, push B pair

  Stack->>Engine: pop(B_A, B_B)
  Engine->>Engine: bbb = bbb → SKIP
  Engine->>Result: nodesSkipped += 3 - 1 = 2

  Stack->>Engine: pop(A_A, A_B)
  Engine->>Engine: aaa ≠ xxx → descend
  Engine->>Engine: match children: a1↔a1, a2↔a2
  Note over Stack: push a1 pair, push a2 pair

  Stack->>Engine: pop(a2_A, a2_B)
  Engine->>Engine: 222 = 222 → SKIP
  Engine->>Result: nodesSkipped += 1 - 1 = 0

  Stack->>Engine: pop(a1_A, a1_B)
  Engine->>Engine: 111 ≠ 999 → leaf diff
  Engine->>Result: emit "modified: a1"
```

### The result

| Bucket | Count | What |
|---|---|---|
| `nodesVisited` | 5 | root, B, A, a2, a1 |
| `nodesSkipped` | 2 | B-subtree (2) + a2 (0) |
| `nodesBulkReported` | 0 | — |
| **Total** | **7** | = trace A size ✓ |

The one change cost us **5 visits** out of 7 nodes. Not a big win here — but this tree is tiny. See §9 for why depth changes everything.

---

## 7. Three verdicts per node

Fingerprinting gives us a subtle power: we can distinguish **"truly identical"** from **"same after rules."**

We compute **two** fingerprints per node:

- **`rawHash`** — hash of the node's literal content
- **`normalizedHash`** — hash of the content **after** equivalence rules run (ignore timestamps, canonicalize IDs, etc.)

```mermaid
flowchart TD
  Start([Compare two nodes]) --> N{normalizedHash<br/>equal?}
  N -->|No| Diverge["DIVERGES<br/>Real difference<br/>→ keep walking"]
  N -->|Yes| R{rawHash<br/>equal?}
  R -->|Yes| Identical["IDENTICAL<br/>Truly nothing changed<br/>→ skip silently"]
  R -->|No| Noise["NOISE<br/>Something changed but<br/>rules said it doesn't matter<br/>→ skip with note"]

  classDef div fill:#f85149,stroke:#c0392b,color:#fff
  classDef id fill:#3fb950,stroke:#2d8a3e,color:#fff
  classDef no fill:#d29922,stroke:#b8860b,color:#fff
  class Diverge div
  class Identical id
  class Noise no
```

**Why two hashes?** Because "same" is domain-specific:

| Node A | Node B | Verdict | Why |
|---|---|---|---|
| `{ts: 10:00, rows: 42}` | `{ts: 10:05, rows: 42}` | noise | Timestamps stripped by rule |
| `{ts: 10:00, rows: 42}` | `{ts: 10:00, rows: 0}` | diverges | Real change |
| `{ts: 10:00, rows: 42}` | `{ts: 10:00, rows: 42}` | identical | Nothing changed |

With only one hash, noise and identical would look the same — and the UI couldn't paint them yellow vs green.

---

## 8. Skip accounting — the three buckets

Every node in trace A must land in **exactly one** bucket, or the demo numbers lie.

```mermaid
flowchart TD
  Root["trace A<br/>all nodes"]
  Root --> V["nodesVisited<br/>frames popped<br/>examined individually"]
  Root --> S["nodesSkipped<br/>hash match, not walked<br/>genuine Merkle savings"]
  Root --> B["nodesBulkReported<br/>removed / depth-capped<br/>reported whole, not walked"]

  V --> Inv["Invariant:<br/>traceASize = V + S + B"]
  S --> Inv
  B --> Inv

  Inv --> Pct["skipPercentage =<br/>S / traceASize<br/>only genuine skips"]

  classDef v fill:#58a6ff,stroke:#1f6feb,color:#fff
  classDef s fill:#3fb950,stroke:#2d8a3e,color:#fff
  classDef b fill:#d29922,stroke:#b8860b,color:#fff
  class V v
  class S s
  class B b
```

| Bucket | Meaning | Counts toward `skipPercentage`? |
|---|---|---|
| `nodesVisited` | Popped off the stack, inspected | No |
| `nodesSkipped` | Descendants of a **hash-verified match** | **Yes** |
| `nodesBulkReported` | Descendants of **removed** or **depth-capped** subtrees | No |

**Why three buckets and not two?** Because `nodesVisited` must mean exactly one thing: frames popped. If we folded removed/capped subtrees into it, the counter would silently include multi-node lump sums for things we never actually looked at.

**Why isn't `nodesBulkReported` in `skipPercentage`?** Because a removed subtree isn't a skip — it's a **diff**. We didn't ignore it; we flagged it. Only Merkle matches count as genuine savings.

---

## 9. Why depth matters for skip %

This is the trap that bit us once. **Wide shallow trees skip less than deep narrow ones** — even with identical node counts.

Consider: **one leaf changed**, everything else identical.

### Depth 2 — root → 10 groups → 10 leaves (111 nodes)

```mermaid
flowchart TD
  R["root<br/>differ"] --> G0["g0<br/>MATCH"]
  R --> G1["g1<br/>differ"]
  R --> G9["g2 … g9<br/>MATCH"]
  G0 --> G0L["10 leaves<br/>skipped"]
  G1 --> L0["l1 … l9<br/>MATCH"]
  G1 --> LX["l0<br/>changed"]

  classDef match fill:#3fb950,stroke:#2d8a3e,color:#fff
  classDef diff fill:#f85149,stroke:#c0392b,color:#fff
  classDef trivial fill:#1c2128,stroke:#30363d,color:#8b949e
  class G0,G9,G0L,L0 match
  class G1,LX diff
```

- Skipped: 9 groups × 10 descendants = **90**
- Visited: 1 + 10 + 10 = **21**
- Skip % = 90 / 111 = **81%**

### Depth 3 — root → 10 → 10 → 10 (1,111 nodes)

```mermaid
flowchart TD
  R["root<br/>differ"] --> G0["9 groups<br/>MATCH<br/>skip 990"]
  R --> G1["1 group<br/>differ"]
  G1 --> S0["9 subgroups<br/>MATCH<br/>skip 90"]
  G1 --> S1["1 subgroup<br/>differ"]
  S1 --> L0["9 leaves<br/>MATCH"]
  S1 --> LX["1 leaf<br/>changed"]

  classDef match fill:#3fb950,stroke:#2d8a3e,color:#fff
  classDef diff fill:#f85149,stroke:#c0392b,color:#fff
  class G0,S0,L0 match
  class G1,S1,LX diff
```

- Skipped: 9 × 110 + 9 × 10 = **1,080**
- Visited: 1 + 10 + 10 + 10 = **31**
- Skip % = 1,080 / 1,111 = **97.2%**

### The trend

| Depth | Nodes | Skipped | Skip % |
|---|---|---|---|
| 2 | 111 | 90 | 81.1% |
| 3 | 1,111 | 1,080 | 97.2% |
| 4 | 11,111 | 11,070 | 99.6% |
| 5 | 111,111 | 111,060 | 99.96% |

**The rule:** every level of depth multiplies the skip rate by roughly `branching / (branching + 1)`, until you asymptote to 100%.

Real traces are 5–10 levels deep (span → sub-span → handler → query → row). That's why a real trace hits 98–99% skip while a 2-level test tree caps at 81%.

**Corollary:** never benchmark your skip-% on a shallow tree. The number isn't the algorithm's fault.

---

## 10. Complexity — the win

```mermaid
flowchart LR
  subgraph naive["Naive full-tree diff"]
    N1["N = 1,000,000"] --> N2["O(N²) = 10¹² ops"]
    N2 --> N3["~15 minutes"]
  end

  subgraph merkle["Merkle + skip"]
    M1["N = 1,000,000<br/>D = 100 diffs"] --> M2["Build:<br/>O(N) ≈ 12 s"]
    M2 --> M3["Walk:<br/>O(D·log N) ≈ 1 ms"]
    M3 --> M4["Total: ~12 s"]
  end

  classDef bad fill:#f85149,stroke:#c0392b,color:#fff
  classDef good fill:#3fb950,stroke:#2d8a3e,color:#fff
  class N3 bad
  class M4 good
```

| Operation | Naive | `tracediff` | Asymptotic speedup |
|---|---|---|---|
| Subtree equality | O(N) | O(1) hash compare | 1,000,000× (N=1M) |
| Full tree diff | O(N²) | O(N + D·log N) | ~1,000,000× (N=1M, D=100) |
| Children matching | O(k²) | O(k) hash map | k× |
| Diff walk, identical traces | O(N) | O(1) — root match, stop | 1,000,000× |
| Find first divergence | O(N) | O(log N) down one path | ~50,000× (N=1M) |

**The key mental shift:** the diff cost tracks **how much changed**, not **how big the trace is**. Doubling trace size barely moves the diff phase; doubling diff count doubles it (linearly).

---

## 11. Local single-process pipeline

```mermaid
flowchart LR
  A1["trace_a.json"] --> P1["Parse"]
  B1["trace_b.json"] --> P1
  P1 --> M1["Build Merkle trees<br/>O(N)"]
  M1 --> D["Diff walk<br/>O(D·log N)"]
  D --> Out["DiffSummary"]
  Out --> CLI["Terminal"]
  Out --> JSON["JSON"]
  Out --> HTML["HTML viz"]

  classDef input fill:#161b22,stroke:#58a6ff,color:#e6edf3
  classDef output fill:#161b22,stroke:#bc8cff,color:#e6edf3
  class A1,B1 input
  class CLI,JSON,HTML output
```

Every stage is **single-pass**. The diff walk is **iterative** (explicit stack — see §5); the Merkle build recurses bottom-up in `src/core/merkle-tree.ts`. The local CLI runs completely in memory with zero external dependencies.

---

## 12. Distributed Cloud Architecture (AWS Serverless Engine)

When traces grow into hundreds of megabytes or production telemetry runs asynchronously, TraceDiff transitions from the local single-process pipeline to an **event-driven AWS serverless architecture** defined in [`infra/template.yaml`](../infra/template.yaml).

To ensure clarity, the cloud architecture is presented in two focused operational phases, with an expandable full-system schematic.

### 12.1 Phase 1: Ingestion & Direct Storage Lifecycle

To bypass the 10 MB payload ceiling of AWS API Gateway, trace dumps are uploaded directly to Amazon S3 via time-limited presigned URLs:

```mermaid
flowchart LR
  subgraph ClientTier["1. Client Ingestion"]
    UI["Web Frontend<br/>CloudFront + S3"]
    CLI["TraceDiff CLI<br/>Bun Runtime"]
  end

  subgraph APITier["2. API Gateway & Handlers"]
    P_ROUTE["GET /presign"]
    J_ROUTE["POST /jobs"]
    H_PRE["presign.handler"]
    H_SUB["submit-job.handler"]
  end

  subgraph StorageTier["3. Storage & State"]
    S3["Amazon S3 Bucket<br/>tracediff-uploads-*<br/>14-Day Auto-TTL"]
    D_JOBS[("DynamoDB JobsTable<br/>Status: PENDING<br/>Job Metadata & TTL")]
  end

  subgraph Orchestration["4. Execution Trigger"]
    SFN["DiffStateMachine<br/>Step Functions Pipeline"]
  end

  UI -->|"1. Request presigned URL"| P_ROUTE
  CLI -->|"1. Request presigned URL"| P_ROUTE
  P_ROUTE --> H_PRE
  H_PRE -->|"Generate PUT URL"| S3

  UI -->|"2. Direct multi-MB trace upload"| S3
  CLI -->|"2. Direct multi-MB trace upload"| S3

  UI -->|"3. Submit job with trace keys"| J_ROUTE
  CLI -->|"3. Submit job with trace keys"| J_ROUTE
  J_ROUTE --> H_SUB
  H_SUB -->|"4. Persist PENDING state"| D_JOBS
  H_SUB -->|"5. Trigger execution"| SFN
```

---

### 12.2 Phase 2: Distributed Map-State & Query Pipeline

AWS Step Functions orchestrates parallel worker tasks across Lambda instances, streams paginated divergence items into DynamoDB, and delivers results to the frontend:

```mermaid
flowchart TD
  subgraph SFN_Pipeline["Step Functions Orchestration Pipeline - DiffStateMachine"]
    L_LOAD["LoadTraces Lambda<br/>• Fetch trace metadata from S3<br/>• Transition job status to RUNNING<br/>• Slice trace into chunk partitions"]

    subgraph MapState["MapDiff - Distributed Concurrency: 10"]
      W1["DiffWorker Lambda - 3008 MB RAM<br/>• Parse OTel or JSON trace trees<br/>• Execute equivalence normalization<br/>• Merkle tree hash & top-down diff walk"]
    end

    L_AGGR["Aggregate Lambda<br/>• Combine chunk metrics & skip rates<br/>• Run FinOps cost engine - AWS US-East-1 pricing"]
    L_UPDATE["UpdateStatus Lambda<br/>• Finalize job record as COMPLETED<br/>• Persist consolidated KPI summary"]
    L_FAIL["JobFailed Handler<br/>• Catch unhandled exceptions<br/>• Mark job status as FAILED"]
  end

  subgraph Persistence["Dual DynamoDB Persistence"]
    T_RES[("DynamoDB ResultsTable<br/>PK: jobId | SK: diffIndex<br/>Indexed Divergence Tree")]
    T_JOBS[("DynamoDB JobsTable<br/>PK: jobId<br/>Status, KPIs, TTL")]
  end

  subgraph Visualizer["Client Query & Pagination"]
    H_GET["get-job.handler<br/>REST API"]
    UI["Web Visualizer UI<br/>• KPI Metrics Bar<br/>• Hierarchical Diff Tree<br/>• 3-Column Attribute Panel"]
  end

  L_LOAD -->|"Chunk items"| MapState
  W1 -->|"Batch write divergence records"| T_RES
  MapState -->|"Worker results"| L_AGGR
  L_AGGR -->|"Merged summary"| L_UPDATE
  L_UPDATE -->|"Write COMPLETED state"| T_JOBS

  L_LOAD -.->|"On catch error"| L_FAIL
  MapState -.->|"On catch error"| L_FAIL
  L_AGGR -.->|"On catch error"| L_FAIL
  L_FAIL -->|"Write FAILED state"| T_JOBS

  UI -->|"1. GET /jobs/:id - Poll status and KPIs"| H_GET
  H_GET -->|"Read status"| T_JOBS
  UI -->|"2. GET /jobs/:id/results?cursor=... - Paginated"| H_GET
  H_GET -->|"Query divergence items"| T_RES
```

---

### 12.3 Consolidated End-to-End Cloud Blueprint

Unified architectural blueprint mapping client upload, API Gateway endpoints, Step Functions Map-State, S3 storage, dual DynamoDB tables, and visualizer pagination:

```mermaid
flowchart TD
  subgraph Client["1. Client Ingestion Layer"]
    UI["Web Frontend<br/>CloudFront + S3"]
    CLI["TraceDiff CLI<br/>Local Bun Runtime"]
  end

  subgraph Gateway["2. API Gateway REST Layer"]
    API["API Gateway /dev<br/>CORS Enabled"]
    P_URL["GET /presign"]
    POST_JOB["POST /jobs"]
    GET_JOB["GET /jobs/:id"]
    GET_RES["GET /jobs/:id/results"]
  end

  subgraph Storage["3. Persistent Cloud Storage"]
    S3["Amazon S3 Bucket<br/>14-Day Auto-TTL"]
    T_JOBS[("DynamoDB JobsTable<br/>Status & Summary")]
    T_RES[("DynamoDB ResultsTable<br/>Paginated Divergences")]
  end

  subgraph StepFn["4. Step Functions Diff Pipeline"]
    L_LOAD["LoadTraces Lambda"]
    MAP_DIFF["Step Functions Map State<br/>Concurrency: 10"]
    L_WORKER["DiffWorker Lambda<br/>3008 MB RAM"]
    L_AGGR["Aggregate Lambda<br/>FinOps Cost Model"]
    L_UPDATE["UpdateStatus Lambda<br/>Mark COMPLETED"]
    L_FAIL["JobFailed Handler<br/>Mark FAILED"]
  end

  subgraph Handlers["5. Lambda API Handlers"]
    H_PRESIGN["presign.handler"]
    H_SUBMIT["submit-job.handler"]
    H_GET["get-job.handler"]
  end

  UI --> P_URL
  CLI --> P_URL
  P_URL --> H_PRESIGN
  H_PRESIGN -->|"Generate PUT URL"| S3

  UI -->|"Direct multi-MB trace upload"| S3
  CLI -->|"Direct multi-MB trace upload"| S3

  UI --> POST_JOB
  CLI --> POST_JOB
  POST_JOB --> H_SUBMIT
  H_SUBMIT -->|"Write PENDING state"| T_JOBS
  H_SUBMIT -->|"Trigger execution"| L_LOAD

  L_LOAD -->|"Read trace keys"| S3
  L_LOAD -->|"Status: RUNNING"| T_JOBS
  L_LOAD --> MAP_DIFF
  MAP_DIFF -->|"Parallel chunks"| L_WORKER
  L_WORKER -->|"Batch write diffs"| T_RES
  L_WORKER --> MAP_DIFF
  MAP_DIFF --> L_AGGR
  L_AGGR --> L_UPDATE
  L_UPDATE -->|"Status: COMPLETED"| T_JOBS

  L_LOAD -.-> L_FAIL
  MAP_DIFF -.-> L_FAIL
  L_AGGR -.-> L_FAIL
  L_FAIL -->|"Status: FAILED"| T_JOBS

  UI --> GET_JOB
  GET_JOB --> H_GET
  H_GET -->|"Read status & KPIs"| T_JOBS
  UI --> GET_RES
  GET_RES --> H_GET
  H_GET -->|"Paginated divergence records"| T_RES
```

---

### 12.4 Key Architectural Pillars

1. **Direct S3 Presigned Uploads**: Bypasses API Gateway's 10 MB limit, enabling multi-hundred-megabyte trace ingestion with automated 14-day TTL cleanup.
2. **Step Functions Map-State Concurrency**: Slices large traces into chunks and fans out across 10 concurrent `DiffWorker` Lambda instances (provisioned with 3,008 MB RAM each).
3. **Dual DynamoDB Tables**: Separates coarse-grained job state (`JobsTable`) from fine-grained, paginated divergence items (`ResultsTable` with composite key `jobId` + `diffIndex`).
4. **Embedded FinOps Cost Engine**: Calculates monetary cost deltas (Lambda GB-seconds, DynamoDB RCUs/WCUs, S3 requests) using official AWS US-East-1 list pricing.
5. **Zero-Webpack Bun Bundling**: Builds single-file Lambda handlers targeting Node.js 22.x with infrastructure managed via AWS SAM.

---

## 13. Indexing Architecture — How TraceDiff Localizes Divergences in O(1)

TraceDiff's subtitle is *"Merkle-indexed divergence localization"*. The entire performance breakthrough comes from **three complementary indexing tiers** operating across the pipeline:

```mermaid
flowchart TD
  subgraph Tier1["Tier 1: Subtree Merkle Index (Cryptographic Hash Index)"]
    M_HASH["Dual 256-Bit Digests<br/>• normalizedHash: semantic equivalence index<br/>• rawHash: literal byte equivalence index"]
    M_ACTION["Action: Root/subtree O(1) equality check.<br/>If hashes match, skip entire subtree without traversal."]
  end

  subgraph Tier2["Tier 2: Sibling Bucket Index (Linear Alignment Index)"]
    S_MAP["In-Memory Hash Buckets (match-children.ts)<br/>• Map(normalizedHash, MerkleNode[]) for O(1) exact alignment<br/>• Map(label, MerkleNode[]) for heuristic structural pairing"]
    S_ACTION["Action: Avoids O(k²) quadratic sibling matching.<br/>Aligns thousands of concurrent async spans in O(k) linear time."]
  end

  subgraph Tier3["Tier 3: DynamoDB Composite Range Index (Sparse Result Stream)"]
    D_KEY["Composite Primary Key<br/>• Partition Key: jobId (UUID)<br/>• Sort Key: diffIndex (Sequential 0, 1, 2, ... N)"]
    D_ACTION["Action: Fast cursor pagination for millions of events.<br/>The frontend fetches 50 diffs at a time via indexed range queries."]
  end

  Tier1 -->|"Divergence detected (hashes differ)"| Tier2
  Tier2 -->|"Identifies mutated/added/removed nodes"| Tier3

  classDef tier fill:#161b22,stroke:#58a6ff,color:#e6edf3
  class Tier1,Tier2,Tier3 tier
```

### 13.1 Tier 1: Subtree Merkle Indexing (Cryptographic Hash Index)
* **Mechanism**: Every node in the execution graph is indexed by a bottom-up cryptographic digest constructed from its canonical serialized attributes and its sorted children's hashes ([`src/core/merkle-tree.ts`](../src/core/merkle-tree.ts)).
* **Why It Works**: Instead of performing an exhaustive depth-first search or dynamic programming tree alignment (such as the Zhang-Shasha tree edit distance algorithm which runs in $O(N^2 \cdot m^2)$), the Merkle index inverts the problem: identical branches map to identical index keys.
* **Result**: An $O(1)$ integer/byte comparison replaces recursive inspection of tens of thousands of descendant nodes.

### 13.2 Tier 2: In-Memory Sibling Alignment Indexing ([`src/core/match-children.ts`](../src/core/match-children.ts))
* **Problem**: When a trace parent has thousands of concurrent sibling tasks (e.g. batch API requests or worker pools), a naive alignment compares every child in Trace A against every child in Trace B ($O(k^2)$ operations).
* **Two-Pass Hash Bucketing Index**:
  1. **Pass 1 (`byHash` Map Index)**: Indexes children of B into an in-memory hash table `Map<string, MerkleNode[]>` keyed by `normalizedHash`. For each child in A, lookup takes $O(1)$ time, pulling matches with FIFO order preservation.
  2. **Pass 2 (`byLabel` Map Index)**: Remaining unmatched siblings are indexed by their operation `label`. This pairs modified operations (such as a database query with altered parameters) rather than falsely reporting an "operation deleted + new operation created".
* **Result**: Sibling alignment drops from quadratic $O(k^2)$ to linear $O(k)$ average time.

### 13.3 Tier 3: Cloud Range Indexing in DynamoDB (`ResultsTable`)
* **Problem**: Execution traces frequently contain 1,000,000+ nodes, but only 5 to 50 real behavioral regressions. Transporting, deserializing, and rendering all nodes in a browser crashes client memory.
* **Composite Key Structure**:
  * **Partition Key (`HASH`)**: `jobId` — groups all divergence records for a specific trace comparison run.
  * **Sort Key (`RANGE`)**: `diffIndex` — monotonically increasing integer (0, 1, 2, ...).
* **Query Execution**: When the web frontend displays the diff tree, it queries `ResultsTable` using indexed cursor pagination (`KeyConditionExpression: jobId = :jid AND diffIndex >= :cursor`, `Limit: 50`).
* **Result**: The UI visualizer renders instantly on 100K+ node traces because it only retrieves the indexed divergence stream rather than the full execution graph.

---

## Cheat sheet

| Term | One-line meaning |
|---|---|
| **Trace tree** | Nested nodes of events; edges are "called" or "spawned" |
| **Fingerprint** | SHA-256 of a node's content + its children's fingerprints |
| **`rawHash`** | Fingerprint of the literal content |
| **`normalizedHash`** | Fingerprint after equivalence rules run |
| **Identical** | Both hashes match → skip silently |
| **Noise** | Only `rawHash` differs → skip with note |
| **Diverges** | `normalizedHash` differs → recurse |
| **`nodesVisited`** | Frames popped off the diff stack |
| **`nodesSkipped`** | Descendants of hash-verified matches (real savings) |
| **`nodesBulkReported`** | Descendants of removed / depth-capped subtrees |
| **`skipPercentage`** | `nodesSkipped / traceASize` |
| **Invariant** | `traceASize == visited + skipped + bulkReported` |

---

## One diagram to rule them all

If you only have 30 seconds to explain this to a judge:

```mermaid
flowchart LR
  A["Trace A"] --> H1["hash every subtree"]
  B["Trace B"] --> H2["hash every subtree"]
  H1 --> C{"Same<br/>hash?"}
  H2 --> C
  C -->|"Yes 99.9%"| Skip["Skip. O(1)."]
  C -->|"No 0.1%"| Recurse["Recurse. Find the diff."]
  Skip --> Win["100× faster<br/>than full compare"]
  Recurse --> Win

  classDef good fill:#3fb950,stroke:#2d8a3e,color:#fff
  class Win good
```

That's the whole idea. Everything else is engineering around it.

<script src="https://cdn.jsdelivr.net/npm/mermaid@10/dist/mermaid.min.js"></script>
<script>
  (function() {
    function renderMermaid() {
      if (typeof mermaid === "undefined") return;
      var blocks = document.querySelectorAll("pre code.language-mermaid, div.language-mermaid pre code, pre.language-mermaid, code.language-mermaid");
      blocks.forEach(function(code) {
        var container = code.closest(".language-mermaid") || code.closest("pre") || code;
        var div = document.createElement("div");
        div.className = "mermaid";
        div.textContent = code.textContent.trim();
        container.parentNode.replaceChild(div, container);
      });
      mermaid.initialize({ startOnLoad: false, theme: "dark", securityLevel: "loose" });
      mermaid.run();
    }
    if (document.readyState === "loading") {
      document.addEventListener("DOMContentLoaded", renderMermaid);
    } else {
      renderMermaid();
    }

    document.querySelectorAll("details").forEach(function(detail) {
      detail.addEventListener("toggle", function() {
        if (detail.open && typeof mermaid !== "undefined") {
          var unrendered = detail.querySelectorAll("pre code.language-mermaid, div.language-mermaid pre code, pre.language-mermaid");
          if (unrendered.length > 0) {
            unrendered.forEach(function(code) {
              var container = code.closest(".language-mermaid") || code.closest("pre") || code;
              var div = document.createElement("div");
              div.className = "mermaid";
              div.textContent = code.textContent.trim();
              container.parentNode.replaceChild(div, container);
            });
          }
          mermaid.run({ nodes: detail.querySelectorAll(".mermaid") });
        }
      });
    });
  })();
</script>
