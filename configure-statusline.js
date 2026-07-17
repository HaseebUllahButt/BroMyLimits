#!/usr/bin/env node
const fs = require('node:fs');

const [, , settingsPath, nodePath, statuslinePath, accountLabel] = process.argv;
if (!settingsPath || !nodePath || !statuslinePath || !accountLabel) {
  process.exit(2);
}

let settings = {};
try {
  settings = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
} catch (error) {
  if (error.code !== 'ENOENT') throw error;
}

const shellQuote = (value) => `'${String(value).replace(/'/g, `'\\''`)}'`;
const command = `${shellQuote(nodePath)} ${shellQuote(statuslinePath)} ${shellQuote(accountLabel)}`;

if (fs.existsSync(settingsPath)) {
  const backupPath = `${settingsPath}.cc-usage-backup`;
  if (!fs.existsSync(backupPath)) fs.copyFileSync(settingsPath, backupPath);
}

settings.statusLine = { type: 'command', command };
fs.writeFileSync(settingsPath, `${JSON.stringify(settings, null, 2)}\n`);
