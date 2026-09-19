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

/**
 * Segments that unambiguously mark a wall-clock instant wherever they
 * appear in a key — e.g. "timestamp_raw", "timestamp_ms",
 * "db.timestamp_iso". Deliberately narrow: generic words like "time" or
 * "date" are NOT matched here, so "time_zone" or "date_of_birth" (a zone,
 * a birth date — not instants of this run) stay semantic. Those keep the
 * leaf-only behavior above.
 */
const INSTANT_MARKERS = new Set(["timestamp", "timestamps"]);

export const TIMESTAMP_TOKEN = "__TIMESTAMP__";

export function isTimestampKey(key: string): boolean {
  const segments = key.split(/[._]/);
  const leaf = segments[segments.length - 1]?.toLowerCase() ?? "";
  if (TIMESTAMP_LEAVES.has(leaf)) return true;
  return segments.some((seg) => INSTANT_MARKERS.has(seg.toLowerCase()));
}

export const ignoreTimestamps = (): EquivalenceRule => ({
  name: "ignore-timestamps",
  description: "Ignores timestamp fields",
  fuse: { kind: "ignore-timestamps" },

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
