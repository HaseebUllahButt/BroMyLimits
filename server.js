const http = require('node:http');
const https = require('node:https');
const { exec, execFile } = require('node:child_process');
const { readFile, readdir, stat, writeFile } = require('node:fs/promises');
const { existsSync, createReadStream } = require('node:fs');
const readline = require('node:readline');
const path = require('node:path');
const { detectProfileAccounts, getHomeDir, isProviderDisabled } = require('./profile-discovery');
const { resolveCcusageCommand, runCcusage: runCcusageCommand } = require('./ccusage-runner');
const limitHistory = require('./limit-history');
const { FileRollupCache, ResultCache, loadIndex, saveIndex, blankStats, addStats } = require('./scan-cache');

let DatabaseSync;
try {
  ({ DatabaseSync } = require('node:sqlite'));
} catch {
  // OpenCode support is optional. The other providers still work on Node
  // versions that do not ship the built-in SQLite module.
  DatabaseSync = null;
}

const PORT = process.env.PORT || 47291;
const HOST = '127.0.0.1';
function getDataHome() {
  const home = getHomeDir();
  return process.env.XDG_DATA_HOME || (process.platform === 'win32'
    ? path.join(home, 'AppData', 'Local')
    : process.platform === 'darwin'
      ? path.join(home, 'Library', 'Application Support')
      : path.join(home, '.local', 'share'));
}

function getAntigravityDataDir() {
  return process.env.ANTIGRAVITY_DATA_DIR || path.join(getHomeDir(), '.gemini', 'antigravity-cli');
}

const CCUSAGE_BIN = resolveCcusageCommand();

// --- Account discovery -----------------------------------------------------
async function detectAccounts() {
  const discovered = await detectProfileAccounts();
  const activeClaude = await selectActiveClaudeAccount(discovered);
  const accounts = discovered.filter((account) => account.provider !== 'claude');
  if (activeClaude) accounts.push(activeClaude);

  if (!isProviderDisabled('antigravity')) {
    const antigravityAuth = await readAntigravityAuth();
    if (antigravityAuth) {
      accounts.push({
        id: 'antigravity-default',
        provider: 'antigravity',
        label: 'default',
        authPath: antigravityAuth.authPath,
        projectId: antigravityAuth.projectId || null,
      });
    }
  }

  if (!isProviderDisabled('opencode')) {
    const dataHome = getDataHome();
    const seenPaths = new Set();
    const envDb = process.env.OPENCODE_DB || path.join(dataHome, 'opencode', 'opencode.db');
    try {
      await stat(envDb);
      accounts.push({ id: 'opencode-default', provider: 'opencode', label: 'default', dbPath: envDb });
      seenPaths.add(path.resolve(envDb));
    } catch {}
    try {
      const dataEntries = await readdir(dataHome, { withFileTypes: true });
      for (const entry of dataEntries) {
        if (!entry.isDirectory() || !/^opencode/i.test(entry.name)) continue;
        const dbPath = path.join(dataHome, entry.name, 'opencode.db');
        const resolved = path.resolve(dbPath);
        if (seenPaths.has(resolved)) continue;
        try {
          await stat(resolved);
          const label = entry.name === 'opencode' ? 'default' : entry.name.replace(/^opencode[-_]?/i, '') || entry.name;
          const safeLabel = label.replace(/[^a-zA-Z0-9._-]+/g, '-');
          const id = label === 'default' ? 'opencode-default' : `opencode-${safeLabel}`;
          accounts.push({ id, provider: 'opencode', label, dbPath: resolved });
          seenPaths.add(resolved);
        } catch {}
      }
    } catch {}
  }

  if (!isProviderDisabled('devin') && DatabaseSync) {
    const devinDb = process.env.DEVIN_DB || path.join(getDataHome(), 'devin', 'cli', 'sessions.db');
    try {
      await stat(devinDb);
      accounts.push({ id: 'devin-default', provider: 'devin', label: 'default', dbPath: devinDb });
    } catch {}
  }

  return accounts;
}

// The dashboard is an overview of the profile currently in use, not an
// archive of every Claude login directory on disk. An explicit service/CLI
// environment wins; otherwise the freshest statusline/config snapshot is the
// best durable signal of which profile Claude Code used most recently.
async function selectActiveClaudeAccount(accounts) {
  const claudeAccounts = accounts.filter((account) => account.provider === 'claude');
  if (claudeAccounts.length <= 1) return claudeAccounts[0] || null;

  if (process.env.CLAUDE_CONFIG_DIR) {
    const explicit = path.resolve(process.env.CLAUDE_CONFIG_DIR);
    const match = claudeAccounts.find((account) => path.resolve(account.configDir) === explicit);
    if (match) return match;
  }

  const ranked = await Promise.all(claudeAccounts.map(async (account) => {
    const cached = await getCachedClaudeRateLimits(account).catch(() => null);
    if (Number(cached?.fetchedAtMs) > 0) return { account, activityMs: Number(cached.fetchedAtMs) };
    try {
      const info = await stat(account.configDir);
      return { account, activityMs: info.mtimeMs };
    } catch {
      return { account, activityMs: 0 };
    }
  }));
  ranked.sort((a, b) => b.activityMs - a.activityMs || a.account.label.localeCompare(b.account.label));
  return ranked[0].account;
}

// --- Antigravity / Google Cloud Code Assist rate limits -------------------
// Pi's antigravity provider stores the Google OAuth credentials in the Pi
// auth store. The quota summary endpoint reports separate shared pools for
// Gemini and third-party models, each with a 5-hour and weekly window.
function getAntigravityAuthPath() {
  return process.env.PI_AUTH_PATH || path.join(getHomeDir(), '.pi', 'agent', 'auth.json');
}
const ANTIGRAVITY_AUTH_PATH = getAntigravityAuthPath();
const ANTIGRAVITY_ENDPOINTS = [
  process.env.ANTIGRAVITY_BASE_URL || 'https://cloudcode-pa.googleapis.com',
  'https://daily-cloudcode-pa.sandbox.googleapis.com',
].filter((endpoint, i, all) => endpoint && all.indexOf(endpoint) === i);
const ANTIGRAVITY_TOKEN_EARLY_REFRESH_MS = 5 * 60_000;
const ANTIGRAVITY_LIVE_REFRESH_MS = 60_000;
const antigravityTokens = new Map();
const antigravityLimits = new Map();
const lastAntigravityLiveAttemptAt = new Map();

// These are Google's public Antigravity desktop OAuth client values. They are
// not an account credential; custom values can be supplied through the same
// environment variables supported by pi-antigravity.
const ANTIGRAVITY_CLIENT_ID = process.env.ANTIGRAVITY_CLIENT_ID || Buffer.from(
  'MTA3MTAwNjA2MDU5MS10bWhzc2luMmgyMWxjcmUyMzV2dG9sb2poNGc0MDNlc' +
  'C5hcHBzLmdvb2dsZXVzZXJjb250ZW50LmNvbQ==',
  'base64',
 ).toString('utf8');
const ANTIGRAVITY_CLIENT_SECRET = process.env.ANTIGRAVITY_CLIENT_SECRET || Buffer.from(
  'R09DU1BYLUs1OEZXUjQ' + '4NkxkTEoxbUxCOHNYQzR6NnFEQWY=',
  'base64',
 ).toString('utf8');

function getAntigravityCliTokenPath() {
  return process.env.ANTIGRAVITY_CLI_TOKEN_PATH
    || path.join(getAntigravityDataDir(), 'antigravity-oauth-token');
}

async function readAntigravityAuth() {
  const cliTokenPath = getAntigravityCliTokenPath();
  const antigravityAuthPath = process.env.PI_AUTH_PATH || path.join(getHomeDir(), '.pi', 'agent', 'auth.json');
  // Primary: Pi agent auth store (has { antigravity: { access, refresh, expires } })
  try {
    const auth = JSON.parse(await readFile(antigravityAuthPath, 'utf8'));
    const credentials = auth.antigravity;
    if (credentials && (credentials.access || credentials.refresh)) {
      return { ...credentials, authPath: antigravityAuthPath };
    }
  } catch { /* fall through */ }

  // Fallback: AGY CLI token file ({ token: { access_token, refresh_token, expiry }, auth_method })
  try {
    const raw = JSON.parse(await readFile(cliTokenPath, 'utf8'));
    const tok = raw.token || {};
    if (!tok.access_token && !tok.refresh_token) return null;
    return {
      access: tok.access_token || null,
      refresh: tok.refresh_token || null,
      expires: tok.expiry ? Date.parse(tok.expiry) : 0,
      authPath: cliTokenPath,
    };
  } catch { /* fall through */ }

  return null;
}

function antigravityHeaders(token) {
  return {
    Authorization: `Bearer ${token}`,
    'Content-Type': 'application/json',
    Accept: 'application/json',
    'User-Agent': process.env.ANTIGRAVITY_USER_AGENT || 'antigravity/1.15.8 linux/amd64',
    'X-Goog-Api-Client': 'google-cloud-sdk vscode_cloudshelleditor/0.1',
    'Client-Metadata': JSON.stringify({ ideType: 'ANTIGRAVITY', platform: 'LINUX', pluginType: 'GEMINI' }),
  };
}

async function refreshAntigravityToken(credentials) {
  if (!credentials.refresh) throw new Error('no Antigravity refresh token');
  const body = new URLSearchParams({
    client_id: ANTIGRAVITY_CLIENT_ID,
    client_secret: ANTIGRAVITY_CLIENT_SECRET,
    grant_type: 'refresh_token',
    refresh_token: credentials.refresh,
  });
  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { Accept: 'application/json', 'Content-Type': 'application/x-www-form-urlencoded' },
    body,
    signal: AbortSignal.timeout(15_000),
  });
  if (!res.ok) throw new Error(`OAuth refresh ${res.status}`);
  const token = await res.json();
  if (!token.access_token) throw new Error('OAuth refresh returned no access token');
  return {
    access: token.access_token,
    refresh: token.refresh_token || credentials.refresh,
    expires: Date.now() + Number(token.expires_in || 3600) * 1000,
  };
}

async function getAntigravityAccessToken() {
  const credentials = await readAntigravityAuth();
  if (!credentials) throw new Error('no Antigravity credentials');
  const tokenKey = credentials.authPath || ANTIGRAVITY_AUTH_PATH;
  const cached = antigravityTokens.get(tokenKey);
  const expires = Number(credentials.expires || 0);
  if (credentials.access && expires > Date.now() + ANTIGRAVITY_TOKEN_EARLY_REFRESH_MS) {
    return credentials.access;
  }
  if (cached?.access && cached.expires > Date.now() + ANTIGRAVITY_TOKEN_EARLY_REFRESH_MS) {
    return cached.access;
  }
  const refreshed = await refreshAntigravityToken(credentials);
  antigravityTokens.set(tokenKey, refreshed);
  return refreshed.access;
}

async function postAntigravity(pathname, token, body = {}) {
  let lastError = '';
  for (const endpoint of ANTIGRAVITY_ENDPOINTS) {
    try {
      const res = await fetch(`${endpoint}${pathname}`, {
        method: 'POST',
        headers: antigravityHeaders(token),
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(20_000),
      });
      const text = await res.text();
      let data;
      try { data = JSON.parse(text); } catch { data = {}; }
      if (res.ok) return data;
      lastError = `${pathname} ${res.status}: ${data?.error?.message || text.slice(0, 200)}`;
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
    }
  }
  throw new Error(lastError || `${pathname} unavailable`);
}

function compactAntigravityLabel(groupName, bucketName) {
  const group = String(groupName || 'Quota')
    .replace(/Claude and GPT models/i, 'Claude/GPT')
    .replace(/Gemini Models/i, 'Gemini');
  const bucket = String(bucketName || 'Limit')
    .replace(/Five Hour Limit/i, '5h')
    .replace(/Weekly Limit/i, 'Weekly')
    .replace(/\s+Limit$/i, '');
  return `${group} · ${bucket}`;
}
function parseAntigravityRateLimits(summary, assist) {
  const windows = [];
  for (const group of summary?.groups || []) {
    for (const bucket of group.buckets || []) {
      if (typeof bucket.remainingFraction !== 'number') continue;
      const remaining = Math.max(0, Math.min(1, bucket.remainingFraction));
      windows.push({
        label: compactAntigravityLabel(group.displayName, bucket.displayName || bucket.window),
        percent: Math.round((1 - remaining) * 100),
        remainingPercent: Math.round(remaining * 100),
        resetsAt: bucket.resetTime || null,
      });
    }
  }
  const productTier = assist?.paidTier || assist?.currentTier;
  return {
    fetchedAtMs: Date.now(),
    ageMinutes: 0,
    live: true,
    source: 'antigravity-quota-summary',
    windows,
    planLabel: productTier?.name || null,
  };
}

async function fetchLiveAntigravityRateLimits(token) {
  const [summary, assist] = await Promise.all([
    postAntigravity('/v1internal:retrieveUserQuotaSummary', token),
    postAntigravity('/v1internal:loadCodeAssist', token, {
      metadata: { ideType: 'ANTIGRAVITY', platform: 'PLATFORM_UNSPECIFIED', pluginType: 'GEMINI' },
    }).catch(() => null),
  ]);
  return parseAntigravityRateLimits(summary, assist);
}

// --- failing providers ------------------------------------------------------
//
// A rate-limit endpoint that is down gets retried on the same cadence as one
// that works, so a permanently broken account (an Antigravity login that
// answers "Verify your account to continue") pays its full network timeout on
// every single pass - measured at 5.6s of a 9.5s refresh, for a number that
// was never going to arrive. Consecutive failures back off; one success
// forgets the whole history.
const FAIL_BACKOFF_MS = [60_000, 5 * 60_000, 15 * 60_000, 60 * 60_000];
const failureState = new Map(); // key -> { n, at, message }

function failureHold(key) {
  const f = failureState.get(key);
  if (!f) return false;
  const wait = FAIL_BACKOFF_MS[Math.min(f.n - 1, FAIL_BACKOFF_MS.length - 1)];
  return Date.now() - f.at < wait;
}

function noteFailure(key, message) {
  const prev = failureState.get(key);
  failureState.set(key, { n: (prev?.n || 0) + 1, at: Date.now(), message });
}

function clearFailure(key) {
  failureState.delete(key);
}

/** What is currently being skipped, and for how long - for the cache panel. */
function failureReport() {
  const now = Date.now();
  return [...failureState.entries()].map(([key, f]) => {
    const wait = FAIL_BACKOFF_MS[Math.min(f.n - 1, FAIL_BACKOFF_MS.length - 1)];
    return { key, failures: f.n, message: f.message, retryInMs: Math.max(0, wait - (now - f.at)) };
  });
}

// --- Antigravity, asked locally ----------------------------------------------
//
// Antigravity's IDE runs a language server on loopback and already knows the
// answer: it holds the signed-in user's plan and the remaining fraction of
// every model's quota, because that is what it draws in its own UI. Asking it
// is a request to 127.0.0.1 against the user's own running process - no Google
// endpoint, no OAuth refresh, no embedded client credentials, and nothing
// leaves the machine.
//
// The server authenticates callers with a CSRF token it puts on its own
// command line, and listens on an ephemeral port with a self-signed
// certificate. So: find the process, take the token, try its listening ports.
//
// This is the same route the Antigravity quota extensions use. When the IDE is
// not running there is nothing to ask, and the caller falls back to whatever
// was last known.

const AG_SERVER_NAMES = {
  'linux:x64': 'language_server_linux_x64',
  'linux:arm64': 'language_server_linux_arm',
  'darwin:arm64': 'language_server_macos_arm',
  'darwin:x64': 'language_server_macos',
};

const AG_LOCAL_TTL_MS = 60_000;
let agLocal = { at: 0, value: null };

function execOut(cmd, args, timeout = 2500) {
  return new Promise((resolve) => {
    try {
      execFile(cmd, args, { timeout, maxBuffer: 1 << 20 }, (err, stdout) => resolve(err && !stdout ? '' : String(stdout || '')));
    } catch { resolve(''); }
  });
}

/** The language server's pid and CSRF token, or null when the IDE is not up. */
async function antigravityServerProcess() {
  if (process.platform === 'win32') return null; // no pgrep; not worth shelling wmic
  const name = AG_SERVER_NAMES[`${process.platform}:${process.arch}`];
  if (!name) return null;
  const out = await execOut('pgrep', ['-fa', name]);
  for (const line of out.split('\n')) {
    if (!line.trim() || !line.includes(name)) continue;
    const pid = Number(line.trim().split(/\s+/)[0]);
    const csrf = /--csrf_token[= ]+([A-Za-z0-9._-]+)/.exec(line)?.[1];
    if (pid && csrf) return { pid, csrf };
  }
  return null;
}

/** Ports that pid is listening on, newest tooling first. */
async function listeningPorts(pid) {
  const ports = new Set();
  const take = (text) => {
    for (const m of text.matchAll(/:(\d{2,5})\b/g)) {
      const n = Number(m[1]);
      if (n > 1024) ports.add(n);
    }
  };
  const ss = await execOut('ss', ['-tlnp']);
  for (const line of ss.split('\n')) if (line.includes(`pid=${pid},`)) take(line);
  if (!ports.size) {
    const lsof = await execOut('lsof', ['-nP', '-a', '-iTCP', '-sTCP:LISTEN', '-p', String(pid)]);
    for (const line of lsof.split('\n')) if (line.includes('LISTEN')) take(line);
  }
  return [...ports];
}

/** One Connect-protocol POST to the local server. Self-signed cert by design. */
function postLocalLanguageServer(port, csrf, method, body) {
  return new Promise((resolve) => {
    const payload = JSON.stringify(body);
    const req = https.request({
      host: '127.0.0.1',
      port,
      path: `/exa.language_server_pb.LanguageServerService/${method}`,
      method: 'POST',
      rejectUnauthorized: false, // loopback, the IDE's own self-signed cert
      timeout: 4000,
      headers: {
        'Content-Type': 'application/json',
        'X-Codeium-Csrf-Token': csrf,
        'Connect-Protocol-Version': '1',
        'Content-Length': Buffer.byteLength(payload),
      },
    }, (res) => {
      let data = '';
      res.setEncoding('utf8');
      res.on('data', (c) => { data += c; });
      res.on('end', () => {
        try { resolve(JSON.parse(data)); } catch { resolve(null); }
      });
    });
    req.on('error', () => resolve(null));
    req.on('timeout', () => { req.destroy(); resolve(null); });
    req.end(payload);
  });
}

/** GetUserStatus, shaped like every other provider's rate-limit block. */
function parseAntigravityLocalStatus(data) {
  const userStatus = data?.userStatus;
  if (!userStatus) return null;
  const configs = userStatus.cascadeModelConfigData?.clientModelConfigs || [];
  const windows = [];
  for (const model of configs) {
    const quota = model?.quotaInfo;
    if (!quota) continue;
    const label = String(model.label || 'Model');
    // No remainingFraction but a resetTime means the bucket is spent; neither
    // means the model is not metered at all, which is not a window to draw.
    if (typeof quota.remainingFraction !== 'number') {
      if (!quota.resetTime) continue;
      windows.push({ label, percent: 100, remainingPercent: 0, resetsAt: quota.resetTime });
      continue;
    }
    const remaining = Math.max(0, Math.min(1, quota.remainingFraction));
    windows.push({
      label,
      percent: Math.round((1 - remaining) * 100),
      remainingPercent: Math.round(remaining * 100),
      resetsAt: quota.resetTime || null,
    });
  }
  if (!windows.length) return null;
  return {
    fetchedAtMs: Date.now(),
    ageMinutes: 0,
    live: true,
    source: 'antigravity-language-server',
    windows,
    planLabel: userStatus.planStatus?.planInfo?.planName || null,
  };
}

async function getAntigravityLocalRateLimits() {
  const now = Date.now();
  if (agLocal.value && now - agLocal.at < AG_LOCAL_TTL_MS) {
    return { ...agLocal.value, ageMinutes: Math.round((now - agLocal.at) / 60000) };
  }
  const proc = await antigravityServerProcess();
  if (!proc) return null;
  for (const port of await listeningPorts(proc.pid)) {
    const data = await postLocalLanguageServer(port, proc.csrf, 'GetUserStatus', {
      metadata: { ideName: 'antigravity', extensionName: 'antigravity', locale: 'en' },
    });
    const parsed = parseAntigravityLocalStatus(data);
    if (parsed) {
      agLocal = { at: now, value: parsed };
      return parsed;
    }
  }
  return null;
}

async function getAntigravityRateLimits(account, force = false) {
  const now = Date.now();

  // The local language server first, always. It is the same data, it is on
  // loopback, and it costs no request to anyone's servers - so a background
  // pass never reaches for the network at all.
  const local = await getAntigravityLocalRateLimits();
  if (local) {
    antigravityLimits.set(account.id, { value: local, at: now });
    clearFailure(`antigravity:${account.id}`);
    return local;
  }

  const cached = antigravityLimits.get(account.id);
  // Nothing local to read: serve what was last known and stop there. The
  // remote call is reserved for an explicit Refresh.
  if (!force) {
    if (cached) return { ...cached.value, ageMinutes: Math.round((now - cached.at) / 60000), live: false };
    // Say why there is nothing rather than drawing an empty card. The IDE
    // holds these numbers; when it is closed nobody local knows them.
    return {
      fetchedAtMs: now,
      live: false,
      source: 'antigravity-language-server',
      windows: [],
      note: 'Antigravity is not running - open the IDE, or press Refresh to ask upstream.',
    };
  }
  const failKey = `antigravity:${account.id}`;
  if (!force && failureHold(failKey)) {
    return cached ? cached.value : { error: failureState.get(failKey)?.message, backingOff: true };
  }
  lastAntigravityLiveAttemptAt.set(account.id, now);
  try {
    const token = await getAntigravityAccessToken();
    const fresh = await fetchLiveAntigravityRateLimits(token);
    antigravityLimits.set(account.id, { value: fresh, at: now });
    clearFailure(failKey);
    return fresh;
  } catch (error) {
    const message = error?.message || String(error);
    noteFailure(failKey, message);
    const { n } = failureState.get(failKey);
    // Say it once per escalation, not once per pass: this used to print every
    // five minutes forever.
    if (n <= FAIL_BACKOFF_MS.length) {
      console.error(`cc-usage-dashboard: Antigravity rate-limit fetch failed (${n}x, backing off): ${message}`);
    }
    return cached ? cached.value : { error: message };
  }
}


// --- Claude rate limits ------------------------------------------------------
// Claude Code's own rate-limit endpoint. Confirmed by Anthropic's public
// issue tracker (anthropics/claude-code#31637, #31021) and by the
// Claude-Code-Usage-Monitor project — it's aggressively rate-limited (429s),
// so it's only ever hit on an explicit manual refresh. Normal/background
// reads always come from local caches instead (see getCachedClaudeRateLimits).
const LIMITS_REFRESH_BACKOFF_MS = 15 * 60_000;
const lastLiveAttemptAt = new Map(); // accountId -> ms

async function fetchLiveClaudeRateLimits(accessToken) {
  const res = await fetch('https://api.anthropic.com/api/oauth/usage', {
    headers: {
      Authorization: `Bearer ${accessToken}`,
      'anthropic-beta': 'oauth-2025-04-20',
      'User-Agent': 'claude-code/2.1.212',
      'Content-Type': 'application/json',
    },
  });
  if (!res.ok) throw new Error(`usage endpoint ${res.status}`);
  const u = await res.json();
  return {
    fetchedAtMs: Date.now(),
    ageMinutes: 0,
    live: true,
    session: u.five_hour ? { percent: u.five_hour.utilization, resetsAt: u.five_hour.resets_at } : null,
    weekly: u.seven_day ? { percent: u.seven_day.utilization, resetsAt: u.seven_day.resets_at } : null,
  };
}

// Snapshot written by statusline.js — captures Claude Code's rate_limits
// straight off the statusline stdin payload, which the CLI refreshes after
// every prompt (rate_limits appears after the first API response; statusline
// reruns on every prompt). Freshest possible source, zero API calls.
function statuslineSnapshotFilename(accountId) {
  return `claude-live-limits-${accountId}.json`;
}

async function getStatuslineSnapshotDirs(account) {
  const dirs = [__dirname];
  try {
    const settings = JSON.parse(await readFile(path.join(account.configDir, 'settings.json'), 'utf8'));
    const command = settings.statusLine?.command || '';
    const match = command.match(/(?:^|\s)(?:"([^"]+statusline\.js)"|'([^']+statusline\.js)'|(\S+statusline\.js))(?:\s|$)/);
    const scriptPath = match?.[1] || match?.[2] || match?.[3];
    if (scriptPath) dirs.push(path.dirname(path.resolve(account.configDir, scriptPath)));
  } catch {}
  return [...new Set(dirs)];
}

async function getStatuslineClaudeRateLimits(account) {
  const snapshotPaths = (await getStatuslineSnapshotDirs(account))
    .map((dir) => path.join(dir, statuslineSnapshotFilename(account.id)));
  const snapshots = await Promise.all(snapshotPaths.map(async (snapshotPath) => {
    try {
      const raw = await readFile(snapshotPath, 'utf8');
      const u = JSON.parse(raw);
      // Only trust self-identifying snapshots. This also rejects legacy files
      // that may already have been written under the wrong account filename.
      if (u.accountId !== account.id) return null;
      if (!u.session && !u.weekly) return null;
      return {
        fetchedAtMs: u.fetchedAtMs,
        ageMinutes: Math.round((Date.now() - u.fetchedAtMs) / 60000),
        live: false,
        source: 'statusline',
        session: u.session,
        weekly: u.weekly,
      };
    } catch {
      return null;
    }
  }));
  return snapshots.filter(Boolean).sort((a, b) => b.fetchedAtMs - a.fetchedAtMs)[0] || null;
}

async function getConfigCacheClaudeRateLimits(configDir) {
  try {
    const raw = await readFile(path.join(configDir, '.claude.json'), 'utf8');
    const data = JSON.parse(raw);
    const u = data.cachedUsageUtilization;
    if (!u || !u.utilization) return null;
    const { five_hour, seven_day } = u.utilization;
    return {
      fetchedAtMs: u.fetchedAtMs,
      ageMinutes: Math.round((Date.now() - u.fetchedAtMs) / 60000),
      live: false,
      source: 'claude-cache',
      session: five_hour ? { percent: five_hour.utilization, resetsAt: five_hour.resets_at } : null,
      weekly: seven_day ? { percent: seven_day.utilization, resetsAt: seven_day.resets_at } : null,
    };
  }
  catch {
    return null;
  }
}

async function getCachedClaudeRateLimits(account) {
  const [statusline, configCache] = await Promise.all([
    getStatuslineClaudeRateLimits(account),
    getConfigCacheClaudeRateLimits(account.configDir),
  ]);
  if (!statusline) return configCache;
  if (!configCache) return statusline;
  return statusline.fetchedAtMs >= configCache.fetchedAtMs ? statusline : configCache;
}

// Which Claude login a profile directory currently holds. A profile keeps its
// name across a re-authentication — an expired subscription replaced via device
// OAuth lands in the same directory — but the limit percentages afterwards
// belong to whichever account is now signed in. Stamping readings with the
// account UUID is what lets a window that straddles a switch be spotted instead
// of silently averaging two accounts' rates together.
async function claudeAccountIdentity(configDir) {
  try {
    const data = JSON.parse(await readFile(path.join(configDir, '.claude.json'), 'utf8'));
    const uuid = data.oauthAccount?.accountUuid || data.cachedUsageUtilization?.accountUuid;
    if (!uuid) return null;
    return { accountUuid: uuid, organizationName: data.oauthAccount?.organizationName || null };
  } catch {
    return null;
  }
}

async function withClaudeIdentity(account, limitsPromise) {
  const [limits, identity] = await Promise.all([limitsPromise, claudeAccountIdentity(account.configDir)]);
  if (!limits || !identity) return limits;
  return { ...limits, ...identity };
}

async function getClaudeRateLimits(account, force = false) {
  if (!force) {
    return withClaudeIdentity(account, getCachedClaudeRateLimits(account));
  }
  const now = Date.now();
  if (now - (lastLiveAttemptAt.get(account.id) || 0) < LIMITS_REFRESH_BACKOFF_MS) {
    return withClaudeIdentity(account, getCachedClaudeRateLimits(account));
  }
  lastLiveAttemptAt.set(account.id, now);
  try {
    const raw = await readFile(path.join(account.configDir, '.credentials.json'), 'utf8');
    const accessToken = JSON.parse(raw).claudeAiOauth?.accessToken;
    if (!accessToken) throw new Error('no access token');
    return await withClaudeIdentity(account, fetchLiveClaudeRateLimits(accessToken));
  } catch {
    return withClaudeIdentity(account, getCachedClaudeRateLimits(account));
  }
}

// --- Codex rate limits ---------------------------------------------------
// Reverse-engineered from the openai.chatgpt VS Code extension's webview
// bundle (confirmed by openai/codex#10869 and the CodexBar project). Codex
// CLI itself polls this ~every 60s so it isn't known to be as aggressively
// rate-limited as Anthropic's — still backed off the same way to be
// conservative with the account token.
const liveCodexLimits = new Map(); // accountId -> {value, at}
const lastCodexLiveAttemptAt = new Map();

async function fetchLiveCodexRateLimits(accessToken, chatgptAccountId) {
  const headers = {
    Authorization: `Bearer ${accessToken}`,
    'chatgpt-account-id': chatgptAccountId,
    'User-Agent': 'codex_cli_rs/0.1.0',
  };
  const [res, resetCreditsRes] = await Promise.all([
    fetch('https://chatgpt.com/backend-api/wham/usage', { headers }),
    fetch('https://chatgpt.com/backend-api/wham/rate-limit-reset-credits', { headers }).catch(() => null),
  ]);
  if (!res.ok) throw new Error(`usage endpoint ${res.status}`);
  const u = await res.json();

  // The usage endpoint exposes the count, while this endpoint exposes each
  // reset credit's expiry. Keep the usage response usable if the latter is
  // unavailable for an account or an older backend.
  let resetCreditsPayload = null;
  if (resetCreditsRes?.ok) {
    try { resetCreditsPayload = await resetCreditsRes.json(); } catch {}
  }
  const availableResetCredits = (resetCreditsPayload?.credits || [])
    .filter((credit) => (!credit.status || credit.status === 'available') && credit.expires_at)
    .sort((a, b) => new Date(a.expires_at) - new Date(b.expires_at));
  const toEntry = (w) => (w ? { percent: w.used_percent, resetsAt: new Date(w.reset_at * 1000).toISOString() } : null);
  // Codex's rate limiter is percent-of-window based, not a token count, so
  // there's no literal "tokens left" to show. The closest real numbers it
  // does expose are message-credit balance/estimates (only present on
  // credit-based plans) — surfaced as-is, not fabricated.
  const credits = u.credits?.has_credits
    ? {
        balance: Number(u.credits.balance),
        approxLocalMessages: u.credits.approx_local_messages || null,
        approxCloudMessages: u.credits.approx_cloud_messages || null,
      }
    : null;
  // Separate from credits: a banked count of manual rate-limit resets you
  // can spend to clear the window early (ChatGPT plan perk), not a token
  // or message balance.
  const resetSummary = u.rate_limit_reset_credits;
  const resetsAvailable = resetSummary || availableResetCredits.length
    ? {
        available: resetSummary?.available_count ?? availableResetCredits.length,
        applicableAvailable: resetSummary?.applicable_available_count ?? availableResetCredits.length,
        // Show the next expiry when several banked resets exist.
        expiresAt: availableResetCredits[0]?.expires_at || null,
      }
    : null;
  // primary_window / secondary_window position is NOT stable — Codex has
  // swapped which window is primary vs secondary (5h was secondary before,
  // primary now). Classify by window duration instead: 300 min (18000s) is
  // the 5h session window, 10080 min (604800s) is the weekly window.
  const windows = [u.rate_limit?.primary_window, u.rate_limit?.secondary_window].filter(Boolean);
  let weekly = null;
  let session = null;
  for (const w of windows) {
    const secs = Number(w.limit_window_seconds) || Number(w.window_minutes) * 60 || 0;
    const entry = toEntry(w);
    if (secs >= 604800 - 3600) weekly = entry;
    else if (secs >= 300 * 60 - 60) session = entry;
    else {
      // Fallback for old payloads that lack duration: treat first as weekly
      if (!weekly) weekly = entry;
      else if (!session) session = entry;
    }
  }
  // Extremely old payloads only sent primary_window (weekly) — keep that
  // assignment when no duration is present and only one window exists.
  if (!weekly && !session && windows.length === 1) weekly = toEntry(windows[0]);
  return {
    fetchedAtMs: Date.now(),
    ageMinutes: 0,
    live: true,
    weekly,
    session,
    credits,
    resetsAvailable,
  };
}

async function getCodexRateLimits(account, force = false) {
  const now = Date.now();
  const cached = liveCodexLimits.get(account.id);
  // Codex writes its own rate limits into every rollout transcript - the same
  // percentages, windows, reset times, credit balance and plan the endpoint
  // returns, at finer resolution than we could ever poll for. A background
  // pass reads those (scanCodexSessions -> formatCodexLocalRateLimits) and
  // never touches the network; Refresh is what asks upstream.
  if (!force) {
    return cached
      ? { ...cached.value, ageMinutes: Math.round((now - cached.at) / 60000), live: false }
      : null;
  }
  lastCodexLiveAttemptAt.set(account.id, now);
  try {
    const raw = await readFile(path.join(account.configDir, 'auth.json'), 'utf8');
    const t = JSON.parse(raw).tokens;
    if (!t?.access_token || !t?.account_id) throw new Error('no access token');
    const fresh = await fetchLiveCodexRateLimits(t.access_token, t.account_id);
    liveCodexLimits.set(account.id, { value: fresh, at: now });
    return fresh;
  } catch {
    return cached ? cached.value : null;
  }
}

// --- Grok / xAI rate limits ------------------------------------------------
// Grok CLI's /usage command hits cli-chat-proxy billing endpoints with the
// OIDC token from ~/.grok/auth.json. Default /billing exposes monthly
// included credits; ?format=credits exposes the weekly window + prepaid/
// on-demand balances. Reverse-engineered from xai-grok-shell billing.rs.
const liveGrokLimits = new Map(); // accountId -> {value, at}
const lastGrokLiveAttemptAt = new Map();
const GROK_PROXY_BASE = process.env.GROK_CLI_CHAT_PROXY_BASE_URL || 'https://cli-chat-proxy.grok.com/v1';
// The browser polls /api/usage every 30s. Keep this independent from the
// other providers' conservative 15-minute backoff: Grok's billing endpoint
// is the authoritative source and is cheap enough to follow that cadence.
const GROK_LIVE_REFRESH_MS = 30_000;
const GROK_AUTH_EARLY_INVALIDATION_MS = 5 * 60_000;
const grokOidcDiscovery = new Map(); // issuer -> token endpoint

function grokVal(v) {
  if (v == null) return null;
  if (typeof v === 'number') return v;
  if (typeof v === 'object' && typeof v.val === 'number') return v.val;
  return null;
}

function readGrokAuthEntry(authJson) {
  // Shape: { "https://auth.x.ai::<clientId>": { key, refresh_token, expires_at, ... } }
  // Prefer a non-expired entry, then the one with the latest expiry. Keep the
  // storage key because a refresh may rotate both key and refresh_token.
  const entries = Object.entries(authJson || {})
    .filter(([, e]) => e && typeof e === 'object' && (e.key || e.refresh_token));
  if (!entries.length) return null;
  const now = Date.now();
  entries.sort(([, a], [, b]) => {
    const aActive = a.key && (!a.expires_at || Date.parse(a.expires_at) > now) ? 1 : 0;
    const bActive = b.key && (!b.expires_at || Date.parse(b.expires_at) > now) ? 1 : 0;
    return bActive - aActive || Date.parse(b.expires_at || 0) - Date.parse(a.expires_at || 0);
  });
  return { storageKey: entries[0][0], entry: entries[0][1] };
}

async function grokOidcTokenEndpoint(issuer) {
  if (!issuer) return null;
  const normalizedIssuer = issuer.replace(/\/$/, '');
  if (grokOidcDiscovery.has(normalizedIssuer)) return grokOidcDiscovery.get(normalizedIssuer);
  try {
    const res = await fetch(`${normalizedIssuer}/.well-known/openid-configuration`, {
      signal: AbortSignal.timeout(10_000),
    });
    if (res.ok) {
      const endpoint = (await res.json()).token_endpoint;
      if (endpoint) {
        grokOidcDiscovery.set(normalizedIssuer, endpoint);
        return endpoint;
      }
    }
  } catch {}
  // xAI's issuer follows the conventional endpoint even if discovery is
  // temporarily unavailable. This also keeps refresh working offline from
  // a cached auth file after the dashboard has already been configured.
  const fallback = `${normalizedIssuer}/oauth2/token`;
  grokOidcDiscovery.set(normalizedIssuer, fallback);
  return fallback;
}

async function refreshGrokAuth(configDir, authJson, selected) {
  const entry = selected?.entry;
  if (!entry?.refresh_token || !entry.oidc_issuer || !entry.oidc_client_id) return null;
  const tokenEndpoint = await grokOidcTokenEndpoint(entry.oidc_issuer);
  if (!tokenEndpoint) return null;

  const body = new URLSearchParams({
    grant_type: 'refresh_token',
    refresh_token: entry.refresh_token,
    client_id: entry.oidc_client_id,
  });
  const res = await fetch(tokenEndpoint, {
    method: 'POST',
    headers: { Accept: 'application/json', 'Content-Type': 'application/x-www-form-urlencoded' },
    body,
    signal: AbortSignal.timeout(15_000),
  });
  if (!res.ok) throw new Error(`OIDC refresh ${res.status}`);
  const refreshed = await res.json();
  if (!refreshed.access_token) throw new Error('OIDC refresh returned no access token');

  const updated = {
    ...entry,
    key: refreshed.access_token,
    refresh_token: refreshed.refresh_token || entry.refresh_token,
    expires_at: refreshed.expires_in
      ? new Date(Date.now() + Number(refreshed.expires_in) * 1000).toISOString()
      : entry.expires_at,
  };
  authJson[selected.storageKey] = updated;
  // Match Grok's owner-only credential file permissions. The CLI may update
  // this file too, but retaining the existing JSON shape keeps both clients
  // compatible and lets the refreshed token survive a dashboard restart.
  await writeFile(path.join(configDir, 'auth.json'), `${JSON.stringify(authJson, null, 2)}\n`, { mode: 0o600 });
  return updated.key;
}

async function getGrokAccessToken(configDir, forceRefresh = false) {
  const authPath = path.join(configDir, 'auth.json');
  const authJson = JSON.parse(await readFile(authPath, 'utf8'));
  const selected = readGrokAuthEntry(authJson);
  if (!selected) return null;
  const { entry } = selected;
  const expiresAt = Date.parse(entry.expires_at || '');
  const expiresSoon = Number.isFinite(expiresAt)
    && expiresAt <= Date.now() + GROK_AUTH_EARLY_INVALIDATION_MS;
  if (!forceRefresh && entry.key && !expiresSoon) return entry.key;
  if (entry.refresh_token) {
    try { return await refreshGrokAuth(configDir, authJson, selected); } catch {}
  }
  return entry.key || null;
}

// /v1/billing (default) can take several seconds; credits is faster.
// 20s matches what we measured for a cold monthly response (~4s) with headroom.
async function fetchGrokBilling(accessToken, search = '', timeoutMs = 20_000) {
  const res = await fetch(`${GROK_PROXY_BASE}/billing${search}`, {
    headers: {
      Authorization: `Bearer ${accessToken}`,
      Accept: 'application/json',
      'User-Agent': 'grok-cli/0.2.106',
      'x-grok-client-mode': 'cli',
      'x-grok-client-version': '0.2.106',
    },
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!res.ok) {
    const error = new Error(`billing endpoint ${res.status}`);
    error.status = res.status;
    throw error;
  }
  return res.json();
}

// Normalize monthly (/v1/billing) + credits (?format=credits) configs.
// Live shape from cli-chat-proxy (OIDC session token, same as Grok CLI /usage):
//   monthly: { monthlyLimit:{val}, used:{val}, billingPeriodStart/End, ... }
//   credits: { creditUsagePercent, currentPeriod:{end}, onDemand*, prepaidBalance,
//              isUnifiedBillingUser, productUsage:[{product, usagePercent}], ... }
// Unified-billing accounts (X Premium+ / GrokBuild) report monthlyLimit/used as 0.
// Their real quota is the weekly creditUsagePercent window.
function grokRateLimitsFromConfigs(monthly = {}, credits = {}, {
  live = false,
  source = 'grok-billing',
  fetchedAtMs = Date.now(),
  subscriptionTier = null,
} = {}) {
  let monthlyLimit = grokVal(monthly.monthlyLimit) ?? grokVal(credits.monthlyLimit);
  let monthlyUsed = grokVal(monthly.used) ?? grokVal(credits.used) ?? grokVal(credits.includedUsed) ?? grokVal(credits.totalUsed);
  const unifiedBilling = !!(credits.isUnifiedBillingUser || monthly.isUnifiedBillingUser
    || monthlyLimit === 0);

  // xAI returns {val:0} for the legacy monthly pool once an account is on
  // unified billing. Treat zero as "no monthly pool", not 0/0 usage.
  if (monthlyLimit == null || monthlyLimit <= 0) {
    monthlyLimit = null;
    monthlyUsed = null;
  }

  const weeklyResetsAt = credits.currentPeriod?.end || credits.billingPeriodEnd
    || monthly.currentPeriod?.end || monthly.billingPeriodEnd || null;

  const weeklyBar = (() => {
    if (typeof credits.creditUsagePercent === 'number') {
      return {
        percent: Math.round(credits.creditUsagePercent),
        resetsAt: weeklyResetsAt,
      };
    }
    if (typeof monthly.creditUsagePercent === 'number') {
      return {
        percent: Math.round(monthly.creditUsagePercent),
        resetsAt: weeklyResetsAt,
      };
    }
    // productUsage sometimes carries per-product weekly % (Api / GrokBuild).
    const products = credits.productUsage || monthly.productUsage;
    if (Array.isArray(products) && products.length) {
      const build = products.find((p) => /grokbuild|build/i.test(p.product || '')) || products[0];
      if (typeof build?.usagePercent === 'number') {
        return {
          percent: Math.round(build.usagePercent),
          resetsAt: weeklyResetsAt,
        };
      }
    }
    if (weeklyResetsAt) {
      return {
        percent: null,
        resetsAt: weeklyResetsAt,
        windowOnly: true,
      };
    }
    return null;
  })();

  const monthlyBar = monthlyLimit != null && monthlyUsed != null
    ? {
        percent: Math.min(100, Math.round((monthlyUsed / monthlyLimit) * 100)),
        resetsAt: monthly.billingPeriodEnd || null,
        used: monthlyUsed,
        limit: monthlyLimit,
      }
    : null;

  const weekly = weeklyBar && weeklyBar.percent != null
    ? { percent: weeklyBar.percent, resetsAt: weeklyBar.resetsAt, label: 'Weekly' }
    : weeklyBar && weeklyBar.windowOnly
      ? { percent: 0, resetsAt: weeklyBar.resetsAt, label: 'Weekly', windowOnly: true }
      : null;

  // Product bars (e.g. GrokBuild) — skip duplicates of the overall weekly %.
  const productWindows = [];
  const products = credits.productUsage || monthly.productUsage;
  if (Array.isArray(products)) {
    for (const p of products) {
      if (typeof p?.usagePercent !== 'number') continue;
      const label = String(p.product || 'Product');
      const percent = Math.round(p.usagePercent);
      if (weekly && weekly.percent === percent && /grokbuild|build/i.test(label)) continue;
      productWindows.push({ label, percent, resetsAt: weeklyResetsAt });
    }
  }

  // Prefer an explicit windows list so the UI can render Monthly + Weekly,
  // or just Weekly for unified-billing accounts without a blank Monthly slot.
  const windows = [];
  if (monthlyBar) {
    windows.push({
      label: 'Monthly',
      percent: monthlyBar.percent,
      resetsAt: monthlyBar.resetsAt,
      used: monthlyBar.used,
      limit: monthlyBar.limit,
    });
  }
  if (weekly && weekly.percent != null) {
    windows.push({
      label: weekly.label || 'Weekly',
      percent: weekly.percent,
      resetsAt: weekly.resetsAt,
    });
  } else if (weekly && weekly.windowOnly) {
    windows.push({
      label: 'Weekly',
      percent: 0,
      resetsAt: weekly.resetsAt,
      windowOnly: true,
    });
  }
  for (const pw of productWindows) windows.push(pw);

  const onDemandCap = grokVal(credits.onDemandCap) ?? grokVal(monthly.onDemandCap);
  const onDemandUsed = grokVal(credits.onDemandUsed) ?? grokVal(monthly.onDemandUsed) ?? 0;
  const prepaidBalance = grokVal(credits.prepaidBalance) ?? grokVal(monthly.prepaidBalance);
  const planLabel = subscriptionTier || credits.subscriptionTier || monthly.subscriptionTier || null;

  const creditsOut = (() => {
    const hasPrepaid = prepaidBalance != null;
    const hasOnDemand = onDemandCap != null;
    const hasMonthly = monthlyLimit != null && monthlyLimit > 0;
    if (!hasPrepaid && !hasOnDemand && !hasMonthly) return null;
    const out = {
      balance: prepaidBalance ?? 0,
      onDemandUsed,
      onDemandCap: onDemandCap ?? 0,
    };
    if (hasMonthly) {
      out.monthlyUsed = monthlyUsed;
      out.monthlyLimit = monthlyLimit;
    }
    return out;
  })();

  return {
    fetchedAtMs,
    ageMinutes: Math.max(0, Math.round((Date.now() - fetchedAtMs) / 60000)),
    live,
    source,
    // Legacy slot mapping: session=Monthly when the pool exists.
    session: monthlyBar
      ? { percent: monthlyBar.percent, resetsAt: monthlyBar.resetsAt, label: 'Monthly', used: monthlyBar.used, limit: monthlyBar.limit }
      : null,
    weekly,
    windows: windows.length ? windows : null,
    unifiedBilling,
    planLabel,
    credits: creditsOut,
    subscriptionTier: planLabel,
  };
}

function grokLimitsComplete(limits) {
  // Monthly pool (legacy) OR a real weekly % (unified billing) is enough to cache.
  if (!limits) return false;
  if (limits.session && limits.session.label === 'Monthly' && limits.session.limit > 0) return true;
  if (limits.weekly && limits.weekly.percent != null) return true;
  if (Array.isArray(limits.windows) && limits.windows.some((w) => w && w.percent != null)) return true;
  return false;
}

function creditsHaveRealMonthly(credits) {
  return !!(credits && credits.monthlyLimit != null && credits.monthlyLimit > 0);
}

function mergeGrokLimits(primary, secondary) {
  if (!primary) return secondary || null;
  if (!secondary) return primary;
  const planLabel = primary.planLabel || primary.subscriptionTier
    || secondary.planLabel || secondary.subscriptionTier || null;
  return {
    ...secondary,
    ...primary,
    session: primary.session || secondary.session || null,
    weekly: primary.weekly || secondary.weekly || null,
    windows: (primary.windows && primary.windows.length)
      ? primary.windows
      : (secondary.windows || primary.windows || null),
    credits: creditsHaveRealMonthly(primary.credits)
      ? primary.credits
      : (creditsHaveRealMonthly(secondary.credits)
        ? secondary.credits
        : (primary.credits || secondary.credits)),
    unifiedBilling: !!(primary.unifiedBilling || secondary.unifiedBilling),
    planLabel,
    subscriptionTier: planLabel,
    source: primary.source === secondary.source
      ? primary.source
      : `${primary.source}+${secondary.source}`,
    live: !!(primary.live || secondary.live),
    fetchedAtMs: Math.max(primary.fetchedAtMs || 0, secondary.fetchedAtMs || 0),
    ageMinutes: Math.max(0, Math.round((Date.now() - Math.max(primary.fetchedAtMs || 0, secondary.fetchedAtMs || 0)) / 60000)),
  };
}

function grokLimitsSnapshotPath(accountId) {
  return path.join(__dirname, `grok-live-limits-${accountId}.json`);
}

async function writeGrokLimitsSnapshot(accountId, limits) {
  if (!limits || !grokLimitsComplete(limits)) return;
  try {
    await writeFile(grokLimitsSnapshotPath(accountId), JSON.stringify({
      accountId,
      fetchedAtMs: limits.fetchedAtMs,
      session: limits.session,
      weekly: limits.weekly,
      windows: limits.windows || null,
      unifiedBilling: !!limits.unifiedBilling,
      planLabel: limits.planLabel || limits.subscriptionTier || null,
      credits: limits.credits,
      subscriptionTier: limits.subscriptionTier || limits.planLabel || null,
      source: limits.source,
    }), 'utf8');
  } catch {}
}

async function readGrokLimitsSnapshot(accountId) {
  try {
    const raw = await readFile(grokLimitsSnapshotPath(accountId), 'utf8');
    const u = JSON.parse(raw);
    if (u.accountId !== accountId) return null;
    if (!u.session && !u.weekly && !(u.windows && u.windows.length)) return null;
    // Drop stale zeroed monthly pool from older snapshots.
    let session = u.session || null;
    let credits = u.credits || null;
    if (session && (!(session.limit > 0) || session.label === 'Monthly' && session.limit === 0)) {
      session = null;
    }
    if (credits && !(credits.monthlyLimit > 0)) {
      const { monthlyUsed, monthlyLimit, ...rest } = credits;
      credits = rest;
      if (credits.balance == null && credits.onDemandCap == null) credits = null;
    }
    const planLabel = u.planLabel || u.subscriptionTier || null;
    return {
      fetchedAtMs: u.fetchedAtMs || Date.now(),
      ageMinutes: Math.round((Date.now() - (u.fetchedAtMs || Date.now())) / 60000),
      live: false,
      source: u.source || 'grok-snapshot',
      session,
      weekly: u.weekly || null,
      windows: u.windows || null,
      unifiedBilling: !!u.unifiedBilling || !session,
      planLabel,
      credits,
      subscriptionTier: planLabel,
    };
  } catch {
    return null;
  }
}

async function fetchLiveGrokRateLimits(accessToken) {
  // Monthly (default /billing) is the source of monthlyLimit/used.
  // Credits (?format=credits) is the source of weekly creditUsagePercent.
  // Fetch independently so a slow monthly still pairs with a fast weekly.
  const [monthlyResult, creditsResult] = await Promise.allSettled([
    fetchGrokBilling(accessToken, '', 20_000),
    fetchGrokBilling(accessToken, '?format=credits', 12_000),
  ]);
  const monthlyRaw = monthlyResult.status === 'fulfilled' ? monthlyResult.value : null;
  const creditsRaw = creditsResult.status === 'fulfilled' ? creditsResult.value : null;
  if (!monthlyRaw && !creditsRaw) {
    const unauthorized = [monthlyResult, creditsResult]
      .some((result) => result.status === 'rejected' && result.reason?.status === 401);
    const error = new Error(unauthorized ? 'billing endpoints unauthorized' : 'billing endpoints unreachable');
    if (unauthorized) error.status = 401;
    throw error;
  }
  return grokRateLimitsFromConfigs(monthlyRaw?.config || {}, creditsRaw?.config || {}, {
    live: true,
    source: 'grok-billing',
    fetchedAtMs: Date.now(),
    subscriptionTier: creditsRaw?.subscriptionTier || monthlyRaw?.subscriptionTier || null,
  });
}

// Grok CLI already hits the billing proxy on every session and logs the
// credits-format response as "billing: fetched credits config" in
// ~/.grok/logs/unified.jsonl. That only covers the weekly window — monthly
// comes from the default /billing endpoint, which the CLI does not log.
async function getGrokLimitsFromCliLog(configDir) {
  const logPath = path.join(configDir, 'logs', 'unified.jsonl');
  let text;
  try {
    text = await readFile(logPath, 'utf8');
  } catch {
    return null;
  }
  const lines = text.split('\n');
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i];
    if (!line || !line.includes('billing: fetched')) continue;
    let o;
    try { o = JSON.parse(line); } catch { continue; }
    const cfg = o?.ctx?.config;
    if (!cfg || typeof cfg !== 'object') continue;
    const fetchedAtMs = o.ts ? Date.parse(o.ts) : Date.now();
    const credits = { ...cfg };
    if (o.ctx?.subscriptionTier != null && credits.subscriptionTier == null) {
      credits.subscriptionTier = o.ctx.subscriptionTier;
    }
    return grokRateLimitsFromConfigs({}, credits, {
      live: false,
      source: 'grok-cli-log',
      fetchedAtMs: Number.isFinite(fetchedAtMs) ? fetchedAtMs : Date.now(),
    });
  }
  return null;
}

async function getGrokRateLimits(account, force = false) {
  const now = Date.now();
  const cached = liveGrokLimits.get(account.id);

  // Background passes read what the CLI already wrote: its own log, and the
  // snapshot this dashboard keeps beside it. Neither is a request to xAI.
  if (!force) {
    const fromLog = await getGrokLimitsFromCliLog(account.configDir).catch(() => null);
    const snapshot = await readGrokLimitsSnapshot(account.id).catch(() => null);
    const best = mergeGrokLimits(
      grokLimitsComplete(cached?.value) ? cached.value : null,
      mergeGrokLimits(snapshot, fromLog),
    ) || cached?.value || snapshot || fromLog || null;
    return best ? { ...best, live: false } : null;
  }

  lastGrokLiveAttemptAt.set(account.id, now);
  try {
    let accessToken = await getGrokAccessToken(account.configDir);
    if (!accessToken) throw new Error('no access token');
    let fresh;
    try {
      fresh = await fetchLiveGrokRateLimits(accessToken);
    } catch (error) {
      // The CLI refreshes and retries on 401. Do the same so the dashboard
      // does not get stuck showing the last snapshot after token expiry.
      if (error.status !== 401) throw error;
      const refreshedToken = await getGrokAccessToken(account.configDir, true);
      if (!refreshedToken || refreshedToken === accessToken) throw error;
      accessToken = refreshedToken;
      fresh = await fetchLiveGrokRateLimits(accessToken);
    }
    // Stitch CLI-log weekly/plan label when the live response is partial.
    // subscriptionTier is only logged by the CLI (not always on HTTP billing).
    {
      const fromLog = await getGrokLimitsFromCliLog(account.configDir);
      if (fromLog) {
        if (!fresh.weekly && fromLog.weekly) fresh = mergeGrokLimits(fresh, fromLog);
        else if (!fresh.planLabel && (fromLog.planLabel || fromLog.subscriptionTier)) {
          fresh = mergeGrokLimits(fresh, fromLog);
        } else if (!fresh.planLabel && fromLog.subscriptionTier) {
          fresh.planLabel = fromLog.subscriptionTier;
          fresh.subscriptionTier = fromLog.subscriptionTier;
        }
      }
    }
    liveGrokLimits.set(account.id, { value: fresh, at: now });
    await writeGrokLimitsSnapshot(account.id, fresh);
    return fresh;
  } catch {
    // Prefer best available: complete in-memory → disk snapshot → CLI log.
    const snapshot = await readGrokLimitsSnapshot(account.id);
    const fromLog = await getGrokLimitsFromCliLog(account.configDir);
    const fallback = mergeGrokLimits(
      grokLimitsComplete(cached?.value) ? cached.value : null,
      mergeGrokLimits(snapshot, fromLog),
    ) || cached?.value || snapshot || fromLog || null;
    if (fallback) {
      liveGrokLimits.set(account.id, { value: { ...fallback, live: false }, at: now });
      return { ...fallback, live: false, ageMinutes: Math.round((now - (fallback.fetchedAtMs || now)) / 60000) };
    }
    return null;
  }
}

// Grok reports cost as integer "usd ticks". Headless docs:
//   total_cost_usd_ticks: 126890500  ↔  total_cost_usd: 0.01268905
// so 1 USD = 10_000_000_000 ticks.
function grokTicksToUsd(ticks) {
  if (ticks == null || ticks === 0) return 0;
  if (typeof ticks !== 'number' || !Number.isFinite(ticks)) return 0;
  return ticks / 10_000_000_000;
}

// Prefer explicit costUsd, then costUsdTicks; free-tier models often omit both.
function grokUsageCostUsd(v) {
  if (!v || typeof v !== 'object') return 0;
  if (typeof v.costUsd === 'number') return v.costUsd;
  if (typeof v.costUSD === 'number') return v.costUSD;
  if (typeof v.costUsdTicks === 'number') return grokTicksToUsd(v.costUsdTicks);
  return 0;
}

// --- Pricing -----------------------------------------------------------------
// Published per-model rates from platform.claude.com/docs/about-claude/pricing
// (checked 2026-07-17), $ per million tokens. Cache creation is billed at the
// 5-minute-write rate unless a 1-hour cache is explicitly requested; ccusage's
// token logs don't distinguish the two, so cacheWrite below assumes 5m — the
// same assumption Claude Code itself defaults to.
const CLAUDE_PRICING = {
  'claude-fable-5': { input: 10, output: 50, cacheWrite: 12.5, cacheRead: 1 },
  'claude-fable-5-1': { input: 10, output: 50, cacheWrite: 12.5, cacheRead: 1 },
  'claude-mythos-5': { input: 10, output: 50, cacheWrite: 12.5, cacheRead: 1 },
  'claude-opus-5': { input: 5, output: 25, cacheWrite: 6.25, cacheRead: 0.5 },
  'claude-opus-4-8': { input: 5, output: 25, cacheWrite: 6.25, cacheRead: 0.5 },
  'claude-opus-4-7': { input: 5, output: 25, cacheWrite: 6.25, cacheRead: 0.5 },
  'claude-opus-4-6': { input: 5, output: 25, cacheWrite: 6.25, cacheRead: 0.5 },
  'claude-opus-4-5': { input: 5, output: 25, cacheWrite: 6.25, cacheRead: 0.5 },
  'claude-opus-4-1': { input: 15, output: 75, cacheWrite: 18.75, cacheRead: 1.5 },
  'claude-opus-4': { input: 15, output: 75, cacheWrite: 18.75, cacheRead: 1.5 },
  'claude-sonnet-4-6': { input: 3, output: 15, cacheWrite: 3.75, cacheRead: 0.3 },
  'claude-sonnet-4-5': { input: 3, output: 15, cacheWrite: 3.75, cacheRead: 0.3 },
  'claude-sonnet-4': { input: 3, output: 15, cacheWrite: 3.75, cacheRead: 0.3 },
  'claude-haiku-4-5': { input: 1, output: 5, cacheWrite: 1.25, cacheRead: 0.1 },
  'claude-haiku-3-5': { input: 0.8, output: 4, cacheWrite: 1, cacheRead: 0.08 },
  // Sonnet 5 has time-boxed introductory pricing (through 2026-08-31), resolved in claudeRatesFor().
};

const SONNET_5_INTRO_ENDS_UTC = '2026-09-01T00:00:00Z';
const SONNET_5_INTRO = { input: 2, output: 10, cacheWrite: 2.5, cacheRead: 0.2 };
const SONNET_5_STANDARD = { input: 3, output: 15, cacheWrite: 3.75, cacheRead: 0.3 };

// Model names in ccusage's JSON sometimes carry a dated suffix
// (claude-haiku-4-5-20251001) — strip it to match the rate table above.
function normalizeClaudeModel(modelName) {
  return modelName.replace(/-\d{8}$/, '');
}

function claudeRatesFor(modelName, asOfDate) {
  const base = normalizeClaudeModel(modelName);
  if (base === 'claude-sonnet-5') {
    return new Date(asOfDate) < new Date(SONNET_5_INTRO_ENDS_UTC) ? SONNET_5_INTRO : SONNET_5_STANDARD;
  }
  return CLAUDE_PRICING[base] || null;
}

function claudeModelCost(modelName, tokens, asOfDate) {
  const rates = claudeRatesFor(modelName, asOfDate);
  const { inputTokens = 0, outputTokens = 0, cacheCreationTokens = 0, cacheReadTokens = 0 } = tokens;
  if (!rates) return null;
  return {
    input: (inputTokens * rates.input) / 1_000_000,
    output: (outputTokens * rates.output) / 1_000_000,
    cacheWrite: (cacheCreationTokens * rates.cacheWrite) / 1_000_000,
    cacheRead: (cacheReadTokens * rates.cacheRead) / 1_000_000,
  };
}

function run(cmd, env) {
  return new Promise((resolve, reject) => {
    exec(cmd, {
      maxBuffer: 1024 * 1024 * 32,
      timeout: 30000,
      resourceLimits: { maxOldGenerationSizeMb: 512, maxYoungGenerationSizeMb: 16 },
      env: { ...process.env, ...env },
    }, (err, stdout) => {
      if (err) return reject(err);
      try {
        resolve(JSON.parse(stdout));
      } catch (e) {
        reject(e);
      }
    });
  });
}

// Stream a JSONL file line-by-line so a giant session log costs only one line
// of memory instead of a whole-file read + split (a 1.4GB Grok sessions dir
// used to push the process past 3GB of RSS every poll).
async function forEachLine(filePath, onLine) {
  await new Promise((resolve) => {
    let stream;
    try {
      stream = createReadStream(filePath, { encoding: 'utf8' });
    } catch {
      return resolve();
    }
    const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });
    rl.on('line', onLine);
    rl.on('error', () => resolve());
    rl.on('close', () => resolve());
  });
}

function runCcusage(args, env) {
  return runCcusageCommand(args, env, { command: CCUSAGE_BIN });
}

function sumCost(rows, costKey = 'totalCost') {
  return rows.reduce((s, r) => s + (r[costKey] ?? r.costUSD ?? 0), 0);
}

function sumTokens(rows) {
  return rows.reduce((s, r) => {
    const t = r.totalTokens ?? (r.inputTokens + r.outputTokens + r.cacheCreationTokens + r.cacheReadTokens);
    return s + t;
  }, 0);
}

function summarize(daily, costKey = 'totalCost') {
  const sorted = daily.slice().sort((a, b) => (a.period ?? a.date).localeCompare(b.period ?? b.date));
  const now = new Date();
  // Match on the actual calendar day rather than "the newest row we have" —
  // otherwise an account with no usage today reports its last active day as
  // today. Providers bucket by local date or by UTC date depending on where
  // the row came from, so accept either spelling of "today".
  const localToday = new Date(now.getTime() - now.getTimezoneOffset() * 60000).toISOString().slice(0, 10);
  const utcToday = now.toISOString().slice(0, 10);
  const today = sorted.find((d) => {
    const key = d.period ?? d.date;
    return key === localToday || key === utcToday;
  });
  // A rolling 7-day window, not "the last 7 rows we have" — an account that
  // was idle for a fortnight should not report month-old spend as this week's.
  const weekStart = new Date(Date.parse(localToday) - 6 * 86400000).toISOString().slice(0, 10);
  const last7 = sorted.filter((d) => (d.period ?? d.date) >= weekStart);
  const thisMonthPrefix = localToday.slice(0, 7);
  const thisMonth = sorted.filter((d) => (d.period ?? d.date).startsWith(thisMonthPrefix));

  return {
    today: { cost: today ? (today[costKey] ?? today.costUSD ?? 0) : 0, tokens: today ? sumTokens([today]) : 0 },
    last7d: { cost: sumCost(last7, costKey), tokens: sumTokens(last7) },
    month: { cost: sumCost(thisMonth, costKey), tokens: sumTokens(thisMonth) },
    allTime: { cost: sumCost(sorted, costKey), tokens: sumTokens(sorted) },
    // Keep the compact summaries used by the web UI, but also expose the
    // daily series so small native clients (such as the Omarchy panel) do not
    // need to rescan every provider's private storage independently.
    daily: sorted.map((row) => ({
      date: row.period ?? row.date,
      cost: row[costKey] ?? row.costUSD ?? 0,
      tokens: sumTokens([row]),
      unpriced: row.unpriced === true,
    })),
  };
}

// A "claude"-agent transcript can still contain gpt-* entries (e.g. a
// plugin that shells out to Codex logs into the same session file), so
// tag every row by actual provider rather than trusting which ccusage
// subcommand it came from.
function providerOf(modelName) {
  if (/^claude-/.test(modelName)) return 'Anthropic';
  if (/^gpt-/.test(modelName)) return 'OpenAI';
  if (/^grok-/.test(modelName)) return 'xAI';
  if (/^gemini-/.test(modelName)) return 'Google';
  return 'Google';
}

function blankBreakdown(modelName, provider) {
  return {
    modelName,
    provider,
    unpriced: false,
    tokens: { input: 0, output: 0, cacheWrite: 0, cacheRead: 0 },
    cost: { input: 0, output: 0, cacheWrite: 0, cacheRead: 0, total: 0 },
  };
}

// Granular breakdown: real tokens x real published per-category rate for
// every model, not just a lump total. Computed entirely from our own rate
// tables rather than ccusage's own cost field, so every model missing a
// rate is flagged instead of silently reading $0.
function claudeModelTable(daily) {
  const byModel = new Map();
  for (const d of daily) {
    const periodDate = d.period ?? d.date;
    for (const mb of d.modelBreakdowns || []) {
      if (providerOf(mb.modelName) !== 'Anthropic') continue; // Claude Code tab shows Anthropic models only
      const cur = byModel.get(mb.modelName) || blankBreakdown(mb.modelName, providerOf(mb.modelName));
      const t = cur.tokens;
      t.input += mb.inputTokens || 0;
      t.output += mb.outputTokens || 0;
      t.cacheWrite += mb.cacheCreationTokens || 0;
      t.cacheRead += mb.cacheReadTokens || 0;

      const cost = claudeModelCost(mb.modelName, mb, periodDate);
      if (!cost) {
        cur.unpriced = true;
      } else {
        cur.cost.input += cost.input;
        cur.cost.output += cost.output;
        cur.cost.cacheWrite += cost.cacheWrite;
        cur.cost.cacheRead += cost.cacheRead;
        cur.cost.total += cost.input + cost.output + cost.cacheWrite + cost.cacheRead;
      }
      byModel.set(mb.modelName, cur);
    }
  }
  return [...byModel.values()].sort((a, b) => b.cost.total - a.cost.total);
}

// Rebuild day-level Claude totals from the same per-model math above,
// instead of trusting ccusage's own totalCost (which is $0 for any model
// missing from its pricing DB — the gap that originally zeroed Sonnet 5).
function claudeDailyRecomputed(daily) {
  return (daily || []).map((d) => {
    const periodDate = d.period ?? d.date;
    let cost = 0;
    let unpriced = false;
    let tokens = 0;
    for (const mb of d.modelBreakdowns || []) {
      if (providerOf(mb.modelName) !== 'Anthropic') continue;
      const c = claudeModelCost(mb.modelName, mb, periodDate);
      if (!c) unpriced = true;
      else cost += c.input + c.output + c.cacheWrite + c.cacheRead;
      tokens += (mb.inputTokens || 0) + (mb.outputTokens || 0) + (mb.cacheCreationTokens || 0) + (mb.cacheReadTokens || 0);
    }
    return { period: periodDate, totalCost: cost, totalTokens: tokens, unpriced };
  });
}

// Codex's daily/session JSON gives real per-model token counts but no
// per-model cost, and litellm/ccusage has no entries for these model names
// at all. Real tokens x real published OpenAI rate card
// (developers.openai.com/api/docs/pricing, checked 2026-07-31) = real cost.
// 2026-07-30: OpenAI cut Luna 80% and Terra 20% (Sol unchanged).
const CODEX_PRICING = {
  // input / cachedInput / output, $ per million tokens (standard, short context)
  'gpt-6-astra': { input: 10, cachedInput: 1, output: 50 },
  'gpt-5.6-sol': { input: 5, cachedInput: 0.5, output: 30 },
  'gpt-5.6-terra': { input: 2, cachedInput: 0.2, output: 12 },
  'gpt-5.6-luna': { input: 0.2, cachedInput: 0.02, output: 1.2 },
  'gpt-5.5': { input: 5, cachedInput: 0.5, output: 30 },
  'gpt-5.5-pro': { input: 30, cachedInput: 30, output: 180 },
  'gpt-5.4': { input: 2.5, cachedInput: 0.25, output: 15 },
  'gpt-5.4-mini': { input: 0.75, cachedInput: 0.075, output: 4.5 },
  'gpt-5.4-nano': { input: 0.2, cachedInput: 0.02, output: 1.25 },
  'gpt-5.4-pro': { input: 30, cachedInput: 30, output: 180 },
};

const CODEX_CUTOVER_MS = Date.parse('2026-07-30T00:00:00Z');
const CODEX_PRICING_PRE_CUT = {
  'gpt-5.6-luna': { input: 1.0, cachedInput: 0.1, output: 6 },
  'gpt-5.6-terra': { input: 2.5, cachedInput: 0.25, output: 15 },
};

function codexTurnCost(modelName, u, timestamp) {
  const key = String(modelName || '').replace(/-\d{4}-\d{2}-\d{2}$/, '');
  const ms = timestamp ? Date.parse(timestamp) : NaN;
  const usePreCut = Number.isFinite(ms) && ms < CODEX_CUTOVER_MS && CODEX_PRICING_PRE_CUT[key];
  const rates = usePreCut ? CODEX_PRICING_PRE_CUT[key] : CODEX_PRICING[key];
  if (!rates) return null;
  const cached = Number(u.cached_input_tokens ?? u.cacheReadTokens) || 0;
  const rawInput = Number(u.input_tokens ?? u.inputTokens) || 0;
  const fresh = Math.max(0, rawInput - cached);
  const out = Number(u.output_tokens ?? u.outputTokens) || 0;
  return {
    input: (fresh * rates.input) / 1e6,
    output: (out * rates.output) / 1e6,
    cacheWrite: 0,
    cacheRead: (cached * rates.cachedInput) / 1e6,
    total: (fresh * rates.input + cached * rates.cachedInput + out * rates.output) / 1e6,
  };
}

function codexModelCost(modelName, v, timestamp) {
  return codexTurnCost(modelName, v, timestamp);
}

function modelTableFromCodexSessions(sessions) {
  const byModel = new Map();
  for (const s of sessions) {
    for (const [modelName, v] of Object.entries(s.models)) {
      const cur = byModel.get(modelName) || blankBreakdown(modelName, providerOf(modelName));
      const t = cur.tokens;
      t.input += v.inputTokens || 0;
      t.output += v.outputTokens || 0;
      t.cacheRead += v.cacheReadTokens || 0;

      const cost = codexModelCost(modelName, v);
      if (!cost) {
        cur.unpriced = true;
      } else {
        cur.cost.input += cost.input;
        cur.cost.output += cost.output;
        cur.cost.cacheRead += cost.cacheRead;
        cur.cost.total += cost.input + cost.output + cost.cacheRead;
      }
      byModel.set(modelName, cur);
    }
  }
  return [...byModel.values()].sort((a, b) => b.cost.total - a.cost.total);
}

// Rebuild day-level rows straight from session data + the real rate card
// above, instead of trusting ccusage's own costUSD (which is wrong for any
// model missing from its pricing DB — the same gap that zeroed Sonnet 5).
function codexDailyFromSessions(sessions) {
  const byDate = new Map();
  for (const s of sessions) {
    const date = (s.lastActivity || '').slice(0, 10);
    if (!date) continue;
    const row = byDate.get(date) || { date, costUSD: 0, totalTokens: 0, unpriced: false };
    for (const [modelName, v] of Object.entries(s.models)) {
      const cost = codexModelCost(modelName, v);
      if (!cost) row.unpriced = true;
      else row.costUSD += cost.input + cost.output + cost.cacheWrite + cost.cacheRead;
      row.totalTokens += v.totalTokens || 0;
    }
    byDate.set(date, row);
  }
  return [...byDate.values()];
}

// ------------------------------------------------------------------ scanning
//
// Both session scanners keep raw token counts per (date, model) and price them
// at read time. Caching the *dollars* instead - which is what this used to do -
// meant an edit to a rate table below never reached a file whose mtime had not
// changed, and an archived session's mtime never changes again.

const claudeSessionCache = new FileRollupCache({
  id: 'claude',
  parser: {
    initState: () => ({ seen: [] }),
    // A cheap reject before JSON.parse: most lines in a transcript are not
    // assistant turns, and parsing them all is the bulk of a cold scan.
    wants: (line) => line.includes('"type":"assistant"') || line.includes('"role":"assistant"'),
    line: (d, state, add) => {
      if (d.type !== 'assistant' && d.message?.role !== 'assistant') return;
      const msg = d.message || d;
      const u = msg.usage || d.usage;
      if (!u) return;

      // Claude Code occasionally writes the same assistant message twice in a
      // row. The ring only has to look back a few lines to catch that, and it
      // is bounded so an index entry cannot grow with the transcript.
      const msgId = msg.id || d.requestId || d.uuid;
      if (msgId) {
        if (state.seen.includes(msgId)) return;
        state.seen.push(msgId);
      }

      const rawModel = msg.model || d.model || 'claude-sonnet-5';
      if (rawModel === '<synthetic>') return;
      const model = normalizeClaudeModel(rawModel);

      const rawTs = d.timestamp || msg.timestamp;
      const ts = typeof rawTs === 'number'
        ? new Date(rawTs > 1e12 ? rawTs : rawTs * 1000).toISOString()
        : String(rawTs || '');
      const date = ts.slice(0, 10);
      if (!date) return;

      const input = Number(u.input_tokens ?? u.inputTokens) || 0;
      const output = Number(u.output_tokens ?? u.outputTokens) || 0;
      const cacheWrite = Number(u.cache_creation_input_tokens ?? u.cacheCreationTokens) || 0;
      const cacheRead = Number(u.cache_read_input_tokens ?? u.cacheReadTokens) || 0;
      add(date, model, { input, output, cacheWrite, cacheRead, total: input + output + cacheWrite + cacheRead });
    },
  },
});

async function scanClaudeSessionFiles(projectsDir) {
  const files = [];
  async function walk(dir) {
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) await walk(full);
      else if (e.isFile() && e.name.endsWith('.jsonl')) files.push(full);
    }
  }
  await walk(projectsDir);
  return files;
}

/**
 * Turn `date|model -> tokens` into the daily rows and per-model breakdown the
 * API already speaks. Pricing happens here, once per (date, model) pair, so a
 * rate table edit is reflected on the next read with no rescan at all.
 */
function priceFolded(folded, priceFor) {
  const byDate = new Map();
  const byModel = new Map();
  for (const [key, t] of folded) {
    const cut = key.indexOf('|');
    const date = key.slice(0, cut);
    const model = key.slice(cut + 1);
    const cost = priceFor(model, t, date);

    const day = byDate.get(date) || { date, costUSD: 0, totalTokens: 0, unpriced: false };
    day.totalTokens += t.total || 0;
    if (cost) day.costUSD += cost.total;
    else day.unpriced = true;
    byDate.set(date, day);

    const cur = byModel.get(model) || blankBreakdown(model, providerOf(model));
    cur.tokens.input += t.input || 0;
    cur.tokens.output += t.output || 0;
    cur.tokens.cacheWrite += t.cacheWrite || 0;
    cur.tokens.cacheRead += t.cacheRead || 0;
    if (t.reasoning) cur.tokens.reasoning = (cur.tokens.reasoning || 0) + t.reasoning;
    if (cost) {
      cur.cost.input += cost.input;
      cur.cost.output += cost.output;
      cur.cost.cacheWrite += cost.cacheWrite;
      cur.cost.cacheRead += cost.cacheRead;
      cur.cost.total += cost.total;
    } else {
      cur.unpriced = true;
    }
    byModel.set(model, cur);
  }
  return {
    daily: [...byDate.values()].sort((a, b) => a.date.localeCompare(b.date)),
    models: [...byModel.values()].sort((a, b) => b.cost.total - a.cost.total),
  };
}

function claudeBucketCost(model, t, date) {
  const c = claudeModelCost(model, {
    inputTokens: t.input, outputTokens: t.output,
    cacheCreationTokens: t.cacheWrite, cacheReadTokens: t.cacheRead,
  }, date);
  return c && { ...c, total: c.input + c.output + c.cacheWrite + c.cacheRead };
}

async function scanClaudeSessions(configDir, opts = {}) {
  const root = path.join(configDir, 'projects');
  const files = await scanClaudeSessionFiles(root);
  const stats = await claudeSessionCache.scan(files, { ...opts, root });
  return { ...priceFolded(claudeSessionCache.fold(files), claudeBucketCost), stats };
}

async function getClaudeAccountUsage(account, force, { rescanFiles = false, rebuild = false } = {}) {
  const [scanned, rateLimits] = await Promise.all([
    scanClaudeSessions(account.configDir, { force: rescanFiles, rebuild }),
    getClaudeRateLimits(account, force),
  ]);
  const section = summarize(scanned.daily, 'costUSD');
  section.rateLimits = rateLimits;
  section.models = scanned.models;
  section.usageSources = ['Claude Code'];
  section.scan = scanned.stats;
  return section;
}

function getPiSessionsDir() {
  return path.join(getHomeDir(), '.pi', 'agent', 'sessions');
}
function getPrimeSessionsDir() {
  return path.join(getHomeDir(), '.prime', 'agent', 'sessions');
}

async function jsonlFilesUnder(rootDir) {
  const files = [];
  async function visit(dir) {
    let entries;
    try { entries = await readdir(dir, { withFileTypes: true }); } catch { return; }
    for (const entry of entries) {
      const entryPath = path.join(dir, entry.name);
      if (entry.isDirectory()) await visit(entryPath);
      else if (entry.isFile() && entry.name.endsWith('.jsonl')) files.push(entryPath);
    }
  }
  await visit(rootDir);
  return files;
}

async function scanCodexHarnessSessions() {
  const byDate = new Map();
  const byModel = new Map();
  const sourceCounts = {};

  for (const [source, sessionsDir] of [
    ['Pi', getPiSessionsDir()],
    ['Prime Agent', getPrimeSessionsDir()],
  ]) {
    const files = await jsonlFilesUnder(sessionsDir);
    for (const filePath of files) {
      await forEachLine(filePath, (line) => {
        if (!line.includes('openai-codex') || !line.includes('"assistant"')) return;
        let o;
        try { o = JSON.parse(line); } catch { return; }
        if (o.type !== 'message' || o.message?.role !== 'assistant') return;
        if (o.message?.provider !== 'openai-codex') return;
        const u = o.message.usage;
        if (!u) return;

        const rawTimestamp = o.timestamp || o.message.timestamp;
        const timestamp = typeof rawTimestamp === 'number'
          ? new Date(rawTimestamp > 1e12 ? rawTimestamp : rawTimestamp * 1000).toISOString()
          : rawTimestamp;
        const date = String(timestamp || '').slice(0, 10);
        if (!date) return;

        const modelName = o.message.model || 'gpt-5.6-luna';
        const inputTok = Number(u.input) || 0;
        const outputTok = Number(u.output) || 0;
        const cacheReadTok = Number(u.cacheRead) || 0;
        const cacheWriteTok = Number(u.cacheWrite) || 0;
        const computedCost = codexModelCost(modelName, {
          inputTokens: inputTok,
          outputTokens: outputTok,
          cacheReadTokens: cacheReadTok,
        });
        // Use the dashboard's Codex rate card when the model is known so
        // direct Codex CLI and harness totals use identical pricing. Older
        // harness records may provide a cost object for models we do not know.
        const reportedCost = typeof u.cost === 'number'
          ? { total: u.cost }
          : u.cost && typeof u.cost === 'object' ? u.cost : null;
        const costObj = computedCost || reportedCost || { total: 0 };
        const totalCost = Number(costObj.total)
          || (Number(costObj.input) || 0)
          + (Number(costObj.output) || 0)
          + (Number(costObj.cacheWrite) || 0)
          + (Number(costObj.cacheRead) || 0);
        const totTok = Number(u.totalTokens) || (inputTok + outputTok + cacheReadTok + cacheWriteTok);

        const day = byDate.get(date) || { date, costUSD: 0, totalTokens: 0, unpriced: false };
        day.costUSD += totalCost;
        day.totalTokens += totTok;
        day.unpriced = day.unpriced || (!computedCost && !reportedCost);
        byDate.set(date, day);

        const cur = byModel.get(modelName) || blankBreakdown(modelName, 'OpenAI');
        cur.tokens.input += inputTok;
        cur.tokens.output += outputTok;
        cur.tokens.cacheRead += cacheReadTok;
        cur.tokens.cacheWrite += cacheWriteTok;
        cur.cost.input += Number(costObj.input) || 0;
        cur.cost.output += Number(costObj.output) || 0;
        cur.cost.cacheWrite += Number(costObj.cacheWrite) || 0;
        cur.cost.cacheRead += Number(costObj.cacheRead) || 0;
        cur.cost.total += totalCost;
        cur.unpriced = cur.unpriced || (!computedCost && !reportedCost);
        byModel.set(modelName, cur);
        sourceCounts[source] = (sourceCounts[source] || 0) + 1;
      });
    }
  }
  return {
    daily: [...byDate.values()],
    models: [...byModel.values()],
    sourceCounts,
  };
}

function mergeCodexDaily(nativeDaily, piDaily) {
  const byDate = new Map();
  for (const d of nativeDaily) {
    byDate.set(d.date, { ...d });
  }
  for (const d of piDaily) {
    const cur = byDate.get(d.date) || { date: d.date, costUSD: 0, totalTokens: 0, unpriced: false };
    cur.costUSD += d.costUSD;
    cur.totalTokens += d.totalTokens;
    cur.unpriced = cur.unpriced || d.unpriced;
    byDate.set(d.date, cur);
  }
  return [...byDate.values()].sort((a, b) => a.date.localeCompare(b.date));
}

function mergeCodexModels(nativeModels, piModels) {
  const byModel = new Map();
  for (const m of nativeModels) {
    byModel.set(m.modelName, JSON.parse(JSON.stringify(m)));
  }
  for (const m of piModels) {
    if (byModel.has(m.modelName)) {
      const cur = byModel.get(m.modelName);
      cur.tokens.input += m.tokens.input;
      cur.tokens.output += m.tokens.output;
      cur.tokens.cacheRead += m.tokens.cacheRead;
      cur.tokens.cacheWrite += m.tokens.cacheWrite;
      cur.cost.input += m.cost.input;
      cur.cost.output += m.cost.output;
      cur.cost.cacheRead += m.cost.cacheRead;
      cur.cost.cacheWrite += m.cost.cacheWrite;
      cur.cost.total += m.cost.total;
    } else {
      byModel.set(m.modelName, JSON.parse(JSON.stringify(m)));
    }
  }
  return [...byModel.values()].sort((a, b) => b.cost.total - a.cost.total);
}

function formatCodexLocalRateLimits(limits, timestampMs) {
  if (!limits) return null;
  const toEntry = (w) => (w && typeof w.used_percent === 'number'
    ? {
        percent: w.used_percent,
        resetsAt: w.resets_at ? new Date((w.resets_at > 1e12 ? w.resets_at : w.resets_at * 1000)).toISOString() : null,
      }
    : null);
  const windows = [limits.primary, limits.secondary].filter(Boolean);
  let weekly = null;
  let session = null;
  for (const w of windows) {
    const mins = Number(w.window_minutes) || (Number(w.limit_window_seconds) ? Math.round(w.limit_window_seconds / 60) : 0);
    const entry = toEntry(w);
    if (mins >= 10080 - 60) weekly = entry;
    else if (mins >= 300 - 30) session = entry;
    else {
      if (!weekly) weekly = entry;
      else if (!session) session = entry;
    }
  }
  const credits = limits.credits?.has_credits
    ? {
        balance: Number(limits.credits.balance),
        approxLocalMessages: limits.credits.approx_local_messages || null,
        approxCloudMessages: limits.credits.approx_cloud_messages || null,
      }
    : null;
  const ageMinutes = timestampMs ? Math.max(0, Math.round((Date.now() - timestampMs) / 60000)) : 0;
  return {
    fetchedAtMs: timestampMs || Date.now(),
    ageMinutes,
    live: ageMinutes <= 5,
    weekly,
    session,
    credits,
    planLabel: limits.plan_type ? limits.plan_type.charAt(0).toUpperCase() + limits.plan_type.slice(1) : null,
  };
}

const codexRolloutCache = new FileRollupCache({
  id: 'codex',
  parser: {
    // `model` has to survive an incremental read: a rollout names it once in a
    // turn_context near the top and every token_count after it is that model,
    // so a tail parsed without it would bill the whole session to the default.
    initState: () => ({ model: null, limit: null }),
    wants: (line) => line.includes('"token_count"') || line.includes('"turn_context"'),
    line: (d, state, add) => {
      const p = d.payload || {};
      if (d.type === 'turn_context' || p.type === 'turn_context') {
        if (p.model) state.model = p.model;
        return;
      }
      if (p.type !== 'token_count') return;

      const ts = d.timestamp;
      const date = String(ts || '').slice(0, 10);
      if (!date) return;

      if (p.rate_limits) {
        const ms = ts ? Date.parse(ts) : 0;
        if (!state.limit || ms > state.limit.timestampMs) state.limit = { timestampMs: ms, limits: p.rate_limits };
      }

      const u = (p.info || {}).last_token_usage || {};
      const cacheRead = Number(u.cached_input_tokens) || 0;
      const input = Math.max(0, (Number(u.input_tokens) || 0) - cacheRead);
      const output = Number(u.output_tokens) || 0;
      const reasoning = Number(u.reasoning_output_tokens) || 0;
      const total = Number(u.total_tokens) || (input + cacheRead + output);
      add(date, state.model || 'gpt-5.6-luna', { input, output, cacheRead, reasoning, total });
    },
  },
});

async function scanCodexSessionFiles(sessionsDir) {
  const files = [];
  async function walk(dir) {
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) await walk(full);
      else if (e.isFile() && e.name.endsWith('.jsonl')) files.push(full);
    }
  }
  await walk(sessionsDir);
  return files;
}

// The bucket already holds fresh input separately from cached, so this prices
// it directly rather than going through codexTurnCost's raw-minus-cached step.
function codexBucketCost(model, t, date) {
  const key = String(model || '').replace(/-\d{4}-\d{2}-\d{2}$/, '');
  const ms = date ? Date.parse(date) : NaN;
  const rates = (Number.isFinite(ms) && ms < CODEX_CUTOVER_MS && CODEX_PRICING_PRE_CUT[key])
    ? CODEX_PRICING_PRE_CUT[key]
    : CODEX_PRICING[key];
  if (!rates) return null;
  const input = (t.input * rates.input) / 1e6;
  const cacheRead = (t.cacheRead * rates.cachedInput) / 1e6;
  const output = (t.output * rates.output) / 1e6;
  return { input, output, cacheWrite: 0, cacheRead, total: input + output + cacheRead };
}

async function scanCodexSessions(configDir, opts = {}) {
  const root = path.join(configDir, 'sessions');
  const files = await scanCodexSessionFiles(root);
  const stats = await codexRolloutCache.scan(files, { ...opts, root });
  const priced = priceFolded(codexRolloutCache.fold(files), codexBucketCost);

  let latestLimit = null;
  let latestLimitTime = 0;
  for (const state of codexRolloutCache.states(files)) {
    if (state?.limit && state.limit.timestampMs > latestLimitTime) {
      latestLimitTime = state.limit.timestampMs;
      latestLimit = state.limit.limits;
    }
  }

  return {
    ...priced,
    stats,
    rateLimits: formatCodexLocalRateLimits(latestLimit, latestLimitTime),
  };
}

async function getCodexAccountUsage(account, force, { rescanFiles = false, rebuild = false } = {}) {
  const [scanned, liveLimits] = await Promise.all([
    scanCodexSessions(account.configDir, { force: rescanFiles, rebuild }),
    getCodexRateLimits(account, force).catch(() => null),
  ]);

  let rateLimits = scanned.rateLimits;
  if (liveLimits) {
    rateLimits = {
      ...scanned.rateLimits,
      ...liveLimits,
      credits: liveLimits.credits || scanned.rateLimits?.credits,
      planLabel: liveLimits.planLabel || scanned.rateLimits?.planLabel,
    };
  }

  const section = summarize(scanned.daily, 'costUSD');
  section.rateLimits = rateLimits;
  section.models = scanned.models;
  section.usageSources = ['Codex CLI'];
  section.planLabel = rateLimits?.planLabel || null;
  section.scan = scanned.stats;
  return section;
}

// Grok CLI persists per-turn usage on session updates.jsonl under
// turn_completed.usage / modelUsage — no ccusage equivalent. Free-tier
// models (e.g. grok-4.5-build-free) legitimately report $0; paid turns
// carry costUsdTicks (10^10 ticks = $1, per headless-mode docs).
async function scanGrokSessionUsage(configDir) {
  const byDate = new Map(); // date -> { date, costUSD, totalTokens, unpriced, models: Map }
  const sessionsRoot = path.join(configDir, 'sessions');
  let cwdDirs = [];
  try {
    cwdDirs = await readdir(sessionsRoot, { withFileTypes: true });
  } catch {
    return { daily: [], models: [] };
  }

  for (const cwdEnt of cwdDirs) {
    if (!cwdEnt.isDirectory()) continue;
    const cwdPath = path.join(sessionsRoot, cwdEnt.name);
    let sessionDirs = [];
    try {
      sessionDirs = await readdir(cwdPath, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const sEnt of sessionDirs) {
      if (!sEnt.isDirectory()) continue;
      const updatesPath = path.join(cwdPath, sEnt.name, 'updates.jsonl');
      await forEachLine(updatesPath, (line) => {
        if (!line.includes('turn_completed') || !line.includes('usage')) return;
        let o;
        try { o = JSON.parse(line); } catch { return; }
        const update = o?.params?.update;
        if (!update || update.sessionUpdate !== 'turn_completed' || !update.usage) return;
        const usage = update.usage;
        let ts = o.timestamp;
        if (typeof ts === 'number' && ts > 1e12) ts = Math.floor(ts / 1000);
        if (typeof ts !== 'number') return;
        const date = new Date(ts * 1000).toISOString().slice(0, 10);
        const row = byDate.get(date) || {
          date,
          costUSD: 0,
          totalTokens: 0,
          unpriced: false,
          models: new Map(),
        };

        const applyModel = (modelName, v) => {
          const m = row.models.get(modelName) || {
            inputTokens: 0,
            outputTokens: 0,
            cacheReadTokens: 0,
            reasoningTokens: 0,
            totalTokens: 0,
            costUSD: 0,
          };
          m.inputTokens += v.inputTokens || 0;
          m.outputTokens += v.outputTokens || 0;
          m.cacheReadTokens += v.cachedReadTokens || 0;
          m.reasoningTokens += v.reasoningTokens || 0;
          m.totalTokens += v.totalTokens
            || ((v.inputTokens || 0) + (v.outputTokens || 0) + (v.cachedReadTokens || 0));
          m.costUSD += grokUsageCostUsd(v);
          row.models.set(modelName, m);
        };

        const modelUsage = usage.modelUsage || {};
        const modelNames = Object.keys(modelUsage);
        if (modelNames.length) {
          for (const [modelName, v] of Object.entries(modelUsage)) applyModel(modelName, v);
          // Prefer sum of per-model costs; fall back to top-level ticks if models
          // only carried tokens (shouldn't happen, but keeps totals honest).
          const modelCostSum = modelNames.reduce((s, name) => s + grokUsageCostUsd(modelUsage[name]), 0);
          row.costUSD += modelCostSum || grokUsageCostUsd(usage);
        } else {
          applyModel('unknown', usage);
          row.costUSD += grokUsageCostUsd(usage);
        }

        row.totalTokens += usage.totalTokens
          || ((usage.inputTokens || 0) + (usage.outputTokens || 0) + (usage.cachedReadTokens || 0));
        byDate.set(date, row);
      });
    }
  }

  const daily = [...byDate.values()]
    .map((r) => ({ date: r.date, costUSD: r.costUSD, totalTokens: r.totalTokens, unpriced: r.unpriced, models: r.models }))
    .sort((a, b) => a.date.localeCompare(b.date));

  const byModel = new Map();
  for (const d of daily) {
    for (const [modelName, v] of d.models.entries()) {
      const cur = byModel.get(modelName) || blankBreakdown(modelName, providerOf(modelName));
      cur.tokens.input += v.inputTokens || 0;
      cur.tokens.output += v.outputTokens || 0;
      cur.tokens.cacheRead += v.cacheReadTokens || 0;
      // stash reasoning in cacheWrite column so the existing 4-col table shows it
      cur.tokens.cacheWrite += v.reasoningTokens || 0;
      // Grok only reports a total cost (via ticks), not per-channel splits.
      cur.cost.input += 0;
      cur.cost.output += 0;
      cur.cost.cacheRead += 0;
      cur.cost.cacheWrite += 0;
      cur.cost.total += v.costUSD || 0;
      // Free tier ($0 with no ticks) is priced, not missing a rate card.
      // Only flag unknown if somehow cost is missing AND model isn't free.
      if (v.costUSD == null) cur.unpriced = true;
      byModel.set(modelName, cur);
    }
  }

  return {
    daily: daily.map(({ date, costUSD, totalTokens, unpriced }) => ({ date, costUSD, totalTokens, unpriced })),
    models: [...byModel.values()].sort((a, b) => (b.tokens.input + b.tokens.output) - (a.tokens.input + a.tokens.output)),
  };
}

async function getGrokAccountUsage(account, force) {
  const [scanned, rateLimits] = await Promise.all([
    scanGrokSessionUsage(account.configDir),
    getGrokRateLimits(account, force),
  ]);
  const section = summarize(scanned.daily, 'costUSD');
  section.rateLimits = rateLimits;
  section.models = scanned.models;
  section.planLabel = rateLimits?.planLabel || rateLimits?.subscriptionTier || null;
  section.limitLabels = rateLimits?.unifiedBilling
    ? { session: 'Weekly', weekly: 'Weekly' }
    : { session: 'Monthly', weekly: 'Weekly' };
  return section;
}

const ANTIGRAVITY_PRICING = {
  'gemini-3.7-flash': { input: 0.75, cachedInput: 0.1875, output: 3.75 },
  'gemini-3.6-flash': { input: 0.5, cachedInput: 0.125, output: 3.0 },
  'gemini-3.5-flash': { input: 0.5, cachedInput: 0.125, output: 3.0 },
  'gemini-3.1-pro': { input: 1.25, cachedInput: 0.3125, output: 5.0 },
  'claude-opus-4-6': { input: 15.0, cachedInput: 1.875, output: 75.0 },
  'claude-sonnet-4-6': { input: 3.0, cachedInput: 0.375, output: 15.0 },
  'gpt-oss-120b': { input: 1.0, cachedInput: 0.1, output: 6.0 },
};

function normalizeAntigravityModelName(modelName) {
  const name = String(modelName || 'unknown').replace(/-\d{4}-\d{2}-\d{2}$/, '');
  if (/^gemini-3\.7-flash(?:-exp)?(?:-agent)?(?:-a)?$/.test(name)) return 'gemini-3.7-flash';
  if (/^gemini-3\.6-flash(?:-tiered)?$/.test(name)) return 'gemini-3.6-flash';
  if (/^gemini-3\.5-flash(?:-extra-low|-low)?$/.test(name)) return 'gemini-3.5-flash';
  if (/^gemini-3\.1-pro(?:-low)?$/.test(name)) return 'gemini-3.1-pro';
  if (/^claude-(?:opus|sonnet)-4-6-thinking$/.test(name)) return name.replace(/-thinking$/, '');
  if (name === 'gpt-oss-120b-medium') return 'gpt-oss-120b';
  return name;
}

function antigravityModelCost(modelName, u) {
  const base = normalizeAntigravityModelName(modelName);
  const r = ANTIGRAVITY_PRICING[base] || { input: 0.75, cachedInput: 0.1875, output: 3.75 };
  return {
    input: ((u.input || 0) * r.input) / 1_000_000,
    output: ((u.output || 0) * r.output) / 1_000_000,
    cacheWrite: 0,
    cacheRead: ((u.cacheRead || 0) * r.cachedInput) / 1_000_000,
  };
}

// Antigravity CLI stores response usage in protobuf blobs inside one SQLite
// database per conversation. These helpers decode only the documented fields
// needed for usage; message content is never loaded or exposed.
function protoVarint(buffer, start) {
  let value = 0n;
  let shift = 0n;
  for (let pos = start; pos < buffer.length && pos < start + 10; pos++) {
    const byte = BigInt(buffer[pos]);
    value |= (byte & 0x7fn) << shift;
    if ((byte & 0x80n) === 0n) return { value: Number(value), next: pos + 1 };
    shift += 7n;
  }
  return null;
}

function protoField(buffer, wanted, wantedWire) {
  let pos = 0;
  while (pos < buffer.length) {
    const tag = protoVarint(buffer, pos);
    if (!tag) return null;
    pos = tag.next;
    const field = Math.floor(tag.value / 8);
    const wire = tag.value & 7;
    let value;
    if (wire === 0) {
      const decoded = protoVarint(buffer, pos);
      if (!decoded) return null;
      value = decoded.value;
      pos = decoded.next;
    } else if (wire === 1) {
      if (pos + 8 > buffer.length) return null;
      value = buffer.subarray(pos, pos + 8);
      pos += 8;
    } else if (wire === 2) {
      const length = protoVarint(buffer, pos);
      if (!length || length.value < 0 || pos + (length.next - pos) + length.value > buffer.length) return null;
      pos = length.next;
      value = buffer.subarray(pos, pos + length.value);
      pos += length.value;
    } else if (wire === 5) {
      if (pos + 4 > buffer.length) return null;
      value = buffer.subarray(pos, pos + 4);
      pos += 4;
    } else {
      return null;
    }
    if (field === wanted && (wantedWire == null || wire === wantedWire)) return value;
  }
  return null;
}

const protoMessage = (buffer, field) => protoField(buffer, field, 2);
const protoInt = (buffer, field) => protoField(buffer, field, 0);

function decodeAntigravityModelMetadata(data) {
  // Older layout: f1.f3 enum and f1.f19 model. Newer: f3.f1 and f3.f28.
  const oldInner = protoMessage(data, 1);
  const newInner = protoMessage(data, 3);
  for (const [inner, enumField, nameField] of [[oldInner, 3, 19], [newInner, 1, 28]]) {
    if (!inner) continue;
    const modelEnum = protoInt(inner, enumField);
    const nameBytes = protoMessage(inner, nameField);
    if (modelEnum != null && nameBytes?.length) {
      return [modelEnum, Buffer.from(nameBytes).toString('utf8').trim()];
    }
  }
  return null;
}

const ANTIGRAVITY_MODEL_ENUMS = new Map([
  [342, 'gpt-oss-120b-medium'],
  [1020, 'gemini-3.5-flash-low'],
  [1026, 'claude-opus-4-6-thinking'],
  [1035, 'claude-sonnet-4-6'],
  [1036, 'gemini-3.1-pro-low'],
  [1132, 'gemini-3.7-flash-agent'],
  [1187, 'gemini-3.5-flash-extra-low'],
  [1196, 'gemini-3.6-flash-tiered'],
]);

function decodeAntigravityStep(payload) {
  const event = protoMessage(payload, 5);
  const usage = event && protoMessage(event, 9);
  const timestamp = event && protoMessage(event, 1);
  if (!usage || !timestamp) return null;
  const seconds = protoInt(timestamp, 1);
  const modelEnum = protoInt(usage, 1);
  if (!seconds || modelEnum == null) return null;
  return {
    timestampMs: seconds * 1000 + Math.floor((protoInt(timestamp, 2) || 0) / 1_000_000),
    modelEnum,
    output: protoInt(usage, 2) || 0,
    reasoning: protoInt(usage, 3) || 0,
    cumulativeInput: protoInt(usage, 5) || 0,
  };
}

async function scanNativeAntigravitySessionsUncached() {
  if (!DatabaseSync) return { daily: [], models: [] };
  const conversationsDir = path.join(getAntigravityDataDir(), 'conversations');
  const byDate = new Map();
  const byModel = new Map();
  let files;
  try { files = await readdir(conversationsDir); } catch { return { daily: [], models: [] }; }

  for (const file of files) {
    if (!file.endsWith('.db') || file === 'conversation_summaries.db') continue;
    let db;
    try {
      db = new DatabaseSync(path.join(conversationsDir, file), { readOnly: true });
      const modelMap = new Map(ANTIGRAVITY_MODEL_ENUMS);
      for (const row of db.prepare('SELECT data FROM gen_metadata ORDER BY idx').iterate()) {
        const pair = decodeAntigravityModelMetadata(row.data);
        if (pair?.[1]) modelMap.set(pair[0], pair[1]);
      }
      const steps = [...db.prepare(
        'SELECT step_type, step_payload FROM steps WHERE step_type IN (15, 23) ORDER BY idx',
      ).iterate()].map((row) => ({ type: Number(row.step_type), usage: decodeAntigravityStep(row.step_payload) }))
        .filter((row) => row.usage);
      const modelCounts = new Map();
      for (const row of steps) {
        if (row.type === 15) modelCounts.set(row.usage.modelEnum, (modelCounts.get(row.usage.modelEnum) || 0) + 1);
      }
      const primaryEnum = [...modelCounts].sort((a, b) => b[1] - a[1])[0]?.[0];
      let previousInput = null;
      for (const row of steps) {
        const u = row.usage;
        const input = previousInput == null ? u.cumulativeInput : Math.max(0, u.cumulativeInput - previousInput);
        previousInput = u.cumulativeInput;
        const resolvedEnum = modelMap.has(u.modelEnum) ? u.modelEnum : primaryEnum;
        const modelName = normalizeAntigravityModelName(modelMap.get(resolvedEnum) || String(u.modelEnum));
        const date = new Date(u.timestampMs).toISOString().slice(0, 10);
        const totalTokens = input + u.output + u.reasoning;
        const cost = antigravityModelCost(modelName, { input, output: u.output + u.reasoning, cacheRead: 0 });
        const totalCost = cost.input + cost.output;

        const day = byDate.get(date) || { date, costUSD: 0, totalTokens: 0, unpriced: false };
        day.costUSD += totalCost;
        day.totalTokens += totalTokens;
        byDate.set(date, day);

        const cur = byModel.get(modelName) || blankBreakdown(modelName, providerOf(modelName));
        cur.tokens.input += input;
        cur.tokens.output += u.output;
        cur.tokens.reasoning = (cur.tokens.reasoning || 0) + u.reasoning;
        cur.cost.input += cost.input;
        cur.cost.output += cost.output;
        cur.cost.total += totalCost;
        byModel.set(modelName, cur);
      }
    } catch {
      // A conversation may be mid-write. Skip it for this poll and retry on
      // the next one instead of failing the entire dashboard.
    } finally {
      try { db?.close(); } catch {}
    }
  }
  return {
    daily: [...byDate.values()].sort((a, b) => a.date.localeCompare(b.date)),
    models: [...byModel.values()].sort((a, b) => {
      const tokens = (m) => m.tokens.input + m.tokens.output + (m.tokens.reasoning || 0);
      return tokens(b) - tokens(a);
    }),
  };
}

function mergeAntigravityUsage(...scans) {
  const byDate = new Map();
  const byModel = new Map();
  for (const scan of scans) {
    for (const row of scan.daily) {
      const cur = byDate.get(row.date) || { date: row.date, costUSD: 0, totalTokens: 0, unpriced: false };
      cur.costUSD += row.costUSD || 0;
      cur.totalTokens += row.totalTokens || 0;
      byDate.set(row.date, cur);
    }
    for (const model of scan.models) {
      const cur = byModel.get(model.modelName) || blankBreakdown(model.modelName, model.provider);
      for (const key of ['input', 'output', 'cacheWrite', 'cacheRead', 'reasoning']) {
        cur.tokens[key] = (cur.tokens[key] || 0) + (model.tokens[key] || 0);
      }
      for (const key of ['input', 'output', 'cacheWrite', 'cacheRead', 'total']) cur.cost[key] += model.cost[key] || 0;
      byModel.set(model.modelName, cur);
    }
  }
  return { daily: [...byDate.values()], models: [...byModel.values()] };
}

async function scanPiAntigravitySessionsUncached(excludeDates = new Set()) {
  const byDate = new Map();
  const byModel = new Map();
  const piSessionsDir = getPiSessionsDir();
  try {
    const projDirs = await readdir(piSessionsDir, { withFileTypes: true });
    for (const pDir of projDirs) {
      if (!pDir.isDirectory()) continue;
      const dirPath = path.join(piSessionsDir, pDir.name);
      let files;
      try { files = await readdir(dirPath); } catch { continue; }
      for (const file of files) {
        if (!file.endsWith('.jsonl')) continue;
        await forEachLine(path.join(dirPath, file), (line) => {
          if (!line.includes('"assistant"')) return;
          let o;
          try { o = JSON.parse(line); } catch { return; }
          if (o.type !== 'message' || o.message?.role !== 'assistant') return;
          // Pi has used both the provider field and the API field to identify
          // Cloud Code Assist records across releases. Accept either, while
          // still excluding ordinary Gemini/Claude sessions from elsewhere.
          if (o.message?.provider !== 'antigravity' && o.message?.api !== 'antigravity-api') return;
          const u = o.message.usage;
          if (!u) return;

          const rawTimestamp = o.timestamp || o.message.timestamp;
          const timestamp = typeof rawTimestamp === 'number'
            ? new Date(rawTimestamp > 1e12 ? rawTimestamp : rawTimestamp * 1000).toISOString()
            : String(rawTimestamp || '');
          const date = timestamp.slice(0, 10);
          if (!date) return;
          // Pi drives Antigravity through the same local antigravity-cli
          // backend, which independently logs the identical exchange into
          // its own conversations DB (see scanNativeAntigravitySessions).
          // On any date the native scan already covers, counting Pi's copy
          // too would double-bill the same tokens/cost.
          if (excludeDates.has(date)) return;

          const inputTok = Number(u.input ?? u.inputTokens) || 0;
          const outputTok = Number(u.output ?? u.outputTokens) || 0;
          const cacheReadTok = Number(u.cacheRead ?? u.cacheReadTokens) || 0;
          const cacheWriteTok = Number(u.cacheWrite ?? u.cacheWriteTokens) || 0;
          const totTok = Number(u.totalTokens) || (inputTok + outputTok + cacheReadTok + cacheWriteTok);
          const modelName = normalizeAntigravityModelName(o.message.model || 'gemini-3.6-flash');
          const cost = antigravityModelCost(modelName, {
            input: inputTok,
            output: outputTok,
            cacheRead: cacheReadTok,
          });
          const totalCost = cost.input + cost.output + cost.cacheRead;

          const day = byDate.get(date) || { date, costUSD: 0, totalTokens: 0, unpriced: false };
          day.costUSD += totalCost;
          day.totalTokens += totTok;
          byDate.set(date, day);

          const cur = byModel.get(modelName) || blankBreakdown(modelName, providerOf(modelName));
          cur.tokens.input += inputTok;
          cur.tokens.output += outputTok;
          cur.tokens.cacheRead += cacheReadTok;
          cur.tokens.cacheWrite += cacheWriteTok;
          cur.cost.input += cost.input;
          cur.cost.output += cost.output;
          cur.cost.cacheRead += cost.cacheRead;
          cur.cost.total += totalCost;
          byModel.set(modelName, cur);
        });
      }
    }
  } catch {}
  return {
    daily: [...byDate.values()].sort((a, b) => a.date.localeCompare(b.date)),
    models: [...byModel.values()].sort((a, b) => b.cost.total - a.cost.total),
  };
}

/** The 82-odd conversation databases Antigravity keeps, and their WALs. */
async function antigravityDbFiles() {
  const dir = path.join(getAntigravityDataDir(), 'conversations');
  let names = [];
  try { names = await readdir(dir); } catch { return []; }
  const out = [];
  for (const n of names) {
    if (!n.endsWith('.db') || n === 'conversation_summaries.db') continue;
    out.push(path.join(dir, n), path.join(dir, `${n}-wal`));
  }
  return out.sort();
}

async function scanNativeAntigravitySessions(stats, opts) {
  const paths = await antigravityDbFiles();
  if (!paths.length) return scanNativeAntigravitySessionsUncached();
  return cachedScan('antigravity-native', paths, scanNativeAntigravitySessionsUncached, stats, opts);
}

async function scanPiAntigravitySessions(excludeDates, stats, opts) {
  const paths = (await jsonlFilesUnder(getPiSessionsDir())).sort();
  if (!paths.length) return scanPiAntigravitySessionsUncached(excludeDates);
  // The exclude set is derived from the native scan, so it belongs in the key:
  // the same files with a different exclusion are a different answer.
  const key = `antigravity-pi:${[...excludeDates].sort().join(',')}`;
  return cachedScan(key, paths, () => scanPiAntigravitySessionsUncached(excludeDates), stats, opts);
}

async function getAntigravityAccountUsage(account, force, { rebuild = false } = {}) {
  const stats = blankStats();
  const [rateLimits, nativeUsage] = await Promise.all([
    getAntigravityRateLimits(account, force),
    scanNativeAntigravitySessions(stats, { rebuild }),
  ]);
  const nativeDates = new Set(nativeUsage.daily.map((row) => row.date));
  const piUsage = await scanPiAntigravitySessions(nativeDates, stats, { rebuild });
  const usage = mergeAntigravityUsage(piUsage, nativeUsage);
  const section = summarize(usage.daily, 'costUSD');
  section.rateLimits = rateLimits;
  section.models = usage.models;
  section.planLabel = rateLimits?.planLabel || null;
  section.scan = stats;
  return section;
}

// --- OpenCode -----------------------------------------------------------------
// OpenCode keeps every session row in ~/.local/share/opencode/opencode.db with
// real per-session cost + token totals already computed by the app itself, so
// there's no rate-card math here — just read-only aggregation. Opened read-only
// (WAL-safe even while opencode is running) on every scan; a session created
// mid-request just won't show until the next 30s poll.
//
function parseOpencodeModel(model) {
  if (!model) return null;
  try {
    const o = JSON.parse(model);
    return { id: o.id || null, providerID: o.providerID || null };
  } catch {}
  return { id: model, providerID: null };
}

function opencodeProviderName(providerID) {
  return providerID === 'opencode-go' ? 'OpenCode Go'
    : providerID === 'opencode' ? 'OpenCode'
      : providerID === 'openai' ? 'OpenAI'
        : providerID === 'xai' ? 'xAI'
          : providerID === 'github-copilot' ? 'GitHub Copilot'
          : providerID || 'Unknown';
}

// Official DeepSeek API list prices, USD per million tokens (checked
// 2026-08-19). Peak hours are 01:00-04:00 and 06:00-10:00 UTC; all other
// hours use the off-peak rate. OpenCode Zen's `-free` route records $0,
// but the dashboard intentionally shows the equivalent public API value so
// free/subscription usage can be compared with the other coding agents.
const OPENCODE_DEEPSEEK_PRICING = {
  'deepseek-v4-flash': {
    offPeak: { input: 0.22, cachedInput: 0.007, output: 0.66 },
    peak: { input: 0.44, cachedInput: 0.014, output: 1.32 },
  },
  'deepseek-v4-pro': {
    offPeak: { input: 0.66, cachedInput: 0.022, output: 1.98 },
    peak: { input: 1.32, cachedInput: 0.044, output: 3.96 },
  },
};

function opencodeDeepseekCost(modelName, usage, timestampMs) {
  const base = String(modelName || '').replace(/-free$/, '').replace(/-\d{4}-\d{2}-\d{2}$/, '');
  const pricing = OPENCODE_DEEPSEEK_PRICING[base];
  if (!pricing) return null;
  const hour = new Date(timestampMs).getUTCHours();
  const isPeak = (hour >= 1 && hour < 4) || (hour >= 6 && hour < 10);
  const rates = isPeak ? pricing.peak : pricing.offPeak;
  return {
    input: ((usage.input || 0) * rates.input) / 1_000_000,
    output: (((usage.output || 0) + (usage.reasoning || 0)) * rates.output) / 1_000_000,
    cacheWrite: 0,
    cacheRead: ((usage.cacheRead || 0) * rates.cachedInput) / 1_000_000,
  };
}

// --- database scans, kept until the database moves ---------------------------
//
// Devin's store is 1.06GB with a 610MB WAL beside it and OpenCode's is 1.24GB;
// scanning either means walking every message row. Measured on a warm pass,
// that was 3.9s and 0.7s respectively - spent every single refresh, including
// the overwhelming majority where the agent had not been used since the last
// one and the answer could not possibly have changed.
const dbResultCache = new ResultCache({ id: 'db' });

/**
 * The database plus the WAL, which is where a committed write actually lands.
 *
 * Deliberately NOT the -shm sidecar. That file is shared-memory coordination
 * state, not data, and merely opening the database read-only rewrites its
 * mtime - measured on the 1GB Devin store, a single read-only count(*) moved
 * it while the database and the WAL stayed byte-identical. Signing on it made
 * the cache invalidate itself: every scan dirtied the thing it was watching,
 * so the next scan re-read all 1GB, for ever. A write always lands in the WAL
 * (or is checkpointed into the database), so those two are the whole story.
 */
const dbFiles = (dbPath) => [dbPath, `${dbPath}-wal`];

/** Total bytes of a path list, for reporting what a hit avoided reading. */
async function bytesOf(paths) {
  let total = 0;
  for (const p of paths) {
    try { total += (await stat(p)).size; } catch { /* absent sidecar */ }
  }
  return total;
}

/**
 * Run `work` only if one of `paths` has moved since last time.
 *
 * The JSONL scanners read appended bytes; this is for the scans that have no
 * such seam - a SQLite aggregation, or a walk that folds dozens of stores into
 * one answer. Stat is cheap and the answer is usually "nothing changed",
 * because an agent you are not using right now cannot have produced new usage.
 */
async function cachedScan(key, paths, work, stats, { rebuild = false } = {}) {
  if (stats) stats.dbs++;
  const { hit, sig, value } = await dbResultCache.lookup(key, paths, { force: rebuild });
  if (hit) {
    if (stats) { stats.dbHits++; stats.dbBytesSkipped += await bytesOf(paths); }
    return value;
  }
  const fresh = await work();
  dbResultCache.store(key, sig, fresh);
  if (stats) stats.dbScans++;
  return fresh;
}

async function scanDatabase(kind, dbPath, run, stats, opts) {
  return cachedScan(`${kind}:${dbPath}`, dbFiles(dbPath), () => run(dbPath), stats, opts);
}

function scanOpencodeSessionsUncached(dbPath) {
  if (!DatabaseSync) return { daily: [], models: [] };
  const byDate = new Map();
  const byModel = new Map();
  let db;
  try {
    db = new DatabaseSync(dbPath, { readOnly: true });
    const sessionStmt = db.prepare(
      'SELECT id, model, agent, cost, tokens_input, tokens_output, tokens_reasoning, tokens_cache_read, tokens_cache_write, time_created FROM session',
    );
    const messageStmt = db.prepare(`
      SELECT m.session_id AS session_id,
        json_extract(m.data, '$.modelID') AS model_id,
        json_extract(m.data, '$.providerID') AS provider_id,
        json_extract(m.data, '$.tokens.input') AS input,
        json_extract(m.data, '$.tokens.output') AS output,
        json_extract(m.data, '$.tokens.reasoning') AS reasoning,
        json_extract(m.data, '$.tokens.cache.read') AS cache_read,
        json_extract(m.data, '$.tokens.cache.write') AS cache_write
      FROM message m
      JOIN session s ON s.id = m.session_id
      WHERE s.model IS NULL AND json_extract(m.data, '$.modelID') IS NOT NULL
    `);
    const messageUsage = new Map();
    for (const m of messageStmt.iterate()) {
      const key = `${m.session_id}::${m.provider_id || 'unknown'}::${m.model_id}`;
      const current = messageUsage.get(key) || {
        sessionID: m.session_id,
        modelName: m.model_id,
        providerID: m.provider_id || 'unknown',
        input: 0,
        output: 0,
        reasoning: 0,
        cacheRead: 0,
        cacheWrite: 0,
      };
      current.input += Number(m.input) || 0;
      current.output += Number(m.output) || 0;
      current.reasoning += Number(m.reasoning) || 0;
      current.cacheRead += Number(m.cache_read) || 0;
      current.cacheWrite += Number(m.cache_write) || 0;
      messageUsage.set(key, current);
    }
    for (const r of sessionStmt.iterate()) {
      let ts = Number(r.time_created);
      if (!ts || !Number.isFinite(ts)) continue;
      // Older rows are unix seconds; newer ones are milliseconds.
      if (ts > 1e12) ts = Math.floor(ts / 1000);
      const date = new Date(ts * 1000).toISOString().slice(0, 10);
      const parsedModel = parseOpencodeModel(r.model);
      const modelName = parsedModel?.id || r.agent || 'unknown';
      const providerID = parsedModel?.providerID || 'unknown';
      const billedCost = Number(r.cost) || 0;
      const input = Number(r.tokens_input) || 0;
      const output = Number(r.tokens_output) || 0;
      const reasoning = Number(r.tokens_reasoning) || 0;
      const cacheWrite = Number(r.tokens_cache_write) || 0;
      const cacheRead = Number(r.tokens_cache_read) || 0;
      const totalTokens = input + output + reasoning + cacheWrite + cacheRead;

      const day = byDate.get(date) || { date, costUSD: 0, totalTokens: 0, unpriced: false };
      const sessionTokens = input + output + reasoning + cacheWrite + cacheRead;
      const messageModels = parsedModel
        ? [{ modelName, providerID, input, output, reasoning, cacheRead, cacheWrite }]
        : [...messageUsage.values()].filter((m) => m.sessionID === r.id);
      const parts = messageModels.length ? messageModels : [{ modelName, providerID, input, output, reasoning, cacheRead, cacheWrite }];
      const apiCosts = parts.map((part) => opencodeDeepseekCost(part.modelName, part, ts * 1000));
      const apiCostTotal = apiCosts.reduce((sum, item) => sum + (item
        ? item.input + item.output + item.cacheWrite + item.cacheRead
        : 0), 0);
      const effectiveSessionCost = billedCost || apiCostTotal;
      day.costUSD += effectiveSessionCost;
      day.totalTokens += totalTokens;
      byDate.set(date, day);

      for (let partIndex = 0; partIndex < parts.length; partIndex++) {
        const part = parts[partIndex];
        const partTokens = part.input + part.output + part.reasoning + part.cacheRead + part.cacheWrite;
        const apiCost = apiCosts[partIndex];
        const costShare = billedCost
          ? (sessionTokens ? billedCost * (partTokens / sessionTokens) : billedCost / parts.length)
          : apiCost ? apiCost.input + apiCost.output + apiCost.cacheWrite + apiCost.cacheRead : 0;
        const modelKey = `${part.providerID}::${part.modelName}`;
        const cur = byModel.get(modelKey) || blankBreakdown(part.modelName, providerOf(part.modelName));
        cur.provider = opencodeProviderName(part.providerID);
        cur.route = part.providerID;
        cur.tokens.input += part.input;
        cur.tokens.output += part.output;
        cur.tokens.reasoning = (cur.tokens.reasoning || 0) + part.reasoning;
        cur.tokens.cacheRead += part.cacheRead;
        cur.tokens.cacheWrite += part.cacheWrite;
        if (apiCost && !billedCost) {
          cur.cost.input += apiCost.input;
          cur.cost.output += apiCost.output;
          cur.cost.cacheWrite += apiCost.cacheWrite;
          cur.cost.cacheRead += apiCost.cacheRead;
        }
        cur.cost.total += costShare;
        if (apiCost && !billedCost) cur.pricingSource = 'DeepSeek API equivalent (peak/off-peak)';
        byModel.set(modelKey, cur);
      }
    }
    db.close();
  } catch {
    try { db?.close(); } catch {}
  }
  return {
    daily: [...byDate.values()].sort((a, b) => a.date.localeCompare(b.date)),
    models: [...byModel.values()].sort((a, b) => {
      const tokenCount = (m) => m.tokens.input + m.tokens.output + (m.tokens.reasoning || 0) + m.tokens.cacheRead + m.tokens.cacheWrite;
      return tokenCount(b) - tokenCount(a);
    }),
  };
}

async function getOpencodeAccountUsage(account, force, { rebuild = false } = {}) {
  const stats = blankStats();
  const scanned = await scanDatabase('opencode', account.dbPath, scanOpencodeSessionsUncached, stats, { rebuild });
  const section = summarize(scanned.daily, 'costUSD');
  section.rateLimits = null;
  section.models = scanned.models;
  section.planLabel = null;
  section.scan = stats;
  return section;
}


// --- Devin ------------------------------------------------------------------
// Devin CLI and Devin Desktop share one store — the desktop app spawns the CLI
// over ACP, so both land in ~/.local/share/devin/cli/sessions.db with
// backend_type telling them apart ("windsurf" = desktop). Each assistant
// message node carries the generation's token metrics. There is no local
// rate-limit feed, and swe-* models have no public per-token rate (plan/ACU
// billing), so cost is only filled in where a public OpenAI-equivalent rate
// applies; the rest reports tokens with the unpriced flag.

const DEVIN_TIER_SUFFIX = /-(?:fast|slow|medium|high|max|sidekick)(?=-|$)/g;

function devinBaseModel(modelName) {
  return String(modelName || '')
    .replace(DEVIN_TIER_SUFFIX, '')
    .replace(/^gpt-(\d+)-(\d+)/, 'gpt-$1.$2');
}

function devinProviderName(modelName) {
  return /^gpt-/.test(modelName) ? 'OpenAI' : 'Cognition';
}

function devinModelCost(modelName, u) {
  const rates = CODEX_PRICING[devinBaseModel(modelName)];
  if (!rates) return null;
  const cached = Number(u.cacheReadTokens) || 0;
  const fresh = Math.max(0, (Number(u.inputTokens) || 0) - cached);
  const out = Number(u.outputTokens) || 0;
  return {
    input: (fresh * rates.input) / 1e6,
    output: (out * rates.output) / 1e6,
    cacheWrite: 0,
    cacheRead: (cached * rates.cachedInput) / 1e6,
    total: (fresh * rates.input + cached * rates.cachedInput + out * rates.output) / 1e6,
  };
}

function scanDevinSessionsUncached(dbPath) {
  if (!DatabaseSync) return { daily: [], models: [], sources: [] };
  const byDate = new Map();
  const byModel = new Map();
  const sources = new Set();
  // The CLI rewrites an assistant node when its tool calls resolve, storing
  // the same generation under the same request_id a second time — count each
  // generation once.
  const seenRequests = new Set();
  let db;
  try {
    db = new DatabaseSync(dbPath, { readOnly: true });
    const stmt = db.prepare(`
      SELECT m.created_at AS ts, s.backend_type AS backend,
        json_extract(m.chat_message, '$.metadata.request_id') AS requestId,
        json_extract(m.chat_message, '$.metadata.generation_model') AS model,
        json_extract(m.chat_message, '$.metadata.metrics.input_tokens') AS input,
        json_extract(m.chat_message, '$.metadata.metrics.output_tokens') AS output,
        json_extract(m.chat_message, '$.metadata.metrics.cache_read_tokens') AS cacheRead,
        json_extract(m.chat_message, '$.metadata.metrics.cache_creation_tokens') AS cacheWrite
      FROM message_nodes m
      JOIN sessions s ON s.id = m.session_id
      WHERE json_extract(m.chat_message, '$.metadata.metrics') IS NOT NULL
    `);
    for (const r of stmt.iterate()) {
      if (r.requestId) {
        if (seenRequests.has(r.requestId)) continue;
        seenRequests.add(r.requestId);
      }
      let ts = Number(r.ts);
      if (!ts || !Number.isFinite(ts)) continue;
      if (ts > 1e12) ts = Math.floor(ts / 1000);
      const date = new Date(ts * 1000).toISOString().slice(0, 10);
      const modelName = r.model || 'unknown';
      const tokens = {
        inputTokens: Number(r.input) || 0,
        outputTokens: Number(r.output) || 0,
        cacheReadTokens: Number(r.cacheRead) || 0,
        cacheCreationTokens: Number(r.cacheWrite) || 0,
      };
      const totalTokens = tokens.inputTokens + tokens.outputTokens + tokens.cacheReadTokens + tokens.cacheCreationTokens;
      if (r.backend === 'windsurf') sources.add('Devin Desktop');
      else if (r.backend) sources.add('Devin CLI');

      const cost = devinModelCost(modelName, tokens);
      const day = byDate.get(date) || { date, costUSD: 0, totalTokens: 0, unpriced: false };
      day.totalTokens += totalTokens;
      if (!cost) day.unpriced = true;
      else day.costUSD += cost.total;
      byDate.set(date, day);

      const cur = byModel.get(modelName) || blankBreakdown(modelName, devinProviderName(modelName));
      cur.tokens.input += tokens.inputTokens;
      cur.tokens.output += tokens.outputTokens;
      cur.tokens.cacheRead += tokens.cacheReadTokens;
      cur.tokens.cacheWrite += tokens.cacheCreationTokens;
      if (!cost) cur.unpriced = true;
      else {
        cur.cost.input += cost.input;
        cur.cost.output += cost.output;
        cur.cost.cacheRead += cost.cacheRead;
        cur.cost.total += cost.input + cost.output + cost.cacheRead;
        cur.pricingSource = 'OpenAI API equivalent';
      }
      byModel.set(modelName, cur);
    }
    db.close();
  } catch {
    try { db?.close(); } catch {}
  }
  return {
    daily: [...byDate.values()].sort((a, b) => a.date.localeCompare(b.date)),
    models: [...byModel.values()].sort((a, b) => {
      const tokenCount = (m) => m.tokens.input + m.tokens.output + m.tokens.cacheRead + m.tokens.cacheWrite;
      return tokenCount(b) - tokenCount(a);
    }),
    sources: [...sources],
  };
}

async function getDevinAccountUsage(account, force, { rebuild = false } = {}) {
  const stats = blankStats();
  const scanned = await scanDatabase('devin', account.dbPath, scanDevinSessionsUncached, stats, { rebuild });
  const section = summarize(scanned.daily, 'costUSD');
  section.rateLimits = null;
  section.models = scanned.models;
  section.planLabel = null;
  section.usageSources = scanned.sources.length ? scanned.sources : ['Devin CLI'];
  section.scan = stats;
  return section;
}


// --- prompt cache ------------------------------------------------------------
//
// The number this dashboard exists to show, alongside the bill: how much of
// what you sent the model was served from its prompt cache rather than read
// fresh. A cached input token costs a fraction of a fresh one - an eighth on
// Claude, a tenth on the OpenAI rate card - so on a long agent session, where
// the same context is resent every turn, the hit rate *is* the bill.
//
// Two figures, because caching is not free in both directions: reads save the
// difference between the fresh and cached rates, and writes are billed above
// the fresh rate. The honest number is what is left after the toll.

/** Per-million rates for one model as {input, cacheRead, cacheWrite}, or null. */
function cacheRatesFor(modelName, provider) {
  const flat = (r) => r && { input: r.input, cacheRead: r.cachedInput, cacheWrite: r.input };
  switch (provider) {
    case 'claude': {
      const r = claudeRatesFor(modelName, new Date().toISOString().slice(0, 10));
      return r && { input: r.input, cacheRead: r.cacheRead, cacheWrite: r.cacheWrite };
    }
    case 'codex':
      return flat(CODEX_PRICING[String(modelName || '').replace(/-\d{4}-\d{2}-\d{2}$/, '')]);
    case 'devin':
      return flat(CODEX_PRICING[devinBaseModel(modelName)]);
    case 'antigravity':
      return flat(ANTIGRAVITY_PRICING[normalizeAntigravityModelName(modelName)]);
    default:
      // OpenCode reports a billed total rather than per-channel rates, and
      // Grok reports only a tick cost - so their tokens are counted and their
      // saving is left unclaimed rather than guessed at.
      return null;
  }
}

function cacheStatsFor(models, provider) {
  const out = {
    freshInput: 0, cacheRead: 0, cacheWrite: 0, output: 0,
    hitRate: 0, savedUsd: 0, writePremiumUsd: 0, netSavedUsd: 0,
    wouldHaveCostUsd: 0, unpriced: false, models: [],
  };
  // Grok stashes reasoning tokens in the cacheWrite column to fit the shared
  // four-column table, so reading it as cache here would invent a number.
  if (provider === 'grok') return null;

  for (const m of models || []) {
    const t = m.tokens || {};
    const input = t.input || 0;
    const cacheRead = t.cacheRead || 0;
    const cacheWrite = t.cacheWrite || 0;
    out.freshInput += input;
    out.cacheRead += cacheRead;
    out.cacheWrite += cacheWrite;
    out.output += t.output || 0;

    const rates = cacheRatesFor(m.modelName, provider);
    if (!rates) {
      if (cacheRead || cacheWrite) out.unpriced = true;
      continue;
    }
    const saved = (cacheRead * (rates.input - rates.cacheRead)) / 1e6;
    const premium = (cacheWrite * (rates.cacheWrite - rates.input)) / 1e6;
    out.savedUsd += saved;
    out.writePremiumUsd += premium;
    out.wouldHaveCostUsd += (cacheRead * rates.input) / 1e6;
    const denom = input + cacheRead;
    out.models.push({
      modelName: m.modelName,
      hitRate: denom ? cacheRead / denom : 0,
      cacheRead,
      freshInput: input,
      savedUsd: saved - premium,
    });
  }
  const denom = out.freshInput + out.cacheRead;
  out.hitRate = denom ? out.cacheRead / denom : 0;
  out.netSavedUsd = out.savedUsd - out.writePremiumUsd;
  out.models.sort((a, b) => b.savedUsd - a.savedUsd);
  return out;
}

async function getAccountUsage(account, force, { rescanFiles = false, rebuild = false } = {}) {
  let section;
  if (account.provider === 'claude') section = await getClaudeAccountUsage(account, force, { rescanFiles, rebuild });
  else if (account.provider === 'codex') section = await getCodexAccountUsage(account, force, { rescanFiles, rebuild });
  else if (account.provider === 'grok') section = await getGrokAccountUsage(account, force);
  else if (account.provider === 'antigravity') section = await getAntigravityAccountUsage(account, force, { rebuild });
  else if (account.provider === 'opencode') section = await getOpencodeAccountUsage(account, force, { rebuild });
  else if (account.provider === 'devin') section = await getDevinAccountUsage(account, force, { rebuild });
  else throw new Error(`unknown provider ${account.provider}`);
  section.cache = cacheStatsFor(section.models, account.provider);
  return { id: account.id, provider: account.provider, label: account.label, ...section };
}

// ------------------------------------------------------------------- caching
//
// Four tiers, cheapest first, and the expensive one is now the one that is
// persisted. It used to be the other way round: the 34KB aggregate was written
// to disk and the parse work behind it (1.8GB of rollouts, 8-16s) lived only in
// memory, so every restart - which the deploy procedure does on every change -
// rebuilt it from nothing.
//
//   memory   the whole reply, for rapid polls
//   disk     the same reply, so a restart answers immediately
//   index    per-file token rollups (scan-cache.js), so a restart does not rescan
//   files    the only tier that touches a session log, and only its new bytes
//
// What a reader gets is never allowed to depend on how long the scan takes:
// a stale reply goes out at once and the refresh happens behind it.

let cache = null;
let cacheAt = 0;
let inflight = null;
let lastScan = { at: 0, ms: 0, stats: blankStats(), timings: [], indexLoaded: false, indexSavedAt: 0 };
const CACHE_MS = 30_000;
const DISK_CACHE_MS = 5 * 60_000;
// Past this the cached reply is still served, but only while a refresh runs
// behind it. Beyond it, a reader waits - data this old is a guess, not a memory.
const STALE_MAX_MS = 60 * 60_000;
// Bumped whenever the shape of an account section changes: the disk cache
// holds whole replies, so a stale one silently serves the old shape and the
// new field simply never appears (prompt-cache stats, added at v4).
const DISK_CACHE_VERSION = 4;
const DISK_CACHE_PATH = path.join(__dirname, 'usage-cache.json');
const SCAN_INDEX_PATH = process.env.CC_USAGE_SCAN_INDEX || path.join(__dirname, 'scan-index.json');
const fileCaches = [claudeSessionCache, codexRolloutCache, dbResultCache];

async function loadDiskCache() {
  if (!existsSync(DISK_CACHE_PATH)) return null;
  try {
    const raw = await readFile(DISK_CACHE_PATH, 'utf8');
    const data = JSON.parse(raw);
    if (!data || data.cacheVersion !== DISK_CACHE_VERSION || !Array.isArray(data.accounts)) return null;
    data.accounts = data.accounts.filter((account) => !isProviderDisabled(account.provider));
    const age = Date.now() - Date.parse(data.fetchedAt);
    if (!(age >= 0) || age > STALE_MAX_MS) return null;
    return data;
  } catch {
    return null;
  }
}

function saveDiskCache(value) {
  writeFile(DISK_CACHE_PATH, JSON.stringify(value), 'utf8').catch(() => {});
}

/**
 * Read the per-file index back at startup. Without this the first refresh
 * after a restart re-parses every session log on the machine; with it, the
 * same refresh is a few hundred stat calls.
 */
async function primeScanIndex() {
  const t0 = Date.now();
  const ok = await loadIndex(SCAN_INDEX_PATH, fileCaches);
  lastScan.indexLoaded = ok;
  if (ok) {
    const files = fileCaches.reduce((n, c) => n + c.entries.size, 0);
    console.log(`cc-usage-dashboard: scan index restored (${files} files, ${Date.now() - t0}ms) - no cold rescan needed`);
  }
  return ok;
}

async function persistScanIndex() {
  if (await saveIndex(SCAN_INDEX_PATH, fileCaches)) lastScan.indexSavedAt = Date.now();
}

// Every observation of (limit percentage, cumulative tokens, cumulative cost)
// is worth keeping: the ledger turns them into the per-percent exchange rate
// that no provider reports directly. Deduplication lives in the ledger, so
// calling this on cache hits too costs nothing and closes gaps.
function noteHistory(usage) {
  limitHistory.recordSnapshot(usage).catch((e) => {
    console.error('limit-history: failed to record snapshot:', e.message);
  });
}

/**
 * What the cache did, in the terms a person cares about: how much of the work
 * was avoided, and how much was actually read off disk.
 */
function cacheReport({ source, ageMs, stale, refreshing }) {
  const s = lastScan.stats;
  const considered = s.files || 0;
  const reused = (s.hits || 0) + (s.sealed || 0);
  // Databases count toward the byte figures too: a 1GB store left unread is
  // the largest single thing the cache avoids on a quiet pass.
  const skipped = (s.bytesSkipped || 0) + (s.dbBytesSkipped || 0);
  const bytesTotal = (s.bytesRead || 0) + skipped;
  return {
    source,
    ageMs,
    stale: !!stale,
    refreshing: !!refreshing,
    ttlMs: CACHE_MS,
    diskTtlMs: DISK_CACHE_MS,
    indexRestored: lastScan.indexLoaded,
    indexPath: SCAN_INDEX_PATH,
    lastScanAt: lastScan.at || null,
    lastScanMs: lastScan.ms || 0,
    // Slowest first: the one worth looking at is the one at the top.
    accounts: [...(lastScan.timings || [])].sort((a, b) => b.ms - a.ms),
    backingOff: failureReport(),
    files: {
      considered,
      sealed: s.sealed || 0,       // too old to have changed; not even stat'ed
      hits: s.hits || 0,           // unchanged since last time
      appended: s.appended || 0,   // grew; only the new bytes were read
      parsed: s.parsed || 0,       // new or rewritten; read whole
      dropped: s.dropped || 0,
    },
    hitRate: considered ? reused / considered : 1,
    databases: { considered: s.dbs || 0, reused: s.dbHits || 0, scanned: s.dbScans || 0 },
    bytes: { read: s.bytesRead || 0, skipped, total: bytesTotal },
    byteHitRate: bytesTotal ? skipped / bytesTotal : 1,
  };
}

/** The scan itself. Never entered twice at once - see refreshUsage(). */
async function scanAll({ rescanFiles = false, rebuild = false } = {}) {
  const started = Date.now();
  const accounts = await detectAccounts();
  // Sequential, not Promise.all: heavy scans (multi-GB session dirs, ccusage
  // children parsing the Codex/Claude histories) must never overlap, or their
  // page-cache and heap charges would stack into the gigabytes.
  const results = [];
  const timings = [];
  for (const account of accounts) {
    const t0 = Date.now();
    const section = await getAccountUsage(account, false, { rescanFiles, rebuild });
    // Per-account, because "the refresh is slow" is not actionable until you
    // know which provider it is waiting on - a session scan, a SQLite read, or
    // a rate-limit endpoint that is timing out.
    section.scanMs = Date.now() - t0;
    timings.push({ id: account.id, provider: account.provider, ms: section.scanMs, cached: !!section.scan });
    results.push(section);
  }

  let stats = blankStats();
  for (const r of results) if (r.scan) stats = addStats(stats, r.scan);
  lastScan = { ...lastScan, at: Date.now(), ms: Date.now() - started, stats, timings };

  const value = { cacheVersion: DISK_CACHE_VERSION, accounts: results, fetchedAt: new Date().toISOString() };
  cache = value;
  cacheAt = Date.now();
  saveDiskCache(value);
  persistScanIndex().catch(() => {});
  noteHistory(value);
  return value;
}

/**
 * One scan at a time, however many readers are waiting.
 *
 * Without this, every request arriving after the cache expired started its own
 * full scan: the sequential loop inside a scan stops passes overlapping with
 * themselves, not with each other.
 */
function refreshUsage(opts) {
  if (!inflight) {
    inflight = scanAll(opts).finally(() => { inflight = null; });
  }
  return inflight;
}

async function getUsage({ force = false, rebuild = false } = {}) {
  const now = Date.now();
  // Rescan re-stats every file, seal included, and re-reads only what changed.
  // Rebuild additionally distrusts the cache key and re-reads every byte - the
  // only thing that can repair an entry whose (mtime, size, ino) lied.
  if (force || rebuild) {
    const fresh = await refreshUsage({ rescanFiles: true, rebuild });
    return { ...fresh, cache: cacheReport({ source: 'scan', ageMs: 0 }) };
  }

  if (cache && now - cacheAt < CACHE_MS) {
    return { ...cache, cache: cacheReport({ source: 'memory', ageMs: now - cacheAt }) };
  }

  if (!cache) {
    const disk = await loadDiskCache();
    if (disk) {
      cache = disk;
      cacheAt = Date.parse(disk.fetchedAt) || now;
      noteHistory(disk);
    }
  }

  const age = cache ? Date.now() - cacheAt : Infinity;
  // Fresh enough on disk: answer, and do not scan at all.
  if (cache && age < DISK_CACHE_MS) {
    return { ...cache, cache: cacheReport({ source: 'disk', ageMs: age }) };
  }
  // Stale but usable: answer now, refresh behind it. This is the case that
  // used to make whoever knocked first pay for the whole scan.
  if (cache && age < STALE_MAX_MS) {
    refreshUsage().catch((e) => console.error('cc-usage-dashboard: background refresh failed:', e.message));
    return { ...cache, cache: cacheReport({ source: 'stale', ageMs: age, stale: true, refreshing: true }) };
  }
  const fresh = await refreshUsage();
  return { ...fresh, cache: cacheReport({ source: 'scan', ageMs: 0 }) };
}
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);

  if (url.pathname === '/api/usage') {
    try {
      const force = url.searchParams.get('force') === '1';
      const rebuild = url.searchParams.get('rebuild') === '1';
      const data = await getUsage({ force, rebuild });
      res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
      res.end(JSON.stringify(data));
    } catch (e) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: String(e) }));
    }
    return;
  }

  // Manual "refresh" button: bypass the 15-min backoff and force one live
  // attempt right now for one account, bypassing the 30s dashboard cache
  // too so the response reflects it immediately.
  if (url.pathname === '/api/refresh-limits' && req.method === 'POST') {
    const accountId = url.searchParams.get('id');
    try {
      const accounts = await detectAccounts();
      const targets = accountId ? accounts.filter((a) => a.id === accountId) : accounts;
      const results = await Promise.all(targets.map(async (a) => {
        let rateLimits = null;
        if (a.provider === 'claude') rateLimits = await getClaudeRateLimits(a, true);
        else if (a.provider === 'codex') rateLimits = await getCodexRateLimits(a, true);
        else if (a.provider === 'grok') rateLimits = await getGrokRateLimits(a, true);
        else if (a.provider === 'antigravity') rateLimits = await getAntigravityRateLimits(a, true);
        return [a.id, rateLimits];
      }));
      // Merge the fresh limits into the current cache instead of nulling it:
      // a manual refresh is only about limits, not about re-scanning the
      // multi-GB session dirs again.
      if (typeof cache === 'object' && cache !== null) {
        for (const [id, limits] of results) {
          const account = cache.accounts.find((a) => a.id === id);
          if (account) account.rateLimits = limits;
        }
        noteHistory(cache);
      }
      res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
      res.end(JSON.stringify(Object.fromEntries(results)));
    } catch (e) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: String(e) }));
    }
    return;
  }

  // What the cache is doing right now. Cheap enough to poll on its own, so the
  // panel stays live without re-fetching every account's daily series with it.
  if (url.pathname === '/api/cache') {
    const now = Date.now();
    const age = cache ? now - cacheAt : null;
    res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
    res.end(JSON.stringify({
      ...cacheReport({
        source: !cache ? 'empty' : age < CACHE_MS ? 'memory' : age < DISK_CACHE_MS ? 'disk' : 'stale',
        ageMs: age,
        stale: cache ? age >= DISK_CACHE_MS : false,
        refreshing: !!inflight,
      }),
      index: fileCaches.map((c) => ({ id: c.id, files: c.entries.size })),
    }));
    return;
  }

  // Derived view over the limit ledger: what one percent of each rate-limit
  // window actually costs in tokens and dollars, per cycle and pooled.
  if (url.pathname === '/api/limit-history') {
    try {
      const data = await limitHistory.analyze({
        maxStepsPerWindow: Number(url.searchParams.get('steps')) || 400,
      });
      res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
      res.end(JSON.stringify(data));
    } catch (e) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: String(e) }));
    }
    return;
  }

  // Raw ledger rows, for exporting or charting the series directly.
  if (url.pathname === '/api/limit-history/raw') {
    try {
      const acct = url.searchParams.get('account');
      const win = url.searchParams.get('window');
      const limit = Number(url.searchParams.get('limit')) || 5000;
      let rows = [
        ...(await limitHistory.readRows(limitHistory.BACKFILL_PATH)),
        ...(await limitHistory.readRows(limitHistory.LEDGER_PATH)),
      ];
      if (acct) rows = rows.filter((r) => r.acct === acct);
      if (win) rows = rows.filter((r) => r.win === win);
      rows.sort((a, b) => String(a.t).localeCompare(String(b.t)));
      res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
      res.end(JSON.stringify({ total: rows.length, rows: rows.slice(-limit) }));
    } catch (e) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: String(e) }));
    }
    return;
  }

  // Codex rollouts are the one local record of historical limit percentages,
  // so their replay is re-runnable on demand as new sessions accumulate.
  if (url.pathname === '/api/limit-history/backfill' && req.method === 'POST') {
    try {
      const state = await limitHistory.backfillCodex({});
      res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
      res.end(JSON.stringify(state));
    } catch (e) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: String(e) }));
    }
    return;
  }

  // Browsers commonly probe this path even when the page declares another
  // icon. Return an empty success response for stale clients instead of a
  // noisy 404; current clients use the SVG declared in index.html.
  if (url.pathname === '/favicon.ico') {
    res.writeHead(204, { 'Cache-Control': 'public, max-age=86400' });
    res.end();
    return;
  }

  let filePath = url.pathname === '/' ? '/index.html' : url.pathname;
  filePath = path.join(__dirname, 'public', filePath);
  if (!filePath.startsWith(path.join(__dirname, 'public'))) {
    res.writeHead(403);
    res.end('Forbidden');
    return;
  }

  try {
    const content = await readFile(filePath);
    const ext = path.extname(filePath);
    const type = {
      '.html': 'text/html',
      '.js': 'text/javascript',
      '.css': 'text/css',
      '.svg': 'image/svg+xml',
    }[ext] || 'text/plain';
    res.writeHead(200, { 'Content-Type': type, 'Cache-Control': 'no-store' });
    res.end(content);
  } catch {
    res.writeHead(404);
    res.end('Not found');
  }
});

// The ledger is only as good as its sampling rate, and a percentage that
// climbs while nobody has the dashboard open would otherwise be lost. Sampling
// on the same period as the disk cache keeps the series continuous without
// making the heavy session scans run any more often than a browser poll would.
const HISTORY_SAMPLE_MS = Number(process.env.LIMIT_HISTORY_SAMPLE_MS) || DISK_CACHE_MS;

function startHistorySampler() {
  if (process.env.LIMIT_HISTORY_SAMPLER === 'off') return;
  const timer = setInterval(() => {
    getUsage().catch((e) => console.error('limit-history: sampler failed:', e.message));
  }, HISTORY_SAMPLE_MS);
  timer.unref();
}

// Codex transcripts record a percentage after every single turn — far finer
// than this server's own sampling — so they stay the better record of Codex
// even while it runs. Replaying them periodically keeps that resolution.
const BACKFILL_REFRESH_MS = 6 * 60 * 60_000;

async function replayCodexHistory(reason) {
  try {
    const s = await limitHistory.backfillCodex({});
    console.log(`limit-history: ${reason} replayed ${s.rows} rows from ${s.files} Codex rollouts`);
  } catch (e) {
    console.error('limit-history: backfill failed:', e.message);
  }
}

// OpenCode appends all real-time UI/streaming events into the `event` table
// without an automatic retention policy, which causes `opencode.db` to grow
// into multiple gigabytes over time. The dashboard only needs `session` and
// `message` records for usage metrics. Pruning stale events and checkpointing
// the WAL keeps the database compact and healthy without losing usage data.
async function maintainOpencodeDatabases() {
  if (!DatabaseSync) return;
  try {
    const accounts = await detectAccounts();
    const opencodeAccounts = accounts.filter((a) => a.provider === 'opencode' && a.dbPath);
    for (const acct of opencodeAccounts) {
      let db;
      try {
        const s = await stat(acct.dbPath).catch(() => null);
        if (!s) continue;
        db = new DatabaseSync(acct.dbPath);
        db.exec(`
          DELETE FROM event;
          PRAGMA wal_checkpoint(TRUNCATE);
        `);
      } catch {
        // If DB is busy with an active OpenCode write, skip until the next maintenance cycle
      } finally {
        try { db?.close(); } catch {}
      }
    }
  } catch {}
}

if (require.main === module) {
  server.listen(PORT, HOST, async () => {
    console.log(`cc-usage-dashboard listening on http://${HOST}:${PORT}`);
    // Before the sampler or a browser can ask: a restored index turns the
    // first scan from a full re-parse into a few hundred stat calls.
    await primeScanIndex().catch(() => {});
    const state = await limitHistory.backfillState();
    const stale = !state || Date.now() - Date.parse(state.ranAt) > BACKFILL_REFRESH_MS;
    if (stale) replayCodexHistory('startup');
    maintainOpencodeDatabases();
    const timer = setInterval(() => {
      replayCodexHistory('scheduled');
      maintainOpencodeDatabases();
    }, BACKFILL_REFRESH_MS);
    timer.unref();
    startHistorySampler();
  });
}

module.exports = {
  detectAccounts,
  getUsage,
  cacheStatsFor,
  cacheRatesFor,
  parseAntigravityLocalStatus,
  postLocalLanguageServer,
  priceFolded,
  claudeBucketCost,
  codexBucketCost,
  claudeSessionCache,
  codexRolloutCache,
  maintainOpencodeDatabases,
  scanCodexSessions,
  scanClaudeSessions,
  codexTurnCost,
  formatCodexLocalRateLimits,
  server,
};
