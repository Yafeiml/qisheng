#!/usr/bin/env bash
set -euo pipefail

project_root=$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)
contract_tmp=$(mktemp -d)

cleanup() {
  rm -rf -- "$contract_tmp"
}
trap cleanup EXIT

cd "$project_root"
pnpm --filter @xhs-agentic/database... build
pnpm --filter @xhs-agentic/network-security build
pnpm --filter @xhs-agentic/wechat-miniapp build
pnpm --filter @xhs-agentic/api build
node scripts/contracts/check-content-safety-save.cjs
pnpm --filter @xhs-agentic/api openapi -- "$contract_tmp/openapi.json"
pnpm --filter @xhs-agentic/contracts exec openapi-typescript "$contract_tmp/openapi.json" -o "$contract_tmp/openapi.ts"
node scripts/contracts/validate-openapi.mjs "$contract_tmp/openapi.json" "$contract_tmp/openapi.ts"

cmp --silent "$contract_tmp/openapi.json" packages/contracts/openapi/openapi.json || {
  echo "OpenAPI document is stale. Run: pnpm contracts:generate" >&2
  exit 1
}

cmp --silent "$contract_tmp/openapi.ts" packages/contracts/src/generated/openapi.ts || {
  echo "Generated TypeScript contracts are stale. Run: pnpm contracts:generate" >&2
  exit 1
}

echo "OpenAPI document and generated TypeScript contracts are current."
