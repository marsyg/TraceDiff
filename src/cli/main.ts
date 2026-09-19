import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { performance } from "node:perf_hooks";
import { compareTraces } from "../core/compare-traces.js";
import type { TraceNode } from "../core/type.js";
import { autoDetect, parseFlatSpans, parseJsonTree, parseOtel } from "../parsers/index.js";
import { buildRuleSet, type RuleSetOptions } from "../rules/registry.js";
import { getHelpText, parseCliArgs } from "./args.js";
import { formatHtml } from "./format-html.js";
import { formatTerminal } from "./format-terminal.js";

export function run(argv: string[] = process.argv.slice(2)): number {
  let args: ReturnType<typeof parseCliArgs>;
  try {
    args = parseCliArgs(argv);
  } catch (err: unknown) {
    console.error(`Error: ${err instanceof Error ? err.message : String(err)}`);
    return 2;
  }

  if (args.help) {
    process.stdout.write(`${getHelpText()}\n`);
    return 0;
  }

  if (args.version) {
    process.stdout.write("tracediff v0.1.0\n");
    return 0;
  }

  // ── Read files ─────────────────────────────────────────────────────────────
  if (!existsSync(args.fileA)) {
    console.error(`Error: File not found: "${args.fileA}"`);
    return 2;
  }
  if (!existsSync(args.fileB)) {
    console.error(`Error: File not found: "${args.fileB}"`);
    return 2;
  }

  let rawA: unknown;
  let rawB: unknown;
  try {
    rawA = JSON.parse(readFileSync(args.fileA, "utf8"));
  } catch (err: unknown) {
    console.error(
      `Error: Failed to parse JSON in "${args.fileA}": ${err instanceof Error ? err.message : String(err)}`,
    );
    return 2;
  }

  try {
    rawB = JSON.parse(readFileSync(args.fileB, "utf8"));
  } catch (err: unknown) {
    console.error(
      `Error: Failed to parse JSON in "${args.fileB}": ${err instanceof Error ? err.message : String(err)}`,
    );
    return 2;
  }

  // ── Parse traces ───────────────────────────────────────────────────────────
  let traceA: TraceNode;
  let traceB: TraceNode;
  const parseStart = performance.now();

  try {
    traceA = parseInput(rawA, args.format);
  } catch (err: unknown) {
    console.error(
      `Error: Failed to parse trace A ("${args.fileA}"): ${err instanceof Error ? err.message : String(err)}`,
    );
    return 2;
  }

  try {
    traceB = parseInput(rawB, args.format);
  } catch (err: unknown) {
    console.error(
      `Error: Failed to parse trace B ("${args.fileB}"): ${err instanceof Error ? err.message : String(err)}`,
    );
    return 2;
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
  const summary = compareTraces(traceA, traceB, {
    buildRules,
    maxDepth: args.maxDepth,
    parseMs,
  });

  const activeRules = args.noRules
    ? []
    : (args.rules ?? [
        "ignore-timestamps",
        "canonicalize-ids",
        "numeric-tolerance",
        "sort-concurrent",
        "ignore-fields",
      ]);

  // ── Optional HTML file export ──────────────────────────────────────────────
  if (args.htmlOut) {
    try {
      const htmlContent = formatHtml(summary, {
        fileA: args.fileA,
        fileB: args.fileB,
        activeRules,
      });
      writeFileSync(args.htmlOut, htmlContent, "utf8");
    } catch (err: unknown) {
      console.error(
        `Error: Failed to write HTML output to "${args.htmlOut}": ${err instanceof Error ? err.message : String(err)}`,
      );
      return 2;
    }
  }

  // ── Render output ──────────────────────────────────────────────────────────
  if (!args.quiet) {
    if (args.output === "json") {
      process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
    } else if (args.output === "html") {
      process.stdout.write(
        `${formatHtml(summary, {
          fileA: args.fileA,
          fileB: args.fileB,
          activeRules,
        })}\n`,
      );
    } else {
      process.stdout.write(
        `${formatTerminal(summary, {
          fileA: args.fileA,
          fileB: args.fileB,
          activeRules,
          stats: args.stats,
          includeNoise: args.includeNoise,
        })}\n`,
      );
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
