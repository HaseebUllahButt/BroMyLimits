#!/usr/bin/env bash
set -euo pipefail

if [[ "${OSTYPE:-}" != linux* ]]; then
  echo "cc-usage-dashboard currently supports Linux only." >&2
  exit 1
fi

if ! command -v node >/dev/null 2>&1; then
  echo "Node.js is required (Node 18+)." >&2
  exit 1
fi

node_major="$(node -p 'process.versions.node.split(".")[0]')"
if (( node_major < 18 )); then
  echo "Node.js 18+ is required; found $(node --version)." >&2
  exit 1
fi

if ! command -v ccusage >/dev/null 2>&1; then
  if ! command -v npm >/dev/null 2>&1; then
    echo "ccusage is required and was not found on PATH." >&2
    echo "npm is also unavailable, so it can't be installed automatically." >&2
    echo "Install Node.js/npm or ccusage manually, then run this script again." >&2
    exit 1
  fi
  echo "ccusage not found; installing it globally via npm..."
  if ! npm install -g ccusage; then
    echo "Failed to install ccusage via npm." >&2
    echo "Install it manually, then run this script again." >&2
    exit 1
  fi
  if ! command -v ccusage >/dev/null 2>&1; then
    echo "ccusage was installed but is not on PATH." >&2
    echo "Ensure npm's global bin directory is on your PATH, then run this script again." >&2
    exit 1
  fi
fi

default_port="${PORT:-47291}"
if [[ $# -gt 0 ]]; then
  port="$1"
else
  printf 'Which port should cc-usage-dashboard use? [%s]: ' "$default_port"
  read -r port
  port="${port:-$default_port}"
fi
if [[ ! "$port" =~ ^[0-9]+$ ]] || (( port < 1 || port > 65535 )); then
  echo "Usage: $0 [port]  (port must be 1-65535)" >&2
  exit 2
fi

source_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
install_dir="${XDG_DATA_HOME:-$HOME/.local/share}/cc-usage-dashboard"
bin_dir="${XDG_BIN_HOME:-$HOME/.local/bin}"
service_dir="${XDG_CONFIG_HOME:-$HOME/.config}/systemd/user"
service_file="$service_dir/cc-usage-dashboard.service"
node_bin="$(command -v node)"

mkdir -p "$install_dir/public" "$bin_dir" "$service_dir"
install -m 0644 "$source_dir/server.js" "$install_dir/server.js"
install -m 0644 "$source_dir/statusline.js" "$install_dir/statusline.js"
install -m 0755 "$source_dir/configure-statusline.js" "$install_dir/configure-statusline.js"
install -m 0644 "$source_dir/public/index.html" "$install_dir/public/index.html"

launcher="$bin_dir/cc-usage-dashboard"
cat > "$launcher" <<EOF
#!/usr/bin/env bash
set -euo pipefail
exec env PORT="\${1:-$port}" node "$install_dir/server.js"
EOF
chmod 0755 "$launcher"

declare -A configured_dirs=()
while IFS= read -r marker_path; do
  config_dir="$(dirname -- "$marker_path")"
  # Claude keeps the default account marker at ~/.claude.json, but its
  # settings belong in ~/.claude/. Never write settings.json into $HOME.
  [[ "$marker_path" == "$HOME/.claude.json" ]] && config_dir="$HOME/.claude"
  [[ -d "$config_dir" ]] || continue
  [[ -n "${configured_dirs[$config_dir]:-}" ]] && continue
  configured_dirs["$config_dir"]=1
  config_name="$(basename "$config_dir")"
  account_label="${config_name#.claude-}"
  [[ "$config_name" == ".claude" ]] && account_label="default"
  account_label="${account_label#.}"
  settings_path="$config_dir/settings.json"
  "$node_bin" "$install_dir/configure-statusline.js" \
    "$settings_path" "$node_bin" "$install_dir/statusline.js" "$account_label"
done < <(find "$HOME" -xdev \
  \( -path '*/node_modules' -o -path '*/.git' -o -path '*/.cache' -o -path '*/.npm' \
     -o -path '*/.venv' -o -path '*/venv' -o -path '*/.cargo' -o -path '*/.rustup' \
     -o -path '*/.Trash' -o -path '*/.local/share/Trash' \) -prune -o \
  -type f -name '.claude.json' -print 2>/dev/null | sort -u)

cat > "$service_file" <<EOF
[Unit]
Description=Claude Code usage dashboard
After=network-online.target

[Service]
Type=simple
Environment=PORT=$port
Environment=HOME=$HOME
Environment=PATH=$PATH
ExecStart=$node_bin $install_dir/server.js
WorkingDirectory=$install_dir
Restart=on-failure
RestartSec=3

[Install]
WantedBy=default.target
EOF

if ! command -v systemctl >/dev/null 2>&1; then
  echo "systemctl is required to install the dashboard daemon." >&2
  exit 1
fi

if ! systemctl --user daemon-reload; then
  echo "Could not reach your user systemd session." >&2
  echo "Run this from a logged-in Linux desktop/session; sudo is not normally needed." >&2
  exit 1
fi

systemctl --user enable --now cc-usage-dashboard.service

url="http://127.0.0.1:$port"

echo
echo "  ┌────────────────────────────────────────────────────┐"
echo "  │  ✅  Installed cc-usage-dashboard                  │"
echo "  │                                                    │"
echo "  │  ▶  Open dashboard:                                │"
echo "  │                                                    │"
echo "  │     $url                    │"
echo "  │                                                    │"
echo "  │  Accounts discovered from ~/.claude* ~/.codex*     │"
echo "  └────────────────────────────────────────────────────┘"
echo

if command -v xdg-open >/dev/null 2>&1; then
  (xdg-open "$url" 2>/dev/null &) || true
elif command -v open >/dev/null 2>&1; then
  (open "$url" 2>/dev/null &) || true
fi
