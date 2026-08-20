const assert = require('node:assert/strict');
const { mkdtemp, mkdir, rm, writeFile } = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const { detectProfileAccounts } = require('../profile-discovery');

test('CC_USAGE_DISABLED_PROVIDERS excludes historical profiles without deleting them', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'cc-usage-profiles-'));
  const oldHome = process.env.CC_USAGE_HOME;
  const oldDisabled = process.env.CC_USAGE_DISABLED_PROVIDERS;
  try {
    await mkdir(path.join(root, '.claude', 'projects'), { recursive: true });
    await writeFile(path.join(root, '.claude', 'projects', 'old-session.jsonl'), '{}\n');
    await mkdir(path.join(root, '.codex', 'sessions'), { recursive: true });
    await writeFile(path.join(root, '.codex', 'auth.json'), '{}\n');

    process.env.CC_USAGE_HOME = root;
    process.env.CC_USAGE_DISABLED_PROVIDERS = 'claude';
    const accounts = await detectProfileAccounts();

    assert.deepEqual(accounts.map((account) => account.provider), ['codex']);
  } finally {
    if (oldHome == null) delete process.env.CC_USAGE_HOME;
    else process.env.CC_USAGE_HOME = oldHome;
    if (oldDisabled == null) delete process.env.CC_USAGE_DISABLED_PROVIDERS;
    else process.env.CC_USAGE_DISABLED_PROVIDERS = oldDisabled;
    await rm(root, { recursive: true, force: true });
  }
});
