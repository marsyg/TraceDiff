#!/usr/bin/env bash
# TraceDiff AWS Infrastructure Deployment Script
# 
# Prerequisites:
# - Bun (for bundling TypeScript handlers to Node 22 JavaScript)
# - AWS SAM CLI
# - Configured AWS credentials (AWS_PROFILE or environment variables)

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(cd "${SCRIPT_DIR}/.." && pwd)"

echo "=== [1/3] Bundling Lambda handlers with Bun ==="
cd "${ROOT_DIR}"
bun run build

echo "=== [2/3] Building SAM application ==="
sam build --template infra/template.yaml

echo "=== [3/3] Deploying CloudFormation stack ==="
sam deploy --guided
