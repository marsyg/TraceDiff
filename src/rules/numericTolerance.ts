import type { EquivalenceRule, RawDiff } from "./type";

export interface NumericToleranceRuleConfig {
  relativeTolerance?: number;
}

// This is a two-stage design, deliberately not a single hash-bucketing pass:
//
// 1. normalize() rounds to a fixed precision before hashing. This is cheap
//    and catches most jitter (45ms vs 45.2ms), but hash-bucketing has
//    boundary artifacts — two values just barely on opposite sides of a
//    rounding boundary can still hash differently even though they're
//    within tolerance. That's fine, because:
// 2. classify() does the REAL relative-tolerance comparison, but only runs
//    on the small number of fields that survive to become an actual
//    localized diff — not on every node during the Merkle build. Cheap
//    where it needs to be fast, precise where precision actually matters

export const makeNumericTolerance = (options: NumericToleranceRuleConfig): EquivalenceRule => {
  const relativeTolerance = options.relativeTolerance ?? 0.05;

  const precision = Math.max(0, Math.floor(Math.log10(relativeTolerance))) + 2;

  return {
    name: "numeric-tolerance",
    description: "Tolerance for floating point values",
    normalize(node) {
      const attributes: Record<string, unknown> = {};
      for (const [key, value] of Object.entries(node.attributes)) {
        attributes[key] = typeof value === "number" ? roundTo(value, precision) : value;
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
      const relativeDiff = Math.abs(valueA - valueB) / denom;
      return relativeDiff <= relativeTolerance ? "noise" : "semantic";
    },
  };
};

function roundTo(value: number, precision: number): number {
  if (!Number.isFinite(value)) return value;

  if (!Number.isFinite(precision)) {
    precision = 0;
  }

  precision = Math.max(0, Math.floor(precision));

  const factor = 10 ** precision;

  // Prevent overflow from extremely large precision values
  if (!Number.isFinite(factor)) return value;

  return Math.round(value * factor) / factor;
}
