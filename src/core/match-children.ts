import type { MerkleNode } from "./type.js";

export interface ChildMatchResult {
  /** Paired children to be compared recursively or checked for divergence. */
  matched: Array<[MerkleNode, MerkleNode]>;
  /** Children present in trace A with no counterpart in trace B (deleted). */
  removed: MerkleNode[];
  /** Children present in trace B with no counterpart in trace A (inserted). */
  added: MerkleNode[];
}

/**
 * Aligns child nodes between two trace spans using a two-pass linear-time matcher.
 *
 * Sibling alignment is critical for avoiding false "add + remove" pairs when a node
 * is simply modified. A naive quadratic comparison would degrade on high fan-out spans
 * (e.g. thousands of concurrent async calls). This implementation runs in O(k) average
 * time (where k = |a| + |b|) by using hash-indexed buckets and FIFO consumption.
 *
 * Alignment strategy:
 *  1. Exact Semantic Match (normalizedHash):
 *     Pairs nodes that are semantically identical (or differing only in harmless noise).
 *     These pairs can be skipped or classified immediately by the diff engine.
 *  2. Heuristic Structural Match (label):
 *     Pairs remaining unmatched nodes sharing the same operation name/span label.
 *     This allows the diff engine to descend into the pair and report pinpointed
 *     attribute modifications rather than emitting spurious delete + insert diffs.
 */
export function matchChildren(a: MerkleNode[], b: MerkleNode[]): ChildMatchResult {
  const matched: Array<[MerkleNode, MerkleNode]> = [];

  // Pass 1: Bucket B children by normalizedHash for O(1) exact-match lookups.
  // Using an array bucket with FIFO shift preserves relative ordering when
  // identical operations occur multiple times among siblings.
  const byHash = new Map<string, MerkleNode[]>();
  for (const child of b) {
    const bucket = byHash.get(child.normalizedHash);
    if (bucket) {
      bucket.push(child);
    } else {
      byHash.set(child.normalizedHash, [child]);
    }
  }

  const unmatchedA: MerkleNode[] = [];
  for (const childA of a) {
    const bucket = byHash.get(childA.normalizedHash);
    const childB = bucket?.shift();
    if (childB) {
      matched.push([childA, childB]);
    } else {
      unmatchedA.push(childA);
    }
  }

  // Children remaining in hash buckets were not claimed by any identical A child;
  // they represent either modified operations or newly added operations.
  const unmatchedB = [...byHash.values()].flat();

  // Pass 2: Bucket remaining B children by label to correlate modified operations.
  // When a child's attributes or descendants change, its hash diverges. Matching by
  // label ensures we align "same operation with modified content" instead of reporting
  // an unrelated addition and deletion.
  const unmatchedBByLabel = new Map<string, MerkleNode[]>();
  for (const child of unmatchedB) {
    const bucket = unmatchedBByLabel.get(child.trace.label);
    if (bucket) {
      bucket.push(child);
    } else {
      unmatchedBByLabel.set(child.trace.label, [child]);
    }
  }

  const removed: MerkleNode[] = [];
  for (const childA of unmatchedA) {
    const bucket = unmatchedBByLabel.get(childA.trace.label);
    const childB = bucket?.shift();
    if (childB) {
      matched.push([childA, childB]);
    } else {
      // No counterpart in B with matching semantics or label: operation was removed.
      removed.push(childA);
    }
  }

  // Any B nodes remaining after label matching are genuine additions in trace B.
  const added = [...unmatchedBByLabel.values()].flat();

  return { matched, removed, added };
}
