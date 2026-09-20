"use strict";
/* frontend-v2/js/demo.js — 1-click benchmark demo trace builder.
   Trace A = clean checkout (auth -> cart -> payment -> fulfillment).
   Trace B = same behavior + rotated UUIDs / shifted timestamps / duration
   jitter (noise) + 5 injected semantic regressions. Diffing itself is
   always done by the live AWS backend; this only builds the INPUT files. */

// Deterministic RNG so the demo is identical on every load.
function mulberry32(seed) {
  var a = seed >>> 0;
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    var t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
function demoUuid(rng) {
  function h(n) { var s = ""; for (var i = 0; i < n; i++) s += "0123456789abcdef"[Math.floor(rng() * 16)]; return s; }
  return h(8) + "-" + h(4) + "-4" + h(3) + "-8" + h(3) + "-" + h(12);
}
var demoCounter = 0;
function mkSpan(rng, label, type, extraAttrs, children) {
  var ts = 1758000000000 + Math.floor(rng() * 4000);
  var attrs = {
    timestamp: new Date(ts).toISOString(),
    request_id: demoUuid(rng),
    duration_ms: Math.round((2 + rng() * 120) * 100) / 100
  };
  if (extraAttrs) for (var k in extraAttrs) attrs[k] = extraAttrs[k];
  return { id: "span-" + (++demoCounter), type: type || "span", label: label, attributes: attrs, children: children || [] };
}
function leafFan(rng, prefix, n, type) {
  var out = [];
  for (var i = 0; i < n; i++) out.push(mkSpan(rng, prefix + "-" + i, type || "log"));
  return out;
}
function buildDemoTraceA() {
  demoCounter = 0;
  var rng = mulberry32(20260919);
  var auth = mkSpan(rng, "auth", "span", { service: "auth-svc" }, [
    mkSpan(rng, "login", "call", { "http.status_code": 200 }, leafFan(rng, "login-audit", 50, "log")),
    mkSpan(rng, "token_validate", "call", { "http.status_code": 200 }, leafFan(rng, "token-check", 30, "log")),
    mkSpan(rng, "session_create", "call", { "http.status_code": 200 }, leafFan(rng, "session-evt", 30, "log"))
  ]);
  var cartItems = [];
  for (var i = 0; i < 130; i++) {
    cartItems.push(mkSpan(rng, "cart_item_" + i, "span", { sku: "SKU-" + (1000 + i), qty: 1 + (i % 3) }, [
      mkSpan(rng, "price_lookup", "call", { price_cents: 499 + i }),
      mkSpan(rng, "inventory_check", "call", { rows_available: 42 }),
      mkSpan(rng, "cart_line_audit", "log", {})
    ]));
  }
  var cart = mkSpan(rng, "cart", "span", { service: "cart-svc" }, cartItems.concat([
    mkSpan(rng, "price_calc", "call", { total_cents: 5199 }, leafFan(rng, "price-evt", 20, "log")),
    mkSpan(rng, "promo_apply", "call", { promo: "FESTIVE10" }, leafFan(rng, "promo-evt", 15, "log"))
  ]));
  var payment = mkSpan(rng, "payment_process", "span", { service: "pay-svc" }, [
    mkSpan(rng, "fraud_check", "call", { risk_score: 0.02 }, leafFan(rng, "fraud-sig", 40, "log")),
    mkSpan(rng, "stripe_charge_create", "call", { "http.status_code": 200, charge_id: "ch_demo123" }, leafFan(rng, "charge-evt", 40, "log")),
    mkSpan(rng, "ledger_write", "call", { rows_written: 2 }, leafFan(rng, "ledger-evt", 40, "log")),
    mkSpan(rng, "audit_record_written", "log", { level: "INFO", message: "Payment captured successfully" })
  ]);
  var packages = [];
  for (var p = 0; p < 50; p++) {
    packages.push(mkSpan(rng, "package_" + p, "span", { warehouse: "BLR-0" + (p % 4) }, [
      mkSpan(rng, "inventory_reserve", "call", { rows_available: 42 }),
      mkSpan(rng, "warehouse_pick", "call", { "http.status_code": 200 }),
      mkSpan(rng, "ship_label", "call", { carrier: "delhivery" })
    ]));
  }
  var fulfillment = mkSpan(rng, "fulfillment", "span", { service: "fulfill-svc" }, packages.concat([
    mkSpan(rng, "order_state_transition", "state_change", { from_state: "PAID", to_state: "CONFIRMED" })
  ]));
  return mkSpan(rng, "POST /api/v1/checkout", "span",
    { "http.status_code": 200, service: "api-gateway" }, [auth, cart, payment, fulfillment]);
}
function rotateUuidLike(v, rng) {
  if (typeof v !== "string") return v;
  if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(v)) return demoUuid(rng);
  if (/^(ch_|req_|tok_)/.test(v)) return v.replace(/[A-Za-z0-9]+$/, function () { return Math.floor(rng() * 1e9).toString(36); });
  return v;
}
function addNoise(node, rng) {
  for (var k in node.attributes) {
    var v = node.attributes[k];
    if (k === "timestamp" || k === "start_time" || k === "end_time") {
      node.attributes[k] = new Date(Date.parse(v) + Math.floor(rng() * 800)).toISOString();
    } else if (k === "request_id" || k === "span_id" || /uuid|guid/i.test(k)) {
      node.attributes[k] = rotateUuidLike(v, rng);
    } else if (k === "duration_ms" && typeof v === "number") {
      node.attributes[k] = Math.round(v * (1 + (rng() - 0.5) * 0.06) * 100) / 100;
    }
  }
  node.id = "span-b-" + node.id;
  node.children.forEach(function (c) { addNoise(c, rng); });
}
function findNode(root, label) {
  if (root.label === label) return root;
  for (var i = 0; i < root.children.length; i++) {
    var f = findNode(root.children[i], label);
    if (f) return f;
  }
  return null;
}
function findParent(root, label, parent) {
  if (root.label === label) return parent;
  for (var i = 0; i < root.children.length; i++) {
    var f = findParent(root.children[i], label, root);
    if (f) return f;
  }
  return null;
}
function buildDemoPair() {
  var rng = mulberry32(777);
  var a = buildDemoTraceA();
  var b = JSON.parse(JSON.stringify(a));
  addNoise(b, rng);
  // 5 injected semantic regressions:
  var charge = findNode(b, "stripe_charge_create");
  charge.attributes["http.status_code"] = 500;
  charge.attributes.error_code = "card_declined";
  var ledgerParent = findParent(b, "ledger_write", null);
  ledgerParent.children = ledgerParent.children.filter(function (c) { return c.label !== "ledger_write"; });
  var reserve = findNode(b, "inventory_reserve");
  reserve.attributes.rows_available = 0;
  var pay = findNode(b, "payment_process");
  var retry = mkSpan(rng, "sms_fraud_retry", "call", { "http.status_code": 202, attempt: 2 });
  delete retry.attributes.timestamp; delete retry.attributes.request_id;
  pay.children.push(retry);
  var st = findNode(b, "order_state_transition");
  st.attributes.to_state = "FAILED";
  return { a: a, b: b };
}
