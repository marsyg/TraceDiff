import { createHash } from "node:crypto";
import { applyRules, shouldSortChildren } from "../rules/registry.js";
import type { EquivalenceRule } from "../rules/type.js";
import { canonicalSerialize } from "./hash.js";
import type { MerkleNode, TraceNode } from "./type.js";

export type { MerkleNode };

export function buildMerkleTree(node: TraceNode, rules: EquivalenceRule[]): MerkleNode {
  const normalized = applyRules(node, rules);

  // Build children from the RAW node's children, not the normalized copy —
  // none of the current rules touch `children` so today these are the same
  // array by reference, but iterate from `node` explicitly so that stays
  // true even if a future rule (e.g. a "collapse retries" rule) starts
  // adding/removing/reordering children in normalize().
  let childNodes = node.children.map((child) => buildMerkleTree(child, rules));

  if (shouldSortChildren(normalized, rules)) {
    // Sort ONCE, then use this same order for both hash computations below.
    // Sorting raw and normalized children independently would let the two
    // hashes drift out of sync with each other for reasons that have
    // nothing to do with an actual diff.
    childNodes = [...childNodes].sort((a, b) => {
      const byLabel = a.trace.label.localeCompare(b.trace.label);
      return byLabel !== 0 ? byLabel : a.normalizedHash.localeCompare(b.normalizedHash);
    });
  }

  const normalizedContent = canonicalSerialize({
    type: normalized.type,
    label: normalized.label,
    attributes: normalized.attributes,
  });
  const rawContent = canonicalSerialize({
    type: node.type,
    label: node.label,
    attributes: node.attributes,
  });

  const normalizedHash = createHash("sha256")
    .update(normalizedContent)
    .update(childNodes.map((c) => c.normalizedHash).join(""))
    .digest("hex");

  const rawHash = createHash("sha256")
    .update(rawContent)
    .update(childNodes.map((c) => c.rawHash).join(""))
    .digest("hex");
  const subTreeSize = 1 + childNodes.reduce((n, c) => n + c.subTreeSize, 0);

  return { normalizedHash, rawHash, trace: node, children: childNodes, subTreeSize };
}

export type MatchVerdict = "identical" | "noise" | "diverges";

// The entry point the diff walker actually calls at each pair of aligned
// nodes:
//   - "diverges"  → normalizedHash differs → recurse into children, this is
//                    where real (red) diffs get localized
//   - "noise"     → normalizedHash matches but rawHash doesn't → color this
//                    subtree yellow, STOP recursing for diff purposes (it's
//                    already classified as noise), the raw trace is kept on
//                    the node if the UI wants to show exact values on click
//   - "identical" → both match → color green, stop, nothing to show at all
export function compareNodes(a: MerkleNode, b: MerkleNode): MatchVerdict {
  if (a.normalizedHash !== b.normalizedHash) return "diverges";
  return a.rawHash === b.rawHash ? "identical" : "noise";
}

// Optional refinement, not required for MVP: within a "noise" subtree, find
// the exact leaf-level nodes that actually differ, instead of just coloring
// the whole subtree root yellow. Safe to bolt on later — it's the same
// top-down pruning trick, just walking rawHash instead of normalizedHash,
// and only ever runs inside subtrees already confirmed to be noise (so it's
// bounded by the size of the actual noise, not the whole trace).
export function findNoisyLeaves(
  a: MerkleNode,
  b: MerkleNode,
  path: string[] = [],
): Array<{ path: string[]; a: MerkleNode; b: MerkleNode }> {
  if (a.rawHash === b.rawHash) return []; // nothing differs at or below here
  if (a.children.length === 0 && b.children.length === 0) {
    return [{ path, a, b }]; // bottomed out — this leaf is the noisy one
  }
  const results: Array<{ path: string[]; a: MerkleNode; b: MerkleNode }> = [];
  const len = Math.min(a.children.length, b.children.length);
  for (let i = 0; i < len; i++) {
    const childA = a.children[i];
    const childB = b.children[i];
    if (!childA || !childB) continue;
    results.push(...findNoisyLeaves(childA, childB, [...path, String(i)]));
  }
  return results;
}
