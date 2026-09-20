"use strict";
/* frontend-v2/js/config.js — backend endpoint, shared state, tiny DOM helpers.
   Loaded first. Classic scripts share globals, mirrored on window.TraceDiff
   so split files stay debuggable from the console. */

var DEFAULT_API = "https://adw2m5fxnj.execute-api.us-east-1.amazonaws.com/dev";
var API_PARAM = null;
try { API_PARAM = new URLSearchParams(window.location.search).get("api"); } catch (e) {}
var BASE_URL = API_PARAM || DEFAULT_API;

var state = {
  fileA: null, fileB: null,
  rules: { "ignore-timestamps": true, "canonicalize-ids": true, "numeric-tolerance": true, "sort-concurrent": true },
  jobId: null, summary: null, results: [],
  query: "", groupBy: "none",
  showSig: { semantic: true, uncertain: true, noise: true },
  collapsed: {}, selected: -1,
  treeB: null, diffByPath: {}, nodeIndex: {}
};

function el(id) { return document.getElementById(id); }
function esc(s) { return String(s == null ? "" : s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;"); }
function fmtBytes(n) {
  if (n < 1024) return n + " B";
  if (n < 1048576) return (n / 1024).toFixed(1) + " KB";
  return (n / 1048576).toFixed(2) + " MB";
}
function sleep(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }
function icons() { try { if (window.lucide) window.lucide.createIcons(); } catch (e) {} }

function setStatus(mode, text) {
  var dot = el("status-dot");
  dot.className = "w-2 h-2 rounded-full inline-block " + (
    mode === "working" ? "bg-[rgb(var(--status-working))] glow-amber dot-live" :
    mode === "done" ? "bg-[rgb(var(--status-done))] glow-emerald" :
    mode === "error" ? "bg-[rgb(var(--status-error))] glow-rose" : "bg-[var(--text-muted)]");
  el("status-text").textContent = text;
}

var toastTimer = null;
function toast(msg) {
  el("toast-text").textContent = "BACKEND ERROR\n" + msg;
  el("toast-wrap").classList.remove("hidden");
  setStatus("error", "error | see notification");
  if (toastTimer) clearTimeout(toastTimer);
  toastTimer = setTimeout(function () { el("toast-wrap").classList.add("hidden"); }, 12000);
  icons();
}

function paintApiMeta() {
  el("api-url").textContent = BASE_URL;
  el("api-source").textContent = API_PARAM ? "api: custom ?api=" : "api: default";
}

// Shared namespace for console debugging across split files.
window.TraceDiff = window.TraceDiff || {};
window.TraceDiff.state = state;
window.TraceDiff.getBaseUrl = function () { return BASE_URL; };
