const assert = require('node:assert/strict');
const { mkdtemp, mkdir, rm, writeFile } = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const { detectAccounts } = require('../server');

test('detectAccounts detects opencode and antigravity accounts without failing on large DB files', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'cc-usage-detect-'));
  const oldHome = process.env.CC_USAGE_HOME;
  const oldDataHome = process.env.XDG_DATA_HOME;
  const oldDisabled = process.env.CC_USAGE_DISABLED_PROVIDERS;

  try {
    const dataHome = path.join(root, 'share');
    await mkdir(path.join(dataHome, 'opencode'), { recursive: true });
    await mkdir(path.join(dataHome, 'opencode2'), { recursive: true });
    await writeFile(path.join(dataHome, 'opencode', 'opencode.db'), 'fake-db-header');
    await writeFile(path.join(dataHome, 'opencode2', 'opencode.db'), 'fake-db-header');

    // Create antigravity token
    await mkdir(path.join(root, '.gemini', 'antigravity-cli'), { recursive: true });
    await writeFile(
      path.join(root, '.gemini', 'antigravity-cli', 'antigravity-oauth-token'),
      JSON.stringify({ token: { access_token: 'fake-access', refresh_token: 'fake-refresh', expiry: '2099-01-01T00:00:00Z' } }),
    );

    process.env.CC_USAGE_HOME = root;
    process.env.XDG_DATA_HOME = dataHome;
    delete process.env.CC_USAGE_DISABLED_PROVIDERS;

    const accounts = await detectAccounts();
    const providers = accounts.map((a) => a.provider);

    assert.ok(providers.includes('opencode'), 'opencode should be detected');
    assert.ok(providers.includes('antigravity'), 'antigravity should be detected');

    const opencodeAccounts = accounts.filter((a) => a.provider === 'opencode');
    assert.equal(opencodeAccounts.length, 2, 'both opencode profiles should be detected');
    assert.ok(opencodeAccounts.some((a) => a.id === 'opencode-default'));
    assert.ok(opencodeAccounts.some((a) => a.id === 'opencode-2' || a.id === 'opencode-opencode2'));
  } finally {
    if (oldHome == null) delete process.env.CC_USAGE_HOME;
    else process.env.CC_USAGE_HOME = oldHome;
    if (oldDataHome == null) delete process.env.XDG_DATA_HOME;
    else process.env.XDG_DATA_HOME = oldDataHome;
    if (oldDisabled == null) delete process.env.CC_USAGE_DISABLED_PROVIDERS;
    else process.env.CC_USAGE_DISABLED_PROVIDERS = oldDisabled;
    await rm(root, { recursive: true, force: true });
  }
});

test('detectAccounts respects CC_USAGE_DISABLED_PROVIDERS for opencode and antigravity', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'cc-usage-detect-dis-'));
  const oldHome = process.env.CC_USAGE_HOME;
  const oldDataHome = process.env.XDG_DATA_HOME;
  const oldDisabled = process.env.CC_USAGE_DISABLED_PROVIDERS;

  try {
    const dataHome = path.join(root, 'share');
    await mkdir(path.join(dataHome, 'opencode'), { recursive: true });
    await writeFile(path.join(dataHome, 'opencode', 'opencode.db'), 'fake-db-header');

    await mkdir(path.join(root, '.gemini', 'antigravity-cli'), { recursive: true });
    await writeFile(
      path.join(root, '.gemini', 'antigravity-cli', 'antigravity-oauth-token'),
      JSON.stringify({ token: { access_token: 'fake-access', refresh_token: 'fake-refresh', expiry: '2099-01-01T00:00:00Z' } }),
    );

    process.env.CC_USAGE_HOME = root;
    process.env.XDG_DATA_HOME = dataHome;
    process.env.CC_USAGE_DISABLED_PROVIDERS = 'opencode,antigravity';

    const accounts = await detectAccounts();
    const providers = accounts.map((a) => a.provider);

    assert.ok(!providers.includes('opencode'), 'opencode should be excluded');
    assert.ok(!providers.includes('antigravity'), 'antigravity should be excluded');
  } finally {
    if (oldHome == null) delete process.env.CC_USAGE_HOME;
    else process.env.CC_USAGE_HOME = oldHome;
    if (oldDataHome == null) delete process.env.XDG_DATA_HOME;
    else process.env.XDG_DATA_HOME = oldDataHome;
    if (oldDisabled == null) delete process.env.CC_USAGE_DISABLED_PROVIDERS;
    else process.env.CC_USAGE_DISABLED_PROVIDERS = oldDisabled;
    await rm(root, { recursive: true, force: true });
  }
});
