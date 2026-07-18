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

declare -A configured_dirs=()
while IFS= read -r marker_path; do
  config_dir="$(dirname -- "$marker_path")"
  # The default account marker lives in $HOME, while its settings live in the
  # hidden ~/.claude directory.
  [[ "$marker_path" == "$HOME/.claude.json" ]] && config_dir="$HOME/.claude"
  [[ -d "$config_dir" ]] || continue
  [[ -n "${configured_dirs[$config_dir]:-}" ]] && continue
  configured_dirs["$config_dir"]=1
  settings_path="$config_dir/settings.json"
  backup_path="$settings_path.cc-usage-backup"
  if [[ -f "$backup_path" ]]; then
    mv -f "$backup_path" "$settings_path"
  fi
done < <(find "$HOME" -xdev \
  \( -path '*/node_modules' -o -path '*/.git' -o -path '*/.cache' -o -path '*/.npm' \
     -o -path '*/.venv' -o -path '*/venv' -o -path '*/.cargo' -o -path '*/.rustup' \
     -o -path '*/.Trash' -o -path '*/.local/share/Trash' \) -prune -o \
  -type f -name '.claude.json' -print 2>/dev/null | sort -u)

rm -f "$service_file" "$launcher"
if [[ -d "$install_dir" && "$install_dir" != "$HOME" && "$install_dir" != / ]]; then
  rm -rf "$install_dir"
fi

echo "cc-usage-dashboard has been uninstalled."
echo "The source checkout was not removed."
