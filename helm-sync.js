'use strict';

const { readFile, writeFile, mkdir, rename, rm } = require('node:fs/promises');
const { execFile } = require('node:child_process');
const http = require('node:http');
const { promisify } = require('node:util');
const { createHash } = require('node:crypto');
const path = require('node:path');
const { getHomeDir } = require('./profile-discovery');
const exec = promisify(execFile);
const MAX_BYTES = 16 * 1024 * 1024;
const STALE_MS = 10 * 60_000;
const quote = value => `'${String(value).replace(/'/g, `'"'"'`)}'`;
const remoteId = (machine, account) => `helm-${createHash('sha256').update(`${machine}\0${account}`).digest('hex').slice(0, 24)}`;

async function readJson(file) {
  try { return JSON.parse(await readFile(file, 'utf8')); } catch { return null; }
}
async function atomicJson(file, value) {
  await mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  const tmp = `${file}.${process.pid}.tmp`;
  await writeFile(tmp, JSON.stringify(value), { mode: 0o600 });
  await rename(tmp, file);
}

// Re-evaluate calendar windows for remembered snapshots; yesterday's "today"
// must not stay today's usage when a laptop sleeps overnight.
function currentPeriods(account, now = new Date()) {
  if (!Array.isArray(account.daily)) return account;
  const today = now.toISOString().slice(0, 10);
  const week = new Date(Date.parse(today) - 6 * 86400000).toISOString().slice(0, 10);
  const sum = rows => rows.reduce((s, r) => ({ cost: s.cost + (Number(r.cost) || 0), tokens: s.tokens + (Number(r.tokens) || 0) }), { cost: 0, tokens: 0 });
  return { ...account,
    today: sum(account.daily.filter(r => r.date === today)),
    last7d: sum(account.daily.filter(r => r.date >= week && r.date <= today)),
    month: sum(account.daily.filter(r => r.date.startsWith(today.slice(0, 7)) && r.date <= today)),
  };
}

function validSnapshot(s, net, machine) {
  return s?.version === 1 && s.networkId === net.id && s.machineId === machine
    && Number.isFinite(Date.parse(s.usage?.fetchedAt)) && Array.isArray(s.usage?.accounts)
    && s.usage.accounts.every(a => typeof a.id === 'string' && typeof a.provider === 'string')
    && !s.usage.accounts.some(a => a.machineId || a.remote);
}

function sshArgs(peer, source, helmDir) {
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}$/.test(peer.name || '')
      || !/^[a-z_][a-z0-9_-]{0,31}$/i.test(peer.sshUser || '')) throw new Error('Invalid Helm SSH identity');
  const port = peer.sshPort ?? 22;
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Invalid Helm SSH port');
  return ['-F', process.platform === 'win32' ? 'NUL' : '/dev/null', '-i', path.join(helmDir, 'id_ed25519'),
    '-p', String(port), '-o', 'BatchMode=yes', '-o', 'IdentitiesOnly=yes', '-o', 'ConnectTimeout=30',
    '-o', 'StrictHostKeyChecking=accept-new', '-o', `UserKnownHostsFile=${path.join(helmDir, 'known_hosts')}`,
    '-o', `ProxyCommand=${quote(process.execPath)} ${quote(path.join(source, 'packages/connect/bin/helm.js'))} proxy %h`,
    `${peer.sshUser}@${peer.name}`];
}

class HelmSync {
  constructor({ home = getHomeDir(), helmDir = process.env.HELM_DIR || path.join(home, '.helm'),
    source = process.env.BRO_MY_LIMITS_HELM_SOURCE || process.env.HELM_INSTALL_DIR || path.join(home, '.helm-src'),
    cachePath = path.join(__dirname, 'helm-cache.json'), mode = process.env.BRO_MY_LIMITS_HELM || 'auto',
    peersOnly = process.env.BRO_MY_LIMITS_HELM_PEERS_ONLY === '1', syncPort = Number(process.env.BRO_MY_LIMITS_SYNC_PORT || 47292), readPeer, readReport } = {}) {
    Object.assign(this, { helmDir, source, cachePath, mode, peersOnly, syncPort });
    this.snapshotPath = path.join(helmDir, 'bro-my-limits.json');
    this.readPeer = readPeer || (async (peer, machine) => {
      try {
        const { stdout } = await exec(process.execPath, [path.join(__dirname, 'helm-snapshot.mjs'), source, machine, String(this.syncPort)],
          { timeout: 20_000, maxBuffer: MAX_BYTES, windowsHide: true, env: { ...process.env, HELM_DIR: helmDir } });
        return JSON.parse(stdout);
      } catch { /* Compatibility with earlier installs that only shared files. */ }
      const { stdout } = await exec('ssh', [...sshArgs(peer, source, helmDir),
        'cat "${HELM_DIR:-$HOME/.helm}/bro-my-limits.json"'], { timeout: 40_000, maxBuffer: MAX_BYTES, windowsHide: true });
      return JSON.parse(stdout);
    });
    this.readReport = readReport || (async machine => {
      const { stdout } = await exec(process.execPath, [path.join(__dirname, 'helm-usage.mjs'), source, machine],
        { timeout: 35_000, maxBuffer: MAX_BYTES, windowsHide: true, env: { ...process.env, HELM_DIR: helmDir } });
      return JSON.parse(stdout);
    });
    this.peers = {};
    this.lastSync = 0;
    this.inflight = null;
    this.error = null;
  }

  async network() {
    if (this.mode === 'off') return null;
    const net = await readJson(path.join(this.helmDir, 'network.json'));
    return net?.id && net.machines?.[net.self] && !net.revoked?.[net.self] ? net : null;
  }

  async ensureSharing() {
    if (this.sharing) return;
    if (!await this.network()) return;
    if (!Number.isInteger(this.syncPort) || this.syncPort < 1024 || this.syncPort > 65535) throw new Error('Invalid Bro My Limits sync port');
    const listener = http.createServer(async (req, res) => {
      if (req.method !== 'GET' || req.url !== '/snapshot' || !await this.network()) { res.writeHead(404); res.end(); return; }
      const snapshot = await readJson(this.snapshotPath);
      const net = await this.network();
      if (!snapshot || snapshot.networkId !== net?.id || snapshot.machineId !== net?.self) { res.writeHead(503); res.end(); return; }
      const data = JSON.stringify(snapshot);
      res.writeHead(200, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data), 'Cache-Control': 'no-store' });
      res.end(data);
    });
    await new Promise((resolve, reject) => { listener.once('error', reject); listener.listen(this.syncPort, '127.0.0.1', resolve); });
    listener.unref();
    try {
      const configPath = path.join(this.helmDir, 'config.json');
      let config;
      try { config = JSON.parse(await readFile(configPath, 'utf8')); } catch (e) { if (e.code !== 'ENOENT') throw e; config = {}; }
      const ports = config.tunnel?.ports || [];
      if (!ports.includes(this.syncPort)) {
        config.tunnel = { ...config.tunnel, ports: [...ports, this.syncPort] };
        await atomicJson(configPath, config);
        await atomicJson(path.join(this.helmDir, 'bro-my-limits-port.json'), { port: this.syncPort });
      }
      this.sharing = listener;
    } catch (e) { listener.close(); throw e; }
  }

  async publish(usage, history) {
    const net = await this.network();
    if (!net) return;
    // Export only this machine's own result. Aggregated responses never enter
    // a peer snapshot or the local limit ledger, preventing mesh feedback loops.
    await atomicJson(this.snapshotPath, { version: 1, networkId: net.id, machineId: net.self,
      usage: { fetchedAt: usage.fetchedAt, accounts: usage.accounts }, history });
  }

  async sync(net) {
    this.networkId ??= net.id;
    if (this.inflight) return this.inflight;
    this.inflight = this.refresh(net).catch(e => { this.error = e.message; }).finally(() => {
      this.lastSync = Date.now(); this.inflight = null;
    });
    return this.inflight;
  }

  async refresh(net) {
    if (!this.loaded) {
      const disk = await readJson(this.cachePath);
      if (disk?.networkId === net.id) this.peers = disk.peers || {};
      this.loaded = true;
    }
    const peers = { ...this.peers };
    const wanted = Object.entries(net.machines).filter(([id]) => id !== net.self && !net.revoked?.[id]);
    for (const id of Object.keys(peers)) if (!wanted.some(([key]) => key === id)) delete peers[id];
    await Promise.all(wanted.map(async ([id, peer]) => {
      let snapshot;
      try {
        snapshot = await this.readPeer(peer, id);
        if (!validSnapshot(snapshot, net, id)) throw new Error('Incompatible Bro My Limits snapshot');
        peers[id] = { snapshot, source: 'bro-my-limits', checkedAt: Date.now(), stale: false };
        return;
      } catch { /* An older install, sleeping machine, or Helm-only peer. */ }
      const prior = peers[id];
      // Keep richer last-known data, but explicitly mark that it could not be refreshed.
      if (prior?.source === 'bro-my-limits') {
        prior.stale = true;
        prior.error = 'Could not refresh Bro My Limits on this device';
        return;
      }
      if (!this.peersOnly) {
        try {
          const usage = await this.readReport(id);
          if (!Array.isArray(usage.accounts) || !Number.isFinite(Date.parse(usage.fetchedAt))) throw new Error('Invalid Helm usage report');
          peers[id] = { snapshot: { usage }, source: 'helm', checkedAt: Date.now(), stale: !!usage.stale };
          return;
        } catch { /* Keep the last observation if the mesh is unreachable. */ }
      }
      peers[id] = { ...prior, stale: true, error: 'No reachable usage source' };
    }));
    if ((await this.network())?.id !== net.id) return;
    this.peers = peers;
    await atomicJson(this.cachePath, { networkId: net.id, peers });
    this.error = null;
  }

  async view(local, { wait = false } = {}) {
    const net = await this.network();
    if (!net) return { ...local, mesh: { mode: 'standalone', devices: [] } };
    if (this.networkId !== net.id) {
      this.peers = {}; this.loaded = false; this.lastSync = 0; this.networkId = net.id;
    }
    if (Date.now() - this.lastSync > 60_000) {
      const work = this.sync(net);
      if (wait) await work;
    }
    const accounts = local.accounts.map(a => ({ ...a, machineId: net.self, machineName: net.machines[net.self].name, remote: false }));
    const devices = [{ id: net.self, name: net.machines[net.self].name, source: 'bro-my-limits', local: true,
      fetchedAt: local.fetchedAt, stale: !!local.cache?.stale, accounts: local.accounts.length }];
    for (const [id, machine] of Object.entries(net.machines)) {
      if (id === net.self || net.revoked?.[id]) continue;
      const peer = this.peers[id];
      const usage = peer?.snapshot?.usage;
      const included = !!usage && (!this.peersOnly || peer.source === 'bro-my-limits');
      const stale = !!peer?.stale || Date.now() - Date.parse(usage?.fetchedAt) > STALE_MS;
      devices.push({ id, name: machine.name, source: peer?.source || null, stale, accounts: included ? usage.accounts.length : 0,
        fetchedAt: usage?.fetchedAt || null, status: included ? (stale ? 'cached' : 'connected') : 'unavailable', error: peer?.error });
      if (!included) continue;
      for (const a of usage.accounts) accounts.push({ ...currentPeriods(a), id: remoteId(id, a.id), localAccountId: a.id,
        machineId: id, machineName: machine.name, remote: true, stale, source: peer.source, fetchedAt: usage.fetchedAt });
    }
    return { ...local, accounts, mesh: { mode: 'helm', devices, syncing: !!this.inflight, lastSync: this.lastSync || null, error: this.error } };
  }

  async history(local) {
    const net = await this.network();
    if (!net || this.networkId !== net.id) return local;
    const accounts = [...(local.accounts || [])];
    for (const [id, peer] of Object.entries(this.peers)) {
      if (!net.machines[id] || net.revoked?.[id] || peer.source !== 'bro-my-limits') continue;
      for (const a of peer.snapshot?.history?.accounts || []) accounts.push({ ...a, id: remoteId(id, a.id) });
    }
    return { ...local, accounts };
  }

  async stopSharing() {
    this.sharing?.close(); this.sharing = null;
    const markerPath = path.join(this.helmDir, 'bro-my-limits-port.json');
    const marker = await readJson(markerPath);
    if (marker?.port) {
      const configPath = path.join(this.helmDir, 'config.json');
      const config = await readJson(configPath);
      if (Array.isArray(config?.tunnel?.ports)) {
        config.tunnel.ports = config.tunnel.ports.filter(port => port !== marker.port);
        await atomicJson(configPath, config);
      }
      await rm(markerPath, { force: true });
    }
    await rm(this.snapshotPath, { force: true });
  }
}

module.exports = { HelmSync, currentPeriods, validSnapshot, remoteId, sshArgs, atomicJson };
