import type { DiffWorkerOutput } from "./diff-worker.js";

export interface AggregateInput {
  jobId?: string;
  workerResults?: DiffWorkerOutput[];
  // If the input is passed directly as an array from Step Functions Map state
  [key: string]: unknown;
}

export interface AggregatedSummary {
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

export interface AggregateOutput {
  jobId: string;
  summary: AggregatedSummary;
  status: "COMPLETED";
}

/**
 * Step Functions task: AggregateResults.
 * Collates results across all parallel diff worker chunks into an aggregated summary.
 */
export async function handler(
  input: AggregateInput | DiffWorkerOutput[],
): Promise<AggregateOutput> {
  let jobId = "";
  let results: DiffWorkerOutput[] = [];

  if (Array.isArray(input)) {
    results = input;
  } else {
    jobId = input.jobId ?? "";
    if (Array.isArray(input.workerResults)) {
      results = input.workerResults;
    } else if (Array.isArray(input)) {
      results = input;
    }
  }

  let totalDiffs = 0;
  let totalSemantic = 0;
  let totalNoise = 0;
  let totalUncertain = 0;
  let totalVisited = 0;
  let totalSkipped = 0;
  let totalBulk = 0;
  let traceASize = 0;
  let traceBSize = 0;

  let maxParseMs = 0;
  let maxTreeBuildMs = 0;
  let maxMerkleBuildMs = 0;
  let totalDiffMs = 0;

  for (const chunk of results) {
    totalDiffs += chunk.diffsFound ?? 0;
    totalSemantic += chunk.semanticDiffs ?? 0;
    totalNoise += chunk.noiseDiffs ?? 0;
    totalUncertain += chunk.uncertainDiffs ?? 0;
    totalVisited += chunk.nodesVisited ?? 0;
    totalSkipped += chunk.nodesSkipped ?? 0;
    totalBulk += chunk.nodesBulkReported ?? 0;

    traceASize = Math.max(traceASize, chunk.traceASize ?? 0);
    traceBSize = Math.max(traceBSize, chunk.traceBSize ?? 0);

    if (chunk.timing) {
      maxParseMs = Math.max(maxParseMs, chunk.timing.parseMs ?? 0);
      maxTreeBuildMs = Math.max(maxTreeBuildMs, chunk.timing.treeBuildMs ?? 0);
      maxMerkleBuildMs = Math.max(maxMerkleBuildMs, chunk.timing.merkleBuildMs ?? 0);
      totalDiffMs += chunk.timing.diffMs ?? 0;
    }
  }

  const skipPercentage =
    traceASize > 0 ? Number(((totalSkipped / traceASize) * 100).toFixed(2)) : 0;

  const summary: AggregatedSummary = {
    diffsFound: totalDiffs,
    semanticDiffs: totalSemantic,
    noiseDiffs: totalNoise,
    uncertainDiffs: totalUncertain,
    nodesVisited: totalVisited,
    nodesSkipped: totalSkipped,
    nodesBulkReported: totalBulk,
    skipPercentage,
    traceASize,
    traceBSize,
    timing: {
      parseMs: maxParseMs,
      treeBuildMs: maxTreeBuildMs,
      merkleBuildMs: maxMerkleBuildMs,
      diffMs: totalDiffMs,
      totalMs: maxParseMs + maxTreeBuildMs + maxMerkleBuildMs + totalDiffMs,
    },
  };

  return {
    jobId,
    summary,
    status: "COMPLETED",
  };
}
