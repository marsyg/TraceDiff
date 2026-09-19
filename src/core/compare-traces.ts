import { performance } from "node:perf_hooks";
import type { EquivalenceRule } from "../rules/type.js";
import { diffTrees } from "./diff.js";
import { buildMerkleTree } from "./merkle-tree.js";
import type { DiffSummary, TraceNode } from "./type.js";

export interface CompareTracesOptions {
  // A FACTORY, not a fixed array. buildMerkleTree(A) and buildMerkleTree(B)
  // each need their own fresh rule instances -- canonicalize-ids carries
  // per-trace token state, so sharing one array across both traces would
  // leak token assignments between them. Called 3 times total here (once
  // for A's Merkle build, once for B's, once for the diff walk's classify
  // calls) -- classify() itself is stateless for every rule so far, so the
  // extra instance is just a harmless small allocation, not a correctness
  // requirement for that third call specifically.
  buildRules: () => EquivalenceRule[];
  maxDepth?: number;
  // Stages this function doesn't own: pass in if you timed them yourself
  // (parsing raw trace JSON, reconstructing nested TraceNode from a flat
  // span list). Both default to 0 since neither stage is built yet.
  parseMs?: number;
  treeBuildMs?: number;
}

export function compareTraces(
  traceA: TraceNode,
  traceB: TraceNode,
  options: CompareTracesOptions,
): DiffSummary {
  const merkleStart = performance.now();
  const merkleA = buildMerkleTree(traceA, options.buildRules());
  const merkleB = buildMerkleTree(traceB, options.buildRules());
  const merkleBuildMs = performance.now() - merkleStart;

  const diffStart = performance.now();
  const walk = diffTrees(
    merkleA,
    merkleB,
    options.buildRules(),
    options.maxDepth !== undefined ? { maxDepth: options.maxDepth } : {},
  );
  const diffMs = performance.now() - diffStart;

  const traceASize = merkleA.subTreeSize;
  const skipPercentage = traceASize > 0 ? (walk.nodesSkipped / traceASize) * 100 : 0;

  const parseMs = options.parseMs ?? 0;
  const treeBuildMs = options.treeBuildMs ?? 0;

  return {
    traceASize,
    traceBSize: merkleB.subTreeSize,
    nodesVisited: walk.nodesVisited,
    nodesSkipped: walk.nodesSkipped,
    nodesBulkReported: walk.nodesBulkReported,
    skipPercentage,
    diffs: walk.diffs,
    semantic: walk.diffs.filter((d) => d.significance === "semantic"),
    noise: walk.diffs.filter((d) => d.significance === "noise"),
    uncertain: walk.diffs.filter((d) => d.significance === "uncertain"),
    timing: {
      parseMs,
      treeBuildMs,
      merkleBuildMs,
      diffMs,
      totalMs: parseMs + treeBuildMs + merkleBuildMs + diffMs,
    },
  };
}
