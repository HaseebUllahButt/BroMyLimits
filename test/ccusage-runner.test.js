const assert = require('node:assert/strict');
const test = require('node:test');

const { requiresShell, runCcusage } = require('../ccusage-runner');

test('Windows native ccusage binaries do not require a shell', () => {
  assert.equal(requiresShell('C:\\app\\ccusage.exe', 'win32'), false);
  assert.equal(requiresShell('C:\\app\\ccusage.cmd', 'win32'), true);
  assert.equal(requiresShell('/app/ccusage', 'linux'), false);
});

test('runCcusage parses JSON and passes the provider home to the child', async () => {
  let seen;
  const result = await runCcusage(['codex', 'session', '--json'], { CODEX_HOME: 'C:\\profile' }, {
    command: 'ccusage.exe',
    platform: 'win32',
    execFileImpl(command, args, options, callback) {
      seen = { command, args, options };
      callback(null, '{"sessions":[]}', '');
    },
  });

  assert.deepEqual(result, { sessions: [] });
  assert.equal(seen.command, 'ccusage.exe');
  assert.deepEqual(seen.args, ['codex', 'session', '--json']);
  assert.equal(seen.options.shell, false);
  assert.equal(seen.options.env.CODEX_HOME, 'C:\\profile');
});

test('runCcusage preserves a useful native error message', async () => {
  await assert.rejects(
    runCcusage([], {}, {
      command: 'ccusage.cmd',
      platform: 'win32',
      execFileImpl(command, args, options, callback) {
        const error = new Error('spawn EINVAL');
        error.code = 'EINVAL';
        callback(error, '', 'ccusage was not found');
      },
    }),
    /spawn EINVAL: ccusage was not found/,
  );
});
