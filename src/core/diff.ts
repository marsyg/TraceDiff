import { classifyDiff } from "../rules/registry.js";
import type { EquivalenceRule, RawDiff } from "../rules/type.js";
import { canonicalSerialize } from "./hash.js";
import { matchChildren } from "./match-children.js";
import { compareNodes } from "./merkle-tree.js";
import type { DiffResult, MerkleNode } from "./type.js";

export interface DiffTreesConfig {
  maxDepth?: number;
}

// Internal, leaner shape -- NOT the public DiffSummary. compareTraces()
// (in compare-traces.ts) wraps this into the full documented schema, since
// this function has no idea about parse/tree-build timing or trace sizes;
// it only knows what it walked.
//
// Three mutually exclusive buckets partition trace A exactly once:
//   nodesVisited       -- stack frames actually popped and inspected
//   nodesSkipped       -- descendants of a hash-verified identical/noise match
//   nodesBulkReported  -- descendants of removed / depth-capped subtrees:
//                         reported as a diff without being walked individually
// Invariant: traceASize === nodesVisited + nodesSkipped + nodesBulkReported
// skipPercentage is computed only from nodesSkipped (real Merkle savings),
// never from nodesBulkReported -- removed/capped subtrees were reported, not
// ignored, so they do not belong in the skip numerator.
export interface DiffWalkResult {
  diffs: DiffResult[];
  nodesVisited: number;
  nodesSkipped: number;
  nodesBulkReported: number;
  depthCapped: number;
}

interface StackFrame {
  a: MerkleNode;
  b: MerkleNode;
  pathA: string[];
  pathB: string[];
  depth: number;
}

const SIGNIFICANCE_RANK: Record<import("./type.js").Significance, number> = {
  noise: 0,
  uncertain: 1,
  semantic: 2,
};

export function diffTrees(
  rootA: MerkleNode,
  rootB: MerkleNode,
  rules: EquivalenceRule[],
  config: DiffTreesConfig = {},
): DiffWalkResult {
  const maxDepth = config.maxDepth ?? 200;
  const diffs: DiffResult[] = [];
  let nodesVisited = 0;
  let nodesSkipped = 0;
  let nodesBulkReported = 0;
  let depthCapped = 0;

  const stack: StackFrame[] = [
    {
      a: rootA,
      b: rootB,
      pathA: [rootA.trace.label],
      pathB: [rootB.trace.label],
      depth: 0,
    },
  ];

  while (stack.length > 0) {
    const frame = stack.pop();
    if (!frame) break;
    const { a, b, pathA, pathB, depth } = frame;

    // nodesVisited increments in exactly one place: on pop. Nothing else
    // may touch it. Any branch that needs to account for a subtree it did
    // not individually walk must use nodesBulkReported instead.
    nodesVisited++;

    const verdict = compareNodes(a, b);

    if (verdict === "identical") {
      // This node itself was already counted in nodesVisited above.
      // subtreeSize includes the node itself, so only its DESCENDANTS were
      // actually skipped -- subtreeSize - 1. Without the -1, every fast-path
      // hit double-counts its own root and the three-bucket partition no
      // longer sums to traceASize.
      nodesSkipped += a.subTreeSize - 1;
      continue;
    }

    if (verdict === "noise") {
      diffs.push({
        type: "modified",
        pathA,
        pathB,
        nodeA: a.trace,
        nodeB: b.trace,
        significance: "noise",
        description:
          "Subtree differs only in fields normalized away by active rules (e.g. timestamps, rotated IDs).",
        depth,
        affectedSubtreeSize: a.subTreeSize,
      });
      // Hash-verified match after normalization -- real Merkle savings.
      nodesSkipped += a.subTreeSize - 1; // -1: node itself already visited
      continue;
    }

    // verdict === "diverges" past this point.

    if (depth > maxDepth) {
      depthCapped++;
      diffs.push({
        type: "modified",
        pathA,
        pathB,
        nodeA: a.trace,
        nodeB: b.trace,
        significance: "uncertain",
        description: "Subtree differs but was not fully explored (depth limit reached).",
        depth,
        affectedSubtreeSize: a.subTreeSize,
      });
      // Descendants below the cap were never pushed as frames. They are
      // reported (as part of this capped diff) but not visited and not
      // Merkle-skipped. -1: this node itself was already counted above.
      nodesBulkReported += a.subTreeSize - 1;
      continue;
    }

    // Own-node field diff -- checked at EVERY node, not just leaves, and
    // aggregated into ONE DiffResult per node (not one per field): the
    // requested schema carries nodeA/nodeB rather than a single field, so
    // multiple changed fields on the same node collapse into one entry
    // with a worst-case significance rollup and a description listing each.
    const ownDiff = buildOwnNodeDiff(a, b, pathA, pathB, depth, rules);
    if (ownDiff) diffs.push(ownDiff);

    const { matched, removed, added } = matchChildren(a.children, b.children);

    for (const [childA, childB] of matched) {
      stack.push({
        a: childA,
        b: childB,
        pathA: [...pathA, childA.trace.label],
        pathB: [...pathB, childB.trace.label],
        depth: depth + 1,
      });
    }

    for (const child of removed) {
      diffs.push({
        type: "removed",
        pathA: [...pathA, child.trace.label],
        pathB,
        nodeA: child.trace,
        significance: "semantic",
        description: `"${child.trace.label}" removed.`,
        depth: depth + 1,
        affectedSubtreeSize: child.subTreeSize,
      });
      // Removed children are reported whole and never pushed as frames.
      // No -1 here: none of these descendants (including the child itself)
      // was ever counted in nodesVisited.
      nodesBulkReported += child.subTreeSize;
    }

    for (const child of added) {
      diffs.push({
        type: "added",
        pathA,
        pathB: [...pathB, child.trace.label],
        nodeB: child.trace,
        significance: "semantic",
        description: `"${child.trace.label}" added.`,
        depth: depth + 1,
        affectedSubtreeSize: child.subTreeSize,
      });
      // Added children exist only in trace B. They do not affect trace A's
      // partition, so no counter is touched.
    }
  }

  return { diffs, nodesVisited, nodesSkipped, nodesBulkReported, depthCapped };
}

// Compares this node's own RAW attributes (not the normalized/rounded copy
// -- classify() rules like numeric-tolerance need the real pre-rounding
// numbers), classifies each changed field independently, then rolls the
// per-field verdicts up into one DiffResult: semantic beats uncertain
// beats noise, so the node is only as "safe" as its worst field.
function buildOwnNodeDiff(
  a: MerkleNode,
  b: MerkleNode,
  pathA: string[],
  pathB: string[],
  depth: number,
  rules: EquivalenceRule[],
): DiffResult | undefined {
  const keys = new Set([...Object.keys(a.trace.attributes), ...Object.keys(b.trace.attributes)]);

  const fieldVerdicts: Array<{
    field: string;
    valueA: unknown;
    valueB: unknown;
    significance: import("./type.js").Significance;
    classifiedBy?: string;
  }> = [];

  for (const field of keys) {
    const valueA = a.trace.attributes[field];
    const valueB = b.trace.attributes[field];
    if (canonicalSerialize(valueA) === canonicalSerialize(valueB)) continue;

    const rawDiff: RawDiff = {
      pathA,
      pathB,
      nodeA: a.trace,
      nodeB: b.trace,
      field,
      valueA,
      valueB,
    };
    const significance = classifyDiff(rawDiff, rules);
    const classifiedBy = rules.find((r) => r.classify?.(rawDiff))?.name;
    fieldVerdicts.push({
      field,
      valueA,
      valueB,
      significance,
      ...(classifiedBy ? { classifiedBy } : {}),
    });
  }

  if (fieldVerdicts.length === 0) return undefined;

  const worst = fieldVerdicts.reduce((acc, v) =>
    SIGNIFICANCE_RANK[v.significance] > SIGNIFICANCE_RANK[acc.significance] ? v : acc,
  );

  const description = fieldVerdicts
    .map(
      (v) =>
        `${v.field}: ${canonicalSerialize(v.valueA)} → ${canonicalSerialize(v.valueB)} (${v.significance}${v.classifiedBy ? ` via ${v.classifiedBy}` : ""})`,
    )
    .join("; ");

  return {
    type: "modified",
    pathA,
    pathB,
    nodeA: a.trace,
    nodeB: b.trace,
    significance: worst.significance,
    ...(worst.classifiedBy ? { classifiedBy: worst.classifiedBy } : {}),
    description,
    depth,
    affectedSubtreeSize: a.subTreeSize,
  };
}
