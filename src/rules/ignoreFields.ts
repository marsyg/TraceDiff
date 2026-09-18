import type { EquivalenceRule } from "./type";

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

    normalize(node) {
      const attributes: Record<string, unknown> = {};
      for (const [key, value] of Object.entries(node.attributes)) {
        if (!blocked.has(key)) attributes[key] = value;
      }
      return { ...node, attributes };
    },
  };
}
