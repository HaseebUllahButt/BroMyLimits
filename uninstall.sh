#!/usr/bin/env bash
set -euo pipefail

if [[ "${OSTYPE:-}" != linux* ]]; then
  echo "cc-usage-dashboard currently supports Linux only." >&2
  exit 1
fi

install_dir="${XDG_DATA_HOME:-$HOME/.local/share}/cc-usage-dashboard"
bin_dir="${XDG_BIN_HOME:-$HOME/.local/bin}"
service_dir="${XDG_CONFIG_HOME:-$HOME/.config}/systemd/user"
service_file="$service_dir/cc-usage-dashboard.service"
launcher="$bin_dir/cc-usage-dashboard"

if command -v systemctl >/dev/null 2>&1; then
  systemctl --user disable --now cc-usage-dashboard.service 2>/dev/null || true
  systemctl --user daemon-reload 2>/dev/null || true
fi

for config_dir in "$HOME"/.claude "$HOME"/.claude-*; do
  [[ -d "$config_dir" && -f "$config_dir/.claude.json" ]] || continue
  settings_path="$config_dir/settings.json"
  backup_path="$settings_path.cc-usage-backup"
  if [[ -f "$backup_path" ]]; then
    mv -f "$backup_path" "$settings_path"
  fi
done

rm -f "$service_file" "$launcher"
if [[ -d "$install_dir" && "$install_dir" != "$HOME" && "$install_dir" != / ]]; then
  rm -rf "$install_dir"
fi

echo "cc-usage-dashboard has been uninstalled."
echo "The source checkout was not removed."
