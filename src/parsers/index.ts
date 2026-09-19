import type { TraceNode } from "../core/type.js";
import { parseFlatSpans } from "./json-flat.js";
import { parseJsonTree } from "./json-tree.js";
import { parseOtel } from "./otel.js";

export { parseFlatSpans } from "./json-flat.js";
export { parseJsonTree } from "./json-tree.js";
export { parseOtel } from "./otel.js";

/**
 * Automatically detect trace format and parse into a unified TraceNode tree.
 */
export function autoDetect(raw: unknown): TraceNode {
  if (Array.isArray(raw)) {
    return parseFlatSpans(raw);
  }
  if (raw && typeof raw === "object") {
    if ("resourceSpans" in raw) {
      return parseOtel(raw);
    }
    if ("children" in raw) {
      return parseJsonTree(raw);
    }
  }
  throw new Error("Unknown trace format: input does not match any supported trace schema");
}
