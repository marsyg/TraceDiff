import type { TraceNode } from "../core/type.js";
// A single attribute-level difference found on an already-localized subtree.
// classify() only ever sees these — never whole subtrees — because by the
// time you're calling classify, the Merkle walk has already narrowed the
// diff down to specific fields.
export interface RawDiff {
  pathA: string[];
  pathB: string[];
  nodeA?: TraceNode;
  nodeB?: TraceNode;
  field?: string;
  valueA?: unknown;
  valueB?: unknown;
}

export interface EquivalenceRule {
  name: string;
  description: string;

  // Runs on every node BEFORE hashing. This is what lets identical-after-
  // normalization subtrees collapse to the same Merkle hash and get
  // skipped by the diff walk entirely. Must be pure given the same input —
  // no reliance on hidden global state — except where a rule intentionally
  // carries per-run state (see canonicalize-ids).
  normalize(node: TraceNode): TraceNode;

  // Only relevant for nodes whose children run concurrently. Returning true
  // tells the Merkle builder to sort this node's children (by label, then
  // hash) before hashing, so parallel-execution reordering isn't read as a
  // structural move.
  shouldSortChildren?(node: TraceNode): boolean;

  // Runs AFTER localization, only on the small number of fields that
  // actually differ. This is the right place for anything too expensive or
  // too precise to bake into normalize() — e.g. real relative-tolerance
  // comparison instead of hash-bucket approximation.
  classify?(diff: RawDiff): "semantic" | "noise" | "uncertain" | undefined;
}
