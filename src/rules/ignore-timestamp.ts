import type { EquivalenceRule } from "./type.js";

const TIMESTAMP_KEYS = new Set([
  "timestamp",
  "time",
  "created_at",
  "updated_at",
  "ts",
  "recorded_at",
]);

/**
 * Equivalence rule that neutralizes wall-clock timestamp variance.
 *
 * Real executions inevitably record different timestamps due to CPU scheduling,
 * clock drift, and invocation intervals. Rather than deleting the field, this
 * rule replaces timestamp values with a fixed sentinel token (`__TIMESTAMP__`).
 * This preserves schema structure and field presence while allowing identical
 * execution flows to produce identical Merkle hashes (noise isolation).
 */
export const ignoreTimestamps = (): EquivalenceRule => ({
  name: "ignore-timestamps",
  description: "Ignores timestamp fields",
  normalize(node) {
    const attributes: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(node.attributes)) {
      if (TIMESTAMP_KEYS.has(key.toLowerCase())) {
        attributes[key] = "__TIMESTAMP__";
      } else {
        attributes[key] = value;
      }
    }
    return { ...node, attributes };
  },
});
