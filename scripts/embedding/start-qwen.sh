#!/usr/bin/env bash
set -Eeuo pipefail

project_root=$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)
qwen_runtime="$project_root/.tools/llama-b10883/llama-b10883/llama-server"
qwen_model="$project_root/.tools/models/qwen3/Qwen3-Embedding-0.6B-Q8_0.gguf"
qwen_state_dir="$project_root/.artifacts/qwen-embedding"
qwen_port="${QWEN_EMBEDDING_PORT:-8092}"

if [[ ! "$qwen_port" =~ ^[0-9]+$ ]] || (( qwen_port < 1024 || qwen_port > 65535 )); then
  echo "QWEN_EMBEDDING_PORT must be between 1024 and 65535." >&2
  exit 1
fi
if [[ ! -x "$qwen_runtime" || ! -f "$qwen_model" ]]; then
  echo "Run python3 scripts/embedding/setup-qwen.py first." >&2
  exit 1
fi
umask 077
mkdir -p "$qwen_state_dir"
chmod 700 "$qwen_state_dir"
if [[ ! -s "$qwen_state_dir/api-key" ]]; then
  python3 - "$qwen_state_dir/api-key" <<'PY'
import os, secrets, sys
try:
    descriptor = os.open(sys.argv[1], os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
except FileExistsError:
    raise SystemExit("Existing empty key file must be repaired before starting")
with os.fdopen(descriptor, "w") as handle:
    handle.write(secrets.token_urlsafe(32) + "\n")
PY
fi
chmod 600 "$qwen_state_dir/api-key"

# Qwen: last-token pooling; llama.cpp's compatible endpoint returns pooled vectors.
# Keep CPU and context use bounded. The application submits one material chunk/request.
exec "$qwen_runtime" \
  --model "$qwen_model" \
  --alias qwen3-embedding-0.6b \
  --embedding --pooling last --embd-normalize 2 \
  --ctx-size 8192 --batch-size 8192 --ubatch-size 8192 \
  --parallel 1 --threads 4 --threads-batch 8 --gpu-layers 0 \
  --host 127.0.0.1 --port "$qwen_port" \
  --api-key-file "$qwen_state_dir/api-key" \
  --no-webui --no-slots --log-disable
