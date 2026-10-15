import http from 'node:http';
import { randomUUID } from 'node:crypto';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadKnowledge } from './aria-knowledge.ts';
import { createConversationEnding, parseConversationTool } from './aria-conversation.ts';
import { createVisitorStore } from './aria-memory.ts';
import { openAriaGuide } from './aria-guide.ts';
import type { VisitorStore } from './aria-memory.ts';
import {
  askLuna,
  connectVoice,
  readSubscription,
  voices,
  voiceModel,
  reasoningModel
} from './aria-openai.ts';
import { askRequestSchema, sessionRequestSchema } from '../shared/aria-contracts.ts';
import type {
  KnowledgeMaterial,
  AskInput,
  VoiceInput,
  VoiceConnection,
  ResponseItem,
  AriaEvent,
  ConversationControlName
} from '../shared/aria-contracts.ts';
import type { IncomingMessage, ServerResponse } from 'node:http';

const root = fileURLToPath(new URL('../../', import.meta.url));
const allowedOrigins = new Set([
  'http://localhost:3000',
  'http://127.0.0.1:3000',
  'https://shaneholloman.dev'
]);
if (process.env.ARIA_PREVIEW_ORIGIN === 'https://aria.shaneholloman.dev')
  allowedOrigins.add(process.env.ARIA_PREVIEW_ORIGIN);

async function body(req: IncomingMessage): Promise<unknown> {
  if (!req.headers['content-type']?.startsWith('application/json'))
    throw new Error('Expected JSON.');
  let bytes = 0;
  const parts = [];
  for await (const part of req) {
    bytes += part.length;
    if (bytes > 128_000) throw new Error('Request is too large.');
    parts.push(part);
  }
  return JSON.parse(Buffer.concat(parts).toString());
}

interface Session {
  id: string;
  abort: AbortController;
  clients: Set<ServerResponse>;
  events: AriaEvent[];
  history: ResponseItem[];
  currentHistory: ResponseItem[];
  closed: boolean;
  delegations: Set<string>;
  timer?: ReturnType<typeof setTimeout>;
  connection?: VoiceConnection;
  ending?: ReturnType<typeof createConversationEnding>;
  visitorId?: string;
  startedAt?: number;
  transcripts: { user: string; assistant: string };
  forgotten?: boolean;
  lookups: Set<AbortController>;
}
interface ServerOptions {
  observe?: (event: {
    phase: string;
    elapsedMs?: number;
    source?: string;
    tool?: string;
    error?: string;
    code?: number;
    inputTokens?: number;
    cachedTokens?: number;
    outputTokens?: number;
  }) => void;
  knowledge?: () => Promise<KnowledgeMaterial>;
  subscription?: typeof readSubscription;
  ask?: (input: AskInput) => Promise<string>;
  voiceConnect?: (input: VoiceInput) => Promise<VoiceConnection>;
  sessionMilliseconds?: number;
  lookupProgressMilliseconds?: number;
  memory?: VisitorStore;
}
export function createAriaServer({
  observe,
  knowledge: providedKnowledge,
  subscription = readSubscription,
  ask = askLuna,
  voiceConnect = connectVoice,
  sessionMilliseconds = 5 * 60_000,
  lookupProgressMilliseconds = 8000,
  memory = createVisitorStore(
    process.env.ARIA_MEMORY_DB || join(root, 'data/memory/visitors.sqlite')
  )
}: ServerOptions = {}) {
  let guide: ReturnType<typeof openAriaGuide> | undefined;
  const knowledge =
    providedKnowledge ||
    (() => {
      guide ||= openAriaGuide(
        process.env.ARIA_GUIDE_DIR || join(root, 'dist/knowledge/Aria-guide')
      );
      return loadKnowledge(
        join(root, 'index.mdx'),
        process.env.ARIA_KNOWLEDGE_DIR || join(root, 'data/knowledge'),
        guide.lookup,
        join(root, 'dist/knowledge')
      );
    });
  const sessions = new Map<string, Session>();
  const activeRequests = new Map<AbortController, { visitorId?: string; sessionId?: string }>();
  let requestCount = 0;
  let windowStart = Date.now();
  const json = (res: ServerResponse, code: number, value: unknown) => {
    res.writeHead(code, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(value));
  };
  const emit = (session: Session, event: AriaEvent) => {
    if (session.closed) return;
    session.events.push(event);
    if (session.events.length > 30) session.events.shift();
    for (const client of session.clients) client.write(`data: ${JSON.stringify(event)}\n\n`);
  };
  const end = (session: Session, reason?: 'completed' | 'forgotten', source = 'manual') => {
    if (session.closed) return;
    observe?.({
      phase: 'session.closed',
      source,
      elapsedMs: session.startedAt ? Date.now() - session.startedAt : undefined
    });
    emit(session, { type: 'aria.closed', ...(reason ? { reason } : {}) });
    session.closed = true;
    session.abort.abort();
    session.connection?.close();
    clearTimeout(session.timer);
    session.ending?.dispose();
    if (session.visitorId && session.startedAt)
      memory.ended(session.visitorId, Date.now() - session.startedAt);
    for (const client of session.clients) client.end();
    sessions.delete(session.id);
  };
  const remember = (history: ResponseItem[], prompt: string, answer: string) => {
    history.push(
      { type: 'message', role: 'user', content: [{ type: 'input_text', text: prompt }] },
      { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: answer }] }
    );
    if (history.length > 16) history.splice(0, history.length - 16);
  };
  const transcript = (session: Session, role: 'user' | 'assistant', text: string) => {
    const value = text.trim().slice(0, 6000);
    if (!value) return;
    const previous = session.currentHistory.at(-1);
    if (previous?.role === role && previous.content?.[0]?.text === value) return;
    session.history.push({
      type: 'message',
      role,
      content: [{ type: role === 'user' ? 'input_text' : 'output_text', text: value }]
    });
    session.currentHistory.push({
      type: 'message',
      role,
      content: [{ type: role === 'user' ? 'input_text' : 'output_text', text: value }]
    });
    if (session.currentHistory.length > 16)
      session.currentHistory.splice(0, session.currentHistory.length - 16);
    if (session.history.length > 16) session.history.splice(0, session.history.length - 16);
    if (session.visitorId) memory.append(session.visitorId, role, value);
  };
  const server = http.createServer(async (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    const host = req.headers.host || '';
    const origin = req.headers.origin;
    if (!/^(?:localhost|127\.0\.0\.1):\d+$/.test(host) || (origin && !allowedOrigins.has(origin))) {
      json(res, 403, { error: 'This prototype accepts local CV requests only.' });
      return;
    }
    if (origin) {
      res.setHeader('Access-Control-Allow-Origin', origin);
      res.setHeader('Vary', 'Origin');
      res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
      res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
      res.setHeader('Access-Control-Allow-Private-Network', 'true');
    }
    if (req.method === 'OPTIONS') {
      res.writeHead(204);
      res.end();
      return;
    }
    const path = new URL(req.url || '/', 'http://localhost').pathname;
    try {
      if (req.method === 'GET' && path === '/status') {
        let authenticated = false;
        let message;
        try {
          await subscription();
          authenticated = true;
        } catch {
          message = 'Aria needs to reconnect. Please try again later.';
        }
        const material = await knowledge();
        json(res, 200, {
          authenticated,
          message,
          sources: material.count,
          voiceModel,
          reasoningModel,
          voices
        });
        return;
      }
      const match = path.match(/^\/session\/([a-f0-9-]+)\/(events|end)$/);
      if (match) {
        const session = sessions.get(match[1]);
        if (!session) {
          json(res, 404, { error: 'This conversation has ended.' });
          return;
        }
        if (req.method === 'GET' && match[2] === 'events') {
          res.writeHead(200, { 'Content-Type': 'text/event-stream', Connection: 'keep-alive' });
          res.write(': Aria\n\n');
          for (const event of session.events) res.write(`data: ${JSON.stringify(event)}\n\n`);
          session.clients.add(res);
          const heartbeat = setInterval(() => res.write(': keepalive\n\n'), 15_000);
          res.on('close', () => {
            clearInterval(heartbeat);
            session.clients.delete(res);
          });
          return;
        }
        if (req.method === 'POST' && match[2] === 'end') {
          end(session);
          json(res, 200, { ended: true });
          return;
        }
      }
      if (req.method !== 'POST' || !['/session', '/ask'].includes(path)) {
        json(res, 404, { error: 'Not found.' });
        return;
      }
      if (Date.now() - windowStart > 10 * 60_000) {
        requestCount = 0;
        windowStart = Date.now();
      }
      if (++requestCount > 40) {
        json(res, 429, { error: 'Aria is busy. Please try again in a few minutes.' });
        return;
      }
      const raw = await body(req);
      const material = await knowledge();
      if (path === '/ask') {
        const parsed = askRequestSchema.safeParse(raw);
        if (!parsed.success) {
          json(res, 400, {
            error: 'Enter a question of up to 2,000 characters with a valid session.'
          });
          return;
        }
        const data = parsed.data;
        if (activeRequests.size >= 2) {
          json(res, 429, { error: 'Aria is finishing another answer. Please wait.' });
          return;
        }
        const abort = new AbortController();
        activeRequests.set(abort, { visitorId: data.visitorId, sessionId: data.sessionId });
        res.on('close', () => abort.abort());
        const session = data.sessionId ? sessions.get(data.sessionId) : undefined;
        if (
          data.sessionId &&
          (!session || session.forgotten || session.visitorId !== data.visitorId)
        ) {
          activeRequests.delete(abort);
          json(res, 404, { error: 'This conversation is unavailable.' });
          return;
        }
        const history =
          session?.history ||
          (data.visitorId ? memory.read(data.visitorId)?.history : undefined) ||
          [];
        const streaming = req.headers.accept?.includes('text/event-stream');
        const send = (event: unknown) => {
          if (!res.destroyed) res.write(`data: ${JSON.stringify(event)}\n\n`);
        };
        if (streaming) {
          res.writeHead(200, { 'Content-Type': 'text/event-stream' });
          res.write(': Aria\n\n');
        }
        try {
          const answer = await ask({
            prompt: data.prompt,
            knowledge: material.text,
            lookup: material.lookup,
            history,
            signal: abort.signal,
            sessionId: session?.id,
            onActivity: (magnitude) => {
              if (streaming) send({ type: 'aria.activity', magnitude });
              else if (session && !session.closed)
                emit(session, { type: 'aria.activity', magnitude });
            }
          });
          abort.signal.throwIfAborted();
          remember(history, data.prompt, answer);
          if (data.visitorId) {
            memory.append(data.visitorId, 'user', data.prompt);
            memory.append(data.visitorId, 'assistant', answer);
            memory.profile(data.visitorId, data.profile);
          }
          session?.connection?.speak(answer);
          if (streaming) {
            send({ type: 'aria.answer', answer });
            res.end();
          } else json(res, 200, { answer });
        } catch (error) {
          if (!streaming) throw error;
          send({
            type: 'aria.error',
            message: error instanceof Error ? error.message : 'Aria could not answer.'
          });
          res.end();
        } finally {
          activeRequests.delete(abort);
        }
        return;
      }
      const parsed = sessionRequestSchema.safeParse(raw);
      if (!parsed.success) {
        json(res, 400, { error: 'Invalid voice connection.' });
        return;
      }
      const data = parsed.data;
      if (sessions.size >= 2) {
        json(res, 429, {
          error: 'Aria is speaking with other visitors. Please try again shortly.'
        });
        return;
      }
      const previous = data.visitorId ? memory.read(data.visitorId) : undefined;
      const session: Session = {
        id: randomUUID(),
        abort: new AbortController(),
        clients: new Set(),
        events: [],
        history: previous?.history || [],
        currentHistory: [],
        visitorId: data.visitorId,
        transcripts: { user: '', assistant: '' },
        lookups: new Set(),
        closed: false,
        delegations: new Set()
      };
      sessions.set(session.id, session);
      session.timer = setTimeout(() => end(session, undefined, 'deadline'), sessionMilliseconds);
      session.ending = createConversationEnding(() =>
        end(session, session.forgotten ? 'forgotten' : 'completed', 'farewell')
      );
      res.on('close', () => {
        if (!res.writableFinished) end(session, undefined, 'setup-disconnected');
      });
      try {
        session.connection = await voiceConnect({
          sdp: data.sdp,
          knowledge: material.text,
          voice: data.voice || 'cove',
          // A remembered browser ID alone is not a remembered conversation.
          returning: data.visitorId ? Boolean(previous) : data.returning || false,
          history: [...session.history],
          signal: session.abort.signal,
          onEvent: (event) => {
            if (session.closed) return;
            if (session.forgotten) {
              session.ending?.observe(event);
              return;
            }
            if (event.type === 'aria.caption')
              session.transcripts[event.role] = (
                session.transcripts[event.role] + event.delta
              ).slice(0, 6000);
            if (event.type === 'aria.turn.done' || event.type === 'aria.user.turn.done') {
              const role = event.type === 'aria.turn.done' ? 'assistant' : 'user';
              transcript(session, role, event.transcript || session.transcripts[role]);
              session.transcripts[role] = '';
            }
            emit(session, event);
            session.ending?.observe(event);
          },
          onClose: (detail) => {
            observe?.({ phase: 'provider.closed', code: detail?.code });
            end(session, session.forgotten ? 'forgotten' : undefined, 'provider');
          },
          onDelegation: async (id, prompt) => {
            if (session.closed) return;
            observe?.({ phase: 'delegation.received' });
            const runControl = (name: ConversationControlName): string => {
              observe?.({ phase: 'control.requested', tool: name });
              if (name === 'VisitorMemoryDelete') {
                if (session.forgotten) {
                  return '{"status":"already_cleared"}';
                }
                const visitorId = session.visitorId;
                if (visitorId) memory.forget(visitorId);
                for (const affected of sessions.values()) {
                  if (affected !== session && (!visitorId || affected.visitorId !== visitorId))
                    continue;
                  affected.forgotten = true;
                  affected.visitorId = undefined;
                  affected.history.length = 0;
                  affected.currentHistory.length = 0;
                  affected.transcripts = { user: '', assistant: '' };
                  affected.events.length = 0;
                  for (const lookup of affected.lookups) lookup.abort();
                  emit(affected, { type: 'aria.forgotten' });
                  if (affected !== session) end(affected, 'forgotten');
                }
                for (const [abort, owner] of activeRequests)
                  if (
                    (visitorId && owner.visitorId === visitorId) ||
                    owner.sessionId === session.id
                  )
                    abort.abort();
                session.ending?.begin(true);
                emit(session, { type: 'aria.ending' });
                return JSON.stringify({
                  status: 'cleared',
                  message: "Yeah, I'm happy to clear this session out for you. It's cleared now."
                });
              }
              const started = session.ending?.begin();
              if (started) emit(session, { type: 'aria.ending' });
              return JSON.stringify({
                status: started ? 'ending' : 'already_ending',
                message: started
                  ? 'Reply with one natural farewell, such as "Thanks for chatting. See you later!" Begin with the farewell itself. Do not acknowledge a task, announce cleanup, or promise any action. The call will close after the farewell.'
                  : 'A farewell is already underway. Add no further speech or tool calls.'
              });
            };
            try {
              const tool = parseConversationTool(prompt);
              if (tool) {
                session.connection?.deliver(id, runControl(tool.name));
                return;
              }
            } catch {
              session.connection?.deliver(id, '{"error":"Invalid or unavailable voice tool."}');
              return;
            }
            if (session.ending?.pending) return;
            if (session.closed || session.delegations.size >= 2) {
              session.connection?.deliver(id, 'Please ask one question at a time.');
              return;
            }
            session.delegations.add(id);
            const lookupStarted = performance.now();
            const report = (
              phase: string,
              detail: {
                tool?: string;
                error?: string;
                inputTokens?: number;
                cachedTokens?: number;
                outputTokens?: number;
              } = {}
            ) =>
              observe?.({
                phase,
                elapsedMs: Math.round(performance.now() - lookupStarted),
                ...detail
              });
            report('lookup.started');
            const lookup = new AbortController();
            session.lookups.add(lookup);
            emit(session, { type: 'aria.thinking' });
            const progress = setInterval(() => {
              if (!session.closed && !session.ending?.pending && !lookup.signal.aborted)
                session.connection?.progress?.(
                  id,
                  'I’m still checking the relevant documentation.'
                );
            }, lookupProgressMilliseconds);
            try {
              const answer = await ask({
                prompt,
                knowledge: material.text,
                lookup: material.lookup,
                history: session.history,
                signal: AbortSignal.any([session.abort.signal, lookup.signal]),
                sessionId: session.id,
                conversationControl: {
                  history: [...session.currentHistory],
                  execute(name) {
                    if (session.closed || session.abort.signal.aborted)
                      throw new Error('This voice call has ended.');
                    const result = runControl(name);
                    session.connection?.deliver(id, result);
                    return result;
                  }
                },
                onTool: (tool) => report('lookup.tool', { tool }),
                onUsage: (usage) => report('lookup.usage', usage),
                onActivity: (magnitude) => {
                  if (!session.closed && !session.forgotten)
                    emit(session, { type: 'aria.activity', magnitude });
                }
              });
              if (!session.closed && !session.ending?.pending) {
                report('lookup.completed');
                session.connection?.deliver(id, answer);
              }
            } catch (error) {
              report('lookup.failed', {
                error: error instanceof Error ? error.message.slice(0, 180) : 'Unknown lookup error'
              });
              if (!session.closed && !session.ending?.pending) {
                session.connection?.deliver(
                  id,
                  'I could not look that up just now. Please try again.'
                );
                emit(session, {
                  type: 'aria.lookup.error',
                  message: error instanceof Error ? error.message : 'Knowledge lookup failed.'
                });
              }
            } finally {
              clearInterval(progress);
              session.lookups.delete(lookup);
              session.delegations.delete(id);
              if (!session.closed && !session.ending?.pending && session.delegations.size === 0)
                emit(session, { type: 'aria.ready' });
            }
          }
        });
        if (session.closed) {
          session.connection.close();
          throw new Error('Voice connection cancelled.');
        }
        session.startedAt = Date.now();
        if (session.visitorId) memory.connected(session.visitorId, data.profile);
        json(res, 200, { id: session.id, sdp: session.connection.answerSdp });
      } catch (error) {
        end(session, undefined, 'setup-failed');
        throw error;
      }
    } catch (error) {
      if (!res.headersSent && !res.destroyed)
        json(res, 400, {
          error:
            error instanceof SyntaxError
              ? 'Invalid JSON.'
              : error instanceof Error
                ? error.message
                : 'Aria could not complete this request.'
        });
    }
  });
  server.on('close', () => {
    for (const session of sessions.values()) end(session, undefined, 'server-shutdown');
    for (const abort of activeRequests.keys()) abort.abort();
    memory.close();
    guide?.close();
  });
  return server;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const server = createAriaServer({
    observe: (event) => console.info('Aria lifecycle:', JSON.stringify(event))
  });
  server.listen(8791, '127.0.0.1', () =>
    console.log('Aria local service: http://127.0.0.1:8791 • ChatGPT subscription only')
  );
  const shutdown = () => {
    server.close();
    server.closeAllConnections();
  };
  process.once('SIGINT', shutdown);
  process.once('SIGTERM', shutdown);
}
