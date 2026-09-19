import type { EquivalenceRule, RawDiff } from "./type.js";

/**
 * Leaf segment(s) of an attribute key that identify a timestamp.
 * Tested against the final segment after splitting on "." or "_",
 * so "db.timestamp", "span.start_time", "ts", and "created_at" all match.
 */
const TIMESTAMP_LEAVES = new Set([
  "timestamp",
  "time",
  "ts",
  "date",
  "start_time",
  "end_time",
  "started_at",
  "finished_at",
  "created_at",
  "updated_at",
  "recorded_at",
]);

const TIMESTAMP_TOKEN = "__TIMESTAMP__";

function isTimestampKey(key: string): boolean {
  const leaf = key.split(/[._]/).pop()?.toLowerCase() ?? "";
  return TIMESTAMP_LEAVES.has(leaf);
}

export const ignoreTimestamps = (): EquivalenceRule => ({
  name: "ignore-timestamps",
  description: "Ignores timestamp fields",

  normalize(node) {
    const attributes: Record<string, unknown> = {};
    let mutated = false;
    for (const [key, value] of Object.entries(node.attributes)) {
      if (isTimestampKey(key)) {
        if (value !== TIMESTAMP_TOKEN) mutated = true;
        attributes[key] = TIMESTAMP_TOKEN;
      } else {
        attributes[key] = value;
      }
    }
    return mutated ? { ...node, attributes } : node;
  },

  classify(diff: RawDiff): "noise" | undefined {
    if (!diff.field || !isTimestampKey(diff.field)) return undefined;
    return diff.valueA === diff.valueB ? undefined : "noise";
  },
});
