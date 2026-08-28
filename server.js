const http = require('node:http');
const { exec, execFile } = require('node:child_process');
const { readFile, readdir, stat, writeFile } = require('node:fs/promises');
const { existsSync, createReadStream } = require('node:fs');
const readline = require('node:readline');
const path = require('node:path');
const { detectProfileAccounts, getHomeDir, isProviderDisabled } = require('./profile-discovery');
const { resolveCcusageCommand, runCcusage: runCcusageCommand } = require('./ccusage-runner');
const limitHistory = require('./limit-history');

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
const HOME = getHomeDir();
const DATA_HOME = process.env.XDG_DATA_HOME || (process.platform === 'win32'
  ? path.join(HOME, 'AppData', 'Local')
  : process.platform === 'darwin'
    ? path.join(HOME, 'Library', 'Application Support')
    : path.join(HOME, '.local', 'share'));
const OPENCODE_DB = process.env.OPENCODE_DB || path.join(DATA_HOME, 'opencode', 'opencode.db');
const ANTIGRAVITY_DATA_DIR = process.env.ANTIGRAVITY_DATA_DIR
  || path.join(HOME, '.gemini', 'antigravity-cli');
const CCUSAGE_BIN = resolveCcusageCommand();

// --- Account discovery -----------------------------------------------------
async function detectAccounts() {
  const discovered = await detectProfileAccounts();
  const activeClaude = await selectActiveClaudeAccount(discovered);
  const accounts = discovered.filter((account) => account.provider !== 'claude');
  if (activeClaude) accounts.push(activeClaude);
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
  try {
    await readFile(OPENCODE_DB);
    accounts.push({ id: 'opencode-default', provider: 'opencode', label: 'default', dbPath: OPENCODE_DB });
  } catch {}
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
const ANTIGRAVITY_AUTH_PATH = process.env.PI_AUTH_PATH || path.join(HOME, '.pi', 'agent', 'auth.json');
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

const ANTIGRAVITY_CLI_TOKEN_PATH = process.env.ANTIGRAVITY_CLI_TOKEN_PATH
  || path.join(ANTIGRAVITY_DATA_DIR, 'antigravity-oauth-token');

async function readAntigravityAuth() {
  // Primary: Pi agent auth store (has { antigravity: { access, refresh, expires } })
  try {
    const auth = JSON.parse(await readFile(ANTIGRAVITY_AUTH_PATH, 'utf8'));
    const credentials = auth.antigravity;
    if (credentials && (credentials.access || credentials.refresh)) {
      return { ...credentials, authPath: ANTIGRAVITY_AUTH_PATH };
    }
  } catch { /* fall through */ }

  // Fallback: AGY CLI token file ({ token: { access_token, refresh_token, expiry }, auth_method })
  try {
    const raw = JSON.parse(await readFile(ANTIGRAVITY_CLI_TOKEN_PATH, 'utf8'));
    const tok = raw.token || {};
    if (!tok.access_token && !tok.refresh_token) return null;
    return {
      access: tok.access_token || null,
      refresh: tok.refresh_token || null,
      expires: tok.expiry ? Date.parse(tok.expiry) : 0,
      authPath: ANTIGRAVITY_CLI_TOKEN_PATH,
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
      lastError = `${pathname} ${res.status}`;
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

async function getAntigravityRateLimits(account, force = false) {
  const now = Date.now();
  const cached = antigravityLimits.get(account.id);
  if (!force && cached && now - cached.at < ANTIGRAVITY_LIVE_REFRESH_MS) {
    return { ...cached.value, ageMinutes: Math.round((now - cached.at) / 60000) };
  }
  if (!force && now - (lastAntigravityLiveAttemptAt.get(account.id) || 0) < ANTIGRAVITY_LIVE_REFRESH_MS) {
    return cached ? cached.value : null;
  }
  lastAntigravityLiveAttemptAt.set(account.id, now);
  try {
    const token = await getAntigravityAccessToken();
    const fresh = await fetchLiveAntigravityRateLimits(token);
    antigravityLimits.set(account.id, { value: fresh, at: now });
    return fresh;
  } catch {
    return cached ? cached.value : null;
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
  if (!force) {
    if (cached && now - cached.at < LIMITS_REFRESH_BACKOFF_MS) {
      return { ...cached.value, ageMinutes: Math.round((now - cached.at) / 60000) };
    }
    if (now - (lastCodexLiveAttemptAt.get(account.id) || 0) < LIMITS_REFRESH_BACKOFF_MS) {
      return cached ? cached.value : null;
    }
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

  // Serve a complete in-memory cache (has monthly) within the backoff window.
  // Incomplete caches (weekly-only from CLI log) must not block a live retry.
  if (!force && cached && grokLimitsComplete(cached.value) && now - cached.at < GROK_LIVE_REFRESH_MS) {
    return { ...cached.value, ageMinutes: Math.round((now - cached.at) / 60000) };
  }
  if (!force && cached && now - (lastGrokLiveAttemptAt.get(account.id) || 0) < GROK_LIVE_REFRESH_MS) {
    return { ...cached.value, ageMinutes: Math.round((now - (cached.value.fetchedAtMs || now)) / 60000) };
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

function codexModelCost(modelName, v) {
  // ccusage session/daily JSON reports cacheCreationTokens as 0 for Codex
  // (OpenAI auto-caches, no separate write charge) and cacheReadTokens as
  // the cached-input count; inputTokens is fresh (uncached) input.
  const rates = CODEX_PRICING[modelName.replace(/-\d{4}-\d{2}-\d{2}$/, '')];
  if (!rates) return null; // unknown model — surfaced as null so the UI can flag it instead of silently showing $0
  return {
    input: ((v.inputTokens || 0) * rates.input) / 1_000_000,
    output: ((v.outputTokens || 0) * rates.output) / 1_000_000,
    cacheWrite: 0,
    cacheRead: ((v.cacheReadTokens || 0) * rates.cachedInput) / 1_000_000,
  };
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

async function getClaudeAccountUsage(account, force) {
  let claudeDailyRaw = { daily: [] };
  let usageError = null;
  const [dailyResult, rateLimits] = await Promise.all([
    runCcusage(['claude', 'daily', '--json', '-O'], { CLAUDE_CONFIG_DIR: account.configDir })
      .then((value) => ({ value }))
      .catch((error) => ({ error })),
    getClaudeRateLimits(account, force),
  ]);
  if (dailyResult.error) {
    usageError = dailyResult.error.message;
    console.warn(`cc-usage-dashboard: Claude token scan failed: ${usageError}`);
  } else {
    claudeDailyRaw = dailyResult.value;
  }
  const rawRows = claudeDailyRaw.daily || [];
  const section = summarize(claudeDailyRecomputed(rawRows), 'totalCost');
  section.rateLimits = rateLimits;
  section.models = claudeModelTable(rawRows);
  if (usageError) section.usageError = usageError;
  return section;
}

const PI_SESSIONS_DIR = path.join(HOME, '.pi', 'agent', 'sessions');
const PRIME_SESSIONS_DIR = path.join(HOME, '.prime', 'agent', 'sessions');

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
    ['Pi', PI_SESSIONS_DIR],
    ['Prime Agent', PRIME_SESSIONS_DIR],
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

async function getCodexAccountUsage(account, force) {
  const [sessionsResult, harnessUsage, rateLimits] = await Promise.all([
    runCcusage(['codex', 'session', '--json', '-O'], { CODEX_HOME: account.configDir })
      .then((value) => ({ value }))
      .catch((error) => ({ error })),
    scanCodexHarnessSessions(),
    getCodexRateLimits(account, force),
  ]);
  const sessionsRaw = sessionsResult.value || { sessions: [] };
  const sessions = sessionsRaw.sessions || sessionsRaw.session || [];
  const nativeDaily = codexDailyFromSessions(sessions);
  const nativeModels = modelTableFromCodexSessions(sessions);

  const mergedDaily = mergeCodexDaily(nativeDaily, harnessUsage.daily);
  const mergedModels = mergeCodexModels(nativeModels, harnessUsage.models);

  const section = summarize(mergedDaily, 'costUSD');
  section.rateLimits = rateLimits;
  section.models = mergedModels;
  section.usageSources = ['Codex CLI'];
  for (const [source, count] of Object.entries(harnessUsage.sourceCounts)) {
    if (count) section.usageSources.push(`${source} (${count} Codex responses)`);
  }
  if (sessionsResult.error) {
    section.usageError = sessionsResult.error.message;
    console.warn(`cc-usage-dashboard: Codex token scan failed: ${section.usageError}`);
  }
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

async function scanNativeAntigravitySessions() {
  if (!DatabaseSync) return { daily: [], models: [] };
  const conversationsDir = path.join(ANTIGRAVITY_DATA_DIR, 'conversations');
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

async function scanPiAntigravitySessions() {
  const byDate = new Map();
  const byModel = new Map();
  try {
    const projDirs = await readdir(PI_SESSIONS_DIR, { withFileTypes: true });
    for (const pDir of projDirs) {
      if (!pDir.isDirectory()) continue;
      const dirPath = path.join(PI_SESSIONS_DIR, pDir.name);
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

async function getAntigravityAccountUsage(account, force) {
  const [rateLimits, piUsage, nativeUsage] = await Promise.all([
    getAntigravityRateLimits(account, force),
    scanPiAntigravitySessions(),
    scanNativeAntigravitySessions(),
  ]);
  const usage = mergeAntigravityUsage(piUsage, nativeUsage);
  const section = summarize(usage.daily, 'costUSD');
  section.rateLimits = rateLimits;
  section.models = usage.models;
  section.planLabel = rateLimits?.planLabel || null;
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

function scanOpencodeSessions(dbPath) {
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

async function getOpencodeAccountUsage(account, force) {
  const scanned = await scanOpencodeSessions(account.dbPath);
  const section = summarize(scanned.daily, 'costUSD');
  section.rateLimits = null;
  section.models = scanned.models;
  section.planLabel = null;
  return section;
}


async function getAccountUsage(account, force) {
  let section;
  if (account.provider === 'claude') section = await getClaudeAccountUsage(account, force);
  else if (account.provider === 'codex') section = await getCodexAccountUsage(account, force);
  else if (account.provider === 'grok') section = await getGrokAccountUsage(account, force);
  else if (account.provider === 'antigravity') section = await getAntigravityAccountUsage(account, force);
  else if (account.provider === 'opencode') section = await getOpencodeAccountUsage(account, force);
  else throw new Error(`unknown provider ${account.provider}`);
  return { id: account.id, provider: account.provider, label: account.label, ...section };
}

let cache = null;
let cacheAt = 0;
const CACHE_MS = 30_000;
// Heavy scans (Grok's sessions dir alone is >1GB) rerun as little as possible:
// the in-memory cache deals with rapid polls, the disk cache survives restarts
// and stops the poll loop from rescanning everything more than every 5 minutes.
const DISK_CACHE_MS = 5 * 60_000;
const DISK_CACHE_VERSION = 2;
const DISK_CACHE_PATH = path.join(__dirname, 'usage-cache.json');

async function loadDiskCache() {
  if (!existsSync(DISK_CACHE_PATH)) return null;
  try {
    const raw = await readFile(DISK_CACHE_PATH, 'utf8');
    const data = JSON.parse(raw);
    if (!data || data.cacheVersion !== DISK_CACHE_VERSION || !Array.isArray(data.accounts)) return null;
    data.accounts = data.accounts.filter((account) => !isProviderDisabled(account.provider));
    if (Date.now() - Date.parse(data.fetchedAt) > DISK_CACHE_MS) return null;
    return data;
  } catch {
    return null;
  }
}

function saveDiskCache(value) {
  writeFile(DISK_CACHE_PATH, JSON.stringify(value), 'utf8').catch(() => {});
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

async function getUsage() {
  const now = Date.now();
  if (cache && now - cacheAt < CACHE_MS) return cache;
  if (!cache || now - cacheAt >= CACHE_MS) {
    const disk = await loadDiskCache();
    if (disk) {
      cache = disk;
      cacheAt = now;
      noteHistory(disk);
      return cache;
    }
  }

  const accounts = await detectAccounts();
  // Sequential, not Promise.all: heavy scans (multi-GB session dirs, ccusage
  // children parsing the Codex/Claude histories) must never overlap, or their
  // page-cache and heap charges would stack into the gigabytes.
  const results = [];
  for (const account of accounts) {
    results.push(await getAccountUsage(account, false));
  }

  cache = { cacheVersion: DISK_CACHE_VERSION, accounts: results, fetchedAt: new Date().toISOString() };
  cacheAt = now;
  saveDiskCache(cache);
  noteHistory(cache);
  return cache;
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);

  if (url.pathname === '/api/usage') {
    try {
      const data = await getUsage();
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

server.listen(PORT, HOST, async () => {
  console.log(`cc-usage-dashboard listening on http://${HOST}:${PORT}`);
  const state = await limitHistory.backfillState();
  const stale = !state || Date.now() - Date.parse(state.ranAt) > BACKFILL_REFRESH_MS;
  if (stale) replayCodexHistory('startup');
  const timer = setInterval(() => replayCodexHistory('scheduled'), BACKFILL_REFRESH_MS);
  timer.unref();
  startHistorySampler();
});
