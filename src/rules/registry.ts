import type { Significance, TraceNode } from "../core/type.js";
import { canonicalizeIdsRule } from "./canonicalize-ids.js";
import { makeIgnoreFields } from "./ignore-fields.js";
import { ignoreTimestamps } from "./ignore-timestamp.js";
import { makeNumericTolerance } from "./numeric-tolerance.js";
import { makeSortConcurrent } from "./sort-concurrent.js";
import type { EquivalenceRule, RawDiff } from "./type.js";

export interface RuleSetOptions {
  ruleNames?: string[]; // subset from --rules, default = all built-ins
  numericTolerance?: number; // --tolerance
  ignoreFields?: string[]; // --ignore-fields
  isConcurrent?: (node: TraceNode) => boolean;
}

export function buildRuleSet(options: RuleSetOptions = {}): EquivalenceRule[] {
  const available: Record<string, () => EquivalenceRule> = {
    "ignore-timestamps": () => ignoreTimestamps(),
    // canonicalize-ids is pure (fixed sentinel, no per-run state) so a
    // single shared instance is fine — the factory wrapper is kept only
    // for consistency with the other entries.
    "canonicalize-ids": () => canonicalizeIdsRule,
    "numeric-tolerance": () =>
      options.numericTolerance !== undefined
        ? makeNumericTolerance({ relativeTolerance: options.numericTolerance })
        : makeNumericTolerance({}),
    // Default predicate: any node typed "parallel" has unordered children.
    // Previously this defaulted to () => false, which silently disabled
    // the rule on every well-formed trace.
    "sort-concurrent": () =>
      makeSortConcurrent(options.isConcurrent ?? ((node: TraceNode) => node.type === "parallel")),
    "ignore-fields": () => makeIgnoreFields(options.ignoreFields ?? []),
  };

  const names = options.ruleNames ?? Object.keys(available);
  return names.map((name) => {
    const factory = available[name];
    if (!factory) {
      throw new Error(
        `Unknown equivalence rule "${name}". Available: ${Object.keys(available).join(", ")}`,
      );
    }
    return factory();
  });
}

// Apply every active rule to a node, in order, before it gets hashed.
export function applyRules(node: TraceNode, rules: EquivalenceRule[]): TraceNode {
  return rules.reduce((current, rule) => rule.normalize(current), node);
}

// True if ANY active rule wants this node's children sorted before hashing.
export function shouldSortChildren(node: TraceNode, rules: EquivalenceRule[]): boolean {
  return rules.some((rule) => rule.shouldSortChildren?.(node) ?? false);
}

// Run classify() across rules for one localized diff. First rule to return
// a verdict wins. Returns both the verdict AND the rule that produced it,
// so callers do not need a second pass to find `classifiedBy`.
export function classifyDiff(
  diff: RawDiff,
  rules: EquivalenceRule[],
): { significance: Significance; classifiedBy?: string } {
  for (const rule of rules) {
    const verdict = rule.classify?.(diff);
    if (verdict) return { significance: verdict, classifiedBy: rule.name };
  }
  // Unclassified diffs default to "semantic": if no rule vouches for it,
  // treat it as real rather than silently dropping it.
  return { significance: "semantic" };
}
