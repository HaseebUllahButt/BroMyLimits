const assert = require('node:assert/strict');
const test = require('node:test');

const { accountLabelFromConfigDir } = require('../statusline');

test('CLAUDE_CONFIG_DIR identifies the active account independently of an inherited setting', () => {
  assert.equal(accountLabelFromConfigDir('/home/example/.claude'), 'default');
  assert.equal(accountLabelFromConfigDir('/home/example/.claude-personal'), 'personal');
  assert.equal(accountLabelFromConfigDir('/home/example/.claude-work'), 'work');
});
