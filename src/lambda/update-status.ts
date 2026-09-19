import { UpdateCommand } from "@aws-sdk/lib-dynamodb";
import type { AggregatedSummary } from "./aggregate.js";
import { docClient, TABLE_JOBS } from "./shared.js";

export interface UpdateStatusInput {
  jobId: string;
  status?: "COMPLETED" | "FAILED";
  summary?: AggregatedSummary;
  error?: unknown;
  Cause?: string;
  Error?: string;
}

export interface UpdateStatusOutput {
  jobId: string;
  status: "COMPLETED" | "FAILED";
  completedAt: string;
}

/**
 * Step Functions task: UpdateJobStatus.
 * Sets the final state of the job in DynamoDB, persisting aggregate metrics or error details.
 */
export async function handler(input: UpdateStatusInput): Promise<UpdateStatusOutput> {
  const { jobId, summary } = input;

  if (!jobId) {
    throw new Error("UpdateJobStatus requires a 'jobId'");
  }

  const completedAt = new Date().toISOString();
  const isFailed =
    input.status === "FAILED" ||
    input.error !== undefined ||
    input.Error !== undefined ||
    input.Cause !== undefined;

  const finalStatus = isFailed ? "FAILED" : "COMPLETED";

  let errorDetails: unknown = input.error;
  if (!errorDetails && (input.Error || input.Cause)) {
    try {
      errorDetails = input.Cause ? JSON.parse(input.Cause) : input.Error;
    } catch {
      errorDetails = input.Cause ?? input.Error;
    }
  }

  await docClient.send(
    new UpdateCommand({
      TableName: TABLE_JOBS,
      Key: { jobId },
      UpdateExpression:
        "SET #st = :status, completedAt = :completedAt, summary = :summary, #err = :error",
      ExpressionAttributeNames: {
        "#st": "status",
        "#err": "error",
      },
      ExpressionAttributeValues: {
        ":status": finalStatus,
        ":completedAt": completedAt,
        ":summary": summary ?? null,
        ":error": errorDetails ?? null,
      },
    }),
  );

  return {
    jobId,
    status: finalStatus,
    completedAt,
  };
}
