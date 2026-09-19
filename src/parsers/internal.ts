import type { TraceNode } from "../core/type.js";

/**
 * Walk a fully-linked tree and fill in `depth` and `subtreeSize` on every
 * node. Called once by each parser after the tree is assembled. Mutates in
 * place and returns the root for chaining.
 */
export function finalize(node: TraceNode, depth = 0): TraceNode {
  node.depth = depth;
  let size = 1;
  for (const child of node.children) {
    finalize(child, depth + 1);
    size += child.subtreeSize ?? 0;
  }
  node.subtreeSize = size;
  return node;
}

export function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}
