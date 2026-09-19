import { type DiffWalkResult, diffTrees } from "../src/core/diff.js";
import { buildMerkleTree } from "../src/core/merkle-tree.js";
import type { TraceNode } from "../src/core/type.js";
import { buildRuleSet, type RuleSetOptions } from "../src/rules/registry.js";
import type { EquivalenceRule } from "../src/rules/type.js";

/**
 * Build a TraceNode with subtreeSize computed from children.
 * `children` is the only thing that matters for size — depth is derived below.
 */
export function node(
  label: string,
  attrs: Record<string, unknown> = {},
  children: TraceNode[] = [],
  type = "span",
): TraceNode {
  return {
    id: `${label}-id`,
    type,
    label,
    attributes: attrs,
    children,
    depth: 0, // fixed up by `withDepth`
    subtreeSize: 1 + children.reduce((n, c) => n + (c.subtreeSize ?? 0), 0),
    raw: undefined,
  };
}

/** Assign correct depths top-down. Call once on a root before running the pipeline. */
export function withDepth(n: TraceNode, d = 0): TraceNode {
  n.depth = d;
  for (const c of n.children) withDepth(c, d + 1);
  return n;
}

/** Deep clone a tree (structured clone keeps it simple). */
export function clone(n: TraceNode): TraceNode {
  return structuredClone(n);
}

/** Helper to create rule sets with optional rule names and config. */
export function createRules(
  ruleNames?: string[],
  options?: Omit<RuleSetOptions, "ruleNames">,
): EquivalenceRule[] {
  return buildRuleSet({ ...options, ...(ruleNames !== undefined ? { ruleNames } : {}) });
}

export interface RunResult extends DiffWalkResult {
  traceASize: number;
  /** Sum of the three accounting buckets. Must equal traceASize. */
  partitionSum: number;
}

export function runDiff(
  a: TraceNode,
  b: TraceNode,
  ruleNames: string[] = [],
  config?: { maxDepth?: number },
): RunResult {
  const rules = createRules(ruleNames, {});
  const ma = buildMerkleTree(a, rules);
  const mb = buildMerkleTree(b, rules);
  const walk = diffTrees(ma, mb, rules, config ?? {});

  // `subtreeSize` was computed on the TraceNode already; use it directly.
  const traceASize = a.subtreeSize ?? 0;
  const partitionSum = walk.nodesVisited + walk.nodesSkipped + walk.nodesBulkReported;

  return { ...walk, traceASize, partitionSum };
}

/** Find a diff by path suffix (helps write resilient assertions). */
export function findByPath<T extends { pathA?: string[]; pathB?: string[] }>(
  diffs: T[],
  label: string,
): T | undefined {
  return diffs.find(
    (d) =>
      (d.pathA && d.pathA[d.pathA.length - 1] === label) ||
      (d.pathB && d.pathB[d.pathB.length - 1] === label),
  );
}
