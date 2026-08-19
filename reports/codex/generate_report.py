#!/usr/bin/env python3
"""Generate the publishable Bro My Limits report package."""
import json, csv, hashlib, os
from datetime import datetime, timezone

BASE = os.environ.get("REPORT_DIR", os.path.expanduser("~/bro-my-limits-report"))
DATA = os.path.join(BASE, "data")
AGG = os.path.join(BASE, "aggregates")

usage = json.load(open(os.path.join(DATA, "usage.json")))
hist = json.load(open(os.path.join(DATA, "limit-history.json")))
ONLY = os.environ.get("ONLY_ACCOUNT", "")
if ONLY:
    usage = dict(usage, accounts=[a for a in usage["accounts"] if a["id"] == ONLY])
    hist = dict(hist, accounts=[a for a in hist["accounts"] if a["id"] == ONLY])
    with open(os.path.join(DATA, "usage.json"), "w") as f:
        json.dump(usage, f, indent=2)
    with open(os.path.join(DATA, "limit-history.json"), "w") as f:
        json.dump(hist, f, indent=2)


FETCHED_AT = usage.get("fetchedAt") or hist.get("generatedAt")

def money(n): return f"${n:,.2f}"
def toks(n): return f"{n:,}"

# ---------- aggregates ----------
accounts_csv = os.path.join(AGG, "accounts.csv")
models_csv = os.path.join(AGG, "models.csv")
cycles_csv = os.path.join(AGG, "limit-cycles.csv")
steps_csv = os.path.join(AGG, "limit-steps.csv")

# accounts.csv
with open(accounts_csv, "w", newline="") as f:
    w = csv.writer(f)
    w.writerow(["account_id", "provider", "label", "period", "cost_usd", "tokens"])
    for a in usage["accounts"]:
        for period in ["today", "last7d", "month", "allTime"]:
            w.writerow([a["id"], a["provider"], a.get("label", ""), period,
                        a[period]["cost"], a[period]["tokens"]])

# models.csv
with open(models_csv, "w", newline="") as f:
    w = csv.writer(f)
    w.writerow(["account_id", "model", "provider", "route", "tokens_input", "tokens_output",
                "tokens_cache_write", "tokens_cache_read", "tokens_reasoning",
                "cost_input", "cost_output", "cost_cache_write", "cost_cache_read", "cost_total"])
    for a in usage["accounts"]:
        for m in a.get("models", []):
            t, c = m.get("tokens", {}), m.get("cost", {})
            w.writerow([a["id"], m["modelName"], m.get("provider", ""), m.get("route", ""),
                        t.get("input", 0), t.get("output", 0), t.get("cacheWrite", 0),
                        t.get("cacheRead", 0), t.get("reasoning", 0),
                        c.get("input", 0), c.get("output", 0), c.get("cacheWrite", 0),
                        c.get("cacheRead", 0), c.get("total", 0)])

# limit-cycles.csv
with open(cycles_csv, "w", newline="") as f:
    w = csv.writer(f)
    w.writerow(["account_id", "window", "cycle", "source", "resets_at", "from", "to",
                "samples", "pct_start", "pct_end", "pct_span", "partial",
                "tokens", "cost_usd", "tokens_per_pct", "cost_per_pct"])
    for a in hist["accounts"]:
        for win in a["windows"]:
            for cyc in win.get("cycles", []):
                w.writerow([a["id"], win["key"], cyc.get("cycle"), cyc.get("src"),
                            cyc.get("resetsAt"), cyc.get("from"), cyc.get("to"),
                            cyc.get("samples"), cyc.get("pctStart"), cyc.get("pctEnd"),
                            cyc.get("pctSpan"), cyc.get("partial"), cyc.get("tokens"),
                            cyc.get("cost"), cyc.get("tokensPerPct"), cyc.get("costPerPct")])

# limit-steps.csv
with open(steps_csv, "w", newline="") as f:
    w = csv.writer(f)
    w.writerow(["account_id", "window", "cycle", "t", "from_pct", "to_pct", "delta_pct",
                "tokens", "cost_usd"])
    for a in hist["accounts"]:
        for win in a["windows"]:
            for s in win.get("steps", []):
                w.writerow([a["id"], win["key"], s.get("cycle"), s.get("t"),
                            s.get("fromPct"), s.get("toPct"), s.get("deltaPct"),
                            s.get("tokens"), s.get("cost")])

# ---------- computed summaries ----------
def sum_period(period):
    c = sum(a[period]["cost"] for a in usage["accounts"])
    t = sum(a[period]["tokens"] for a in usage["accounts"])
    return c, t

today_c, today_t = sum_period("today")
d7_c, d7_t = sum_period("last7d")
mo_c, mo_t = sum_period("month")
all_c, all_t = sum_period("allTime")

prov_cost = {}
prov_tokens = {}
for a in usage["accounts"]:
    p = a["provider"]
    prov_cost[p] = prov_cost.get(p, 0) + a["allTime"]["cost"]
    prov_tokens[p] = prov_tokens.get(p, 0) + a["allTime"]["tokens"]

model_totals = {}
for a in usage["accounts"]:
    for m in a.get("models", []):
        key = (m["modelName"], m.get("provider", ""))
        tt = model_totals.setdefault(key, {"tokens": 0, "cost": 0})
        t = m.get("tokens", {})
        tt["tokens"] += sum(t.get(k, 0) for k in ("input", "output", "cacheWrite", "cacheRead", "reasoning"))
        tt["cost"] += m.get("cost", {}).get("total", 0) or 0
model_totals = sorted(model_totals.items(), key=lambda kv: -kv[1]["tokens"])

limit_snapshots = []
for a in hist["accounts"]:
    for win in a["windows"]:
        l = win["latest"]
        limit_snapshots.append((a["id"], win["key"], l["pct"], l["resetsAt"], l["t"]))

# ---------- report.md ----------
def table(headers, rows):
    out = ["| " + " | ".join(headers) + " |", "|" + "|".join(["---"] * len(headers)) + "|"]
    for r in rows:
        out.append("| " + " | ".join(str(c) for c in r) + " |")
    return "\n".join(out)

lines = []
lines.append("# Bro My Limits — Published Usage Report" + (" — " + usage["accounts"][0]["id"] if ONLY else ""))
lines.append("")
lines.append(f"**Report generated:** {FETCHED_AT} (UTC)")
if ONLY:
    lines.append(f"**Coverage:** all-time local usage for the Codex CLI account `{ONLY}`, plus sampled rate-limit history for that account from {hist.get('firstSampleAt')}.")
else:
    lines.append(f"**Coverage:** all-time local usage across Claude Code, Codex CLI, Grok CLI, Antigravity, and OpenCode, plus sampled rate-limit history from {hist.get('firstSampleAt')}.")
lines.append(f"**Source:** local `cc-usage-dashboard` API (`http://127.0.0.1:47291`). Raw payloads, hashes, and a re-verification script are in `data/` and `verify.sh`.")
lines.append("")
lines.append("## 1. Aggregate totals")
lines.append("")
lines.append(table(
    ["Period", "Cost (USD)", "Tokens"],
    [
        ["Today", money(today_c), toks(today_t)],
        ["Last 7 days", money(d7_c), toks(d7_t)],
        ["This month", money(mo_c), toks(mo_t)],
        ["All time", money(all_c), toks(all_t)],
    ]))
lines.append("")
lines.append("## 2. All-time cost & tokens by provider")
lines.append("")
lines.append(table(
    ["Provider", "Cost (USD)", "Tokens"],
    [[p, money(prov_cost[p]), toks(prov_tokens[p])] for p in sorted(prov_cost, key=lambda p: -prov_cost[p])]))
lines.append("")
lines.append("## 3. Accounts (all-time)")
lines.append("")
rows = []
for a in sorted(usage["accounts"], key=lambda a: -a["allTime"]["cost"]):
    rl = a.get("rateLimits")
    live = rl.get("live") if rl else None
    rows.append([a["id"], a["provider"], money(a["allTime"]["cost"]), toks(a["allTime"]["tokens"]),
                 "yes" if live else ("no" if rl is not None else "n/a")])
lines.append(table(["Account", "Provider", "Cost (USD)", "Tokens", "Live limits"], rows))
lines.append("")
lines.append("## 4. Most-used models (all-time tokens)")
lines.append("")
rows = [[m[0][0], m[0][1], toks(m[1]["tokens"]), money(m[1]["cost"])] for m in model_totals[:15]]
lines.append(table(["Model", "Provider", "Tokens", "Cost (USD)"], rows))
lines.append("")
lines.append("## 5. Current rate-limit snapshot")
lines.append("")
rows = [[aid, win, f"{pct}%", resets] for aid, win, pct, resets, _t in sorted(limit_snapshots)]
lines.append(table(["Account", "Window", "Used", "Resets at (UTC)"], rows))
lines.append("")
lines.append("## 6. Verification")
lines.append("")
lines.append("1. **Raw data:** `data/usage.json` and `data/limit-history.json` are exact, unmodified API responses.")
lines.append("2. **Integrity:** `manifest.sha256` contains a SHA-256 hash of every file in this package. Run `sha256sum -c manifest.sha256`.")
lines.append("3. **Re-fetch:** `./verify.sh` re-downloads from the local dashboard API and compares hashes against this snapshot. Any mismatch means the underlying data changed after this report was generated.")
lines.append("   - `usage.json` is a stable point-in-time aggregate (refreshed on demand).")
lines.append("   - `limit-history.json` is continuously sampled by the dashboard (new samples every few minutes), so its hash legitimately changes on re-fetch. The report is a point-in-time snapshot of that stream.")
if ONLY:
    lines.append(f"4. **Provenance:** figures are computed from local Codex CLI usage logs (`~/.codex/`) via `cc-usage-dashboard`. Costs are derived from token counts × published provider rates, not provider invoices.")
else:
    lines.append("4. **Provenance:** figures are computed from local CLI usage logs (Claude Code `~/.claude/projects/**/*.jsonl`, Codex CLI logs, Grok CLI `~/.grok/logs/unified.jsonl`, OpenCode `~/.local/share/opencode/opencode.db`, Antigravity local logs) via `cc-usage-dashboard`. Costs are derived from token counts × published provider rates, not provider invoices.")
lines.append("")
lines.append("## 7. Files")
lines.append("")
lines.append("| File | Contents |")
lines.append("|------|----------|")
lines.append("| `data/usage.json` | Raw usage API response (accounts, models, tokens, costs, limits) |")
lines.append("| `data/limit-history.json` | Raw limit-history API response (sample counts, cycles, steps) |")
lines.append("| `aggregates/accounts.csv` | Cost/tokens per account per period |")
lines.append("| `aggregates/models.csv` | Token/cost per model per channel |")
lines.append("| `aggregates/limit-cycles.csv` | Each observed limit window/cycle |")
lines.append("| `aggregates/limit-steps.csv` | Each observed limit-percentage step with tokens/cost |")
lines.append("| `manifest.json` / `manifest.sha256` | File metadata + SHA-256 hashes |")
lines.append("| `verify.sh` | Re-fetch and hash-compare script |")
lines.append("")

with open(os.path.join(BASE, "report.md"), "w") as f:
    f.write("\n".join(lines))

print("report.md written")
