"use strict";
/* frontend-v2/js/app.js — file ingest, pipeline, runDiff orchestration, UI wiring.
   Loaded last. Attaches all event listeners and performs initial paint. */

// ---- Live execution pipeline: 4 stages driven by real backend progress ----
var STAGES = [
  { key: "upload", label: "1. S3 Presigned Upload", icon: "cloud-upload" },
  { key: "orch", label: "2. Step Functions Orchestration", icon: "workflow" },
  { key: "map", label: "3. Parallel Lambda Map-Workers", icon: "cpu" },
  { key: "prune", label: "4. Merkle Prune + Equivalence Filter", icon: "git-compare-arrows" }
];
var stageState = {};
function renderPipeline() {
  var html = "";
  STAGES.forEach(function (s) {
    var st = stageState[s.key] || "idle";
    var border = st === "done" ? "border-emerald-800" : st === "active" ? "stage-active" : "border-edge";
    var badge = st === "done"
      ? '<span class="w-4 h-4 rounded-full bg-emerald-500 glow-emerald inline-block"></span>'
      : st === "active"
        ? '<span class="w-4 h-4 rounded-full border-2 border-amber-500 border-t-transparent spinner inline-block"></span>'
        : '<span class="w-4 h-4 rounded-full border border-zinc-700 inline-block"></span>';
    html += '<div class="border rounded-lg px-3 py-2.5 bg-surface2 flex items-center gap-2.5 ' + border + '">'
      + badge
      + '<div><div class="font-mono text-[11px] font-semibold ' + (st === "idle" ? "text-zinc-600" : "text-zinc-200") + '">' + s.label + "</div>"
      + '<div class="font-mono text-[10px] text-zinc-600">' + (st === "done" ? "complete" : st === "active" ? "running..." : "pending") + "</div></div></div>";
  });
  el("pipe-stages").innerHTML = html;
  icons();
}
function showPipeline(jobId) {
  el("pipeline").classList.remove("hidden");
  el("pipe-job").textContent = jobId ? "job " + jobId : "";
  renderPipeline();
  el("pipeline").scrollIntoView({ behavior: "smooth", block: "nearest" });
}

// ---- Local trace normalization (display + node counts; diffing is backend-only)
function toNode(raw, fid) {
  var id = String((raw && raw.id) || fid);
  var label = String((raw && (raw.label || raw.name || raw.id)) || fid);
  var type = String((raw && raw.type) || "span");
  var attrs = (raw && typeof raw.attributes === "object" && raw.attributes) || {};
  var kids = (raw && (raw.children || raw.spans)) || [];
  var children = Array.isArray(kids) ? kids.map(function (c, i) { return toNode(c, fid + "." + i); }) : [];
  return { id: id, label: label, type: type, attributes: attrs, children: children };
}
function otelToTree(raw) {
  var spans = [];
  (raw.resourceSpans || []).forEach(function (rs) {
    (rs.scopeSpans || []).forEach(function (ss) { (ss.spans || []).forEach(function (s) { spans.push(s); }); });
  });
  var byId = {}, roots = [];
  spans.forEach(function (s, i) {
    var n = { id: String(s.spanId || s.id || ("s" + i)), label: String(s.name || s.spanId || ("span-" + i)), type: "span", attributes: s.attributes || {}, children: [] };
    byId[n.id] = n;
  });
  spans.forEach(function (s, i) {
    var n = byId[String(s.spanId || s.id || ("s" + i))];
    var pid = s.parentSpanId ? String(s.parentSpanId) : "";
    if (pid && byId[pid]) byId[pid].children.push(n); else roots.push(n);
  });
  return { id: "trace", label: "trace", type: "trace", attributes: {}, children: roots };
}
function toDisplayTree(raw) {
  if (Array.isArray(raw)) {
    var linked = raw.some(function (s) { return s && typeof s === "object" && ("parentId" in s || "parentSpanId" in s); });
    if (linked) {
      var byId = {}, roots = [];
      raw.forEach(function (s, i) { var n = toNode(s, "n" + i); n.children = []; byId[n.id] = n; if (s.spanId) byId[s.spanId] = n; });
      raw.forEach(function (s, i) {
        var pid = s.parentId || s.parentSpanId;
        var n = byId[s.id] || byId[s.spanId];
        if (pid && byId[pid] && byId[pid] !== n) byId[pid].children.push(n); else roots.push(n);
      });
      if (roots.length === 1) return roots[0];
      return { id: "trace", label: "trace", type: "trace", attributes: {}, children: roots };
    }
    return { id: "trace", label: "trace", type: "trace", attributes: {}, children: raw.map(function (c, i) { return toNode(c, "n" + i); }) };
  }
  if (raw && typeof raw === "object") {
    if ("resourceSpans" in raw) return otelToTree(raw);
    if ("children" in raw || "label" in raw || "id" in raw) return toNode(raw, "0");
  }
  throw new Error("Unknown trace format: expected nested {children}, flat span array, or OTel {resourceSpans}");
}
function countNodes(n) { var c = 1; for (var i = 0; i < n.children.length; i++) c += countNodes(n.children[i]); return c; }

function updateRunBtn() {
  el("run-btn").disabled = !(state.fileA && state.fileA.valid && state.fileB && state.fileB.valid);
}
function ingestRecord(slot, rec) {
  try {
    rec.json = JSON.parse(rec.text);
    rec.tree = toDisplayTree(rec.json);
    rec.nodeCount = countNodes(rec.tree);
    rec.valid = true;
    el(slot === "A" ? "meta-a" : "meta-b").textContent =
      rec.nodeCount.toLocaleString() + " spans | " + fmtBytes(rec.size) + " | " + rec.name;
    el(slot === "A" ? "dz-a" : "dz-b").style.borderColor = "#059669";
  } catch (e) {
    rec.valid = false;
    el(slot === "A" ? "meta-a" : "meta-b").textContent = "INVALID: " + (e instanceof Error ? e.message : String(e));
    el(slot === "A" ? "dz-a" : "dz-b").style.borderColor = "#e11d48";
  }
  if (slot === "A") state.fileA = rec; else state.fileB = rec;
  updateRunBtn();
}
function handleFile(slot, file) {
  var reader = new FileReader();
  reader.onload = function () {
    ingestRecord(slot, { name: file.name, size: file.size, text: String(reader.result || ""), valid: false });
  };
  reader.readAsText(file);
}
function wireDropzone(slot) {
  var dz = el(slot === "A" ? "dz-a" : "dz-b");
  var input = el(slot === "A" ? "file-a" : "file-b");
  dz.addEventListener("click", function () { input.click(); });
  dz.addEventListener("keydown", function (e) { if (e.key === "Enter" || e.key === " ") input.click(); });
  input.addEventListener("change", function () { if (input.files && input.files[0]) handleFile(slot, input.files[0]); input.value = ""; });
  ["dragover", "dragenter"].forEach(function (ev) { dz.addEventListener(ev, function (e) { e.preventDefault(); dz.classList.add("drag"); }); });
  ["dragleave", "drop"].forEach(function (ev) { dz.addEventListener(ev, function (e) { e.preventDefault(); dz.classList.remove("drag"); }); });
  dz.addEventListener("drop", function (e) {
    if (e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files[0]) handleFile(slot, e.dataTransfer.files[0]);
  });
}

// ---- runDiff orchestration -------------------------------------------------
function runDiff() {
  if (!(state.fileA && state.fileA.valid && state.fileB && state.fileB.valid)) {
    toast("Both Trace A and Trace B must be valid JSON traces before running.");
    return;
  }
  el("run-btn").disabled = true;
  el("demo-btn").disabled = true;
  setStatus("working", "working | Step Functions Map-State Engine");
  kpiLoading();
  el("tree-toolbar").classList.add("hidden");
  el("tree-section").classList.add("hidden");
  renderDetail();
  stageState = { upload: "active" };
  showPipeline(null);
  var jobId = null;
  presign(state.fileA.name)
    .then(function (pA) { return putToS3(pA.uploadUrl, state.fileA.text).then(function () { return pA.key; }); })
    .then(function (keyA) {
      return presign(state.fileB.name).then(function (pB) {
        return putToS3(pB.uploadUrl, state.fileB.text).then(function () { return { keyA: keyA, keyB: pB.key }; });
      });
    })
    .then(function (keys) {
      stageState = { upload: "done", orch: "active" };
      renderPipeline();
      return submitJob(keys.keyA, keys.keyB);
    })
    .then(function (sub) {
      jobId = sub.jobId; state.jobId = jobId;
      el("job-id").textContent = "job " + jobId;
      el("pipe-job").textContent = "job " + jobId;
      stageState = { upload: "done", orch: "done", map: "active" };
      renderPipeline();
      var attempts = 0;
      function poll() {
        return getJob(jobId).then(function (job) {
          if (job.status === "PENDING") { stageState = { upload: "done", orch: "active", map: "idle", prune: "idle" }; }
          else if (job.status === "RUNNING") { stageState = { upload: "done", orch: "done", map: "active", prune: "idle" }; }
          else if (job.status === "COMPLETED") {
            stageState = { upload: "done", orch: "done", map: "done", prune: "active" };
            renderPipeline();
            return job;
          }
          else { throw new Error("Job terminal state:\n" + JSON.stringify(job, null, 2)); }
          renderPipeline();
          attempts++;
          if (attempts > 250) throw new Error("Polling timed out after 250 x 1.2s waiting for job " + jobId);
          return sleep(1200).then(poll);
        });
      }
      return poll();
    })
    .then(function (job) {
      state.summary = job.summary || null;
      if (!state.summary) throw new Error("Job " + jobId + " COMPLETED but returned no summary.");
      return getResults(jobId);
    })
    .then(function (results) {
      state.results = results || [];
      state.selected = -1;
      state.collapsed = {};
      stageState = { upload: "done", orch: "done", map: "done", prune: "done" };
      renderPipeline();
      renderAll();
      setStatus("done", "completed | Step Functions Map-State Engine");
      document.getElementById("kpis").scrollIntoView({ behavior: "smooth", block: "nearest" });
    })
    .catch(function (e) {
      toast(e instanceof Error ? e.message : String(e));
    })
    .then(function () {
      el("run-btn").disabled = false;
      el("demo-btn").disabled = false;
      updateRunBtn();
    });
}

// ---- UI wiring (single init site — all listeners live here) ---------------
function paintRuleButtons() {
  document.querySelectorAll(".rule-btn").forEach(function (b) {
    var on = b.getAttribute("aria-pressed") === "true";
    b.className = "rule-btn font-mono text-[11px] px-2.5 py-1 rounded-md border transition-colors " +
      (on ? "border-zinc-500 bg-surface2 text-zinc-100" : "border-edge bg-surface text-zinc-600 line-through");
  });
}

function initApp() {
  paintApiMeta();
  wireDropzone("A"); wireDropzone("B");

  el("upload-toggle").addEventListener("click", function () {
    var panel = el("upload-panel");
    var show = panel.classList.contains("hidden");
    panel.classList.toggle("hidden");
    el("upload-toggle").setAttribute("aria-pressed", String(show));
    icons();
  });

  el("reset-btn").addEventListener("click", function () {
    state.fileA = state.fileB = null; state.jobId = null;
    state.summary = null; state.results = []; state.selected = -1;
    state.treeB = null; state.diffByPath = {}; state.nodeIndex = {};
    state.collapsed = {}; state.query = ""; state.groupBy = "none";
    state.showSig = { semantic: true, uncertain: true, noise: true };
    el("tree-search").value = ""; el("group-select").value = "none";
    paintSegButtons();
    el("dz-a").style.borderColor = ""; el("dz-b").style.borderColor = "";
    el("meta-a").textContent = "no file loaded"; el("meta-b").textContent = "no file loaded";
    el("demo-meta").classList.add("hidden");
    el("job-id").textContent = ""; el("pipeline").classList.add("hidden");
    el("kpis").classList.add("hidden");
    el("tree-toolbar").classList.add("hidden");
    el("tree-section").classList.add("hidden");
    renderDetail();
    setStatus("", "idle | Step Functions Map-State Engine");
    updateRunBtn();
  });

  document.querySelectorAll(".rule-btn").forEach(function (btn) {
    btn.addEventListener("click", function () {
      var r = btn.getAttribute("data-rule");
      var on = btn.getAttribute("aria-pressed") !== "true";
      btn.setAttribute("aria-pressed", String(on));
      state.rules[r] = on;
      paintRuleButtons();
    });
  });
  paintRuleButtons();

  el("demo-btn").addEventListener("click", function () {
    var pair = buildDemoPair();
    var textA = JSON.stringify(pair.a);
    var textB = JSON.stringify(pair.b);
    ingestRecord("A", { name: "demo-trace-a.json", size: textA.length, text: textA, valid: false });
    ingestRecord("B", { name: "demo-trace-b.json", size: textB.length, text: textB, valid: false });
    var m = el("demo-meta");
    m.classList.remove("hidden");
    m.textContent = "demo loaded: Trace A " + state.fileA.nodeCount.toLocaleString() + " spans | Trace B " +
      state.fileB.nodeCount.toLocaleString() + " spans | 5 injected regressions + timestamp/UUID noise | uploading to live backend...";
    icons();
    runDiff();
  });

  el("run-btn").addEventListener("click", runDiff);

  // Tree toolbar: significance toggles + search + grouping.
  document.querySelectorAll(".seg-btn").forEach(function (btn) {
    btn.addEventListener("click", function () {
      var sig = btn.getAttribute("data-sig");
      state.showSig[sig] = !state.showSig[sig];
      paintSegButtons();
      renderTree();
    });
  });
  el("tree-search").addEventListener("input", function () {
    state.query = el("tree-search").value;
    renderTree();
  });
  el("group-select").addEventListener("change", function () {
    state.groupBy = el("group-select").value;
    renderTree();
  });
  el("expand-all-btn").addEventListener("click", expandAll);
  el("collapse-all-btn").addEventListener("click", collapseAll);

  paintSegButtons();
  renderDetail();
  icons();
  setStatus("", "idle | Step Functions Map-State Engine");
}

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", initApp);
} else {
  initApp();
}
