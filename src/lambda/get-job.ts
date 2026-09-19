import { GetCommand, QueryCommand } from "@aws-sdk/lib-dynamodb";
import type { APIGatewayProxyEvent, APIGatewayProxyResult } from "aws-lambda";
import { docClient, handleOptions, jsonResponse, TABLE_JOBS, TABLE_RESULTS } from "./shared.js";

/**
 * Lambda handler for:
 * - GET /jobs/{id}
 * - GET /jobs/{id}/results
 *
 * Reads job state and paginates structured divergence records from DynamoDB.
 */
export async function handler(event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> {
  if (event.httpMethod === "OPTIONS") {
    return handleOptions();
  }

  try {
    const jobId = event.pathParameters?.id;
    if (!jobId) {
      return jsonResponse(400, { error: "Missing 'id' path parameter" });
    }

    // 1. Fetch the parent job record
    const jobResult = await docClient.send(
      new GetCommand({
        TableName: TABLE_JOBS,
        Key: { jobId },
      }),
    );

    if (!jobResult.Item) {
      return jsonResponse(404, { error: `Job '${jobId}' not found` });
    }

    const job = jobResult.Item;
    const isResultsEndpoint =
      event.resource?.endsWith("/results") || event.path?.endsWith("/results");

    // 2. If client is requesting /jobs/{id}/results, return paginated diff entries
    if (isResultsEndpoint) {
      const queryParams = event.queryStringParameters ?? {};
      const limit = Math.min(
        Math.max(1, Number.parseInt(queryParams.limit ?? "50", 10) || 50),
        200,
      );

      let exclusiveStartKey: Record<string, unknown> | undefined;
      if (queryParams.nextToken) {
        try {
          exclusiveStartKey = JSON.parse(
            Buffer.from(queryParams.nextToken, "base64").toString("utf-8"),
          );
        } catch {
          return jsonResponse(400, { error: "Invalid nextToken" });
        }
      }

      const resultsQuery = await docClient.send(
        new QueryCommand({
          TableName: TABLE_RESULTS,
          KeyConditionExpression: "jobId = :jid",
          ExpressionAttributeValues: {
            ":jid": jobId,
          },
          Limit: limit,
          ExclusiveStartKey: exclusiveStartKey,
        }),
      );

      const items = resultsQuery.Items ?? [];
      const nextToken = resultsQuery.LastEvaluatedKey
        ? Buffer.from(JSON.stringify(resultsQuery.LastEvaluatedKey)).toString("base64")
        : undefined;

      return jsonResponse(200, {
        jobId,
        results: items,
        count: items.length,
        nextToken,
      });
    }

    // 3. For GET /jobs/{id}, return job status and summary, plus a small preview of top diffs
    let diffPreview: unknown[] = [];
    if (job.status === "COMPLETED") {
      const previewQuery = await docClient.send(
        new QueryCommand({
          TableName: TABLE_RESULTS,
          KeyConditionExpression: "jobId = :jid",
          ExpressionAttributeValues: {
            ":jid": jobId,
          },
          Limit: 10,
        }),
      );
      diffPreview = previewQuery.Items ?? [];
    }

    return jsonResponse(200, {
      ...job,
      diffPreview,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Failed to fetch job";
    return jsonResponse(500, { error: message });
  }
}
