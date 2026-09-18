import type { EquivalenceRule } from "./type";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ID_FIELD_RE = /(^|_)id$/i; // matches "id", "request_id", "trace_id"...

// Stateful by design: token assignment has to be consistent within one
// trace so the same real ID always maps to the same token, but must NOT
// leak across unrelated diff runs. That's why this is a factory, not a
// singleton like ignore-timestamps — call makeCanonicalizeIds() once per
// Merkle build (see registry.ts), never share an instance across traces.
//
// Caveat worth knowing: tokens are assigned in first-seen (traversal) order.
// For trace A and trace B to canonicalize equivalent IDs to the same token,
// both traces must be walked in the same deterministic order (pre-order DFS,
// same child ordering) up to the point each ID first appears. If your
// Merkle builder sorts children differently between A and B before this
// rule runs, token assignment can drift and cause false "semantic" diffs.
export function makeCanonicalizeIds(): EquivalenceRule {
  let counter = 0;
  const seen = new Map<string, string>();

  function tokenFor(value: string): string {
    const existing = seen.get(value);
    if (existing) return existing;
    const token = `__ID_${counter++}__`;
    seen.set(value, token);
    return token;
  }

  return {
    name: "canonicalize-ids",
    description:
      "Replaces UUID/ID-shaped values with positional tokens so a rotated correlation ID reads as identical.",

    normalize(node) {
      const attributes: Record<string, unknown> = {};
      for (const [key, value] of Object.entries(node.attributes)) {
        const looksLikeId =
          typeof value === "string" && (UUID_RE.test(value) || ID_FIELD_RE.test(key));
        attributes[key] = looksLikeId ? tokenFor(value as string) : value;
      }
      return { ...node, attributes };
    },
  };
}
