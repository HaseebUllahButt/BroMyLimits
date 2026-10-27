const test = require('node:test');
const assert = require('node:assert/strict');
const { groupByProvider } = require('../public/provider-groups');
const acct = (id, provider, tokens) => ({ id, provider, allTime: { cost: tokens / 100, tokens },
  today: { cost: tokens / 100, tokens }, daily: [{ date: '2026-10-04', cost: tokens / 100, tokens }],
  models: [{ modelName: 'model', tokens: { input: tokens }, cost: { input: tokens / 100, total: tokens / 100 } }],
  cache: { freshInput: tokens, cacheRead: 10, savedUsd: 1, netSavedUsd: 1 }, rateLimits: { percent: 30 } });

test('one provider tab combines accounts and machines, preserving token and cost totals', () => {
  const inputs = [acct('local', 'codex', 100), acct('remote', 'codex', 200), acct('claude', 'claude', 50), acct('oc', 'opencode2', 25)];
  const before = JSON.stringify(inputs);
  const groups = groupByProvider(inputs);
  assert.deepEqual(groups.map(g => g.provider), ['codex', 'claude', 'opencode']);
  const codex = groups[0];
  assert.equal(codex.allTime.tokens, 300);
  assert.equal(codex.allTime.cost, 3);
  assert.equal(codex.models.length, 1);
  assert.equal(codex.models[0].tokens.input, 300);
  assert.equal(codex.daily[0].tokens, 300);
  assert.equal(codex.cache.hitRate, 20 / 320);
  assert.equal(codex.rateLimits, undefined, 'account percentages must never be summed');
  assert.equal(codex.members.length, 2);
  assert.equal(JSON.stringify(inputs), before, 'grouping must not mutate snapshots');
});

test('provider grouping propagates missing detail and total-only costs', () => {
  const a = acct('a', 'codex', 100);
  a.dailyUnavailable = true;
  a.models[0].totalCostOnly = true;
  const g = groupByProvider([a])[0];
  assert.equal(g.dailyUnavailable, true);
  assert.equal(g.models[0].totalCostOnly, true);
});
