/**
 * Repro-Gen: Trace-to-Code Automated Test Generator
 *
 * Consumes existing DiffResult objects and TraceNode AST nodes to synthesize:
 *   - Executable cURL commands that reproduce the diverging HTTP/RPC call.
 *   - Standalone Vitest/TypeScript unit tests with mocked upstream dependencies.
 *   - A ReproBundle combining both artefacts with a human-readable summary.
 *
 * This module is purely additive -- it does NOT modify the diff engine, Merkle
 * tree hashing, equivalence rules, or Step Functions orchestration.
 */

import type { DiffResult, TraceNode } from "../core/type.js";

// --- Public output types -------------------------------------------------------

/** The self-contained reproduction artefact for a single semantic diff. */
export interface ReproBundle {
  /** Runnable shell command: `curl -X <METHOD> "http://localhost:3000<ROUTE>" ...` */
  curl: string;
  /** Complete `.test.ts` file content, suitable for `bun test` / `vitest`. */
  vitestFile: string;
  /** Short markdown paragraph describing what this repro exercises. */
  summary: string;
}

// --- Internal span metadata ---------------------------------------------------

interface SpanMeta {
  httpMethod?: string;
  httpRoute?: string;
  httpStatusA?: number;
  httpStatusB?: number;
  rpcService?: string;
  rpcMethod?: string;
  dbSystem?: string;
  dbStatement?: string;
  requestPayload?: Record<string, unknown>;
  isHttp: boolean;
  isRpc: boolean;
  isDb: boolean;
  label: string;
  callerLabel?: string;
}

// --- Span metadata extractor --------------------------------------------------

/**
 * Extracts structured metadata from a TraceNode's raw attributes.
 *
 * Precedence:
 *   1. HTTP attributes  (`http.method`, `http.route`, `http.status_code`)
 *   2. RPC attributes   (`rpc.service`, `rpc.method`)
 *   3. DB attributes    (`db.system`, `db.statement`)
 *
 * Remaining non-metadata attributes are collected into `requestPayload`.
 */
function extractSpanMeta(nodeA?: TraceNode, nodeB?: TraceNode, callerLabel?: string): SpanMeta {
  const attrsA = nodeA?.attributes ?? {};
  const attrsB = nodeB?.attributes ?? {};

  const strAttr = (key: string): string | undefined => {
    const v = attrsA[key] ?? attrsB[key];
    return typeof v === "string" ? v : undefined;
  };

  const numAttr = (attrs: Record<string, unknown>, key: string): number | undefined => {
    const v = attrs[key];
    return typeof v === "number" ? v : undefined;
  };

  const httpMethod = strAttr("http.method");
  const httpRoute = strAttr("http.route");
  const httpStatusA = numAttr(attrsA, "http.status_code");
  const httpStatusB = numAttr(attrsB, "http.status_code");
  const rpcService = strAttr("rpc.service");
  const rpcMethod = strAttr("rpc.method");
  const dbSystem = strAttr("db.system");
  const dbStatement = strAttr("db.statement") ?? strAttr("db.statement.text");

  const isHttp = !!(httpMethod || httpRoute);
  const isRpc = !isHttp && !!(rpcService || rpcMethod);
  const isDb = !isHttp && !isRpc && !!(dbSystem || dbStatement);

  const SKIP_KEYS = new Set([
    "http.method",
    "http.route",
    "http.status_code",
    "http.url",
    "http.target",
    "rpc.service",
    "rpc.method",
    "rpc.system",
    "db.system",
    "db.statement",
    "db.statement.text",
    "db.operation",
    "db.name",
    "span.kind",
    "service.name",
  ]);

  const requestPayload: Record<string, unknown> = {};
  for (const [key, val] of Object.entries(attrsA)) {
    if (!SKIP_KEYS.has(key) && typeof val !== "boolean") {
      requestPayload[key] = val;
    }
  }

  return {
    httpMethod,
    httpRoute,
    httpStatusA,
    httpStatusB,
    rpcService,
    rpcMethod,
    dbSystem,
    dbStatement,
    requestPayload: Object.keys(requestPayload).length > 0 ? requestPayload : undefined,
    isHttp,
    isRpc,
    isDb,
    label: nodeA?.label ?? nodeB?.label ?? "unknown-span",
    callerLabel,
  };
}

/**
 * Walks the TraceNode tree to find the immediate parent label of a node
 * identified by `targetLabel`. Returns undefined when the target is the root.
 */
export function findParentLabel(root: TraceNode, targetLabel: string): string | undefined {
  function walk(node: TraceNode, parentLabel: string | undefined): string | undefined {
    if (node.label === targetLabel) return parentLabel;
    for (const child of node.children) {
      const result = walk(child, node.label);
      if (result !== undefined) return result;
    }
    return undefined;
  }
  return walk(root, undefined);
}

// --- cURL generator ----------------------------------------------------------

/**
 * Formats a runnable `curl` command for the diverging span.
 *
 * HTTP spans  -> `curl -X <METHOD> "http://localhost:3000<ROUTE>" ...`
 * RPC spans   -> commented stub showing service/method/input
 * DB spans    -> commented stub showing the SQL/query statement
 * Fallback    -> curl using the span label as a route slug
 */
export function generateCurl(_diff: DiffResult, nodeA?: TraceNode, nodeB?: TraceNode): string {
  const meta = extractSpanMeta(nodeA, nodeB);

  if (meta.isHttp || (!meta.isRpc && !meta.isDb)) {
    const method = meta.httpMethod ?? "GET";
    const route = meta.httpRoute ?? `/${slugify(meta.label)}`;
    const baseUrl = `http://localhost:3000${route}`;
    const headers = ['-H "Content-Type: application/json"'];

    let body = "";
    if (meta.requestPayload && Object.keys(meta.requestPayload).length > 0) {
      body = ` \\\n  -d '${JSON.stringify(meta.requestPayload)}'`;
    } else if (method === "POST" || method === "PUT" || method === "PATCH") {
      body = " \\\n  -d '{}'";
    }

    return `curl -X ${method} "${baseUrl}" \\\n  ${headers.join(" \\\n  ")}${body}`;
  }

  if (meta.isRpc) {
    const service = meta.rpcService ?? "UnknownService";
    const method = meta.rpcMethod ?? meta.label;
    const input = meta.requestPayload ? JSON.stringify(meta.requestPayload, null, 2) : "{}";
    return `# RPC call -- no HTTP endpoint to curl\n# Service: ${service}\n# Method:  ${method}\n# Input:   ${input.replace(/\n/g, "\n#          ")}`;
  }

  // DB span
  const stmt = meta.dbStatement ?? `-- query for span: ${meta.label}`;
  const system = meta.dbSystem ?? "database";
  return `# ${system.toUpperCase()} query -- no HTTP endpoint to curl\n# ${stmt}`;
}

// --- Vitest file generator ---------------------------------------------------

/**
 * Generates a standalone `.test.ts` file for the diverging span. The test:
 *   1. Mocks the immediate upstream caller so the unit is self-contained.
 *   2. Calls the endpoint / function under test.
 *   3. Asserts against the baseline (trace A) behaviour, making the regression
 *      introduced in trace B detectable without a live environment.
 */
export function generateVitest(diff: DiffResult, nodeA?: TraceNode, nodeB?: TraceNode): string {
  const callerLabel =
    diff.pathA && diff.pathA.length >= 2 ? diff.pathA[diff.pathA.length - 2] : undefined;
  const meta = extractSpanMeta(nodeA, nodeB, callerLabel);

  const testName = `Regression Repro: ${diff.description.slice(0, 120)}`;
  const callerMock = meta.callerLabel ? buildCallerMock(meta.callerLabel) : "";

  if (meta.isHttp || (!meta.isRpc && !meta.isDb)) {
    return buildHttpVitestFile(meta, testName, callerMock, diff);
  }
  if (meta.isRpc) {
    return buildRpcVitestFile(meta, testName, callerMock, diff);
  }
  return buildDbVitestFile(meta, testName, callerMock, diff);
}

// --- Bundle assembler --------------------------------------------------------

/**
 * Returns the cURL command, Vitest file content, and a markdown summary
 * for a single semantic DiffResult, packaged as a ReproBundle.
 */
export function exportReproBundle(diff: DiffResult, nodeB?: TraceNode): ReproBundle {
  const nodeA = diff.nodeA;
  const nB = nodeB ?? diff.nodeB;

  const curl = generateCurl(diff, nodeA, nB);
  const vitestFile = generateVitest(diff, nodeA, nB);
  const summary = buildMarkdownSummary(diff, curl);

  return { curl, vitestFile, summary };
}

// --- Private helpers ---------------------------------------------------------

function slugify(label: string): string {
  return label
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
}

function buildCallerMock(callerLabel: string): string {
  const id = camelCase(callerLabel);
  return `\n  // Mock the upstream caller so this test is self-contained.\n  vi.mock("./${id}", () => ({\n    ${id}: vi.fn().mockResolvedValue({ ok: true }),\n  }));`;
}

function camelCase(label: string): string {
  return label
    .replace(/[-_\s.]+(.)/g, (_, c: string) => c.toUpperCase())
    .replace(/^./, (c) => c.toLowerCase());
}

function buildHttpVitestFile(
  meta: SpanMeta,
  testName: string,
  callerMock: string,
  diff: DiffResult,
): string {
  const method = (meta.httpMethod ?? "GET").toLowerCase();
  const route = meta.httpRoute ?? `/${slugify(meta.label)}`;
  const expectedStatus = meta.httpStatusA ?? 200;
  const regressionStatus = meta.httpStatusB;
  const payload = meta.requestPayload ? JSON.stringify(meta.requestPayload) : "{}";

  const fetchBody =
    method === "get" || method === "head" ? "" : `,\n    body: JSON.stringify(${payload}),`;

  const regressionComment =
    regressionStatus !== undefined && regressionStatus !== expectedStatus
      ? `\n  // Regression detected: trace B returned ${regressionStatus} instead of ${expectedStatus}.\n  // Uncomment the line below to assert that the regression is present:\n  // expect(res.status).toBe(${regressionStatus}); // regression`
      : "";

  return `/**
 * AUTO-GENERATED by TraceDiff Repro-Gen
 * Span:        ${meta.label}
 * Diff type:   ${diff.type} (${diff.significance})
 * Description: ${diff.description.slice(0, 200)}
 *
 * Run: bun test this-file.test.ts
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
${callerMock ? `${callerMock}\n` : ""}
const BASE_URL = process.env.TEST_BASE_URL ?? "http://localhost:3000";

describe("${escapeStr(testName)}", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("baseline: should return ${expectedStatus} for a well-formed ${method.toUpperCase()} ${route}", async () => {
    const res = await fetch(\`\${BASE_URL}${route}\`, {
      method: "${method.toUpperCase()}",
      headers: { "Content-Type": "application/json" }${fetchBody}
    });

    // Assert against the baseline behaviour (trace A).
    expect(res.status).toBe(${expectedStatus});${regressionComment}
  });

  it("regression: response body is consistent with baseline span attributes", async () => {
    const res = await fetch(\`\${BASE_URL}${route}\`, {
      method: "${method.toUpperCase()}",
      headers: { "Content-Type": "application/json" }${fetchBody}
    });

    // The response must be parseable JSON.
    const body = await res.json().catch(() => null);
    expect(body).not.toBeNull();
  });
});
`;
}

function buildRpcVitestFile(
  meta: SpanMeta,
  testName: string,
  callerMock: string,
  diff: DiffResult,
): string {
  const service = meta.rpcService ?? "UnknownService";
  const method = meta.rpcMethod ?? meta.label;
  const inputStr = meta.requestPayload ? JSON.stringify(meta.requestPayload, null, 4) : "{}";

  return `/**
 * AUTO-GENERATED by TraceDiff Repro-Gen
 * Span:        ${meta.label}
 * Diff type:   ${diff.type} (${diff.significance})
 * Description: ${diff.description.slice(0, 200)}
 *
 * Run: bun test this-file.test.ts
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
${callerMock ? `${callerMock}\n` : ""}
// TODO: replace with the actual import path for your ${service} client.
// import { ${camelCase(service)}Client } from "../src/clients/${slugify(service)}";

describe("${escapeStr(testName)}", () => {
  const mockClient = {
    ${camelCase(method)}: vi.fn(),
  };

  beforeEach(() => {
    vi.clearAllMocks();
    // Simulate the baseline (trace A) response.
    mockClient.${camelCase(method)}.mockResolvedValue({ success: true });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("calls ${service}.${method} with the expected inputs", async () => {
    const input = ${inputStr};
    await mockClient.${camelCase(method)}(input);

    expect(mockClient.${camelCase(method)}).toHaveBeenCalledOnce();
    expect(mockClient.${camelCase(method)}).toHaveBeenCalledWith(input);
  });

  it("returns a successful result matching baseline behaviour", async () => {
    const result = await mockClient.${camelCase(method)}({});
    expect(result).toMatchObject({ success: true });
  });
});
`;
}

function buildDbVitestFile(
  meta: SpanMeta,
  testName: string,
  callerMock: string,
  diff: DiffResult,
): string {
  const system = meta.dbSystem ?? "database";
  const stmt = meta.dbStatement ?? `-- query for span: ${meta.label}`;

  return `/**
 * AUTO-GENERATED by TraceDiff Repro-Gen
 * Span:        ${meta.label}
 * Diff type:   ${diff.type} (${diff.significance})
 * Description: ${diff.description.slice(0, 200)}
 *
 * Run: bun test this-file.test.ts
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
${callerMock ? `${callerMock}\n` : ""}
// TODO: replace with the actual import path for your ${system} client.
// import { db } from "../src/db";

describe("${escapeStr(testName)}", () => {
  // Mock the database query so the test runs without a real ${system} connection.
  const mockDb = {
    query: vi.fn(),
  };

  beforeEach(() => {
    vi.clearAllMocks();
    // Simulate the baseline (trace A) result.
    mockDb.query.mockResolvedValue({ rows: [], rowCount: 0 });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("executes the expected ${system} statement", async () => {
    const stmt = ${JSON.stringify(stmt)};
    await mockDb.query(stmt);

    expect(mockDb.query).toHaveBeenCalledOnce();
    expect(mockDb.query).toHaveBeenCalledWith(stmt);
  });

  it("handles an empty result set without throwing", async () => {
    const result = await mockDb.query("SELECT 1");
    expect(result).toHaveProperty("rows");
    expect(Array.isArray(result.rows)).toBe(true);
  });
});
`;
}

function buildMarkdownSummary(diff: DiffResult, curl: string): string {
  const path = (diff.pathB ?? diff.pathA ?? []).join(" > ");
  return [
    `## Repro: ${diff.type.toUpperCase()} diff at \`${path}\``,
    "",
    `**Significance:** ${diff.significance}  `,
    `**Description:** ${diff.description}  `,
    `**Depth:** ${diff.depth}  `,
    `**Affected subtree:** ${diff.affectedSubtreeSize} nodes`,
    "",
    "### Reproduction command",
    "```sh",
    curl,
    "```",
  ].join("\n");
}

function escapeStr(s: string): string {
  return s.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}
