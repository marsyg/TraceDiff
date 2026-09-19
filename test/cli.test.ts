import { describe, expect, test } from "bun:test";
import { existsSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { run } from "../src/cli/main.js";

const FIXTURES_DIR = join(import.meta.dir, "..", "fixtures");
const IDENTICAL_A = join(FIXTURES_DIR, "small-identical", "a.json");
const IDENTICAL_B = join(FIXTURES_DIR, "small-identical", "b.json");
const DIFF_A = join(FIXTURES_DIR, "small-diff", "a.json");
const DIFF_B = join(FIXTURES_DIR, "small-diff", "b.json");

function captureRun(args: string[]): { code: number; stdout: string; stderr: string } {
  let stdout = "";
  let stderr = "";
  const origStdout = process.stdout.write;
  const origStderr = process.stderr.write;
  const origConsoleError = console.error;

  process.stdout.write = ((chunk: string | Uint8Array): boolean => {
    stdout += typeof chunk === "string" ? chunk : new TextDecoder().decode(chunk);
    return true;
  }) as typeof process.stdout.write;

  process.stderr.write = ((chunk: string | Uint8Array): boolean => {
    stderr += typeof chunk === "string" ? chunk : new TextDecoder().decode(chunk);
    return true;
  }) as typeof process.stderr.write;

  console.error = (...args: unknown[]) => {
    stderr += `${args.map(String).join(" ")}\n`;
  };

  try {
    const code = run(args);
    return { code, stdout, stderr };
  } finally {
    process.stdout.write = origStdout;
    process.stderr.write = origStderr;
    console.error = origConsoleError;
  }
}

describe("CLI — argument handling & exit codes", () => {
  test("shows help with --help and exits 0", () => {
    const { code, stdout } = captureRun(["--help"]);
    expect(code).toBe(0);
    expect(stdout).toContain("tracediff v0.1.0");
    expect(stdout).toContain("Usage:");
  });

  test("shows version with --version and exits 0", () => {
    const { code, stdout } = captureRun(["--version"]);
    expect(code).toBe(0);
    expect(stdout).toContain("tracediff v0.1.0");
  });

  test("exits 2 when missing positional arguments", () => {
    const { code, stderr } = captureRun([]);
    expect(code).toBe(2);
    expect(stderr).toContain("Expected 2 trace files");
  });

  test("exits 2 when files do not exist", () => {
    const { code, stderr } = captureRun(["nonexistent_a.json", "nonexistent_b.json"]);
    expect(code).toBe(2);
    expect(stderr).toContain("File not found");
  });
});

describe("CLI — trace diffing execution", () => {
  test("returns 0 for identical traces", () => {
    const { code, stdout } = captureRun([IDENTICAL_A, IDENTICAL_B]);
    expect(code).toBe(0);
    expect(stdout).toContain("IDENTICAL");
    expect(stdout).toContain("No differences found");
  });

  test("returns 1 for semantic differences", () => {
    const { code, stdout } = captureRun([DIFF_A, DIFF_B]);
    expect(code).toBe(1);
    expect(stdout).toContain("SEMANTIC");
    expect(stdout).toContain("differences found");
  });

  test("supports --output json producing valid DiffSummary", () => {
    const { code, stdout } = captureRun([DIFF_A, DIFF_B, "--output", "json"]);
    expect(code).toBe(1);
    const parsed = JSON.parse(stdout);
    expect(parsed.traceASize).toBe(10);
    expect(parsed.traceBSize).toBe(10);
    expect(parsed.semantic.length).toBeGreaterThan(0);
    expect(parsed.timing).toBeDefined();
    expect(parsed.timing.totalMs).toBeGreaterThan(0);
  });

  test("supports --stats flag", () => {
    const { code, stdout } = captureRun([DIFF_A, DIFF_B, "--stats"]);
    expect(code).toBe(1);
    expect(stdout).toContain("━━━ Statistics ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
    expect(stdout).toContain("Nodes compared:");
    expect(stdout).toContain("Nodes skipped:");
    expect(stdout).toContain("Total:");
  });

  test("supports -q / --quiet suppressing output", () => {
    const { code, stdout } = captureRun([DIFF_A, DIFF_B, "-q"]);
    expect(code).toBe(1);
    expect(stdout).toBe("");
  });

  test("supports --html-out writing report file to disk", () => {
    const tempHtml = join(FIXTURES_DIR, "temp_report.html");
    if (existsSync(tempHtml)) unlinkSync(tempHtml);

    try {
      const { code } = captureRun([DIFF_A, DIFF_B, "--html-out", tempHtml, "-q"]);
      expect(code).toBe(1);
      expect(existsSync(tempHtml)).toBe(true);
    } finally {
      if (existsSync(tempHtml)) unlinkSync(tempHtml);
    }
  });

  test("supports --no-rules disabling equivalence normalization", () => {
    const { code, stdout } = captureRun([DIFF_A, DIFF_B, "--no-rules", "--output", "json"]);
    expect(code).toBe(1);
    const parsed = JSON.parse(stdout);
    expect(parsed.diffs.length).toBeGreaterThan(0);
  });

  test("supports --finops flag in terminal output", () => {
    const { code, stdout } = captureRun([DIFF_A, DIFF_B, "--finops"]);
    expect(code).toBe(1);
    expect(stdout).toContain("━━━ FinOps Cost Impact ━━━━━━━━━━━━━━━━━━━━━━━━");
    expect(stdout).toContain("Baseline trace:");
    expect(stdout).toContain("Target trace:");
    expect(stdout).toContain("Monthly impact:");
    expect(stdout).toContain("Disclaimer:");
  });

  test("supports --finops displaying prescriptive fixes when cost regresses", () => {
    const tempA = join(FIXTURES_DIR, "temp_finops_a.json");
    const tempB = join(FIXTURES_DIR, "temp_finops_b.json");
    writeFileSync(
      tempA,
      JSON.stringify({ id: "root", type: "span", label: "api", attributes: {}, children: [] }),
    );
    writeFileSync(
      tempB,
      JSON.stringify({
        id: "root",
        type: "span",
        label: "api",
        attributes: {},
        children: [
          {
            id: "s3-call",
            type: "span",
            label: "s3_read_cold_cache",
            attributes: { "rpc.service": "s3", "db.operation": "GetObject" },
            children: [],
          },
        ],
      }),
    );
    try {
      const { code, stdout } = captureRun([tempA, tempB, "--finops"]);
      expect(code).toBe(1);
      expect(stdout).toContain("💡 Prescriptive Fixes & Cost Optimization:");
      expect(stdout).toContain("Cold Storage Cache Miss");
      expect(stdout).toContain("Save up to");
    } finally {
      if (existsSync(tempA)) unlinkSync(tempA);
      if (existsSync(tempB)) unlinkSync(tempB);
    }
  });

  test("supports --finops with custom --requests-per-month", () => {
    const { code, stdout } = captureRun([
      DIFF_A,
      DIFF_B,
      "--finops",
      "--requests-per-month",
      "50000000",
      "--output",
      "json",
    ]);
    expect(code).toBe(1);
    const parsed = JSON.parse(stdout);
    expect(parsed.finops).toBeDefined();
    expect(parsed.finops.requestsPerMonth).toBe(50000000);
    expect(parsed.finops.remediations).toBeDefined();
    expect(Array.isArray(parsed.finops.remediations)).toBe(true);
  });

  test("supports --finops with --output json including finops object", () => {
    const { code, stdout } = captureRun([DIFF_A, DIFF_B, "--finops", "--output", "json"]);
    expect(code).toBe(1);
    const parsed = JSON.parse(stdout);
    expect(parsed.finops).toBeDefined();
    expect(parsed.finops.baselineCostUsd).toBeDefined();
    expect(parsed.finops.targetCostUsd).toBeDefined();
    expect(parsed.finops.projectedMonthlyUsd).toBeDefined();
    expect(parsed.finops.topCostDrivers).toBeDefined();
  });

  test("without --finops, output does not include finops object or section", () => {
    const { code, stdout } = captureRun([DIFF_A, DIFF_B, "--output", "json"]);
    expect(code).toBe(1);
    const parsed = JSON.parse(stdout);
    expect(parsed.finops).toBeUndefined();

    const termRun = captureRun([DIFF_A, DIFF_B]);
    expect(termRun.stdout).not.toContain("FinOps Cost Impact");
  });
});
