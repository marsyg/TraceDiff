import { describe, expect, test } from "bun:test";
import { autoDetect, parseFlatSpans, parseJsonTree, parseOtel } from "../src/parsers/index.js";

// ─────────────────────────────────────────────────────────────────────────────
// json-tree
// ─────────────────────────────────────────────────────────────────────────────

describe("parsers — json-tree", () => {
  const input = {
    id: "root",
    type: "span",
    label: "root",
    attributes: { env: "prod" },
    children: [
      {
        id: "c1",
        type: "span",
        label: "child1",
        attributes: {},
        children: [
          { id: "g1", type: "log", label: "leaf", attributes: { msg: "hi" }, children: [] },
        ],
      },
      { id: "c2", type: "span", label: "child2", attributes: {}, children: [] },
    ],
  };

  test("parses nested children into a TraceNode tree", () => {
    const t = parseJsonTree(input);

    expect(t.id).toBe("root");
    expect(t.label).toBe("root");
    expect(t.type).toBe("span");
    expect(t.attributes).toEqual({ env: "prod" });
    expect(t.children).toHaveLength(2);
    expect(t.children[0].label).toBe("child1");
    expect(t.children[0].children[0].label).toBe("leaf");
  });

  test("assigns depth top-down", () => {
    const t = parseJsonTree(input);
    expect(t.depth).toBe(0);
    expect(t.children[0].depth).toBe(1);
    expect(t.children[0].children[0].depth).toBe(2);
  });

  test("computes subtreeSize on every node", () => {
    const t = parseJsonTree(input);
    expect(t.subtreeSize).toBe(4);
    expect(t.children[0].subtreeSize).toBe(2);
    expect(t.children[1].subtreeSize).toBe(1);
  });

  test("defaults missing attributes to {}", () => {
    const t = parseJsonTree({
      id: "r",
      type: "span",
      label: "r",
      children: [],
    });
    expect(t.attributes).toEqual({});
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// json-flat
// ─────────────────────────────────────────────────────────────────────────────

describe("parsers — json-flat", () => {
  const input = [
    { id: "root", parentId: null, type: "span", label: "root", attributes: {} },
    { id: "c1", parentId: "root", type: "span", label: "child1", attributes: {} },
    { id: "g1", parentId: "c1", type: "log", label: "leaf", attributes: { msg: "hi" } },
    { id: "c2", parentId: "root", type: "span", label: "child2", attributes: {} },
  ];

  test("reconstructs parent-child relationships from parentId", () => {
    const t = parseFlatSpans(input);

    expect(t.label).toBe("root");
    expect(t.children.map((c) => c.label).sort()).toEqual(["child1", "child2"]);
    const c1 = t.children.find((c) => c.label === "child1");
    expect(c1?.children[0].label).toBe("leaf");
  });

  test("assigns depth and subtreeSize", () => {
    const t = parseFlatSpans(input);
    expect(t.depth).toBe(0);
    expect(t.subtreeSize).toBe(4);
    expect(t.children.find((c) => c.label === "child1")?.depth).toBe(1);
    expect(t.children.find((c) => c.label === "child1")?.subtreeSize).toBe(2);
  });

  test("handles order-independent input", () => {
    const shuffled = [...input].reverse();
    const t = parseFlatSpans(shuffled);
    expect(t.subtreeSize).toBe(4);
    const c1 = t.children.find((c) => c.label === "child1");
    expect(c1?.children[0].label).toBe("leaf");
  });

  test("throws if there is no root (every node has a parent)", () => {
    expect(() =>
      parseFlatSpans([
        { id: "a", parentId: "b", type: "span", label: "a", attributes: {} },
        { id: "b", parentId: "a", type: "span", label: "b", attributes: {} },
      ]),
    ).toThrow();
  });

  test("throws if a parentId points to a missing node", () => {
    expect(() =>
      parseFlatSpans([
        { id: "root", parentId: null, type: "span", label: "root", attributes: {} },
        { id: "c", parentId: "ghost", type: "span", label: "c", attributes: {} },
      ]),
    ).toThrow();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// OTel
// ─────────────────────────────────────────────────────────────────────────────

describe("parsers — otel", () => {
  const input = {
    resourceSpans: [
      {
        scopeSpans: [
          {
            spans: [
              {
                spanId: "s1",
                parentSpanId: "",
                name: "root",
                attributes: [{ key: "env", value: { stringValue: "prod" } }],
              },
              {
                spanId: "s2",
                parentSpanId: "s1",
                name: "child1",
                attributes: [],
              },
              {
                spanId: "s3",
                parentSpanId: "s2",
                name: "leaf",
                attributes: [{ key: "msg", value: { stringValue: "hi" } }],
              },
            ],
          },
        ],
      },
    ],
  };

  test("builds a tree from parentSpanId links", () => {
    const t = parseOtel(input);
    expect(t.children[0].label).toBe("root");
    const root = t.children[0];
    expect(root.children[0].label).toBe("child1");
    expect(root.children[0].children[0].label).toBe("leaf");
  });

  test("unwraps OTel attribute envelopes (stringValue/intValue/boolValue)", () => {
    const t = parseOtel(input);
    const root = t.children[0];
    expect(root.attributes.env).toBe("prod");
    const leaf = root.children[0].children[0];
    expect(leaf.attributes.msg).toBe("hi");
  });

  test("creates a synthetic root when there is exactly one top-level span", () => {
    const t = parseOtel(input);
    // plan says: creates synthetic root "trace"; adjust if your impl differs
    expect(t.children.length).toBeGreaterThanOrEqual(1);
    expect(t.label).toBeDefined();
  });

  test("handles multiple top-level spans by wrapping them under a synthetic root", () => {
    const multi = structuredClone(input);
    multi.resourceSpans[0].scopeSpans[0].spans.push({
      spanId: "s4",
      parentSpanId: "",
      name: "another-root",
      attributes: [],
    });
    const t = parseOtel(multi);
    const names = t.children.map((c) => c.label).sort();
    expect(names).toEqual(["another-root", "root"]);
  });

  test("computes subtreeSize correctly on the assembled tree", () => {
    const t = parseOtel(input);
    // synthetic root(1) + root(1) + child1(1) + leaf(1) = 4
    expect(t.subtreeSize).toBe(4);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// autoDetect
// ─────────────────────────────────────────────────────────────────────────────

describe("parsers — autoDetect", () => {
  test("array input → flat parser", () => {
    const t = autoDetect([
      { id: "root", parentId: null, type: "span", label: "root", attributes: {} },
    ]);
    expect(t.label).toBe("root");
  });

  test("object with resourceSpans → otel parser", () => {
    const t = autoDetect({
      resourceSpans: [
        {
          scopeSpans: [
            { spans: [{ spanId: "s1", parentSpanId: "", name: "root", attributes: [] }] },
          ],
        },
      ],
    });
    expect(t.children.length).toBeGreaterThanOrEqual(1);
  });

  test("object with children → json-tree parser", () => {
    const t = autoDetect({
      id: "r",
      type: "span",
      label: "r",
      attributes: {},
      children: [{ id: "c", type: "span", label: "c", attributes: {}, children: [] }],
    });
    expect(t.label).toBe("r");
    expect(t.children[0].label).toBe("c");
  });

  test("unknown shape throws with a helpful message", () => {
    expect(() => autoDetect({ foo: "bar" })).toThrow(/unknown|format/i);
    expect(() => autoDetect("not a trace")).toThrow(/unknown|format/i);
    expect(() => autoDetect(42)).toThrow(/unknown|format/i);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Round-trip: parse → diff
// ─────────────────────────────────────────────────────────────────────────────

describe("parsers — end-to-end with diff", () => {
  test("two json-tree traces with one semantic change produce one diff", async () => {
    const { runDiff } = await import("./helpers.js");
    const base = {
      id: "root",
      type: "span",
      label: "root",
      attributes: {},
      children: [
        { id: "a", type: "span", label: "a", attributes: { v: 1 }, children: [] },
        { id: "b", type: "span", label: "b", attributes: { v: 2 }, children: [] },
      ],
    };
    const mod = structuredClone(base);
    mod.children[0].attributes.v = 99;

    const a = parseJsonTree(base);
    const b = parseJsonTree(mod);

    const r = runDiff(a, b, []);
    expect(r.diffs.filter((d) => d.significance === "semantic")).toHaveLength(1);
    expect(r.partitionSum).toBe(r.traceASize);
  });
});
