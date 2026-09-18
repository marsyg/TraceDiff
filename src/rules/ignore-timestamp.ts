import type { EquivalenceRule } from "./type";

const TIMESTAMP_KEYS = new Set([
  "timestamp",
  "time",
  "created_at",
  "updated_at",
  "ts",
  "recorded_at",
]);

export const ignoreTimestamps = (): EquivalenceRule => ({
  name: "ignore-timestamp",
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
