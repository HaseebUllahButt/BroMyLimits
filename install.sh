#!/usr/bin/env sh
set -eu

# Both a checkout entrypoint and a pipeable bootstrap. In pipe mode fetch a
# source archive over HTTPS, and remove it even when installation fails.
if [ -f "$(dirname -- "$0")/install.js" ] && [ -f "$(dirname -- "$0")/server.js" ]; then
  install_source=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
else
  command -v curl >/dev/null 2>&1 || { echo 'Bro My Limits: curl is required.' >&2; exit 1; }
  command -v tar >/dev/null 2>&1 || { echo 'Bro My Limits: tar is required.' >&2; exit 1; }
  install_tmp=$(mktemp -d)
  trap 'rm -rf "$install_tmp"' EXIT HUP INT TERM
  install_ref=${BRO_MY_LIMITS_REF:-main}
  curl -fLsS --retry 3 "https://codeload.github.com/HaseebUllahButt/BroMyLimits/tar.gz/$install_ref" -o "$install_tmp/source.tar.gz"
  mkdir "$install_tmp/source"
  tar -xzf "$install_tmp/source.tar.gz" --strip-components=1 -C "$install_tmp/source"
  install_source=$install_tmp/source
fi
command -v node >/dev/null 2>&1 || { echo 'Bro My Limits: Node.js 20+ is required (22+ for Helm).' >&2; exit 1; }
node -e 'if (Number(process.versions.node.split(".")[0]) < 20) process.exit(1)' || {
  echo 'Bro My Limits: upgrade Node.js to 20+ (22+ for Helm).' >&2; exit 1;
}
node "$install_source/install.js" "$@"
