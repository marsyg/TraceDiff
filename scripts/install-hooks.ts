#!/usr/bin/env bun
/**
 * scripts/install-hooks.ts
 * Writes git pre-commit and pre-push hooks.
 * Run once after cloning: bun run hooks:install
 */
import { mkdirSync, writeFileSync, chmodSync, existsSync } from "fs";
import { join } from "path";

const hooksDir = join(import.meta.dir, "..", ".git", "hooks");

if (!existsSync(join(import.meta.dir, "..", ".git"))) {
  console.error("❌ Not a git repo. Run 'git init' first.");
  process.exit(1);
}

mkdirSync(hooksDir, { recursive: true });

// pre-commit: run Biome on staged .ts/.js files
const preCommit = `#!/bin/sh
# TraceDiff pre-commit hook — runs Biome on staged files
STAGED=$(git diff --cached --name-only --diff-filter=ACM | grep -E '\\.(ts|js)$')
if [ -z "$STAGED" ]; then
  exit 0
fi
echo "🔍 Biome checking staged files..."
./node_modules/.bin/biome check --no-errors-on-unmatched $STAGED
if [ $? -ne 0 ]; then
  echo ""
  echo "❌ Biome found issues. Run 'bun run lint:fix && bun run format' then re-stage."
  exit 1
fi
echo "✅ Biome clean"
`;

// pre-push: typecheck
const prePush = `#!/bin/sh
# TraceDiff pre-push hook — runs TypeScript type check
echo "🔍 Type checking..."
./node_modules/.bin/tsc --noEmit
if [ $? -ne 0 ]; then
  echo ""
  echo "❌ Type errors found. Fix them before pushing."
  exit 1
fi
echo "✅ Types clean"
`;

writeFileSync(join(hooksDir, "pre-commit"), preCommit, "utf8");
writeFileSync(join(hooksDir, "pre-push"), prePush, "utf8");

// Make executable (no-op on Windows but correct on Mac/Linux)
try {
  chmodSync(join(hooksDir, "pre-commit"), 0o755);
  chmodSync(join(hooksDir, "pre-push"), 0o755);
} catch {}

console.log("✅ Git hooks installed:");
console.log("   pre-commit  → biome check on staged .ts/.js files");
console.log("   pre-push    → tsc --noEmit");
