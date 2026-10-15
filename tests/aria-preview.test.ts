import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { once } from 'node:events';
import { WebSocket, WebSocketServer } from 'ws';
import { createPreviewServer } from '../src/server/aria-preview.ts';
import type { IncomingMessage, OutgoingHttpHeaders } from 'node:http';

test('preview protects both upstreams, strips Access credentials and streams events and WebSockets', async (t) => {
  let calls = 0;
  const upstream = http.createServer((req, res) => {
    calls++;
    assert.equal(req.headers.cookie, undefined);
    assert.equal(req.headers['cf-access-jwt-assertion'], undefined);
    if (req.url === '/events') {
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      res.write('data: ready\n\n');
      res.on('close', () => res.end());
    } else if (req.url?.startsWith('/chunk/')) {
      res.writeHead(200, { 'Content-Type': 'text/javascript', 'Content-Length': 300_000 });
      res.write('a'.repeat(150_000));
      setTimeout(() => res.end('b'.repeat(150_000)), 5);
    } else res.end(req.url);
  });
  upstream.listen(0, '127.0.0.1');
  await once(upstream, 'listening');
  const ws = new WebSocketServer({ server: upstream });
  ws.on('connection', (peer) => peer.send('reload'));
  const address = upstream.address();
  assert.ok(address && typeof address !== 'string');
  const port = address.port;
  const gateway = createPreviewServer({ sitePort: port, ariaPort: port });
  gateway.listen(0, '127.0.0.1');
  await once(gateway, 'listening');
  t.after(() => {
    ws.close();
    upstream.close();
    upstream.closeAllConnections();
    gateway.close();
    gateway.closeAllConnections();
  });
  const gatewayAddress = gateway.address();
  assert.ok(gatewayAddress && typeof gatewayAddress !== 'string');
  const base = `http://127.0.0.1:${gatewayAddress.port}`;
  const headers = {
    Host: 'aria.shaneholloman.dev',
    'cf-access-jwt-assertion': 'valid-test-token',
    Cookie: 'CF_Authorization=private'
  };
  const request = (path: string, overrides: OutgoingHttpHeaders = {}) =>
    new Promise<IncomingMessage>((resolve, reject) => {
      http.get(base + path, { headers: { ...headers, ...overrides } }, resolve).on('error', reject);
    });
  for (const overrides of [{ Origin: 'https://other.example' }, { Host: 'other.example' }]) {
    const response = await request('/aria-api/status', overrides);
    response.resume();
    assert.equal(response.statusCode, 403);
  }
  assert.equal(calls, 0);
  const blockedPage = await request('/index', { Origin: 'https://shaneholloman.dev' });
  blockedPage.resume();
  assert.equal(blockedPage.statusCode, 403);
  for (const path of ['/index', '/aria-api/status']) {
    const response = await request(
      path,
      path.startsWith('/aria-api/') ? { Origin: 'https://shaneholloman.dev' } : {}
    );
    let content = '';
    for await (const part of response) content += part;
    assert.equal(content, path.replace('/aria-api', ''));
  }
  await Promise.all(
    Array.from({ length: 20 }, async (_, index) => {
      const response = await request(`/chunk/${index}`);
      let content = '';
      for await (const part of response) content += part;
      assert.equal(content, 'a'.repeat(150_000) + 'b'.repeat(150_000));
    })
  );
  const events = await request('/aria-api/events');
  assert.equal(events.headers['content-type'], 'text/event-stream');
  const [chunk] = await once(events, 'data');
  assert.match(chunk.toString(), /data: ready/);
  events.destroy();
  const peer = new WebSocket(base.replace('http:', 'ws:'), { headers });
  const [message] = await once(peer, 'message');
  assert.equal(message.toString(), 'reload');
  peer.close();
  await once(peer, 'close');
});
