#!/usr/bin/env bash
set -euo pipefail

project_root=$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)

case "$(uname -s)" in
  MINGW*|MSYS*|CYGWIN*)
    devtools_root=$(cygpath -u "${DEVTOOLS_HOME:-D:/app/devtools}")
    node_dir="$devtools_root/node/24.21.0"
    pnpm_dir="$devtools_root/pnpm/12.6.0"
    for executable in "$node_dir/node.exe" "$pnpm_dir/pnpm.exe"; do
      if [[ ! -x "$executable" ]]; then
        echo "Project toolchain executable is missing: $executable" >&2
        exit 1
      fi
    done
    export PATH="$node_dir:$pnpm_dir:$PATH"
    export npm_config_manage_package_manager_versions=false
    if [[ "${1:-}" == dev:all ]]; then
      shift
      pwsh="$devtools_root/powershell/pwsh.exe"
      if [[ ! -x "$pwsh" ]]; then
        echo "PowerShell 7 executable is missing: $pwsh" >&2
        exit 1
      fi
      exec "$pwsh" -NoLogo -NoProfile -File "$(cygpath -w "$project_root/scripts/dev/start-all.ps1")" "$@"
    fi
    exec "$pnpm_dir/pnpm.exe" "$@"
    ;;
esac

if [[ ! -x "$project_root/.tools/node/bin/node" ]]; then
  echo "Project toolchain is missing. Run: bash scripts/dev/setup-toolchain.sh" >&2
  exit 1
fi

export PATH="$project_root/.tools/node/bin:$PATH"

exec pnpm "$@"
