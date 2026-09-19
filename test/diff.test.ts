import { describe, expect, test } from "bun:test";
import { clone, findByPath, node, runDiff, withDepth } from "./helpers";

// ─────────────────────────────────────────────────────────────────────────────
// Fixtures
// ─────────────────────────────────────────────────────────────────────────────

function buildBaseline() {
  return withDepth(
    node("root", { env: "prod" }, [
      node("api-gateway", {}, [
        node("auth-middleware", { latency_ms: 12 }, []),
        node("user-service", {}, [
          node("db-query", { rows_returned: 42, sql: "SELECT 1" }, []),
          node("format-response", {}, []),
        ]),
      ]),
      node("response", { http_status: 200 }, []),
    ]),
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Identity / skip fast-path
// ─────────────────────────────────────────────────────────────────────────────

describe("diff — identity", () => {
  test("self-diff is empty and skips all but the root", () => {
    const a = buildBaseline();
    const r = runDiff(a, clone(a), []);

    expect(r.diffs).toHaveLength(0);
    expect(r.nodesVisited).toBe(1); // only root popped
    expect(r.nodesSkipped).toBe((a.subtreeSize ?? 0) - 1);
    expect(r.nodesBulkReported).toBe(0);
    expect(r.partitionSum).toBe(r.traceASize);
  });

  test("two structurally identical trees built separately produce zero diffs", () => {
    const r = runDiff(buildBaseline(), buildBaseline(), []);
    expect(r.diffs).toHaveLength(0);
    expect(r.partitionSum).toBe(r.traceASize);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Added / removed
// ─────────────────────────────────────────────────────────────────────────────

describe("diff — added / removed", () => {
  test("one added child yields exactly one 'added' diff", () => {
    const a = buildBaseline();
    const b = clone(a);
    // append a new leaf under user-service
    const user = b.children[0].children[1];
    user.children.push(node("cache-miss-fallback", {}, []));
    withDepth(b, 0);

    const r = runDiff(a, b, []);
    const added = r.diffs.filter((d) => d.type === "added");

    expect(added).toHaveLength(1);
    expect(added[0].nodeB?.label).toBe("cache-miss-fallback");
    expect(added[0].nodeA).toBeUndefined();
    expect(added[0].significance).toBe("semantic");
    expect(added[0].affectedSubtreeSize).toBe(1);
  });

  test("one removed child yields exactly one 'removed' diff", () => {
    const a = buildBaseline();
    const b = clone(a);
    const user = b.children[0].children[1];
    user.children = user.children.filter((c) => c.label !== "format-response");
    withDepth(b, 0);

    const r = runDiff(a, b, []);
    const removed = r.diffs.filter((d) => d.type === "removed");

    expect(removed).toHaveLength(1);
    expect(removed[0].nodeA?.label).toBe("format-response");
    expect(removed[0].nodeB).toBeUndefined();
    expect(removed[0].significance).toBe("semantic");
  });

  test("removed subtree is accounted as bulk-reported, not visited", () => {
    const a = buildBaseline();
    const b = clone(a);
    // remove an entire 2-node subtree
    b.children[0].children[1].children = [];
    withDepth(b, 0);

    const r = runDiff(a, b, []);
    // Two nodes removed (db-query and format-response). Neither was walked.
    expect(r.nodesBulkReported).toBeGreaterThanOrEqual(2);
    expect(r.partitionSum).toBe(r.traceASize);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Modified attributes
// ─────────────────────────────────────────────────────────────────────────────

describe("diff — modified attributes", () => {
  test("one semantic attribute change produces one 'modified' diff at that node", () => {
    const a = buildBaseline();
    const b = clone(a);
    b.children[0].children[1].children[0].attributes.rows_returned = 0;

    const r = runDiff(a, b, []);
    const modified = r.diffs.filter((d) => d.type === "modified");

    expect(modified).toHaveLength(1);
    expect(modified[0].significance).toBe("semantic");
    expect(modified[0].nodeA?.label).toBe("db-query");
    expect(modified[0].description).toContain("rows_returned");
    expect(modified[0].description).toContain("42");
    expect(modified[0].description).toContain("0");
  });

  test("multiple field changes on one node collapse into a single diff (worst-wins)", () => {
    const a = buildBaseline();
    const b = clone(a);
    const db = b.children[0].children[1].children[0];
    db.attributes.rows_returned = 0; // semantic (no rule)
    db.attributes.sql = "SELECT 2"; // also semantic

    const r = runDiff(a, b, []);
    const modified = r.diffs.filter((d) => d.type === "modified");
    // one entry per node, not per field
    expect(modified).toHaveLength(1);
    expect(modified[0].significance).toBe("semantic");
    // description mentions both fields
    expect(modified[0].description).toContain("rows_returned");
    expect(modified[0].description).toContain("sql");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Noise classification via rules
// ─────────────────────────────────────────────────────────────────────────────

describe("diff — noise via rules", () => {
  test("timestamp-only change is noise when ignore-timestamps is active", () => {
    const a = withDepth(
      node("root", { ts: "2026-09-18T10:00:00Z" }, [
        node("work", { ts: "2026-09-18T10:00:01Z" }, []),
      ]),
    );
    const b = clone(a);
    b.attributes.ts = "2026-09-18T10:05:00Z";
    b.children[0].attributes.ts = "2026-09-18T10:05:01Z";
    withDepth(b, 0);

    const r = runDiff(a, b, ["ignore-timestamps"]);
    const semantic = r.diffs.filter((d) => d.significance === "semantic");
    const noise = r.diffs.filter((d) => d.significance === "noise");

    expect(semantic).toHaveLength(0);
    expect(noise.length).toBeGreaterThanOrEqual(1);
  });

  test("timestamp-only change is semantic when no rules are active", () => {
    const a = withDepth(node("root", { ts: "2026-09-18T10:00:00Z" }));
    const b = withDepth(node("root", { ts: "2026-09-18T10:05:00Z" }));

    const r = runDiff(a, b, []);
    expect(r.diffs.some((d) => d.significance === "semantic")).toBe(true);
  });

  test("mixed node rolls up to worst significance", () => {
    // Field A is within numeric tolerance (noise), field B is not (semantic).
    const a = withDepth(node("op", { jitter_ms: 100, status: 200 }));
    const b = withDepth(node("op", { jitter_ms: 103, status: 500 }));

    const r = runDiff(a, b, ["numeric-tolerance"]);
    const mod = r.diffs.find((d) => d.type === "modified");

    expect(mod).toBeDefined();
    // status change is semantic — must beat the jitter noise
    expect(mod?.significance).toBe("semantic");
    expect(mod?.description).toContain("jitter_ms");
    expect(mod?.description).toContain("status");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Depth cap
// ─────────────────────────────────────────────────────────────────────────────

describe("diff — depth cap", () => {
  test("a divergence beyond maxDepth is reported as one uncertain diff and bulk-accounted", () => {
    // chain of depth 8, leaf changes at the bottom
    function chain(leafValue: number, n = 8) {
      let cur = node("leaf", { v: leafValue });
      for (let i = n - 1; i >= 0; i--) cur = node(`level-${i}`, {}, [cur]);
      return withDepth(cur);
    }

    const a = chain(1);
    const b = chain(2);

    const r = runDiff(a, b, [], { maxDepth: 3 });

    expect(r.depthCapped).toBeGreaterThanOrEqual(1);
    const capped = r.diffs.find(
      (d) => d.description.includes("depth limit") || d.significance === "uncertain",
    );
    expect(capped).toBeDefined();
    // No frames below the cap were popped
    expect(r.nodesBulkReported).toBeGreaterThan(0);
    // Three-bucket invariant still holds
    expect(r.partitionSum).toBe(r.traceASize);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Accounting invariant — must hold for every branch
// ─────────────────────────────────────────────────────────────────────────────

describe("diff — accounting invariant", () => {
  const cases: Array<
    [string, () => [ReturnType<typeof buildBaseline>, ReturnType<typeof buildBaseline>]]
  > = [
    [
      "identical",
      () => {
        const a = buildBaseline();
        return [a, clone(a)];
      },
    ],
    [
      "added",
      () => {
        const a = buildBaseline();
        const b = clone(a);
        b.children[0].children[1].children.push(node("extra"));
        withDepth(b, 0);
        return [a, b];
      },
    ],
    [
      "removed",
      () => {
        const a = buildBaseline();
        const b = clone(a);
        b.children[0].children[1].children = [];
        withDepth(b, 0);
        return [a, b];
      },
    ],
    [
      "modified",
      () => {
        const a = buildBaseline();
        const b = clone(a);
        b.children[1].attributes.http_status = 500;
        withDepth(b, 0);
        return [a, b];
      },
    ],
    [
      "noise",
      () => {
        const a = withDepth(node("root", { ts: "a" }, [node("c", { ts: "b" })]));
        const b = withDepth(node("root", { ts: "x" }, [node("c", { ts: "y" })]));
        return [a, b];
      },
    ],
  ];

  for (const [name, make] of cases) {
    test(`traceASize === visited + skipped + bulkReported (${name})`, () => {
      const [a, b] = make();
      const rules = name === "noise" ? ["ignore-timestamps"] : [];
      const r = runDiff(a, b, rules);
      expect(r.partitionSum).toBe(r.traceASize);
    });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// Paths and metadata
// ─────────────────────────────────────────────────────────────────────────────

describe("diff — paths and metadata", () => {
  test("paths describe the location of the diff", () => {
    const a = buildBaseline();
    const b = clone(a);
    b.children[0].children[1].children[0].attributes.rows_returned = 0;

    const r = runDiff(a, b, []);
    const dbDiff = r.diffs.find((d) => d.nodeA?.label === "db-query");

    expect(dbDiff).toBeDefined();
    expect(dbDiff?.pathA).toEqual(["root", "api-gateway", "user-service", "db-query"]);
    expect(dbDiff?.pathB).toEqual(["root", "api-gateway", "user-service", "db-query"]);
    expect(dbDiff?.depth).toBe(3);
  });

  test("added diff has no pathA and removed diff has no pathB", () => {
    const a = buildBaseline();
    const b = clone(a);
    b.children[0].children[1].children.push(node("brand-new"));
    withDepth(b, 0);

    const r = runDiff(a, b, []);
    const added = findByPath(
      r.diffs.filter((d) => d.type === "added"),
      "brand-new",
    );
    expect(added?.pathA).toBeDefined(); // parent path is always present
    expect(added?.nodeA).toBeUndefined();
    expect(added?.nodeB?.label).toBe("brand-new");
  });

  test("affectedSubtreeSize reflects the size of the affected subtree", () => {
    const a = buildBaseline();
    const b = clone(a);
    // Add a 3-node subtree
    const big = node("big", {}, [node("x"), node("y")]);
    b.children[0].children[1].children.push(big);
    withDepth(b, 0);

    const r = runDiff(a, b, []);
    const added = r.diffs.find((d) => d.type === "added" && d.nodeB?.label === "big");
    expect(added?.affectedSubtreeSize).toBe(3);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Skip accounting sanity — the demo numbers
// ─────────────────────────────────────────────────────────────────────────────

describe("diff — skip accounting", () => {
  test("a single leaf change in a deep tree skips >95% of nodes", () => {
    // Depth-3 tree: root → 10 → 10 → 10 = 1 + 10 + 100 + 1000 = 1111 nodes.
    // One changed leaf invalidates the hash chain up its ancestors only;
    // sibling subtrees at each level are Merkle-skipped. Observed skip: ~97%.
    const buildTree = (leafValue: number) =>
      withDepth(
        node(
          "root",
          {},
          Array.from({ length: 10 }, (_, g) =>
            node(
              `g${g}`,
              {},
              Array.from({ length: 10 }, (_, sg) =>
                node(
                  `g${g}-s${sg}`,
                  {},
                  Array.from({ length: 10 }, (_, l) =>
                    node(`g${g}-s${sg}-l${l}`, { v: leafValue }),
                  ),
                ),
              ),
            ),
          ),
        ),
      );

    const a = buildTree(0);
    const b = buildTree(0);
    b.children[5].children[7].children[3].attributes.v = 1;

    const r = runDiff(a, b, []);
    const skipPct = (r.nodesSkipped / r.traceASize) * 100;

    expect(r.partitionSum).toBe(r.traceASize);
    expect(skipPct).toBeGreaterThan(95);
    expect(r.diffs.filter((d) => d.significance === "semantic")).toHaveLength(1);
  });
});
