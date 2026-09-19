import type { DiffResult, DiffSummary } from "../core/type.js";
import type { FinOpsDiffResult } from "../finops/costEngine.js";

export interface TerminalFormatOptions {
  fileA: string;
  fileB: string;
  activeRules?: string[];
  stats?: boolean;
  finops?: FinOpsDiffResult;
  includeNoise?: boolean;
  noColor?: boolean;
}

export function formatTerminal(summary: DiffSummary, options: TerminalFormatOptions): string {
  const isColor =
    !options.noColor &&
    !process.env.NO_COLOR &&
    (Boolean(process.stdout?.isTTY) || Boolean(process.env.FORCE_COLOR));

  const c = {
    reset: isColor ? "\x1b[0m" : "",
    bold: isColor ? "\x1b[1m" : "",
    dim: isColor ? "\x1b[2m" : "",
    red: isColor ? "\x1b[31m" : "",
    green: isColor ? "\x1b[32m" : "",
    yellow: isColor ? "\x1b[33m" : "",
    blue: isColor ? "\x1b[34m" : "",
    cyan: isColor ? "\x1b[36m" : "",
    gray: isColor ? "\x1b[90m" : "",
    bgRed: isColor ? "\x1b[41m\x1b[37m\x1b[1m" : "",
    bgYellow: isColor ? "\x1b[43m\x1b[30m\x1b[1m" : "",
    bgBlue: isColor ? "\x1b[44m\x1b[37m\x1b[1m" : "",
    bgGreen: isColor ? "\x1b[42m\x1b[30m\x1b[1m" : "",
  };

  const lines: string[] = [];

  // ── Header ───────────────────────────────────────────────────────────────
  lines.push(`${c.bold}tracediff v0.1.0${c.reset}\n`);
  lines.push(
    `Trace A: ${c.cyan}${options.fileA}${c.reset} ${c.dim}(${summary.traceASize.toLocaleString()} nodes)${c.reset}`,
  );
  lines.push(
    `Trace B: ${c.cyan}${options.fileB}${c.reset} ${c.dim}(${summary.traceBSize.toLocaleString()} nodes)${c.reset}`,
  );

  const rulesText =
    options.activeRules && options.activeRules.length > 0
      ? options.activeRules.join(", ")
      : "none (raw structural)";
  lines.push(`Rules:   ${c.dim}${rulesText}${c.reset}`);
  lines.push("");

  // ── Diff Section ─────────────────────────────────────────────────────────
  lines.push(`${c.bold}━━━ Diff Results ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${c.reset}`);
  lines.push("");

  const semantic = summary.semantic;
  const uncertain = summary.uncertain;
  const noise = summary.noise;

  let counter = 1;

  if (summary.diffs.length === 0) {
    lines.push(` ${c.bgGreen} IDENTICAL ${c.reset} No differences found (traces are equivalent)\n`);
  } else {
    // 1. Semantic — real behavioral changes, always shown.
    if (semantic.length > 0) {
      const label =
        semantic.length === 1 ? "1 difference found" : `${semantic.length} differences found`;
      lines.push(` ${c.bgRed} SEMANTIC ${c.reset}  ${c.bold}${c.red}${label}${c.reset}\n`);
      for (const d of semantic) {
        lines.push(formatDiffItem(d, counter++, c));
      }
    }

    // 2. Uncertain — needs human judgment, always shown.
    if (uncertain.length > 0) {
      const label = uncertain.length === 1 ? "1 difference" : `${uncertain.length} differences`;
      lines.push(` ${c.bgYellow} UNCERTAIN ${c.reset}  ${c.bold}${c.yellow}${label}${c.reset}\n`);
      for (const d of uncertain) {
        lines.push(formatDiffItem(d, counter++, c));
      }
    }

    // 3. Noise — hidden by default to keep the signal readable.
    if (options.includeNoise && noise.length > 0) {
      const label = noise.length === 1 ? "1 noise difference" : `${noise.length} noise differences`;
      lines.push(` ${c.bgBlue} NOISE ${c.reset}  ${c.bold}${c.blue}${label}${c.reset}\n`);
      for (const d of noise) {
        lines.push(formatDiffItem(d, counter++, c));
      }
    } else if (!options.includeNoise && noise.length > 0) {
      const label =
        noise.length === 1 ? "+1 noise diff hidden" : `+${noise.length} noise diffs hidden`;
      lines.push(`${c.dim}${label} — re-run with --include-noise to show${c.reset}\n`);
    }
  }

  // ── Statistics ───────────────────────────────────────────────────────────
  if (options.stats) {
    lines.push(`${c.bold}━━━ Statistics ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${c.reset}\n`);
    const totalA = summary.traceASize || 1;
    const comparedPct = ((summary.nodesVisited / totalA) * 100).toFixed(1);
    const skipPct = summary.skipPercentage.toFixed(1);

    lines.push(
      `  Nodes compared:    ${c.bold}${summary.nodesVisited.toLocaleString()}${c.reset} of ${totalA.toLocaleString()} (${comparedPct}%)`,
    );
    lines.push(
      `  Nodes skipped:     ${c.green}${c.bold}${summary.nodesSkipped.toLocaleString()}${c.reset} (${c.green}${skipPct}%${c.reset}) via Merkle match`,
    );
    if (summary.nodesBulkReported > 0) {
      lines.push(
        `  Nodes bulk reported: ${summary.nodesBulkReported.toLocaleString()} (removed/depth-capped subtrees)`,
      );
    }
    lines.push(`  Parse time:        ${summary.timing.parseMs.toFixed(1)} ms`);
    lines.push(
      `  Merkle build:      ${(summary.timing.treeBuildMs + summary.timing.merkleBuildMs).toFixed(1)} ms`,
    );
    const diffTimeStr =
      summary.timing.diffMs < 1
        ? `${summary.timing.diffMs.toFixed(2)} ms`
        : `${summary.timing.diffMs.toFixed(1)} ms`;
    lines.push(`  Diff time:         ${diffTimeStr}`);
    lines.push(`  Total:             ${c.bold}${summary.timing.totalMs.toFixed(1)} ms${c.reset}\n`);
  }

  // ── FinOps Cost Impact ───────────────────────────────────────────────────
  if (options.finops) {
    const f = options.finops;
    const deltaSign = f.deltaUsd > 0 ? "+" : "";
    const pctSign = f.percentageChange > 0 ? "+" : "";
    const deltaColor = f.deltaUsd > 0 ? c.red : f.deltaUsd < 0 ? c.green : c.gray;
    const pctColor = f.percentageChange > 0 ? c.red : f.percentageChange < 0 ? c.green : c.gray;

    lines.push(`${c.bold}━━━ FinOps Cost Impact ━━━━━━━━━━━━━━━━━━━━━━━━${c.reset}\n`);
    lines.push(`  Baseline trace:    ${c.bold}$${f.baselineCostUsd.toFixed(6)}${c.reset} / req`);
    lines.push(
      `  Target trace:      ${c.bold}$${f.targetCostUsd.toFixed(6)}${c.reset} / req (${pctColor}${pctSign}${f.percentageChange.toFixed(1)}%${c.reset})`,
    );
    lines.push(
      `  Delta per request: ${deltaColor}${c.bold}${deltaSign}$${f.deltaUsd.toFixed(6)}${c.reset}`,
    );
    const monthlyStr = `${deltaSign}$${Math.abs(f.projectedMonthlyUsd).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
    lines.push(
      `  Monthly impact:    ${deltaColor}${c.bold}${monthlyStr} / mo${c.reset} ${c.dim}(@ ${f.requestsPerMonth.toLocaleString()} reqs/mo)${c.reset}\n`,
    );

    lines.push(`  ${c.bold}Category Shift:${c.reset}`);
    const cat = f.categories.delta;
    const fmtCat = (val: number) => {
      const sign = val > 0 ? "+" : val < 0 ? "-" : " ";
      return `${sign}$${Math.abs(val).toFixed(6)}`;
    };
    lines.push(`    Compute:         ${fmtCat(cat.computeUsd)}`);
    lines.push(`    Database:        ${fmtCat(cat.databaseUsd)}`);
    lines.push(`    Storage:         ${fmtCat(cat.storageUsd)}`);
    lines.push(`    LLM / GenAI:     ${fmtCat(cat.llmUsd)}\n`);

    if (f.topCostDrivers.length > 0) {
      lines.push(`  ${c.bold}Top Cost Drivers:${c.reset}`);
      for (let i = 0; i < f.topCostDrivers.length; i++) {
        const d = f.topCostDrivers[i];
        const driverSign = d.deltaUsd > 0 ? "+" : "";
        const driverColor = d.deltaUsd > 0 ? c.red : c.green;
        lines.push(
          `    ${i + 1}. ${c.bold}${d.nodeId}${c.reset} (${driverColor}${driverSign}$${d.deltaUsd.toFixed(6)}${c.reset})`,
        );
        lines.push(`       ${c.dim}Path:   ${d.path}${c.reset}`);
        lines.push(`       ${c.dim}Reason: ${d.reason}${c.reset}`);
      }
      lines.push("");
    }

    if (f.remediations && f.remediations.length > 0) {
      lines.push(`  ${c.bold}💡 Prescriptive Fixes & Cost Optimization:${c.reset}`);
      for (let i = 0; i < f.remediations.length; i++) {
        const r = f.remediations[i];
        const monthlySave = `$${r.potentialMonthlySavingsUsd.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
        lines.push(
          `    ${i + 1}. [${c.yellow}${r.patternName}${c.reset}] ${c.bold}${r.affectedSpanId}${c.reset} (${c.green}Save up to ${monthlySave}/mo${c.reset})`,
        );
        lines.push(`       ${c.dim}Fix:${c.reset}  ${r.actionableFix}`);
      }
      lines.push("");
    }

    lines.push(
      `  ${c.dim}Pricing Table: ${f.priceTableVersion} (${f.evalDurationMs.toFixed(1)}ms eval)${c.reset}`,
    );
    lines.push(`  ${c.dim}Disclaimer: ${f.disclaimer}${c.reset}\n`);
  }

  // ── Result footer — mirrors the process exit code ────────────────────────
  if (semantic.length > 0) {
    const uncertainSuffix = uncertain.length > 0 ? ` · ${uncertain.length} uncertain` : "";
    lines.push(
      `${c.red}${c.bold}✖ Result:${c.reset} ${semantic.length} semantic${uncertainSuffix} — exit 1`,
    );
  } else if (summary.diffs.length === 0) {
    lines.push(`${c.green}${c.bold}✓ Result:${c.reset} traces are equivalent — exit 0`);
  } else {
    lines.push(
      `${c.green}${c.bold}✓ Result:${c.reset} no semantic diffs (${uncertain.length} uncertain, ${noise.length} noise) — exit 0`,
    );
  }
  if (!options.stats && !options.finops && semantic.length > 0) {
    lines.push(
      `${c.dim}Tip: --stats for timing · --finops for cloud cost impact · --html-out report.html for a report${c.reset}`,
    );
  }

  return lines.join("\n");
}

function formatDiffItem(d: DiffResult, num: number, c: Record<string, string>): string {
  const pathArr = d.pathB ?? d.pathA ?? [];
  const pathStr = pathArr.length > 0 ? pathArr.join(" > ") : "(root)";

  const typeUpper = d.type.toUpperCase();
  let typeBadge = typeUpper;
  if (d.type === "added") typeBadge = `${c.green}${c.bold}ADDED${c.reset}`;
  else if (d.type === "removed") typeBadge = `${c.red}${c.bold}REMOVED${c.reset}`;
  else if (d.type === "modified") typeBadge = `${c.yellow}${c.bold}MODIFIED${c.reset}`;
  else typeBadge = `${c.cyan}${c.bold}${typeUpper}${c.reset}`;

  const numStr = `  ${num}.`.padEnd(5);
  const via = d.classifiedBy ? ` ${c.dim}[via ${d.classifiedBy}]${c.reset}` : "";
  const header = `${c.dim}${numStr}${c.reset}${typeBadge}  ${c.cyan}${pathStr}${c.reset}${via}`;

  const detailLines: string[] = [];
  if (d.type === "added") {
    const node = d.nodeB;
    const childCount = node?.children?.length ?? 0;
    detailLines.push(
      `     ${c.green}+ New span: ${node?.label ?? "unknown"} (${childCount} children, ${d.affectedSubtreeSize} total nodes)${c.reset}`,
    );
  } else if (d.type === "removed") {
    const node = d.nodeA;
    const childCount = node?.children?.length ?? 0;
    detailLines.push(
      `     ${c.red}- Removed span: ${node?.label ?? "unknown"} (${childCount} children, ${d.affectedSubtreeSize} total nodes)${c.reset}`,
    );
  } else {
    // Modified: description contains items separated by semicolons
    const parts = d.description.split("; ");
    for (const part of parts) {
      if (d.significance === "semantic") {
        detailLines.push(`     ${c.red}-${c.reset} ${part}`);
      } else {
        detailLines.push(`     ${c.yellow}~${c.reset} ${part}`);
      }
    }
  }

  return `${header}\n${detailLines.join("\n")}\n`;
}
