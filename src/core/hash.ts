import { createHash } from "node:crypto";

/**
 * Deterministically serializes arbitrary trace values and attribute objects.
 *
 * Standard JSON.stringify does not guarantee object key order across JavaScript
 * runtimes or differing property insertion sequences. Because Merkle hashing
 * requires identical subtrees to generate bitwise-identical digests, this
 * function recursively sorts object keys before serialization.
 */
export function canonicalSerialize(obj: unknown): string {
  if (obj === null || typeof obj !== "object") return JSON.stringify(obj);
  if (Array.isArray(obj)) return `[${obj.map(canonicalSerialize).join(",")}]`;
  const record = obj as Record<string, unknown>;
  const keys = Object.keys(record);
  if (keys.length === 0) return "{}";
  let out = "{";
  const order = sortedKeyOrder(record, keys);
  for (let i = 0; i < order.length; i++) {
    if (i > 0) out += ",";
    const k = order[i];
    out += `${JSON.stringify(k)}:${canonicalSerialize(record[k])}`;
  }
  return `${out}}`;
}

// Attribute key-sets repeat heavily across nodes (dozens distinct over 100K
// nodes) while Array.sort with a string comparator costs per node — resolve
// each shape's order once. Sound by construction: the cached order is only
// ever a permutation aid, and any key absent from it is appended in sorted
// order, so equal key-sets always produce equal strings and every key is
// always emitted exactly once.
const keyOrderCache = new Map<string, readonly string[]>();

function sortedKeyOrder(record: Record<string, unknown>, keys: string[]): readonly string[] {
  if (keys.length === 1) return keys;
  const sig = keys.join("\0");
  let order = keyOrderCache.get(sig);
  if (order === undefined) {
    order = [...keys].sort();
    if (keyOrderCache.size > 512) keyOrderCache.clear();
    keyOrderCache.set(sig, order);
    return order;
  }
  if (order.length !== keys.length) return [...keys].sort();
  // Collision-safe path: emit cached order filtered to OWN present keys,
  // then any missing keys (a different key-set hashing to the same
  // signature) in sorted order. hasOwn (not `in`) so prototype members like
  // "toString" can never leak in. Deterministic for every input.
  let out: string[] | null = null;
  for (const k of order) {
    if (!Object.hasOwn(record, k)) {
      out = [];
      for (const ok of order) {
        if (Object.hasOwn(record, ok)) out.push(ok);
      }
      break;
    }
  }
  if (out === null) return order;
  const seen = new Set(out);
  const missing: string[] = [];
  for (const k of keys) {
    if (!seen.has(k)) missing.push(k);
  }
  missing.sort();
  return [...out, ...missing];
}

/**
 * Computes a standard SHA-256 hexadecimal hash digest for Merkle DAG nodes.
 */
export function computeHash(input: string): string {
  return createHash("sha256").update(input).digest("hex");
}
