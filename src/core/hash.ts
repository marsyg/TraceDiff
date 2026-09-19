import { createHash } from "node:crypto";

/**
 * Deterministically serializes arbitrary trace values and attribute objects.
 *
 * Standard JSON.stringify does not guarantee object key order across JavaScript
 * runtimes or differing property insertion sequences. Because Merkle hashing
 * requires identical subtrees to generate bitwise-identical digests, this
 * function recursively sorts object keys before serialization.
 */
export function canonicalSerialize(obj: unknown): string {
  if (obj === null || typeof obj !== "object") return JSON.stringify(obj);
  if (Array.isArray(obj)) return `[${obj.map(canonicalSerialize).join(",")}]`;
  const keys = Object.keys(obj as Record<string, unknown>).sort();
  const entries = keys.map(
    (k) => `${JSON.stringify(k)}:${canonicalSerialize((obj as Record<string, unknown>)[k])}`,
  );
  return `{${entries.join(",")}}`;
}

/**
 * Computes a standard SHA-256 hexadecimal hash digest for Merkle DAG nodes.
 */
export function computeHash(input: string): string {
  return createHash("sha256").update(input).digest("hex");
}
