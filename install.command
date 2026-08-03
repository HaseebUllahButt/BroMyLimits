#!/bin/sh
set -eu

SCRIPT_DIR="$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)"
exec /usr/bin/env node "$SCRIPT_DIR/install.js" "$@"
