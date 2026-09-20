import type { TraceNode } from "../core/type.js";

/**
 * Price Table Version & Provenance Metadata
 * All rates based on AWS US-East-1 on-demand public list prices (March 2026).
 */
export const PRICE_TABLE_VERSION = "AWS-2026.03.1";
export const PRICE_TABLE_EFFECTIVE_DATE = "2026-03-01";
export const PRICE_TABLE_SOURCE = "AWS Public On-Demand Pricing (us-east-1, March 2026)";

export const FINOPS_DISCLAIMER =
  "Figures are architectural cost estimates computed from span attributes and assumed defaults (memory, RCU/WCU, token counts where traces do not record them). They represent relative cost impact modeling, not metered billing invoices.";

// Default assumptions when attributes are omitted
export const DEFAULT_ASSUMED_LAMBDA_MEMORY_MB = 512;
export const DEFAULT_ASSUMED_DYNAMODB_RCU = 1.0;
export const DEFAULT_ASSUMED_DYNAMODB_WCU = 1.0;

// On-Demand Price Constants (USD)
export const PRICING = {
  // Compute (AWS Lambda)
  lambdaGbSecond: 0.0000166667, // $0.0600 per GB-hour
  lambdaInvocation: 0.0000002, // $0.20 per 1M requests

  // Database (AWS DynamoDB On-Demand)
  dynamoDbRcu: 0.00000025, // $0.25 per 1M read units (up to 4KB)
  dynamoDbWcu: 0.00000125, // $1.25 per 1M write units (up to 1KB)
  genericDbQuery: 0.0000005, // Baseline relational query overhead

  // Storage (AWS S3 Standard)
  s3GetRequest: 0.0000004, // $0.0004 per 1,000 requests (GET, HEAD)
  s3PutRequest: 0.000005, // $0.0050 per 1,000 requests (PUT, POST)

  // Messaging (AWS SQS Standard)
  sqsRequest: 0.0000004, // $0.40 per 1M requests

  // LLM / GenAI (OpenAI / Claude standard blended average)
  llmInputToken: 0.0000025, // $2.50 per 1M prompt tokens ($0.0025 / 1k)
  llmOutputToken: 0.00001, // $10.00 per 1M completion tokens ($0.0100 / 1k)
} as const;

export interface CostCategories {
  computeUsd: number;
  databaseUsd: number;
  storageUsd: number;
  llmUsd: number;
}

export interface NodeCostBreakdown {
  nodeId: string;
  label: string;
  categories: CostCategories;
  totalUsd: number;
  details: string[];
}

export interface TraceCostBreakdown {
  totalCostUsd: number;
  categories: CostCategories;
  nodeCount: number;
  costSpansCount: number;
  nodeCosts: Map<string, NodeCostBreakdown>;
}

export interface CostDriver {
  nodeId: string;
  label: string;
  path: string;
  baselineUsd: number;
  targetUsd: number;
  deltaUsd: number;
  reason: string;
}

export interface RemediationAdvice {
  patternId:
    | "n_plus_one_storm"
    | "full_table_scan"
    | "over_provisioned_compute"
    | "cold_storage_miss"
    | "llm_token_inflation"
    | "short_polling_waste"
    | "unbounded_retries";
  patternName: string;
  affectedSpanId: string;
  affectedSpanLabel: string;
  path: string;
  actionableFix: string;
  potentialMonthlySavingsUsd: number;
  codeSnippet: string;
}

export interface FinOpsDiffResult {
  baselineCostUsd: number;
  targetCostUsd: number;
  deltaUsd: number;
  percentageChange: number;
  projectedMonthlyUsd: number;
  requestsPerMonth: number;
  categories: {
    baseline: CostCategories;
    target: CostCategories;
    delta: CostCategories;
  };
  topCostDrivers: CostDriver[];
  remediations: RemediationAdvice[];
  priceTableVersion: string;
  disclaimer: string;
  evalDurationMs: number;
}

/**
 * Calculates the architectural micro-cost of a single trace node based on its attributes.
 * Pure, deterministic function with no side-effects.
 */
export function calculateNodeCost(node: TraceNode): NodeCostBreakdown {
  const attrs = node.attributes || {};
  const details: string[] = [];
  const categories: CostCategories = {
    computeUsd: 0,
    databaseUsd: 0,
    storageUsd: 0,
    llmUsd: 0,
  };

  // 1. Compute Cost (Execution Duration in milliseconds)
  const durationMs =
    typeof attrs.duration_ms === "number"
      ? attrs.duration_ms
      : typeof attrs["duration.ms"] === "number"
        ? attrs["duration.ms"]
        : typeof attrs.duration === "number"
          ? attrs.duration
          : 0;

  if (durationMs > 0) {
    const memoryMb =
      typeof attrs["faas.memory_mb"] === "number"
        ? attrs["faas.memory_mb"]
        : typeof attrs.memory_mb === "number"
          ? attrs.memory_mb
          : DEFAULT_ASSUMED_LAMBDA_MEMORY_MB;

    const gbSeconds = (durationMs / 1000) * (memoryMb / 1024);
    const computeCost = gbSeconds * PRICING.lambdaGbSecond;
    categories.computeUsd += computeCost;
    details.push(
      `Compute: ${durationMs.toFixed(1)}ms @ ${memoryMb}MB ($${computeCost.toFixed(8)})`,
    );
  }

  // 2. Database Cost (DynamoDB & relational queries)
  const dbSystem = String(attrs["db.system"] || "").toLowerCase();
  const dbOperation = String(attrs["db.operation"] || "").toLowerCase();
  const label = String(node.label || "").toLowerCase();

  if (dbSystem === "dynamodb" || label.includes("dynamodb")) {
    const isWrite =
      dbOperation.includes("put") ||
      dbOperation.includes("update") ||
      dbOperation.includes("delete") ||
      dbOperation.includes("write");

    if (isWrite) {
      const wcu =
        typeof attrs["aws.dynamodb.consumed_wcu"] === "number"
          ? attrs["aws.dynamodb.consumed_wcu"]
          : DEFAULT_ASSUMED_DYNAMODB_WCU;
      const cost = wcu * PRICING.dynamoDbWcu;
      categories.databaseUsd += cost;
      details.push(`DynamoDB Write: ${wcu} WCU ($${cost.toFixed(8)})`);
    } else {
      const rcu =
        typeof attrs["aws.dynamodb.consumed_rcu"] === "number"
          ? attrs["aws.dynamodb.consumed_rcu"]
          : DEFAULT_ASSUMED_DYNAMODB_RCU;
      const cost = rcu * PRICING.dynamoDbRcu;
      categories.databaseUsd += cost;
      details.push(`DynamoDB Read: ${rcu} RCU ($${cost.toFixed(8)})`);
    }
  } else if (dbSystem.length > 0 || attrs["db.statement"]) {
    // Relational or generic database query
    categories.databaseUsd += PRICING.genericDbQuery;
    details.push(`DB Query: ${dbSystem || "generic"} ($${PRICING.genericDbQuery.toFixed(8)})`);
  }

  // 3. Storage Cost (AWS S3)
  const rpcService = String(attrs["rpc.service"] || attrs["aws.service"] || "").toLowerCase();
  if (rpcService === "s3" || label.includes("s3")) {
    const isWrite =
      dbOperation.includes("put") ||
      dbOperation.includes("upload") ||
      label.includes("put") ||
      label.includes("upload");

    const cost = isWrite ? PRICING.s3PutRequest : PRICING.s3GetRequest;
    categories.storageUsd += cost;
    details.push(`S3 ${isWrite ? "Put" : "Get"}: ($${cost.toFixed(8)})`);
  }

  // 4. Messaging Cost (AWS SQS)
  const msgSystem = String(attrs["messaging.system"] || "").toLowerCase();
  if (msgSystem === "sqs" || label.includes("sqs")) {
    categories.computeUsd += PRICING.sqsRequest;
    details.push(`SQS Request: ($${PRICING.sqsRequest.toFixed(8)})`);
  }

  // 5. LLM / GenAI Token Cost
  const promptTokens =
    typeof attrs["gen_ai.usage.prompt_tokens"] === "number"
      ? attrs["gen_ai.usage.prompt_tokens"]
      : typeof attrs.prompt_tokens === "number"
        ? attrs.prompt_tokens
        : 0;

  const completionTokens =
    typeof attrs["gen_ai.usage.completion_tokens"] === "number"
      ? attrs["gen_ai.usage.completion_tokens"]
      : typeof attrs.completion_tokens === "number"
        ? attrs.completion_tokens
        : 0;

  if (promptTokens > 0 || completionTokens > 0) {
    const llmCost =
      promptTokens * PRICING.llmInputToken + completionTokens * PRICING.llmOutputToken;
    categories.llmUsd += llmCost;
    details.push(
      `LLM Tokens: ${promptTokens} in / ${completionTokens} out ($${llmCost.toFixed(6)})`,
    );
  }

  const totalUsd =
    categories.computeUsd + categories.databaseUsd + categories.storageUsd + categories.llmUsd;

  return {
    nodeId: node.id,
    label: node.label,
    categories,
    totalUsd,
    details,
  };
}

/**
 * Calculates total cost and category breakdown of a full trace tree.
 * Uses an ITERATIVE EXPLICIT-STACK traversal to guarantee no call stack recursion limits.
 */
export function calculateTraceCost(root: TraceNode): TraceCostBreakdown {
  const categories: CostCategories = {
    computeUsd: 0,
    databaseUsd: 0,
    storageUsd: 0,
    llmUsd: 0,
  };

  const nodeCosts = new Map<string, NodeCostBreakdown>();
  let totalCostUsd = 0;
  let nodeCount = 0;
  let costSpansCount = 0;

  // Explicit stack for iterative traversal (no recursion)
  const stack: TraceNode[] = [root];

  while (stack.length > 0) {
    const node = stack.pop();
    if (!node) continue;

    nodeCount++;
    const nodeCost = calculateNodeCost(node);

    if (nodeCost.totalUsd > 0) {
      costSpansCount++;
      totalCostUsd += nodeCost.totalUsd;
      categories.computeUsd += nodeCost.categories.computeUsd;
      categories.databaseUsd += nodeCost.categories.databaseUsd;
      categories.storageUsd += nodeCost.categories.storageUsd;
      categories.llmUsd += nodeCost.categories.llmUsd;
      nodeCosts.set(node.id, nodeCost);
    }

    const children = node.children || [];
    for (let i = children.length - 1; i >= 0; i--) {
      stack.push(children[i]);
    }
  }

  return {
    totalCostUsd,
    categories,
    nodeCount,
    costSpansCount,
    nodeCosts,
  };
}

/**
 * Compares the FinOps micro-costs of Trace A vs Trace B.
 * Identifies dollar delta, percentage shift, monthly extrapolation, and top cost drivers.
 * Uses explicit-stack traversal for path tracking.
 */
export function diffTraceCosts(
  rootA: TraceNode,
  rootB: TraceNode,
  requestsPerMonth = 10_000_000,
): FinOpsDiffResult {
  const startTime = performance.now();

  const costA = calculateTraceCost(rootA);
  const costB = calculateTraceCost(rootB);

  const baselineCostUsd = costA.totalCostUsd;
  const targetCostUsd = costB.totalCostUsd;
  const deltaUsd = targetCostUsd - baselineCostUsd;

  const percentageChange =
    baselineCostUsd === 0 ? (targetCostUsd === 0 ? 0 : 100) : (deltaUsd / baselineCostUsd) * 100;

  const projectedMonthlyUsd = deltaUsd * requestsPerMonth;

  // Category deltas
  const categories = {
    baseline: costA.categories,
    target: costB.categories,
    delta: {
      computeUsd: costB.categories.computeUsd - costA.categories.computeUsd,
      databaseUsd: costB.categories.databaseUsd - costA.categories.databaseUsd,
      storageUsd: costB.categories.storageUsd - costA.categories.storageUsd,
      llmUsd: costB.categories.llmUsd - costA.categories.llmUsd,
    },
  };

  // Find Top Cost Drivers via iterative traversal of B with path tracking
  const nodePathsB = new Map<string, string>();
  const stackB: { node: TraceNode; path: string[] }[] = [
    { node: rootB, path: [rootB.label || rootB.id] },
  ];

  while (stackB.length > 0) {
    const item = stackB.pop();
    if (!item) continue;
    const { node, path } = item;
    nodePathsB.set(node.id, path.join(" > "));

    const children = node.children || [];
    for (let i = children.length - 1; i >= 0; i--) {
      const child = children[i];
      stackB.push({ node: child, path: [...path, child.label || child.id] });
    }
  }

  const drivers: CostDriver[] = [];

  // Check all nodes in target trace B for positive cost impact
  for (const [id, costDetailB] of costB.nodeCosts.entries()) {
    const costDetailA = costA.nodeCosts.get(id);
    const aCost = costDetailA ? costDetailA.totalUsd : 0;
    const bCost = costDetailB.totalUsd;
    const nodeDelta = bCost - aCost;

    if (Math.abs(nodeDelta) > 0.00000001) {
      drivers.push({
        nodeId: id,
        label: costDetailB.label,
        path: nodePathsB.get(id) || costDetailB.label,
        baselineUsd: aCost,
        targetUsd: bCost,
        deltaUsd: nodeDelta,
        reason: costDetailB.details.join("; ") || "Increased span duration/operations",
      });
    }
  }

  // Also check if any nodes in A were removed in B (cost reduction)
  for (const [id, costDetailA] of costA.nodeCosts.entries()) {
    if (!costB.nodeCosts.has(id)) {
      drivers.push({
        nodeId: id,
        label: costDetailA.label,
        path: costDetailA.label,
        baselineUsd: costDetailA.totalUsd,
        targetUsd: 0,
        deltaUsd: -costDetailA.totalUsd,
        reason: "Removed span",
      });
    }
  }

  // Sort drivers by largest positive delta first (most expensive regressions)
  drivers.sort((x, y) => y.deltaUsd - x.deltaUsd);

  const topCostDrivers = drivers.slice(0, 5);
  const candidateDrivers = drivers.filter((d) => d.deltaUsd > 0).slice(0, 10);
  const remediations = generateRemediations(candidateDrivers, rootB, requestsPerMonth);

  const evalDurationMs = performance.now() - startTime;

  return {
    baselineCostUsd,
    targetCostUsd,
    deltaUsd,
    percentageChange,
    projectedMonthlyUsd,
    requestsPerMonth,
    categories,
    topCostDrivers,
    remediations,
    priceTableVersion: PRICE_TABLE_VERSION,
    disclaimer: FINOPS_DISCLAIMER,
    evalDurationMs,
  };
}

/**
 * Prescriptive Remediation Advisor — 7 Cloud Optimization Patterns
 * Evaluates cost drivers against enterprise cloud architecture heuristics.
 * Pure function, iterative traversal, zero recursion.
 */
export function generateRemediations(
  drivers: CostDriver[],
  rootB: TraceNode,
  requestsPerMonth = 10_000_000,
): RemediationAdvice[] {
  // Index all nodes in B iteratively (no recursion)
  const nodeMapB = new Map<string, TraceNode>();
  const parentMapB = new Map<string, TraceNode>();
  const stack: { node: TraceNode; parent?: TraceNode }[] = [{ node: rootB }];

  while (stack.length > 0) {
    const item = stack.pop();
    if (!item) continue;
    const { node, parent } = item;
    nodeMapB.set(node.id, node);
    if (parent) parentMapB.set(node.id, parent);

    const children = node.children || [];
    for (let i = children.length - 1; i >= 0; i--) {
      stack.push({ node: children[i], parent: node });
    }
  }

  const remediations: RemediationAdvice[] = [];
  const seenSpans = new Set<string>();

  for (const driver of drivers) {
    if (driver.deltaUsd <= 0) continue;
    if (seenSpans.has(driver.nodeId)) continue;

    const node = nodeMapB.get(driver.nodeId);
    const attrs = node?.attributes || {};
    const label = (driver.label || "").toLowerCase();
    const reason = (driver.reason || "").toLowerCase();
    const parent = parentMapB.get(driver.nodeId);
    const parentChildren = parent?.children || [];

    // Pattern 1: Unbounded Cascading Retries
    const statusCode = Number(attrs["http.status_code"] || 0);
    if (label.includes("retry") || label.includes("error") || statusCode >= 500 || attrs.error) {
      const savings = Math.round(driver.deltaUsd * requestsPerMonth * 0.7 * 100) / 100;
      remediations.push({
        patternId: "unbounded_retries",
        patternName: "Unbounded Cascading Retries",
        affectedSpanId: driver.nodeId,
        affectedSpanLabel: driver.label,
        path: driver.path,
        actionableFix:
          "Implement exponential backoff with full jitter and a circuit breaker to avoid costly repeated downstream failures.",
        codeSnippet:
          "// Exponential backoff with jitter:\nconst backoff = Math.min(3000, 100 * Math.pow(2, attempt));\nawait new Promise(r => setTimeout(r, backoff * (0.5 + Math.random() * 0.5)));",
        potentialMonthlySavingsUsd: savings > 0 ? savings : 18.0,
      });
      seenSpans.add(driver.nodeId);
      continue;
    }

    // Pattern 2: Full Table Scan Waste
    const dbOp = String(attrs["db.operation"] || "").toLowerCase();
    if (
      dbOp.includes("scan") ||
      label.includes("scan") ||
      Number(attrs["aws.dynamodb.scanned_count"] || 0) > 10
    ) {
      const savings = Math.round(driver.deltaUsd * requestsPerMonth * 0.9 * 100) / 100;
      remediations.push({
        patternId: "full_table_scan",
        patternName: "Full Table Scan Waste",
        affectedSpanId: driver.nodeId,
        affectedSpanLabel: driver.label,
        path: driver.path,
        actionableFix:
          "Convert unindexed table Scan to targeted Query using a Global Secondary Index (GSI).",
        codeSnippet:
          "// Before: dynamodb.scan({ TableName: TABLE, FilterExpression: 'userId = :uid' });\n// After:  dynamodb.query({ TableName: TABLE, IndexName: 'userId-index', KeyConditionExpression: 'userId = :uid' });",
        potentialMonthlySavingsUsd: savings > 0 ? savings : 25.0,
      });
      seenSpans.add(driver.nodeId);
      continue;
    }

    // Pattern 3: N+1 API / Query Storm
    const isDbRead =
      reason.includes("dynamodb read") ||
      reason.includes("db query") ||
      attrs["db.system"] === "dynamodb";
    const siblingDbReads = parentChildren.filter(
      (c) =>
        c.attributes?.["db.system"] === "dynamodb" ||
        String(c.label || "")
          .toLowerCase()
          .includes("read") ||
        String(c.label || "")
          .toLowerCase()
          .includes("query") ||
        String(c.label || "")
          .toLowerCase()
          .includes("getitem"),
    ).length;

    if (isDbRead && siblingDbReads >= 2) {
      const savings = Math.round(driver.deltaUsd * requestsPerMonth * 0.85 * 100) / 100;
      remediations.push({
        patternId: "n_plus_one_storm",
        patternName: "N+1 API / Query Storm",
        affectedSpanId: driver.nodeId,
        affectedSpanLabel: driver.label,
        path: driver.path,
        actionableFix:
          "Consolidate iterative point queries into a single batch operation (BatchGetItem or query with IN clause).",
        potentialMonthlySavingsUsd: savings > 0 ? savings : 10.0,
        codeSnippet:
          "// Before: for (const id of ids) await dynamodb.getItem({ Key: { id } });\n// After:  await dynamodb.batchGetItem({ RequestItems: { [TABLE]: { Keys: ids.map(id => ({ id })) } } });",
      });
      seenSpans.add(driver.nodeId);
      continue;
    }

    // Pattern 4: Over-Provisioned Compute
    const duration = Number(attrs.duration_ms || attrs.duration || 0);
    const memory = Number(attrs["faas.memory_mb"] || attrs.memory_mb || 0);
    if (duration > 0 && duration < 60 && memory >= 1024) {
      const savings = Math.round(driver.deltaUsd * requestsPerMonth * 0.75 * 100) / 100;
      remediations.push({
        patternId: "over_provisioned_compute",
        patternName: "Over-Provisioned Compute",
        affectedSpanId: driver.nodeId,
        affectedSpanLabel: driver.label,
        path: driver.path,
        actionableFix: `Right-size Lambda memory from ${memory}MB down to 256MB. Fast I/O tasks do not benefit from surplus compute.`,
        codeSnippet:
          "# template.yaml / cdk configuration:\nMemorySize: 256  # Downsized from 1024MB (-75% GB-second billing)",
        potentialMonthlySavingsUsd: savings > 0 ? savings : 15.0,
      });
      seenSpans.add(driver.nodeId);
      continue;
    }

    // Pattern 5: Cold Storage Cache Miss
    const rpc = String(attrs["rpc.service"] || "").toLowerCase();
    const isS3Read =
      (rpc === "s3" || label.includes("s3") || label.includes("cold")) &&
      !label.includes("put") &&
      !label.includes("upload") &&
      !reason.includes("s3 put");

    if (isS3Read || reason.includes("s3 get")) {
      const savings = Math.round(driver.deltaUsd * requestsPerMonth * 0.9 * 100) / 100;
      remediations.push({
        patternId: "cold_storage_miss",
        patternName: "Cold Storage Cache Miss",
        affectedSpanId: driver.nodeId,
        affectedSpanLabel: driver.label,
        path: driver.path,
        actionableFix:
          "Introduce an in-memory or Redis read-through cache with a 1-hour TTL to eliminate recurring S3 GET requests.",
        codeSnippet:
          "const cached = await redis.get(cacheKey);\nif (!cached) {\n  const data = await s3.getObject({ Bucket, Key });\n  await redis.set(cacheKey, data, 'EX', 3600);\n}",
        potentialMonthlySavingsUsd: savings > 0 ? savings : 14.5,
      });
      seenSpans.add(driver.nodeId);
      continue;
    }

    // Pattern 6: Runaway LLM Token Inflation
    const promptTokens = Number(attrs["gen_ai.usage.prompt_tokens"] || attrs.prompt_tokens || 0);
    if (reason.includes("llm tokens") || promptTokens >= 2000) {
      const savings = Math.round(driver.deltaUsd * requestsPerMonth * 0.6 * 100) / 100;
      remediations.push({
        patternId: "llm_token_inflation",
        patternName: "Runaway LLM Token Inflation",
        affectedSpanId: driver.nodeId,
        affectedSpanLabel: driver.label,
        path: driver.path,
        actionableFix:
          "Implement sliding window context pruning or prompt compression to avoid re-sending bloated message history.",
        codeSnippet:
          "// Truncate chat history to recent messages:\nconst activeMessages = messages.slice(-6);\nawait openai.chat.completions.create({ messages: activeMessages });",
        potentialMonthlySavingsUsd: savings > 0 ? savings : 40.0,
      });
      seenSpans.add(driver.nodeId);
      continue;
    }

    // Pattern 7: Short-Polling Busy Waiting
    const msgSystem = String(attrs["messaging.system"] || "").toLowerCase();
    if (msgSystem === "sqs" || label.includes("sqs") || label.includes("poll")) {
      const savings = Math.round(driver.deltaUsd * requestsPerMonth * 0.85 * 100) / 100;
      remediations.push({
        patternId: "short_polling_waste",
        patternName: "Short-Polling Busy Waiting",
        affectedSpanId: driver.nodeId,
        affectedSpanLabel: driver.label,
        path: driver.path,
        actionableFix:
          "Enable SQS Long Polling (WaitTimeSeconds = 20) to eliminate charges from empty receive requests.",
        codeSnippet:
          "await sqs.receiveMessage({\n  QueueUrl: QUEUE_URL,\n  WaitTimeSeconds: 20,\n  MaxNumberOfMessages: 10\n});",
        potentialMonthlySavingsUsd: savings > 0 ? savings : 12.0,
      });
      seenSpans.add(driver.nodeId);
    }
  }

  // Sort remediations by potential monthly savings descending
  remediations.sort((a, b) => b.potentialMonthlySavingsUsd - a.potentialMonthlySavingsUsd);
  return remediations;
}
