"use strict";
/* frontend-v2/js/tree.js — unified diff tree.
   Covers: path keys, renderAll, significance filter + search + grouping,
   KPI bar, row model, annotate, tree render.
   Key invariant: ALL path-key construction uses the visible "\u0001" escape
   (U+0001). A literal control byte and "" look identical in editors but
   produce different runtime keys — that invisible-difference class is what
   caused the old "everything is unchanged" bug. */

// ---- Path keys ----------------------------------------------------------
// One tree rooted at the common root, colored per node. Removed nodes don't
// exist in Trace B, so they render inline under their parent anchor in B
// (their pathA minus the last segment locates that anchor).
// Removed diffs index by pathA (where the node actually lived). Indexing
// them by pathB (the surviving parent anchor, which the engine sets as
// pathB) would attach a REMOVED verdict onto the parent row itself —
// mislabeling a healthy parent and duplicating the inline removed row.
function pathOf(r) {
  if (r.type === "removed") return r.pathA || r.pathB || [];
  return r.pathB || r.pathA || [];
}
// VISIBLE escape (not a literal control byte) so all key sites look identical.
function pathKey(r) { return pathOf(r).join("\u0001"); }
function breadcrumbs(r) {
  // Display path: where the node actually lives.
  if (r.type === "removed") return r.pathA || r.pathB || [];
  return r.pathB || r.pathA || [];
}

function renderAll() {
  // FIX (stale view state): a new diff is a new context. Without this, a
  // search string or toggled-off seg chip from the previous run silently
  // filters the fresh result set — KPI correctly shows 5 while the tree
  // shows "No rows match the current filter". Mirrors Reset button state.
  state.query = ""; state.groupBy = "none";
  state.showSig = { semantic: true, uncertain: true, noise: true };
  if (el("tree-search")) el("tree-search").value = "";
  if (el("group-select")) el("group-select").value = "none";

  renderKpis();
  el("tree-toolbar").classList.remove("hidden");
  el("tree-section").classList.remove("hidden");
  paintSegButtons();
  state.diffByPath = {};
  state.nodeIndex = {};
  state.results.forEach(function (r, i) {
    var k = pathKey(r);
    if (!state.diffByPath[k]) state.diffByPath[k] = [];
    state.diffByPath[k].push(i);
  });
  state.treeB = state.fileB.tree;
  renderTree();
  renderDetail();
  icons();
}

// ---- Significance visibility (3-way filter) + search + grouping ----------
function sigOf(r) { return r.significance === "uncertain" ? "uncertain" : r.significance === "noise" ? "noise" : "semantic"; }
function matchQuery(text) {
  var q = state.query.trim().toLowerCase();
  if (!q) return true;
  return String(text).toLowerCase().indexOf(q) >= 0;
}
function groupKeyFor(label, type) {
  if (state.groupBy === "service") {
    var svc = String(label).split("|")[0].trim();
    return svc || "(unlabeled)";
  }
  if (state.groupBy === "type") return String(type || "span");
  return "";
}

function paintSegButtons() {
  var counts = { semantic: 0, uncertain: 0, noise: 0 };
  state.results.forEach(function (r) { counts[sigOf(r)]++; });
  document.querySelectorAll(".seg-btn").forEach(function (b) {
    var sig = b.getAttribute("data-sig");
    var on = !!state.showSig[sig];
    b.setAttribute("aria-pressed", String(on));
    var base = "seg-btn font-mono text-[11px] px-3 py-1.5 rounded-md border ";
    var color = sig === "semantic" ? "border-[rgb(var(--ink-semantic))] text-[rgb(var(--ink-semantic))]"
      : sig === "uncertain" ? "border-dashed border-[rgb(var(--ink-uncertain))] text-[rgb(var(--ink-uncertain))]"
      : "border-[rgb(var(--ink-noise))] text-[rgb(var(--ink-noise))]";
    b.className = base + color;
    b.textContent = (sig === "semantic" ? "~ " : sig === "uncertain" ? "? " : "≈ ") + sig + " (" + counts[sig] + ")";
  });
}

// ---- KPI bar (hidden until first compare; spinners while loading) --------
function kpiLoading() {
  el("kpis").classList.remove("hidden");
  el("k-skip").innerHTML = '<span class="skel">…</span>';
  el("k-skip-sub").textContent = "computing…";
  el("k-sem").textContent = "…"; el("k-unc").textContent = "…"; el("k-noise").textContent = "…";
  el("k-nodes").textContent = "…"; el("k-time").textContent = "…";
}
function renderKpis() {
  var s = state.summary;
  var skip = s.skipPercentage != null ? s.skipPercentage : 0;
  el("k-skip").textContent = skip + "%";
  el("k-skip-sub").textContent =
    (s.nodesSkipped != null ? Number(s.nodesSkipped).toLocaleString() : "--") +
    " skipped / " + (s.nodesVisited != null ? Number(s.nodesVisited).toLocaleString() : "--") + " compared";
  var sem = s.semanticDiffs != null ? s.semanticDiffs : state.results.filter(function (r) { return r.significance === "semantic"; }).length;
  var unc = s.uncertainDiffs != null ? s.uncertainDiffs : state.results.filter(function (r) { return r.significance === "uncertain"; }).length;
  var noi = s.noiseDiffs != null ? s.noiseDiffs : state.results.filter(function (r) { return r.significance === "noise"; }).length;
  el("k-sem").textContent = sem;
  el("k-unc").textContent = unc;
  el("k-noise").textContent = noi;
  var aSize = s.traceASize != null ? Number(s.traceASize).toLocaleString() : "--";
  var bSize = s.traceBSize != null ? Number(s.traceBSize).toLocaleString() : "--";
  el("k-nodes").textContent = aSize + " → " + bSize + " nodes";
  el("k-time").textContent = (s.timing && s.timing.totalMs != null ? Number(s.timing.totalMs).toLocaleString() + " ms total" : "--");
  // Identical traces read green, not broken: full skip, zero of everything.
  el("k-skip").className = "font-mono text-4xl font-bold mt-1 " + (sem === 0 ? "text-[rgb(var(--ink-added))]" : "text-[var(--text-primary)]");
}

// ---- Row model ------------------------------------------------------------
// NOTE: ownIdxs holds result INDICES (diffByPath stores indices, not
// objects) — resolve before reading .type/.significance. Reading fields
// off the raw index silently yields undefined and every row degrades to
// "semantic", which is exactly the bug this guard documents.
function rowState(ownIdxs, hasSemBelow, hasNoiseBelow) {
  if (ownIdxs.length) {
    var first = state.results[ownIdxs[0]];
    if (!first) return "semantic";
    if (first.type === "added") return "added";
    if (first.type === "removed") return "removed";
    if (first.significance === "uncertain") return "uncertain";
    if (first.significance === "noise") {
      // Own verdict is noise but semantic diffs live below (e.g. the root
      // carries root-attribute jitter while descendants regressed). Stay an
      // open structural anchor instead of collapsing into — or filtering
      // as — a noise-only region that would bury the semantic rows.
      if (hasSemBelow) return "below-sem";
      return "noise";
    }
    return "semantic";
  }
  if (hasSemBelow) return "below-sem";
  if (hasNoiseBelow) return "below-noise";
  return "unchanged";
}

function annotate(node, trail, ukey, counter) {
  // Same visible "\u0001" separator as pathKey() so diffByPath lookups match.
  var key = trail.join("\u0001");
  var own = state.diffByPath[key] || [];
  // Duplicate labels under one parent (e.g. 10 identical log lines) share
  // a path key. Give each instance its own diff (FIFO, mirroring how the
  // backend matcher pairs duplicates) and its own UI key, so rows don't
  // share collapse/selection state or all show the same diff list.
  var inst = counter[key] || 0;
  counter[key] = inst + 1;
  var hasSem = false, hasNoise = false, kids = [], total = 1;
  node.children.forEach(function (c, ci) {
    var info = annotate(c, trail.concat([c.label]), ukey + "/" + ci, counter);
    kids.push(info); total += info.total;
    if (info.hasSem) hasSem = true;
    if (info.hasNoise) hasNoise = true;
  });
  own.forEach(function (i) {
    var s = sigOf(state.results[i]);
    if (s === "semantic" || s === "uncertain") hasSem = true; else hasNoise = true;
  });
  state.nodeIndex[key] = { node: node, own: own };
  return { node: node, key: key, ukey: ukey, inst: inst, own: own, kids: kids, hasSem: hasSem, hasNoise: hasNoise, total: total };
}

// ---- Expand / collapse all ----------------------------------------------
// Walk the annotated tree and set the expand/collapse state, then re-render.
// ukeys are positional, so flags stay valid across filter/search changes.
// Expand opens every branch. Collapse shuts only true bulk regions
// (unchanged / noise with more than one node); anchors revert to
// default-open so Collapse all restores the default view and can never
// bury semantic rows behind a closed branch. Per-branch carets remain for
// manually shutting anything.
function setAllCollapsed(collapse) {
  if (!state.treeB && !(state.fileB && state.fileB.tree)) return;
  state.treeB = state.treeB || state.fileB.tree;
  var info = annotate(state.treeB, [state.treeB.label], "0", {});
  (function walk(ni) {
    var dispOwn = ni.own.length ? [ni.own[ni.inst % ni.own.length]] : [];
    var st = rowState(dispOwn, ni.hasSem, ni.hasNoise);
    var collapsible = (st === "unchanged" || st === "noise") && ni.total > 1;
    if (collapse) {
      if (collapsible) state.collapsed[ni.ukey] = false;
      else if (ni.kids.length) delete state.collapsed[ni.ukey];
    } else if (ni.kids.length) {
      state.collapsed[ni.ukey] = true;
    }
    ni.kids.forEach(walk);
  })(info);
  renderTree();
}
function expandAll() { setAllCollapsed(false); }
function collapseAll() { setAllCollapsed(true); }

function stateDot(st) {
  if (st === "added") return "bg-[rgb(var(--ink-added))] glow-emerald";
  if (st === "removed") return "border border-[rgb(var(--ink-removed))]";
  if (st === "semantic") return "bg-[rgb(var(--ink-semantic))] glow-rose";
  if (st === "uncertain") return "border border-dashed border-[rgb(var(--ink-uncertain))]";
  if (st === "noise") return "bg-[rgb(var(--ink-noise))] glow-amber";
  if (st === "below-sem") return "bg-[rgb(var(--ink-semantic))]";
  if (st === "below-noise") return "bg-[rgb(var(--ink-noise))]";
  return "bg-[var(--text-muted)]";
}
function stateIcon(st) {
  if (st === "added") return "+";
  if (st === "removed") return "−";
  if (st === "semantic") return "~";
  if (st === "uncertain") return "?";
  if (st === "noise") return "≈";
  return "·";
}
function hl(text) {
  var q = state.query.trim();
  if (!q) return esc(text);
  var lower = String(text).toLowerCase();
  var idx = lower.indexOf(q.toLowerCase());
  if (idx < 0) return esc(text);
  return esc(String(text).slice(0, idx)) + "<mark class=\"hl\">" + esc(String(text).slice(idx, idx + q.length)) + "</mark>" + esc(String(text).slice(idx + q.length));
}

function renderTree() {
  var host = el("tree");
  if (!state.treeB) {
    host.innerHTML = '<div class="p-8 text-center font-mono text-xs text-[var(--text-muted)]">Run a diff to visualize the unified tree.</div>';
    return;
  }
  var info = annotate(state.treeB, [state.treeB.label], "0", {});
  // Inline removed nodes under their parent anchor in B. When the anchor
  // path doesn't exist in B (e.g. differing root labels), fall back to the
  // root — a removed span with no B-side home still deserves a row, with
  // its full A-path breadcrumb intact.
  var removedByParent = {};
  var removedOrphan = [];
  state.results.forEach(function (r, i) {
    if (r.type !== "removed" || !state.showSig[sigOf(r)]) return;
    // Same visible separator to match nodeIndex keys set by annotate().
    var anchor = (r.pathA || []).slice(0, -1).join("\u0001");
    if (anchor && !state.nodeIndex[anchor]) {
      removedOrphan.push(i);
      return;
    }
    (removedByParent[anchor] = removedByParent[anchor] || []).push(i);
  });
  var html = "";
  var visible = 0, hiddenByFilter = 0;

  function subtreeMatches(ni, isRoot) {
    if (!state.query.trim()) return true;
    if (matchQuery(ni.node.label)) return true;
    for (var i = 0; i < ni.own.length; i++) {
      if (matchQuery(state.results[ni.own[i]].description || "")) return true;
    }
    if (isRoot) {
      // Orphaned removals live outside the B tree — match them explicitly
      // or a query for a removed-only label would hide the whole tree.
      for (var q = 0; q < removedOrphan.length; q++) {
        var rr = state.results[removedOrphan[q]];
        var rl = (rr.nodeA && rr.nodeA.label) || "";
        if (matchQuery(rl) || matchQuery(rr.description || "")) return true;
      }
    }
    for (var k = 0; k < ni.kids.length; k++) {
      if (subtreeMatches(ni.kids[k], false)) return true;
    }
    return false;
  }

  function emit(ni, depth) {
    // This instance's own diff (see annotate): all duplicates share the
    // path list, but each row shows exactly one diff.
    var dispOwn = ni.own.length ? [ni.own[ni.inst % ni.own.length]] : [];
    var st = rowState(dispOwn, ni.hasSem, ni.hasNoise);
    // Significance filter: hide the class entirely (except structural anchors).
    if ((st === "noise" || st === "below-noise") && !state.showSig.noise) { hiddenByFilter++; return; }
    if ((st === "uncertain") && !state.showSig.uncertain) { hiddenByFilter++; return; }
    if (st !== "unchanged" && st !== "below-sem" && st !== "below-noise") {
      var vis = sigOf(state.results[dispOwn[0]]);
      if (!state.showSig[vis]) { hiddenByFilter++; return; }
    }
    if (!subtreeMatches(ni, depth === 0)) { hiddenByFilter++; return; }
    visible++;

    var removed = removedByParent[ni.key] || [];
    if (depth === 0) removed = removed.concat(removedOrphan);
    var hasKids = ni.kids.length > 0 || removed.length > 0;

    var isCollapsedRegion = (st === "unchanged" || st === "noise") && ni.total > 1;
    var userOpen = state.collapsed[ni.ukey];
    // Defaults per spec: unchanged + noise bulk regions collapse; everything else expands.
    var defaultOpen = !isCollapsedRegion;
    var open = userOpen === undefined ? defaultOpen : !!userOpen;

    if (isCollapsedRegion && !open) {
      var label = st === "noise"
        ? "≈ " + (ni.total - 1) + " noise-only spans — judged safe, click to expand"
        : "⌄ " + (ni.total - 1) + " unchanged spans — Merkle-skipped, click to expand";
      html += '<div class="tnode-row collapsed-row flex items-center gap-2 rounded cursor-pointer px-3 py-1.5 my-0.5 font-mono text-[11px] text-[var(--text-secondary)]" data-key="' + esc(ni.ukey) + '" data-act="toggle" style="margin-left:' + (6 + depth * 14) + 'px">'
        + esc(label) + "</div>";
      return;
    }

    var caretHtml = "";
    if (hasKids) {
      caretHtml = '<button type="button" class="caret-btn w-4 h-4 cursor-pointer select-none text-[11px] shrink-0" data-key="' + esc(ni.ukey) + '" data-act="toggle-caret" title="' + (open ? 'Collapse branch' : 'Expand branch') + '" aria-label="' + (open ? 'Collapse branch' : 'Expand branch') + ' ' + esc(ni.node.label) + '">'
        + (open ? '▾' : '▸')
        + '</button>';
    } else {
      caretHtml = '<span class="w-4 h-4 shrink-0 inline-block"></span>';
    }

    var ownIdx = dispOwn.length ? dispOwn[0] : -1;
    var sel = dispOwn.indexOf(state.selected) >= 0 ? " selected" : "";
    var dot = stateDot(st);
    var pill = "";
    if (st === "added") pill = '<span class="state-added font-mono text-[9px] font-bold px-1.5 py-px">ADDED</span>';
    else if (st === "removed") pill = '<span class="state-removed font-mono text-[9px] font-bold px-1.5 py-px">REMOVED</span>';
    else if (st === "semantic") pill = '<span class="state-semantic font-mono text-[9px] font-bold px-1.5 py-px">SEMANTIC</span>';
    else if (st === "uncertain") pill = '<span class="state-uncertain font-mono text-[9px] font-bold px-1.5 py-px">UNCERTAIN</span>';
    else if (st === "noise") pill = '<span class="state-noise font-mono text-[9px] px-1.5 py-px">NOISE</span>';
    var sizeBadge = ni.total > 1 && dispOwn.length
      ? '<span class="font-mono text-[9px] px-1.5 py-px rounded-full border border-edge text-[var(--text-secondary)]">covers ' + ni.total + " nodes</span>"
      : "";
    var dur = ni.node.attributes && ni.node.attributes.duration_ms != null ? esc(ni.node.attributes.duration_ms) + "ms" : "";
    var extra = st === "uncertain" ? " uncertain-outline" : "";
    html += '<div class="tnode-row flex items-center gap-1.5 pr-2 rounded cursor-pointer' + sel + extra + '" data-key="' + esc(ni.ukey) + '" data-diff="' + ownIdx + '" style="padding-left:' + (6 + depth * 14) + 'px">'
      + caretHtml
      + '<span class="w-2 h-2 rounded-full shrink-0 ' + dot + '"></span>'
      + '<span class="font-mono text-[11px] font-bold text-[var(--text-muted)] w-3 shrink-0">' + stateIcon(st) + "</span>"
      + '<span class="truncate text-[var(--text-primary)] font-mono text-xs">' + hl(ni.node.label) + "</span>" + pill + sizeBadge
      + '<span class="ml-auto text-[10px] text-[var(--text-muted)] shrink-0 pl-2 font-mono">' + esc(ni.node.type) + (dur ? " | " + dur : "") + "</span></div>";

    // Only render child nodes and anchored removals when this node is expanded
    if (open) {
      for (var ri = 0; ri < removed.length; ri++) {
        var r = state.results[removed[ri]];
        var rLabel = (r.nodeA && r.nodeA.label) || (r.pathA && r.pathA[r.pathA.length - 1]) || "(removed)";
        if (!matchQuery(rLabel) && !matchQuery(r.description || "")) { hiddenByFilter++; continue; }
        visible++;
        var rSel = removed[ri] === state.selected ? " selected" : "";
        html += '<div class="tnode-row flex items-center gap-1.5 pr-2 rounded cursor-pointer' + rSel + '" data-diff="' + removed[ri] + '" style="padding-left:' + (6 + (depth + 1) * 14) + 'px">'
          + '<span class="w-4 h-4 shrink-0 inline-block"></span>'
          + '<span class="w-2 h-2 rounded-full shrink-0 ' + stateDot("removed") + '"></span>'
          + '<span class="font-mono text-[11px] font-bold text-[var(--text-muted)] w-3 shrink-0">−</span>'
          + '<span class="truncate text-[var(--text-muted)] line-through font-mono text-xs">' + hl(rLabel) + "</span>"
          + '<span class="state-removed font-mono text-[9px] font-bold px-1.5 py-px">REMOVED</span>'
          + "</div>";
      }

      // Grouped rendering for wide flat fan-outs (log windows): sticky headers.
      var lastGroup = null;
      for (var ci = 0; ci < ni.kids.length; ci++) {
        var gk = groupKeyFor(ni.kids[ci].node.label, ni.kids[ci].node.type);
        if (gk && gk !== lastGroup) {
          lastGroup = gk;
          html += '<div class="font-mono text-[10px] uppercase tracking-widest text-[var(--text-muted)] px-3 pt-2" style="margin-left:' + (6 + (depth + 1) * 14) + 'px">' + esc(gk) + "</div>";
        }
        emit(ni.kids[ci], depth + 1);
      }
    }
  }

  emit(info, 0);
  el("tree-count").textContent = visible.toLocaleString() + " rows" + (hiddenByFilter ? " · " + hiddenByFilter + " filtered" : "");
  host.innerHTML = html || '<div class="p-8 text-center font-mono text-xs text-[var(--text-muted)]">No rows match the current filter.</div>';
  host.querySelectorAll(".tnode-row").forEach(function (row) {
    row.addEventListener("click", function (e) {
      var caret = e.target.closest('[data-act="toggle-caret"]');
      if (caret) {
        e.stopPropagation();
        var k = caret.getAttribute("data-key");
        var isCurrentlyOpen = caret.getAttribute("title") === "Collapse branch";
        state.collapsed[k] = !isCurrentlyOpen;
        renderTree();
        return;
      }

      var di = Number(row.getAttribute("data-diff"));
      var act = row.getAttribute("data-act");
      if (act === "toggle") {
        var k = row.getAttribute("data-key");
        state.collapsed[k] = !(state.collapsed[k] === undefined ? false : state.collapsed[k]);
        renderTree();
        return;
      }
      if (di >= 0) {
        state.selected = di;
        renderTree();
        renderDetail();
      } else {
        var caretInRow = row.querySelector('[data-act="toggle-caret"]');
        if (caretInRow) {
          var k = caretInRow.getAttribute("data-key");
          var isCurrentlyOpen = caretInRow.getAttribute("title") === "Collapse branch";
          state.collapsed[k] = !isCurrentlyOpen;
          renderTree();
        }
      }
    });
  });
  icons();
}
