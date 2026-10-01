const assert = require('node:assert/strict');
const { mkdtemp, rm } = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { DatabaseSync } = require('node:sqlite');

const { scanOpencodeSessionsUncached } = require('../server');

const COLS = `id TEXT PRIMARY KEY, model TEXT, agent TEXT, cost REAL, tokens_input INT, tokens_output INT,
  tokens_reasoning INT, tokens_cache_read INT, tokens_cache_write INT, time_created INT`;
const model = JSON.stringify({ id: 'deepseek-v4-flash', providerID: 'opencode' });
const insert = (db, table, id, tokens) => db.prepare(
  `INSERT INTO ${table} VALUES (?, ?, 'build', 0, ?, 0, 0, 0, 0, ?)`,
).run(id, model, tokens, Date.parse('2026-09-20T12:00:00Z'));
const total = (scan) => scan.daily.reduce((sum, d) => sum + d.totalTokens, 0);

async function withDb(setup, check) {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'cc-usage-opencode-'));
  const file = path.join(dir, 'opencode.db');
  try {
    const db = new DatabaseSync(file);
    db.exec('CREATE TABLE message (id TEXT, session_id TEXT, data TEXT)');
    setup(db);
    db.close();
    check(scanOpencodeSessionsUncached(file));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

test('opencode scan counts sessions that exist only in session_v2, once', async () => {
  await withDb((db) => {
    db.exec(`CREATE TABLE session (${COLS}); CREATE TABLE session_v2 (${COLS})`);
    insert(db, 'session', 'a', 100);
    insert(db, 'session_v2', 'a', 100); // in both tables: must not double count
    insert(db, 'session_v2', 'b', 40);  // only in v2: must not be dropped
  }, (scan) => assert.equal(total(scan), 140));
});

test('opencode scan still works on databases without session_v2', async () => {
  await withDb((db) => {
    db.exec(`CREATE TABLE session (${COLS})`);
    insert(db, 'session', 'a', 100);
  }, (scan) => assert.equal(total(scan), 100));
});

test('archived usage adds to all-time totals only', () => {
  const { applyArchivedUsage } = require('../server');
  const section = { allTime: { cost: 1, tokens: 10 }, today: { cost: 0, tokens: 0 }, usageSources: ['Devin CLI'] };
  const out = applyArchivedUsage(section, { tokens: 500, label: 'archived 500' });
  assert.deepEqual(out.allTime, { cost: 1, tokens: 510 });
  assert.deepEqual(out.today, { cost: 0, tokens: 0 });
  assert.deepEqual(out.usageSources, ['Devin CLI', 'archived 500']);
  assert.equal(applyArchivedUsage({ allTime: { cost: 0, tokens: 1 } }, null).allTime.tokens, 1);
});
