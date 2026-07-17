const http = require('node:http');
const { exec } = require('node:child_process');
const { readFile, readdir } = require('node:fs/promises');
const path = require('node:path');

const PORT = process.env.PORT || 47291;
const HOST = '127.0.0.1';
const HOME = process.env.HOME;

// --- Account discovery -----------------------------------------------------
// Any top-level ~/.claude* directory that contains .claude.json is a real
// Claude account (catches ~/.claude, ~/.claude-personal, ~/.claude-work,
// aliases like claude-p just point CLAUDE_CONFIG_DIR at one of these).
// Deliberately NOT keyed on .credentials.json: Claude Code stores the OAuth
// token in the OS keyring when one is available and only falls back to that
// plaintext file otherwise, so an account can be fully real and active with
// no credentials file on disk at all. Its absence just means the live
// rate-limit refresh silently has nothing to read (handled separately) —
// it doesn't mean the account isn't there.
// Same idea for ~/.codex* + auth.json. Re-scanned on every server start, so
// a newly-added account shows up on the next restart with zero config.
async function detectAccounts() {
  let entries;
  try {
    entries = await readdir(HOME, { withFileTypes: true });
  } catch {
    return [];
  }
  const accounts = [];
  for (const e of entries) {
    if (!e.isDirectory()) continue;
    const dir = path.join(HOME, e.name);
    if (/^\.claude(-.*)?$/.test(e.name)) {
      try {
        await readFile(path.join(dir, '.claude.json'));
        const label = e.name === '.claude' ? 'default' : e.name.replace(/^\.claude-/, '');
        accounts.push({ id: `claude-${label}`, provider: 'claude', label, configDir: dir });
      } catch {}
    } else if (/^\.codex(-.*)?$/.test(e.name)) {
      try {
        await readFile(path.join(dir, 'auth.json'));
        const label = e.name === '.codex' ? 'default' : e.name.replace(/^\.codex-/, '');
        accounts.push({ id: `codex-${label}`, provider: 'codex', label, configDir: dir });
      } catch {}
    }
  }
  return accounts;
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
  return 'Other';
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
// (developers.openai.com/api/docs/pricing, checked 2026-07-17) = real cost.
const CODEX_PRICING = {
  // input / cachedInput / output, $ per million tokens
  'gpt-5.6-sol': { input: 5, cachedInput: 0.5, output: 30 },
  'gpt-5.6-terra': { input: 2.5, cachedInput: 0.25, output: 15 },
  'gpt-5.6-luna': { input: 1, cachedInput: 0.1, output: 6 },
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
    run('ccusage claude daily --json -O', { CLAUDE_CONFIG_DIR: account.configDir }).catch(() => ({ daily: [] })),
    getClaudeRateLimits(account, force),
  ]);
  const rawRows = claudeDailyRaw.daily || [];
  const section = summarize(claudeDailyRecomputed(rawRows), 'totalCost');
  section.rateLimits = rateLimits;
  section.models = claudeModelTable(rawRows);
  return section;
}

async function getCodexAccountUsage(account, force) {
  const [sessionsRaw, rateLimits] = await Promise.all([
    run('ccusage codex session --json -O', { CODEX_HOME: account.configDir }).catch(() => ({ sessions: [] })),
    getCodexRateLimits(account, force),
  ]);
  const sessions = sessionsRaw.sessions || sessionsRaw.session || [];
  const section = summarize(codexDailyFromSessions(sessions), 'costUSD');
  section.rateLimits = rateLimits;
  section.models = modelTableFromCodexSessions(sessions);
  return section;
}

async function getAccountUsage(account, force) {
  const section = account.provider === 'claude'
    ? await getClaudeAccountUsage(account, force)
    : await getCodexAccountUsage(account, force);
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
        const rateLimits = a.provider === 'claude'
          ? await getClaudeRateLimits(a, true)
          : await getCodexRateLimits(a, true);
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
