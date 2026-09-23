'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const limitHistory = require('../limit-history');
const { claudeModelCost, codexBucketCost, codexTurnCost, formatCodexLocalRateLimits } = require('../server');

test('Codex limit windows keep 5h, 7d, and 30d readings separate', () => {
  assert.deepEqual(limitHistory.classifyCodexWindow(300), { key: 'session', label: 'Session (5h)' });
  assert.deepEqual(limitHistory.classifyCodexWindow(10080), { key: 'weekly', label: 'Weekly' });
  assert.deepEqual(limitHistory.classifyCodexWindow(43200), { key: '30d', label: '30d' });
});

test('old durationless live snapshots cannot overwrite a backfilled 30d lane as weekly', () => {
  const rows = [
    { acct: 'codex-default', provider: 'codex', src: 'backfill', win: '30d', cycle: 'cycle-a' },
    { acct: 'codex-default', provider: 'codex', src: 'live', win: 'weekly', cycle: 'cycle-a' },
    { acct: 'codex-default', provider: 'codex', src: 'live', win: 'session', cycle: 'cycle-a' },
    { acct: 'codex-personal', provider: 'codex', src: 'live', win: 'weekly', cycle: 'cycle-a' },
  ];
  assert.deepEqual(limitHistory.removeMisclassifiedLiveCodexRows(rows), [rows[0], rows[2], rows[3]]);
});

test('Codex live limit parsing does not relabel an unsupported 30d lane as weekly', () => {
  const limits = formatCodexLocalRateLimits({
    primary: { used_percent: 98, window_minutes: 43200, resets_at: 1791782350 },
    secondary: { used_percent: 24, window_minutes: 10080, resets_at: 1790536733 },
  }, Date.now());
  assert.equal(limits.weekly.percent, 24);
  assert.equal(limits.session, null);
});

test('durationless Codex limits with resets beyond eight days are not called weekly', () => {
  const sampledAt = Date.parse('2026-09-23T14:00:00Z');
  const monthlyReset = Date.parse('2026-10-12T05:19:15Z') / 1000;
  const longer = formatCodexLocalRateLimits({
    primary: { used_percent: 100, resets_at: monthlyReset },
  }, sampledAt);
  assert.equal(longer.weekly, null);
  assert.equal(longer.session, null);

  const weeklyReset = Date.parse('2026-09-27T19:18:53Z') / 1000;
  const withinAWeek = formatCodexLocalRateLimits({
    primary: { used_percent: 25, resets_at: weeklyReset },
  }, sampledAt);
  assert.equal(withinAWeek.weekly.percent, 25);
});

test('stale long-reset Codex rows are excluded from the weekly economics pool', () => {
  const longLane = {
    acct: 'codex-personal', provider: 'codex', src: 'live', win: 'weekly',
    t: '2026-09-23T13:43:29.117Z', resetsAt: '2026-10-12T05:19:16.000Z',
    cycle: '2026-10-12T05:20:00.000Z', pct: 100,
  };
  const realWeekly = {
    acct: 'codex-default', provider: 'codex', src: 'live', win: 'weekly',
    t: '2026-09-23T14:07:26.136Z', resetsAt: '2026-09-27T19:18:53.000Z',
    cycle: '2026-09-27T19:20:00.000Z', pct: 25,
  };
  assert.deepEqual(limitHistory.removeMisclassifiedLiveCodexRows([longLane, realWeekly]), [realWeekly]);
});

test('Codex dollar counters split when repricing lowers the cumulative cost', () => {
  const rows = [
    { pct: 40, tok: 400, cost: 40 },
    { pct: 50, tok: 500, cost: 50 },
    { pct: 51, tok: 510, cost: 35 },
    { pct: 55, tok: 550, cost: 39 },
  ];
  const segments = limitHistory.splitCounterResetSegments(rows);
  assert.deepEqual(segments.map((segment) => segment.length), [2, 2]);
  assert.equal((segments[1][1].cost - segments[1][0].cost) / (segments[1][1].pct - segments[1][0].pct), 1);
});

test('Codex Sol API-equivalent rates apply the Aug 21 promotion and preserve prior rates', () => {
  const usage = { input_tokens: 1_000_000, cached_input_tokens: 200_000, output_tokens: 1_000_000 };
  const before = limitHistory.codexTurnCost('gpt-5.6-sol', usage, '2026-08-20T23:59:59Z');
  const after = limitHistory.codexTurnCost('gpt-5.6-sol', usage, '2026-08-21T00:00:00Z');
  assert.ok(Math.abs(before - 34.1) < 1e-9);
  assert.ok(Math.abs(after - 23.28) < 1e-9);
});

test('Codex daily and turn pricing use the same dated Sol rates', () => {
  const before = codexBucketCost('gpt-5.6-sol', { input: 800_000, cacheRead: 200_000, output: 1_000_000 }, '2026-08-20T23:59:59Z');
  const after = codexBucketCost('gpt-5.6-sol', { input: 800_000, cacheRead: 200_000, output: 1_000_000 }, '2026-08-21T00:00:00Z');
  assert.ok(Math.abs(before.total - 34.1) < 1e-9);
  assert.ok(Math.abs(after.total - 23.28) < 1e-9);
  const turn = codexTurnCost('gpt-5.6-sol', { input_tokens: 1_000_000, cached_input_tokens: 200_000, output_tokens: 1_000_000 }, '2026-08-21T00:00:00Z');
  assert.ok(Math.abs(after.total - turn.total) < 1e-9);
});

test('Codex GPT-6 Luna usage receives its current API-equivalent rate', () => {
  const usage = { input_tokens: 200_000, cached_input_tokens: 190_000, output_tokens: 1_000 };
  const turn = limitHistory.codexTurnCost('gpt-6-luna', usage, '2026-09-23T00:00:00Z');
  const daily = codexBucketCost('gpt-6-luna', { input: 10_000, cacheRead: 190_000, output: 1_000 }, '2026-09-23');
  assert.ok(Math.abs(turn - 0.0034) < 1e-9);
  assert.ok(Math.abs(daily.total - turn) < 1e-9);
});

test('all GPT-6 models use their current API-equivalent rates for turns and daily usage', () => {
  const cases = [
    ['gpt-6-astra', 51],
    ['gpt-6-sol', 10.2],
    ['gpt-6-luna', 0.51],
  ];
  const usage = { input_tokens: 1_000_000, cached_input_tokens: 1_000_000, output_tokens: 1_000_000 };
  const dailyTokens = { input: 0, cacheRead: 1_000_000, output: 1_000_000 };
  for (const [model, expected] of cases) {
    const turn = codexTurnCost(model, usage, '2026-09-23T00:00:00Z');
    const daily = codexBucketCost(model, dailyTokens, '2026-09-23');
    assert.ok(Math.abs(turn.total - expected) < 1e-9, `${model} turn rate`);
    assert.ok(Math.abs(daily.total - expected) < 1e-9, `${model} daily rate`);
  }
});

test('Claude Opus 5.5 local usage includes input, output, cache-write, and cache-read rates', () => {
  const cost = claudeModelCost('claude-opus-5-5-20260922', {
    inputTokens: 1_000_000,
    outputTokens: 1_000_000,
    cacheCreationTokens: 1_000_000,
    cacheReadTokens: 1_000_000,
  }, '2026-09-23');
  assert.deepEqual(cost, { input: 4, output: 20, cacheWrite: 5, cacheRead: 0.2 });
});

test('5h session windows are excluded from limit economics, others are kept', () => {
  const { isFiveHourWindow } = require('../limit-history.js');
  assert.equal(isFiveHourWindow('session', 'Session (5h)'), true);
  assert.equal(isFiveHourWindow('claude-gpt-5h', 'Claude/GPT · 5h'), true);
  assert.equal(isFiveHourWindow('gemini-five-hour-limit', 'Gemini — Five Hour Limit'), true);
  assert.equal(isFiveHourWindow('weekly', 'Weekly'), false);
  assert.equal(isFiveHourWindow('15h', '15h'), false);
  assert.equal(isFiveHourWindow('30d', '30d'), false);
});
