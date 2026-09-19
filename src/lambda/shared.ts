import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { S3Client } from "@aws-sdk/client-s3";
import { SFNClient } from "@aws-sdk/client-sfn";
import { BatchWriteCommand, DynamoDBDocumentClient } from "@aws-sdk/lib-dynamodb";

// Reuse client connections across Lambda invocations for performance.
export const s3Client = new S3Client({});
export const rawDynamoClient = new DynamoDBClient({});
export const docClient = DynamoDBDocumentClient.from(rawDynamoClient, {
  marshallOptions: {
    removeUndefinedValues: true,
  },
});
export const sfnClient = new SFNClient({});

export const TABLE_JOBS = process.env.JOBS_TABLE_NAME ?? "tracediff-jobs";
export const TABLE_RESULTS = process.env.RESULTS_TABLE_NAME ?? "tracediff-results";
export const BUCKET_TRACES = process.env.TRACES_BUCKET_NAME ?? "tracediff-uploads";
export const STATE_MACHINE_ARN = process.env.STATE_MACHINE_ARN ?? "";

export interface ApiResponse {
  statusCode: number;
  headers: Record<string, string>;
  body: string;
}

export const CORS_HEADERS: Record<string, string> = {
  "Access-Control-Allow-Origin": process.env.CORS_ORIGIN ?? "*",
  "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
  "Access-Control-Allow-Headers":
    "Content-Type,Authorization,X-Amz-Date,X-Api-Key,X-Amz-Security-Token",
  "Content-Type": "application/json",
};

/**
 * Construct an API Gateway proxy response with standard CORS headers.
 */
export function jsonResponse(
  statusCode: number,
  body: unknown,
  extraHeaders: Record<string, string> = {},
): ApiResponse {
  return {
    statusCode,
    headers: { ...CORS_HEADERS, ...extraHeaders },
    body: JSON.stringify(body),
  };
}

/**
 * Handle API Gateway CORS preflight OPTIONS requests.
 */
export function handleOptions(): ApiResponse {
  return {
    statusCode: 204,
    headers: CORS_HEADERS,
    body: "",
  };
}

/**
 * Write items to DynamoDB in batches of 25 (the DynamoDB BatchWrite limit),
 * automatically retrying unprocessed items with exponential backoff.
 */
export async function batchWriteAll(
  tableName: string,
  items: Record<string, unknown>[],
  maxRetries = 3,
): Promise<void> {
  if (items.length === 0) return;

  const CHUNK_SIZE = 25;
  for (let i = 0; i < items.length; i += CHUNK_SIZE) {
    const chunk = items.slice(i, i + CHUNK_SIZE);
    let requestItems: Record<string, unknown>[] = chunk;
    let attempt = 0;

    while (requestItems.length > 0 && attempt <= maxRetries) {
      const response = await docClient.send(
        new BatchWriteCommand({
          RequestItems: {
            [tableName]: requestItems.map((item) => ({
              PutRequest: {
                Item: item,
              },
            })),
          },
        }),
      );

      const unprocessed = response.UnprocessedItems?.[tableName];
      if (!unprocessed || unprocessed.length === 0) {
        break;
      }

      attempt += 1;
      if (attempt > maxRetries) {
        throw new Error(
          `BatchWrite failed to process ${unprocessed.length} items after ${maxRetries} retries`,
        );
      }

      // Exponential backoff before retry
      await new Promise((resolve) => setTimeout(resolve, 2 ** attempt * 50));
      requestItems = unprocessed
        .map((req) => req.PutRequest?.Item)
        .filter((item): item is Record<string, unknown> => item !== undefined);
    }
  }
}
