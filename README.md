# CC Usage Dashboard

Local dashboard for Claude Code, Codex, Grok, Antigravity/Pi, and OpenCode usage.

## Install

Requires Node.js 20 or newer. From this directory:

```sh
./install.sh
```

To choose a port explicitly:

```sh
./install.sh 47291
```

### One-paste install

Linux or macOS Terminal:

```sh
d="$(mktemp -d)" && git clone --depth 1 https://github.com/HaseebUllahButt/BroMyLimits.git "$d/BroMyLimits" && "$d/BroMyLimits/install.sh" 47291
```

Windows PowerShell:

```powershell
$ErrorActionPreference='Stop'; $d=Join-Path $env:TEMP ('BroMyLimits-'+[guid]::NewGuid()); git clone --depth 1 https://github.com/HaseebUllahButt/BroMyLimits.git $d; powershell -ExecutionPolicy Bypass -File (Join-Path $d 'install.ps1') 47291
```

On macOS, run `install.sh` in Terminal or double-click `install.command`. On Windows, run `install.ps1` from PowerShell. The installer creates a user-local app directory and launcher, installs `ccusage` locally when npm is available, configures the Claude statusline for every detected Claude profile, enables a user service on Linux/macOS, and opens the dashboard automatically. Use `--skip-deps`, `--no-statusline`, `--no-service`, or `--no-browser` to disable those parts.

Start it with `cc-usage-dashboard`, then open <http://127.0.0.1:47291>.

To remove the installed service and restore backed-up Claude settings:

```sh
./uninstall.sh
```

## Profile discovery

Every refresh scans for the standard profile directories:

- Claude: `~/.claude`, `~/.claude-*`
- Codex: `~/.codex`, `~/.codex-*`
- Grok: `~/.grok`, `~/.grok-*`

It also honors `CLAUDE_CONFIG_DIR`, `CODEX_HOME`, `GROK_CONFIG_DIR`, and `GROK_HOME`. For profiles stored somewhere else, set `CC_USAGE_CONFIG_DIRS` to a comma- or platform-path-separated list before starting the dashboard. New profiles appear without reinstalling or editing a config file.

The dashboard only reads local usage/session data, except for the provider rate-limit refreshes already exposed by the agents. It does not copy credentials into the dashboard directory.

## Portability

The app no longer contains a user-specific home path or Node path. It works on Linux, macOS, Windows, and WSL as long as Node.js and the relevant agent CLIs are installed. OpenCode details are enabled automatically when the Node runtime provides `node:sqlite`; all other providers continue to work without it.

Install locations: Linux uses `~/.local/share/cc-usage-dashboard` and `~/.local/bin/cc-usage-dashboard`; macOS uses `~/Library/Application Support/cc-usage-dashboard`, `~/.local/bin/cc-usage-dashboard`, and `~/Library/LaunchAgents/com.cc-usage-dashboard.plist`; Windows uses `%LOCALAPPDATA%\cc-usage-dashboard` and `%LOCALAPPDATA%\bin\cc-usage-dashboard.cmd`.
