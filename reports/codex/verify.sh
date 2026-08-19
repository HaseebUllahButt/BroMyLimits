#!/usr/bin/env bash
# Re-fetch the raw API payloads from the local dashboard and compare them
# against this published snapshot. If this package is scoped to one account
# (ONLY_ACCOUNT filter), the live payloads are filtered the same way first.
# Exit 0 if identical, 1 otherwise.
set -euo pipefail
cd "$(dirname "$0")"
BASE_URL="${BASE_URL:-http://127.0.0.1:47291}"
ONLY="${ONLY_ACCOUNT:-}"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

echo "== Re-fetching from $BASE_URL =="
curl -sf "$BASE_URL/api/usage"        -o "$TMP/usage.raw.json"
curl -sf "$BASE_URL/api/limit-history" -o "$TMP/limit-history.raw.json"
date -u +"fetched_at=%Y-%m-%dT%H:%M:%SZ"

if [ -n "$ONLY" ]; then
  echo "== Filtering live payloads to account: $ONLY =="
  python3 - "$TMP/usage.raw.json" "$TMP/usage.json" "$ONLY" <<'PYEOF'
import json, sys
d = json.load(open(sys.argv[1]))
d["accounts"] = [a for a in d["accounts"] if a["id"] == sys.argv[3]]
json.dump(d, open(sys.argv[2], "w"), indent=2)
PYEOF
  python3 - "$TMP/limit-history.raw.json" "$TMP/limit-history.json" "$ONLY" <<'PYEOF'
import json, sys
d = json.load(open(sys.argv[1]))
d["accounts"] = [a for a in d["accounts"] if a["id"] == sys.argv[3]]
json.dump(d, open(sys.argv[2], "w"), indent=2)
PYEOF
else
  mv "$TMP/usage.raw.json" "$TMP/usage.json"
  mv "$TMP/limit-history.raw.json" "$TMP/limit-history.json"
fi

echo "== Comparing against published snapshot (fetch timestamps normalized) =="
ok=1
for f in usage.json limit-history.json; do
  norm() {
    python3 - "$1" "$TMP/$(basename "$1").norm" <<'PYEOF'
import json, sys
src, dst = sys.argv[1], sys.argv[2]
d = json.load(open(src))
for k in ("fetchedAt", "generatedAt"):
    if k in d:
        d[k] = ""
for a in d.get("accounts", []):
    rl = a.get("rateLimits")
    if isinstance(rl, dict) and "ageMinutes" in rl:
        rl["ageMinutes"] = 0
json.dump(d, open(dst, "w"), indent=2)
print(dst)
PYEOF
  }
  wantf=$(norm "data/$f")
  gotf=$(norm "$TMP/$f")
  want=$(sha256sum "$wantf" | cut -d' ' -f1)
  got=$(sha256sum "$gotf" | cut -d' ' -f1)
  if [ "$want" = "$got" ]; then
    echo "OK   $f"
  else
    echo "MISMATCH $f (published=$want now=$got)"
    ok=0
  fi
done

echo "== Full package integrity check =="
sha256sum -c manifest.sha256 || ok=0

if [ "$ok" = 1 ]; then
  echo "ALL GOOD — snapshot still matches the live dashboard."
else
  echo "CHANGED — the dashboard data differs from this published snapshot." >&2
fi
exit $((1-ok))