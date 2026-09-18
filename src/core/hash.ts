import { createHash } from "node:crypto";

// Must sort object keys recursively.
export function canonicalSerialize(obj: unknown): string {
  if (obj === null || typeof obj !== "object") return JSON.stringify(obj);
  if (Array.isArray(obj)) return `[${obj.map(canonicalSerialize).join(",")}]`;
  const keys = Object.keys(obj as Record<string, unknown>).sort();
  const entries = keys.map(
    (k) => `${JSON.stringify(k)}:${canonicalSerialize((obj as Record<string, unknown>)[k])}`,
  );
  return `{${entries.join(",")}}`;
}

export function computeHash(input: string): string {
  return createHash("sha256").update(input).digest("hex");
}
