const assert = require('node:assert/strict');
const test = require('node:test');
const https = require('node:https');
const { execFileSync } = require('node:child_process');
const os = require('node:os');
const path = require('node:path');
const { mkdtemp, rm } = require('node:fs/promises');

const { parseAntigravityLocalStatus, postLocalLanguageServer } = require('../server');

// The shape Antigravity's own language server returns from GetUserStatus,
// as the quota extensions read it.
const sample = {
  userStatus: {
    name: 'Someone',
    planStatus: { planInfo: { planName: 'Antigravity Pro' } },
    cascadeModelConfigData: {
      clientModelConfigs: [
        { label: 'Gemini 3.1 Pro (High)', quotaInfo: { remainingFraction: 0.42, resetTime: '2026-09-18T00:00:00Z' } },
        { label: 'Claude Sonnet 4.6 (Thinking)', quotaInfo: { remainingFraction: 1 } },
        // No remainingFraction but a resetTime: the bucket is spent.
        { label: 'GPT-OSS 120B (Medium)', quotaInfo: { resetTime: '2026-09-18T06:00:00Z' } },
        // No quota info at all: not metered, so not a window.
        { label: 'Unmetered Model', quotaInfo: {} },
        { label: 'No Quota Block' },
      ],
    },
  },
};

test('GetUserStatus becomes the same rate-limit shape every other provider uses', () => {
  const out = parseAntigravityLocalStatus(sample);
  assert.equal(out.planLabel, 'Antigravity Pro');
  assert.equal(out.source, 'antigravity-language-server');
  assert.equal(out.live, true);

  const byLabel = Object.fromEntries(out.windows.map((w) => [w.label, w]));
  assert.deepEqual(byLabel['Gemini 3.1 Pro (High)'], {
    label: 'Gemini 3.1 Pro (High)', percent: 58, remainingPercent: 42,
    resetsAt: '2026-09-18T00:00:00Z',
  });
  assert.equal(byLabel['Claude Sonnet 4.6 (Thinking)'].percent, 0, 'a full bucket is 0% used');
  assert.equal(byLabel['GPT-OSS 120B (Medium)'].percent, 100, 'reset time without a fraction means spent');
  assert.equal(byLabel['Unmetered Model'], undefined, 'an unmetered model is not a window');
  assert.equal(byLabel['No Quota Block'], undefined);
  assert.equal(out.windows.length, 3);
});

test('a payload with nothing metered yields null rather than an empty card', () => {
  assert.equal(parseAntigravityLocalStatus({ userStatus: { cascadeModelConfigData: {} } }), null);
  assert.equal(parseAntigravityLocalStatus(null), null);
  assert.equal(parseAntigravityLocalStatus({}), null);
});

test('the loopback POST speaks Connect protocol and accepts a self-signed cert', async (t) => {
  // The real server listens on loopback with its own self-signed certificate,
  // which is why the request must not verify it. Prove both: the headers it
  // expects go out, and a self-signed responder is accepted.
  let key, cert;
  try {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'ag-cert-'));
    const k = path.join(dir, 'k.pem'); const c = path.join(dir, 'c.pem');
    execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes',
      '-keyout', k, '-out', c, '-days', '1', '-subj', '/CN=127.0.0.1'], { stdio: 'ignore' });
    key = require('node:fs').readFileSync(k); cert = require('node:fs').readFileSync(c);
    await rm(dir, { recursive: true, force: true });
  } catch {
    return t.skip('openssl unavailable');
  }

  let seen = null;
  const server = https.createServer({ key, cert }, (req, res) => {
    let body = '';
    req.on('data', (d) => { body += d; });
    req.on('end', () => {
      seen = { url: req.url, headers: req.headers, body: JSON.parse(body) };
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(sample));
    });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const port = server.address().port;

  const data = await postLocalLanguageServer(port, 'tok-123', 'GetUserStatus', {
    metadata: { ideName: 'antigravity', extensionName: 'antigravity', locale: 'en' },
  });
  server.close();

  assert.equal(seen.url, '/exa.language_server_pb.LanguageServerService/GetUserStatus');
  assert.equal(seen.headers['x-codeium-csrf-token'], 'tok-123');
  assert.equal(seen.headers['connect-protocol-version'], '1');
  assert.equal(seen.body.metadata.ideName, 'antigravity');
  assert.equal(parseAntigravityLocalStatus(data).planLabel, 'Antigravity Pro');
});

test('an unreachable port resolves null instead of throwing', async () => {
  // Port scanning tries every listening port the process has; a wrong one
  // must be a quiet miss, not an exception that kills the whole refresh.
  const out = await postLocalLanguageServer(9, 'tok', 'GetUserStatus', {});
  assert.equal(out, null);
});
