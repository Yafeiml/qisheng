#!/usr/bin/env bash
set -Eeuo pipefail

project_root=$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)
source_dir="$project_root/apps/employee-miniapp"

# The IDE rejects WSL UNC paths. Only native miniapp sources belong in this mirror.
windows_profile=$(pwsh.exe -NoProfile -NonInteractive -Command '[Console]::OutputEncoding = [System.Text.Encoding]::UTF8; [Environment]::GetFolderPath("UserProfile")' | tr -d '\r\n')
target_dir="$(wslpath -u "$windows_profile")/WeChatProjects/qisheng-opensource-employee-miniapp"
marker="$target_dir/.qisheng-opensource-miniapp-mirror"

if [[ -d "$target_dir" && ! -f "$marker" ]] && [[ -n "$(ls -A "$target_dir")" ]]; then
  echo "Refusing to overwrite an existing, unmanaged project: $target_dir" >&2
  exit 1
fi

mkdir -p "$target_dir"
touch "$marker"

if [[ ! -f "$target_dir/config.ts" ]]; then
  cp "$source_dir/config.ts" "$target_dir/config.ts"
fi

if [[ ! -f "$target_dir/project.config.json" ]]; then
  cp "$source_dir/project.config.json" "$target_dir/project.config.json"
fi

# Excluded files (including IDE private settings) are never copied or deleted.
rsync --recursive --checksum --delete --prune-empty-dirs \
  --exclude='node_modules/' \
  --exclude='project.config.json' \
  --exclude='config.ts' \
  --exclude='project.private.config.json' \
  --exclude='package.json' \
  --exclude='tsconfig.json' \
  --include='*/' \
  --include='*.ts' \
  --include='*.js' \
  --include='*.json' \
  --include='*.wxml' \
  --include='*.wxss' \
  --include='*.png' \
  --include='*.jpg' \
  --include='*.jpeg' \
  --include='*.webp' \
  --include='*.svg' \
  --include='LICENSE*' \
  --exclude='*' \
  "$source_dir/" "$target_dir/"

printf 'Windows miniapp project: %s\n' "$(wslpath -w "$target_dir")"
printf 'Configure config.ts and your own AppID in this isolated open-source project.\n'
printf 'Edit sources in %s, then rerun this script to sync.\n' "$source_dir"
