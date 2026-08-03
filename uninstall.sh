#!/usr/bin/env sh
set -eu

command -v node >/dev/null 2>&1 || {
  echo "cc-usage-dashboard: Node.js is required to uninstall." >&2
  exit 1
}

SCRIPT_DIR="$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)"
exec node "$SCRIPT_DIR/uninstall.js" "$@"
