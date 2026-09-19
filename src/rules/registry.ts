import type { TraceNode } from "../core/type.js";
import { makeCanonicalizeIds } from "./canonicalize-ids.js";
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

// Build a FRESH rule set per diff run. This matters specifically because
// canonicalize-ids carries state (its token map) — reusing one instance
// across unrelated trace pairs would leak token assignments between them.
export function buildRuleSet(options: RuleSetOptions = {}): EquivalenceRule[] {
  const available: Record<string, () => EquivalenceRule> = {
    "ignore-timestamps": () => ignoreTimestamps(),
    "canonicalize-ids": () => makeCanonicalizeIds(),
    "numeric-tolerance": () =>
      options.numericTolerance !== undefined
        ? makeNumericTolerance({ relativeTolerance: options.numericTolerance })
        : makeNumericTolerance({}),
    "sort-concurrent": () => makeSortConcurrent(options.isConcurrent ?? (() => false)),
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
// a verdict wins — order rules with more specific classify() logic first
// if you add custom ones. Unclassified diffs default to "semantic": if no
// rule vouches for it, treat it as real rather than silently dropping it.
export function classifyDiff(
  diff: RawDiff,
  rules: EquivalenceRule[],
): "semantic" | "noise" | "uncertain" {
  for (const rule of rules) {
    const verdict = rule.classify?.(diff);
    if (verdict) return verdict;
  }
  return "semantic";
}
