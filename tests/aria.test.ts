import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import http from 'node:http';
import { mkdtemp, writeFile, rm, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createAriaServer } from '../src/server/aria-server.ts';
import { loadKnowledge } from '../src/server/aria-knowledge.ts';
import { chunks } from '../src/server/aria-openai.ts';
import type { TestContext } from 'node:test';
import type { AskInput } from '../src/shared/aria-contracts.ts';
import { sessionResultSchema } from '../src/shared/aria-contracts.ts';

test('knowledge includes the complete CV and supplemental text without reading unrelated files', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'aria-knowledge-'));
  try {
    const cv = join(dir, 'index.mdx');
    const extra = join(dir, 'knowledge');
    await mkdir(extra);
    await writeFile(
      cv,
      '---\ntitle: CV\n---\n<h2>Experience</h2><p>IT Manager at 8i &amp; Head of AI at Cello.</p><h2>Education</h2><p>Music studies.</p>'
    );
    await writeFile(join(extra, 'projects.md'), 'Project detail not displayed on the site.');
    await writeFile(join(extra, 'credentials.json'), 'DO NOT INCLUDE');
    const material = await loadKnowledge(cv, extra);
    assert.equal(material.count, 2);
    assert.match(material.text, /## Education\n\nMusic studies/);
    assert.match(material.text, /8i &amp; Head of AI/);
    assert.doesNotMatch(material.text, /not displayed on the site/);
    assert.match(
      material.lookup.execute('read_knowledge', { source: 'projects.md' }),
      /not displayed on the site/
    );
    assert.doesNotMatch(material.text, /DO NOT INCLUDE|title: CV|<h2>/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('Live result chunks preserve multibyte speech text within the provider limit', () => {
  const text = 'Shane’s work • infrastructure • 音楽 '.repeat(50);
  const parts = chunks(text);
  assert.equal(parts.join(''), text);
  assert.ok(parts.every((part) => Buffer.byteLength(part) <= 500));
});

async function fixture(
  t: TestContext,
  overrides: NonNullable<Parameters<typeof createAriaServer>[0]> = {}
) {
  const server = createAriaServer({
    knowledge: async () => ({
      text: 'Shane is IT Manager at 8i.',
      count: 1,
      lookup: {
        tools: [],
        execute: () => {
          throw new Error('Unexpected lookup in server fixture');
        }
      }
    }),
    subscription: async () => ({ token: 'SECRET-DO-NOT-EXPOSE' }),
    ask: async () => 'Shane worked at 8i.',
    ...overrides
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => {
    server.close();
    server.closeAllConnections();
  });
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  const base = `http://127.0.0.1:${address.port}`;
  const post = (path: string, data: unknown, headers: Record<string, string> = {}) =>
    fetch(base + path, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Origin: 'http://localhost:3000', ...headers },
      body: JSON.stringify(data)
    });
  return { base, post };
}

test('local status exposes readiness without credentials and rejects remote origins and hostnames', async (t) => {
  const { base } = await fixture(t);
  const response = await fetch(`${base}/status`, { headers: { Origin: 'http://localhost:3000' } });
  assert.equal(response.headers.get('access-control-allow-origin'), 'http://localhost:3000');
  const published = await fetch(`${base}/status`, {
    headers: { Origin: 'https://shaneholloman.dev' }
  });
  assert.equal(published.status, 200);
  assert.equal(published.headers.get('access-control-allow-origin'), 'https://shaneholloman.dev');
  const preflight = await fetch(`${base}/ask`, {
    method: 'OPTIONS',
    headers: { Origin: 'https://shaneholloman.dev', 'Access-Control-Request-Method': 'POST' }
  });
  assert.equal(preflight.status, 204);
  assert.equal(preflight.headers.get('access-control-allow-origin'), 'https://shaneholloman.dev');
  const status = await response.text();
  assert.match(status, /"authenticated":true/);
  assert.doesNotMatch(status, /SECRET-DO-NOT-EXPOSE|access_token|account_id/);
  assert.equal(
    (await fetch(`${base}/status`, { headers: { Origin: 'https://untrusted.example' } })).status,
    403
  );
  const hostStatus = await new Promise((resolve) => {
    http.get(`${base}/status`, { headers: { Host: 'untrusted.example' } }, (response) => {
      response.resume();
      resolve(response.statusCode);
    });
  });
  assert.equal(hostStatus, 403);
});

test('typed questions reach the knowledge-backed agent and reject oversized or malformed requests', async (t) => {
  let received: AskInput | undefined;
  const { post } = await fixture(t, {
    ask: async (input) => {
      received = input;
      return '8i.';
    }
  });
  const answer = await post('/ask', { prompt: 'Where was Shane IT Manager?' });
  assert.deepEqual(await answer.json(), { answer: '8i.' });
  assert.equal(received?.knowledge, 'Shane is IT Manager at 8i.');
  assert.equal((await post('/ask', { prompt: 'x'.repeat(2001) })).status, 400);
  assert.equal((await post('/session', { sdp: 'not SDP' })).status, 400);
});

test('typed event streams carry real background activity before the answer and finish on error', async (t) => {
  const { post } = await fixture(t, {
    ask: async (input) => {
      input.onActivity?.(12);
      if (input.prompt === 'Fail') throw new Error('Lookup failed.');
      return 'Shane worked at 8i.';
    }
  });
  const response = await post(
    '/ask',
    { prompt: 'Where did Shane work?' },
    { Accept: 'text/event-stream' }
  );
  assert.equal(response.headers.get('content-type'), 'text/event-stream');
  const content = await response.text();
  assert.ok(content.indexOf('aria.activity') < content.indexOf('aria.answer'));
  assert.match(content, /"magnitude":12/);
  assert.match(content, /Shane worked at 8i/);
  const failed = await post('/ask', { prompt: 'Fail' }, { Accept: 'text/event-stream' });
  assert.match(await failed.text(), /"type":"aria.error","message":"Lookup failed\."/);
});

test('ending a conversation closes its provider connection and invalidates the session', async (t) => {
  let closed = 0;
  const { post } = await fixture(t, {
    voiceConnect: async () => ({
      answerSdp: 'v=0\r\n',
      sessionId: 'provider-session',
      deliver: () => {},
      speak: () => {},
      close: () => {
        closed++;
      }
    })
  });
  const response = await post('/session', { sdp: 'v=0\r\n' });
  const session = sessionResultSchema.parse(await response.json());
  assert.ok(session.id);
  assert.equal(session.sdp, 'v=0\r\n');
  await post(`/session/${session.id}/end`, {});
  assert.equal(closed, 1);
  assert.equal((await post(`/session/${session.id}/end`, {})).status, 404);
});

test('the session deadline aborts pending provider setup', async (t) => {
  const pendingAbort = Promise.withResolvers<void>();
  const { post } = await fixture(t, {
    sessionMilliseconds: 20,
    voiceConnect: (input) =>
      new Promise((_, reject) =>
        input.signal?.addEventListener('abort', () => {
          pendingAbort.resolve();
          reject(new Error('cancelled'));
        })
      )
  });
  void post('/session', { sdp: 'v=0\r\n' }).catch(() => {});
  await pendingAbort.promise;
});
