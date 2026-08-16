#!/usr/bin/env node

const os = require('node:os');
const path = require('node:path');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const { spawnSync } = require('node:child_process');
const { detectProfileAccounts, getHomeDir } = require('./profile-discovery');

const sourceDir = path.resolve(__dirname);
const home = getHomeDir();
const isWindows = process.platform === 'win32';
const dataHome = process.env.XDG_DATA_HOME || (isWindows
  ? path.join(home, 'AppData', 'Local')
  : process.platform === 'darwin'
    ? path.join(home, 'Library', 'Application Support')
    : path.join(home, '.local', 'share'));
const appDir = path.resolve(process.env.CC_USAGE_INSTALL_DIR || path.join(dataHome, 'cc-usage-dashboard'));
const binDir = path.resolve(process.env.CC_USAGE_BIN_DIR || (isWindows
  ? path.join(home, 'AppData', 'Local', 'bin')
  : path.join(process.env.XDG_BIN_HOME || path.join(home, '.local', 'bin'))));
const nodePath = process.execPath;
const serverPath = path.join(appDir, 'server.js');
// Tight V8 heap caps: the dashboard only holds an aggregated summary, and the
// session scanners are streaming, so 80MB of old space is plenty. This keeps
// the daemon at a few tens of MB of RSS instead of growing to gigabytes.
const NODE_FLAGS = '--max-old-space-size=80 --max-semi-space-size=8';

const args = new Set(process.argv.slice(2));
const skipDeps = args.has('--skip-deps');
const skipStatusline = args.has('--no-statusline');
const skipService = args.has('--no-service');
const skipBrowser = args.has('--no-browser');
const requestedPort = process.env.PORT || process.argv.slice(2).find((value) => /^\d+$/.test(value)) || '47291';
if (!/^\d+$/.test(requestedPort) || Number(requestedPort) < 1 || Number(requestedPort) > 65535) {
  throw new Error('port must be a number from 1 to 65535');
}
const dashboardPort = String(requestedPort);

function shellQuote(value) {
  return `'${String(value).replace(/'/g, `'\\''`)}'`;
}

function systemdQuote(value) {
  return String(value).replace(/([\\"\s])/g, '\\$1');
}

function xmlQuote(value) {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

async function installFiles() {
  await fsp.mkdir(appDir, { recursive: true });
  if (path.resolve(sourceDir) === path.resolve(appDir)) return;

  await fsp.cp(sourceDir, appDir, {
    recursive: true,
    force: true,
    filter(source) {
      const relative = path.relative(sourceDir, source);
      return !relative.startsWith('node_modules')
        && !relative.startsWith('.git')
        && !/^((claude|grok)-live-limits-.*\.json)$/.test(path.basename(source));
    },
  });
}

async function installDependencies() {
  if (skipDeps || fs.existsSync(path.join(appDir, 'node_modules', '.bin', isWindows ? 'ccusage.cmd' : 'ccusage'))) return;
  const npm = isWindows ? 'npm.cmd' : 'npm';
  const result = spawnSync(npm, ['install', '--omit=dev', '--no-fund', '--no-audit'], {
    cwd: appDir,
    stdio: 'inherit',
    windowsHide: true,
  });
  if (result.error || result.status !== 0) {
    console.warn('cc-usage-dashboard: could not install ccusage automatically.');
    console.warn('Install it with: npm install -g ccusage');
  }
}

async function configureStatuslines() {
  if (skipStatusline) return;
  const accounts = await detectProfileAccounts();
  const claudeAccounts = accounts.filter((account) => account.provider === 'claude');
  for (const account of claudeAccounts) {
    const result = spawnSync(nodePath, [
      path.join(appDir, 'configure-statusline.js'),
      path.join(account.configDir, 'settings.json'),
      nodePath,
      path.join(appDir, 'statusline.js'),
      account.label,
    ], { stdio: 'inherit', windowsHide: true });
    if (result.error || result.status !== 0) {
      console.warn(`cc-usage-dashboard: could not configure Claude profile ${account.label}.`);
    }
  }
  if (claudeAccounts.length) {
    console.log(`Configured statusline for ${claudeAccounts.length} Claude profile${claudeAccounts.length === 1 ? '' : 's'}.`);
  }
}

async function writeLaunchers() {
  await fsp.mkdir(binDir, { recursive: true });
  if (isWindows) {
    const cmd = [
      '@echo off',
      'set "PORT=%~1"',
      `if "%PORT%"=="" set "PORT=${dashboardPort}"`,
      `set "CC_USAGE_HOME=${home}"`,
      `"${nodePath}" ${NODE_FLAGS} "${serverPath}"`,
      '',
    ].join('\r\n');
    await fsp.writeFile(path.join(binDir, 'cc-usage-dashboard.cmd'), cmd);
    await fsp.writeFile(path.join(appDir, 'start-dashboard.ps1'), [
      `$env:CC_USAGE_HOME = '${home.replace(/'/g, "''")}'`,
      `$env:PORT = if ($args.Count -gt 0) { $args[0] } else { '${dashboardPort}' }`,
      `& '${nodePath.replace(/'/g, "''")}' ${NODE_FLAGS} '${serverPath.replace(/'/g, "''")}'`,
      '',
    ].join('\r\n'));
    console.log(`Launcher: ${path.join(binDir, 'cc-usage-dashboard.cmd')}`);
    console.log(`PowerShell: ${path.join(appDir, 'start-dashboard.ps1')}`);
    return;
  }

  const launcher = [
    '#!/usr/bin/env sh',
    'set -eu',
    `PORT="\${1:-\${PORT:-${dashboardPort}}}"`,
    'export PORT',
    `export CC_USAGE_HOME=${shellQuote(home)}`,
    `exec ${shellQuote(nodePath)} ${NODE_FLAGS} ${shellQuote(serverPath)}`,
    '',
  ].join('\n');
  const launcherPath = path.join(binDir, 'cc-usage-dashboard');
  await fsp.writeFile(launcherPath, launcher, { mode: 0o755 });
  await fsp.chmod(launcherPath, 0o755);
  console.log(`Launcher: ${launcherPath}`);
}

async function installLinuxService() {
  if (skipService || process.platform !== 'linux') return;
  const configDir = process.env.XDG_CONFIG_HOME || path.join(home, '.config');
  const serviceDir = path.join(configDir, 'systemd', 'user');
  const servicePath = path.join(serviceDir, 'cc-usage-dashboard.service');
  const unit = [
    '[Unit]',
    'Description=Claude Code usage dashboard',
    'After=network-online.target',
    '',
    '[Service]',
    'Type=simple',
    `Environment=PORT=${dashboardPort}`,
    `Environment=CC_USAGE_HOME=${systemdQuote(home)}`,
    `Environment=PATH=${systemdQuote(process.env.PATH || '')}`,
    `ExecStart=${systemdQuote(nodePath)} ${NODE_FLAGS} ${systemdQuote(serverPath)}`,
    `WorkingDirectory=${systemdQuote(appDir)}`,
    'Restart=on-failure',
    'RestartSec=3',
    // The heavy session scans pull multi-GB files through the cgroup as
    // reclaimable page cache; cap it so the unit's memory meter stays sane
    // instead of showing gigabytes. Real usage (80MB heap + streaming scans)
    // is far below MemoryHigh.
    'MemoryHigh=300M',
    'MemoryMax=1G',
    '',
    '[Install]',
    'WantedBy=default.target',
    '',
  ].join('\n');
  await fsp.mkdir(serviceDir, { recursive: true });
  await fsp.writeFile(servicePath, unit);
  if (spawnSync('systemctl', ['--user', 'daemon-reload'], { stdio: 'ignore' }).status === 0) {
    spawnSync('systemctl', ['--user', 'enable', '--now', 'cc-usage-dashboard.service'], { stdio: 'ignore' });
    console.log(`Systemd service enabled: ${servicePath}`);
  } else {
    console.log(`Systemd unit written: ${servicePath}`);
  }
}

async function installMacService() {
  if (skipService || process.platform !== 'darwin') return;
  const launchDir = path.join(home, 'Library', 'LaunchAgents');
  const plistPath = path.join(launchDir, 'com.cc-usage-dashboard.plist');
  const plist = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>Label</key><string>com.cc-usage-dashboard</string>
<key>ProgramArguments</key><array><string>${xmlQuote(nodePath)}</string>${NODE_FLAGS.split(' ').map((f) => `<string>${xmlQuote(f)}</string>`).join('')}<string>${xmlQuote(serverPath)}</string></array>
<key>WorkingDirectory</key><string>${xmlQuote(appDir)}</string>
<key>EnvironmentVariables</key><dict><key>CC_USAGE_HOME</key><string>${xmlQuote(home)}</string><key>PORT</key><string>${dashboardPort}</string></dict>
<key>RunAtLoad</key><true/><key>KeepAlive</key><true/>
</dict></plist>
`;
  await fsp.mkdir(launchDir, { recursive: true });
  await fsp.writeFile(plistPath, plist);
  const uid = typeof process.getuid === 'function' ? process.getuid() : null;
  const domain = uid == null ? null : `gui/${uid}`;
  if (domain) {
    spawnSync('launchctl', ['bootout', domain, plistPath], { stdio: 'ignore' });
    const loaded = spawnSync('launchctl', ['bootstrap', domain, plistPath], { stdio: 'ignore' });
    if (loaded.status === 0) {
      console.log(`LaunchAgent enabled: ${plistPath}`);
      return;
    }
  }
  console.log(`LaunchAgent written: ${plistPath}`);
  console.log('Load it with: launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.cc-usage-dashboard.plist');
}

function openDashboard() {
  if (skipBrowser) return;
  const url = `http://127.0.0.1:${dashboardPort}`;
  if (process.platform === 'darwin') {
    spawnSync('open', [url], { stdio: 'ignore' });
  } else if (process.platform === 'linux') {
    spawnSync('xdg-open', [url], { stdio: 'ignore' });
  } else if (process.platform === 'win32') {
    spawnSync('cmd.exe', ['/c', 'start', '', url], { stdio: 'ignore', windowsHide: true });
  }
}

async function main() {
  await installFiles();
  await installDependencies();
  await writeLaunchers();
  await configureStatuslines();
  await installLinuxService();
  await installMacService();
  console.log(`Dashboard: http://127.0.0.1:${dashboardPort}`);
  console.log('Profiles are discovered automatically each time the dashboard refreshes.');
  openDashboard();
}

main().catch((error) => {
  console.error(`cc-usage-dashboard: ${error.message}`);
  process.exitCode = 1;
});
