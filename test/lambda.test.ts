import { describe, expect, test } from "bun:test";
import type { APIGatewayProxyEvent } from "aws-lambda";
import { diffTraceCosts } from "../src/finops/costEngine.js";
import { handler as aggregateHandler } from "../src/lambda/aggregate.js";
import type { DiffWorkerOutput } from "../src/lambda/diff-worker.js";
import { handler as diffWorkerHandler } from "../src/lambda/diff-worker.js";
import { handler as getJobHandler } from "../src/lambda/get-job.js";
import { handler as loadTracesHandler } from "../src/lambda/load-traces.js";
import { handler as presignHandler } from "../src/lambda/presign.js";
import { docClient, s3Client, sfnClient } from "../src/lambda/shared.js";
import { handler as submitJobHandler } from "../src/lambda/submit-job.js";
import { handler as updateStatusHandler } from "../src/lambda/update-status.js";
import { node, withDepth } from "./helpers.js";

process.env.AWS_ACCESS_KEY_ID = "testing";
process.env.AWS_SECRET_ACCESS_KEY = "testing";
process.env.AWS_REGION = "us-east-1";

function makeMockApiEvent(overrides: Partial<APIGatewayProxyEvent> = {}): APIGatewayProxyEvent {
  return {
    body: null,
    headers: {},
    multiValueHeaders: {},
    httpMethod: "GET",
    isBase64Encoded: false,
    path: "/",
    pathParameters: null,
    queryStringParameters: null,
    multiValueQueryStringParameters: null,
    stageVariables: null,
    requestContext: {} as unknown as APIGatewayProxyEvent["requestContext"],
    resource: "/",
    ...overrides,
  };
}

describe("Lambda — aggregate handler", () => {
  test("aggregates multiple diff worker outputs correctly", async () => {
    const chunk1: DiffWorkerOutput = {
      chunkIndex: 0,
      totalChunks: 2,
      diffsFound: 2,
      semanticDiffs: 1,
      noiseDiffs: 1,
      uncertainDiffs: 0,
      nodesVisited: 50,
      nodesSkipped: 950,
      nodesBulkReported: 0,
      skipPercentage: 95.0,
      traceASize: 1000,
      traceBSize: 1000,
      timing: {
        parseMs: 10,
        treeBuildMs: 5,
        merkleBuildMs: 15,
        diffMs: 2,
        totalMs: 32,
      },
    };

    const chunk2: DiffWorkerOutput = {
      chunkIndex: 1,
      totalChunks: 2,
      diffsFound: 3,
      semanticDiffs: 2,
      noiseDiffs: 0,
      uncertainDiffs: 1,
      nodesVisited: 30,
      nodesSkipped: 470,
      nodesBulkReported: 0,
      skipPercentage: 94.0,
      traceASize: 1000,
      traceBSize: 1000,
      timing: {
        parseMs: 12,
        treeBuildMs: 4,
        merkleBuildMs: 18,
        diffMs: 3,
        totalMs: 37,
      },
    };

    const result = await aggregateHandler({
      jobId: "test-job-123",
      workerResults: [chunk1, chunk2],
    });

    expect(result.jobId).toBe("test-job-123");
    expect(result.status).toBe("COMPLETED");
    expect(result.summary.diffsFound).toBe(5);
    expect(result.summary.semanticDiffs).toBe(3);
    expect(result.summary.noiseDiffs).toBe(1);
    expect(result.summary.uncertainDiffs).toBe(1);
    expect(result.summary.nodesVisited).toBe(80);
    expect(result.summary.nodesSkipped).toBe(1420);
    expect(result.summary.traceASize).toBe(1000);
    expect(result.summary.timing.parseMs).toBe(12);
    expect(result.summary.timing.diffMs).toBe(5);
  });

  test("handles empty worker results gracefully", async () => {
    const result = await aggregateHandler({
      jobId: "empty-job",
      workerResults: [],
    });

    expect(result.jobId).toBe("empty-job");
    expect(result.summary.diffsFound).toBe(0);
    expect(result.summary.skipPercentage).toBe(0);
    expect(result.summary.finops).toBeUndefined();
  });

  test("passes FinOps through from the reporting chunk without merging", async () => {
    const finopsA = diffTraceCosts(
      withDepth(node("root", { duration_ms: 100 })),
      withDepth(node("root", { duration_ms: 200 })),
    );
    const finopsB = diffTraceCosts(
      withDepth(node("root", { duration_ms: 100 })),
      withDepth(node("root", { duration_ms: 300 })),
    );
    const baseChunk = {
      chunkIndex: 0,
      totalChunks: 1,
      diffsFound: 1,
      semanticDiffs: 1,
      noiseDiffs: 0,
      uncertainDiffs: 0,
      nodesVisited: 2,
      nodesSkipped: 0,
      nodesBulkReported: 0,
      skipPercentage: 0,
      traceASize: 2,
      traceBSize: 2,
      timing: { parseMs: 1, treeBuildMs: 1, merkleBuildMs: 1, diffMs: 1, totalMs: 4 },
    };

    // First reporting chunk wins; costs are per-trace-pair, never summed.
    const result = await aggregateHandler({
      jobId: "finops-job",
      workerResults: [
        { ...baseChunk, finops: finopsA },
        { ...baseChunk, chunkIndex: 1, finops: finopsB },
      ],
    });
    expect(result.summary.finops?.targetCostUsd).toBe(finopsA.targetCostUsd);
    expect(result.summary.finops?.requestsPerMonth).toBe(10_000_000);
  });
});

describe("Lambda — presign handler", () => {
  test("handles OPTIONS preflight with 204", async () => {
    const event = makeMockApiEvent({ httpMethod: "OPTIONS" });
    const response = await presignHandler(event);
    expect(response.statusCode).toBe(204);
    expect(response.headers?.["Access-Control-Allow-Origin"]).toBe("*");
  });

  test("generates presigned URL for upload", async () => {
    const event = makeMockApiEvent({
      httpMethod: "GET",
      queryStringParameters: {
        filename: "canary-trace.json",
      },
    });

    const response = await presignHandler(event);
    expect(response.statusCode).toBe(200);
    const body = JSON.parse(response.body);
    expect(body.uploadUrl).toBeDefined();
    expect(body.key).toMatch(/^traces\/[0-9a-f-]+-canary-trace\.json$/);
    expect(body.expiresIn).toBe(900);
  });
});

describe("Lambda — submit-job handler", () => {
  test("handles OPTIONS preflight with 204", async () => {
    const event = makeMockApiEvent({ httpMethod: "OPTIONS" });
    const response = await submitJobHandler(event);
    expect(response.statusCode).toBe(204);
  });

  test("returns 400 when request body is missing", async () => {
    const event = makeMockApiEvent({ httpMethod: "POST", body: null });
    const response = await submitJobHandler(event);
    expect(response.statusCode).toBe(400);
    expect(JSON.parse(response.body).error).toContain("Missing request body");
  });

  test("returns 400 when JSON body is invalid", async () => {
    const event = makeMockApiEvent({ httpMethod: "POST", body: "{invalid json" });
    const response = await submitJobHandler(event);
    expect(response.statusCode).toBe(400);
    expect(JSON.parse(response.body).error).toContain("Invalid JSON format");
  });

  test("returns 400 when trace keys are missing", async () => {
    const event = makeMockApiEvent({
      httpMethod: "POST",
      body: JSON.stringify({ traceAKey: "traces/a.json" }),
    });
    const response = await submitJobHandler(event);
    expect(response.statusCode).toBe(400);
    expect(JSON.parse(response.body).error).toContain("Missing or invalid 'traceBKey'");
  });

  test("returns 202 and creates job when payload is valid", async () => {
    // Both AWS clients are stubbed: Bun auto-loads a deployment .env if one
    // exists, which would otherwise flip the handler into the live Step
    // Functions branch (STATE_MACHINE_ARN set) and fail offline.
    const origSend = docClient.send;
    const origSfnSend = sfnClient.send;
    docClient.send = (async () => ({})) as unknown as typeof docClient.send;
    sfnClient.send = (async () => ({
      executionArn: "arn:aws:states:mock",
    })) as unknown as typeof sfnClient.send;

    try {
      const event = makeMockApiEvent({
        httpMethod: "POST",
        body: JSON.stringify({
          traceAKey: "traces/a.json",
          traceBKey: "traces/b.json",
          rules: ["ignore-timestamps"],
        }),
      });

      const response = await submitJobHandler(event);
      expect(response.statusCode).toBe(202);
      const body = JSON.parse(response.body);
      expect(body.jobId).toBeDefined();
      expect(body.status).toBe("PENDING");
    } finally {
      docClient.send = origSend;
      sfnClient.send = origSfnSend;
    }
  });
});

describe("Lambda — get-job handler", () => {
  test("handles OPTIONS preflight with 204", async () => {
    const event = makeMockApiEvent({ httpMethod: "OPTIONS" });
    const response = await getJobHandler(event);
    expect(response.statusCode).toBe(204);
  });

  test("returns 400 when id path parameter is missing", async () => {
    const event = makeMockApiEvent({ httpMethod: "GET", pathParameters: null });
    const response = await getJobHandler(event);
    expect(response.statusCode).toBe(400);
  });

  test("returns 404 when job does not exist", async () => {
    const origSend = docClient.send;
    docClient.send = (async () => ({ Item: undefined })) as unknown as typeof docClient.send;

    try {
      const event = makeMockApiEvent({
        httpMethod: "GET",
        pathParameters: { id: "non-existent-id" },
      });
      const response = await getJobHandler(event);
      expect(response.statusCode).toBe(404);
    } finally {
      docClient.send = origSend;
    }
  });

  test("returns job details and results when job exists", async () => {
    const origSend = docClient.send;
    docClient.send = (async (command: { constructor: { name: string } }) => {
      if (command.constructor.name === "GetCommand") {
        return {
          Item: {
            jobId: "test-job-456",
            status: "COMPLETED",
            createdAt: "2026-09-19T00:00:00.000Z",
            completedAt: "2026-09-19T00:00:05.000Z",
          },
        };
      }
      return { Items: [] };
    }) as unknown as typeof docClient.send;

    try {
      const event = makeMockApiEvent({
        httpMethod: "GET",
        pathParameters: { id: "test-job-456" },
      });
      const response = await getJobHandler(event);
      expect(response.statusCode).toBe(200);
      const body = JSON.parse(response.body);
      expect(body.jobId).toBe("test-job-456");
      expect(body.status).toBe("COMPLETED");
    } finally {
      docClient.send = origSend;
    }
  });
});

describe("Lambda — load-traces handler", () => {
  test("validates required inputs", async () => {
    expect(loadTracesHandler({ jobId: "", traceAKey: "a", traceBKey: "b" })).rejects.toThrow(
      "Invalid LoadTraces input",
    );
  });

  test("verifies S3 traces and returns chunk array", async () => {
    const origS3Send = s3Client.send;
    const origDocSend = docClient.send;

    s3Client.send = (async () => ({})) as unknown as typeof s3Client.send;
    docClient.send = (async () => ({})) as unknown as typeof docClient.send;

    try {
      const output = await loadTracesHandler({
        jobId: "job-load-test",
        traceAKey: "traces/a.json",
        traceBKey: "traces/b.json",
        rules: ["ignore-timestamps"],
      });

      expect(output.jobId).toBe("job-load-test");
      expect(output.chunks.length).toBe(1);
      expect(output.chunks[0].chunkIndex).toBe(0);
      expect(output.chunks[0].totalChunks).toBe(1);
    } finally {
      s3Client.send = origS3Send;
      docClient.send = origDocSend;
    }
  });
});

describe("Lambda — update-status handler", () => {
  test("updates job status to COMPLETED", async () => {
    const origSend = docClient.send;
    let capturedItem: { ExpressionAttributeValues?: Record<string, unknown> } = {};
    docClient.send = (async (cmd: {
      input?: { ExpressionAttributeValues?: Record<string, unknown> };
    }) => {
      capturedItem = cmd.input ?? {};
      return {};
    }) as unknown as typeof docClient.send;

    try {
      const output = await updateStatusHandler({
        jobId: "status-test-job",
        status: "COMPLETED",
      });

      expect(output.status).toBe("COMPLETED");
      expect(output.completedAt).toBeDefined();
      expect(capturedItem.ExpressionAttributeValues?.[":status"]).toBe("COMPLETED");
    } finally {
      docClient.send = origSend;
    }
  });

  test("marks job as FAILED when error is passed", async () => {
    const origSend = docClient.send;
    let capturedItem: { ExpressionAttributeValues?: Record<string, unknown> } = {};
    docClient.send = (async (cmd: {
      input?: { ExpressionAttributeValues?: Record<string, unknown> };
    }) => {
      capturedItem = cmd.input ?? {};
      return {};
    }) as unknown as typeof docClient.send;

    try {
      const output = await updateStatusHandler({
        jobId: "status-failed-job",
        error: "Diff engine out of memory",
      });

      expect(output.status).toBe("FAILED");
      expect(capturedItem.ExpressionAttributeValues?.[":status"]).toBe("FAILED");
      expect(capturedItem.ExpressionAttributeValues?.[":error"]).toBe("Diff engine out of memory");
    } finally {
      docClient.send = origSend;
    }
  });
});

describe("Lambda — diff-worker handler", () => {
  test("downloads traces, diffs them, and records results", async () => {
    const origS3Send = s3Client.send;
    const origDocSend = docClient.send;

    const traceAStr = await Bun.file("fixtures/small-diff/a.json").text();
    const traceBStr = await Bun.file("fixtures/small-diff/b.json").text();

    s3Client.send = (async (cmd: { input: { Key: string } }) => {
      if (cmd.input.Key === "traces/a.json") {
        return { Body: { transformToString: async () => traceAStr } };
      }
      return { Body: { transformToString: async () => traceBStr } };
    }) as unknown as typeof s3Client.send;

    const writtenBatches: unknown[] = [];
    docClient.send = (async (cmd: { input?: unknown }) => {
      writtenBatches.push(cmd.input);
      return {};
    }) as unknown as typeof docClient.send;

    try {
      const output = await diffWorkerHandler({
        jobId: "worker-test-job",
        traceAKey: "traces/a.json",
        traceBKey: "traces/b.json",
        rules: ["ignore-timestamps", "canonicalize-ids"],
        chunkIndex: 0,
        totalChunks: 1,
      });

      expect(output.diffsFound).toBeGreaterThan(0);
      expect(output.semanticDiffs).toBeGreaterThan(0);
      expect(output.nodesVisited).toBeGreaterThan(0);
      expect(writtenBatches.length).toBeGreaterThan(0);
    } finally {
      s3Client.send = origS3Send;
      docClient.send = origDocSend;
    }
  });

  test("includes FinOps cost regression on single-chunk jobs", async () => {
    const origS3Send = s3Client.send;
    const origDocSend = docClient.send;

    const traceAStr = await Bun.file("fixtures/small-diff/a.json").text();
    const traceBStr = await Bun.file("fixtures/small-diff/b.json").text();

    s3Client.send = (async (cmd: { input: { Key: string } }) => {
      if (cmd.input.Key === "traces/a.json") {
        return { Body: { transformToString: async () => traceAStr } };
      }
      return { Body: { transformToString: async () => traceBStr } };
    }) as unknown as typeof s3Client.send;
    docClient.send = (async () => ({})) as unknown as typeof docClient.send;

    try {
      const output = await diffWorkerHandler({
        jobId: "worker-finops-job",
        traceAKey: "traces/a.json",
        traceBKey: "traces/b.json",
        chunkIndex: 0,
        totalChunks: 1,
      });

      expect(output.finops).toBeDefined();
      expect(output.finops?.requestsPerMonth).toBe(10_000_000);
      expect(output.finops?.priceTableVersion.length).toBeGreaterThan(0);
      // Driver discovery is threshold-gated ($1e-8); the 10-node fixture
      // may legitimately yield none — driver identification itself is
      // covered in test/costEngine.test.ts. Here we assert shape.
      expect(Array.isArray(output.finops?.topCostDrivers)).toBe(true);
      expect(output.finops?.evalDurationMs).toBeGreaterThanOrEqual(0);
    } finally {
      s3Client.send = origS3Send;
      docClient.send = origDocSend;
    }
  });

  test("honors config.requestsPerMonth and skips FinOps on multi-chunk jobs", async () => {
    const origS3Send = s3Client.send;
    const origDocSend = docClient.send;

    const traceAStr = await Bun.file("fixtures/small-diff/a.json").text();
    const traceBStr = await Bun.file("fixtures/small-diff/b.json").text();

    s3Client.send = (async (cmd: { input: { Key: string } }) => {
      if (cmd.input.Key === "traces/a.json") {
        return { Body: { transformToString: async () => traceAStr } };
      }
      return { Body: { transformToString: async () => traceBStr } };
    }) as unknown as typeof s3Client.send;
    docClient.send = (async () => ({})) as unknown as typeof docClient.send;

    try {
      const custom = await diffWorkerHandler({
        jobId: "worker-finops-volume",
        traceAKey: "traces/a.json",
        traceBKey: "traces/b.json",
        config: { requestsPerMonth: 500_000 },
        chunkIndex: 0,
        totalChunks: 1,
      });
      expect(custom.finops?.requestsPerMonth).toBe(500_000);

      // Every chunked worker loads the FULL traces, so per-chunk costs
      // would multiply the truth — multi-chunk jobs report none.
      const chunked = await diffWorkerHandler({
        jobId: "worker-finops-chunked",
        traceAKey: "traces/a.json",
        traceBKey: "traces/b.json",
        chunkIndex: 0,
        totalChunks: 4,
      });
      expect(chunked.finops).toBeUndefined();
      expect(chunked.diffsFound).toBeGreaterThan(0);
    } finally {
      s3Client.send = origS3Send;
      docClient.send = origDocSend;
    }
  });
});
