"use strict";
/* frontend-v2/js/detail.js — diff detail panel (right column).
   Structured divergence breakdown, formatted JSON & timestamps,
   delta calculations, and responsive attribute comparison table. */

function sigBadge(sig) {
  if (sig === "semantic") return '<span class="state-semantic font-mono text-[9px] font-bold px-1.5 py-0.5 border border-[rgb(var(--ink-semantic))]">SEMANTIC</span>';
  if (sig === "noise") return '<span class="state-noise font-mono text-[9px] font-bold px-1.5 py-0.5 border border-[rgb(var(--ink-noise))]">NOISE</span>';
  if (sig === "uncertain") return '<span class="state-uncertain font-mono text-[9px] font-bold px-1.5 py-0.5 border border-dashed border-[rgb(var(--ink-uncertain))]">UNCERTAIN</span>';
  return '<span class="font-mono text-[9px] font-bold px-1.5 py-0.5 rounded border border-[var(--border-strong)] text-[var(--text-secondary)]">UNKNOWN</span>';
}

function typeBadge(t) {
  var c = t === "added" ? "state-added border border-[rgb(var(--ink-added))]" : t === "removed" ? "state-removed border border-[rgb(var(--ink-removed))]" : "border border-[var(--border-strong)] text-[var(--text-secondary)]";
  return '<span class="font-mono text-[9px] font-bold px-1.5 py-0.5 ' + c + '">' + esc(String(t || "modified").toUpperCase()) + "</span>";
}

// ---- Formatting Helpers ---------------------------------------------------

function isIsoDate(s) {
  if (typeof s !== "string") return false;
  return /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})?$/.test(s.trim());
}

function isTimestampKey(k) {
  if (!k) return false;
  var lk = String(k).toLowerCase();
  return lk.includes("timestamp") || lk.includes("time_iso") || lk === "time" || lk.endsWith("_at") || lk === "date";
}

function formatIso(isoStr) {
  try {
    var s = String(isoStr).trim();
    var p = s.split("T");
    if (p.length === 2) {
      var datePart = p[0];
      var timePart = p[1].replace("Z", "");
      return '<span class="trace-value text-[var(--text-primary)] inline-block" title="' + esc(s) + '">'
        + '<span class="text-[10px] text-[var(--text-muted)] block leading-none mb-0.5">' + esc(datePart) + '</span>'
        + '<span class="font-bold">' + esc(timePart) + ' <span class="text-[9px] text-[var(--text-muted)] font-normal">UTC</span></span>'
        + '</span>';
    }
    var clean = s.replace("T", " ").replace("Z", "");
    return '<span class="trace-value text-[var(--text-primary)]" title="' + esc(s) + '">'
      + esc(clean) + ' <span class="text-[10px] text-[var(--text-muted)] font-normal">UTC</span></span>';
  } catch (e) {
    return esc(isoStr);
  }
}

function formatEpoch(num) {
  try {
    var ms = num > 1e11 ? num : num * 1000;
    var d = new Date(ms);
    var iso = d.toISOString().replace("T", " ").replace("Z", " UTC");
    return '<span class="trace-value text-[var(--text-primary)]" title="Epoch: ' + num + '">'
      + num + ' <span class="text-[10px] text-[var(--text-muted)] font-normal">(' + iso + ')</span></span>';
  } catch (e) {
    return String(num);
  }
}

function unquote(s) {
  if (s == null) return "";
  s = String(s).trim();
  if (s === "undefined") return undefined;
  if (s === "null") return null;
  if (s === "true") return true;
  if (s === "false") return false;
  if ((s.startsWith('"') && s.endsWith('"')) || (s.startsWith("'") && s.endsWith("'"))) {
    try {
      return JSON.parse(s);
    } catch (e) {
      return s.slice(1, -1);
    }
  }
  if (!isNaN(Number(s)) && s !== "") {
    return Number(s);
  }
  return s;
}

function formatValue(v, key) {
  if (v === undefined) {
    return '<span class="text-[var(--text-muted)] italic">undefined</span>';
  }
  if (v === null) {
    return '<span class="text-[var(--text-muted)] italic">null</span>';
  }
  if (typeof v === "boolean") {
    return v
      ? '<span class="font-mono text-[rgb(var(--ink-added))] font-bold">true</span>'
      : '<span class="font-mono text-[rgb(var(--ink-removed))] font-bold">false</span>';
  }
  if (typeof v === "number") {
    if (isTimestampKey(key) && v > 1e9) {
      return formatEpoch(v);
    }
    if (key === "http.status_code" || key === "status_code") {
      if (v === 200) return '<span class="font-mono font-bold text-[rgb(var(--ink-added))] bg-[rgb(var(--ink-added)_/_0.12)] px-1.5 py-0.5 rounded">200 OK</span>';
      if (v === 500) return '<span class="font-mono font-bold text-[rgb(var(--ink-semantic))] bg-[rgb(var(--ink-semantic)_/_0.12)] px-1.5 py-0.5 rounded">500 Error</span>';
      if (v >= 400 && v < 500) return '<span class="font-mono font-bold text-[rgb(var(--ink-noise))] bg-[rgb(var(--ink-noise)_/_0.12)] px-1.5 py-0.5 rounded">' + v + '</span>';
      return '<span class="font-mono font-bold text-[var(--text-primary)]">' + v + '</span>';
    }
    if (key && (key.includes("duration") || key.includes("latency") || key.endsWith("_ms"))) {
      var dStr = v.toFixed ? v.toFixed(2) : String(v);
      return '<span class="trace-value text-[var(--text-primary)]">' + dStr + ' <span class="text-[10px] text-[var(--text-muted)]">ms</span></span>';
    }
    if (key && (key.includes("price") || key.includes("cost") || key.endsWith("_cents"))) {
      return '<span class="trace-value text-[var(--text-primary)]">$' + (v / 100).toFixed(2) + ' <span class="text-[10px] text-[var(--text-muted)]">(' + v + '¢)</span></span>';
    }
    return '<span class="trace-value text-[var(--text-primary)]">' + Number(v).toLocaleString() + '</span>';
  }
  if (typeof v === "string") {
    if (isIsoDate(v)) {
      return formatIso(v);
    }
    if (v === "") {
      return '<span class="text-[var(--text-muted)] italic">(empty string)</span>';
    }
    return '<span class="trace-value text-[var(--text-primary)] break-words">' + esc(v) + '</span>';
  }
  if (typeof v === "object") {
    try {
      var json = JSON.stringify(v, null, 2);
      return '<pre class="font-mono text-[11px] leading-tight bg-[var(--surface-raised)] border border-[var(--border)] rounded p-2 overflow-x-auto text-[var(--text-primary)] max-h-40 whitespace-pre-wrap">' + esc(json) + '</pre>';
    } catch (e) {
      return '<span class="trace-value text-[var(--text-muted)]">' + esc(String(v)) + '</span>';
    }
  }
  return '<span class="trace-value text-[var(--text-primary)]">' + esc(String(v)) + '</span>';
}

function sigTint(sig) {
  // Delta pills never re-derive significance — the backend verdict is
  // authoritative. Tint purely from the sig already computed upstream.
  if (sig === "semantic") return "text-[rgb(var(--ink-semantic))] bg-[rgb(var(--ink-semantic)_/_0.12)] border-[rgb(var(--ink-semantic))]";
  if (sig === "uncertain") return "text-[rgb(var(--ink-uncertain))] bg-transparent border-[rgb(var(--ink-uncertain))]";
  return "text-[rgb(var(--ink-noise))] bg-[rgb(var(--ink-noise)_/_0.12)] border-[rgb(var(--ink-noise))]";
}

function formatDelta(vA, vB, key, sig) {
  if (vA === undefined || vB === undefined) return "";

  // 1. HTTP status code change label (key-driven, not a verdict).
  if (key === "http.status_code" || key === "status_code") {
    if (vA !== vB) {
      return '<span class="text-[10px] font-mono font-bold px-1.5 py-0.5 rounded bg-[rgb(var(--ink-semantic)_/_0.12)] text-[rgb(var(--ink-semantic))] border border-[rgb(var(--ink-semantic))]">STATUS CHANGE</span>';
    }
    return "";
  }

  var tint = sigTint(sig);

  // 2. Timestamp delta.
  var tA = isIsoDate(vA) ? new Date(vA).getTime() : (typeof vA === "number" && isTimestampKey(key)) ? (vA > 1e11 ? vA : vA * 1000) : null;
  var tB = isIsoDate(vB) ? new Date(vB).getTime() : (typeof vB === "number" && isTimestampKey(key)) ? (vB > 1e11 ? vB : vB * 1000) : null;
  if (tA != null && tB != null && !isNaN(tA) && !isNaN(tB)) {
    var diffMs = tB - tA;
    if (diffMs !== 0) {
      var sign = diffMs > 0 ? "+" : "";
      return '<span class="inline-flex items-center gap-1 text-[10px] font-mono px-1.5 py-0.5 rounded border ' + tint + '" title="Timestamp shifted by ' + diffMs + 'ms">'
        + 'Δ ' + sign + diffMs.toLocaleString() + 'ms</span>';
    }
    return '<span class="text-[10px] font-mono text-[var(--text-muted)]">Δ 0ms</span>';
  }

  // 3. Numeric delta (magnitude only — tint comes from sig, never recomputed).
  if (typeof vA === "number" && typeof vB === "number") {
    var d = vB - vA;
    if (Math.abs(d) > 0.0001) {
      var s = d > 0 ? "+" : "";
      var formattedD = Math.abs(d) < 1 ? d.toFixed(3) : d.toFixed(2);
      var isDuration = key && (key.includes("duration") || key.includes("latency") || key.endsWith("_ms"));
      var unit = isDuration ? "ms" : "";
      return '<span class="inline-flex items-center gap-1 text-[10px] font-mono px-1.5 py-0.5 rounded border ' + tint + '">'
        + 'Δ ' + s + formattedD + unit + '</span>';
    }
  }

  return "";
}

// ---- Divergence Breakdown -------------------------------------------------

function renderDivergences(description) {
  if (!description) return "";
  var parts = String(description).split("; ");
  var regex = /^([^:]+):\s*(.*?)\s*→\s*(.*?)\s*\((semantic|noise|uncertain)(?:\s+via\s+([^)]+))?\)$/;
  var items = [];
  var nonFieldParts = [];

  for (var i = 0; i < parts.length; i++) {
    var p = parts[i].trim();
    if (!p) continue;
    var m = p.match(regex);
    if (m) {
      items.push({
        field: m[1].trim(),
        rawA: unquote(m[2].trim()),
        rawB: unquote(m[3].trim()),
        sig: m[4].trim(),
        rule: m[5] ? m[5].trim() : ""
      });
    } else {
      nonFieldParts.push(p);
    }
  }

  var html = "";

  // If there are structural/sentence notes:
  if (nonFieldParts.length > 0) {
    html += '<div class="mt-3 p-3 rounded-lg border border-edge bg-surface2 text-xs font-mono text-[var(--text-secondary)] leading-relaxed">'
      + nonFieldParts.map(esc).join("<br>") + '</div>';
  }

  if (items.length === 0) return html;

  var semanticItems = items.filter(function (it) { return it.sig === "semantic"; });
  var uncertainItems = items.filter(function (it) { return it.sig === "uncertain"; });
  var noiseItems = items.filter(function (it) { return it.sig === "noise"; });

  html += '<div class="mt-4 space-y-3">';

  // 1. Semantic items (loud, prominent)
  if (semanticItems.length > 0) {
    html += '<div>'
      + '<div class="flex items-center gap-1.5 font-mono text-[11px] uppercase tracking-wider text-[rgb(var(--ink-semantic))] font-bold mb-1.5">'
      + '<i data-lucide="triangle-alert" class="w-3.5 h-3.5"></i>'
      + '<span>Semantic Regressions (' + semanticItems.length + ')</span>'
      + '</div>'
      + '<div class="space-y-2">';

    semanticItems.forEach(function (it) {
      // Single home for Δ pills is the attribute table below; cards keep
      // the field name plus the classifying-rule badge only.
      var ruleBadge = it.rule ? '<span class="text-[9px] font-mono px-1.5 py-0.5 rounded border border-edge bg-surface text-[var(--text-secondary)]">via ' + esc(it.rule) + '</span>' : '';
      html += '<div class="p-2.5 rounded-lg border border-[rgb(var(--ink-semantic))] bg-[rgb(var(--ink-semantic)_/_0.12)]">'
        + '<div class="flex items-center justify-between gap-2 mb-1.5 flex-wrap">'
        + '<span class="font-mono text-xs font-bold text-[rgb(var(--ink-semantic))]">' + esc(it.field) + '</span>'
        + ruleBadge
        + '</div>'
        + '<div class="grid grid-cols-2 gap-2 font-mono text-xs pt-1 border-t border-[var(--ink-semantic-bg)]">'
        + '<div><div class="text-[9px] uppercase tracking-wider text-[var(--text-muted)]">Trace A (baseline)</div><div class="mt-0.5">' + formatValue(it.rawA, it.field) + '</div></div>'
        + '<div><div class="text-[9px] uppercase tracking-wider text-[var(--text-muted)]">Trace B (target)</div><div class="mt-0.5 font-bold">' + formatValue(it.rawB, it.field) + '</div></div>'
        + '</div></div>';
    });

    html += '</div></div>';
  }

  // 2. Uncertain items
  if (uncertainItems.length > 0) {
    html += '<div>'
      + '<div class="flex items-center gap-1.5 font-mono text-[11px] uppercase tracking-wider text-[rgb(var(--ink-uncertain))] font-bold mb-1.5">'
      + '<i data-lucide="circle-help" class="w-3.5 h-3.5"></i>'
      + '<span>Uncertain Divergences (' + uncertainItems.length + ')</span>'
      + '</div>'
      + '<div class="space-y-2">';

    uncertainItems.forEach(function (it) {
      html += '<div class="p-2.5 rounded-lg border border-dashed border-[rgb(var(--ink-uncertain))] bg-surface2">'
        + '<div class="flex items-center justify-between gap-2 mb-1.5 flex-wrap">'
        + '<span class="font-mono text-xs font-bold text-[rgb(var(--ink-uncertain))]">' + esc(it.field) + '</span>'
        + '</div>'
        + '<div class="grid grid-cols-2 gap-2 font-mono text-xs pt-1 border-t border-[var(--border)]">'
        + '<div><div class="text-[9px] uppercase tracking-wider text-[var(--text-muted)]">Trace A</div><div class="mt-0.5">' + formatValue(it.rawA, it.field) + '</div></div>'
        + '<div><div class="text-[9px] uppercase tracking-wider text-[var(--text-muted)]">Trace B</div><div class="mt-0.5">' + formatValue(it.rawB, it.field) + '</div></div>'
        + '</div></div>';
    });

    html += '</div></div>';
  }

  // 3. Noise items (judged safe) — collapsed by default so the section
  // never buries the semantic cards it exists to de-emphasize.
  if (noiseItems.length > 0) {
    html += '<div>'
      + '<div class="flex items-center gap-1.5 font-mono text-[11px] uppercase tracking-wider text-[rgb(var(--ink-noise))] font-semibold mb-1.5 cursor-pointer" data-noise-toggle title="Show/hide judged-safe noise">'
      + '<span data-noise-caret>▸</span>'
      + '<i data-lucide="circle-check-big" class="w-3.5 h-3.5"></i>'
      + '<span>Equivalence Noise (' + noiseItems.length + ') · judged safe by rules</span>'
      + '</div>'
      + '<div class="space-y-1.5 hidden" data-noise-items>';

    noiseItems.forEach(function (it) {
      var ruleBadge = it.rule ? '<span class="text-[9px] font-mono px-1.5 py-0.5 rounded border border-edge bg-surface text-[var(--text-secondary)]">via ' + esc(it.rule) + '</span>' : '';
      html += '<div class="p-2 rounded-lg border border-edge bg-surface2 hover:border-[var(--border-strong)] transition-colors">'
        + '<div class="flex items-center justify-between gap-2 mb-1 flex-wrap">'
        + '<span class="font-mono text-xs text-[rgb(var(--ink-noise))]">' + esc(it.field) + '</span>'
        + ruleBadge
        + '</div>'
        + '<div class="grid grid-cols-2 gap-2 font-mono text-xs pt-1 border-t border-[var(--border)]">'
        + '<div><div class="text-[9px] uppercase tracking-wider text-[var(--text-muted)]">Trace A</div><div class="mt-0.5 break-all leading-tight">' + formatValue(it.rawA, it.field) + '</div></div>'
        + '<div><div class="text-[9px] uppercase tracking-wider text-[var(--text-muted)]">Trace B</div><div class="mt-0.5 break-all leading-tight">' + formatValue(it.rawB, it.field) + '</div></div>'
        + '</div></div>';
    });

    html += '</div></div>';
  }

  html += '</div>';
  return html;
}

// ---- Attribute Comparison Table -------------------------------------------

function attrTable(nodeA, nodeB, highlight, sig) {
  if (!nodeA && !nodeB) return '<p class="text-[var(--text-muted)]">No span attributes returned for this diff.</p>';

  var keysObj = {};
  [nodeA, nodeB].forEach(function (n) {
    var a = (n && n.attributes) || {};
    Object.keys(a).forEach(function (k) { keysObj[k] = true; });
  });
  var allKeys = Object.keys(keysObj).sort();

  // If only nodeA exists (removed) or only nodeB exists (added)
  if (!nodeA || !nodeB) {
    var targetNode = nodeB || nodeA;
    var sideLabel = nodeB ? "Trace B (added)" : "Trace A (removed)";
    var rows = allKeys.map(function (k) {
      var v = targetNode && targetNode.attributes ? targetNode.attributes[k] : undefined;
      return '<tr class="border-b border-edge/60 hover:bg-[var(--surface-raised)] transition-colors">'
        + '<td class="py-2 px-3 text-[var(--text-secondary)] font-medium align-top whitespace-nowrap">' + esc(k) + '</td>'
        + '<td class="py-2 px-3 align-top break-all font-mono">' + formatValue(v, k) + '</td>'
        + '</tr>';
    }).join("");

    return '<div class="overflow-x-auto border border-edge rounded-lg bg-surface">'
      + '<table class="w-full text-left font-mono text-xs border-collapse">'
      + '<thead><tr class="bg-surface2 text-[var(--text-muted)] text-[10px] uppercase border-b border-edge">'
      + '<th class="py-2 px-3 font-semibold">attribute</th>'
      + '<th class="py-2 px-3 font-semibold">' + sideLabel + '</th>'
      + '</tr></thead>'
      + '<tbody>' + rows + '</tbody></table></div>';
  }

  // Both nodeA and nodeB exist: unified 3-column diff table. Changed rows
  // render up front; unchanged rows hide behind a local toggle so long
  // attribute lists don't bury the divergence they surround.
  var changedRows = [], unchangedRows = [];
  allKeys.forEach(function (k) {
    var vA = nodeA && nodeA.attributes ? nodeA.attributes[k] : undefined;
    var vB = nodeB && nodeB.attributes ? nodeB.attributes[k] : undefined;
    var sA = vA === undefined ? "--" : JSON.stringify(vA);
    var sB = vB === undefined ? "--" : JSON.stringify(vB);
    var isChanged = highlight && sA !== sB;

    var delta = isChanged ? formatDelta(vA, vB, k, sig) : "";
    var rowClass = isChanged
      ? 'border-b border-edge bg-[rgb(var(--ink-semantic)_/_0.12)] hover:bg-[var(--surface-raised)] transition-colors'
      : 'border-b border-edge/40 hover:bg-[var(--surface-raised)] transition-colors opacity-75 hover:opacity-100';

    var row = '<tr class="' + rowClass + '">'
      + '<td class="py-2 px-3 text-[var(--text-primary)] font-medium align-top whitespace-nowrap">'
      + esc(k)
      + (isChanged ? '<span class="inline-block w-1.5 h-1.5 rounded-full bg-[rgb(var(--ink-semantic))] ml-1.5 align-middle"></span>' : '')
      + '</td>'
      + '<td class="py-2 px-3 align-top break-all font-mono">' + formatValue(vA, k) + '</td>'
      + '<td class="py-2 px-3 align-top break-all font-mono">' + formatValue(vB, k)
      + (delta ? '<div class="mt-1">' + delta + '</div>' : '')
      + '</td>'
      + '</tr>';
    (isChanged ? changedRows : unchangedRows).push(row);
  });

  var toggleHtml = "";
  if (unchangedRows.length) {
    toggleHtml = '<button type="button" data-attr-toggle data-count="' + unchangedRows.length + '" class="mt-2 font-mono text-[11px] text-[var(--text-secondary)] hover:text-[var(--text-primary)] transition-colors">'
      + 'Show ' + unchangedRows.length + ' unchanged attributes</button>';
  }

  return '<div class="overflow-x-auto border border-edge rounded-lg bg-surface">'
    + '<table class="w-full text-left font-mono text-xs border-collapse">'
    + '<thead><tr class="bg-surface2 text-[var(--text-muted)] text-[10px] uppercase border-b border-edge">'
    + '<th class="py-2 px-3 font-semibold">attribute</th>'
    + '<th class="py-2 px-3 font-semibold">Trace A</th>'
    + '<th class="py-2 px-3 font-semibold">Trace B</th>'
    + '</tr></thead>'
    + '<tbody>' + changedRows.join("") + '</tbody>'
    + (unchangedRows.length ? '<tbody data-attr-unchanged class="hidden">' + unchangedRows.join("") + '</tbody>' : '')
    + '</table></div>' + toggleHtml;
}

function renderDetail() {
  var host = el("detail-body");
  var r = state.results[state.selected];
  if (!r) {
    host.innerHTML = '<div class="text-center py-10">'
      + '<i data-lucide="mouse-pointer-click" class="w-6 h-6 text-[var(--text-muted)] mx-auto mb-2"></i>'
      + '<p class="font-mono text-xs text-[var(--text-secondary)]">Select a diff to inspect</p>'
      + '<p class="font-mono text-[11px] text-[var(--text-muted)] mt-1">Click any row in the unified tree.</p></div>';
    icons();
    return;
  }

  var sig = sigOf(r);
  var crumb = esc(breadcrumbs(r).join("  ›  ") || "(root)");
  var head = '<div class="flex items-center gap-2 flex-wrap">' + typeBadge(r.type) + sigBadge(sig) + '</div>'
    + '<h3 class="text-sm font-semibold text-[var(--text-primary)] mt-3 break-all font-mono">' + esc(opLabel(r)) + '</h3>'
    + '<div class="text-[var(--text-secondary)] mt-1 break-all font-mono text-[11px]">' + crumb + '</div>';

  var ruleTag = r.classifiedBy
    ? '<div class="mt-2.5"><span class="font-mono text-[10px] px-2 py-1 rounded-md border border-edge bg-surface2 text-[var(--text-secondary)]">via ' + esc(r.classifiedBy) + '</span></div>'
    : '';

  // Extract node info if available
  var activeNode = r.nodeB || r.nodeA;
  var metaCols = [
    { label: "depth", val: r.depth },
    { label: "affected subtree", val: r.affectedSubtreeSize + " spans" }
  ];
  if (activeNode) {
    if (activeNode.id) metaCols.push({ label: "span id", val: activeNode.id });
    if (activeNode.type) metaCols.push({ label: "type", val: activeNode.type });
  }

  var metaGrid = '<div class="grid grid-cols-2 gap-2 mt-3">'
    + metaCols.map(function (c) {
      return '<div class="border border-edge rounded-lg p-2.5 bg-surface2">'
        + '<div class="text-[9px] uppercase tracking-wider text-[var(--text-muted)] font-mono">' + esc(c.label) + '</div>'
        + '<div class="text-[var(--text-primary)] mt-0.5 font-mono text-xs truncate" title="' + esc(c.val) + '">' + esc(c.val) + '</div>'
        + '</div>';
    }).join("")
    + '</div>';

  // FinOps: show this span's cost impact when it is a top driver.
  // Matched by span id (either trace side); silently absent otherwise.
  var finopsHtml = "";
  if (typeof driverForDiff === "function" && typeof fmtUsd === "function") {
    var fdrv = driverForDiff(r);
    if (fdrv) {
      var f = state.summary && state.summary.finops;
      var rpm = f && f.requestsPerMonth ? Number(f.requestsPerMonth) : 10000000;
      var fdc = fdrv.deltaUsd > 0 ? "text-[rgb(var(--ink-semantic))]" : fdrv.deltaUsd < 0 ? "text-[rgb(var(--ink-added))]" : "text-[var(--text-secondary)]";
      finopsHtml = '<div class="mt-3 border border-edge rounded-lg p-3 bg-surface2">'
        + '<div class="font-mono text-[10px] uppercase tracking-wider text-[var(--text-muted)] mb-1.5">💸 Cost impact</div>'
        + '<div class="font-mono text-sm font-bold ' + fdc + '">'
        + fmtUsd(fdrv.deltaUsd, 6) + ' / req · ' + fmtUsd(fdrv.baselineUsd, 6) + ' → ' + fmtUsd(fdrv.targetUsd, 6)
        + "</div>"
        + '<div class="font-mono text-[11px] text-[var(--text-secondary)] mt-1">≈ ' + fmtUsdMonthly(fdrv.deltaUsd * rpm) + ' @ ' + rpm.toLocaleString() + ' reqs/mo</div>'
        + '<div class="text-[12px] text-[var(--text-secondary)] mt-1.5">' + esc(fdrv.reason || "") + "</div>"
        + "</div>";
    }
  }

  // Structured breakdown of field divergences (semantic / uncertain / noise)
  var divergencesHtml = renderDivergences(r.description);

  if (sig === "uncertain") {
    divergencesHtml += '<div class="mt-3 border border-dashed border-[rgb(var(--ink-uncertain))] rounded-lg p-3 font-mono text-[11px] text-[rgb(var(--ink-uncertain))] bg-[var(--surface-raised)]">'
      + 'Not fully explored — depth limit reached. Treat as needing judgment, not a resolved verdict.</div>';
  }

  // All attributes table
  var attrs = "";
  if (r.type === "added") {
    attrs = '<div class="mt-5 pt-3 border-t border-edge">'
      + '<div class="flex items-center justify-between text-[10px] uppercase font-mono tracking-wider text-[var(--text-muted)] mb-2 font-semibold">'
      + '<span>Trace B Attributes</span>'
      + '<span class="text-[rgb(var(--ink-added))] font-bold">+' + r.affectedSubtreeSize + ' descendant spans</span>'
      + '</div>'
      + attrTable(null, r.nodeB, false)
      + '</div>';
  } else if (r.type === "removed") {
    attrs = '<div class="mt-5 pt-3 border-t border-edge">'
      + '<div class="flex items-center justify-between text-[10px] uppercase font-mono tracking-wider text-[var(--text-muted)] mb-2 font-semibold">'
      + '<span>Trace A Attributes (Gone from Trace B)</span>'
      + '<span class="text-[rgb(var(--ink-removed))] font-bold">removed</span>'
      + '</div>'
      + attrTable(r.nodeA, null, false)
      + '</div>';
  } else if (sig === "noise") {
    attrs = '<div class="mt-5 pt-3 border-t border-edge">'
      + '<div class="text-[10px] uppercase font-mono tracking-wider text-[var(--text-muted)] mb-2 font-semibold">Attributes (judged safe via rules)</div>'
      + attrTable(r.nodeA, r.nodeB, false)
      + '</div>';
  } else {
    attrs = '<div class="mt-5 pt-3 border-t border-edge">'
      + '<div class="text-[10px] uppercase font-mono tracking-wider text-[var(--text-muted)] mb-2 font-semibold">Full Span Attributes · Trace A vs Trace B</div>'
      + attrTable(r.nodeA, r.nodeB, true, sig)
      + '</div>';
  }

  host.innerHTML = head + ruleTag + metaGrid + finopsHtml + divergencesHtml + attrs;
  // Local toggles (no shared state): noise section and unchanged rows both
  // start collapsed; each re-render resets them to that default.
  host.querySelectorAll("[data-noise-toggle]").forEach(function (t) {
    t.addEventListener("click", function () {
      var items = t.parentNode.querySelector("[data-noise-items]");
      if (!items) return;
      var nowHidden = items.classList.toggle("hidden");
      var caret = t.querySelector("[data-noise-caret]");
      if (caret) caret.textContent = nowHidden ? "▸" : "▾";
    });
  });
  host.querySelectorAll("[data-attr-toggle]").forEach(function (btn) {
    btn.addEventListener("click", function () {
      var bodies = btn.parentNode.querySelectorAll("[data-attr-unchanged]");
      var anyHidden = false;
      bodies.forEach(function (b) { if (b.classList.contains("hidden")) anyHidden = true; });
      bodies.forEach(function (b) {
        if (anyHidden) b.classList.remove("hidden"); else b.classList.add("hidden");
      });
      btn.textContent = (anyHidden ? "Hide " : "Show ") + btn.getAttribute("data-count") + " unchanged attributes";
    });
  });
  icons();
}

function opLabel(r) {
  if (r.nodeA && r.nodeA.label) return r.nodeA.label;
  if (r.nodeB && r.nodeB.label) return r.nodeB.label;
  var p = breadcrumbs(r);
  return p.length ? p[p.length - 1] : "(root)";
}
