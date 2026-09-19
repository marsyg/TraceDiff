import type { EquivalenceRule } from "./type.js";

// The manual escape hatch: whatever the other rules don't cover, --ignore-
// fields lets the user blocklist by hand. Deliberately dumb — no pattern
// matching, exact key names only, so behavior is always predictable from
// the CLI flag.
export function makeIgnoreFields(fields: string[]): EquivalenceRule {
  const blocked = new Set(fields);

  return {
    name: "ignore-fields",
    description:
      fields.length > 0
        ? `Ignores user-specified fields: ${fields.join(", ")}`
        : "Ignores user-specified fields (none configured).",
    fuse: { kind: "ignore-fields", fields: [...fields] },

    normalize(node) {
      // Fast path: with no configured fields (the default) there is nothing
      // to strip — return the node as-is instead of rebuilding its attribute
      // map on every Merkle visit.
      if (blocked.size === 0) return node;
      let mutated = false;
      const attributes: Record<string, unknown> = {};
      for (const [key, value] of Object.entries(node.attributes)) {
        if (blocked.has(key)) {
          mutated = true;
          continue;
        }
        attributes[key] = value;
      }
      return mutated ? { ...node, attributes } : node;
    },
  };
}
