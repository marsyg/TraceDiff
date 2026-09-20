import { describe, expect, test } from "bun:test";
import type { TraceNode } from "../src/core/type.js";
import {
  calculateNodeCost,
  calculateTraceCost,
  DEFAULT_ASSUMED_DYNAMODB_RCU,
  DEFAULT_ASSUMED_LAMBDA_MEMORY_MB,
  diffTraceCosts,
  FINOPS_DISCLAIMER,
  PRICE_TABLE_VERSION,
  PRICING,
} from "../src/finops/costEngine.js";

describe("FinOps Cost Engine — Node Cost Calculation", () => {
  test("computes zero cost for non-cloud spans with no duration", () => {
    const node: TraceNode = {
      id: "node-1",
      type: "span",
      label: "in_memory_op",
      attributes: {},
      children: [],
    };
    const cost = calculateNodeCost(node);
    expect(cost.totalUsd).toBe(0);
    expect(cost.categories.computeUsd).toBe(0);
    expect(cost.categories.databaseUsd).toBe(0);
    expect(cost.categories.storageUsd).toBe(0);
    expect(cost.categories.llmUsd).toBe(0);
  });

  test("calculates compute cost from duration_ms with default memory", () => {
    const node: TraceNode = {
      id: "node-2",
      type: "span",
      label: "handler",
      attributes: { duration_ms: 1000 }, // 1 second
      children: [],
    };
    const cost = calculateNodeCost(node);
    const expectedGbSec = 1.0 * (DEFAULT_ASSUMED_LAMBDA_MEMORY_MB / 1024);
    const expectedCost = expectedGbSec * PRICING.lambdaGbSecond;

    expect(cost.categories.computeUsd).toBeCloseTo(expectedCost, 8);
    expect(cost.totalUsd).toBeCloseTo(expectedCost, 8);
  });

  test("calculates compute cost with custom memory attribute", () => {
    const node: TraceNode = {
      id: "node-3",
      type: "span",
      label: "heavy_task",
      attributes: { duration_ms: 2000, "faas.memory_mb": 1024 }, // 2 seconds @ 1GB
      children: [],
    };
    const cost = calculateNodeCost(node);
    const expectedCost = 2.0 * 1.0 * PRICING.lambdaGbSecond;
    expect(cost.categories.computeUsd).toBeCloseTo(expectedCost, 8);
  });

  test("calculates DynamoDB read and write costs", () => {
    const readNode: TraceNode = {
      id: "db-read",
      type: "span",
      label: "getItem",
      attributes: { "db.system": "dynamodb", "db.operation": "GetItem" },
      children: [],
    };
    const readCost = calculateNodeCost(readNode);
    expect(readCost.categories.databaseUsd).toBe(
      DEFAULT_ASSUMED_DYNAMODB_RCU * PRICING.dynamoDbRcu,
    );

    const writeNode: TraceNode = {
      id: "db-write",
      type: "span",
      label: "putItem",
      attributes: {
        "db.system": "dynamodb",
        "db.operation": "PutItem",
        "aws.dynamodb.consumed_wcu": 5,
      },
      children: [],
    };
    const writeCost = calculateNodeCost(writeNode);
    expect(writeCost.categories.databaseUsd).toBe(5 * PRICING.dynamoDbWcu);
  });

  test("calculates S3 Get and Put request costs", () => {
    const getNode: TraceNode = {
      id: "s3-get",
      type: "span",
      label: "s3_read",
      attributes: { "rpc.service": "s3", "db.operation": "GetObject" },
      children: [],
    };
    expect(calculateNodeCost(getNode).categories.storageUsd).toBe(PRICING.s3GetRequest);

    const putNode: TraceNode = {
      id: "s3-put",
      type: "span",
      label: "s3_upload",
      attributes: { "rpc.service": "s3", "db.operation": "PutObject" },
      children: [],
    };
    expect(calculateNodeCost(putNode).categories.storageUsd).toBe(PRICING.s3PutRequest);
  });

  test("calculates LLM token usage cost", () => {
    const llmNode: TraceNode = {
      id: "llm-1",
      type: "span",
      label: "chat_completion",
      attributes: {
        "gen_ai.system": "openai",
        "gen_ai.usage.prompt_tokens": 1000,
        "gen_ai.usage.completion_tokens": 500,
      },
      children: [],
    };
    const cost = calculateNodeCost(llmNode);
    const expected = 1000 * PRICING.llmInputToken + 500 * PRICING.llmOutputToken;
    expect(cost.categories.llmUsd).toBeCloseTo(expected, 8);
    expect(cost.totalUsd).toBeCloseTo(expected, 8);
  });
});

describe("FinOps Cost Engine — Tree Cost Accumulation Across Nesting", () => {
  test("accurately accumulates cost across deeply nested trees iteratively", () => {
    // Build a 100-level deep linear tree
    let current: TraceNode = {
      id: "leaf",
      type: "span",
      label: "leaf_span",
      attributes: { "db.system": "dynamodb", "db.operation": "GetItem" },
      children: [],
    };

    for (let i = 99; i >= 1; i--) {
      current = {
        id: `node-${i}`,
        type: "span",
        label: `span_${i}`,
        attributes: { duration_ms: 10 },
        children: [current],
      };
    }

    const treeCost = calculateTraceCost(current);
    expect(treeCost.nodeCount).toBe(100);
    expect(treeCost.costSpansCount).toBe(100);
    expect(treeCost.categories.databaseUsd).toBe(PRICING.dynamoDbRcu);
    expect(treeCost.categories.computeUsd).toBeGreaterThan(0);
    expect(treeCost.totalCostUsd).toBe(
      treeCost.categories.computeUsd + treeCost.categories.databaseUsd,
    );
  });
});

describe("FinOps Cost Engine — Diff & Monthly Projections", () => {
  test("computes delta, percentage change, and monthly projection correctly", () => {
    const traceA: TraceNode = {
      id: "root-a",
      type: "span",
      label: "checkout",
      attributes: { duration_ms: 100 },
      children: [
        {
          id: "db-1",
          type: "span",
          label: "query_cart",
          attributes: { "db.system": "dynamodb", "db.operation": "GetItem" },
          children: [],
        },
      ],
    };

    const traceB: TraceNode = {
      id: "root-b",
      type: "span",
      label: "checkout",
      attributes: { duration_ms: 500 }, // +400ms duration
      children: [
        {
          id: "db-1",
          type: "span",
          label: "query_cart",
          attributes: { "db.system": "dynamodb", "db.operation": "GetItem" },
          children: [],
        },
        {
          id: "db-2",
          type: "span",
          label: "redundant_query",
          attributes: { "db.system": "dynamodb", "db.operation": "GetItem" },
          children: [],
        },
      ],
    };

    const diff = diffTraceCosts(traceA, traceB, 10_000_000);

    expect(diff.baselineCostUsd).toBeGreaterThan(0);
    expect(diff.targetCostUsd).toBeGreaterThan(diff.baselineCostUsd);
    expect(diff.deltaUsd).toBeCloseTo(diff.targetCostUsd - diff.baselineCostUsd, 10);
    expect(diff.percentageChange).toBeGreaterThan(0);
    expect(diff.projectedMonthlyUsd).toBeCloseTo(diff.deltaUsd * 10_000_000, 4);
    expect(diff.priceTableVersion).toBe(PRICE_TABLE_VERSION);
    expect(diff.disclaimer).toBe(FINOPS_DISCLAIMER);
    expect(diff.evalDurationMs).toBeGreaterThanOrEqual(0);
  });

  test("identifies top cost drivers accurately", () => {
    const traceA: TraceNode = {
      id: "root",
      type: "span",
      label: "app",
      attributes: {},
      children: [],
    };

    const traceB: TraceNode = {
      id: "root",
      type: "span",
      label: "app",
      attributes: {},
      children: [
        {
          id: "minor-diff",
          type: "span",
          label: "minor_span",
          attributes: { duration_ms: 5 },
          children: [],
        },
        {
          id: "major-diff",
          type: "span",
          label: "expensive_llm_call",
          attributes: {
            "gen_ai.system": "openai",
            "gen_ai.usage.prompt_tokens": 10000,
            "gen_ai.usage.completion_tokens": 2000,
          },
          children: [],
        },
      ],
    };

    const diff = diffTraceCosts(traceA, traceB);
    expect(diff.topCostDrivers.length).toBe(2);
    // The major diff should be the #1 top driver
    expect(diff.topCostDrivers[0].nodeId).toBe("major-diff");
    expect(diff.topCostDrivers[0].deltaUsd).toBeGreaterThan(diff.topCostDrivers[1].deltaUsd);
    expect(diff.topCostDrivers[0].reason).toContain("LLM Tokens");
  });

  test("calculates generic relational db queries and SQS messaging costs", () => {
    const dbNode: TraceNode = {
      id: "pg-query",
      type: "span",
      label: "select_users",
      attributes: { "db.system": "postgresql", "db.statement": "SELECT * FROM users" },
      children: [],
    };
    const dbCost = calculateNodeCost(dbNode);
    expect(dbCost.categories.databaseUsd).toBe(PRICING.genericDbQuery);

    const sqsNode: TraceNode = {
      id: "sqs-poll",
      type: "span",
      label: "sqs_receive",
      attributes: { "messaging.system": "sqs" },
      children: [],
    };
    const sqsCost = calculateNodeCost(sqsNode);
    expect(sqsCost.categories.computeUsd).toBe(PRICING.sqsRequest);
  });
});

describe("FinOps Cost Engine — Prescriptive Remediation Advisor (7 Patterns)", () => {
  test("Pattern 1: detects unbounded cascading retries (5xx / error spans)", () => {
    const traceA: TraceNode = {
      id: "root",
      type: "span",
      label: "api",
      attributes: {},
      children: [],
    };
    const traceB: TraceNode = {
      id: "root",
      type: "span",
      label: "api",
      attributes: {},
      children: [
        {
          id: "err-span",
          type: "span",
          label: "payment_retry_500",
          attributes: { "http.status_code": 500, duration_ms: 300 },
          children: [],
        },
      ],
    };

    const diff = diffTraceCosts(traceA, traceB);
    const retryAdvice = diff.remediations.find((r) => r.patternId === "unbounded_retries");
    expect(retryAdvice).toBeDefined();
    expect(retryAdvice?.patternName).toBe("Unbounded Cascading Retries");
    expect(retryAdvice?.affectedSpanId).toBe("err-span");
    expect(retryAdvice?.codeSnippet).toContain("Exponential backoff");
    expect(retryAdvice?.potentialMonthlySavingsUsd).toBeGreaterThan(0);
  });

  test("Pattern 2: detects full table scan waste (DynamoDB Scan)", () => {
    const traceA: TraceNode = {
      id: "root",
      type: "span",
      label: "api",
      attributes: {},
      children: [],
    };
    const traceB: TraceNode = {
      id: "root",
      type: "span",
      label: "api",
      attributes: {},
      children: [
        {
          id: "scan-span",
          type: "span",
          label: "dynamodb_scan_all",
          attributes: {
            "db.system": "dynamodb",
            "db.operation": "Scan",
            "aws.dynamodb.consumed_rcu": 15,
          },
          children: [],
        },
      ],
    };

    const diff = diffTraceCosts(traceA, traceB);
    const scanAdvice = diff.remediations.find((r) => r.patternId === "full_table_scan");
    expect(scanAdvice).toBeDefined();
    expect(scanAdvice?.patternName).toBe("Full Table Scan Waste");
    expect(scanAdvice?.affectedSpanId).toBe("scan-span");
    expect(scanAdvice?.actionableFix).toContain("Global Secondary Index");
    expect(scanAdvice?.codeSnippet).toContain("dynamodb.query");
  });

  test("Pattern 3: detects N+1 API / query storm on sibling DB reads", () => {
    const traceA: TraceNode = {
      id: "root",
      type: "span",
      label: "parent",
      attributes: {},
      children: [],
    };
    const traceB: TraceNode = {
      id: "root",
      type: "span",
      label: "parent",
      attributes: {},
      children: [
        {
          id: "read-1",
          type: "span",
          label: "dynamodb_getItem_1",
          attributes: { "db.system": "dynamodb", "db.operation": "GetItem" },
          children: [],
        },
        {
          id: "read-2",
          type: "span",
          label: "dynamodb_getItem_2",
          attributes: { "db.system": "dynamodb", "db.operation": "GetItem" },
          children: [],
        },
      ],
    };

    const diff = diffTraceCosts(traceA, traceB);
    const nPlusOneAdvice = diff.remediations.find((r) => r.patternId === "n_plus_one_storm");
    expect(nPlusOneAdvice).toBeDefined();
    expect(nPlusOneAdvice?.patternName).toBe("N+1 API / Query Storm");
    expect(nPlusOneAdvice?.codeSnippet).toContain("batchGetItem");
  });

  test("Pattern 4: detects over-provisioned compute (fast execution on >=1024MB Lambda)", () => {
    const traceA: TraceNode = {
      id: "root",
      type: "span",
      label: "api",
      attributes: {},
      children: [],
    };
    const traceB: TraceNode = {
      id: "root",
      type: "span",
      label: "api",
      attributes: {},
      children: [
        {
          id: "oversized-lambda",
          type: "span",
          label: "lambda_handler",
          attributes: { duration_ms: 15, "faas.memory_mb": 1024 },
          children: [],
        },
      ],
    };

    const diff = diffTraceCosts(traceA, traceB);
    const computeAdvice = diff.remediations.find((r) => r.patternId === "over_provisioned_compute");
    expect(computeAdvice).toBeDefined();
    expect(computeAdvice?.patternName).toBe("Over-Provisioned Compute");
    expect(computeAdvice?.actionableFix).toContain(
      "Right-size Lambda memory from 1024MB down to 256MB",
    );
  });

  test("Pattern 5: detects cold storage cache miss (S3 GetObject)", () => {
    const traceA: TraceNode = {
      id: "root",
      type: "span",
      label: "api",
      attributes: {},
      children: [],
    };
    const traceB: TraceNode = {
      id: "root",
      type: "span",
      label: "api",
      attributes: {},
      children: [
        {
          id: "s3-read",
          type: "span",
          label: "s3_read_cold_cache",
          attributes: { "rpc.service": "s3", "db.operation": "GetObject" },
          children: [],
        },
      ],
    };

    const diff = diffTraceCosts(traceA, traceB);
    const s3Advice = diff.remediations.find((r) => r.patternId === "cold_storage_miss");
    expect(s3Advice).toBeDefined();
    expect(s3Advice?.patternName).toBe("Cold Storage Cache Miss");
    expect(s3Advice?.actionableFix).toContain("Redis read-through cache");
  });

  test("Pattern 6: detects runaway LLM token inflation (>= 2000 prompt tokens)", () => {
    const traceA: TraceNode = {
      id: "root",
      type: "span",
      label: "api",
      attributes: {},
      children: [],
    };
    const traceB: TraceNode = {
      id: "root",
      type: "span",
      label: "api",
      attributes: {},
      children: [
        {
          id: "chat-llm",
          type: "span",
          label: "llm_chat_completion",
          attributes: {
            "gen_ai.system": "anthropic",
            "gen_ai.usage.prompt_tokens": 4096,
            "gen_ai.usage.completion_tokens": 512,
          },
          children: [],
        },
      ],
    };

    const diff = diffTraceCosts(traceA, traceB);
    const llmAdvice = diff.remediations.find((r) => r.patternId === "llm_token_inflation");
    expect(llmAdvice).toBeDefined();
    expect(llmAdvice?.patternName).toBe("Runaway LLM Token Inflation");
    expect(llmAdvice?.actionableFix).toContain("sliding window context pruning");
  });

  test("Pattern 7: detects short-polling busy waiting (SQS receive)", () => {
    const traceA: TraceNode = {
      id: "root",
      type: "span",
      label: "api",
      attributes: {},
      children: [],
    };
    const traceB: TraceNode = {
      id: "root",
      type: "span",
      label: "api",
      attributes: {},
      children: [
        {
          id: "sqs-empty-poll",
          type: "span",
          label: "sqs_poll_queue",
          attributes: { "messaging.system": "sqs" },
          children: [],
        },
      ],
    };

    const diff = diffTraceCosts(traceA, traceB);
    const pollAdvice = diff.remediations.find((r) => r.patternId === "short_polling_waste");
    expect(pollAdvice).toBeDefined();
    expect(pollAdvice?.patternName).toBe("Short-Polling Busy Waiting");
    expect(pollAdvice?.actionableFix).toContain("Enable SQS Long Polling");
  });

  test("sorts multiple remediations by potential monthly savings descending", () => {
    const traceA: TraceNode = {
      id: "root",
      type: "span",
      label: "api",
      attributes: {},
      children: [],
    };
    const traceB: TraceNode = {
      id: "root",
      type: "span",
      label: "api",
      attributes: {},
      children: [
        // S3 read: small dollar delta
        {
          id: "s3-read",
          type: "span",
          label: "s3_read_cold_cache",
          attributes: { "rpc.service": "s3" },
          children: [],
        },
        // LLM tokens: large dollar delta
        {
          id: "huge-llm",
          type: "span",
          label: "llm_completion",
          attributes: {
            "gen_ai.system": "openai",
            "gen_ai.usage.prompt_tokens": 10000,
            "gen_ai.usage.completion_tokens": 2000,
          },
          children: [],
        },
      ],
    };

    const diff = diffTraceCosts(traceA, traceB);
    expect(diff.remediations.length).toBeGreaterThanOrEqual(2);
    for (let i = 0; i < diff.remediations.length - 1; i++) {
      expect(diff.remediations[i].potentialMonthlySavingsUsd).toBeGreaterThanOrEqual(
        diff.remediations[i + 1].potentialMonthlySavingsUsd,
      );
    }
  });

  test("does not generate remediations when cost is reduced (negative delta)", () => {
    const traceA: TraceNode = {
      id: "root",
      type: "span",
      label: "api",
      attributes: {},
      children: [
        {
          id: "old-scan",
          type: "span",
          label: "dynamodb_scan",
          attributes: { "db.system": "dynamodb", "db.operation": "Scan" },
          children: [],
        },
      ],
    };

    // traceB eliminates the scan
    const traceB: TraceNode = {
      id: "root",
      type: "span",
      label: "api",
      attributes: {},
      children: [],
    };
    const diff = diffTraceCosts(traceA, traceB);
    expect(diff.deltaUsd).toBeLessThan(0);
    expect(diff.remediations.length).toBe(0);
  });
});
