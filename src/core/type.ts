//All type definitions
export interface TraceNode {
  id: string;
  type: string; // "span" | "call" | "log" | "state_change"
  label: string; // function name, span name
  attributes: Record<string, unknown>;
  children: TraceNode[];
  depth: number; // 0 = root
  subtreeSize: number; // count of all descendants + self
}

export interface MerkleNode {
  hash: string; // H(normalized_content + children_hashes)
  trace: TraceNode;
  children: MerkleNode[];
  subtreeSize: number;
}

export type DiffType = "added" | "removed" | "modified" | "moved" | "reordered";
export type Significance = "semantic" | "noise" | "uncertain";

export interface DiffResult {
  type: DiffType;
  pathA?: string[]; // absent for "added"
  pathB?: string[]; // absent for "removed"
  nodeA?: TraceNode;
  nodeB?: TraceNode;
  significance: Significance;
  classifiedBy?: string; // rule name
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

export interface TraceDiffConfig {
  rules: string[];
  ruleConfig: Record<string, Record<string, unknown>>;
  maxDepth: number; // default: 1000
  maxChildrenForFullMatch: number; // default: 10000
  hashAlgorithm: "sha256" | "xxhash64";
  outputFormat: "terminal" | "json" | "html";
  includeNoise: boolean;
}
