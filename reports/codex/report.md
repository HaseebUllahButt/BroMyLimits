# Bro My Limits — Published Usage Report — codex-default

**Report generated:** 2026-08-19T06:46:47.867Z (UTC)
**Coverage:** all-time local usage for the Codex CLI account `codex-default`, plus sampled rate-limit history for that account from 2026-07-19T08:50:06.238Z.
**Source:** local `cc-usage-dashboard` API (`http://127.0.0.1:47291`). Raw payloads, hashes, and a re-verification script are in `data/` and `verify.sh`.

## 1. Aggregate totals

| Period | Cost (USD) | Tokens |
|---|---|---|
| Today | $0.00 | 0 |
| Last 7 days | $19.77 | 310,995,935 |
| This month | $260.83 | 1,373,817,620 |
| All time | $342.76 | 1,648,341,930 |

## 2. All-time cost & tokens by provider

| Provider | Cost (USD) | Tokens |
|---|---|---|
| codex | $342.76 | 1,648,341,930 |

## 3. Accounts (all-time)

| Account | Provider | Cost (USD) | Tokens | Live limits |
|---|---|---|---|---|
| codex-default | codex | $342.76 | 1,648,341,930 | yes |

## 4. Most-used models (all-time tokens)

| Model | Provider | Tokens | Cost (USD) |
|---|---|---|---|
| gpt-5.6-luna | OpenAI | 1,233,080,249 | $40.40 |
| gpt-5.6-sol | OpenAI | 380,573,277 | $284.15 |
| gpt-5.6-terra | OpenAI | 21,924,204 | $7.09 |
| gpt-5.5 | OpenAI | 12,574,901 | $11.07 |
| chatgpt-web/high | Google | 128,118 | $0.00 |
| gpt-5.4-mini | OpenAI | 61,181 | $0.03 |

## 5. Current rate-limit snapshot

| Account | Window | Used | Resets at (UTC) |
|---|---|---|---|
| codex-default | weekly | 32% | 2026-08-20T08:14:15.000Z |

## 6. Verification

1. **Raw data:** `data/usage.json` and `data/limit-history.json` are exact, unmodified API responses.
2. **Integrity:** `manifest.sha256` contains a SHA-256 hash of every file in this package. Run `sha256sum -c manifest.sha256`.
3. **Re-fetch:** `./verify.sh` re-downloads from the local dashboard API and compares hashes against this snapshot. Any mismatch means the underlying data changed after this report was generated.
   - `usage.json` is a stable point-in-time aggregate (refreshed on demand).
   - `limit-history.json` is continuously sampled by the dashboard (new samples every few minutes), so its hash legitimately changes on re-fetch. The report is a point-in-time snapshot of that stream.
4. **Provenance:** figures are computed from local Codex CLI usage logs (`~/.codex/`) via `cc-usage-dashboard`. Costs are derived from token counts × published provider rates, not provider invoices.

## 7. Files

| File | Contents |
|------|----------|
| `data/usage.json` | Raw usage API response (accounts, models, tokens, costs, limits) |
| `data/limit-history.json` | Raw limit-history API response (sample counts, cycles, steps) |
| `aggregates/accounts.csv` | Cost/tokens per account per period |
| `aggregates/models.csv` | Token/cost per model per channel |
| `aggregates/limit-cycles.csv` | Each observed limit window/cycle |
| `aggregates/limit-steps.csv` | Each observed limit-percentage step with tokens/cost |
| `manifest.json` / `manifest.sha256` | File metadata + SHA-256 hashes |
| `verify.sh` | Re-fetch and hash-compare script |
