import type { DiffSummary } from "../core/type.js";
import type { FinOpsDiffResult } from "../finops/costEngine.js";
import { exportReproBundle } from "../repro/generator.js";

export interface HtmlFormatOptions {
  fileA: string;
  fileB: string;
  activeRules?: string[];
  finops?: FinOpsDiffResult;
}

export function formatHtml(summary: DiffSummary, options: HtmlFormatOptions): string {
  // Serialize DiffSummary with shallow children to prevent 100MB+ HTML payloads from nested AST diff nodes
  const jsonSummary = JSON.stringify(
    summary,
    (key, value) => {
      if (
        key === "children" &&
        Array.isArray(value) &&
        value.length > 0 &&
        typeof value[0] === "object" &&
        value[0] !== null &&
        "id" in value[0]
      ) {
        return `[${value.length} children]`;
      }
      if (key === "raw") return undefined;
      return value;
    },
    2,
  );
  const rulesList =
    options.activeRules && options.activeRules.length > 0
      ? options.activeRules.join(", ")
      : "none (raw structural)";

  const comparedPct = ((summary.nodesVisited / (summary.traceASize || 1)) * 100).toFixed(1);
  const skipPct = summary.skipPercentage.toFixed(1);
  const reproBundles = summary.semantic.map((diff) => exportReproBundle(diff));

  const diffItemsHtml = summary.diffs
    .map((d, index) => {
      // Same rule as the terminal view: show where the node lives —
      // removed → pathA, added → pathB. Anchor paths stay on the object.
      const pathArr =
        d.type === "removed" ? (d.pathA ?? d.pathB ?? []) : (d.pathB ?? d.pathA ?? []);
      const pathStr = pathArr.join(" &rsaquo; ");
      const badgeClass =
        d.significance === "semantic"
          ? "badge-semantic"
          : d.significance === "uncertain"
            ? "badge-uncertain"
            : "badge-noise";

      const typeBadge =
        d.type === "added"
          ? '<span class="badge badge-added">ADDED</span>'
          : d.type === "removed"
            ? '<span class="badge badge-removed">REMOVED</span>'
            : '<span class="badge badge-modified">MODIFIED</span>';

      return `
      <div class="diff-card" data-significance="${d.significance}">
        <div class="diff-header">
          <span class="diff-number">#${index + 1}</span>
          ${typeBadge}
          <span class="badge ${badgeClass}">${d.significance.toUpperCase()}</span>
          <span class="diff-path">${escapeHtml(pathStr)}</span>
          ${d.significance === "semantic" ? `<button class="repro-btn" onclick="openRepro(${summary.semantic.indexOf(d)})" title="Export reproduction">Export Repro</button>` : ""}
        </div>
        <div class="diff-body">
          <p class="diff-desc">${escapeHtml(d.description)}</p>
          <div class="diff-meta">
            <span>Depth: ${d.depth}</span>
            <span>Affected Subtree: ${d.affectedSubtreeSize} nodes</span>
            ${d.classifiedBy ? `<span>Rule: <code>${escapeHtml(d.classifiedBy)}</code></span>` : ""}
          </div>
        </div>
      </div>
    `;
    })
    .join("\n");

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>TraceDiff Report — ${escapeHtml(options.fileA)} vs ${escapeHtml(options.fileB)}</title>
  <style>
    :root {
      --bg: #0d1117;
      --card-bg: #161b22;
      --border: #30363d;
      --text: #c9d1d9;
      --text-muted: #8b949e;
      --heading: #f0f6fc;
      --semantic: #f85149;
      --semantic-bg: rgba(248, 81, 73, 0.15);
      --uncertain: #d29922;
      --uncertain-bg: rgba(210, 153, 34, 0.15);
      --noise: #58a6ff;
      --noise-bg: rgba(88, 166, 255, 0.15);
      --green: #3fb950;
      --green-bg: rgba(63, 185, 80, 0.15);
    }
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body {
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif;
      background-color: var(--bg);
      color: var(--text);
      line-height: 1.5;
      padding: 2rem;
    }
    .container { max-width: 1100px; margin: 0 auto; }
    header { margin-bottom: 2rem; border-bottom: 1px solid var(--border); padding-bottom: 1.5rem; }
    h1 { color: var(--heading); font-size: 1.8rem; font-weight: 700; margin-bottom: 0.5rem; }
    .trace-meta { color: var(--text-muted); font-size: 0.95rem; line-height: 1.6; }
    .trace-meta strong { color: var(--text); }
    .stats-grid {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(180px, 1fr));
      gap: 1rem;
      margin-bottom: 2rem;
    }
    .stat-card {
      background: var(--card-bg);
      border: 1px solid var(--border);
      border-radius: 8px;
      padding: 1.2rem;
      text-align: center;
    }
    .stat-val { font-size: 1.7rem; font-weight: 700; color: var(--heading); margin-bottom: 0.25rem; }
    .stat-val.semantic { color: var(--semantic); }
    .stat-val.green { color: var(--green); }
    .stat-label { font-size: 0.82rem; color: var(--text-muted); text-transform: uppercase; letter-spacing: 0.05em; }
    .filter-bar {
      display: flex;
      gap: 0.5rem;
      margin-bottom: 1.5rem;
      flex-wrap: wrap;
    }
    .filter-btn {
      background: var(--card-bg);
      border: 1px solid var(--border);
      color: var(--text);
      padding: 0.4rem 0.9rem;
      border-radius: 6px;
      cursor: pointer;
      font-size: 0.88rem;
      transition: background 0.15s, border-color 0.15s;
    }
    .filter-btn.active, .filter-btn:hover {
      background: #21262d;
      border-color: #8b949e;
    }
    .diff-list { display: flex; flex-direction: column; gap: 1rem; }
    .diff-card {
      background: var(--card-bg);
      border: 1px solid var(--border);
      border-radius: 8px;
      padding: 1rem 1.25rem;
      transition: transform 0.1s;
    }
    .diff-header {
      display: flex;
      align-items: center;
      gap: 0.6rem;
      margin-bottom: 0.5rem;
      flex-wrap: wrap;
    }
    .repro-btn {
      margin-left: auto;
      background: var(--semantic-bg);
      border: 1px solid var(--semantic);
      border-radius: 6px;
      color: var(--semantic);
      cursor: pointer;
      font-size: 0.8rem;
      padding: 0.35rem 0.65rem;
    }
    .repro-btn:hover { background: rgba(248, 81, 73, 0.25); }
    .diff-number { font-size: 0.85rem; color: var(--text-muted); font-weight: 600; }
    .diff-path { color: #79c0ff; font-weight: 600; font-size: 0.95rem; }
    .diff-body { margin-top: 0.5rem; }
    .diff-desc {
      font-family: ui-monospace, SFMono-Regular, "SF Mono", Menlo, Consolas, monospace;
      font-size: 0.88rem;
      background: #0d1117;
      padding: 0.5rem 0.75rem;
      border-radius: 6px;
      margin-bottom: 0.5rem;
      color: #e6edf3;
      white-space: pre-wrap;
      word-break: break-all;
    }
    .diff-meta { display: flex; gap: 1rem; font-size: 0.8rem; color: var(--text-muted); }
    .badge {
      display: inline-block;
      padding: 0.15rem 0.45rem;
      border-radius: 4px;
      font-size: 0.75rem;
      font-weight: 600;
      letter-spacing: 0.03em;
    }
    .badge-semantic { background: var(--semantic-bg); color: var(--semantic); }
    .badge-uncertain { background: var(--uncertain-bg); color: var(--uncertain); }
    .badge-noise { background: var(--noise-bg); color: var(--noise); }
    .badge-added { background: var(--green-bg); color: var(--green); }
    .badge-removed { background: var(--semantic-bg); color: var(--semantic); }
    .badge-modified { background: var(--uncertain-bg); color: var(--uncertain); }
    .finops-section { margin-bottom: 2rem; background: var(--card-bg); border: 1px solid var(--border); border-radius: 8px; padding: 1.5rem; }
    .finops-title { color: var(--heading); font-size: 1.25rem; font-weight: 700; margin-bottom: 1rem; display: flex; align-items: center; gap: 0.5rem; }
    .finops-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(200px, 1fr)); gap: 1rem; margin-bottom: 1.5rem; }
    .finops-metric { background: #0d1117; border: 1px solid var(--border); border-radius: 6px; padding: 1rem; text-align: center; }
    .finops-val { font-size: 1.4rem; font-weight: 700; color: var(--heading); margin-bottom: 0.2rem; }
    .finops-val.red { color: var(--semantic); }
    .finops-val.green { color: var(--green); }
    .finops-lbl { font-size: 0.8rem; color: var(--text-muted); text-transform: uppercase; letter-spacing: 0.05em; }
    .finops-breakdown { display: grid; grid-template-columns: repeat(auto-fit, minmax(200px, 1fr)); gap: 0.75rem; margin-bottom: 1.25rem; font-size: 0.88rem; }
    .finops-category { background: #0d1117; border: 1px solid var(--border); border-radius: 6px; padding: 0.75rem 1rem; display: flex; justify-content: space-between; }
    .finops-drivers { margin-top: 1rem; }
    .finops-drivers h4 { font-size: 0.95rem; color: var(--heading); margin-bottom: 0.5rem; }
    .driver-item { background: #0d1117; border: 1px solid var(--border); border-radius: 6px; padding: 0.75rem 1rem; margin-bottom: 0.5rem; font-size: 0.88rem; }
    .driver-header { display: flex; justify-content: space-between; font-weight: 600; margin-bottom: 0.25rem; }
    .driver-path { color: #79c0ff; font-family: ui-monospace, monospace; font-size: 0.82rem; }
    .driver-reason { color: var(--text-muted); font-size: 0.82rem; margin-top: 0.25rem; }
    .finops-disclaimer { font-size: 0.8rem; color: var(--text-muted); border-top: 1px solid var(--border); padding-top: 0.75rem; margin-top: 1rem; }
    .json-section { margin-top: 3rem; }
    details { background: var(--card-bg); border: 1px solid var(--border); border-radius: 8px; padding: 0.75rem 1rem; }
    summary { cursor: pointer; color: var(--text); font-weight: 600; }
    pre.raw-json { margin-top: 0.75rem; padding: 1rem; background: #0d1117; border-radius: 6px; overflow-x: auto; font-size: 0.82rem; color: #8b949e; }
    .repro-drawer {
      background: var(--card-bg);
      border: 1px solid var(--border);
      border-radius: 8px;
      display: none;
      margin-bottom: 1.5rem;
      padding: 1rem;
    }
    .repro-drawer.open { display: block; }
    .repro-toolbar { display: flex; gap: 0.5rem; margin-bottom: 0.75rem; }
    .repro-toolbar button {
      background: #21262d;
      border: 1px solid var(--border);
      border-radius: 6px;
      color: var(--text);
      cursor: pointer;
      padding: 0.4rem 0.7rem;
    }
    .repro-toolbar button.active { border-color: #79c0ff; color: #79c0ff; }
    .repro-code { background: #0d1117; border-radius: 6px; margin: 0; min-height: 8rem; overflow-x: auto; padding: 1rem; white-space: pre-wrap; }
    .copy-status { color: var(--green); font-size: 0.85rem; margin-left: auto; }
  </style>
</head>
<body>
  <div class="container">
    <header>
      <h1>TraceDiff Inspection Report</h1>
      <div class="trace-meta">
        <div><strong>Trace A:</strong> ${escapeHtml(options.fileA)} (${summary.traceASize.toLocaleString()} nodes)</div>
        <div><strong>Trace B:</strong> ${escapeHtml(options.fileB)} (${summary.traceBSize.toLocaleString()} nodes)</div>
        <div><strong>Active Rules:</strong> ${escapeHtml(rulesList)}</div>
      </div>
    </header>

    <div class="stats-grid">
      <div class="stat-card">
        <div class="stat-val semantic">${summary.semantic.length}</div>
        <div class="stat-label">Semantic Diffs</div>
      </div>
      <div class="stat-card">
        <div class="stat-val">${summary.uncertain.length}</div>
        <div class="stat-label">Uncertain</div>
      </div>
      <div class="stat-card">
        <div class="stat-val green">${skipPct}%</div>
        <div class="stat-label">Merkle Skipped (${summary.nodesSkipped.toLocaleString()} nodes)</div>
      </div>
      <div class="stat-card">
        <div class="stat-val">${summary.nodesVisited.toLocaleString()}</div>
        <div class="stat-label">Nodes Compared (${comparedPct}%)</div>
      </div>
      <div class="stat-card">
        <div class="stat-val">${summary.timing.totalMs.toFixed(1)} ms</div>
        <div class="stat-label">Total Execution Time</div>
      </div>
    </div>
${
  options.finops
    ? `
    <section class="finops-section">
      <div class="finops-title">💰 FinOps Cost Regression Analysis</div>
      <div class="finops-grid">
        <div class="finops-metric">
          <div class="finops-val">$${options.finops.baselineCostUsd.toFixed(6)}</div>
          <div class="finops-lbl">Baseline Cost / Req</div>
        </div>
        <div class="finops-metric">
          <div class="finops-val">$${options.finops.targetCostUsd.toFixed(6)}</div>
          <div class="finops-lbl">Target Cost / Req</div>
        </div>
        <div class="finops-metric">
          <div class="finops-val ${options.finops.deltaUsd > 0 ? "red" : "green"}">
            ${options.finops.deltaUsd > 0 ? "+" : ""}$${options.finops.deltaUsd.toFixed(6)}
            (${options.finops.percentageChange > 0 ? "+" : ""}${options.finops.percentageChange.toFixed(1)}%)
          </div>
          <div class="finops-lbl">Cost Delta / Req</div>
        </div>
        <div class="finops-metric">
          <div class="finops-val ${options.finops.projectedMonthlyUsd > 0 ? "red" : "green"}">
            ${options.finops.deltaUsd > 0 ? "+" : ""}$${Math.abs(options.finops.projectedMonthlyUsd).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })} / mo
          </div>
          <div class="finops-lbl">Projected Monthly Impact (@ ${options.finops.requestsPerMonth.toLocaleString()} reqs)</div>
        </div>
      </div>

      <div class="finops-breakdown">
        <div class="finops-category">
          <span>Compute (Lambda):</span>
          <strong>${options.finops.categories.delta.computeUsd >= 0 ? "+" : ""}$${options.finops.categories.delta.computeUsd.toFixed(6)}</strong>
        </div>
        <div class="finops-category">
          <span>Database (DynamoDB):</span>
          <strong>${options.finops.categories.delta.databaseUsd >= 0 ? "+" : ""}$${options.finops.categories.delta.databaseUsd.toFixed(6)}</strong>
        </div>
        <div class="finops-category">
          <span>Storage (S3):</span>
          <strong>${options.finops.categories.delta.storageUsd >= 0 ? "+" : ""}$${options.finops.categories.delta.storageUsd.toFixed(6)}</strong>
        </div>
        <div class="finops-category">
          <span>LLM / GenAI:</span>
          <strong>${options.finops.categories.delta.llmUsd >= 0 ? "+" : ""}$${options.finops.categories.delta.llmUsd.toFixed(6)}</strong>
        </div>
      </div>

      ${
        options.finops.topCostDrivers.length > 0
          ? `
      <div class="finops-drivers">
        <h4>Top Cost Drivers</h4>
        ${options.finops.topCostDrivers
          .map(
            (d, i) => `
          <div class="driver-item">
            <div class="driver-header">
              <span>#${i + 1} ${escapeHtml(d.label)}</span>
              <span class="${d.deltaUsd > 0 ? "badge-semantic" : "badge-added"}" style="padding: 0.2rem 0.5rem; border-radius: 4px;">
                ${d.deltaUsd > 0 ? "+" : ""}$${d.deltaUsd.toFixed(6)}
              </span>
            </div>
            <div class="driver-path">${escapeHtml(d.path)}</div>
            <div class="driver-reason">${escapeHtml(d.reason)}</div>
          </div>
        `,
          )
          .join("")}
      </div>
      `
          : ""
      }

      ${
        options.finops.remediations && options.finops.remediations.length > 0
          ? `
      <div class="finops-drivers" style="margin-top: 1.5rem;">
        <h4>💡 Prescriptive Remediation Advisor (7 Cloud Optimization Patterns)</h4>
        ${options.finops.remediations
          .map(
            (r, i) => `
          <div class="driver-item" style="border-left: 3px solid var(--green); padding: 1rem;">
            <div class="driver-header">
              <span><strong>#${i + 1} [${escapeHtml(r.patternName)}]</strong> &bull; <code>${escapeHtml(r.affectedSpanId)}</code></span>
              <span class="badge-added" style="padding: 0.2rem 0.6rem; border-radius: 4px; font-weight: 700;">
                Save up to $${r.potentialMonthlySavingsUsd.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })} / mo
              </span>
            </div>
            <div class="driver-reason" style="color: var(--heading); margin: 0.5rem 0;"><strong>Action:</strong> ${escapeHtml(r.actionableFix)}</div>
            <pre class="raw-json" style="margin-top: 0.5rem; background: #000; padding: 0.75rem; font-size: 0.8rem; border-radius: 4px;">${escapeHtml(r.codeSnippet)}</pre>
          </div>
        `,
          )
          .join("")}
      </div>
      `
          : ""
      }

      <div class="finops-disclaimer">
        <strong>Price Table:</strong> ${escapeHtml(options.finops.priceTableVersion)} &bull; 
        <strong>Notice:</strong> ${escapeHtml(options.finops.disclaimer)}
      </div>
    </section>
`
    : ""
}

    <div class="filter-bar">
      <button class="filter-btn active" onclick="filterDiffs('all', this)">All (${summary.diffs.length})</button>
      <button class="filter-btn" onclick="filterDiffs('semantic', this)">Semantic (${summary.semantic.length})</button>
      <button class="filter-btn" onclick="filterDiffs('uncertain', this)">Uncertain (${summary.uncertain.length})</button>
      <button class="filter-btn" onclick="filterDiffs('noise', this)">Noise (${summary.noise.length})</button>
    </div>

    <section class="repro-drawer" id="reproDrawer" aria-label="Reproduction code">
      <div class="repro-toolbar">
        <button id="curlTab" class="active" onclick="selectReproTab('curl')">cURL</button>
        <button id="vitestTab" onclick="selectReproTab('vitest')">Vitest Test</button>
        <button onclick="copyRepro('curl')">Copy cURL</button>
        <button onclick="copyRepro('vitest')">Copy Vitest Test</button>
        <span class="copy-status" id="copyStatus" aria-live="polite"></span>
      </div>
      <pre class="repro-code" id="reproCode"></pre>
    </section>

    <div class="diff-list" id="diffList">
      ${diffItemsHtml || '<p style="text-align:center; padding: 2rem; color: var(--text-muted);">No differences found — traces are equivalent.</p>'}
    </div>

    <div class="json-section">
      <details>
        <summary>View Raw JSON DiffSummary</summary>
        <pre class="raw-json">${escapeHtml(jsonSummary)}</pre>
      </details>
    </div>
  </div>

  <script>
    const reproBundles = ${JSON.stringify(reproBundles).replace(/</g, "\\u003c")};
    let selectedRepro = null;
    let selectedReproTab = 'curl';

    function openRepro(index) {
      selectedRepro = reproBundles[index];
      selectedReproTab = 'curl';
      document.getElementById('reproDrawer').classList.add('open');
      selectReproTab('curl');
      document.getElementById('reproDrawer').scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    }

    function selectReproTab(tab) {
      if (!selectedRepro) return;
      selectedReproTab = tab;
      document.getElementById('curlTab').classList.toggle('active', tab === 'curl');
      document.getElementById('vitestTab').classList.toggle('active', tab === 'vitest');
      document.getElementById('reproCode').textContent = selectedRepro[tab === 'curl' ? 'curl' : 'vitestFile'];
      document.getElementById('copyStatus').textContent = '';
    }

    async function copyRepro(tab) {
      if (!selectedRepro) return;
      const text = selectedRepro[tab === 'curl' ? 'curl' : 'vitestFile'];
      try {
        await navigator.clipboard.writeText(text);
        document.getElementById('copyStatus').textContent = 'Copied';
      } catch {
        document.getElementById('copyStatus').textContent = 'Copy failed';
      }
    }

    function filterDiffs(type, btn) {
      document.querySelectorAll('.filter-btn').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      const cards = document.querySelectorAll('.diff-card');
      cards.forEach(card => {
        if (type === 'all' || card.getAttribute('data-significance') === type) {
          card.style.display = 'block';
        } else {
          card.style.display = 'none';
        }
      });
    }
  </script>
</body>
</html>
`;
}

function escapeHtml(str: string): string {
  return str
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}
