import { readFileSync } from "node:fs";

const file = process.argv[2];
if (!file) {
  console.error("Usage: bun run scripts/dump-semantic.ts <summary.json>");
  process.exit(1);
}

const summary = JSON.parse(readFileSync(file, "utf8"));

console.log(`semantic: ${summary.semantic.length}`);
console.log(`noise:    ${summary.noise.length}`);
console.log(`uncertain: ${summary.uncertain.length}`);
console.log(`skip %:   ${summary.skipPercentage.toFixed(2)}`);
console.log("");
console.log("─── semantic diffs ───");
for (const d of summary.semantic) {
  const path = (d.pathA ?? d.pathB ?? []).join(" / ");
  console.log(`[${d.type}] ${path}`);
  console.log(`   ${d.description}`);
  console.log("");
}