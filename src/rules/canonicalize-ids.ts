import type { TraceNode } from "../core/type.js";
import type { EquivalenceRule, RawDiff } from "./type.js";

/**
 * Matches attribute keys that represent identifiers:
 *   "id", "request_id", "userId", "user_id", "charge.id", "user.attributes.id"
 * The separator before "id" is either "_" or "." — the original regex only
 * accepted "_", which silently missed every namespaced field like
 * "charge.id" and made rotated IDs register as semantic diffs.
 */
const ID_FIELD_RE = /(^|[._])id$/i;

/**
 * A fixed sentinel. Deliberately NOT a counter.
 *
 * Earlier versions assigned __ID_0__, __ID_1__, ... in traversal order.
 * That made the rule ORDER-DEPENDENT: if two traces had their children in
 * different orders (concurrent spans, an upstream sort, a rule-driven
 * reorder), the same logical field received a different token in A vs B,
 * and every "noise" ID rotation was escalated to a semantic diff.
 *
 * A constant token removes the dependency entirely. The rule becomes pure,
 * so the whole "one fresh instance per trace" factory dance is unnecessary.
 */
const ID_TOKEN = "__TRACEDIFF_ID__";

export const canonicalizeIdsRule: EquivalenceRule = {
  name: "canonicalize-ids",
  description:
    "Replaces identifier-valued fields with a stable sentinel so rotated IDs are treated as noise",

  normalize(node: TraceNode): TraceNode {
    const attrs = node.attributes;
    if (!attrs || typeof attrs !== "object") return node;

    let mutated = false;
    const next: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(attrs)) {
      if (ID_FIELD_RE.test(key) && value != null && value !== ID_TOKEN) {
        next[key] = ID_TOKEN;
        mutated = true;
      } else {
        next[key] = value;
      }
    }

    return mutated ? { ...node, attributes: next } : node;
  },

  // Called per-field with a RawDiff. Just check the one field we were handed.
  classify(diff: RawDiff): "noise" | undefined {
    if (!diff.field || !ID_FIELD_RE.test(diff.field)) return undefined;
    if (diff.valueA === diff.valueB) return undefined;
    return "noise";
  },
};
