import type { TraceNode } from "../core/type.js";
import { finalize, isPlainObject } from "./internal.js";

interface FlatSpan {
  id: string;
  parentId?: string | null;
  type?: string;
  label?: string;
  attributes?: Record<string, unknown>;
  [key: string]: unknown;
}

export function parseFlatSpans(raw: unknown): TraceNode {
  if (!Array.isArray(raw)) {
    throw new Error("json-flat: input must be an array of spans");
  }
  const spans = raw as FlatSpan[];

  // ── Pass 1: materialize every span as a bare node ──────────────────────
  const byId = new Map<string, TraceNode>();
  const parentOf = new Map<string, string | null>();

  for (const span of spans) {
    if (!span || typeof span !== "object") {
      throw new Error("json-flat: every entry must be an object");
    }
    if (!span.id) {
      throw new Error("json-flat: every span must have an id");
    }
    const id = String(span.id);
    if (byId.has(id)) {
      throw new Error(`json-flat: duplicate id "${id}"`);
    }

    byId.set(id, {
      id,
      type: String(span.type ?? "span"),
      label: String(span.label ?? id),
      attributes: isPlainObject(span.attributes) ? span.attributes : {},
      children: [],
      depth: 0,
      subtreeSize: 1,
      raw: span,
    });

    // null, undefined, and "" all mean "this is a root"
    const pid = span.parentId;
    parentOf.set(id, pid == null || pid === "" ? null : String(pid));
  }

  // ── Pass 2: wire children to parents ──────────────────────────────────
  const roots: TraceNode[] = [];
  for (const [id, node] of byId) {
    const pid = parentOf.get(id) ?? null;
    if (pid === null) {
      roots.push(node);
      continue;
    }
    const parent = byId.get(pid);
    if (!parent) {
      throw new Error(`json-flat: parent "${pid}" of "${id}" not found`);
    }
    parent.children.push(node);
  }

  if (roots.length === 0) {
    throw new Error("json-flat: no root found (every span has a parent — cyclic?)");
  }
  if (roots.length > 1) {
    throw new Error(`json-flat: multiple roots found (${roots.length}) — expected exactly one`);
  }

  return finalize(roots[0]);
}
