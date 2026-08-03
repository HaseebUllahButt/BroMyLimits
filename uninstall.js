#!/usr/bin/env node

const os = require('node:os');
const path = require('node:path');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const { spawnSync } = require('node:child_process');
const { detectProfileAccounts, getHomeDir } = require('./profile-discovery');

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

async function restoreSettings() {
  for (const account of await detectProfileAccounts()) {
    if (account.provider !== 'claude') continue;
    const settingsPath = path.join(account.configDir, 'settings.json');
    const backupPath = `${settingsPath}.cc-usage-backup`;
    if (fs.existsSync(backupPath)) {
      await fsp.rename(backupPath, settingsPath);
    }
  }
}

function stopService() {
  if (process.platform === 'linux') {
    spawnSync('systemctl', ['--user', 'disable', '--now', 'cc-usage-dashboard.service'], { stdio: 'ignore' });
    spawnSync('systemctl', ['--user', 'daemon-reload'], { stdio: 'ignore' });
  }
  if (process.platform === 'darwin') {
    const plistPath = path.join(home, 'Library', 'LaunchAgents', 'com.cc-usage-dashboard.plist');
    const uid = typeof process.getuid === 'function' ? process.getuid() : null;
    if (uid != null) spawnSync('launchctl', ['bootout', `gui/${uid}`, plistPath], { stdio: 'ignore' });
    try { fs.unlinkSync(plistPath); } catch {}
  }
}

async function main() {
  await restoreSettings();
  stopService();
  const launcher = path.join(binDir, isWindows ? 'cc-usage-dashboard.cmd' : 'cc-usage-dashboard');
  try { await fsp.rm(launcher, { force: true }); } catch {}
  if (path.resolve(appDir) !== path.resolve(__dirname) && appDir !== path.parse(appDir).root) {
    await fsp.rm(appDir, { recursive: true, force: true });
  }
  console.log('cc-usage-dashboard has been uninstalled.');
  console.log('The source checkout was not removed.');
}

main().catch((error) => {
  console.error(`cc-usage-dashboard: ${error.message}`);
  process.exitCode = 1;
});
