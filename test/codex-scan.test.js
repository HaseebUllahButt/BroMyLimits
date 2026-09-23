const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const os = require('node:os');
const { existsSync } = require('node:fs');
const { scanCodexSessions } = require('../server');

// Reads this machine's real Codex rollouts, so it skips where none exist.
const codexHome = process.env.CODEX_HOME || path.join(os.homedir(), '.codex');

test('scanCodexSessions parses local rollouts and returns usage & limits', { skip: !existsSync(path.join(codexHome, 'sessions')) && 'no local Codex data' }, async () => {
  const t0 = Date.now();
  const res = await scanCodexSessions(codexHome);
  const coldTime = Date.now() - t0;

  assert.ok(res.daily.length > 0, 'should have daily rows');
  assert.ok(res.models.length > 0, 'should have model rows');
  assert.ok(res.rateLimits, 'should extract rate limits');
  assert.equal(typeof res.rateLimits.weekly.percent, 'number');

  // Test warm scan (caching)
  const t1 = Date.now();
  const resWarm = await scanCodexSessions(codexHome);
  const warmTime = Date.now() - t1;

  assert.equal(resWarm.daily.length, res.daily.length);
  assert.ok(warmTime < 100, `Warm scan should be fast (got ${warmTime}ms)`);
});
