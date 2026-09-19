import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { TraceNode } from "../core/type.js";

/**
 * 32-bit Mulberry32 seeded pseudo-random number generator.
 * Guarantees completely deterministic trace generation given the same seed.
 */
export class SeededRandom {
  private state: number;

  constructor(seed: number) {
    this.state = seed >>> 0;
  }

  /** Returns pseudo-random float in [0, 1). */
  next(): number {
    this.state = (this.state + 0x6d2b79f5) >>> 0;
    let t = this.state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }

  /** Returns pseudo-random integer in [min, max] inclusive. */
  nextInt(min: number, max: number): number {
    return Math.floor(this.next() * (max - min + 1)) + min;
  }

  /** Returns a randomly chosen item from the array. */
  choice<T>(items: readonly T[]): T {
    return items[Math.floor(this.next() * items.length)];
  }

  /** Returns true with the given probability (default 0.5). */
  boolean(prob = 0.5): boolean {
    return this.next() < prob;
  }

  /** Generates a pseudo-random UUIDv4-like string. */
  uuid(): string {
    const hex = "0123456789abcdef";
    let out = "";
    for (let i = 0; i < 32; i++) {
      if (i === 8 || i === 12 || i === 16 || i === 20) {
        out += "-";
      }
      out += hex[this.nextInt(0, 15)];
    }
    return out;
  }

  /** Generates a pseudo-random hex string of the specified length. */
  hex(length: number): string {
    const hex = "0123456789abcdef";
    let out = "";
    for (let i = 0; i < length; i++) {
      out += hex[this.nextInt(0, 15)];
    }
    return out;
  }
}

export interface GeneratorOptions {
  size?: number;
  diffs?: number;
  output?: string;
  seed?: number;
}

export interface ExpectedSemanticDiff {
  type: "added" | "removed" | "modified";
  path: string;
  nodeId: string;
  field?: string;
  before?: unknown;
  after?: unknown;
  details: string;
}

export interface ExpectedDiffsFile {
  generator: {
    size: number;
    diffs: number;
    seed: number;
    generatedAt: string;
  };
  summary: {
    totalNodesTraceA: number;
    totalNodesTraceB: number;
    semanticDiffsCount: number;
    noiseDiffsCount: number;
  };
  semantic: ExpectedSemanticDiff[];
}

export interface GenerationResult {
  traceA: TraceNode;
  traceB: TraceNode;
  expectedDiffs: ExpectedDiffsFile;
  stats: {
    nodesA: number;
    nodesB: number;
    semanticCount: number;
    noiseCount: number;
  };
}

interface ServiceTemplate {
  name: string;
  operations: Array<{
    type: "span" | "call" | "log" | "state_change" | "parallel";
    label: string;
    attributes: (rng: SeededRandom) => Record<string, unknown>;
  }>;
}

const SERVICE_TEMPLATES: ServiceTemplate[] = [
  {
    name: "auth",
    operations: [
      {
        type: "span",
        label: "authenticate_request",
        attributes: (rng) => ({
          "auth.mechanism": "bearer_jwt",
          "auth.valid": true,
          "user.id": `user_${rng.nextInt(1000, 9999)}`,
          duration_ms: rng.nextInt(5, 30),
        }),
      },
      {
        type: "call",
        label: "jwt_verify_signature",
        attributes: (rng) => ({
          algorithm: "RS256",
          key_id: `key_${rng.hex(8)}`,
          duration_ms: rng.nextInt(2, 10),
        }),
      },
      {
        type: "call",
        label: "rbac_policy_eval",
        attributes: (rng) => ({
          required_role: rng.choice(["admin", "shopper", "viewer", "editor"]),
          has_role: true,
          duration_ms: rng.nextInt(1, 5),
        }),
      },
    ],
  },
  {
    name: "database",
    operations: [
      {
        type: "call",
        label: "pg_query_execute",
        attributes: (rng) => ({
          "db.system": "postgresql",
          "db.statement": rng.choice([
            "SELECT * FROM accounts WHERE id = $1",
            "SELECT stock FROM inventory WHERE sku = $1 FOR UPDATE",
            "INSERT INTO audit_log (action, user_id) VALUES ($1, $2)",
            "UPDATE orders SET status = $1 WHERE id = $2",
          ]),
          "db.rows_affected": rng.nextInt(1, 5),
          duration_ms: rng.nextInt(4, 45),
        }),
      },
      {
        type: "call",
        label: "redis_cache_lookup",
        attributes: (rng) => ({
          "db.system": "redis",
          "cache.key": `session:${rng.hex(12)}`,
          "cache.hit": rng.boolean(0.8),
          duration_ms: rng.nextInt(1, 4),
        }),
      },
      {
        type: "call",
        label: "pg_tx_commit",
        attributes: (rng) => ({
          "db.system": "postgresql",
          "tx.isolation": "read_committed",
          duration_ms: rng.nextInt(2, 8),
        }),
      },
    ],
  },
  {
    name: "payment",
    operations: [
      {
        type: "span",
        label: "payment_process",
        attributes: (rng) => ({
          "payment.provider": rng.choice(["stripe", "adyen", "paypal"]),
          "payment.amount_cents": rng.nextInt(999, 99999),
          "payment.currency": "usd",
          duration_ms: rng.nextInt(40, 180),
        }),
      },
      {
        type: "call",
        label: "stripe_charge_create",
        attributes: (rng) => ({
          "http.status_code": 200,
          "charge.id": `ch_${rng.hex(16)}`,
          duration_ms: rng.nextInt(35, 120),
        }),
      },
      {
        type: "call",
        label: "fraud_eval_score",
        attributes: (rng) => ({
          risk_score: rng.nextInt(1, 25),
          action: "approve",
          duration_ms: rng.nextInt(10, 30),
        }),
      },
    ],
  },
  {
    name: "worker",
    operations: [
      {
        type: "parallel",
        label: "parallel_batch_dispatch",
        attributes: (rng) => ({
          batch_id: `batch_${rng.hex(8)}`,
          concurrency: rng.nextInt(2, 5),
          duration_ms: rng.nextInt(20, 90),
        }),
      },
      {
        type: "call",
        label: "sqs_message_publish",
        attributes: (rng) => ({
          "queue.name": "order-fulfillment-tasks",
          message_id: rng.uuid(),
          duration_ms: rng.nextInt(8, 25),
        }),
      },
      {
        type: "call",
        label: "s3_upload_payload",
        attributes: (rng) => ({
          "s3.bucket": "tracediff-records",
          "s3.key": `data/${rng.hex(16)}.json`,
          duration_ms: rng.nextInt(15, 60),
        }),
      },
    ],
  },
  {
    name: "logging",
    operations: [
      {
        type: "log",
        label: "audit_record_written",
        attributes: (rng) => ({
          level: "INFO",
          message: `Operation completed for resource_${rng.nextInt(100, 999)}`,
          logger: "audit.service",
          duration_ms: rng.nextInt(1, 5),
        }),
      },
      {
        type: "log",
        label: "metrics_summary_flush",
        attributes: (rng) => ({
          level: "INFO",
          metrics_flushed: rng.nextInt(5, 50),
          duration_ms: rng.nextInt(1, 3),
        }),
      },
    ],
  },
  {
    name: "state",
    operations: [
      {
        type: "state_change",
        label: "order_state_transition",
        attributes: (rng) => ({
          from_state: "PENDING",
          to_state: "CONFIRMED",
          transition_id: `trn_${rng.hex(8)}`,
          duration_ms: rng.nextInt(2, 6),
        }),
      },
    ],
  },
];

/**
 * Generates a valid TraceNode tree with exactly `requestedSize` nodes in O(N) time.
 */
export function generateBaselineTrace(requestedSize: number, rng: SeededRandom): TraceNode {
  const baseTimestamp = 1773820000000;
  let counter = 1;

  // Create root node
  const root: TraceNode = {
    id: `req-root-${String(counter).padStart(5, "0")}`,
    type: "span",
    label: "POST /api/v1/checkout",
    attributes: {
      "http.method": "POST",
      "http.route": "/api/v1/checkout",
      "http.status_code": 200,
      "user.id": `user_${rng.nextInt(1000, 9999)}`,
      request_id: rng.uuid(),
      timestamp: baseTimestamp,
      duration_ms: rng.nextInt(100, 300),
    },
    children: [],
  };

  if (requestedSize <= 1) {
    return root;
  }

  // FIFO frontier queue for expanding children in a realistic hierarchical tree
  const queue: TraceNode[] = [root];
  const allNodes: TraceNode[] = [root];

  while (counter < requestedSize && queue.length > 0) {
    const parent = queue.shift() as TraceNode;
    const remaining = requestedSize - counter;

    // Realistic branching factor between 2 and 5 children
    const branchFactor = Math.min(rng.nextInt(2, 5), remaining);

    for (let b = 0; b < branchFactor; b++) {
      counter++;
      const service = rng.choice(SERVICE_TEMPLATES);
      const op = rng.choice(service.operations);

      const childAttrs = op.attributes(rng);
      childAttrs.timestamp = baseTimestamp + counter * 10 + rng.nextInt(0, 5);

      const child: TraceNode = {
        id: `${op.type}-${service.name}-${String(counter).padStart(5, "0")}`,
        type: op.type,
        label: op.label,
        attributes: childAttrs,
        children: [],
      };

      parent.children.push(child);
      allNodes.push(child);

      // Spans, parallel blocks, and state nodes can have children
      if (op.type === "span" || op.type === "parallel") {
        queue.push(child);
      }
    }
  }

  // If frontier exhausted before reaching exact requested size, attach to existing span nodes
  while (counter < requestedSize) {
    counter++;
    const targetParent = rng.choice(allNodes);
    const service = rng.choice(SERVICE_TEMPLATES);
    const op = rng.choice(service.operations);

    const childAttrs = op.attributes(rng);
    childAttrs.timestamp = baseTimestamp + counter * 10 + rng.nextInt(0, 5);

    const child: TraceNode = {
      id: `${op.type}-${service.name}-${String(counter).padStart(5, "0")}`,
      type: op.type,
      label: op.label,
      attributes: childAttrs,
      children: [],
    };

    targetParent.children.push(child);
    allNodes.push(child);
  }

  return root;
}

/**
 * Counts total nodes in a trace tree in O(N).
 */
export function countNodes(root: TraceNode): number {
  let count = 0;
  const stack = [root];
  while (stack.length > 0) {
    const node = stack.pop() as TraceNode;
    count++;
    for (const child of node.children) {
      stack.push(child);
    }
  }
  return count;
}

/**
 * Deep-clones a TraceNode tree in O(N) time.
 */
export function cloneTrace(node: TraceNode): TraceNode {
  return {
    id: node.id,
    type: node.type,
    label: node.label,
    attributes: { ...node.attributes },
    children: node.children.map(cloneTrace),
    ...(node.depth !== undefined ? { depth: node.depth } : {}),
    ...(node.subtreeSize !== undefined ? { subtreeSize: node.subtreeSize } : {}),
  };
}

interface NodeLocation {
  node: TraceNode;
  parent: TraceNode | null;
  path: string[];
}

/**
 * Collects all nodes in tree along with their ancestry path and parent reference.
 */
function collectNodeLocations(root: TraceNode): NodeLocation[] {
  const locations: NodeLocation[] = [];
  const stack: Array<{ node: TraceNode; parent: TraceNode | null; path: string[] }> = [
    { node: root, parent: null, path: [root.label] },
  ];

  while (stack.length > 0) {
    const item = stack.pop() as { node: TraceNode; parent: TraceNode | null; path: string[] };
    locations.push(item);
    for (const child of item.node.children) {
      stack.push({
        node: child,
        parent: item.node,
        path: [...item.path, child.label],
      });
    }
  }

  return locations;
}

/**
 * Injects harmless noise changes into Trace B that normalization rules ignore:
 * 1. Shift timestamps (handled by ignore-timestamps rule)
 * 2. Rotate random IDs / UUIDs (handled by canonicalize-ids rule)
 * 3. Small numeric variations within 5% tolerance (handled by numeric-tolerance rule)
 * 4. Permute child ordering for concurrent/parallel spans (handled by sort-concurrent rule)
 */
function injectNoiseChanges(root: TraceNode, rng: SeededRandom): number {
  let noiseCount = 0;
  const timestampShift = rng.nextInt(500, 5000);
  const stack: TraceNode[] = [root];

  while (stack.length > 0) {
    const node = stack.pop() as TraceNode;

    // 1. Shift timestamp attributes
    if (typeof node.attributes.timestamp === "number") {
      const jitter = rng.nextInt(-10, 10);
      node.attributes.timestamp = node.attributes.timestamp + timestampShift + jitter;
      noiseCount++;
    }

    // 2. Rotate random IDs and UUIDs
    if (typeof node.attributes.request_id === "string") {
      node.attributes.request_id = rng.uuid();
      noiseCount++;
    }
    if (typeof node.attributes.message_id === "string") {
      node.attributes.message_id = rng.uuid();
      noiseCount++;
    }
    if (typeof node.attributes["charge.id"] === "string") {
      node.attributes["charge.id"] = `ch_${rng.hex(16)}`;
      noiseCount++;
    }
    if (typeof node.attributes.key_id === "string") {
      node.attributes.key_id = `key_${rng.hex(8)}`;
      noiseCount++;
    }

    // 3. Small numeric jitter within tolerance (±1% to 3%, well below the 5% rule limit)
    if (typeof node.attributes.duration_ms === "number") {
      const orig = node.attributes.duration_ms;
      const jitterFactor = 1 + (rng.next() * 0.04 - 0.02); // 0.98 to 1.02 (+-2%)
      const jittered = Math.max(1, Math.round(orig * jitterFactor));
      if (jittered !== orig) {
        node.attributes.duration_ms = jittered;
        noiseCount++;
      }
    }

    // 4. Reorder concurrent / parallel children
    if ((node.type === "parallel" || node.children.length > 1) && rng.boolean(0.4)) {
      // Reverse children array as a harmless ordering variation
      node.children.reverse();
      noiseCount++;
    }

    for (const child of node.children) {
      stack.push(child);
    }
  }

  return noiseCount;
}

/**
 * Injects intentional semantic differences into Trace B and records them in expected_diffs.
 */
function injectSemanticChanges(
  root: TraceNode,
  diffCount: number,
  rng: SeededRandom,
): ExpectedSemanticDiff[] {
  if (diffCount <= 0) {
    return [];
  }

  const locations = collectNodeLocations(root);
  // Exclude root node to preserve top-level anchor
  const nonRootLocations = locations.filter((loc) => loc.parent !== null);

  // If tree has fewer non-root nodes than diffs requested, clamp
  const actualDiffsToInject = Math.min(diffCount, nonRootLocations.length);
  if (actualDiffsToInject <= 0) {
    return [];
  }

  // Deterministically shuffle candidate indices to pick distinct nodes
  const indices: number[] = nonRootLocations.map((_, i) => i);
  for (let i = indices.length - 1; i > 0; i--) {
    const j = rng.nextInt(0, i);
    const temp = indices[i];
    indices[i] = indices[j];
    indices[j] = temp;
  }

  const selectedTargets = indices.slice(0, actualDiffsToInject).map((i) => nonRootLocations[i]);
  const expectedDiffs: ExpectedSemanticDiff[] = [];
  let nextAddedCounter = 9000;

  for (let i = 0; i < selectedTargets.length; i++) {
    const loc = selectedTargets[i];
    const node = loc.node;
    const pathStr = loc.path.join("/");

    // Cycle through distinct semantic change categories
    const mutationKind = i % 6;

    if (mutationKind === 0) {
      // 1. HTTP Status Code failure (200 -> 500)
      const before = node.attributes["http.status_code"] ?? 200;
      const after = 500;
      node.attributes["http.status_code"] = after;
      expectedDiffs.push({
        type: "modified",
        path: pathStr,
        nodeId: node.id,
        field: "http.status_code",
        before,
        after,
        details: `HTTP status code changed from ${before} to ${after}`,
      });
    } else if (mutationKind === 1) {
      // 2. Large numeric change (far beyond 5% tolerance: 10x - 20x spike)
      const origDuration =
        typeof node.attributes.duration_ms === "number" ? node.attributes.duration_ms : 15;
      const spiked = origDuration * 20;
      node.attributes.duration_ms = spiked;
      expectedDiffs.push({
        type: "modified",
        path: pathStr,
        nodeId: node.id,
        field: "duration_ms",
        before: origDuration,
        after: spiked,
        details: `Latency spiked from ${origDuration}ms to ${spiked}ms (>1000% change)`,
      });
    } else if (mutationKind === 2) {
      // 3. Database rows affected drop to 0
      const before = node.attributes["db.rows_affected"] ?? 1;
      const after = 0;
      node.attributes["db.rows_affected"] = after;
      expectedDiffs.push({
        type: "modified",
        path: pathStr,
        nodeId: node.id,
        field: "db.rows_affected",
        before,
        after,
        details: `Database rows affected dropped from ${before} to ${after}`,
      });
    } else if (mutationKind === 3) {
      // 4. Meaningful attribute / error injection
      if (node.attributes.to_state) {
        const before = node.attributes.to_state;
        const after = "FAILED";
        node.attributes.to_state = after;
        expectedDiffs.push({
          type: "modified",
          path: pathStr,
          nodeId: node.id,
          field: "to_state",
          before,
          after,
          details: `State transition changed from ${before} to ${after}`,
        });
      } else {
        const before = node.attributes["auth.valid"] ?? null;
        const after = false;
        node.attributes["auth.valid"] = after;
        node.attributes.error = "authorization_denied";
        expectedDiffs.push({
          type: "modified",
          path: pathStr,
          nodeId: node.id,
          field: "auth.valid",
          before,
          after,
          details: "Authentication validity set to false with authorization_denied",
        });
      }
    } else if (mutationKind === 4) {
      // 5. Add a new subtree / node under this node
      nextAddedCounter++;
      const newChild: TraceNode = {
        id: `span-fallback-${nextAddedCounter}`,
        type: "span",
        label: "cache_miss_fallback_handler",
        attributes: {
          "fallback.reason": "primary_read_timeout",
          "fallback.executed": true,
          duration_ms: 45,
          timestamp: 1773820005000,
        },
        children: [
          {
            id: `call-cold-storage-${nextAddedCounter + 1}`,
            type: "call",
            label: "s3_read_cold_cache",
            attributes: {
              "s3.bucket": "cold-archive-tier",
              duration_ms: 38,
            },
            children: [],
          },
        ],
      };
      node.children.push(newChild);
      expectedDiffs.push({
        type: "added",
        path: `${pathStr}/${newChild.label}`,
        nodeId: newChild.id,
        details: `Added new fallback subtree ${newChild.label} with 1 child`,
      });
    } else {
      // 6. Remove a subtree / node if parent has multiple children
      const parent = loc.parent;
      if (parent && parent.children.length >= 2) {
        const removeIndex = parent.children.indexOf(node);
        if (removeIndex !== -1) {
          parent.children.splice(removeIndex, 1);
          expectedDiffs.push({
            type: "removed",
            path: pathStr,
            nodeId: node.id,
            details: `Removed node ${node.label} (${node.id}) from parent`,
          });
          continue;
        }
      }

      // Fallback if node cannot be removed: inject critical error attribute
      const before = node.attributes.error ?? null;
      const after = "service_unavailable_503";
      node.attributes.error = after;
      expectedDiffs.push({
        type: "modified",
        path: pathStr,
        nodeId: node.id,
        field: "error",
        before,
        after,
        details: `Error attribute set to ${after}`,
      });
    }
  }

  return expectedDiffs;
}

/**
 * Main trace generation function.
 * Produces baseline trace A, modified trace B with noise + semantic changes,
 * and expected_diffs ground truth.
 */
export function generateTraces(options: GeneratorOptions = {}): GenerationResult {
  const size = options.size ?? 1000;
  const diffs = options.diffs ?? 5;
  const seed = options.seed ?? 42;

  if (size <= 0 || !Number.isInteger(size)) {
    throw new Error(`Invalid size: ${size}. Size must be a positive integer.`);
  }

  if (diffs < 0 || !Number.isInteger(diffs)) {
    throw new Error(`Invalid diffs: ${diffs}. Diffs must be a non-negative integer.`);
  }

  if (diffs > Math.max(10, size)) {
    throw new Error(`Requested diffs (${diffs}) exceeds sensible maximum for size (${size}).`);
  }

  const rng = new SeededRandom(seed);

  // 1. Generate Trace A
  const traceA = generateBaselineTrace(size, rng);
  const nodesA = countNodes(traceA);

  // 2. Clone Trace A to create Trace B
  const traceB = cloneTrace(traceA);

  // 3. Inject harmless noise changes into Trace B
  const noiseCount = injectNoiseChanges(traceB, rng);

  // 4. Inject intentional semantic changes into Trace B
  const semanticDiffs = injectSemanticChanges(traceB, diffs, rng);
  const nodesB = countNodes(traceB);

  const expectedDiffs: ExpectedDiffsFile = {
    generator: {
      size,
      diffs: semanticDiffs.length,
      seed,
      generatedAt: new Date().toISOString(),
    },
    summary: {
      totalNodesTraceA: nodesA,
      totalNodesTraceB: nodesB,
      semanticDiffsCount: semanticDiffs.length,
      noiseDiffsCount: noiseCount,
    },
    semantic: semanticDiffs,
  };

  return {
    traceA,
    traceB,
    expectedDiffs,
    stats: {
      nodesA,
      nodesB,
      semanticCount: semanticDiffs.length,
      noiseCount,
    },
  };
}

/**
 * Writes generation result to output directory.
 */
export function writeTraces(
  result: GenerationResult,
  outputDir: string,
): { traceAPath: string; traceBPath: string; expectedDiffsPath: string } {
  if (!existsSync(outputDir)) {
    mkdirSync(outputDir, { recursive: true });
  }

  const traceAPath = join(outputDir, "trace_a.json");
  const traceBPath = join(outputDir, "trace_b.json");
  const expectedDiffsPath = join(outputDir, "expected_diffs.json");

  writeFileSync(traceAPath, `${JSON.stringify(result.traceA, null, 2)}\n`, "utf8");
  writeFileSync(traceBPath, `${JSON.stringify(result.traceB, null, 2)}\n`, "utf8");
  writeFileSync(expectedDiffsPath, `${JSON.stringify(result.expectedDiffs, null, 2)}\n`, "utf8");

  return { traceAPath, traceBPath, expectedDiffsPath };
}

/**
 * Parses CLI arguments.
 */
export function parseArgs(args: string[]): GeneratorOptions & { help?: boolean } {
  const options: GeneratorOptions & { help?: boolean } = {};

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];

    if (arg === "--help" || arg === "-h") {
      options.help = true;
    } else if (arg === "--size" || arg === "-s") {
      const val = args[++i];
      if (!val) throw new Error("Missing value for --size");
      options.size = Number.parseInt(val, 10);
    } else if (arg.startsWith("--size=")) {
      options.size = Number.parseInt(arg.slice(7), 10);
    } else if (arg === "--diffs" || arg === "-d") {
      const val = args[++i];
      if (!val) throw new Error("Missing value for --diffs");
      options.diffs = Number.parseInt(val, 10);
    } else if (arg.startsWith("--diffs=")) {
      options.diffs = Number.parseInt(arg.slice(8), 10);
    } else if (arg === "--output" || arg === "-o") {
      const val = args[++i];
      if (!val) throw new Error("Missing value for --output");
      options.output = val;
    } else if (arg.startsWith("--output=")) {
      options.output = arg.slice(9);
    } else if (arg === "--seed") {
      const val = args[++i];
      if (!val) throw new Error("Missing value for --seed");
      options.seed = Number.parseInt(val, 10);
    } else if (arg.startsWith("--seed=")) {
      options.seed = Number.parseInt(arg.slice(7), 10);
    }
  }

  return options;
}

/**
 * CLI entry point when executed directly via Bun.
 */
function runCli() {
  const rawArgs = process.argv.slice(2);
  const options = parseArgs(rawArgs);

  if (options.help) {
    process.stdout.write(`TraceDiff Synthetic Trace Generator

Usage:
  bun run src/bench/generate.ts [options]

Options:
  --size <number>       Number of nodes/spans to generate (default: 1000)
  --diffs <number>      Number of intentional semantic differences (default: 5)
  --output <directory>  Output directory to save trace_a.json, trace_b.json, expected_diffs.json
  --seed <number>       Deterministic random seed (default: 42)
  -h, --help            Show this help message

Example:
  bun run src/bench/generate.ts --size 1000 --diffs 5 --output fixtures/demo/
\n`);
    return;
  }

  const size = options.size ?? 1000;
  const diffs = options.diffs ?? 5;
  const outputDir = options.output ?? "fixtures/demo";
  const seed = options.seed ?? 42;

  const result = generateTraces({ size, diffs, seed, output: outputDir });
  const written = writeTraces(result, outputDir);

  process.stdout.write(`Generated TraceDiff fixtures
----------------------------
Nodes: ${result.stats.nodesA}
Semantic changes: ${result.stats.semanticCount}
Noise changes: ${result.stats.noiseCount}
Output:
  ${written.traceAPath}
  ${written.traceBPath}
  ${written.expectedDiffsPath}\n`);
}

// Execute when invoked directly
if (import.meta.main) {
  try {
    runCli();
  } catch (err: unknown) {
    process.stderr.write(`Error: ${err instanceof Error ? err.message : String(err)}\n`);
    process.exit(1);
  }
}
