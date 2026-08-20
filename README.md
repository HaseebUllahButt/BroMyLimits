# CC Usage Dashboard

Local dashboard for Claude Code, Codex, Grok, Antigravity/Pi, and OpenCode usage.

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

Set `LIMIT_HISTORY_SAMPLER=off` to disable background sampling, or
`LIMIT_HISTORY_SAMPLE_MS` to change its period (defaults to the 5-minute disk
cache interval, so it costs no extra scanning).

## Profile discovery

Every refresh scans for the standard profile directories:

- Claude: `~/.claude`, `~/.claude-*`
- Codex: `~/.codex`, `~/.codex-*`
- Grok: `~/.grok`, `~/.grok-*`

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

The dashboard only reads local usage/session data, except for the provider rate-limit refreshes already exposed by the agents. It does not copy credentials into the dashboard directory.

## Portability

The app no longer contains a user-specific home path or Node path. It works on Linux, macOS, Windows, and WSL as long as Node.js and the relevant agent CLIs are installed. OpenCode details are enabled automatically when the Node runtime provides `node:sqlite`; all other providers continue to work without it.

Install locations: Linux uses `~/.local/share/cc-usage-dashboard` and `~/.local/bin/cc-usage-dashboard`; macOS uses `~/Library/Application Support/cc-usage-dashboard`, `~/.local/bin/cc-usage-dashboard`, and `~/Library/LaunchAgents/com.cc-usage-dashboard.plist`; Windows uses `%LOCALAPPDATA%\cc-usage-dashboard` and `%LOCALAPPDATA%\bin\cc-usage-dashboard.cmd`.
