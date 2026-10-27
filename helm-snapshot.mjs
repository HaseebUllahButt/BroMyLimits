// Read the add-on's fixed, read-only loopback endpoint through Helm's tunnel.
// Provider credentials stay on their original machines; no SSH server needed.
import { pathToFileURL } from 'node:url';
import { join } from 'node:path';
import { PassThrough, Writable } from 'node:stream';
const [source, machine, port = '47292'] = process.argv.slice(2);
const load = relative => import(pathToFileURL(join(source, relative)).href);
try {
  const { loadNetwork, hubCredential, allEndpoints } = await load('packages/protocol/network.js');
  const { bridge } = await load('packages/connect/src/proxy.js');
  const net = loadNetwork();
  if (!net?.machines?.[machine] || net.revoked?.[machine]) throw new Error('Not a Helm member');
  let result;
  for (const hub of [...new Set([`http://127.0.0.1:${net.port ?? 8787}`, ...allEndpoints(net)])]) {
    for (const route of ['/helm/ws', '/ws']) {
      const input = new PassThrough();
      const chunks = [];
      let bytes = 0;
      const output = new Writable({ write(chunk, _encoding, callback) {
        bytes += chunk.length;
        if (bytes > 16 * 1024 * 1024) return callback(new Error('Snapshot exceeds 16 MB'));
        chunks.push(chunk); callback();
      } });
      input.write('GET /snapshot HTTP/1.0\r\nHost: localhost\r\nConnection: close\r\n\r\n');
      try {
        await bridge(hub, await hubCredential(net, hub), machine, Number(port), { path: route, input, output, timeout: 3000 });
        const response = Buffer.concat(chunks).toString('utf8');
        const split = response.indexOf('\r\n\r\n');
        if (!/^HTTP\/1\.[01] 200\b/.test(response) || split < 0) throw new Error('Snapshot unavailable');
        result = JSON.parse(response.slice(split + 4));
        break;
      } catch (error) {
        if (error.established) throw error;
        if (!error.legacyPath) break;
      } finally { input.destroy(); output.destroy(); }
    }
    if (result) break;
  }
  if (!result) throw new Error('No reachable add-on snapshot');
  process.stdout.write(JSON.stringify(result));
} catch (error) {
  process.stderr.write(`Bro My Limits snapshot: ${error.message}\n`);
  process.exitCode = 1;
}
