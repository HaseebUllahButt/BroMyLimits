$ErrorActionPreference = 'Stop'

if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
  throw 'cc-usage-dashboard: Node.js 20+ is required.'
}

$scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
& node (Join-Path $scriptDir 'install.js') @args
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
