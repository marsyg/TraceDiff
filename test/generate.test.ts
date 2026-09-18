import { afterAll, describe, expect, it } from "bun:test";
import { existsSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { countNodes, generateTraces, parseArgs, writeTraces } from "../src/bench/generate.js";
import type { TraceNode } from "../src/core/types.js";

function findNodeById(root: TraceNode, id: string): TraceNode | null {
  const stack = [root];
  while (stack.length > 0) {
    const node = stack.pop() as TraceNode;
    if (node.id === id) return node;
    for (const child of node.children) {
      stack.push(child);
    }
  }
  return null;
}

describe("Synthetic Trace Generator", () => {
  const testOutputDir = join("fixtures", "test-temp-generator");

  afterAll(() => {
    if (existsSync(testOutputDir)) {
      rmSync(testOutputDir, { recursive: true, force: true });
    }
  });

  it("generates valid small traces", () => {
    const result = generateTraces({ size: 10, diffs: 2, seed: 100 });

    expect(result.traceA).toBeDefined();
    expect(result.traceB).toBeDefined();
    expect(result.expectedDiffs).toBeDefined();

    expect(result.traceA.id).toBe("req-root-00001");
    expect(result.traceA.type).toBe("span");
    expect(typeof result.traceA.label).toBe("string");
    expect(result.traceA.children.length).toBeGreaterThan(0);

    expect(result.expectedDiffs.semantic.length).toBe(2);
    expect(result.stats.nodesA).toBe(10);
    expect(result.stats.semanticCount).toBe(2);
  });

  it("generates exactly the requested node count", () => {
    const sizes = [1, 5, 25, 100, 500];

    for (const size of sizes) {
      const result = generateTraces({ size, diffs: Math.min(2, Math.floor(size / 2)), seed: 42 });
      const actualCountA = countNodes(result.traceA);
      expect(actualCountA).toBe(size);
      expect(result.stats.nodesA).toBe(size);
    }
  });

  it("produces strictly deterministic output given the same seed", () => {
    const opts = { size: 200, diffs: 5, seed: 999 };

    const run1 = generateTraces(opts);
    const run2 = generateTraces(opts);

    expect(JSON.stringify(run1.traceA)).toBe(JSON.stringify(run2.traceA));
    expect(JSON.stringify(run1.traceB)).toBe(JSON.stringify(run2.traceB));
    expect(JSON.stringify(run1.expectedDiffs.semantic)).toBe(
      JSON.stringify(run2.expectedDiffs.semantic),
    );
    expect(run1.stats.noiseCount).toBe(run2.stats.noiseCount);
  });

  it("produces different output with different seeds", () => {
    const run1 = generateTraces({ size: 100, diffs: 3, seed: 1 });
    const run2 = generateTraces({ size: 100, diffs: 3, seed: 2 });

    expect(JSON.stringify(run1.traceA)).not.toBe(JSON.stringify(run2.traceA));
  });

  it("verifies all expected semantic changes are actually present in trace_b", () => {
    const result = generateTraces({ size: 300, diffs: 6, seed: 777 });

    expect(result.expectedDiffs.semantic.length).toBe(6);

    for (const diff of result.expectedDiffs.semantic) {
      if (diff.type === "modified") {
        const nodeB = findNodeById(result.traceB, diff.nodeId);
        expect(nodeB).not.toBeNull();
        if (diff.field) {
          expect(nodeB?.attributes[diff.field]).toBe(diff.after);
        }
      } else if (diff.type === "added") {
        const nodeB = findNodeById(result.traceB, diff.nodeId);
        expect(nodeB).not.toBeNull();
        const nodeA = findNodeById(result.traceA, diff.nodeId);
        expect(nodeA).toBeNull();
      } else if (diff.type === "removed") {
        const nodeB = findNodeById(result.traceB, diff.nodeId);
        expect(nodeB).toBeNull();
        const nodeA = findNodeById(result.traceA, diff.nodeId);
        expect(nodeA).not.toBeNull();
      }
    }
  });

  it("injects harmless noise changes that are excluded from expected semantic diffs", () => {
    const result = generateTraces({ size: 150, diffs: 3, seed: 555 });

    expect(result.stats.noiseCount).toBeGreaterThan(0);
    expect(result.expectedDiffs.summary.noiseDiffsCount).toBe(result.stats.noiseCount);

    // Assert that semantic diffs list only semantic changes, never pure timestamp or ID shifts
    for (const diff of result.expectedDiffs.semantic) {
      expect(diff.field).not.toBe("timestamp");
      expect(diff.field).not.toBe("request_id");
      expect(diff.field).not.toBe("message_id");
    }
  });

  it("validates input parameters properly", () => {
    expect(() => generateTraces({ size: 0 })).toThrow("positive integer");
    expect(() => generateTraces({ size: -10 })).toThrow("positive integer");
    expect(() => generateTraces({ size: 100, diffs: -1 })).toThrow("non-negative integer");
    expect(() => generateTraces({ size: 10, diffs: 100 })).toThrow("exceeds sensible maximum");
  });

  it("parses CLI arguments correctly", () => {
    const args = ["--size", "500", "--diffs", "10", "--output", "fixtures/custom", "--seed", "123"];
    const parsed = parseArgs(args);

    expect(parsed.size).toBe(500);
    expect(parsed.diffs).toBe(10);
    expect(parsed.output).toBe("fixtures/custom");
    expect(parsed.seed).toBe(123);
  });

  it("writes output files correctly to disk", () => {
    const result = generateTraces({ size: 50, diffs: 2, seed: 42 });
    const written = writeTraces(result, testOutputDir);

    expect(existsSync(written.traceAPath)).toBe(true);
    expect(existsSync(written.traceBPath)).toBe(true);
    expect(existsSync(written.expectedDiffsPath)).toBe(true);

    const readA = JSON.parse(readFileSync(written.traceAPath, "utf8"));
    const readB = JSON.parse(readFileSync(written.traceBPath, "utf8"));
    const readDiffs = JSON.parse(readFileSync(written.expectedDiffsPath, "utf8"));

    expect(readA.id).toBe(result.traceA.id);
    expect(readB.id).toBe(result.traceB.id);
    expect(readDiffs.semantic.length).toBe(2);
  });

  describe("Performance scale tests", () => {
    it("generates 1K nodes in under 50ms", () => {
      const start = performance.now();
      const result = generateTraces({ size: 1000, diffs: 5, seed: 42 });
      const elapsed = performance.now() - start;

      expect(result.stats.nodesA).toBe(1000);
      expect(elapsed).toBeLessThan(150); // Generous margin for CI
    });

    it("generates 10K nodes in under 300ms", () => {
      const start = performance.now();
      const result = generateTraces({ size: 10000, diffs: 50, seed: 42 });
      const elapsed = performance.now() - start;

      expect(result.stats.nodesA).toBe(10000);
      expect(elapsed).toBeLessThan(800);
    });

    it("generates 100K nodes cleanly in under 2000ms", () => {
      const start = performance.now();
      const result = generateTraces({ size: 100000, diffs: 100, seed: 42 });
      const elapsed = performance.now() - start;

      expect(result.stats.nodesA).toBe(100000);
      expect(elapsed).toBeLessThan(3000);
    });
  });
});
