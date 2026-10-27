const test = require('node:test');
const assert = require('node:assert/strict');
const { mkdtemp, readFile, access, rm } = require('node:fs/promises');
const { tmpdir } = require('node:os');
const path = require('node:path');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const exec = promisify(execFile);

test('a clean install contains every runtime module, starts, and retains usage data on update', async t => {
  const root = await mkdtemp(path.join(tmpdir(), 'bml-install-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const app = path.join(root, 'app');
  const env = { ...process.env, CC_USAGE_HOME: root, CC_USAGE_INSTALL_DIR: app, CC_USAGE_BIN_DIR: path.join(root, 'bin') };
  const args = [path.resolve(__dirname, '../install.js'), '--skip-deps', '--no-service', '--no-statusline', '--no-browser'];
  await exec(process.execPath, args, { env });
  for (const file of ['limit-history.js', 'helm-sync.js', 'helm-usage.mjs', 'scan-cache.js', 'cli.js', 'public/provider-groups.js']) await access(path.join(app, file));
  await exec(process.execPath, ['-e', 'require("./server")'], { cwd: app, env });
  const { writeFile } = require('node:fs/promises');
  await writeFile(path.join(app, 'helm-cache.json'), '{"retained":true}');
  await writeFile(path.join(app, 'limit-history.jsonl'), 'local-history\n');
  await exec(process.execPath, args, { env });
  assert.equal(await readFile(path.join(app, 'helm-cache.json'), 'utf8'), '{"retained":true}');
  assert.equal(await readFile(path.join(app, 'limit-history.jsonl'), 'utf8'), 'local-history\n');
  if (process.platform !== 'win32') {
    const { stdout } = await exec(path.join(root, 'bin', 'bro-my-limits'), ['--help'], { env });
    assert.match(stdout, /install-mesh/);
  }
});

test('piped bootstrap downloads an archive and cleans its temporary directory', { skip: process.platform === 'win32' }, async t => {
  const { mkdir, writeFile, readdir } = require('node:fs/promises');
  const { spawn } = require('node:child_process');
  const root = await mkdtemp(path.join(tmpdir(), 'bml-bootstrap-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const stage = path.join(root, 'stage');
  const downloads = path.join(root, 'downloads');
  const fakeBin = path.join(root, 'fake-bin');
  await Promise.all([mkdir(downloads), mkdir(fakeBin)]);
  const env = { ...process.env, CC_USAGE_HOME: root, CC_USAGE_INSTALL_DIR: stage, CC_USAGE_BIN_DIR: path.join(root, 'bin') };
  await exec(process.execPath, [path.resolve(__dirname, '../install.js'), '--skip-deps', '--no-service', '--no-statusline', '--no-browser'], { env });
  const archive = path.join(root, 'source.tar.gz');
  await exec('tar', ['-czf', archive, '-C', root, 'stage']);
  await writeFile(path.join(fakeBin, 'curl'), '#!/bin/sh\nwhile [ "$#" -gt 0 ]; do if [ "$1" = "-o" ]; then shift; cp "$BML_TEST_ARCHIVE" "$1"; exit; fi; shift; done\nexit 1\n', { mode: 0o755 });
  const script = await readFile(path.resolve(__dirname, '../install.sh'), 'utf8');
  await new Promise((resolve, reject) => {
    const child = spawn('sh', ['-s', '--', '--skip-deps', '--no-service', '--no-statusline', '--no-browser'], {
      cwd: root, env: { ...env, CC_USAGE_INSTALL_DIR: path.join(root, 'installed'), TMPDIR: downloads,
        PATH: `${fakeBin}${path.delimiter}${process.env.PATH}`, BML_TEST_ARCHIVE: archive },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let output = '';
    child.stdout.on('data', b => { output += b; });
    child.stderr.on('data', b => { output += b; });
    child.on('error', reject);
    child.on('close', code => code === 0 ? resolve() : reject(new Error(output)));
    child.stdin.end(script);
  });
  await access(path.join(root, 'installed', 'server.js'));
  await access(path.join(root, 'installed', 'limit-history.js'));
  assert.deepEqual(await readdir(downloads), []);
});
