const http = require('node:http');
const { exec, execFile } = require('node:child_process');
const { readFile, readdir, writeFile } = require('node:fs/promises');
const { existsSync } = require('node:fs');
const path = require('node:path');
const { detectProfileAccounts, getHomeDir } = require('./profile-discovery');

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
const LOCAL_CCUSAGE = path.join(__dirname, 'node_modules', '.bin', process.platform === 'win32' ? 'ccusage.cmd' : 'ccusage');
const CCUSAGE_BIN = process.env.CCUSAGE_BIN || (existsSync(LOCAL_CCUSAGE) ? LOCAL_CCUSAGE : (process.platform === 'win32' ? 'ccusage.cmd' : 'ccusage'));

// --- Account discovery -----------------------------------------------------
async function detectAccounts() {
  const accounts = await detectProfileAccounts();
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

async function readAntigravityAuth() {
  try {
    const auth = JSON.parse(await readFile(ANTIGRAVITY_AUTH_PATH, 'utf8'));
    const credentials = auth.antigravity;
    if (!credentials || (!credentials.access && !credentials.refresh)) return null;
    return { ...credentials, authPath: ANTIGRAVITY_AUTH_PATH };
  } catch {
    return null;
  }
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
  const cached = antigravityTokens.get(ANTIGRAVITY_AUTH_PATH);
  const expires = Number(credentials.expires || 0);
  if (credentials.access && expires > Date.now() + ANTIGRAVITY_TOKEN_EARLY_REFRESH_MS) {
    return credentials.access;
  }
  if (cached?.access && cached.expires > Date.now() + ANTIGRAVITY_TOKEN_EARLY_REFRESH_MS) {
    return cached.access;
  }
  const refreshed = await refreshAntigravityToken(credentials);
  antigravityTokens.set(ANTIGRAVITY_AUTH_PATH, refreshed);
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

async function getClaudeRateLimits(account, force = false) {
  if (!force) {
    return getCachedClaudeRateLimits(account);
  }
  const now = Date.now();
  if (now - (lastLiveAttemptAt.get(account.id) || 0) < LIMITS_REFRESH_BACKOFF_MS) {
    return getCachedClaudeRateLimits(account);
  }
  lastLiveAttemptAt.set(account.id, now);
  try {
    const raw = await readFile(path.join(account.configDir, '.credentials.json'), 'utf8');
    const accessToken = JSON.parse(raw).claudeAiOauth?.accessToken;
    if (!accessToken) throw new Error('no access token');
    return await fetchLiveClaudeRateLimits(accessToken);
  } catch {
    return getCachedClaudeRateLimits(account);
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
  return {
    fetchedAtMs: Date.now(),
    ageMinutes: 0,
    live: true,
    // primary_window is the weekly lane; secondary_window (5h session) is
    // only populated once you've actually hit that window this cycle.
    weekly: toEntry(u.rate_limit?.primary_window),
    session: toEntry(u.rate_limit?.secondary_window),
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
//   credits: { creditUsagePercent, currentPeriod:{end}, onDemand*, prepaidBalance, ... }
function grokRateLimitsFromConfigs(monthly = {}, credits = {}, { live = false, source = 'grok-billing', fetchedAtMs = Date.now() } = {}) {
  const monthlyLimit = grokVal(monthly.monthlyLimit) ?? grokVal(credits.monthlyLimit);
  const monthlyUsed = grokVal(monthly.used) ?? grokVal(credits.used) ?? grokVal(credits.includedUsed) ?? grokVal(credits.totalUsed);

  const weeklyBar = (() => {
    if (typeof credits.creditUsagePercent === 'number') {
      return {
        percent: Math.round(credits.creditUsagePercent),
        resetsAt: credits.currentPeriod?.end || credits.billingPeriodEnd || null,
      };
    }
    if (typeof monthly.creditUsagePercent === 'number') {
      return {
        percent: Math.round(monthly.creditUsagePercent),
        resetsAt: monthly.currentPeriod?.end || monthly.billingPeriodEnd || null,
      };
    }
    // productUsage sometimes carries per-product weekly % (Api / GrokBuild).
    const products = credits.productUsage || monthly.productUsage;
    if (Array.isArray(products) && products.length) {
      const build = products.find((p) => /grokbuild|build/i.test(p.product || '')) || products[0];
      if (typeof build?.usagePercent === 'number') {
        return {
          percent: Math.round(build.usagePercent),
          resetsAt: credits.currentPeriod?.end || credits.billingPeriodEnd || null,
        };
      }
    }
    if (credits.currentPeriod?.end || credits.billingPeriodEnd || monthly.currentPeriod?.end || monthly.billingPeriodEnd) {
      return {
        percent: null,
        resetsAt: credits.currentPeriod?.end || credits.billingPeriodEnd || monthly.currentPeriod?.end || monthly.billingPeriodEnd,
        windowOnly: true,
      };
    }
    return null;
  })();

  const monthlyBar = monthlyLimit != null && monthlyLimit > 0 && monthlyUsed != null
    ? {
        percent: Math.min(100, Math.round((monthlyUsed / monthlyLimit) * 100)),
        resetsAt: monthly.billingPeriodEnd || null,
        used: monthlyUsed,
        limit: monthlyLimit,
      }
    : null;

  // Grok: Monthly is primary (included credits pool), Weekly is secondary.
  // Map onto the dashboard's two slots as session=Monthly, weekly=Weekly so
  // the first bar is the monthly limit users care about most.
  const onDemandCap = grokVal(credits.onDemandCap) ?? grokVal(monthly.onDemandCap);
  const onDemandUsed = grokVal(credits.onDemandUsed) ?? grokVal(monthly.onDemandUsed) ?? 0;
  const prepaidBalance = grokVal(credits.prepaidBalance) ?? grokVal(monthly.prepaidBalance);

  return {
    fetchedAtMs,
    ageMinutes: Math.max(0, Math.round((Date.now() - fetchedAtMs) / 60000)),
    live,
    source,
    // Primary: monthly included pool (used / monthlyLimit)
    session: monthlyBar
      ? { percent: monthlyBar.percent, resetsAt: monthlyBar.resetsAt, label: 'Monthly', used: monthlyBar.used, limit: monthlyBar.limit }
      : null,
    // Secondary: weekly credit window (% used this week)
    weekly: weeklyBar && weeklyBar.percent != null
      ? { percent: weeklyBar.percent, resetsAt: weeklyBar.resetsAt, label: 'Weekly' }
      : weeklyBar && weeklyBar.windowOnly
        ? { percent: 0, resetsAt: weeklyBar.resetsAt, label: 'Weekly', windowOnly: true }
        : null,
    credits: prepaidBalance != null || onDemandCap != null || monthlyLimit != null
      ? {
          balance: prepaidBalance ?? 0,
          onDemandUsed,
          onDemandCap: onDemandCap ?? 0,
          monthlyUsed,
          monthlyLimit,
        }
      : null,
    subscriptionTier: credits.subscriptionTier || monthly.subscriptionTier || null,
  };
}

function grokLimitsComplete(limits) {
  // Complete when we have the monthly pool (session bar). Weekly alone is partial.
  return !!(limits && limits.session && limits.session.label === 'Monthly');
}

function mergeGrokLimits(primary, secondary) {
  if (!primary) return secondary || null;
  if (!secondary) return primary;
  return {
    ...secondary,
    ...primary,
    session: primary.session || secondary.session || null,
    weekly: primary.weekly || secondary.weekly || null,
    credits: primary.credits?.monthlyLimit != null ? primary.credits : (secondary.credits || primary.credits),
    subscriptionTier: primary.subscriptionTier || secondary.subscriptionTier || null,
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
      credits: limits.credits,
      subscriptionTier: limits.subscriptionTier,
      source: limits.source,
    }), 'utf8');
  } catch {}
}

async function readGrokLimitsSnapshot(accountId) {
  try {
    const raw = await readFile(grokLimitsSnapshotPath(accountId), 'utf8');
    const u = JSON.parse(raw);
    if (u.accountId !== accountId) return null;
    if (!u.session && !u.weekly) return null;
    return {
      fetchedAtMs: u.fetchedAtMs || Date.now(),
      ageMinutes: Math.round((Date.now() - (u.fetchedAtMs || Date.now())) / 60000),
      live: false,
      source: u.source || 'grok-snapshot',
      session: u.session || null,
      weekly: u.weekly || null,
      credits: u.credits || null,
      subscriptionTier: u.subscriptionTier || null,
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
    // If live monthly landed without weekly, stitch in CLI log weekly %.
    if (!fresh.weekly) {
      const fromLog = await getGrokLimitsFromCliLog(account.configDir);
      if (fromLog?.weekly) fresh = mergeGrokLimits(fresh, fromLog);
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

function runCcusage(args, env) {
  return new Promise((resolve, reject) => {
    execFile(CCUSAGE_BIN, args, {
      maxBuffer: 1024 * 1024 * 32,
      timeout: 30000,
      windowsHide: true,
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
  const today = sorted[sorted.length - 1];
  const last7 = sorted.slice(-7);
  const now = new Date();
  const thisMonthPrefix = now.toISOString().slice(0, 7);
  const thisMonth = sorted.filter((d) => (d.period ?? d.date).startsWith(thisMonthPrefix));

  return {
    today: { cost: today ? (today[costKey] ?? today.costUSD ?? 0) : 0, tokens: today ? sumTokens([today]) : 0 },
    last7d: { cost: sumCost(last7, costKey), tokens: sumTokens(last7) },
    month: { cost: sumCost(thisMonth, costKey), tokens: sumTokens(thisMonth) },
    allTime: { cost: sumCost(sorted, costKey), tokens: sumTokens(sorted) },
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
  const [claudeDailyRaw, rateLimits] = await Promise.all([
    runCcusage(['claude', 'daily', '--json', '-O'], { CLAUDE_CONFIG_DIR: account.configDir }).catch(() => ({ daily: [] })),
    getClaudeRateLimits(account, force),
  ]);
  const rawRows = claudeDailyRaw.daily || [];
  const section = summarize(claudeDailyRecomputed(rawRows), 'totalCost');
  section.rateLimits = rateLimits;
  section.models = claudeModelTable(rawRows);
  return section;
}

const PI_SESSIONS_DIR = path.join(HOME, '.pi', 'agent', 'sessions');

async function scanPiCodexSessions() {
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
        let content;
        try { content = await readFile(path.join(dirPath, file), 'utf8'); } catch { continue; }
        for (const line of content.split('\n')) {
          if (!line.includes('openai-codex') || !line.includes('"assistant"')) continue;
          let o;
          try { o = JSON.parse(line); } catch { continue; }
          if (o.type !== 'message' || o.message?.role !== 'assistant') continue;
          if (o.message?.provider !== 'openai-codex') continue;
          const u = o.message.usage;
          if (!u) continue;

          const date = (o.timestamp || o.message.timestamp || '').slice(0, 10);
          if (!date) continue;

          const modelName = o.message.model || 'gpt-5.6-luna';
          const costObj = u.cost || codexModelCost(modelName, {
            inputTokens: u.input,
            outputTokens: u.output,
            cacheReadTokens: u.cacheRead,
          }) || { total: 0, input: 0, output: 0, cacheRead: 0 };

          const totalCost = typeof costObj === 'number' ? costObj : (costObj.total ?? 0);
          const inputTok = u.input || 0;
          const outputTok = u.output || 0;
          const cacheReadTok = u.cacheRead || 0;
          const cacheWriteTok = u.cacheWrite || 0;
          const totTok = u.totalTokens || (inputTok + outputTok + cacheReadTok);

          const day = byDate.get(date) || { date, costUSD: 0, totalTokens: 0, unpriced: false };
          day.costUSD += totalCost;
          day.totalTokens += totTok;
          byDate.set(date, day);

          const cur = byModel.get(modelName) || blankBreakdown(modelName, 'OpenAI');
          cur.tokens.input += inputTok;
          cur.tokens.output += outputTok;
          cur.tokens.cacheRead += cacheReadTok;
          cur.tokens.cacheWrite += cacheWriteTok;
          cur.cost.input += costObj.input || 0;
          cur.cost.output += costObj.output || 0;
          cur.cost.cacheRead += costObj.cacheRead || 0;
          cur.cost.total += totalCost;
          byModel.set(modelName, cur);
        }
      }
    }
  } catch {}
  return { daily: [...byDate.values()], models: [...byModel.values()] };
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
  const [sessionsRaw, piUsage, rateLimits] = await Promise.all([
    runCcusage(['codex', 'session', '--json', '-O'], { CODEX_HOME: account.configDir }).catch(() => ({ sessions: [] })),
    scanPiCodexSessions(),
    getCodexRateLimits(account, force),
  ]);
  const sessions = sessionsRaw.sessions || sessionsRaw.session || [];
  const nativeDaily = codexDailyFromSessions(sessions);
  const nativeModels = modelTableFromCodexSessions(sessions);

  const mergedDaily = mergeCodexDaily(nativeDaily, piUsage.daily);
  const mergedModels = mergeCodexModels(nativeModels, piUsage.models);

  const section = summarize(mergedDaily, 'costUSD');
  section.rateLimits = rateLimits;
  section.models = mergedModels;
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
      let text;
      try {
        text = await readFile(updatesPath, 'utf8');
      } catch {
        continue;
      }
      for (const line of text.split('\n')) {
        if (!line.includes('turn_completed') || !line.includes('usage')) continue;
        let o;
        try { o = JSON.parse(line); } catch { continue; }
        const update = o?.params?.update;
        if (!update || update.sessionUpdate !== 'turn_completed' || !update.usage) continue;
        const usage = update.usage;
        let ts = o.timestamp;
        if (typeof ts === 'number' && ts > 1e12) ts = Math.floor(ts / 1000);
        if (typeof ts !== 'number') continue;
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
      }
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
  section.limitLabels = { session: 'Monthly', weekly: 'Weekly' };
  return section;
}

const ANTIGRAVITY_PRICING = {
  'gemini-3.6-flash': { input: 0.5, cachedInput: 0.125, output: 3.0 },
  'gemini-3.5-flash': { input: 0.5, cachedInput: 0.125, output: 3.0 },
  'gemini-3.1-pro': { input: 1.25, cachedInput: 0.3125, output: 5.0 },
  'claude-opus-4-6': { input: 15.0, cachedInput: 1.875, output: 75.0 },
  'claude-sonnet-4-6': { input: 3.0, cachedInput: 0.375, output: 15.0 },
  'gpt-oss-120b': { input: 1.0, cachedInput: 0.1, output: 6.0 },
};

function antigravityModelCost(modelName, u) {
  const base = modelName.replace(/-\d{4}-\d{2}-\d{2}$/, '');
  const r = ANTIGRAVITY_PRICING[base] || { input: 0.5, cachedInput: 0.125, output: 3.0 };
  return {
    input: ((u.input || 0) * r.input) / 1_000_000,
    output: ((u.output || 0) * r.output) / 1_000_000,
    cacheWrite: 0,
    cacheRead: ((u.cacheRead || 0) * r.cachedInput) / 1_000_000,
  };
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
        let content;
        try { content = await readFile(path.join(dirPath, file), 'utf8'); } catch { continue; }
        for (const line of content.split('\n')) {
          if (!line.includes('antigravity') || !line.includes('"assistant"')) continue;
          let o;
          try { o = JSON.parse(line); } catch { continue; }
          if (o.type !== 'message' || o.message?.role !== 'assistant') continue;
          if (o.message?.provider !== 'antigravity') continue;
          const u = o.message.usage;
          if (!u) continue;

          const date = (o.timestamp || o.message.timestamp || '').slice(0, 10);
          if (!date) continue;

          const modelName = o.message.model || 'gemini-3.6-flash';
          const cost = antigravityModelCost(modelName, u);
          const totalCost = cost.input + cost.output + cost.cacheRead;

          const inputTok = u.input || 0;
          const outputTok = u.output || 0;
          const cacheReadTok = u.cacheRead || 0;
          const cacheWriteTok = u.cacheWrite || 0;
          const totTok = u.totalTokens || (inputTok + outputTok + cacheReadTok);

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
        }
      }
    }
  } catch {}
  return {
    daily: [...byDate.values()].sort((a, b) => a.date.localeCompare(b.date)),
    models: [...byModel.values()].sort((a, b) => b.cost.total - a.cost.total),
  };
}

async function getAntigravityAccountUsage(account, force) {
  const [rateLimits, piUsage] = await Promise.all([
    getAntigravityRateLimits(account, force),
    scanPiAntigravitySessions(),
  ]);
  const section = summarize(piUsage.daily, 'costUSD');
  section.rateLimits = rateLimits;
  section.models = piUsage.models;
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

function scanOpencodeSessions(dbPath) {
  if (!DatabaseSync) return { daily: [], models: [] };
  const byDate = new Map();
  const byModel = new Map();
  let db;
  try {
    db = new DatabaseSync(dbPath, { readOnly: true });
    const rows = db
      .prepare(
        'SELECT id, model, agent, cost, tokens_input, tokens_output, tokens_reasoning, tokens_cache_read, tokens_cache_write, time_created FROM session',
      )
      .all();
    const messageRows = db.prepare(`
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
    `).all();
    const messageUsage = new Map();
    for (const m of messageRows) {
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
    for (const r of rows) {
      let ts = Number(r.time_created);
      if (!ts || !Number.isFinite(ts)) continue;
      // Older rows are unix seconds; newer ones are milliseconds.
      if (ts > 1e12) ts = Math.floor(ts / 1000);
      const date = new Date(ts * 1000).toISOString().slice(0, 10);
      const parsedModel = parseOpencodeModel(r.model);
      const modelName = parsedModel?.id || r.agent || 'unknown';
      const providerID = parsedModel?.providerID || 'unknown';
      const cost = Number(r.cost) || 0;
      const input = Number(r.tokens_input) || 0;
      const output = Number(r.tokens_output) || 0;
      const reasoning = Number(r.tokens_reasoning) || 0;
      const cacheWrite = Number(r.tokens_cache_write) || 0;
      const cacheRead = Number(r.tokens_cache_read) || 0;
      const totalTokens = input + output + reasoning + cacheWrite + cacheRead;

      const day = byDate.get(date) || { date, costUSD: 0, totalTokens: 0, unpriced: false };
      day.costUSD += cost;
      day.totalTokens += totalTokens;
      byDate.set(date, day);

      const sessionTokens = input + output + reasoning + cacheWrite + cacheRead;
      const messageModels = parsedModel
        ? [{ modelName, providerID, input, output, reasoning, cacheRead, cacheWrite }]
        : [...messageUsage.values()].filter((m) => m.sessionID === r.id);
      const parts = messageModels.length ? messageModels : [{ modelName, providerID, input, output, reasoning, cacheRead, cacheWrite }];
      for (const part of parts) {
        const partTokens = part.input + part.output + part.reasoning + part.cacheRead + part.cacheWrite;
        const costShare = sessionTokens ? cost * (partTokens / sessionTokens) : cost / parts.length;
        const modelKey = `${part.providerID}::${part.modelName}`;
        const cur = byModel.get(modelKey) || blankBreakdown(part.modelName, providerOf(part.modelName));
        cur.provider = opencodeProviderName(part.providerID);
        cur.route = part.providerID;
        cur.tokens.input += part.input;
        cur.tokens.output += part.output;
        cur.tokens.reasoning = (cur.tokens.reasoning || 0) + part.reasoning;
        cur.tokens.cacheRead += part.cacheRead;
        cur.tokens.cacheWrite += part.cacheWrite;
        cur.cost.total += costShare;
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

async function getUsage() {
  const now = Date.now();
  if (cache && now - cacheAt < CACHE_MS) return cache;

  const accounts = await detectAccounts();
  const results = await Promise.all(accounts.map((a) => getAccountUsage(a, false)));

  cache = { accounts: results, fetchedAt: new Date().toISOString() };
  cacheAt = now;
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
      cache = null; // invalidate so the next /api/usage poll picks these up too
      res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
      res.end(JSON.stringify(Object.fromEntries(results)));
    } catch (e) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: String(e) }));
    }
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
    const type = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css' }[ext] || 'text/plain';
    res.writeHead(200, { 'Content-Type': type, 'Cache-Control': 'no-store' });
    res.end(content);
  } catch {
    res.writeHead(404);
    res.end('Not found');
  }
});

server.listen(PORT, HOST, () => {
  console.log(`cc-usage-dashboard listening on http://${HOST}:${PORT}`);
});
