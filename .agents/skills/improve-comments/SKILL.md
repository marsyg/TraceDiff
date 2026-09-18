---

name: tracediff-development
description: Use when developing, reviewing, debugging, documenting, or improving comments in the TraceDiff repository, especially when working on the diff engine, equivalence rules, parsers, CLI, visualization, AWS Lambda infrastructure, benchmarks, or tests.
--------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------

# TraceDiff Development Skill

## Overview

TraceDiff is a TypeScript project for structurally diffing execution traces.

Its goal is to distinguish meaningful behavioral differences from harmless execution noise.

The core approach is:

1. Parse execution traces into a common structural representation.
2. Normalize values using equivalence rules.
3. Build Merkle hashes for trace subtrees.
4. Compare the two trace structures top-down.
5. Skip identical subtrees using hashes.
6. Report meaningful differences separately from noise and uncertainty.

The project is being developed for the WeMakeDevs "First Commit" Hackathon / Bharat Builds Tour.

Do not treat this skill as permission to redesign the architecture. Preserve the existing design unless the task explicitly asks for architectural changes.

---

# Project Architecture

The repository currently follows this structure:

```text
tracediff/
├── src/
│   ├── core/
│   │   ├── Merkle builder
│   │   ├── diff engine
│   │   ├── matcher
│   │   ├── hashing
│   │   └── shared types
│   │
│   ├── rules/
│   │   ├── equivalence-rule registry
│   │   ├── built-in equivalence rules
│   │   └── Bedrock/LLM-based rule
│   │
│   ├── parsers/
│   │   ├── nested JSON
│   │   ├── flat spans
│   │   └── OpenTelemetry
│   │
│   ├── cli/
│   │   ├── CLI entry point
│   │   └── terminal/JSON output formatters
│   │
│   ├── viz/
│   │   └── self-contained HTML visualization
│   │
│   ├── lambda/
│   │   ├── submit-job
│   │   ├── get-job
│   │   ├── diff-worker
│   │   └── other AWS handlers
│   │
│   └── bench/
│       ├── synthetic trace generator
│       └── benchmark runner
│
├── test/
│   └── unit + integration tests
│
├── fixtures/
│   └── sample traces
│
├── infra/
│   ├── template.yaml
│   └── deploy.sh
│
├── package.json
├── tsconfig.json
├── bunfig.toml
└── biome.json
```

Before modifying unfamiliar code, inspect the relevant module and its callers/callees.

Do not assume that a filename or function name tells the complete architecture.

---

# Technology Constraints

Use the project's existing stack.

* Language: TypeScript
* Local runtime: Bun
* Package manager: pnpm
* Formatting/linting: Biome
* Tests: Bun test runner
* AWS runtime: Node.js 22.x
* AWS infrastructure: SAM + CloudFormation
* Lambda bundling: Bun
* Infrastructure should remain compatible with the existing SAM template.

Do NOT introduce npm/yarn dependency management.

Do NOT create `package-lock.json`.

Prefer:

```bash
bun run <script>
```

for repository scripts.

The repository uses a pnpm lockfile:

```text
pnpm-lock.yaml
```

---

# Existing Code-Quality Rules

Follow the repository's Biome conventions:

* Double quotes for strings.
* 2-space indentation.
* Semicolons required.
* Trailing commas in multiline structures.
* Avoid `any`; use `unknown` where appropriate.
* Avoid unused variables/imports.
* Do not add `console.log` inside `src/core/` or `src/rules/`.
* Keep formatting compatible with Biome.

Do not introduce another formatter or linter.

---

# Core Engineering Principles

## 1. Preserve behavior

When asked to:

* improve comments
* refactor readability
* clean up documentation
* review code
* improve naming

do not silently change runtime behavior.

If a behavioral change appears necessary, explain it before making it.

---

## 2. Prefer minimal changes

Do not rewrite entire files when a small change is sufficient.

Avoid:

* unnecessary abstractions
* speculative refactors
* changing APIs without a reason
* changing unrelated files
* replacing working implementations with a different architecture
* adding dependencies for functionality already available in the repository

---

## 3. Understand before editing

Before modifying code:

1. Read the relevant file.
2. Identify its responsibility.
3. Inspect important imported functions/types.
4. Search for callers/usages when changing behavior.
5. Check relevant tests and fixtures.
6. Make the smallest appropriate change.

---

# Comment Improvement Rules

When asked to "improve comments", "clean comments", "add comments", or similar:

## Main principle

Comments should explain **why**, not mechanically describe **what** the code does.

Bad:

```ts
// Increment i
i++;
```

Bad:

```ts
// Check if hash is equal
if (a.hash === b.hash) {
```

Better:

```ts
// Identical subtree hashes mean the entire subtree can be skipped
// without recursively comparing each descendant.
if (a.hash === b.hash) {
```

---

## Add comments when logic is non-obvious

Good candidates include:

* Merkle-tree/hash decisions
* trace normalization
* equivalence-rule behavior
* concurrency/reordering handling
* matching logic
* pruning/skipping decisions
* complexity-sensitive algorithms
* unusual data transformations
* AWS-specific workarounds
* assumptions about trace structure
* edge-case handling
* fallback behavior
* intentionally approximate behavior
* Bedrock/LLM-based equivalence decisions

---

## Do not comment obvious code

Do not add comments such as:

```ts
// Create a map
const map = new Map();
```

```ts
// Return the result
return result;
```

```ts
// Loop through nodes
for (const node of nodes) {
```

Comments should add information that cannot be immediately inferred from the code.

---

## Keep comments concise

Prefer:

```ts
// Ignore timestamps because execution timing can vary between otherwise
// equivalent runs.
```

over:

```ts
// Here we are ignoring timestamps because timestamps are values that can
// potentially be different between two executions even when the actual
// behavior of the program has not changed. This is important because...
```

---

## Do not duplicate the code

Avoid:

```ts
// If the node type is "http", return true
if (node.type === "http") {
  return true;
}
```

Instead explain the reason:

```ts
// HTTP spans are matched by semantic identity rather than their
// generated request IDs, which are expected to differ between runs.
```

---

## Correct misleading comments

If an existing comment is incorrect, stale, or contradicts the implementation:

1. Verify the implementation.
2. Update the comment.
3. Do not change the implementation unless the task explicitly requests it.
4. If the implementation itself appears wrong, flag it separately.

Never preserve an incorrect comment just because it already exists.

---

# TraceDiff-Specific Comment Guidance

When documenting TraceDiff's core algorithm, preserve these conceptual distinctions.

## Semantic difference

A difference that represents a meaningful behavioral change.

Examples include:

* HTTP 200 → HTTP 500
* database query returning rows → returning zero rows
* a new meaningful span
* changed state transition

## Noise

A difference that can occur without changing behavior.

Examples include:

* timestamp jitter
* generated request IDs
* harmless ordering differences caused by concurrency

## Uncertain

A difference where the system cannot confidently determine whether the change is meaningful.

For example:

* a large numeric value changed but its semantic importance is unknown.

Do not describe all differences as bugs.

---

# Merkle Hashing Guidance

When commenting on Merkle hashing, make the optimization clear:

Identical normalized subtrees produce identical hashes.

Therefore the diff engine can skip recursively comparing those subtrees.

The important performance idea is:

```text
Trace A
   ↓
Normalize
   ↓
Merkle hashes
   ↓
        ┌───────────────┐
        │ Diff traversal│
        └───────────────┘
                 ↑
Trace B
   ↓
Normalize
   ↓
Merkle hashes
```

Do not claim that hashing itself guarantees semantic equivalence.

The equivalence depends on:

1. normalization,
2. hashing,
3. the configured equivalence rules.

---

# Equivalence Rules

Equivalence rules determine when two values/events should be treated as equivalent despite literal differences.

When modifying rules:

* preserve the rule registry architecture;
* document what variation the rule intentionally ignores;
* document important assumptions;
* avoid hiding meaningful differences;
* keep deterministic behavior where possible.

If a rule uses an LLM/Bedrock component:

* clearly separate deterministic logic from model-based decisions;
* do not describe an LLM judgment as guaranteed correctness;
* preserve fallback/error behavior;
* avoid exposing secrets in logs or comments.

---

# Parsers

Parsers convert different trace formats into the internal representation.

Current parser categories include:

* nested JSON
* flat spans
* OpenTelemetry

When working on parsers:

* preserve the common internal representation;
* validate malformed input;
* avoid silently discarding information;
* document non-obvious format assumptions;
* add/update fixtures and tests when behavior changes.

Do not implement a new parser merely because it seems useful unless the task requests it.

---

# AWS / Lambda

TraceDiff contains AWS Lambda handlers and SAM/CloudFormation infrastructure.

When working on AWS code:

* inspect `infra/template.yaml` before changing resource assumptions;
* preserve least-privilege behavior;
* do not hard-code credentials;
* never commit AWS secrets;
* use existing environment/configuration mechanisms;
* keep local development possible where the current architecture supports it.

Do not invent AWS resources or permissions without checking the existing infrastructure.

---

# Testing

Before declaring a code change complete:

1. Run relevant tests.
2. Run type checking when appropriate.
3. Run Biome checks.
4. Run formatting checks if formatting/comments were changed.

Useful repository commands include:

```bash
bun test
bun run typecheck
bun run lint
bun run format:check
bun run check
```

For comment-only changes, at minimum verify that formatting and linting remain clean.

For behavior changes, add or update tests where appropriate.

---

# Comment-Improvement Workflow

When the user asks to improve comments across the project:

### Step 1 — Inspect

Identify:

* overly obvious comments
* missing explanations around complex logic
* stale comments
* misleading comments
* duplicated comments
* comments that describe implementation instead of intent

### Step 2 — Prioritize

Prioritize comments in:

1. `src/core/`
2. `src/rules/`
3. `src/parsers/`
4. `src/lambda/`
5. `src/bench/`

Do not blindly comment every line.

### Step 3 — Edit

Improve comments while preserving code behavior.

### Step 4 — Review

Check that each changed comment:

* is technically correct;
* explains intent or reasoning;
* is concise;
* matches the surrounding style;
* does not claim more certainty than the implementation provides.

### Step 5 — Validate

Run the relevant checks.

Report:

* files changed;
* categories of comments improved;
* any suspicious implementation/comment mismatches found;
* validation results.

---

# Scope Control: Phase 1 vs Phase 2

The project may contain planned functionality that is not yet implemented.

Do not automatically implement planned Phase 2 functionality while working on Phase 1.

In particular, do not assume that planned:

* parsers,
* generators,
* additional integrations,
* visualization features,
* AWS services,
* LLM capabilities

already need to be implemented.

If the task is documentation or comment improvement, keep the change documentation-only unless explicitly asked otherwise.

---

# Safety and Repository Hygiene

Never:

* expose credentials;
* commit `.env` secrets;
* hard-code AWS access keys;
* delete unrelated code;
* overwrite working infrastructure without inspection;
* introduce dependencies without justification;
* modify lockfiles unnecessarily;
* change behavior under the guise of a comment improvement.

Before destructive operations, ask for confirmation.

---

# Definition of Done

A TraceDiff change is complete when:

* the requested functionality/documentation change is implemented;
* existing architecture is preserved unless explicitly changed;
* TypeScript remains type-safe;
* comments accurately reflect behavior;
* no unrelated files are modified;
* tests pass where applicable;
* Biome checks pass;
* the final response clearly states what changed and what was verified.

When uncertain about intended behavior, inspect the existing code, tests, README, implementation plan, and call sites before making assumptions.
