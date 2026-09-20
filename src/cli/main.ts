import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { performance } from "node:perf_hooks";
import { compareTraces } from "../core/compare-traces.js";
import type { DiffSummary, TraceNode } from "../core/type.js";
import { diffTraceCosts, type FinOpsDiffResult } from "../finops/costEngine.js";
import { autoDetect, parseFlatSpans, parseJsonTree, parseOtel } from "../parsers/index.js";
import { exportReproBundle } from "../repro/generator.js";
import { buildRuleSet, type RuleSetOptions } from "../rules/registry.js";
import { AVAILABLE_RULES, getHelpText, getRulesText, parseCliArgs, VERSION } from "./args.js";
import { formatHtml } from "./format-html.js";
import { formatTerminal } from "./format-terminal.js";

function fail(message: string): 2 {
  // Some messages already carry their own Tip (e.g. --list-rules hint).
  const suffix = message.includes("Tip:") ? "" : "\n  Tip: run 'tracediff --help' for usage.";
  console.error(`✖ Error: ${message}${suffix}`);
  return 2;
}

export function run(argv: string[] = process.argv.slice(2)): number {
  let args: ReturnType<typeof parseCliArgs>;
  try {
    args = parseCliArgs(argv);
  } catch (err: unknown) {
    return fail(err instanceof Error ? err.message : String(err));
  }

  if (args.help) {
    process.stdout.write(`${getHelpText()}\n`);
    return 0;
  }

  if (args.version) {
    process.stdout.write(`${VERSION}\n`);
    return 0;
  }

  if (args.listRules) {
    process.stdout.write(`${getRulesText()}\n`);
    return 0;
  }

  // ── Read files ─────────────────────────────────────────────────────────────
  if (!existsSync(args.fileA)) {
    return fail(`File not found: "${args.fileA}". Check the path and try again.`);
  }
  if (!existsSync(args.fileB)) {
    return fail(`File not found: "${args.fileB}". Check the path and try again.`);
  }

  let rawA: unknown;
  let rawB: unknown;
  try {
    rawA = JSON.parse(readFileSync(args.fileA, "utf8"));
  } catch (err: unknown) {
    return fail(
      `Failed to parse JSON in "${args.fileA}": ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  try {
    rawB = JSON.parse(readFileSync(args.fileB, "utf8"));
  } catch (err: unknown) {
    return fail(
      `Failed to parse JSON in "${args.fileB}": ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  // ── Parse traces ───────────────────────────────────────────────────────────
  let traceA: TraceNode;
  let traceB: TraceNode;
  const parseStart = performance.now();

  try {
    traceA = parseInput(rawA, args.format);
  } catch (err: unknown) {
    return fail(
      `Failed to parse trace A ("${args.fileA}"): ${err instanceof Error ? err.message : String(err)}\n  Tip: try --format tree | flat | otel if auto-detect picked the wrong parser.`,
    );
  }

  try {
    traceB = parseInput(rawB, args.format);
  } catch (err: unknown) {
    return fail(
      `Failed to parse trace B ("${args.fileB}"): ${err instanceof Error ? err.message : String(err)}\n  Tip: try --format tree | flat | otel if auto-detect picked the wrong parser.`,
    );
  }

  const parseMs = performance.now() - parseStart;

  // ── Build rules ────────────────────────────────────────────────────────────
  const ruleNames = args.noRules ? [] : args.rules;
  const ruleOptions: RuleSetOptions = {
    ...(ruleNames !== undefined ? { ruleNames } : {}),
    ...(args.tolerance !== undefined ? { numericTolerance: args.tolerance } : {}),
    ...(args.ignoreFields !== undefined ? { ignoreFields: args.ignoreFields } : {}),
  };

  const buildRules = () => buildRuleSet(ruleOptions);

  // ── Compare traces ─────────────────────────────────────────────────────────
  // buildRules() throws on unknown --rules names; surface it as a clean
  // exit-2 error instead of an uncaught exception with a stack trace.
  let summary: DiffSummary;
  try {
    summary = compareTraces(traceA, traceB, {
      buildRules,
      maxDepth: args.maxDepth,
      parseMs,
    });
  } catch (err: unknown) {
    return fail(err instanceof Error ? err.message : String(err));
  }

  const activeRules = args.noRules ? [] : (args.rules ?? [...AVAILABLE_RULES]);

  // ── Optional FinOps computation (strictly opt-in) ──────────────────────────
  let finopsResult: FinOpsDiffResult | undefined;
  if (args.finops) {
    finopsResult = diffTraceCosts(traceA, traceB, args.requestsPerMonth);
  }

  // ── Optional HTML file export ──────────────────────────────────────────────
  if (args.htmlOut) {
    try {
      const htmlContent = formatHtml(summary, {
        fileA: args.fileA,
        fileB: args.fileB,
        activeRules,
        finops: finopsResult,
      });
      writeFileSync(args.htmlOut, htmlContent, "utf8");
    } catch (err: unknown) {
      return fail(
        `Failed to write HTML output to "${args.htmlOut}": ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  // ── Optional Repro-Gen export ──────────────────────────────────────────────
  const reproPaths: string[] = [];
  if (args.exportReproDir) {
    try {
      mkdirSync(args.exportReproDir, { recursive: true });
      summary.semantic.forEach((diff, idx) => {
        const n = idx + 1;
        const bundle = exportReproBundle(diff);
        const shPath   = `${args.exportReproDir}/repro-diff-${n}.sh`;
        const testPath = `${args.exportReproDir}/repro-diff-${n}.test.ts`;
        writeFileSync(shPath,   `#!/usr/bin/env bash\n${bundle.curl}\n`, "utf8");
        writeFileSync(testPath, bundle.vitestFile, "utf8");
        reproPaths.push(shPath, testPath);
      });
    } catch (err: unknown) {
      return fail(
        `Failed to write repro files to "${args.exportReproDir}": ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  // ── Render output ──────────────────────────────────────────────────────────
  if (!args.quiet) {
    if (args.output === "json") {
      const jsonOutput = finopsResult ? { ...summary, finops: finopsResult } : summary;
      process.stdout.write(`${JSON.stringify(jsonOutput, null, 2)}\n`);
    } else if (args.output === "html") {
      process.stdout.write(
        `${formatHtml(summary, {
          fileA: args.fileA,
          fileB: args.fileB,
          activeRules,
          finops: finopsResult,
        })}\n`,
      );
    } else {
      process.stdout.write(
        `${formatTerminal(summary, {
          fileA: args.fileA,
          fileB: args.fileB,
          activeRules,
          stats: args.stats,
          finops: finopsResult,
          includeNoise: args.includeNoise,
          noColor: args.noColor,
        })}\n`,
      );
    }

    // Print repro file paths in the summary when --export-repro was used.
    if (reproPaths.length > 0) {
      process.stdout.write(`\n  ⚡ Repro-Gen: ${reproPaths.length / 2} bundle(s) written to ${args.exportReproDir}\n`);
      for (const p of reproPaths) {
        process.stdout.write(`     ${p}\n`);
      }
    }
  }

  // Exit 1 if semantic diffs detected, else 0
  return summary.semantic.length > 0 ? 1 : 0;
}

function parseInput(raw: unknown, format?: "tree" | "flat" | "otel"): TraceNode {
  if (format === "tree") return parseJsonTree(raw);
  if (format === "flat") return parseFlatSpans(raw);
  if (format === "otel") return parseOtel(raw);
  return autoDetect(raw);
}

// Execute immediately when run from the command line
if (import.meta.main) {
  const exitCode = run();
  process.exit(exitCode);
}
