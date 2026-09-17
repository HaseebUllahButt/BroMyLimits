# CC Usage Dashboard

Local dashboard for Claude Code, Codex, Devin, Grok, Antigravity/Pi, and
OpenCode usage: what each account spent, how much of it the prompt cache
paid for, and how much of every rate-limit window is left.

It reads only what the agents already wrote on this machine. A background
refresh makes no network requests at all.

## Windows quick setup

Requires Windows 10/11, Node.js 20 or newer, and Git. Install missing
requirements with WinGet, then close and reopen PowerShell:

```powershell
winget install --id OpenJS.NodeJS.LTS -e
winget install --id Git.Git -e
```

### One-line Windows install

Paste this single line into PowerShell. It downloads the latest version to a
temporary folder and installs the dashboard without requiring administrator
access:

```powershell
$ErrorActionPreference='Stop'; $setupDir=Join-Path $env:TEMP ('BroMyLimits-'+[guid]::NewGuid()); git clone --depth 1 https://github.com/HaseebUllahButt/BroMyLimits.git $setupDir; powershell -NoProfile -ExecutionPolicy Bypass -File (Join-Path $setupDir 'install.ps1') 47291
```

Start the dashboard and keep the PowerShell window open:

```powershell
& "$env:LOCALAPPDATA\bin\cc-usage-dashboard.cmd"
```

Open <http://127.0.0.1:47291>. To use a different default port, replace the
final `47291` in the install command; the generated launcher remembers it. You
can also pass a temporary override when starting, such as
`cc-usage-dashboard.cmd 3000`.

If you already downloaded this repository, install directly from its folder:

```powershell
Set-ExecutionPolicy -Scope Process -ExecutionPolicy Bypass
.\install.ps1 47291
```

The Windows installation lives in `%LOCALAPPDATA%\cc-usage-dashboard`; its
launcher is `%LOCALAPPDATA%\bin\cc-usage-dashboard.cmd`. The installer also
attempts to install `ccusage` locally and configures detected Claude profiles. Add
`--no-statusline` if you do not want Claude statusline configuration, or
`--no-browser` if you do not want the installer to open the dashboard URL.

To uninstall and restore backed-up Claude settings:

```powershell
node "$env:LOCALAPPDATA\cc-usage-dashboard\uninstall.js"
```

### Build a portable Windows package

Create a self-contained Windows ZIP with Node.js and `ccusage` bundled:

```powershell
npm run build:windows
```

The build is written to `dist/cc-usage-dashboard-v<version>-windows-<arch>.zip`.
After extracting it on another Windows computer, run `start-dashboard.cmd`.
The portable build does not require Node.js on the target computer.

## Linux and macOS setup

Requires Node.js 20 or newer. From this directory:

```sh
./install.sh 47291
```

One-line install:

```sh
d="$(mktemp -d)" && git clone --depth 1 https://github.com/HaseebUllahButt/BroMyLimits.git "$d/BroMyLimits" && "$d/BroMyLimits/install.sh" 47291
```

On macOS, run `install.sh` in Terminal or double-click `install.command`. The
installer creates a user-local app directory and launcher, installs `ccusage`,
enables a user service, and opens the dashboard. Use `--skip-deps`,
`--no-statusline`, `--no-service`, or `--no-browser` to disable those parts.

Start it with `cc-usage-dashboard`, then open <http://127.0.0.1:47291>.
Uninstall with `./uninstall.sh` from the source checkout.

## Prompt cache

A cached input token bills at a fraction of a fresh one - an eighth on Claude,
a tenth on the OpenAI rate card. On agent sessions, where the same context is
resent every turn, the hit rate is most of the difference between the bill and
what it could have been, so the dashboard shows it next to the spend: what
share of input tokens came back out of the cache, and what that was worth.

Two figures, because caching is not free in both directions. Reads save the
gap between the fresh and cached rates; writes are billed *above* the fresh
rate. The headline is what is left after that toll.

Providers that report a billed total rather than per-channel rates (OpenCode)
or only a tick cost (Grok) contribute their tokens and abstain from the money
rather than have a number guessed for them.

## Where the numbers come from

Every provider already records its own limits locally, so the dashboard reads
those instead of polling:

| Provider | Limits read from |
| --- | --- |
| Codex | `rate_limits` in every rollout transcript - percentages, windows, reset times, credit balance and plan, written after every turn |
| Claude | the statusline snapshot and config cache the CLI maintains |
| Grok | the CLI log, and the snapshot kept beside it |
| Antigravity | the IDE's own language server, over loopback |
| Devin, OpenCode | no limits feed; usage only |

Antigravity is the interesting one: its IDE runs a language server on
127.0.0.1 that already holds the signed-in plan and every model's remaining
quota, because that is what it draws in its own UI. The dashboard asks that
process rather than any remote endpoint. When the IDE is closed the card says
so. Pressing **Refresh** on an account is the only thing that reaches a
provider over the network.

## Caching

Session logs are JSONL that only ever grows, and databases change only when
the agent behind them is used. Both facts are exploited so a refresh costs
almost nothing:

- **Per-file rollups**, keyed by (date, model), holding *raw token counts* -
  priced at read time, so editing a rate table reaches history that will never
  be touched again.
- **Tail reads.** A file that gained a line is read from where the last scan
  stopped, at the last complete newline - never the stat size, which on a log
  being appended to can fall mid-line and lose that record.
- **A persistent index** (`scan-index.json`), so a restart restores the
  rollups instead of re-parsing every log on the machine.
- **Whole scans kept until their inputs move**, for SQLite stores that have no
  seam to resume from. The signature watches the database and its `-wal`, never
  `-shm`: opening a database read-only rewrites `-shm`, so watching it would
  make every scan dirty the file it was watching.
- **One scan at a time**, with stale results served while a refresh runs
  behind them.

On a machine with 1.8GB of Codex rollouts, a 1.06GB Devin store and a 1.24GB
OpenCode database: a refresh that finds nothing changed reads **0 bytes** and
skips over 5GB, and one that finds an active session reads only the lines that
session appended. A restart restores 944 files of rollups in 27ms rather than
re-parsing them.

## Limit economics

Providers tell you what percentage of a rate-limit window you have burned, but
never what that percentage is worth. The **Limit Economics** tab answers that:
how many tokens, and how many dollars, one percent of each window buys.

Every reading of a limit percentage is appended to a ledger together with the
token and dollar counters standing at that moment, so the rate is the slope
between two readings inside the same window:

- `limit-history.jsonl` — live samples, one row per (account, window) whenever
  the percentage ticks, the window resets, or a 30-minute heartbeat elapses.
  Append-only; safe to keep forever.
- `limit-history-backfill.jsonl` — Codex history replayed from
  `~/.codex/sessions`. Codex writes its rate-limit percentages into every
  rollout transcript, so its series reaches back as far as the transcripts do.
  Derived and regenerable; rewritten at startup and every six hours.

Claude, Grok, and Antigravity keep no local record of past limit percentages,
so their measured series necessarily begins the first time the dashboard runs.
Until a window has moved more than five percentage points, whole-number
percentages make a measured rate imprecise, so a weekly window falls back to an
estimate — the last seven days of usage divided by the percentage consumed —
and is labelled `estimated`. Antigravity is excluded from that estimate because
it splits one token pool across separate Gemini and Claude/GPT quotas, so no
single percentage explains its totals.

### API

| Endpoint | Purpose |
| --- | --- |
| `GET /api/limit-history` | Derived view: per account and window, the per-percent rate for each cycle plus a pooled figure. |
| `GET /api/limit-history/raw?account=&window=&limit=` | Raw ledger rows, for exporting or charting elsewhere. |
| `POST /api/limit-history/backfill` | Re-replay the Codex transcripts now. |
| `GET /api/usage` | Everything the dashboard draws: per-account spend, tokens, models, limits and prompt-cache stats. |
| `GET /api/usage?force=1` | Re-check every file, seal included, and re-read only what changed. |
| `GET /api/usage?rebuild=1` | Distrust the cache key and re-read every byte. The repair for an entry whose `(mtime, size, ino)` lied. |
| `GET /api/cache` | What the scan cache is doing: files and databases reused, bytes skipped, per-account timings. |
| `POST /api/refresh-limits?id=` | Ask one provider for its limits over the network. The only path that does. |

Set `LIMIT_HISTORY_SAMPLER=off` to disable background sampling, or
`LIMIT_HISTORY_SAMPLE_MS` to change its period (defaults to the 5-minute disk
cache interval, so it costs no extra scanning).

## Profile discovery

Every refresh scans for the standard profile directories:

- Claude: `~/.claude`, `~/.claude-*`
- Codex: `~/.codex`, `~/.codex-*`
- Grok: `~/.grok`, `~/.grok-*`
- Devin: `~/.local/share/devin/cli/sessions.db` (or `DEVIN_DB`)

It also honors `CLAUDE_CONFIG_DIR`, `CODEX_HOME`, `GROK_CONFIG_DIR`, and `GROK_HOME`. For profiles stored somewhere else, set `CC_USAGE_CONFIG_DIRS` to a comma- or platform-path-separated list before starting the dashboard. New profiles appear without reinstalling or editing a config file.

If an old local profile should not be tracked, disable it before starting the
dashboard. For example, in PowerShell:

```powershell
$env:CC_USAGE_DISABLED_PROVIDERS = 'claude'
& "$env:LOCALAPPDATA\bin\cc-usage-dashboard.cmd"
```

To keep that choice across new PowerShell windows, set it as a user
environment variable and then open a new terminal:

```powershell
[Environment]::SetEnvironmentVariable('CC_USAGE_DISABLED_PROVIDERS', 'claude', 'User')
```

Use a comma- or semicolon-separated list such as `claude,codex` to disable
multiple providers. This hides the provider from discovery and does not delete
its local files. The dashboard's Settings tab can also hide an account visually
without stopping its background tracking.

The dashboard reads local usage and session data only. Background refreshes
make no network requests; the per-account **Refresh** button is the one action
that contacts a provider. It does not copy credentials into the dashboard
directory.

## Portability

The app no longer contains a user-specific home path or Node path. It works on Linux, macOS, Windows, and WSL as long as Node.js and the relevant agent CLIs are installed. OpenCode details are enabled automatically when the Node runtime provides `node:sqlite`; all other providers continue to work without it.

Derived state is kept beside the install and is safe to delete: `usage-cache.json`
(the last reply), `scan-index.json` (per-file rollups) and the limit-history
backfill all rebuild themselves.

Install locations: Linux uses `~/.local/share/cc-usage-dashboard` and `~/.local/bin/cc-usage-dashboard`; macOS uses `~/Library/Application Support/cc-usage-dashboard`, `~/.local/bin/cc-usage-dashboard`, and `~/Library/LaunchAgents/com.cc-usage-dashboard.plist`; Windows uses `%LOCALAPPDATA%\cc-usage-dashboard` and `%LOCALAPPDATA%\bin\cc-usage-dashboard.cmd`.
