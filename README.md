# Agent Usage Dashboard

> Real-time usage, cost tracking, and rate limits for Claude Code & Codex CLI — served locally, zero telemetry.

A self-hosted dashboard that aggregates usage data across all your Claude Code and Codex CLI accounts. Costs are computed from real token counts × published rate cards, not from opaque API fields — so you always see what you're actually spending, even for models the CLI itself doesn't price correctly.

## Features

- **Multi-account out of the box** — auto-discovers every `~/.claude*` and `~/.codex*` directory with valid configs. No setup per account.
- **Live & cached rate limits** — reads rate-limit snapshots pushed by the Claude Code statusline hook after every prompt (freshest possible data, zero extra API calls). Falls back to `.claude.json` cache when no statusline is installed.
- **Manual refresh** — click to bypass the 15-minute backoff and hit Anthropic/OpenAI's usage endpoints live.
- **Real cost, not guesswork** — token counts × published per-model rates from `platform.claude.com` and `platform.openai.com`. Handles Claude Sonnet 5 introductory pricing, Codex credit-based plans, and flags unknown models instead of silently showing $0.
- **Per-model breakdown** — exactly what you spent on input, output, cache writes, and cache reads for every model in your account.
- **Credit & reset visibility (Codex)** — shows message-credit balances, estimated local/cloud messages, and available manual rate-limit resets with countdowns.
- **Tab-per-account layout** — toggle accounts on/off via Settings; hidden accounts are still tracked.
- **Dark & light mode** — respects `prefers-color-scheme`; manual override in Settings.
- **systemd integration** — installs as a user-level daemon with `--user` systemd, auto-start on login.

## Quick start

**One-line install:**

```bash
cd /tmp && rm -rf BroMyLimits && git clone https://github.com/HaseebUllahButt/BroMyLimits.git && cd BroMyLimits && chmod +x install.sh && ./install.sh 47291
```

Or step by step:

```bash
git clone https://github.com/HaseebUllahButt/BroMyLimits.git
cd BroMyLimits
./install.sh           # interactive — prompts for port
./install.sh 47291     # non-interactive — picks port 47291
```

> The installer auto-opens your browser to **http://127.0.0.1:47291** after setup.

Accounts are auto-detected from `~/.claude*` and `~/.codex*` directories. No per-account config needed.

### Uninstall

```bash
./uninstall.sh
```

## How it works

```
┌─────────────────┐     ┌─────────────────┐     ┌──────────────┐
│  Claude Code     │────▶│  statusline.js   │────▶│  JSON snapshot │
│  (per prompt)    │     │  (stdin hook)    │     │  on disk       │
└─────────────────┘     └─────────────────┘     └──────┬───────┘
                                                       │
┌─────────────────┐                                    │
│  ccusage CLI     │────▶  server.js  ◀────────────────┘
│  (daily/session) │      (HTTP :47291)                 │
└─────────────────┘          │                          │
                             │                          │
                    ┌────────▼─────────┐               │
                    │  public/         │               │
                    │  index.html      │◀──────────────┘
                    │  (dashboard UI)  │
                    └──────────────────┘
```

- `server.js` — HTTP server. Discovers accounts, shells out to `ccusage` for token/cost data, reads rate-limit snapshots, exposes a REST API.
- `statusline.js` — Claude Code statusline command. Captures `rate_limits` from stdin (pushed after every prompt), persists them as JSON. No extra API calls.
- `configure-statusline.js` — install-time helper that sets the statusline command in a Claude account's `settings.json`.
- `public/index.html` — SPA frontend with tab-per-account layout, cost breakdown tables, and animated limit bars.

## Configuration

All configuration is environment-based:

| Variable | Default | Description |
|---|---|---|
| `PORT` | `47291` | HTTP port for the dashboard |
| `HOME` | `$HOME` | Used to scan `~/.claude*` / `~/.codex*` directories |

Account visibility is persisted in `localStorage` — toggle accounts on/off from the Settings tab.

## What makes this different

The `ccusage` CLI already shows your usage, but it has two blind spots:

1. **Rate limits** — `ccusage` has no rate-limit endpoint. This dashboard reads them from Claude Code's own statusline (zero-cost, after-every-prompt) or from Anthropic's OAuth usage API on explicit refresh.
2. **Wrong costs for newer models** — `ccusage` uses a bundled pricing DB that can be outdated (e.g. it showed $0 for Sonnet 5 during its introductory pricing period). This project recomputes costs from real token counts × up-to-date rate cards, and flags any model it doesn't recognize.

## File layout

```
├── server.js                     # HTTP server & API
├── statusline.js                 # Claude Code statusline hook
├── configure-statusline.js       # Install-time statusline configurator
├── install.sh                    # Systemd service installer
├── uninstall.sh                  # Systemd service uninstaller
├── public/
│   └── index.html               # Single-page dashboard UI
└── .gitignore
```

## Requirements

- **OS**: Linux (systemd user session)
- **Runtime**: Node.js 18+
- **CLI**: [ccusage](https://github.com/Anthropic/ccusage) on `PATH`
- **Accounts**: One or more `~/.claude*` or `~/.codex*` directories with valid configs

## License

MIT
