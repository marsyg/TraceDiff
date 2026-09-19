import { HeadObjectCommand } from "@aws-sdk/client-s3";
import { UpdateCommand } from "@aws-sdk/lib-dynamodb";
import { BUCKET_TRACES, docClient, s3Client, TABLE_JOBS } from "./shared.js";

export interface LoadTracesInput {
  jobId: string;
  traceAKey: string;
  traceBKey: string;
  rules?: string[];
  config?: Record<string, unknown>;
}

export interface ChunkItem {
  jobId: string;
  traceAKey: string;
  traceBKey: string;
  rules?: string[];
  config?: Record<string, unknown>;
  chunkIndex: number;
  totalChunks: number;
}

export interface LoadTracesOutput {
  jobId: string;
  traceAKey: string;
  traceBKey: string;
  rules?: string[];
  config?: Record<string, unknown>;
  chunks: ChunkItem[];
}

/**
 * Step Functions task: LoadTraces.
 * Verifies S3 trace assets exist, marks the DynamoDB job status as RUNNING,
 * and sets up chunk descriptor items for the Step Functions Map state.
 */
export async function handler(input: LoadTracesInput): Promise<LoadTracesOutput> {
  const { jobId, traceAKey, traceBKey, rules, config } = input;

  if (!jobId || !traceAKey || !traceBKey) {
    throw new Error("Invalid LoadTraces input: jobId, traceAKey, and traceBKey are required");
  }

  // 1. Verify existence of both trace objects in S3
  await Promise.all([
    s3Client.send(new HeadObjectCommand({ Bucket: BUCKET_TRACES, Key: traceAKey })),
    s3Client.send(new HeadObjectCommand({ Bucket: BUCKET_TRACES, Key: traceBKey })),
  ]);

  // 2. Mark job status as RUNNING in DynamoDB
  await docClient.send(
    new UpdateCommand({
      TableName: TABLE_JOBS,
      Key: { jobId },
      UpdateExpression: "SET #st = :running, startedAt = :now",
      ExpressionAttributeNames: {
        "#st": "status",
      },
      ExpressionAttributeValues: {
        ":running": "RUNNING",
        ":now": new Date().toISOString(),
      },
    }),
  );

  // 3. Construct chunk descriptors for Step Functions Map iteration
  const chunks: ChunkItem[] = [
    {
      jobId,
      traceAKey,
      traceBKey,
      rules,
      config,
      chunkIndex: 0,
      totalChunks: 1,
    },
  ];

  return {
    jobId,
    traceAKey,
    traceBKey,
    rules,
    config,
    chunks,
  };
}
