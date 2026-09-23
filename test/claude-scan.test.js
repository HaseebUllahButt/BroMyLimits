const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const os = require('node:os');
const { existsSync } = require('node:fs');
const { scanClaudeSessions } = require('../server');

// Reads this machine's real Claude Code transcripts, so it skips where none exist.
const claudeHome = [
  process.env.CLAUDE_CONFIG_DIR,
  path.join(os.homedir(), '.claude-personal'),
  path.join(os.homedir(), '.claude'),
].find((dir) => dir && existsSync(path.join(dir, 'projects')));

test('scanClaudeSessions parses local project session files and returns usage', { skip: !claudeHome && 'no local Claude Code data' }, async () => {
  const t0 = Date.now();
  const res = await scanClaudeSessions(claudeHome);
  const coldTime = Date.now() - t0;

  assert.ok(res.daily.length > 0, 'should have daily rows');
  assert.ok(res.models.length > 0, 'should have model rows');

  // Test warm scan (caching)
  const t1 = Date.now();
  const resWarm = await scanClaudeSessions(claudeHome);
  const warmTime = Date.now() - t1;

  assert.equal(resWarm.daily.length, res.daily.length);
  assert.ok(warmTime < 100, `Warm scan should be fast (got ${warmTime}ms)`);
});
