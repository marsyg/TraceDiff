import type { TraceNode } from "../core/type.js";
import { finalize, isPlainObject } from "./internal.js";

interface JsonTreeInput {
  id?: string;
  type?: string;
  label?: string;
  attributes?: Record<string, unknown>;
  children?: JsonTreeInput[];
  [key: string]: unknown;
}

export function parseJsonTree(raw: unknown): TraceNode {
  if (!isPlainObject(raw)) {
    throw new Error("json-tree: input must be an object");
  }
  return finalize(build(raw as JsonTreeInput, "0"));
}

function build(raw: JsonTreeInput, path: string): TraceNode {
  // Deterministic fallback id from position when the input omits one.
  // Never use Math.random() here: hashes are compared across runs.
  const id = String(raw.id ?? path);
  const label = String(raw.label ?? raw.id ?? "unnamed");
  const type = String(raw.type ?? "span");
  const attributes = isPlainObject(raw.attributes) ? raw.attributes : {};

  const children: TraceNode[] = Array.isArray(raw.children)
    ? raw.children.map((child, i) => build(child as JsonTreeInput, `${path}.${i}`))
    : [];

  return {
    id,
    type,
    label,
    attributes,
    children,
    depth: 0, // finalize() sets this
    subtreeSize: 1, // finalize() sets this
    raw,
  };
}
