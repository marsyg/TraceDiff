import crypto from "node:crypto";
import { PutObjectCommand } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import type { APIGatewayProxyEvent, APIGatewayProxyResult } from "aws-lambda";
import { BUCKET_TRACES, handleOptions, jsonResponse, s3Client } from "./shared.js";

/**
 * Lambda handler for GET /presign.
 * Generates an S3 presigned URL for direct file uploads from the browser or CLI,
 * allowing large trace uploads (>100MB) without traversing API Gateway payload limits.
 */
export async function handler(event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> {
  if (event.httpMethod === "OPTIONS") {
    return handleOptions();
  }

  try {
    const queryParams = event.queryStringParameters ?? {};
    const rawFilename = queryParams.filename ?? "trace.json";
    const contentType = queryParams.contentType ?? "application/json";

    // Sanitize filename to prevent directory traversal or invalid S3 key characters
    const sanitizedFilename = rawFilename.replace(/[^a-zA-Z0-9._-]/g, "_");
    const uniqueId = crypto.randomUUID();
    const key = `traces/${uniqueId}-${sanitizedFilename}`;

    const command = new PutObjectCommand({
      Bucket: BUCKET_TRACES,
      Key: key,
      ContentType: contentType,
    });

    const expiresIn = 900; // 15 minutes
    const uploadUrl = await getSignedUrl(s3Client, command, { expiresIn });

    return jsonResponse(200, {
      uploadUrl,
      key,
      bucket: BUCKET_TRACES,
      expiresIn,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Failed to generate presigned URL";
    return jsonResponse(500, { error: message });
  }
}
