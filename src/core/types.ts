// Core type definitions for TraceDiff.
// Shared across the core engine, rules, parsers, CLI, and benchmarking utilities.

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
  hash: string; // H(normalize(content) || childHashes)
  trace: TraceNode;
  children: MerkleNode[];
  subtreeSize: number;
}

export type DiffType = "added" | "removed" | "modified" | "moved" | "reordered";
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

export interface DiffSummary {
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
