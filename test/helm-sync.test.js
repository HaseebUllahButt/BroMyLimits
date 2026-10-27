const test = require('node:test');
const assert = require('node:assert/strict');
const { mkdtemp, writeFile, readFile, rm } = require('node:fs/promises');
const { tmpdir } = require('node:os');
const path = require('node:path');
const { HelmSync, currentPeriods, remoteId, sshArgs } = require('../helm-sync');

const now = new Date().toISOString();
const account = (tokens = 10) => ({ id: 'codex-default', provider: 'codex', label: 'default', allTime: { tokens, cost: 1 },
  daily: [{ date: now.slice(0, 10), cost: 1, tokens }], today: { tokens, cost: 1 } });
const usage = tokens => ({ fetchedAt: now, accounts: [account(tokens)] });
const network = () => ({ id: 'network-1', self: 'one', machines: { one: { name: 'Here' }, two: { name: 'There' } }, revoked: {} });
const snapshot = (tokens = 20) => ({ version: 1, networkId: 'network-1', machineId: 'two', usage: usage(tokens),
  history: { accounts: [{ id: 'codex-default', provider: 'codex', windows: [] }] } });
async function fixture(t, opts = {}) {
  const dir = await mkdtemp(path.join(tmpdir(), 'bml-mesh-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const net = network();
  await writeFile(path.join(dir, 'network.json'), JSON.stringify(net));
  const sync = new HelmSync({ helmDir: dir, cachePath: path.join(dir, 'cache.json'), readPeer: async () => snapshot(),
    readReport: async () => usage(99), ...opts });
  return { sync, dir, net };
}

test('standalone remains usable without Helm and never calls network readers', async t => {
  const { sync, dir } = await fixture(t, { readPeer: () => assert.fail('no peer IO'), readReport: () => assert.fail('no Helm IO') });
  await rm(path.join(dir, 'network.json'));
  const view = await sync.view(usage(10), { wait: true });
  assert.equal(view.mesh.mode, 'standalone');
  assert.deepEqual(view.accounts, usage(10).accounts);
});

test('rich peer snapshot replaces Helm usage; repeated syncs never add copies', async t => {
  const { sync, net } = await fixture(t, { readReport: () => assert.fail('rich snapshot already supplied usage') });
  for (let i = 0; i < 3; i++) {
    await sync.sync(net);
    const view = await sync.view(usage(10));
    assert.equal(view.accounts.length, 2);
    assert.equal(view.accounts.reduce((s, a) => s + a.allTime.tokens, 0), 30);
    assert.equal(view.accounts[1].id, remoteId('two', 'codex-default'));
    assert.notEqual(view.accounts[0].id, view.accounts[1].id);
  }
  const history = await sync.history({ accounts: [{ id: 'codex-default' }] });
  assert.equal(history.accounts[1].id, remoteId('two', 'codex-default'));
});

test('Helm-only devices supply usage and missing devices stay unknown', async t => {
  const { sync, net } = await fixture(t, { readPeer: async () => { throw new Error('not installed'); } });
  const view = await sync.view(usage(10), { wait: true });
  assert.equal(view.accounts[1].allTime.tokens, 99);
  assert.equal(view.mesh.devices[1].source, 'helm');
  sync.readReport = async () => { throw new Error('offline'); };
  await sync.sync(net);
  const cached = await sync.view(usage(10));
  assert.equal(cached.accounts[1].allTime.tokens, 99);
  assert.equal(cached.accounts[1].stale, true);
});

test('rich cached summaries survive restart and revoked members disappear immediately', async t => {
  const { sync, dir, net } = await fixture(t);
  await sync.view(usage(10), { wait: true });
  const restarted = new HelmSync({ helmDir: dir, cachePath: path.join(dir, 'cache.json'),
    readPeer: async () => { throw new Error('sleeping'); }, readReport: () => assert.fail('must retain richer data') });
  const view = await restarted.view(usage(10), { wait: true });
  assert.equal(view.accounts[1].allTime.tokens, 20);
  assert.equal(view.accounts[1].stale, true);
  net.revoked.two = true;
  await writeFile(path.join(dir, 'network.json'), JSON.stringify(net));
  assert.equal((await restarted.view(usage(10))).accounts.length, 1);
  assert.equal((await restarted.history({ accounts: [] })).accounts.length, 0);
});

test('a snapshot from another network or containing aggregates is rejected', async t => {
  const { sync } = await fixture(t, { peersOnly: true, readPeer: async () => ({ ...snapshot(), networkId: 'wrong' }) });
  assert.equal((await sync.view(usage(10), { wait: true })).accounts.length, 1);
  sync.lastSync = 0;
  sync.readPeer = async () => ({ ...snapshot(), usage: { ...usage(20), accounts: [{ ...account(20), remote: true }] } });
  assert.equal((await sync.view(usage(10), { wait: true })).accounts.length, 1);
});

test('publishing shares only local accounts and no mesh credentials', async t => {
  const { sync, dir } = await fixture(t);
  await sync.publish(usage(10), { accounts: [] });
  const published = JSON.parse(await readFile(path.join(dir, 'bro-my-limits.json'), 'utf8'));
  assert.equal(published.machineId, 'one');
  assert.deepEqual(published.usage, usage(10));
  assert.equal(published.key, undefined);
});

test('cached calendar periods advance while all-time totals are retained', () => {
  const old = { ...account(10), daily: [{ date: '2026-09-30', cost: 4, tokens: 40 }] };
  const current = currentPeriods(old, new Date('2026-10-04T12:00:00Z'));
  assert.equal(current.today.tokens, 0);
  assert.equal(current.month.tokens, 0);
  assert.equal(current.last7d.tokens, 40);
  assert.equal(current.allTime.tokens, 10);
});

test('SSH rejects option or shell injection from member fields', () => {
  for (const peer of [{ name: '-bad', sshUser: 'user' }, { name: 'safe', sshUser: 'x;id' }, { name: 'safe', sshUser: 'user', sshPort: 0 }]) {
    assert.throws(() => sshArgs(peer, '/helm', '/state'));
  }
});

test('the Helm tunnel exposes only a read-only summary and preserves other settings', async t => {
  const { sync, dir } = await fixture(t, { syncPort: 52000 + process.pid % 10000 });
  t.after(() => sync.stopSharing());
  await writeFile(path.join(dir, 'config.json'), JSON.stringify({ theme: 'existing', tunnel: { ports: [12345] } }));
  await sync.publish(usage(10), { accounts: [] });
  await sync.ensureSharing();
  const config = JSON.parse(await readFile(path.join(dir, 'config.json'), 'utf8'));
  assert.equal(config.theme, 'existing');
  assert.deepEqual(config.tunnel.ports, [12345, sync.syncPort]);
  const base = `http://127.0.0.1:${sync.syncPort}`;
  const response = await fetch(`${base}/snapshot`);
  assert.equal(response.status, 200);
  assert.equal((await response.json()).usage.accounts[0].allTime.tokens, 10);
  assert.equal((await fetch(`${base}/snapshot`, { method: 'POST' })).status, 404);
  assert.equal((await fetch(`${base}/api/refresh-limits`)).status, 404);
  await sync.stopSharing();
  const restored = JSON.parse(await readFile(path.join(dir, 'config.json'), 'utf8'));
  assert.deepEqual(restored, { theme: 'existing', tunnel: { ports: [12345] } });
});
