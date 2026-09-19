import { performance } from "node:perf_hooks";
import { GetObjectCommand } from "@aws-sdk/client-s3";
import { compareTraces } from "../core/compare-traces.js";
import { autoDetect } from "../parsers/index.js";
import { buildRuleSet, type RuleSetOptions } from "../rules/registry.js";
import type { ChunkItem } from "./load-traces.js";
import { BUCKET_TRACES, batchWriteAll, s3Client, TABLE_RESULTS } from "./shared.js";

export interface DiffWorkerOutput {
  chunkIndex: number;
  totalChunks: number;
  diffsFound: number;
  semanticDiffs: number;
  noiseDiffs: number;
  uncertainDiffs: number;
  nodesVisited: number;
  nodesSkipped: number;
  nodesBulkReported: number;
  skipPercentage: number;
  traceASize: number;
  traceBSize: number;
  timing: {
    parseMs: number;
    treeBuildMs: number;
    merkleBuildMs: number;
    diffMs: number;
    totalMs: number;
  };
}

/**
 * Step Functions Map task / standalone worker: diff-worker.
 *
 * 1. Downloads raw execution traces A and B from S3.
 * 2. Parses traces into standard TraceNode structures.
 * 3. Applies equivalence rules and computes Merkle subtree hashes.
 * 4. Traverses trees top-down, skipping identical subtrees in O(1).
 * 5. Batch-writes individual divergence records into DynamoDB.
 * 6. Returns statistical metrics to Step Functions.
 */
export async function handler(input: ChunkItem): Promise<DiffWorkerOutput> {
  const { jobId, traceAKey, traceBKey, rules, config, chunkIndex, totalChunks } = input;

  if (!jobId || !traceAKey || !traceBKey) {
    throw new Error("Missing required inputs for diff-worker");
  }

  // 1. Fetch raw trace contents from S3
  const [resA, resB] = await Promise.all([
    s3Client.send(new GetObjectCommand({ Bucket: BUCKET_TRACES, Key: traceAKey })),
    s3Client.send(new GetObjectCommand({ Bucket: BUCKET_TRACES, Key: traceBKey })),
  ]);

  const [bodyA, bodyB] = await Promise.all([
    resA.Body?.transformToString("utf-8"),
    resB.Body?.transformToString("utf-8"),
  ]);

  if (!bodyA || !bodyB) {
    throw new Error("One or both trace files downloaded from S3 were empty");
  }

  // 2. Parse raw inputs into unified TraceNode representation
  const parseStart = performance.now();
  const rawA = JSON.parse(bodyA);
  const rawB = JSON.parse(bodyB);
  const traceA = autoDetect(rawA);
  const traceB = autoDetect(rawB);
  const parseMs = performance.now() - parseStart;

  // 3. Configure equivalence rules and options
  const ruleOptions: RuleSetOptions = {
    ruleNames: rules && rules.length > 0 ? rules : undefined,
    numericTolerance: typeof config?.tolerance === "number" ? config.tolerance : undefined,
    ignoreFields: Array.isArray(config?.ignoreFields)
      ? (config.ignoreFields as string[])
      : undefined,
  };

  const maxDepth = typeof config?.maxDepth === "number" ? config.maxDepth : undefined;

  // 4. Run Merkle tree comparison engine
  const summary = compareTraces(traceA, traceB, {
    buildRules: () => buildRuleSet(ruleOptions),
    maxDepth,
    parseMs,
  });

  // 5. Batch-write diff results into DynamoDB (tracediff-results)
  // Each diff record is keyed by (jobId, diffIndex)
  const diffItems = summary.diffs.map((diff, index) => ({
    jobId,
    diffIndex: index,
    type: diff.type,
    significance: diff.significance,
    pathA: diff.pathA,
    pathB: diff.pathB,
    description: diff.description,
    classifiedBy: diff.classifiedBy,
    depth: diff.depth,
    affectedSubtreeSize: diff.affectedSubtreeSize,
    nodeA: diff.nodeA
      ? {
          id: diff.nodeA.id,
          label: diff.nodeA.label,
          type: diff.nodeA.type,
        }
      : undefined,
    nodeB: diff.nodeB
      ? {
          id: diff.nodeB.id,
          label: diff.nodeB.label,
          type: diff.nodeB.type,
        }
      : undefined,
  }));

  await batchWriteAll(TABLE_RESULTS, diffItems);

  // 6. Return chunk metrics to the orchestrator
  return {
    chunkIndex: chunkIndex ?? 0,
    totalChunks: totalChunks ?? 1,
    diffsFound: summary.diffs.length,
    semanticDiffs: summary.semantic.length,
    noiseDiffs: summary.noise.length,
    uncertainDiffs: summary.uncertain.length,
    nodesVisited: summary.nodesVisited,
    nodesSkipped: summary.nodesSkipped,
    nodesBulkReported: summary.nodesBulkReported,
    skipPercentage: summary.skipPercentage,
    traceASize: summary.traceASize,
    traceBSize: summary.traceBSize,
    timing: summary.timing,
  };
}
