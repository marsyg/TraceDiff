import type { Significance, TraceNode } from "../core/type.js";
import { canonicalizeIdsRule, ID_FIELD_RE, ID_TOKEN } from "./canonicalize-ids.js";
import { makeIgnoreFields } from "./ignore-fields.js";
import { ignoreTimestamps, isTimestampKey, TIMESTAMP_TOKEN } from "./ignore-timestamp.js";
import { bucketLogBucketSize, bucketNumber, makeNumericTolerance } from "./numeric-tolerance.js";
import { makeSortConcurrent } from "./sort-concurrent.js";
import type { EquivalenceRule, RawDiff, RuleFuse } from "./type.js";

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
//
// Hot path: the Merkle builder calls this on EVERY node, so the compiled
// form is memoized per rule array (each build uses one array for the whole
// tree — 3 entries per compareTraces, reclaimed afterwards). Arrays must not
// be mutated after use; buildRuleSet always returns fresh ones.
const compiledCache = new WeakMap<EquivalenceRule[], (node: TraceNode) => TraceNode>();

export function applyRules(node: TraceNode, rules: EquivalenceRule[]): TraceNode {
  let fn = compiledCache.get(rules);
  if (fn === undefined) {
    fn = compileNormalizer(rules);
    compiledCache.set(rules, fn);
  }
  return fn(node);
}

/** Compile one single-pass attribute normalizer for the active rule set. */
export function compileNormalizer(rules: EquivalenceRule[]): (node: TraceNode) => TraceNode {
  const fused = tryFuse(rules);
  if (fused === undefined) {
    // Opaque (custom) rule present — sequential reduce, exactly as before.
    return (node: TraceNode) => rules.reduce((current, rule) => rule.normalize(current), node);
  }
  return fused;
}

interface FusedPlan {
  timestamps: boolean;
  ids: boolean;
  numericLogs: number[];
  blocked: Set<string>;
}

// Bit flags for the per-key classification cache below.
const KEY_TS = 1;
const KEY_ID = 2;
const KEY_BLOCKED = 4;

function tryFuse(rules: EquivalenceRule[]): ((node: TraceNode) => TraceNode) | undefined {
  const plan: FusedPlan = { timestamps: false, ids: false, numericLogs: [], blocked: new Set() };
  for (const rule of rules) {
    const fuse: RuleFuse | undefined = rule.fuse;
    if (fuse === undefined) return undefined;
    switch (fuse.kind) {
      case "ignore-timestamps":
        plan.timestamps = true;
        break;
      case "canonicalize-ids":
        plan.ids = true;
        break;
      case "numeric-tolerance":
        plan.numericLogs.push(bucketLogBucketSize(fuse.tolerance));
        break;
      case "ignore-fields":
        for (const f of fuse.fields) plan.blocked.add(f);
        break;
      case "passthrough":
        break;
      default:
        return undefined;
    }
  }

  // Attribute KEYS repeat heavily across nodes (~dozens distinct over 100K
  // nodes) while split/regex/Set lookups cost per node — classify each key
  // once. Pure function of (key, plan); the cap only bounds memory.
  const keyClass = new Map<string, number>();
  const classify = (key: string): number => {
    let flags = keyClass.get(key);
    if (flags === undefined) {
      // Independent checks (no else-chain): a user --ignore-fields entry
      // may name a timestamp key, and the fused pass must still drop it
      // exactly like the sequential pipeline does.
      flags = 0;
      if (plan.timestamps && isTimestampKey(key)) flags |= KEY_TS;
      if (plan.ids && ID_FIELD_RE.test(key)) flags |= KEY_ID;
      if (plan.blocked.has(key)) flags |= KEY_BLOCKED;
      if (keyClass.size > 2048) keyClass.clear();
      keyClass.set(key, flags);
    }
    return flags;
  };

  const { numericLogs } = plan;
  const hasNumerics = numericLogs.length > 0;

  // Mirrors sequential application (timestamps → ids → numeric → drop):
  // timestamp/id leaves are disjoint by definition, numeric only touches
  // numbers (sentinels are strings), and a dropped key stays dropped wherever
  // the ignore-fields rule sits — so this single pass is exactly equivalent
  // for every rule order and multiplicity.
  return (node: TraceNode): TraceNode => {
    const src = node.attributes;
    const keys = Object.keys(src);
    let out: Record<string, unknown> | null = null;
    for (let i = 0; i < keys.length; i++) {
      const key = keys[i];
      const flags = classify(key);
      if ((flags & KEY_BLOCKED) !== 0) {
        if (out === null) {
          out = {};
          for (let j = 0; j < i; j++) out[keys[j]] = src[keys[j]];
        }
        continue;
      }
      let value = src[key];
      if ((flags & KEY_TS) !== 0) {
        if (value === TIMESTAMP_TOKEN) {
          if (out !== null) out[key] = value;
          continue;
        }
        value = TIMESTAMP_TOKEN;
      } else if ((flags & KEY_ID) !== 0) {
        if (value == null || value === ID_TOKEN) {
          if (out !== null) out[key] = value;
          continue;
        }
        value = ID_TOKEN;
      } else if (
        hasNumerics &&
        typeof value === "number" &&
        Number.isFinite(value) &&
        value !== 0
      ) {
        let bucketed = value;
        for (const logSize of numericLogs) bucketed = bucketNumber(bucketed, logSize);
        value = bucketed;
      } else {
        if (out !== null) out[key] = value;
        continue;
      }
      if (out === null) {
        out = {};
        for (let j = 0; j < i; j++) out[keys[j]] = src[keys[j]];
      }
      out[key] = value;
    }
    return out === null ? node : { ...node, attributes: out };
  };
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
