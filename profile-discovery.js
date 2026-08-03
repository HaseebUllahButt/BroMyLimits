const os = require('node:os');
const path = require('node:path');
const { readdir, stat } = require('node:fs/promises');

function getHomeDir() {
  return path.resolve(
    process.env.CC_USAGE_HOME
      || process.env.HOME
      || process.env.USERPROFILE
      || os.homedir(),
  );
}

function expandPath(value, home = getHomeDir()) {
  const raw = String(value || '').trim();
  if (!raw) return null;
  if (raw === '~') return home;
  if (raw.startsWith(`~${path.sep}`) || raw.startsWith('~/')) {
    return path.resolve(home, raw.slice(2));
  }
  return path.resolve(raw);
}

function splitConfiguredPaths(value) {
  if (!value) return [];
  return String(value)
    .split(path.delimiter)
    .flatMap((item) => item.split(','))
    .map((item) => item.trim())
    .filter(Boolean);
}

async function directoryNames(dir) {
  try {
    return new Set(await readdir(dir));
  } catch {
    return new Set();
  }
}

function labelFor(provider, dir) {
  const name = path.basename(dir);
  const prefix = `.${provider}-`;
  if (name === `.${provider}`) return 'default';
  if (name.startsWith(prefix) && name.length > prefix.length) return name.slice(prefix.length);
  return name || 'default';
}

function accountId(provider, label) {
  const safeLabel = String(label || 'default').replace(/[^a-zA-Z0-9._-]+/g, '-');
  return `${provider}-${safeLabel || 'default'}`;
}

function hasProfileMarkers(provider, names) {
  if (provider === 'claude') {
    return ['.claude.json', '.credentials.json', 'history.jsonl', 'projects'].some((name) => names.has(name));
  }
  if (provider === 'codex') {
    return ['auth.json', 'config.toml', 'history.jsonl', 'sessions'].some((name) => names.has(name));
  }
  if (provider === 'grok') {
    return ['auth.json', 'config.toml', 'sessions'].some((name) => names.has(name));
  }
  return false;
}

async function addProfile(accounts, seenPaths, usedIds, provider, dir, { requireMarkers = true } = {}) {
  const resolved = expandPath(dir);
  if (!resolved || seenPaths.has(resolved)) return;
  try {
    if (!(await stat(resolved)).isDirectory()) return;
  } catch {
    return;
  }

  const names = await directoryNames(resolved);
  if (requireMarkers && !hasProfileMarkers(provider, names)) return;

  const label = labelFor(provider, resolved);
  const baseId = accountId(provider, label);
  let id = baseId;
  let suffix = 2;
  while (usedIds.has(id)) id = `${baseId}-${suffix++}`;
  usedIds.add(id);
  seenPaths.add(resolved);
  accounts.push({ id, provider, label, configDir: resolved });
}

// Detect the profiles used by the local CLIs. Standard profiles are the
// top-level dot-directories. Explicit environment paths cover installations
// that keep profiles somewhere else (for example CLAUDE_CONFIG_DIR on Windows
// or a profile managed by a launcher script).
async function detectProfileAccounts() {
  const home = getHomeDir();
  const accounts = [];
  const seenPaths = new Set();
  const usedIds = new Set();

  let entries = [];
  try {
    entries = await readdir(home, { withFileTypes: true });
  } catch {
    entries = [];
  }

  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const name = entry.name;
    const dir = path.join(home, name);
    if (/^\.claude(?:-.+)?$/.test(name)) {
      await addProfile(accounts, seenPaths, usedIds, 'claude', dir);
    } else if (/^\.codex(?:-.+)?$/.test(name)) {
      await addProfile(accounts, seenPaths, usedIds, 'codex', dir);
    } else if (/^\.grok(?:-.+)?$/.test(name)) {
      await addProfile(accounts, seenPaths, usedIds, 'grok', dir);
    }
  }

  // The active environment is useful when the profile is not named using the
  // conventional .claude-work/.codex-work layout.
  for (const [provider, envName] of [
    ['claude', 'CLAUDE_CONFIG_DIR'],
    ['codex', 'CODEX_HOME'],
    ['grok', 'GROK_CONFIG_DIR'],
    ['grok', 'GROK_HOME'],
  ]) {
    if (process.env[envName]) {
      await addProfile(accounts, seenPaths, usedIds, provider, process.env[envName], { requireMarkers: false });
    }
  }

  // A path-list override is convenient for services, which do not inherit a
  // user's interactive shell environment. Provider is inferred from the
  // directory name or its marker files.
  for (const configured of splitConfiguredPaths(process.env.CC_USAGE_CONFIG_DIRS)) {
    const dir = expandPath(configured, home);
    const name = path.basename(dir || '');
    const names = await directoryNames(dir);
    const provider = /^\.codex(?:-|$)/.test(name) || names.has('auth.json') && names.has('config.toml')
      ? 'codex'
      : /^\.grok(?:-|$)/.test(name)
        ? 'grok'
        : 'claude';
    await addProfile(accounts, seenPaths, usedIds, provider, dir, { requireMarkers: false });
  }

  return accounts.sort((a, b) => a.provider.localeCompare(b.provider) || a.label.localeCompare(b.label));
}

module.exports = { detectProfileAccounts, expandPath, getHomeDir, splitConfiguredPaths };
