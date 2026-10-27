#!/usr/bin/env node
'use strict';

const { spawn, spawnSync } = require('node:child_process');
const { mkdtemp, rm, writeFile } = require('node:fs/promises');
const { tmpdir } = require('node:os');
const path = require('node:path');
const { HelmSync, sshArgs } = require('./helm-sync');

const FILES = ['server.js', 'helm-sync.js', 'helm-usage.mjs', 'helm-snapshot.mjs', 'cli.js', 'scan-cache.js', 'limit-history.js',
  'profile-discovery.js', 'ccusage-runner.js', 'statusline.js', 'configure-statusline.js',
  'install.js', 'install.sh', 'install.ps1', 'uninstall.js', 'uninstall.sh', 'package.json', 'README.md', 'public'];

async function installMesh(target) {
  const bridge = new HelmSync();
  const net = await bridge.network();
  if (!net) throw new Error('Join a Helm network before installing on its devices.');
  if (target && !Object.entries(net.machines).some(([id, p]) => (p.name === target || id === target) && id !== net.self && !net.revoked?.[id])) throw new Error('No matching remote machine in this Helm network');
  const dir = await mkdtemp(path.join(tmpdir(), 'bro-my-limits-mesh-'));
  let failures = 0;
  try {
    const archive = path.join(dir, 'app.tar.gz');
    const tar = spawnSync('tar', ['-czf', archive, '-C', __dirname, ...FILES], { stdio: 'inherit' });
    if (tar.status !== 0) throw new Error('Could not package Bro My Limits (tar is required).');
    for (const [id, peer] of Object.entries(net.machines)) {
      if (id === net.self || net.revoked?.[id] || (target && peer.name !== target && id !== target)) continue;
      console.log(`Installing on ${peer.name} through Helm…`);
      // No provider credentials, caches, or histories are in this archive.
      const command = 'set -eu; setup_dir=$(mktemp -d); trap \'rm -rf "$setup_dir"\' EXIT; tar -xzf - -C "$setup_dir"; sh "$setup_dir/install.sh" --no-browser --no-statusline';
      try {
        await new Promise((resolve, reject) => {
          const child = spawn('ssh', [...sshArgs(peer, bridge.source, bridge.helmDir), command], { stdio: ['pipe', 'inherit', 'inherit'] });
          const input = require('node:fs').createReadStream(archive);
          const timer = setTimeout(() => child.kill('SIGTERM'), 180_000);
          input.on('error', reject);
          child.stdin.on('error', () => {});
          child.on('error', reject);
          child.on('close', code => { clearTimeout(timer); input.destroy(); code === 0 ? resolve() : reject(new Error(`SSH/install exited ${code}`)); });
          input.pipe(child.stdin);
        });
      } catch (error) {
        failures++;
        console.error(`${peer.name}: ${error.message}. Re-run install-mesh when this device is reachable.`);
      }
    }
  } finally { await rm(dir, { recursive: true, force: true }); }
  if (failures) process.exitCode = 1;
}

async function update(mesh) {
  const dir = await mkdtemp(path.join(tmpdir(), 'bro-my-limits-update-'));
  try {
    const response = await fetch('https://raw.githubusercontent.com/HaseebUllahButt/BroMyLimits/main/install.sh', { signal: AbortSignal.timeout(30_000) });
    if (!response.ok) throw new Error(`Installer download failed (${response.status})`);
    const script = path.join(dir, 'install.sh');
    await writeFile(script, await response.text());
    const result = spawnSync('sh', [script, '--no-browser', '--no-statusline'], { stdio: 'inherit' });
    if (result.status !== 0) throw new Error('Update failed');
  } finally { await rm(dir, { recursive: true, force: true }); }
  if (mesh) await installMesh();
}

async function main() {
  const [command = 'start', ...args] = process.argv.slice(2);
  if (command === 'install-mesh') return installMesh(args[0]);
  if (command === 'update') return update(args.includes('--mesh'));
  if (command === 'status') {
    const res = await fetch(`http://127.0.0.1:${process.env.PORT || 47291}/api/usage`, { signal: AbortSignal.timeout(10_000) });
    const data = await res.json();
    console.log(JSON.stringify({ mode: data.mesh?.mode || 'standalone', devices: data.mesh?.devices || [], accounts: data.accounts?.length }, null, 2));
    return;
  }
  if (command === '--help' || command === 'help') {
    console.log('bro-my-limits [start [port] | status | update [--mesh] | install-mesh [machine]]');
    return;
  }
  if (command !== 'start' && !/^\d+$/.test(command)) throw new Error(`Unknown command: ${command}`);
  const port = command === 'start' ? args[0] : command;
  const child = spawn(process.execPath, ['--max-old-space-size=80', '--max-semi-space-size=8', path.join(__dirname, 'server.js')],
    { stdio: 'inherit', env: { ...process.env, ...(port ? { PORT: port } : {}) } });
  for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => child.kill(signal));
  child.on('error', error => { console.error(error.message); process.exitCode = 1; });
  child.on('close', code => { process.exitCode = code ?? 1; });
}
main().catch(error => { console.error(`Bro My Limits: ${error.message}`); process.exitCode = 1; });
