import type { EquivalenceRule, RawDiff } from "./type.js";

export interface NumericToleranceRuleConfig {
  relativeTolerance?: number;
}

/**
 * Two-stage design:
 *
 * 1. normalize() BUCKETS numbers in log space so values within tolerance
 *    collapse to the same representative. The previous "round to N decimals"
 *    approach did nothing for integers — Math.round(45 * 100) / 100 === 45 —
 *    so jitter on duration_ms (integer) was never normalized and no subtree
 *    could be Merkle-skipped.
 *
 * 2. classify() does the precise relative-tolerance comparison on the small
 *    number of fields that survive to become a localized diff. Bucketing has
 *    boundary artifacts (two values within tolerance can straddle a bucket
 *    edge), so classify() is the correctness backstop.
 */
export const makeNumericTolerance = (options: NumericToleranceRuleConfig): EquivalenceRule => {
  const relativeTolerance = options.relativeTolerance ?? 0.05;
  const logBucketSize = 2 * Math.log1p(relativeTolerance);

  return {
    name: "numeric-tolerance",
    description: `Numeric tolerance ±${(relativeTolerance * 100).toFixed(1)}%`,
    normalize(node) {
      const attributes: Record<string, unknown> = {};
      for (const [key, value] of Object.entries(node.attributes)) {
        attributes[key] =
          typeof value === "number" && Number.isFinite(value) && value !== 0
            ? bucketNumber(value, logBucketSize)
            : value;
      }
      return { ...node, attributes };
    },
    classify(diff: RawDiff) {
      const { valueA, valueB } = diff;
      if (typeof valueA !== "number" || typeof valueB !== "number") {
        return undefined;
      }
      if (valueA === 0 && valueB === 0) {
        return "noise";
      }
      const denom = Math.max(Math.abs(valueA), Math.abs(valueB));
      if (denom === 0) return "noise";
      const relativeDiff = Math.abs(valueA - valueB) / denom;
      return relativeDiff <= relativeTolerance ? "noise" : "semantic";
    },
  };
};

/**
 * Maps a number to a canonical representative of its log-magnitude bucket.
 * Two values a, b with |a-b|/max(|a|,|b|) ≤ tolerance usually map to the
 * same bucket (modulo boundary effects, corrected in classify()).
 */
function bucketNumber(value: number, logBucketSize: number): number {
  const sign = value < 0 ? -1 : 1;
  const abs = Math.abs(value);
  const bucket = Math.round(Math.log(abs) / logBucketSize);
  // Canonical representative: the exponential midpoint of the bucket.
  return sign * Math.exp(bucket * logBucketSize);
}
