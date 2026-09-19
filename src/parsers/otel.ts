import type { TraceNode } from "../core/type.js";
import { finalize, isPlainObject } from "./internal.js";

interface OtelAttribute {
  key: string;
  value?: Record<string, unknown>;
}

interface OtelSpan {
  spanId: string;
  parentSpanId?: string;
  name?: string;
  attributes?: OtelAttribute[];
  [key: string]: unknown;
}

interface OtelInput {
  resourceSpans?: Array<{
    scopeSpans?: Array<{ spans?: OtelSpan[] }>;
  }>;
}

export function parseOtel(raw: unknown): TraceNode {
  if (!isPlainObject(raw)) {
    throw new Error("otel: input must be an object");
  }
  const input = raw as OtelInput;
  if (!Array.isArray(input.resourceSpans)) {
    throw new Error("otel: missing resourceSpans array");
  }

  // ── Flatten all spans across all resources / scopes ────────────────────
  const spans: OtelSpan[] = [];
  for (const rs of input.resourceSpans) {
    for (const ss of rs.scopeSpans ?? []) {
      for (const span of ss.spans ?? []) {
        spans.push(span);
      }
    }
  }

  // ── Materialize ────────────────────────────────────────────────────────
  const byId = new Map<string, TraceNode>();
  for (const span of spans) {
    if (!span.spanId) throw new Error("otel: span missing spanId");
    const id = String(span.spanId);
    if (byId.has(id)) throw new Error(`otel: duplicate spanId "${id}"`);

    byId.set(id, {
      id,
      type: "span",
      label: String(span.name ?? id),
      attributes: unwrapAttributes(span.attributes),
      children: [],
      depth: 0,
      subtreeSize: 1,
      raw: span,
    });
  }

  // ── Link by parentSpanId ───────────────────────────────────────────────
  const roots: TraceNode[] = [];
  for (const span of spans) {
    const id = String(span.spanId);
    const node = byId.get(id);
    if (!node) continue;
    const pid = span.parentSpanId;

    if (pid == null || pid === "") {
      roots.push(node);
      continue;
    }
    const parent = byId.get(String(pid));
    if (!parent) {
      throw new Error(`otel: parent span "${pid}" of "${id}" not found`);
    }
    parent.children.push(node);
  }

  // ── Synthetic root ─────────────────────────────────────────────────────
  const syntheticRoot: TraceNode = {
    id: "__trace__",
    type: "trace",
    label: "trace",
    attributes: {},
    children: roots,
    depth: 0,
    subtreeSize: 1,
    raw: undefined,
  };

  return finalize(syntheticRoot);
}

// ── OTel attribute unwrapping ─────────────────────────────────────────────

function unwrapAttributes(attrs: OtelAttribute[] | undefined): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  if (!Array.isArray(attrs)) return out;
  for (const { key, value } of attrs) {
    if (!key) continue;
    out[key] = unwrapValue(value);
  }
  return out;
}

function unwrapValue(v: Record<string, unknown> | undefined): unknown {
  if (!v || typeof v !== "object") return v;

  if ("stringValue" in v) return v.stringValue;
  if ("intValue" in v) return Number(v.intValue);
  if ("doubleValue" in v) return Number(v.doubleValue);
  if ("boolValue" in v) return Boolean(v.boolValue);
  if ("bytesValue" in v) return v.bytesValue;

  if ("arrayValue" in v) {
    const arr = v.arrayValue as { values?: Array<Record<string, unknown>> };
    return (arr.values ?? []).map(unwrapValue);
  }
  if ("kvlistValue" in v) {
    const kv = v.kvlistValue as {
      values?: Array<{ key: string; value?: Record<string, unknown> }>;
    };
    const out: Record<string, unknown> = {};
    for (const entry of kv.values ?? []) {
      if (entry.key) out[entry.key] = unwrapValue(entry.value);
    }
    return out;
  }
  return v;
}
