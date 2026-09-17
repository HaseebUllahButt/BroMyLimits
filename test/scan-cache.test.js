const assert = require('node:assert/strict');
const test = require('node:test');
const os = require('node:os');
const path = require('node:path');
const { mkdtemp, writeFile, appendFile, rm, stat } = require('node:fs/promises');

const {
  FileRollupCache, ResultCache, foldLinesFrom, loadIndex, saveIndex, blankStats, addStats,
} = require('../scan-cache');

// A parser in the same shape the real ones use: a stateful model name that is
// announced once and applies to every row after it.
const parser = {
  id: 'test',
  initState: () => ({ model: null, seen: [] }),
  wants: (line) => line.includes('"usage"') || line.includes('"model"'),
  line: (d, state, add) => {
    if (d.model) { state.model = d.model; return; }
    if (!d.usage) return;
    if (d.id) {
      if (state.seen.includes(d.id)) return;
      state.seen.push(d.id);
    }
    add(d.date, state.model || 'unknown', { input: d.usage.in || 0, output: d.usage.out || 0, total: (d.usage.in || 0) + (d.usage.out || 0) });
  },
};

const rows = (n, from = 0) => Array.from({ length: n }, (_, k) =>
  JSON.stringify({ id: `m${from + k}`, date: '2026-09-17', usage: { in: 10, out: 1 } })).join('\n') + '\n';

async function tmpdir() {
  return mkdtemp(path.join(os.tmpdir(), 'scan-cache-test-'));
}

test('foldLinesFrom stops at the last complete newline and leaves a torn tail', async () => {
  const dir = await tmpdir();
  const f = path.join(dir, 'a.jsonl');
  await writeFile(f, 'one\ntwo\nthree-no-newline');
  const seen = [];
  const r = await foldLinesFrom(f, 0, (l) => seen.push(l));
  assert.deepEqual(seen, ['one', 'two']);
  assert.equal(r.consumed, 'one\ntwo\n'.length, 'consumed must exclude the partial line');

  // The torn line completes; a second pass from `consumed` picks it up whole.
  await appendFile(f, '\n');
  const more = [];
  const r2 = await foldLinesFrom(f, r.consumed, (l) => more.push(l));
  assert.deepEqual(more, ['three-no-newline']);
  assert.equal(r2.consumed, (await stat(f)).size);
  await rm(dir, { recursive: true, force: true });
});

test('an incremental append gives exactly the same buckets as a cold parse', async () => {
  const dir = await tmpdir();
  const f = path.join(dir, 'b.jsonl');
  await writeFile(f, JSON.stringify({ model: 'gpt-x' }) + '\n' + rows(50));

  const incremental = new FileRollupCache({ id: 'test', parser });
  const first = await incremental.scan([f]);
  assert.equal(first.parsed, 1);

  // Grow it the way an active session does, then rescan.
  await appendFile(f, rows(25, 50));
  const second = await incremental.scan([f]);
  assert.equal(second.appended, 1, 'a grown file must be read as an append');
  assert.equal(second.parsed, 0);
  assert.ok(second.bytesSkipped > 0, 'the already-read prefix must be skipped');

  const cold = new FileRollupCache({ id: 'test', parser });
  await cold.scan([f]);

  assert.deepEqual(
    Object.fromEntries(incremental.fold()),
    Object.fromEntries(cold.fold()),
    'incremental and cold folds must agree',
  );
  const b = incremental.fold().get('2026-09-17|gpt-x');
  assert.equal(b.input, 750, '75 rows x 10 input tokens');
  await rm(dir, { recursive: true, force: true });
});

test('the model announced before the boundary still applies after it', async () => {
  const dir = await tmpdir();
  const f = path.join(dir, 'c.jsonl');
  // turn_context-style: the model is named once, at the top.
  await writeFile(f, JSON.stringify({ model: 'gpt-5.6-luna' }) + '\n' + rows(3));
  const cache = new FileRollupCache({ id: 'test', parser });
  await cache.scan([f]);
  await appendFile(f, rows(3, 3));
  await cache.scan([f]);
  const keys = [...cache.fold().keys()];
  assert.deepEqual(keys, ['2026-09-17|gpt-5.6-luna'],
    'the appended rows must not fall back to "unknown"');
  await rm(dir, { recursive: true, force: true });
});

test('an unchanged file is a hit and is not re-read', async () => {
  const dir = await tmpdir();
  const f = path.join(dir, 'd.jsonl');
  await writeFile(f, rows(10));
  const cache = new FileRollupCache({ id: 'test', parser });
  await cache.scan([f]);
  const again = await cache.scan([f]);
  assert.equal(again.hits, 1);
  assert.equal(again.parsed, 0);
  assert.equal(again.appended, 0);
  assert.equal(again.bytesRead, 0, 'a hit must read no bytes at all');
  await rm(dir, { recursive: true, force: true });
});

test('a file replaced in place (same size, new inode) is re-parsed, not trusted', async () => {
  const dir = await tmpdir();
  const f = path.join(dir, 'e.jsonl');
  await writeFile(f, rows(4));
  const cache = new FileRollupCache({ id: 'test', parser });
  await cache.scan([f]);
  const before = cache.fold().get('2026-09-17|unknown').input;

  // Same byte length, different content and inode - the case (mtime, size) alone misses.
  await rm(f);
  await writeFile(f, rows(4, 100));
  const st = await stat(f);
  const entry = cache.entries.get(f);
  entry.mtimeMs = st.mtimeMs;
  entry.size = st.size;
  const after = await cache.scan([f]);
  assert.equal(after.parsed, 1, 'a new inode must force a full re-parse');
  assert.equal(cache.fold().get('2026-09-17|unknown').input, before);
  await rm(dir, { recursive: true, force: true });
});

test('a sealed file is trusted without a stat, and force overrides that', async () => {
  const dir = await tmpdir();
  const f = path.join(dir, 'g.jsonl');
  await writeFile(f, rows(5));
  const cache = new FileRollupCache({ id: 'test', parser, sealAfterMs: -1 });
  await cache.scan([f]);          // marks it sealed: every file is "old"
  const again = await cache.scan([f]);
  assert.equal(again.sealed, 1);
  assert.equal(again.hits, 0);
  // force re-stats past the seal but still trusts an unchanged file: that is
  // the cheap "re-check everything" a Rescan button wants.
  const forced = await cache.scan([f], { force: true });
  assert.equal(forced.sealed, 0, 'force must ignore the seal');
  assert.equal(forced.hits, 1, 'force must still skip a file that has not changed');
  assert.equal(forced.bytesRead, 0);

  // rebuild distrusts the cache key itself and re-reads the bytes.
  const rebuilt = await cache.scan([f], { rebuild: true });
  assert.equal(rebuilt.parsed, 1, 'rebuild must re-read regardless of the key');
  assert.ok(rebuilt.bytesRead > 0);
  assert.equal(cache.fold().get('2026-09-17|unknown').input, 50,
    'a rebuild must not double-count what was already folded');
  await rm(dir, { recursive: true, force: true });
});

test('a vanished file is dropped from the index', async () => {
  const dir = await tmpdir();
  const f = path.join(dir, 'h.jsonl');
  await writeFile(f, rows(2));
  const cache = new FileRollupCache({ id: 'test', parser });
  await cache.scan([f]);
  const after = await cache.scan([]);
  assert.equal(after.dropped, 1);
  assert.equal(cache.entries.size, 0);
  assert.equal(cache.fold().size, 0);
  await rm(dir, { recursive: true, force: true });
});

test('the index survives a round trip through disk', async () => {
  const dir = await tmpdir();
  const f = path.join(dir, 'i.jsonl');
  const idx = path.join(dir, 'index.json');
  await writeFile(f, JSON.stringify({ model: 'gpt-x' }) + '\n' + rows(7));

  const a = new FileRollupCache({ id: 'test', parser });
  await a.scan([f]);
  assert.equal(await saveIndex(idx, [a]), true);

  const b = new FileRollupCache({ id: 'test', parser });
  assert.equal(await loadIndex(idx, [b]), true);
  assert.deepEqual(Object.fromEntries(b.fold()), Object.fromEntries(a.fold()));

  // The restored index must behave like a warm one: no re-parse.
  const after = await b.scan([f]);
  assert.equal(after.parsed, 0);
  assert.equal(after.hits + after.sealed, 1, 'a restored entry must be a hit, not a rebuild');
  await rm(dir, { recursive: true, force: true });
});

test('a stale index version is refused rather than trusted', async () => {
  const dir = await tmpdir();
  const idx = path.join(dir, 'index.json');
  await writeFile(idx, JSON.stringify({ version: 999, caches: { test: { id: 'test', files: {} } } }));
  const c = new FileRollupCache({ id: 'test', parser });
  assert.equal(await loadIndex(idx, [c]), false);
  await rm(dir, { recursive: true, force: true });
});

test('stats add up across providers', () => {
  const a = { ...blankStats(), files: 2, hits: 1, bytesRead: 10 };
  const b = { ...blankStats(), files: 3, parsed: 3, bytesRead: 5 };
  const sum = addStats(a, b);
  assert.equal(sum.files, 5);
  assert.equal(sum.hits, 1);
  assert.equal(sum.parsed, 3);
  assert.equal(sum.bytesRead, 15);
});

test('two accounts sharing one index do not evict each other', async () => {
  // The bug this guards: scan() used to treat its file list as the whole
  // universe and delete every other entry, so with two Codex logins the last
  // account to scan was the only one left and the first one's usage vanished.
  const dir = await tmpdir();
  const rootA = path.join(dir, 'a');
  const rootB = path.join(dir, 'b');
  await require('node:fs/promises').mkdir(rootA);
  await require('node:fs/promises').mkdir(rootB);
  const fa = path.join(rootA, 'x.jsonl');
  const fb = path.join(rootB, 'y.jsonl');
  await writeFile(fa, rows(3));
  await writeFile(fb, rows(4, 100));

  const cache = new FileRollupCache({ id: 'test', parser });
  await cache.scan([fa], { root: rootA });
  const after = await cache.scan([fb], { root: rootB });

  assert.equal(after.dropped, 0, "account B's scan must not drop account A");
  assert.equal(cache.entries.size, 2);
  assert.equal(cache.fold([fa]).get('2026-09-17|unknown').input, 30);
  assert.equal(cache.fold([fb]).get('2026-09-17|unknown').input, 40);
  assert.equal(cache.fold().get('2026-09-17|unknown').input, 70, 'an unscoped fold is still every file');

  // A file really gone from its own root is still evicted.
  await rm(fa);
  const gone = await cache.scan([], { root: rootA });
  assert.equal(gone.dropped, 1);
  assert.equal(cache.entries.size, 1, "B's entry must survive A's eviction");
  await rm(dir, { recursive: true, force: true });
});

test('ResultCache serves a whole result until the files behind it change', async () => {
  const dir = await tmpdir();
  const db = path.join(dir, 'x.db');
  await writeFile(db, 'v1');
  const cache = new ResultCache({ id: 'db' });
  const paths = [db, db + '-wal', db + '-shm'];

  let a = await cache.lookup('k', paths);
  assert.equal(a.hit, false, 'nothing cached yet');
  cache.store('k', a.sig, { rows: 1 });

  const b = await cache.lookup('k', paths);
  assert.equal(b.hit, true);
  assert.deepEqual(b.value, { rows: 1 });

  await writeFile(db, 'v2-longer');
  const c = await cache.lookup('k', paths);
  assert.equal(c.hit, false, 'a changed database must miss');
  await rm(dir, { recursive: true, force: true });
});

test('a read-only query must not invalidate the cache it just used', async () => {
  // The bug this guards: -shm was part of the signature, and opening a SQLite
  // database read-only rewrites -shm's mtime. Every scan therefore dirtied the
  // very thing it was watching, so the next scan re-read the whole database -
  // measured at 3.6s per pass on a 1GB store that nobody was writing to.
  let DatabaseSync;
  try { ({ DatabaseSync } = require('node:sqlite')); } catch { return; }
  const dir = await tmpdir();
  const db = path.join(dir, 'w.db');
  const w = new DatabaseSync(db);
  w.exec('PRAGMA journal_mode=WAL');
  w.exec('CREATE TABLE t(a)');
  w.exec("INSERT INTO t VALUES('x')");

  // Exactly what server.js watches: the database and its WAL, never -shm.
  const paths = [db, db + '-wal'];
  const cache = new ResultCache({ id: 'db' });
  const first = await cache.lookup('k', paths);
  cache.store('k', first.sig, { rows: 1 });

  const r = new DatabaseSync(db, { readOnly: true });
  r.prepare('SELECT count(*) AS n FROM t').get();
  r.close();
  assert.equal((await cache.lookup('k', paths)).hit, true,
    'reading the database must leave the cached result valid');

  w.exec("INSERT INTO t VALUES('y')");
  w.close();
  assert.equal((await cache.lookup('k', paths)).hit, false,
    'a real write must still invalidate');
  await rm(dir, { recursive: true, force: true });
});

test('a write that lands only in the WAL still invalidates', async () => {
  // SQLite in WAL mode leaves the main database untouched until a checkpoint,
  // so watching it alone would serve a stale answer for as long as the WAL
  // went uncheckpointed.
  const dir = await tmpdir();
  const db = path.join(dir, 'y.db');
  await writeFile(db, 'main');
  const cache = new ResultCache({ id: 'db' });
  const paths = [db, db + '-wal', db + '-shm'];
  const first = await cache.lookup('k', paths);
  cache.store('k', first.sig, { rows: 7 });
  assert.equal((await cache.lookup('k', paths)).hit, true);

  await writeFile(db + '-wal', 'pending write');
  assert.equal((await cache.lookup('k', paths)).hit, false,
    'a new WAL file must be treated as a change');
  await rm(dir, { recursive: true, force: true });
});

test('ResultCache rebuild ignores a matching signature, and survives disk', async () => {
  const dir = await tmpdir();
  const db = path.join(dir, 'z.db');
  const idx = path.join(dir, 'index.json');
  await writeFile(db, 'data');
  const cache = new ResultCache({ id: 'db' });
  const paths = [db, db + '-wal', db + '-shm'];
  const r = await cache.lookup('k', paths);
  cache.store('k', r.sig, { rows: 3 });

  assert.equal((await cache.lookup('k', paths, { force: true })).hit, false, 'rebuild must bypass');

  assert.equal(await saveIndex(idx, [cache]), true);
  const restored = new ResultCache({ id: 'db' });
  assert.equal(await loadIndex(idx, [restored]), true);
  const back = await restored.lookup('k', paths);
  assert.equal(back.hit, true, 'a restored signature must still match');
  assert.deepEqual(back.value, { rows: 3 });
  await rm(dir, { recursive: true, force: true });
});
