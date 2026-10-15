import http from 'node:http';
import { randomUUID } from 'node:crypto';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadKnowledge } from './aria-knowledge.mjs';
import { askLuna, connectVoice, readSubscription, voices, voiceModel, reasoningModel } from './aria-openai.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const allowedOrigins = new Set(['http://localhost:3000', 'http://127.0.0.1:3000', 'https://shaneholloman.dev']);
if (process.env.ARIA_PREVIEW_ORIGIN === 'https://aria.shaneholloman.dev') allowedOrigins.add(process.env.ARIA_PREVIEW_ORIGIN);

async function body(req) {
  if (!req.headers['content-type']?.startsWith('application/json')) throw new Error('Expected JSON.');
  let bytes = 0;
  const parts = [];
  for await (const part of req) {
    bytes += part.length;
    if (bytes > 128_000) throw new Error('Request is too large.');
    parts.push(part);
  }
  return JSON.parse(Buffer.concat(parts).toString());
}

export function createAriaServer({
  knowledge = () => loadKnowledge(join(root, 'index.mdx'), process.env.ARIA_KNOWLEDGE_DIR || join(homedir(), '.local/share/shane-cv-aria/knowledge')),
  subscription = readSubscription, ask = askLuna, voiceConnect = connectVoice,
  sessionMilliseconds = 5 * 60_000
} = {}) {
  const sessions = new Map();
  const activeRequests = new Set();
  let requestCount = 0;
  let windowStart = Date.now();
  const json = (res, code, value) => {
    res.writeHead(code, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(value));
  };
  const emit = (session, event) => {
    if (session.closed) return;
    session.events.push(event);
    if (session.events.length > 30) session.events.shift();
    for (const client of session.clients) client.write(`data: ${JSON.stringify(event)}\n\n`);
  };
  const end = session => {
    if (session.closed) return;
    emit(session, { type: 'aria.closed' });
    session.closed = true;
    session.abort.abort();
    session.connection?.close();
    clearTimeout(session.timer);
    for (const client of session.clients) client.end();
    sessions.delete(session.id);
  };
  const remember = (history, prompt, answer) => {
    history.push({ role: 'user', content: [{ type: 'input_text', text: prompt }] }, { role: 'assistant', content: [{ type: 'output_text', text: answer }] });
    if (history.length > 16) history.splice(0, history.length - 16);
  };
  const server = http.createServer(async (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    const host = req.headers.host || '';
    const origin = req.headers.origin;
    if (!/^(?:localhost|127\.0\.0\.1):\d+$/.test(host) || (origin && !allowedOrigins.has(origin))) {
      json(res, 403, { error: 'This prototype accepts local CV requests only.' }); return;
    }
    if (origin) {
      res.setHeader('Access-Control-Allow-Origin', origin);
      res.setHeader('Vary', 'Origin');
      res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
      res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
      res.setHeader('Access-Control-Allow-Private-Network', 'true');
    }
    if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }
    const path = new URL(req.url, 'http://localhost').pathname;
    try {
      if (req.method === 'GET' && path === '/status') {
        let authenticated = false;
        let message;
        try { await subscription(); authenticated = true; } catch { message = 'Aria needs to reconnect. Please try again later.'; }
        const material = await knowledge();
        json(res, 200, { authenticated, message, sources: material.count, voiceModel, reasoningModel, voices }); return;
      }
      const match = path.match(/^\/session\/([a-f0-9-]+)\/(events|end)$/);
      if (match) {
        const session = sessions.get(match[1]);
        if (!session) { json(res, 404, { error: 'This conversation has ended.' }); return; }
        if (req.method === 'GET' && match[2] === 'events') {
          res.writeHead(200, { 'Content-Type': 'text/event-stream', Connection: 'keep-alive' });
          res.write(': Aria\n\n');
          for (const event of session.events) res.write(`data: ${JSON.stringify(event)}\n\n`);
          session.clients.add(res);
          const heartbeat = setInterval(() => res.write(': keepalive\n\n'), 15_000);
          res.on('close', () => { clearInterval(heartbeat); session.clients.delete(res); });
          return;
        }
        if (req.method === 'POST' && match[2] === 'end') { end(session); json(res, 200, { ended: true }); return; }
      }
      if (req.method !== 'POST' || !['/session', '/ask'].includes(path)) { json(res, 404, { error: 'Not found.' }); return; }
      if (Date.now() - windowStart > 10 * 60_000) { requestCount = 0; windowStart = Date.now(); }
      if (++requestCount > 40) { json(res, 429, { error: 'Aria is busy. Please try again in a few minutes.' }); return; }
      const data = await body(req);
      const material = await knowledge();
      if (path === '/ask') {
        if (typeof data.prompt !== 'string' || !data.prompt.trim() || data.prompt.length > 2000) { json(res, 400, { error: 'Enter a question of up to 2,000 characters.' }); return; }
        if (activeRequests.size >= 2) { json(res, 429, { error: 'Aria is finishing another answer. Please wait.' }); return; }
        const abort = new AbortController(); activeRequests.add(abort);
        res.on('close', () => abort.abort());
        const session = sessions.get(data.sessionId);
        const history = session?.history || [];
        try {
          const answer = await ask({ prompt: data.prompt.trim(), knowledge: material.text, history, signal: abort.signal });
          remember(history, data.prompt, answer);
          session?.connection.speak(answer);
          json(res, 200, { answer });
        } finally { activeRequests.delete(abort); }
        return;
      }
      if (typeof data.sdp !== 'string' || !data.sdp.startsWith('v=0') || (data.voice && !voices.includes(data.voice))) { json(res, 400, { error: 'Invalid voice connection.' }); return; }
      if (sessions.size >= 2) { json(res, 429, { error: 'Aria is speaking with other visitors. Please try again shortly.' }); return; }
      const session = { id: randomUUID(), abort: new AbortController(), clients: new Set(), events: [], history: [], closed: false, delegations: new Set() };
      sessions.set(session.id, session);
      session.timer = setTimeout(() => end(session), sessionMilliseconds);
      res.on('close', () => { if (!res.writableFinished) end(session); });
      try {
        session.connection = await voiceConnect({
          sdp: data.sdp, knowledge: material.text, voice: data.voice || 'cove', signal: session.abort.signal,
          onEvent: event => emit(session, event), onClose: () => end(session),
          onDelegation: async (id, prompt) => {
            if (session.closed || session.delegations.size >= 2) {
              session.connection?.deliver(id, 'Please ask one question at a time.'); return;
            }
            session.delegations.add(id);
            emit(session, { type: 'aria.thinking' });
            try {
              const answer = await ask({ prompt, knowledge: material.text, history: session.history, signal: session.abort.signal });
              if (!session.closed) { remember(session.history, prompt, answer); session.connection.deliver(id, answer); emit(session, { type: 'aria.ready' }); }
            } catch (error) {
              if (!session.closed) { session.connection?.deliver(id, 'I could not look that up just now. Please try again.'); emit(session, { type: 'aria.error', message: error.message }); }
            } finally { session.delegations.delete(id); }
          }
        });
        if (session.closed) { session.connection.close(); throw new Error('Voice connection cancelled.'); }
        json(res, 200, { id: session.id, sdp: session.connection.answerSdp });
      } catch (error) { end(session); throw error; }
    } catch (error) {
      if (!res.headersSent && !res.destroyed) json(res, 400, { error: error instanceof SyntaxError ? 'Invalid JSON.' : error.message });
    }
  });
  server.on('close', () => { for (const session of sessions.values()) end(session); for (const abort of activeRequests) abort.abort(); });
  return server;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const server = createAriaServer();
  server.listen(8791, '127.0.0.1', () => console.log('Aria local service: http://127.0.0.1:8791 • ChatGPT subscription only'));
  const shutdown = () => { server.close(); server.closeAllConnections(); };
  process.once('SIGINT', shutdown); process.once('SIGTERM', shutdown);
}
