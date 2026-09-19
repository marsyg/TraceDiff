import { describe, expect, test } from "bun:test";
import { generateTraces } from "../src/bench/generate";
import { compareTraces } from "../src/core/compare-traces";
import { buildRuleSet } from "../src/rules/registry";

/**
 * The generator is the oracle for every "noise immunity" claim in the repo.
 * If this test fails, the CLI's demo numbers are wrong. Run it before every
 * commit that touches rules, the generator, or the diff engine.
 */
describe("generator ↔ diff round-trip", () => {
  test("500 nodes / 4 diffs / seed 7 → exactly 4 semantic diffs", () => {
    const { traceA, traceB, expectedDiffs } = generateTraces({
      size: 500,
      diffs: 4,
      seed: 7,
    });

    const summary = compareTraces(traceA, traceB, {
      buildRules: () => buildRuleSet(),
    });

    expect(summary.semantic).toHaveLength(expectedDiffs.semantic.length);
    expect(summary.semantic.length).toBe(4);
  });

  test("1000 nodes / 3 diffs / seed 42 → exactly 3 semantic diffs", () => {
    const { traceA, traceB, expectedDiffs } = generateTraces({
      size: 1000,
      diffs: 3,
      seed: 42,
    });

    const summary = compareTraces(traceA, traceB, {
      buildRules: () => buildRuleSet(),
    });

    expect(summary.semantic).toHaveLength(expectedDiffs.semantic.length);
  });

  test("noise-only generator (0 diffs) produces 0 semantic diffs", () => {
    const { traceA, traceB } = generateTraces({ size: 400, diffs: 0, seed: 11 });

    const summary = compareTraces(traceA, traceB, {
      buildRules: () => buildRuleSet(),
    });

    expect(summary.semantic).toHaveLength(0);
  });

  test("skip percentage exceeds 90% on a mid-size trace", () => {
    const { traceA, traceB } = generateTraces({ size: 500, diffs: 3, seed: 3 });

    const summary = compareTraces(traceA, traceB, {
      buildRules: () => buildRuleSet(),
    });

    expect(summary.skipPercentage).toBeGreaterThan(90);
  });
});
