import assert from 'node:assert/strict';
import { once } from 'node:events';
import { resolve } from 'node:path';
import type * as Server from '../src/server/aria-server.ts';

if (!process.argv.includes('--inside')) {
  const image = process.argv[2] || 'shane-cv-aria:preview';
  if (!/^shane-cv-aria:[a-zA-Z0-9._-]+$/.test(image)) throw new Error('Invalid release image.');
  const child = Bun.spawn(
    [
      'docker',
      'run',
      '--rm',
      '--platform',
      'linux/amd64',
      '--network',
      'none',
      '--read-only',
      '--tmpfs',
      '/tmp:size=32m,mode=1777',
      '-e',
      'ARIA_MEMORY_DB=/tmp/aria-check.sqlite',
      '-v',
      `${resolve('tools/check-container.ts')}:/tmp/check-container.ts:ro`,
      image,
      'bun',
      '/tmp/check-container.ts',
      '--inside'
    ],
    { stdout: 'inherit', stderr: 'inherit' }
  );
  process.exitCode = await child.exited;
} else {
  const moduleUrl = 'file:///app/dist/server/aria-server.js';
  const { createAriaServer } = (await import(moduleUrl)) as typeof Server;
  const server = createAriaServer({
    subscription: async () => ({ token: 'offline-container-fixture' }),
    ask: async ({ lookup }) => {
      assert.deepEqual(
        lookup?.tools.map((tool) => tool.name),
        ['KnowledgeQuery', 'AriaQuery']
      );
      const result = JSON.parse(
        lookup!.execute('AriaQuery', {
          mode: 'search',
          query: 'voice WebRTC'
        })
      );
      assert.equal(result.ok, true);
      assert.ok(result.readback.items.length > 0);
      const page = JSON.parse(
        lookup!.execute('AriaQuery', {
          mode: 'reference',
          reference_kind: 'primitive',
          reference_id: 'voice'
        })
      );
      assert.equal(page.page.slug, 'primitive-voice');
      assert.match(page.page.content, /WebRTC/);
      return 'Native Guide retrieval passed.';
    }
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  try {
    const address = server.address();
    assert.ok(address && typeof address !== 'string');
    const origin = `http://127.0.0.1:${address.port}`;
    const status = (await (await fetch(`${origin}/status`)).json()) as {
      authenticated: boolean;
      sources: number;
    };
    assert.ok(status.authenticated && status.sources >= 182);
    const response = await fetch(`${origin}/ask`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ prompt: 'Describe Aria voice.' })
    });
    assert.equal(response.status, 200);
    assert.match(await response.text(), /Native Guide retrieval passed/);
    console.log(
      'Read-only Linux container passed: startup, SQLite, native Guide search and reference retrieval. No network or OpenAI calls.'
    );
  } finally {
    server.closeAllConnections();
    await new Promise<void>((done) => server.close(() => done()));
  }
}
