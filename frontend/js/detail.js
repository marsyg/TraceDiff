"use strict";
/* frontend-v2/js/detail.js — diff detail panel (right column).
   Badges, attribute tables, selected-diff rendering. */

function sigBadge(sig) {
  if (sig === "semantic") return '<span class="state-semantic font-mono text-[9px] font-bold px-1.5 py-0.5 border border-[var(--ink-semantic)]">SEMANTIC</span>';
  if (sig === "noise") return '<span class="state-noise font-mono text-[9px] font-bold px-1.5 py-0.5 border border-[var(--ink-noise)]">NOISE</span>';
  if (sig === "uncertain") return '<span class="state-uncertain font-mono text-[9px] font-bold px-1.5 py-0.5 border border-dashed border-[var(--ink-uncertain)]">UNCERTAIN</span>';
  return '<span class="font-mono text-[9px] font-bold px-1.5 py-0.5 rounded border border-[var(--border-strong)] text-[var(--text-secondary)]">UNKNOWN</span>';
}
function typeBadge(t) {
  var c = t === "added" ? "state-added border border-[var(--ink-added)]" : t === "removed" ? "state-removed border border-[var(--ink-removed)]" : "border border-[var(--border-strong)] text-[var(--text-secondary)]";
  return '<span class="font-mono text-[9px] font-bold px-1.5 py-0.5 ' + c + '">' + esc(String(t || "modified").toUpperCase()) + "</span>";
}
function attrTable(nodeA, nodeB, highlight) {
  if (!nodeA && !nodeB) return '<p class="text-[var(--text-muted)]">No span attributes returned for this diff.</p>';
  var keys = {};
  [nodeA, nodeB].forEach(function (n) {
    var a = (n && n.attributes) || {};
    Object.keys(a).forEach(function (k) { keys[k] = true; });
  });
  function sideTable(node, other, side) {
    var rows = Object.keys(keys).sort().map(function (k) {
      var v = node && node.attributes ? node.attributes[k] : undefined;
      var o = other && other.attributes ? other.attributes[k] : undefined;
      var s = v === undefined ? "--" : JSON.stringify(v);
      var changed = highlight && s !== (o === undefined ? "--" : JSON.stringify(o));
      return '<tr class="' + (changed ? "bg-[var(--ink-semantic-bg)]" : "") + '"><td class="py-1 pr-3 text-[var(--text-secondary)]">' + esc(k) + "</td>"
        + '<td class="py-1 pr-3 break-all font-mono ' + (changed ? "text-[var(--ink-semantic)] font-medium" : "text-[var(--text-muted)]") + '">' + esc(s) + "</td></tr>";
    }).join("");
    return '<table class="w-full text-left"><thead><tr class="text-[var(--text-muted)] text-[10px] uppercase font-mono">'
      + "<th class='py-1 pr-3'>attribute</th><th class='py-1'>" + side + "</th></tr></thead>"
      + "<tbody>" + rows + "</tbody></table>";
  }
  return '<div class="detail-grid">' + sideTable(nodeA, nodeB, "Trace A") + sideTable(nodeB, nodeA, "Trace B") + "</div>";
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
  var head = '<div class="flex items-center gap-2 flex-wrap">' + typeBadge(r.type) + sigBadge(sig) + "</div>"
    + '<h3 class="text-sm font-semibold text-[var(--text-primary)] mt-3 break-all font-mono">' + esc(opLabel(r)) + "</h3>"
    + '<div class="text-[var(--text-secondary)] mt-1 break-all font-mono text-[11px]">' + crumb + "</div>";
  var ruleTag = r.classifiedBy
    ? '<div class="mt-3"><span class="font-mono text-[10px] px-2 py-1 rounded-md border border-edge bg-surface2 text-[var(--text-secondary)]">via ' + esc(r.classifiedBy) + "</span></div>"
    : "";
  var meta = '<div class="grid grid-cols-2 gap-2 mt-3">'
    + '<div class="border border-edge rounded-lg p-2.5"><div class="text-[10px] uppercase text-[var(--text-muted)]">depth</div><div class="text-[var(--text-primary)] mt-0.5 font-mono">' + r.depth + "</div></div>"
    + '<div class="border border-edge rounded-lg p-2.5"><div class="text-[10px] uppercase text-[var(--text-muted)]">affected subtree</div><div class="text-[var(--text-primary)] mt-0.5 font-mono">' + r.affectedSubtreeSize + " spans</div></div>"
    + "</div>";
  var body = '<p class="text-[var(--text-secondary)] text-[13px] mt-3">' + esc(r.description || "") + "</p>";
  if (sig === "uncertain") {
    body += '<div class="mt-3 border border-dashed border-[var(--ink-uncertain)] rounded-lg p-3 font-mono text-[11px] text-[var(--ink-uncertain)]">Not fully explored — depth limit reached. Treat as needing judgment, not a resolved verdict.</div>';
  }
  var attrs = "";
  if (r.type === "added") {
    attrs = '<div class="mt-3 pt-3 border-t border-edge"><div class="text-[10px] uppercase text-[var(--text-muted)] mb-2">Trace B attributes · +' + r.affectedSubtreeSize + ' descendant nodes</div>' + attrTable(null, r.nodeB, false) + "</div>";
  } else if (r.type === "removed") {
    attrs = '<div class="mt-3 pt-3 border-t border-edge"><div class="text-[10px] uppercase text-[var(--text-muted)] mb-2">Trace A attributes · gone from B</div>' + attrTable(r.nodeA, null, false) + "</div>";
  } else if (sig === "noise") {
    attrs = '<div class="mt-3 pt-3 border-t border-edge opacity-80"><div class="text-[10px] uppercase text-[var(--text-muted)] mb-2">attributes (judged safe)</div>' + attrTable(r.nodeA, r.nodeB, false) + "</div>";
  } else {
    attrs = '<div class="mt-3 pt-3 border-t border-edge"><div class="text-[10px] uppercase text-[var(--text-muted)] mb-2">attribute diff | Trace A vs Trace B</div>' + attrTable(r.nodeA, r.nodeB, true) + "</div>";
  }
  host.innerHTML = head + ruleTag + meta + body + attrs;
  icons();
}
function opLabel(r) {
  if (r.nodeA && r.nodeA.label) return r.nodeA.label;
  if (r.nodeB && r.nodeB.label) return r.nodeB.label;
  var p = breadcrumbs(r);
  return p.length ? p[p.length - 1] : "(root)";
}
