#!/usr/bin/env node
// Claude Code statusline hook. Captures rate_limits (pushed fresh on stdin
// after every prompt — no extra API call) and persists them for
// cc-usage-dashboard to read, then prints a normal status line.
//
// Installed per-account with the account id as argv[2], e.g.:
//   "command": "node /path/to/statusline.js personal"
// writing to claude-live-limits-claude-<id>.json next to this script.
//
// Claude can inherit the default account's statusLine setting even when it is
// launched with CLAUDE_CONFIG_DIR for another account. Prefer that environment
// variable over the installed label so inherited settings cannot attribute one
// account's limits to another.
const fs = require('fs');
const path = require('path');

function accountLabelFromConfigDir(configDir) {
  if (!configDir) return null;
  const name = path.basename(path.resolve(configDir));
  if (name === '.claude') return 'default';
  if (name.startsWith('.claude-') && name.length > '.claude-'.length) {
    return name.slice('.claude-'.length);
  }
  return null;
}

function main() {
  const installedLabel = process.argv[2] || 'default';
  const accountLabel = accountLabelFromConfigDir(process.env.CLAUDE_CONFIG_DIR) || installedLabel;
  const accountId = `claude-${accountLabel}`;
  const SNAPSHOT_PATH = path.join(__dirname, `claude-live-limits-${accountId}.json`);

  let raw = '';
  process.stdin.on('data', (c) => (raw += c));
  process.stdin.on('end', () => {
    let data;
    try {
      data = JSON.parse(raw);
    } catch {
      console.log('');
      return;
    }

    const model = data.model?.display_name || '';
    const dir = (data.workspace?.current_dir || '').split('/').pop();
    const rl = data.rate_limits || {};
    const fiveH = rl.five_hour?.used_percentage;
    const week = rl.seven_day?.used_percentage;

    if (fiveH != null || week != null) {
      const snapshot = {
        accountId,
        fetchedAtMs: Date.now(),
        session: fiveH != null
          ? { percent: Math.round(fiveH), resetsAt: rl.five_hour.resets_at ? new Date(rl.five_hour.resets_at * 1000).toISOString() : null }
          : null,
        weekly: week != null
          ? { percent: Math.round(week), resetsAt: rl.seven_day.resets_at ? new Date(rl.seven_day.resets_at * 1000).toISOString() : null }
          : null,
      };
      try {
        fs.writeFileSync(SNAPSHOT_PATH, JSON.stringify(snapshot));
      } catch {}
    }

    const parts = [];
    if (model) parts.push(model);
    if (dir) parts.push(dir);
    if (fiveH != null) parts.push(`5h ${Math.round(fiveH)}%`);
    if (week != null) parts.push(`7d ${Math.round(week)}%`);
    console.log(parts.join(' · '));
  });
}

if (require.main === module) main();

module.exports = { accountLabelFromConfigDir };
