import crypto from "node:crypto";
import { StartExecutionCommand } from "@aws-sdk/client-sfn";
import { PutCommand } from "@aws-sdk/lib-dynamodb";
import type { APIGatewayProxyEvent, APIGatewayProxyResult } from "aws-lambda";
import {
  docClient,
  handleOptions,
  jsonResponse,
  STATE_MACHINE_ARN,
  sfnClient,
  TABLE_JOBS,
} from "./shared.js";

export interface SubmitJobRequest {
  traceAKey: string;
  traceBKey: string;
  rules?: string[];
  config?: Record<string, unknown>;
}

/**
 * Lambda handler for POST /jobs.
 * Creates a job record in DynamoDB with status PENDING, then starts an asynchronous
 * Step Functions execution to run the Merkle diff pipeline.
 */
export async function handler(event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> {
  if (event.httpMethod === "OPTIONS") {
    return handleOptions();
  }

  try {
    if (!event.body) {
      return jsonResponse(400, { error: "Missing request body" });
    }

    let payload: SubmitJobRequest;
    try {
      payload = JSON.parse(event.body);
    } catch {
      return jsonResponse(400, { error: "Invalid JSON format in request body" });
    }

    const { traceAKey, traceBKey, rules, config } = payload;
    if (!traceAKey || typeof traceAKey !== "string") {
      return jsonResponse(400, { error: "Missing or invalid 'traceAKey'" });
    }
    if (!traceBKey || typeof traceBKey !== "string") {
      return jsonResponse(400, { error: "Missing or invalid 'traceBKey'" });
    }

    const jobId = crypto.randomUUID();
    const now = new Date().toISOString();
    // 7-day DynamoDB TTL expiration
    const ttl = Math.floor(Date.now() / 1000) + 7 * 86400;

    const activeRules =
      rules && rules.length > 0
        ? rules
        : ["ignore-timestamps", "canonicalize-ids", "numeric-tolerance", "sort-concurrent"];

    const jobConfig = config ?? {};

    // 1. Write initial job record to DynamoDB
    await docClient.send(
      new PutCommand({
        TableName: TABLE_JOBS,
        Item: {
          jobId,
          status: "PENDING",
          traceAKey,
          traceBKey,
          rules: activeRules,
          config: jobConfig,
          createdAt: now,
          ttl,
        },
      }),
    );

    // 2. Start Step Functions execution if configured
    let executionArn: string | undefined;
    if (STATE_MACHINE_ARN) {
      const sfnOutput = await sfnClient.send(
        new StartExecutionCommand({
          stateMachineArn: STATE_MACHINE_ARN,
          name: `job-${jobId}`,
          input: JSON.stringify({
            jobId,
            traceAKey,
            traceBKey,
            rules: activeRules,
            config: jobConfig,
          }),
        }),
      );
      executionArn = sfnOutput.executionArn;
    }

    return jsonResponse(202, {
      jobId,
      status: "PENDING",
      executionArn,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Failed to submit job";
    return jsonResponse(500, { error: message });
  }
}
