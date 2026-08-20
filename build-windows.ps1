$ErrorActionPreference = 'Stop'

if (-not $IsWindows -and $env:OS -ne 'Windows_NT') {
  throw 'The portable Windows build must be created on Windows.'
}

$projectDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$package = Get-Content (Join-Path $projectDir 'package.json') -Raw | ConvertFrom-Json
$nodeCommand = Get-Command node -ErrorAction Stop
$npmCommand = Get-Command npm.cmd -ErrorAction Stop
$nodeMajor = [int]((& $nodeCommand.Source -p "process.versions.node.split('.')[0]").Trim())
if ($nodeMajor -lt 20) {
  throw 'Node.js 20 or newer is required to build the Windows package.'
}

$architecture = (& $nodeCommand.Source -p 'process.arch').Trim()
if ($architecture -notin @('x64', 'arm64')) {
  throw "Unsupported Windows architecture: $architecture"
}

$artifactName = "cc-usage-dashboard-v$($package.version)-windows-$architecture"
$distDir = Join-Path $projectDir 'dist'
$archivePath = Join-Path $distDir "$artifactName.zip"
$stagingParent = Join-Path ([System.IO.Path]::GetTempPath()) ("BroMyLimits-build-" + [guid]::NewGuid())
$stagingDir = Join-Path $stagingParent $artifactName

$runtimeFiles = @(
  'server.js',
  'profile-discovery.js',
  'limit-history.js',
  'ccusage-runner.js',
  'package.json',
  'README.md'
)

try {
  New-Item -ItemType Directory -Path $stagingDir -Force | Out-Null
  New-Item -ItemType Directory -Path $distDir -Force | Out-Null

  foreach ($file in $runtimeFiles) {
    Copy-Item -LiteralPath (Join-Path $projectDir $file) -Destination $stagingDir
  }
  Copy-Item -LiteralPath (Join-Path $projectDir 'public') -Destination $stagingDir -Recurse
  Copy-Item -LiteralPath $nodeCommand.Source -Destination (Join-Path $stagingDir 'node.exe')

  Push-Location $stagingDir
  try {
    & $npmCommand.Source install --omit=dev --no-fund --no-audit
    if ($LASTEXITCODE -ne 0) { throw "npm install failed with exit code $LASTEXITCODE" }
  } finally {
    Pop-Location
  }

  $nativeCcusage = Join-Path $stagingDir "node_modules\@ccusage\ccusage-win32-$architecture\bin\ccusage.exe"
  if (-not (Test-Path -LiteralPath $nativeCcusage)) {
    throw "The ccusage Windows $architecture native binary was not installed."
  }

  $launcher = @'
@echo off
setlocal
set "PORT=%~1"
if "%PORT%"=="" set "PORT=47291"
set "CC_USAGE_HOME=%USERPROFILE%"
start "" powershell -NoProfile -WindowStyle Hidden -Command "Start-Sleep -Milliseconds 700; Start-Process 'http://127.0.0.1:%PORT%'"
"%~dp0node.exe" --max-old-space-size=80 --max-semi-space-size=8 "%~dp0server.js"
'@
  Set-Content -LiteralPath (Join-Path $stagingDir 'start-dashboard.cmd') -Value $launcher -Encoding Ascii

  $instructions = @'
CC Usage Dashboard - Windows Portable

1. Extract the ZIP to a normal folder.
2. Double-click start-dashboard.cmd, or run: start-dashboard.cmd 47291
3. Keep the terminal window open while using the dashboard.
4. Open http://127.0.0.1:47291 if the browser does not open automatically.

No Node.js installation is required on the target computer.
'@
  Set-Content -LiteralPath (Join-Path $stagingDir 'WINDOWS-PORTABLE.txt') -Value $instructions -Encoding Utf8

  Compress-Archive -Path (Join-Path $stagingDir '*') -DestinationPath $archivePath -CompressionLevel Optimal -Force
  Write-Output "Windows build created: $archivePath"
} finally {
  if (Test-Path -LiteralPath $stagingParent) {
    Remove-Item -LiteralPath $stagingParent -Recurse -Force
  }
}
