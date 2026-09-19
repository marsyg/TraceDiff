import { writeFileSync } from "node:fs";
import { performance } from "node:perf_hooks";
import { compareTraces } from "../core/compare-traces.js";
import { buildRuleSet } from "../rules/registry.js";
import { generateTraces } from "./generate.js";

export interface BenchCell {
  size: number;
  diffs: number;
  seed: number;
}

export interface BenchRow {
  size: number;
  diffs: number;
  seed: number;
  nodesA: number;
  nodesB: number;
  expected: number;
  found: number;
  skipPct: number;
  genMs: number;
  merkleMs: number;
  diffMs: number;
  totalMs: number;
  memMb: number;
  passed: boolean;
  error?: string;
}

// Fixed seeds keep every run deterministic and comparable across machines.
export const DEFAULT_CELLS: BenchCell[] = [
  { size: 1000, diffs: 5, seed: 42 },
  { size: 10000, diffs: 50, seed: 7 },
  { size: 100000, diffs: 100, seed: 7 },
];

// 1M nodes needs GBs of RAM and minutes of wall time: opt-in only.
export const HUGE_CELL: BenchCell = { size: 1000000, diffs: 100, seed: 7 };

export function runCell(cell: BenchCell): BenchRow {
  const memBefore = process.memoryUsage().heapUsed;

  const genStart = performance.now();
  const { traceA, traceB, expectedDiffs } = generateTraces(cell);
  const genMs = performance.now() - genStart;

  const summary = compareTraces(traceA, traceB, {
    buildRules: () => buildRuleSet(),
  });

  const memAfter = process.memoryUsage().heapUsed;
  const expected = expectedDiffs.semantic.length;
  const found = summary.semantic.length;

  return {
    size: cell.size,
    diffs: cell.diffs,
    seed: cell.seed,
    nodesA: summary.traceASize,
    nodesB: summary.traceBSize,
    expected,
    found,
    skipPct: summary.skipPercentage,
    genMs,
    merkleMs: summary.timing.merkleBuildMs,
    diffMs: summary.timing.diffMs,
    totalMs: summary.timing.totalMs,
    memMb: Math.max(0, memAfter - memBefore) / 1024 / 1024,
    // Exact equality covers both directions: no misses and no false positives.
    passed: found === expected,
  };
}

function fmtMs(v: number): string {
  if (v < 1) return v.toFixed(2);
  if (v < 100) return v.toFixed(1);
  return String(Math.round(v));
}

export function formatTable(rows: BenchRow[]): string {
  const header =
    "Nodes    | Diffs | Skip%  | Gen      | Merkle   | Diff    | Total    | Mem     | Recall";
  const lines = ["TraceDiff benchmark", "=====================", header, "-".repeat(header.length)];
  for (const r of rows) {
    if (r.error !== undefined) {
      lines.push(`${String(r.size).padEnd(8)} | ${`FAIL: ${r.error}`.slice(0, 80)}`);
      continue;
    }
    const recall = r.passed ? `✓ ${r.found}/${r.expected}` : `✗ ${r.found}/${r.expected}`;
    lines.push(
      [
        String(r.size).padEnd(8),
        String(r.diffs).padEnd(5),
        `${r.skipPct.toFixed(1)}%`.padEnd(6),
        `${fmtMs(r.genMs)}ms`.padEnd(8),
        `${fmtMs(r.merkleMs)}ms`.padEnd(8),
        `${fmtMs(r.diffMs)}ms`.padEnd(7),
        `${fmtMs(r.totalMs)}ms`.padEnd(8),
        `${r.memMb.toFixed(1)}MB`.padEnd(7),
        recall,
      ].join(" | "),
    );
  }
  return `${lines.join("\n")}\n`;
}

export function toCsv(rows: BenchRow[]): string {
  const header =
    "nodes,diffs,seed,nodesA,nodesB,expected,found,skip_pct,gen_ms,merkle_ms,diff_ms,total_ms,mem_mb,passed,error";
  const lines = rows.map((r) =>
    [
      r.size,
      r.diffs,
      r.seed,
      r.nodesA,
      r.nodesB,
      r.expected,
      r.found,
      r.skipPct.toFixed(2),
      r.genMs.toFixed(1),
      r.merkleMs.toFixed(1),
      r.diffMs.toFixed(2),
      r.totalMs.toFixed(1),
      r.memMb.toFixed(1),
      r.passed,
      r.error !== undefined ? `"${r.error.replace(/"/g, "'")}"` : "",
    ].join(","),
  );
  return `${header}\n${lines.join("\n")}\n`;
}

export interface BenchOptions {
  includeHuge?: boolean;
  csv?: string;
  help?: boolean;
}

export function parseBenchArgs(args: string[]): BenchOptions {
  const options: BenchOptions = {};
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "--help" || arg === "-h") {
      options.help = true;
    } else if (arg === "--include-huge") {
      options.includeHuge = true;
    } else if (arg === "--csv") {
      const val = args[++i];
      if (!val) throw new Error("Missing value for --csv");
      options.csv = val;
    } else if (arg.startsWith("--csv=")) {
      options.csv = arg.slice("--csv=".length);
    } else if (arg.startsWith("-")) {
      throw new Error(`Unknown option: "${arg}". Run with --help for usage.`);
    }
  }
  return options;
}

function runCli(): void {
  const options = parseBenchArgs(process.argv.slice(2));

  if (options.help) {
    process.stdout.write(`TraceDiff Benchmark Runner

Usage:
  bun run bench [options]

Options:
  --include-huge      Include the 1M-node cell (needs GBs of RAM, minutes of time)
  --csv <path>        CSV output path (default: bench-results.csv in repo root)
  -h, --help          Show this help message

Example:
  bun run bench
  bun run bench --include-huge --csv /tmp/bench.csv
\n`);
    return;
  }

  const cells = options.includeHuge ? [...DEFAULT_CELLS, HUGE_CELL] : DEFAULT_CELLS;
  const csvPath = options.csv ?? "bench-results.csv";
  const rows: BenchRow[] = [];

  for (const cell of cells) {
    try {
      rows.push(runCell(cell));
    } catch (err: unknown) {
      // One heavy cell (e.g. OOM at 1M) must not kill the whole table.
      rows.push({
        size: cell.size,
        diffs: cell.diffs,
        seed: cell.seed,
        nodesA: 0,
        nodesB: 0,
        expected: 0,
        found: 0,
        skipPct: 0,
        genMs: 0,
        merkleMs: 0,
        diffMs: 0,
        totalMs: 0,
        memMb: 0,
        passed: false,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  process.stdout.write(`\n${formatTable(rows)}\n`);
  writeFileSync(csvPath, toCsv(rows), "utf8");
  process.stdout.write(`Wrote ${csvPath}\n`);

  if (rows.some((r) => !r.passed)) process.exitCode = 1;
}

// Execute when invoked directly
if (import.meta.main) {
  try {
    runCli();
  } catch (err: unknown) {
    process.stderr.write(`Error: ${err instanceof Error ? err.message : String(err)}\n`);
    process.exit(1);
  }
}
