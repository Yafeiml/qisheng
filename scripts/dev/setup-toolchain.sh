#!/usr/bin/env bash
set -euo pipefail

project_root=$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)
node_version="v$(cat "$project_root/.node-version" | tr -d '[:space:]')"
node_archive="node-$node_version-linux-x64.tar.xz"
node_url="https://nodejs.org/dist/$node_version"
node_install_dir="$project_root/.tools/node-$node_version-linux-x64"
node_link="$project_root/.tools/node"
mc_release="RELEASE.2025-08-13T08-35-41Z"
mc_checksum="01f866e9c5f9b87c2b09116fa5d7c06695b106242d829a8bb32990c00312e891"
mc_install_path="$project_root/.tools/bin/mc"
tool_tmp_dir=""
mc_tmp_dir=""

cleanup() {
  if [[ -n "$tool_tmp_dir" ]]; then rm -r -- "$tool_tmp_dir"; fi
  if [[ -n "$mc_tmp_dir" ]]; then rm -r -- "$mc_tmp_dir"; fi
}
trap cleanup EXIT

if [[ -x "$node_link/bin/node" ]] && [[ "$($node_link/bin/node --version)" == "$node_version" ]]; then
  echo "Node $node_version is already installed for this project."
else
  if [[ -e "$node_install_dir" ]]; then
    echo "Toolchain target exists but is incomplete: $node_install_dir" >&2
    exit 1
  fi
  tool_tmp_dir=$(mktemp -d)
  curl -fsSL "$node_url/SHASUMS256.txt" -o "$tool_tmp_dir/SHASUMS256.txt"
  curl -fsSL "$node_url/$node_archive" -o "$tool_tmp_dir/$node_archive"
  (
    cd "$tool_tmp_dir"
    grep " $node_archive$" SHASUMS256.txt | sha256sum -c -
  )
  mkdir -p "$project_root/.tools"
  tar -xJf "$tool_tmp_dir/$node_archive" -C "$project_root/.tools"
  ln -sfn "node-$node_version-linux-x64" "$node_link"
fi

export PATH="$node_link/bin:$PATH"
package_manager=$(node -p "require('$project_root/package.json').packageManager")
if [[ ! -x "$node_link/bin/pnpm" ]] || [[ "$(pnpm --version)" != "${package_manager#pnpm@}" ]]; then
  npm install --global --prefix "$node_link" --ignore-scripts "$package_manager"
fi

if [[ ! -x "$mc_install_path" ]] || ! "$mc_install_path" --version | grep -q "$mc_release"; then
  mc_tmp_dir=$(mktemp -d)
  curl -fsSL \
    "https://dl.min.io/client/mc/release/linux-amd64/archive/mc.$mc_release" \
    -o "$mc_tmp_dir/mc"
  printf '%s  %s\n' "$mc_checksum" "$mc_tmp_dir/mc" | sha256sum -c -
  mkdir -p "$(dirname "$mc_install_path")"
  install -m 0755 "$mc_tmp_dir/mc" "$mc_install_path"
else
  echo "MinIO Client $mc_release is already installed for this project."
fi

echo "Toolchain ready: Node $(node --version), pnpm $(pnpm --version), mc $mc_release."
