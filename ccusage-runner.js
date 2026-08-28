const { execFile: nodeExecFile } = require('node:child_process');
const { existsSync } = require('node:fs');
const path = require('node:path');

function resolveCcusageCommand({
  rootDir = __dirname,
  platform = process.platform,
  arch = process.arch,
  env = process.env,
} = {}) {
  if (env.CCUSAGE_BIN) return env.CCUSAGE_BIN;

  if (platform === 'win32') {
    // .cmd shims cannot be passed directly to execFile on Windows. Prefer
    // ccusage's native binary when npm installed its optional dependency.
    const native = path.join(
      rootDir,
      'node_modules',
      '@ccusage',
      `ccusage-win32-${arch}`,
      'bin',
      'ccusage.exe',
    );
    if (existsSync(native)) return native;
  }

  const local = path.join(
    rootDir,
    'node_modules',
    '.bin',
    platform === 'win32' ? 'ccusage.cmd' : 'ccusage',
  );
  if (existsSync(local)) return local;
  return platform === 'win32' ? 'ccusage.cmd' : 'ccusage';
}

function requiresShell(command, platform = process.platform) {
  return platform === 'win32' && /\.(?:cmd|bat)$/i.test(String(command));
}

function runCcusage(args, env, {
  command = resolveCcusageCommand(),
  platform = process.platform,
  execFileImpl = nodeExecFile,
} = {}) {
  return new Promise((resolve, reject) => {
    execFileImpl(command, args, {
      maxBuffer: 1024 * 1024 * 32,
      timeout: 30000,
      windowsHide: true,
      shell: requiresShell(command, platform),
      resourceLimits: { maxOldGenerationSizeMb: 512, maxYoungGenerationSizeMb: 16 },
      env: { ...process.env, ...env },
    }, (err, stdout, stderr) => {
      if (err) {
        const detail = String(stderr || '').trim();
        if (detail) err.message = `${err.message}: ${detail.slice(0, 1000)}`;
        return reject(err);
      }
      try {
        resolve(JSON.parse(stdout));
      } catch (error) {
        reject(error);
      }
    });
  });
}

module.exports = { resolveCcusageCommand, requiresShell, runCcusage };
