import { describe, expect, it } from "bun:test";
import type { DiffResult, TraceNode } from "../src/core/type.js";
import {
  exportReproBundle,
  findParentLabel,
  generateCurl,
  generateVitest,
} from "../src/repro/generator.js";

// ---------------------------------------------------------------------------
// Shared fixtures
// ---------------------------------------------------------------------------

/** Minimal HTTP span simulating a POST endpoint on trace A (baseline). */
const httpNodeA: TraceNode = {
  id: "span-checkout-a",
  type: "span",
  label: "POST /api/v1/checkout",
  attributes: {
    "http.method": "POST",
    "http.route": "/api/v1/checkout",
    "http.status_code": 200,
    "user.id": "user_42",
  },
  children: [],
};

/** Same span on trace B, but with a status regression (200 -> 500). */
const httpNodeB: TraceNode = {
  id: "span-checkout-b",
  type: "span",
  label: "POST /api/v1/checkout",
  attributes: {
    "http.method": "POST",
    "http.route": "/api/v1/checkout",
    "http.status_code": 500,
    "user.id": "user_42",
  },
  children: [],
};

/** RPC span — no HTTP attributes. */
const rpcNodeA: TraceNode = {
  id: "span-rpc-a",
  type: "span",
  label: "InventoryService.Reserve",
  attributes: {
    "rpc.service": "InventoryService",
    "rpc.method": "Reserve",
    "sku": "SKU-9924-M",
  },
  children: [],
};

/** DB span — no HTTP or RPC attributes. */
const dbNodeA: TraceNode = {
  id: "span-db-a",
  type: "span",
  label: "pg_lock_stock_row",
  attributes: {
    "db.system": "postgresql",
    "db.statement": "SELECT stock FROM inventory WHERE sku = $1 FOR UPDATE",
  },
  children: [],
};

function makeDiff(
  overrides: Partial<DiffResult> & { nodeA?: TraceNode; nodeB?: TraceNode },
): DiffResult {
  return {
    type: "modified",
    significance: "semantic",
    description: "http.status_code: 200 → 500 (semantic)",
    depth: 0,
    affectedSubtreeSize: 1,
    pathA: ["POST /api/v1/checkout"],
    pathB: ["POST /api/v1/checkout"],
    nodeA: httpNodeA,
    nodeB: httpNodeB,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// generateCurl — HTTP spans
// ---------------------------------------------------------------------------

describe("generateCurl — HTTP spans", () => {
  it("emits a curl -X POST for a POST endpoint", () => {
    const diff = makeDiff({});
    const curl = generateCurl(diff, httpNodeA, httpNodeB);
    expect(curl).toContain("curl -X POST");
    expect(curl).toContain("http://localhost:3000/api/v1/checkout");
    expect(curl).toContain('-H "Content-Type: application/json"');
  });

  it("includes request payload attributes in -d flag", () => {
    const nodeWithBody: TraceNode = {
      ...httpNodeA,
      attributes: {
        ...httpNodeA.attributes,
        "order.id": "ord-99",
        "amount": 4999,
      },
    };
    const diff = makeDiff({ nodeA: nodeWithBody, nodeB: httpNodeB });
    const curl = generateCurl(diff, nodeWithBody, httpNodeB);
    expect(curl).toContain("-d '");
    expect(curl).toContain("ord-99");
  });

  it("emits a GET curl without a body for GET spans", () => {
    const getNodeA: TraceNode = {
      ...httpNodeA,
      attributes: { "http.method": "GET", "http.route": "/api/v1/items", "http.status_code": 200 },
    };
    const diff = makeDiff({ nodeA: getNodeA });
    const curl = generateCurl(diff, getNodeA, undefined);
    expect(curl).toContain("curl -X GET");
    expect(curl).not.toContain("-d");
  });

  it("uses the span label as a route slug when http.route is absent", () => {
    const unlabelledNode: TraceNode = {
      ...httpNodeA,
      attributes: { "http.method": "PUT" },
      label: "update user profile",
    };
    const diff = makeDiff({ nodeA: unlabelledNode });
    const curl = generateCurl(diff, unlabelledNode, undefined);
    expect(curl).toContain("update-user-profile");
    expect(curl).toContain("curl -X PUT");
  });
});

// ---------------------------------------------------------------------------
// generateCurl — RPC spans
// ---------------------------------------------------------------------------

describe("generateCurl — RPC spans", () => {
  it("emits a # RPC comment block instead of a curl command", () => {
    const diff = makeDiff({ nodeA: rpcNodeA, nodeB: undefined });
    const curl = generateCurl(diff, rpcNodeA, undefined);
    expect(curl).toContain("# RPC call");
    expect(curl).toContain("InventoryService");
    expect(curl).toContain("Reserve");
  });

  it("does NOT emit a curl -X line for RPC spans", () => {
    const diff = makeDiff({ nodeA: rpcNodeA });
    const curl = generateCurl(diff, rpcNodeA, undefined);
    expect(curl).not.toMatch(/^curl/m);
  });
});

// ---------------------------------------------------------------------------
// generateCurl — DB spans
// ---------------------------------------------------------------------------

describe("generateCurl — DB spans", () => {
  it("emits a POSTGRESQL comment block for a DB span", () => {
    const diff = makeDiff({ nodeA: dbNodeA });
    const curl = generateCurl(diff, dbNodeA, undefined);
    expect(curl).toContain("# POSTGRESQL");
    expect(curl).toContain("SELECT stock FROM inventory");
  });
});

// ---------------------------------------------------------------------------
// generateVitest — HTTP spans
// ---------------------------------------------------------------------------

describe("generateVitest — HTTP spans", () => {
  it("generates a file with the correct describe block", () => {
    const diff = makeDiff({});
    const file = generateVitest(diff, httpNodeA, httpNodeB);
    expect(file).toContain('import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"');
    expect(file).toContain("describe(");
    expect(file).toContain("Regression Repro:");
  });

  it("references the baseline status code in the it() description", () => {
    const diff = makeDiff({});
    const file = generateVitest(diff, httpNodeA, httpNodeB);
    expect(file).toContain("200");
    expect(file).toContain("expect(res.status).toBe(200)");
  });

  it("includes a regression comment when status codes differ", () => {
    const diff = makeDiff({});
    const file = generateVitest(diff, httpNodeA, httpNodeB);
    expect(file).toContain("Regression detected");
    expect(file).toContain("500");
  });

  it("does NOT include a regression comment when status codes are identical", () => {
    const nodeASameStatus: TraceNode = {
      ...httpNodeA,
      attributes: { ...httpNodeA.attributes, "http.status_code": 200 },
    };
    const nodeBSameStatus: TraceNode = {
      ...httpNodeB,
      attributes: { ...httpNodeB.attributes, "http.status_code": 200 },
    };
    const diff = makeDiff({ nodeA: nodeASameStatus, nodeB: nodeBSameStatus });
    const file = generateVitest(diff, nodeASameStatus, nodeBSameStatus);
    expect(file).not.toContain("Regression detected");
  });

  it("includes a caller mock when pathA has a parent element", () => {
    const diff = makeDiff({
      pathA: ["root", "payment_process", "POST /api/v1/checkout"],
    });
    const file = generateVitest(diff, httpNodeA, httpNodeB);
    expect(file).toContain("vi.mock");
    expect(file).toContain("paymentProcess");
  });
});

// ---------------------------------------------------------------------------
// generateVitest — RPC spans
// ---------------------------------------------------------------------------

describe("generateVitest — RPC spans", () => {
  it("generates a mock-client test for an RPC span", () => {
    const diff = makeDiff({ nodeA: rpcNodeA, nodeB: undefined, description: "rpc.method changed" });
    const file = generateVitest(diff, rpcNodeA, undefined);
    expect(file).toContain("mockClient");
    expect(file).toContain("InventoryService");
    expect(file).toContain("reserve");
  });
});

// ---------------------------------------------------------------------------
// generateVitest — DB spans
// ---------------------------------------------------------------------------

describe("generateVitest — DB spans (non-HTTP, non-RPC fallback)", () => {
  it("generates a mockDb.query test for a DB span", () => {
    const diff = makeDiff({ nodeA: dbNodeA, nodeB: undefined, description: "db.statement changed" });
    const file = generateVitest(diff, dbNodeA, undefined);
    expect(file).toContain("mockDb");
    expect(file).toContain("query");
    expect(file).toContain("SELECT stock FROM inventory");
  });
});

// ---------------------------------------------------------------------------
// exportReproBundle
// ---------------------------------------------------------------------------

describe("exportReproBundle", () => {
  it("returns a bundle with curl, vitestFile, and summary fields", () => {
    const diff = makeDiff({});
    const bundle = exportReproBundle(diff);
    expect(typeof bundle.curl).toBe("string");
    expect(typeof bundle.vitestFile).toBe("string");
    expect(typeof bundle.summary).toBe("string");
  });

  it("curl in the bundle matches standalone generateCurl output", () => {
    const diff = makeDiff({});
    const bundle = exportReproBundle(diff, httpNodeB);
    const standalone = generateCurl(diff, httpNodeA, httpNodeB);
    expect(bundle.curl).toBe(standalone);
  });

  it("summary contains a markdown heading and the reproduction command block", () => {
    const diff = makeDiff({});
    const bundle = exportReproBundle(diff);
    expect(bundle.summary).toContain("## Repro:");
    expect(bundle.summary).toContain("```sh");
    expect(bundle.summary).toContain("Significance:");
  });
});

// ---------------------------------------------------------------------------
// findParentLabel
// ---------------------------------------------------------------------------

describe("findParentLabel", () => {
  const tree: TraceNode = {
    id: "root-id",
    type: "span",
    label: "root",
    attributes: {},
    children: [
      {
        id: "child-id",
        type: "span",
        label: "payment_process",
        attributes: {},
        children: [
          {
            id: "grandchild-id",
            type: "call",
            label: "stripe_charge_create",
            attributes: {},
            children: [],
          },
        ],
      },
    ],
  };

  it("returns undefined for the root node", () => {
    expect(findParentLabel(tree, "root")).toBeUndefined();
  });

  it("returns the root label for a direct child", () => {
    expect(findParentLabel(tree, "payment_process")).toBe("root");
  });

  it("returns the parent label for a grandchild", () => {
    expect(findParentLabel(tree, "stripe_charge_create")).toBe("payment_process");
  });

  it("returns undefined when the target label does not exist in the tree", () => {
    expect(findParentLabel(tree, "nonexistent_span")).toBeUndefined();
  });
});
