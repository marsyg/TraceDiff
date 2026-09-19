// Core type definitions for TraceDiff.
// Shared across the core engine, rules, parsers, CLI, and benchmarking utilities.

/**
 * Canonical unified execution event tree for TraceDiff.
 * Parsers convert various raw trace formats (OpenTelemetry, flat spans, nested JSON)
 * into this normalized hierarchical structure.
 */
export interface TraceNode {
  id: string;
  type: string; // "span" | "call" | "log" | "state_change" | "parallel"
  label: string;
  attributes: Record<string, unknown>;
  children: TraceNode[];
  depth?: number;
  subtreeSize?: number;
  raw?: unknown;
}

export interface MerkleNode {
  // Hash of the NORMALIZED content (post-rules). Two nodes with the same
  // normalizedHash are semantically equivalent — this is what the diff
  // walker uses to skip subtrees and localize real (red) divergence.
  normalizedHash: string;

  // Hash of the RAW, unnormalized content. Two nodes can have equal
  // normalizedHash but different rawHash — that's exactly the "noise"
  // case (yellow): something genuinely changed (a timestamp, a rotated
  // ID, a jittery latency number) but a rule decided it doesn't matter.
  // Without this second hash there is no way to tell "truly identical"
  // (green) apart from "identical after normalization" (yellow) — both
  // would just look like a silent match.
  rawHash: string;

  trace: TraceNode; // original, unnormalized node — kept for display
  subTreeSize: number;
  children: MerkleNode[];
}

export type DiffType = "added" | "removed" | "modified" | "moved" | "reordered";

/**
 * Categorization of divergence between trace nodes:
 * - "semantic": A genuine behavioral change (e.g., HTTP 200 vs 500, missing query, state regression).
 * - "noise": Non-behavioral variation that matches active equivalence rules (e.g., timestamp jitter, rotated UUIDs).
 * - "uncertain": Divergence whose behavioral significance cannot be definitively established (e.g., depth limit capped).
 */
export type Significance = "semantic" | "noise" | "uncertain";

export interface DiffResult {
  type: DiffType;
  pathA?: string[];
  pathB?: string[];
  nodeA?: TraceNode;
  nodeB?: TraceNode;
  significance: Significance;
  classifiedBy?: string; // Rule name that classified the divergence
  description: string;
  depth: number;
  affectedSubtreeSize: number;
}
export interface FieldChange {
  field: string;
  kind: "added" | "removed" | "modified";
  valueA?: unknown;
  valueB?: unknown;
  significance: Significance;
  classifiedBy?: string;
}

/**
 * Comprehensive execution summary for a diff run.
 *
 * Three mutually exclusive buckets partition trace A exactly once:
 *   traceASize === nodesVisited + nodesSkipped + nodesBulkReported
 *
 * - nodesVisited: Frames popped and inspected directly.
 * - nodesSkipped: Subtrees skipped via Merkle hash matches (identical or noise).
 * - nodesBulkReported: Subtree descendants emitted en-masse (e.g. removed or depth-capped).
 *
 * skipPercentage measures Merkle hashing efficiency: nodesSkipped / traceASize.
 */
export interface DiffSummary {
  traceASize: number;
  traceBSize: number;
  nodesVisited: number;
  nodesSkipped: number;
  nodesBulkReported: number;
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

export interface EquivalenceRule {
  name: string;
  description: string;
  priority: number; // Lower priority numbers are evaluated earlier
  normalize(node: TraceNode): TraceNode;
  shouldSortChildren?(node: TraceNode): boolean;
  childSortKey?(child: TraceNode): string;
  classify?(nodeA: TraceNode, nodeB: TraceNode): Significance | null;
}

export interface TraceDiffConfig {
  rules: string[];
  ruleConfig: Record<string, Record<string, unknown>>;
  maxDepth: number; // Default: 1000
  maxChildrenForFullMatch: number; // Default: 10000
  hashAlgorithm: "sha256" | "xxhash64";
  outputFormat: "terminal" | "json" | "html";
  includeNoise: boolean;
}
