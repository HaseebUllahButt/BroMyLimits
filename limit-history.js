'use strict';

// --- Limit history ledger ----------------------------------------------------
//
// The dashboard already knows two things at any instant: how many tokens/dollars
// an account has burned in total, and what percentage of its rate-limit windows
// it has consumed. Neither on its own answers the question this module exists
// for: *how much usage does one percent of the limit actually buy?*
//
// The answer only falls out of a time series. So every observation is appended
// to an append-only JSONL ledger as {percent, cumulative tokens, cumulative
// cost}; the exchange rate is then the slope between two rows inside the same
// limit window ("cycle"). Cumulative counters are used rather than deltas so a
// missed sample degrades into a wider interval instead of lost usage.
//
// Two sources feed the ledger:
//   * live   — sampled from /api/usage while the server runs (all providers)
//   * backfill — reconstructed from Codex rollout transcripts, which are the
//                only local artefacts that recorded rate-limit percentages
//                historically. Claude/Grok/Antigravity keep no such record, so
//                their series necessarily starts the first time this runs.

const { appendFile, readFile, writeFile, readdir } = require('node:fs/promises');
const { existsSync, createReadStream } = require('node:fs');
const readline = require('node:readline');
const path = require('node:path');

const LEDGER_PATH = path.join(__dirname, 'limit-history.jsonl');
const BACKFILL_PATH = path.join(__dirname, 'limit-history-backfill.jsonl');
const BACKFILL_STATE_PATH = path.join(__dirname, 'limit-history-backfill.state.json');

const SCHEMA_VERSION = 1;

// Providers report reset timestamps with a few seconds of jitter between
// requests, so the same weekly window arrives as several distinct values.
// Rounding to 5 minutes collapses that jitter without merging real windows.
const CYCLE_BUCKET_MS = 5 * 60_000;

function slug(text) {
  return String(text || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '') || 'window';
}

function cycleIdFor(resetsAt) {
  if (!resetsAt) return 'open';
  const ms = Date.parse(resetsAt);
  if (!Number.isFinite(ms)) return 'open';
  return new Date(Math.round(ms / CYCLE_BUCKET_MS) * CYCLE_BUCKET_MS).toISOString();
}

// Flattens each provider's differently-shaped rateLimits object into a single
// list of {key, label, percent, resetsAt}. Providers that expose a `windows`
// array (Grok, Antigravity) already enumerate every bucket; the others carry
// discrete `session`/`weekly` fields.
function normalizeWindows(rateLimits) {
  if (!rateLimits) return [];
  const out = [];
  const push = (key, label, w) => {
    if (!w || typeof w.percent !== 'number' || !Number.isFinite(w.percent)) return;
    out.push({ key, label, percent: w.percent, resetsAt: w.resetsAt || null });
  };
  if (Array.isArray(rateLimits.windows) && rateLimits.windows.length) {
    for (const w of rateLimits.windows) {
      // Antigravity's labels are phrased as remaining quota ("Gemini · Weekly
      // Remaining") while `percent` is consumed quota, like every other
      // provider. The ledger stores consumption, so the wording is dropped
      // rather than left to contradict the number filed under it.
      const label = String(w.label || 'Window').replace(/\s*Remaining$/i, '');
      push(slug(label), label, w);
    }
    return out;
  }
  push('session', 'Session (5h)', rateLimits.session);
  push('weekly', 'Weekly', rateLimits.weekly);
  return out;
}

// --- writing -----------------------------------------------------------------

// Last row written per acct|win, so unchanged observations are not re-appended.
const lastWritten = new Map();
let ledgerPrimed = false;

async function primeLedger() {
  if (ledgerPrimed) return;
  ledgerPrimed = true;
  for (const row of await readRows(LEDGER_PATH)) {
    lastWritten.set(`${row.acct}|${row.win}`, row);
  }
}

const HEARTBEAT_MS = 30 * 60_000;

function materiallyDifferent(prev, next) {
  if (!prev) return true;
  // The percentage is what the ledger exists to track, so every tick of it is
  // recorded along with the counters standing at that moment. Token counters
  // move on almost every sample, but rows that carry only a counter change add
  // nothing the cycle endpoints do not already capture — recording them would
  // grow the file by megabytes a week for no extra resolution.
  if (prev.pct !== next.pct) return true;
  if (prev.cycle !== next.cycle) return true;
  // A changed login mid-window is exactly the event worth having on record.
  if (prev.who !== next.who) return true;
  // A heartbeat keeps long idle stretches visible as flat time rather than as
  // a gap, and re-anchors the counters if a percentage never moves.
  return Date.parse(next.t) - Date.parse(prev.t) > HEARTBEAT_MS;
}

/**
 * Append one ledger row per (account, limit window) from a /api/usage payload.
 * Returns the rows actually written.
 */
async function recordSnapshot(usage) {
  await primeLedger();
  // `t` is when the observation was made, not when the usage scan behind it
  // ran: limit percentages refresh far more often than the heavy token scans,
  // so the two are recorded separately rather than letting a cached scan
  // backdate a percentage that just changed.
  const t = new Date().toISOString();
  const dataAt = usage?.fetchedAt || t;
  const rows = [];
  for (const acct of usage?.accounts || []) {
    const windows = normalizeWindows(acct.rateLimits);
    if (!windows.length) continue;
    const tok = acct?.allTime?.tokens;
    const cost = acct?.allTime?.cost;
    if (typeof tok !== 'number' || typeof cost !== 'number') continue;
    for (const w of windows) {
      const row = {
        v: SCHEMA_VERSION,
        t,
        dataAt,
        src: 'live',
        acct: acct.id,
        provider: acct.provider,
        win: w.key,
        label: w.label,
        pct: w.percent,
        resetsAt: w.resetsAt,
        cycle: cycleIdFor(w.resetsAt),
        tok,
        cost,
        // Which login produced this reading, where the provider exposes one. A
        // profile survives a re-authentication, so this is the only thing that
        // distinguishes readings taken before and after one.
        ...(acct.rateLimits.accountUuid ? { who: acct.rateLimits.accountUuid } : {}),
      };
      const key = `${row.acct}|${row.win}`;
      if (!materiallyDifferent(lastWritten.get(key), row)) continue;
      lastWritten.set(key, row);
      rows.push(row);
    }
  }
  if (rows.length) {
    await appendFile(LEDGER_PATH, rows.map((r) => JSON.stringify(r)).join('\n') + '\n', 'utf8');
    invalidateAnalyzeCache();
  }
  return rows;
}

// --- reading -----------------------------------------------------------------

async function readRows(filePath) {
  if (!existsSync(filePath)) return [];
  const rows = [];
  const rl = readline.createInterface({ input: createReadStream(filePath), crlfDelay: Infinity });
  for await (const line of rl) {
    if (!line) continue;
    try {
      const row = JSON.parse(line);
      if (row && typeof row.pct === 'number') rows.push(row);
    } catch {
      // A torn final line from a crash mid-append: skip it, keep the rest.
    }
  }
  return rows;
}

async function allRows() {
  const [live, back] = await Promise.all([readRows(LEDGER_PATH), readRows(BACKFILL_PATH)]);
  return [...back, ...live];
}

// --- Codex backfill ----------------------------------------------------------
//
// Codex writes a `token_count` event after every model turn carrying both the
// turn's token usage and the account's rate-limit percentages, so the whole
// history can be replayed out of ~/.codex/sessions. Rollout files are grouped
// per session but sessions interleave in time, so events are collected across
// all files and sorted globally before the cumulative counters are built.

const CODEX_PRICING = {
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

function codexTurnCost(modelName, usage) {
  const rates = CODEX_PRICING[String(modelName || '').replace(/-\d{4}-\d{2}-\d{2}$/, '')];
  if (!rates) return 0;
  const cached = usage.cached_input_tokens || 0;
  const fresh = Math.max(0, (usage.input_tokens || 0) - cached);
  return (
    (fresh * rates.input) / 1e6 +
    (cached * rates.cachedInput) / 1e6 +
    ((usage.output_tokens || 0) * rates.output) / 1e6
  );
}

async function codexRolloutFiles(root) {
  const found = [];
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
      else if (e.isFile() && e.name.endsWith('.jsonl')) found.push(full);
    }
  }
  await walk(root);
  return found.sort();
}

async function scanCodexRollout(filePath) {
  const events = [];
  let model = null;
  const rl = readline.createInterface({ input: createReadStream(filePath), crlfDelay: Infinity });
  for await (const line of rl) {
    // Cheap prefilter: only two event kinds matter and both are rare relative
    // to the message bodies that dominate these files.
    if (!line || (!line.includes('"token_count"') && !line.includes('"turn_context"'))) continue;
    let d;
    try {
      d = JSON.parse(line);
    } catch {
      continue;
    }
    const p = d.payload || {};
    // Rollouts tag the record kind on the envelope (`d.type`) and only
    // sometimes repeat it inside the payload, so both are checked before the
    // model is read — missing it would silently price every turn at $0.
    if (d.type === 'turn_context' || p.type === 'turn_context') {
      if (p.model) model = p.model;
      continue;
    }
    if (p.type !== 'token_count') continue;
    const usage = (p.info || {}).last_token_usage || {};
    const limits = p.rate_limits || {};
    events.push({
      t: d.timestamp || null,
      model,
      tokens: usage.total_tokens || 0,
      cost: codexTurnCost(model, usage),
      primary: limits.primary || null,
      secondary: limits.secondary || null,
    });
  }
  return events;
}

function windowLabelFor(minutes) {
  if (!minutes) return 'Limit';
  if (minutes >= 10080) return 'Weekly';
  if (minutes >= 1440) return `${Math.round(minutes / 1440)}d`;
  return `${Math.round(minutes / 60)}h`;
}

/**
 * Replay Codex rollout transcripts into backfill ledger rows. Rewrites
 * BACKFILL_PATH wholesale — it is derived data and always reproducible.
 */
async function backfillCodex({ sessionsDir, accountId = 'codex-default' } = {}) {
  const root = sessionsDir || path.join(require('node:os').homedir(), '.codex', 'sessions');
  const files = await codexRolloutFiles(root);
  const events = [];
  for (const f of files) {
    try {
      events.push(...(await scanCodexRollout(f)));
    } catch {
      // Unreadable or truncated rollout: skip the file, keep the rest.
    }
  }
  events.sort((a, b) => String(a.t).localeCompare(String(b.t)));

  let tok = 0;
  let cost = 0;
  const rows = [];
  const last = new Map();
  for (const e of events) {
    tok += e.tokens;
    cost += e.cost;
    if (!e.t) continue;
    const windows = [];
    if (e.primary && typeof e.primary.used_percent === 'number') {
      windows.push({
        key: e.primary.window_minutes >= 10080 ? 'weekly' : 'session',
        label: windowLabelFor(e.primary.window_minutes),
        pct: e.primary.used_percent,
        resetsAt: e.primary.resets_at ? new Date(e.primary.resets_at * 1000).toISOString() : null,
      });
    }
    if (e.secondary && typeof e.secondary.used_percent === 'number') {
      windows.push({
        key: e.secondary.window_minutes >= 10080 ? 'weekly-secondary' : 'session',
        label: windowLabelFor(e.secondary.window_minutes),
        pct: e.secondary.used_percent,
        resetsAt: e.secondary.resets_at ? new Date(e.secondary.resets_at * 1000).toISOString() : null,
      });
    }
    for (const w of windows) {
      const row = {
        v: SCHEMA_VERSION,
        t: e.t,
        src: 'backfill',
        acct: accountId,
        provider: 'codex',
        win: w.key,
        label: w.label,
        pct: w.pct,
        resetsAt: w.resetsAt,
        cycle: cycleIdFor(w.resetsAt),
        tok,
        cost: Number(cost.toFixed(6)),
      };
      const key = `${row.acct}|${row.win}`;
      const prev = last.get(key);
      // Every turn emits identical limits until the percentage ticks, so keep
      // only rows that move the percentage, the cycle, or the counters.
      if (prev && prev.pct === row.pct && prev.cycle === row.cycle && prev.tok === row.tok) continue;
      last.set(key, row);
      rows.push(row);
    }
  }

  await writeFile(BACKFILL_PATH, rows.map((r) => JSON.stringify(r)).join('\n') + (rows.length ? '\n' : ''), 'utf8');
  const state = {
    ranAt: new Date().toISOString(),
    files: files.length,
    events: events.length,
    rows: rows.length,
    from: rows.length ? rows[0].t : null,
    to: rows.length ? rows[rows.length - 1].t : null,
  };
  await writeFile(BACKFILL_STATE_PATH, JSON.stringify(state, null, 2), 'utf8');
  invalidateAnalyzeCache();
  return state;
}

async function backfillState() {
  try {
    return JSON.parse(await readFile(BACKFILL_STATE_PATH, 'utf8'));
  } catch {
    return null;
  }
}

// --- analysis ----------------------------------------------------------------

// Concurrent sessions each report the limit as it stood when their request was
// issued, so a globally time-sorted series arrives out of order: a stale read
// can show a lower percentage, or name the previous window's reset time, after
// a fresher one. Both are corrected here, on the derived view only — the ledger
// itself stays a faithful record of what was observed.
//
// Within one window a percentage never falls and a reset time never moves
// backwards, so a running maximum of each recovers the true curve.
function stabilize(rows) {
  const out = [];
  let cycle = null;
  let cycleResetsMs = -Infinity;
  let peakPct = -Infinity;
  for (const row of rows) {
    const resetsMs = row.resetsAt ? Date.parse(row.resetsAt) : NaN;
    if (cycle === null) {
      cycle = row.cycle;
      cycleResetsMs = Number.isFinite(resetsMs) ? resetsMs : -Infinity;
      peakPct = row.pct;
    } else if (row.cycle !== cycle) {
      if (!Number.isFinite(resetsMs) || resetsMs > cycleResetsMs) {
        cycle = row.cycle;
        cycleResetsMs = Number.isFinite(resetsMs) ? resetsMs : cycleResetsMs;
        peakPct = row.pct; // genuine reset: the new window starts fresh
      }
      // Otherwise the row names an older window than one already seen — a
      // stale read. Fold it into the current cycle rather than opening a
      // duplicate one.
    }
    peakPct = Math.max(peakPct, row.pct);
    out.push({ ...row, cycle, pct: peakPct, rawPct: row.pct });
  }
  return out;
}

function summarizeSeries(series) {
  // `series` is one (account, window, cycle, source) ordered by time.
  const first = series[0];
  const last = series[series.length - 1];
  const pctSpan = last.pct - first.pct;
  const tokens = Math.max(0, last.tok - first.tok);
  const cost = Math.max(0, last.cost - first.cost);
  const steps = [];
  for (let i = 1; i < series.length; i += 1) {
    const a = series[i - 1];
    const b = series[i];
    const dPct = b.pct - a.pct;
    if (dPct <= 0) continue;
    const dTok = Math.max(0, b.tok - a.tok);
    const dCost = Math.max(0, b.cost - a.cost);
    steps.push({
      t: b.t,
      fromPct: a.pct,
      toPct: b.pct,
      deltaPct: dPct,
      tokens: dTok,
      cost: dCost,
      tokensPerPct: dTok / dPct,
      costPerPct: dCost / dPct,
    });
  }
  return {
    src: first.src,
    cycle: first.cycle,
    resetsAt: last.resetsAt,
    from: first.t,
    to: last.t,
    samples: series.length,
    pctStart: first.pct,
    pctEnd: last.pct,
    pctSpan,
    // The series usually begins mid-window (the server was not running when it
    // opened), so the totals below describe the observed slice, not the window.
    partial: first.pct > 0,
    tokens,
    cost,
    tokensPerPct: pctSpan > 0 ? tokens / pctSpan : null,
    costPerPct: pctSpan > 0 ? cost / pctSpan : null,
    projectedTokensAt100: pctSpan > 0 ? (tokens / pctSpan) * 100 : null,
    projectedCostAt100: pctSpan > 0 ? (cost / pctSpan) * 100 : null,
    steps,
  };
}

function groupBy(rows, keyFn) {
  const map = new Map();
  for (const row of rows) {
    const k = keyFn(row);
    if (!map.has(k)) map.set(k, []);
    map.get(k).push(row);
  }
  return map;
}

/**
 * Build the derived view: per account, per limit window, one entry per cycle
 * with the tokens-and-dollars cost of a single percentage point.
 */
// Rebuilding the derived view means re-reading every ledger row (tens of
// thousands once the Codex backfill has run), so a short cache keeps a polling
// dashboard from paying that on every tick. New samples land at most once per
// heartbeat, well outside this window.
const ANALYZE_CACHE_MS = 30_000;
let analyzeCache = null;

function invalidateAnalyzeCache() {
  analyzeCache = null;
}

async function analyze({ maxStepsPerWindow = 400 } = {}) {
  if (analyzeCache
    && analyzeCache.maxStepsPerWindow === maxStepsPerWindow
    && Date.now() - analyzeCache.at < ANALYZE_CACHE_MS) {
    return analyzeCache.value;
  }
  const rows = await allRows();
  rows.sort((a, b) => String(a.t).localeCompare(String(b.t)));

  const accounts = [];
  for (const [acctId, acctRows] of groupBy(rows, (r) => r.acct)) {
    const windows = [];
    for (const [winKey, rawWinRows] of groupBy(acctRows, (r) => r.win)) {
      const winRows = stabilize(rawWinRows);
      const cycles = [];
      for (const [cycleId, cycleRows] of groupBy(winRows, (r) => r.cycle)) {
        // Live and backfill counters are built from different bases, so a
        // cycle straddling both is summarized from whichever source observed
        // the larger percentage span rather than by mixing them.
        const candidates = [];
        for (const [, srcRows] of groupBy(cycleRows, (r) => r.src)) {
          if (srcRows.length < 2) continue;
          candidates.push(summarizeSeries(srcRows));
        }
        if (!candidates.length) {
          const only = cycleRows[cycleRows.length - 1];
          cycles.push({
            src: only.src,
            cycle: cycleId,
            resetsAt: only.resetsAt,
            from: cycleRows[0].t,
            to: only.t,
            samples: cycleRows.length,
            pctStart: cycleRows[0].pct,
            pctEnd: only.pct,
            pctSpan: 0,
            partial: true,
            tokens: 0,
            cost: 0,
            tokensPerPct: null,
            costPerPct: null,
            projectedTokensAt100: null,
            projectedCostAt100: null,
            steps: [],
          });
          continue;
        }
        candidates.sort((a, b) => b.pctSpan - a.pctSpan);
        // More than one login inside a window means its token counters and its
        // percentages do not describe the same account throughout, so the rate
        // derived from it is not trustworthy without saying so.
        const logins = [...new Set(cycleRows.map((r) => r.who).filter(Boolean))];
        cycles.push({ ...candidates[0], logins, mixedLogins: logins.length > 1 });
      }
      cycles.sort((a, b) => String(b.to).localeCompare(String(a.to)));

      const rated = cycles.filter((c) => c.tokensPerPct != null);
      const totalPct = rated.reduce((s, c) => s + c.pctSpan, 0);
      const totalTokens = rated.reduce((s, c) => s + c.tokens, 0);
      const totalCost = rated.reduce((s, c) => s + c.cost, 0);

      const steps = cycles
        .flatMap((c) => c.steps.map((s) => ({ ...s, cycle: c.cycle })))
        .sort((a, b) => String(a.t).localeCompare(String(b.t)))
        .slice(-maxStepsPerWindow);

      const latest = winRows[winRows.length - 1];
      windows.push({
        key: winKey,
        label: latest.label || winKey,
        latest: { t: latest.t, pct: latest.pct, resetsAt: latest.resetsAt, cycle: latest.cycle },
        current: cycles.find((c) => c.cycle === latest.cycle) || null,
        // Pooled across every observed cycle: the most stable estimate of what
        // one percent costs, since single cycles can be short or lopsided.
        lifetime: totalPct > 0
          ? {
            cycles: rated.length,
            pct: totalPct,
            tokens: totalTokens,
            cost: totalCost,
            tokensPerPct: totalTokens / totalPct,
            costPerPct: totalCost / totalPct,
            projectedTokensAt100: (totalTokens / totalPct) * 100,
            projectedCostAt100: (totalCost / totalPct) * 100,
          }
          : null,
        cycles: cycles.map(({ steps: _drop, ...rest }) => rest),
        steps,
      });
    }
    windows.sort((a, b) => a.key.localeCompare(b.key));
    accounts.push({ id: acctId, provider: acctRows[0].provider, windows });
  }
  accounts.sort((a, b) => a.id.localeCompare(b.id));

  const value = {
    generatedAt: new Date().toISOString(),
    rows: rows.length,
    firstSampleAt: rows.length ? rows[0].t : null,
    backfill: await backfillState(),
    accounts,
  };
  analyzeCache = { at: Date.now(), maxStepsPerWindow, value };
  return value;
}

module.exports = {
  LEDGER_PATH,
  BACKFILL_PATH,
  recordSnapshot,
  backfillCodex,
  backfillState,
  analyze,
  normalizeWindows,
  readRows,
};
