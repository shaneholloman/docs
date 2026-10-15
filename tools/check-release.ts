import assert from 'node:assert/strict';
import http from 'node:http';
import { once } from 'node:events';
import { z } from 'zod';
import { statusSchema, answerResultSchema } from '../src/shared/aria-contracts.ts';
import { createVisitorStore } from '../src/server/aria-memory.ts';
import type * as Server from '../src/server/aria-server.ts';
import type * as Gateway from '../src/server/aria-preview.ts';

const manifest = z
  .strictObject({
    runtime: z.literal('bun@1.4.3'),
    files: z.record(z.string(), z.string().regex(/^[a-f0-9]{64}$/))
  })
  .parse(await Bun.file('dist/manifest.json').json());
for (const [name, digest] of Object.entries(manifest.files)) {
  const file = Bun.file(`dist/${name}`);
  assert.equal(
    new Bun.CryptoHasher('sha256').update(await file.arrayBuffer()).digest('hex'),
    digest,
    `Release digest: ${name}`
  );
}
assert.equal(
  await Bun.file('header.js').text(),
  await Bun.file('dist/client/header.js').text(),
  'Mintlify header must match the client distribution'
);

const serverModule = (await import(
  new URL('../dist/server/aria-server.js', import.meta.url).href
)) as typeof Server;
const gatewayModule = (await import(
  new URL('../dist/server/aria-preview.js', import.meta.url).href
)) as typeof Gateway;
const server = serverModule.createAriaServer({
  memory: createVisitorStore(':memory:'),
  subscription: async () => ({ token: 'offline-release-fixture' }),
  ask: async ({ knowledge }) => {
    assert.match(knowledge, /Shane Holloman/);
    assert.match(knowledge, /Cello Group/);
    assert.match(knowledge, /8i/);
    return 'Shane leads AI at Cello Group and previously led IT at 8i.';
  }
});
server.listen(0, '127.0.0.1');
await once(server, 'listening');
const address = server.address();
assert.ok(address && typeof address !== 'string');
const gateway = gatewayModule.createPreviewServer({
  ariaPort: address.port,
  siteOrigin: 'https://shaneholloman.dev'
});
gateway.listen(0, '127.0.0.1');
await once(gateway, 'listening');
const gatewayAddress = gateway.address();
assert.ok(gatewayAddress && typeof gatewayAddress !== 'string');
const gatewayPort = gatewayAddress.port;

// HTTP's Host header exercises the actual gateway contract without changing DNS.
function request(path: string, body?: unknown): Promise<{ code: number; text: string }> {
  return new Promise((resolve, reject) => {
    const pending = http.request(
      {
        hostname: '127.0.0.1',
        port: gatewayPort,
        path,
        method: body === undefined ? 'GET' : 'POST',
        headers: { Host: 'aria.shaneholloman.dev', 'Content-Type': 'application/json' }
      },
      async (response) => {
        let text = '';
        for await (const chunk of response) text += chunk;
        resolve({ code: response.statusCode || 0, text });
      }
    );
    pending.on('error', reject);
    pending.end(body === undefined ? undefined : JSON.stringify(body));
  });
}
try {
  const status = await request('/aria-api/status');
  assert.equal(status.code, 200);
  const ready = statusSchema.parse(JSON.parse(status.text));
  assert.ok(ready.authenticated && ready.sources >= 1);
  const answer = await request('/aria-api/ask', {
    prompt: 'Describe Shane’s current and previous work.'
  });
  assert.equal(answer.code, 200);
  assert.match(answerResultSchema.parse(JSON.parse(answer.text)).answer, /Cello Group/);
  for (const [route, file] of [
    ['/aria-preview.js', 'dist/client/aria-preview.js'],
    ['/aria-preview.css', 'dist/client/style.css'],
    ['/aria.svg', 'dist/client/aria.svg'],
    ['/favicon.svg', 'dist/client/favicon.svg']
  ]) {
    const result = await request(route);
    assert.equal(result.code, 200, route);
    assert.equal(result.text, await Bun.file(file).text(), route);
  }
  console.log(
    'Release artifacts passed: digests, full CV, gateway, typed answer, and browser assets. No OpenAI calls.'
  );
} finally {
  gateway.close();
  gateway.closeAllConnections();
  server.close();
  server.closeAllConnections();
}
