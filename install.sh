#!/usr/bin/env sh
set -eu

command -v node >/dev/null 2>&1 || {
  echo "cc-usage-dashboard: Node.js 20+ is required." >&2
  exit 1
}

exec node "$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)/install.js" "$@"
