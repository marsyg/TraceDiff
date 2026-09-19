import type { TraceNode } from "../core/type.js";
import type { EquivalenceRule } from "./type.js";

// This rule doesn't touch attributes — its only job is to answer "should
// this node's children be treated as unordered?" The actual sort (by label,
// then by hash as a tiebreak) happens once, in the Merkle builder, after
// child hashes are known — not here, because this rule has no access to
// child hashes at normalize() time.
//
// You need to supply isConcurrent yourself: it depends on your trace
// schema (e.g. a span with attributes.concurrent === true, or a parent
// type of "parallel_group"). No universal default makes sense.
export const makeSortConcurrent = (isConcurrent: (node: TraceNode) => boolean): EquivalenceRule => {
  return {
    name: "sort-concurrent",
    description: "Sorts concurrent nodes",
    normalize: (node: TraceNode) => {
      return node;
    },
    shouldSortChildren: (node: TraceNode) => {
      return isConcurrent(node);
    },
  };
};
