// JSON.stringify is order-sensitive to object key insertion order. Two
// semantically identical attribute objects built via different code paths
// (different parsers, different rule application order) can have different
// key order and therefore hash differently under plain JSON.stringify.
// This is fatal for a diff tool: it means false positives caused by nothing
// but how the input happened to be serialized. Always hash through this,
// never through JSON.stringify directly.
export function canonicalStringify(value: unknown): string {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map(canonicalStringify).join(",")}]`;
  }
  const keys = Object.keys(value as Record<string, unknown>).sort();
  const entries = keys.map(
    (key) =>
      `${JSON.stringify(key)}:${canonicalStringify((value as Record<string, unknown>)[key])}`,
  );
  return `{${entries.join(",")}}`;
}
