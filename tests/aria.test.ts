import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { randomUUID } from 'node:crypto';
import http from 'node:http';
import { mkdtemp, writeFile, rm, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createAriaServer } from '../src/server/aria-server.ts';
import { loadKnowledge } from '../src/server/aria-knowledge.ts';
import { chunks } from '../src/server/aria-openai.ts';
import { createVisitorStore } from '../src/server/aria-memory.ts';
import type { TestContext } from 'node:test';
import type { AskInput, VoiceInput } from '../src/shared/aria-contracts.ts';
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
      material.lookup.execute('KnowledgeQuery', { mode: 'page', page: 'projects.md' }),
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
    memory: createVisitorStore(':memory:'),
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

test('the voice end tool signs off, closes only its own session and bypasses knowledge lookup', async (t) => {
  const memory = createVisitorStore(':memory:');
  const visitorId = randomUUID();
  const inputs: VoiceInput[] = [];
  const delivered: string[][] = [];
  const closed: number[] = [];
  let lookups = 0;
  const { base, post } = await fixture(t, {
    memory,
    ask: async () => {
      lookups++;
      return 'Shane worked at 8i.';
    },
    voiceConnect: async (input) => {
      const index = inputs.push(input) - 1;
      delivered[index] = [];
      closed[index] = 0;
      return {
        answerSdp: 'v=0\r\n',
        sessionId: `provider-${index}`,
        deliver: (_id, text) => delivered[index].push(text),
        speak: () => {},
        close: () => closed[index]++
      };
    }
  });
  memory.connected(visitorId);
  memory.append(visitorId, 'user', 'Keep my earlier conversation');
  const first = sessionResultSchema.parse(
    await (await post('/session', { sdp: 'v=0\r\n', returning: true, visitorId })).json()
  );
  const second = sessionResultSchema.parse(
    await (await post('/session', { sdp: 'v=0\r\n' })).json()
  );
  assert.equal(inputs[0].returning, true);
  assert.equal(inputs[1].returning, false);
  const events = await fetch(`${base}/session/${first.id}/events`);
  const completed = events.text();
  await inputs[0].onDelegation(
    'invalid',
    '<voice_tool>{"name":"shutdown","arguments":{}}</voice_tool>'
  );
  assert.match(delivered[0][0], /Invalid or unavailable/);
  const tool = '<voice_tool>{"name":"ConversationEnd","arguments":{}}</voice_tool>';
  await inputs[0].onDelegation('finish', tool);
  await inputs[0].onDelegation('duplicate', tool);
  await inputs[0].onDelegation('late-lookup', 'Look up another project while closing.');
  assert.equal(JSON.parse(delivered[0][1]).status, 'ending');
  assert.equal(JSON.parse(delivered[0][2]).status, 'already_ending');
  assert.match(JSON.parse(delivered[0][1]).message, /Begin with the farewell itself/);
  assert.match(JSON.parse(delivered[0][2]).message, /Add no further speech or tool calls/);
  assert.equal(lookups, 0);
  inputs[0].onEvent({ type: 'aria.turn.done' });
  assert.deepEqual(closed, [0, 0]);
  inputs[0].onEvent({ type: 'aria.caption', role: 'assistant', delta: 'Goodbye!', timestamp: 1 });
  inputs[0].onEvent({ type: 'output_audio_buffer.started' });
  inputs[0].onEvent({ type: 'aria.turn.done' });
  assert.deepEqual(closed, [0, 0]);
  inputs[0].onEvent({ type: 'output_audio_buffer.stopped' });
  const content = await completed;
  assert.match(content, /"type":"aria.ending"/);
  assert.match(content, /"type":"aria.closed","reason":"completed"/);
  assert.deepEqual(closed, [1, 0]);
  assert.equal(
    memory.read(visitorId)?.history[0].content?.[0].text,
    'Keep my earlier conversation'
  );
  assert.equal(memory.read(visitorId)?.history.at(-1)?.content?.[0].text, 'Goodbye!');
  assert.equal((await post(`/session/${first.id}/end`, {})).status, 404);
  await inputs[1].onDelegation('another-question', 'Thanks, one more question about Shane at 8i.');
  assert.equal(lookups, 1);
  assert.deepEqual(delivered[1], ['Shane worked at 8i.']);
  assert.equal((await post(`/session/${second.id}/end`, {})).status, 200);
  assert.deepEqual(closed, [1, 1]);
});

test('the returning-visitor hint must be a boolean and cannot carry identity or conversation data', async (t) => {
  const { post } = await fixture(t);
  assert.equal((await post('/session', { sdp: 'v=0\r\n', returning: 'true' })).status, 400);
  assert.equal(
    (await post('/session', { sdp: 'v=0\r\n', returning: true, name: 'Shane' })).status,
    400
  );
});

test('voice and typed follow-ups recover only the matching anonymous visitor history', async (t) => {
  const inputs: VoiceInput[] = [];
  const asked: AskInput[] = [];
  const memory = createVisitorStore(':memory:');
  const { post, base } = await fixture(t, {
    memory,
    ask: async (input) => {
      asked.push(input);
      return 'Shane led infrastructure at 8i.';
    },
    voiceConnect: async (input) => {
      inputs.push(input);
      return {
        answerSdp: 'v=0\r\n',
        sessionId: 'provider',
        deliver: () => {},
        speak: () => {},
        close: () => {}
      };
    }
  });
  const visitorId = randomUUID(),
    other = randomUUID();
  const first = sessionResultSchema.parse(
    await (await post('/session', { sdp: 'v=0\r\n', visitorId })).json()
  );
  assert.equal(inputs[0].returning, false);
  inputs[0].onEvent({ type: 'aria.user.turn.done', transcript: 'Tell me about his time at 8i.' });
  inputs[0].onEvent({ type: 'aria.turn.done', transcript: 'He was IT Manager at 8i.' });
  await post(`/session/${first.id}/end`, {});
  const second = sessionResultSchema.parse(
    await (await post('/session', { sdp: 'v=0\r\n', visitorId })).json()
  );
  assert.equal(inputs[1].returning, true);
  assert.equal(inputs[1].history?.length, 2);
  assert.equal(inputs[1].history?.[0].content?.[0].text, 'Tell me about his time at 8i.');
  assert.equal(
    (await post('/ask', { prompt: 'Follow up', sessionId: second.id, visitorId: other })).status,
    404
  );
  await post('/ask', { prompt: 'What did that role involve?', visitorId });
  assert.equal(asked[0].history?.[0].content?.[0].text, 'Tell me about his time at 8i.');
  await post('/ask', { prompt: 'Introduce Shane', visitorId: other });
  assert.equal(asked[1].history?.length, 2); // This visitor's own completed exchange only.
  assert.equal(asked[1].history?.[0].content?.[0].text, 'Introduce Shane');
  assert.equal(memory.read(visitorId)?.history.length, 4);
  assert.equal(memory.read(other)?.history.length, 2);
  const status = await (await fetch(`${base}/status`)).text();
  assert.doesNotMatch(status, /visitorId|history|Tell me about his time/);
  await post(`/session/${second.id}/end`, {});
});

test('forgetting clears the visitor across active calls and blocks late replies from restoring memory', async (t) => {
  const memory = createVisitorStore(':memory:');
  const visitorId = randomUUID(),
    other = randomUUID();
  memory.connected(other);
  memory.append(other, 'user', 'Keep this unrelated visitor');
  const inputs: VoiceInput[] = [],
    pending: AskInput[] = [],
    delivered: string[][] = [],
    closed: number[] = [];
  const late = Promise.withResolvers<string>();
  const { base, post } = await fixture(t, {
    memory,
    ask: async (input) => {
      pending.push(input);
      return late.promise;
    },
    voiceConnect: async (input) => {
      const index = inputs.push(input) - 1;
      delivered[index] = [];
      closed[index] = 0;
      return {
        answerSdp: 'v=0\r\n',
        sessionId: `provider-${index}`,
        deliver: (_id, text) => delivered[index].push(text),
        speak: () => assert.fail('Deleted typed reply must not be spoken'),
        close: () => closed[index]++
      };
    }
  });
  const first = sessionResultSchema.parse(
    await (await post('/session', { sdp: 'v=0\r\n', visitorId })).json()
  );
  const second = sessionResultSchema.parse(
    await (await post('/session', { sdp: 'v=0\r\n', visitorId })).json()
  );
  inputs[0].onEvent({ type: 'aria.user.turn.done', transcript: 'Please clear my transcript' });
  const firstEvents = (await fetch(`${base}/session/${first.id}/events`)).text();
  const secondEvents = (await fetch(`${base}/session/${second.id}/events`)).text();
  const lookup = inputs[0].onDelegation('pending', 'Look up a project');
  const typed = await post(
    '/ask',
    { prompt: 'Another pending question', visitorId, sessionId: first.id },
    { Accept: 'text/event-stream' }
  );
  // Response headers arrive before the asynchronous lookup has completed.
  while (pending.length < 2) await Bun.sleep(1);
  const tool = '<voice_tool>{"name":"VisitorMemoryDelete","arguments":{}}</voice_tool>';
  await inputs[0].onDelegation('forget', tool);
  assert.equal(memory.read(visitorId), undefined);
  assert.equal(memory.read(other)?.history[0].content?.[0].text, 'Keep this unrelated visitor');
  assert.deepEqual(closed, [0, 1]);
  assert.ok(pending.every((input) => input.signal?.aborted));
  assert.ok(pending.every((input) => input.history?.length === 0));
  assert.equal(JSON.parse(delivered[0][0]).status, 'cleared');
  assert.match(
    JSON.parse(delivered[0][0]).message,
    /Yeah, I'm happy to clear this session out for you/
  );
  await inputs[0].onDelegation('duplicate', tool);
  assert.equal(JSON.parse(delivered[0][1]).status, 'already_cleared');
  assert.equal(
    (await post('/ask', { prompt: 'Too late', visitorId, sessionId: first.id })).status,
    404
  );
  late.resolve('Late answer that must never be saved');
  await lookup;
  assert.doesNotMatch(await typed.text(), /aria.answer/);
  inputs[0].onEvent({ type: 'aria.user.turn.done', transcript: 'Late user transcript' });
  inputs[0].onEvent({
    type: 'aria.caption',
    role: 'assistant',
    delta: 'Cleared now.',
    timestamp: 1
  });
  inputs[0].onEvent({ type: 'output_audio_buffer.started' });
  inputs[0].onEvent({ type: 'output_audio_buffer.stopped' });
  const content = await firstEvents;
  assert.match(content, /aria.forgotten/);
  assert.match(content, /"reason":"forgotten"/);
  assert.doesNotMatch(content, /Late user transcript|Cleared now/);
  assert.match(await secondEvents, /"reason":"forgotten"/);
  assert.deepEqual(closed, [1, 1]);
  assert.equal(memory.read(visitorId), undefined);
  assert.equal(delivered[0].length, 2);
  assert.equal(memory.read(other)?.sessions, 1);
});

test('a failed deletion does not claim success or end the visitor conversation', async (t) => {
  const memory = createVisitorStore(':memory:');
  memory.forget = () => {
    throw new Error('Database unavailable');
  };
  let input: VoiceInput | undefined;
  const delivered: string[] = [];
  let closed = 0;
  const { post } = await fixture(t, {
    memory,
    voiceConnect: async (value) => {
      input = value;
      return {
        answerSdp: 'v=0\r\n',
        sessionId: 'provider',
        deliver: (_id, text) => delivered.push(text),
        speak: () => {},
        close: () => closed++
      };
    }
  });
  const visitorId = randomUUID();
  const session = sessionResultSchema.parse(
    await (await post('/session', { sdp: 'v=0\r\n', visitorId })).json()
  );
  await input!.onDelegation(
    'forget',
    '<voice_tool>{"name":"VisitorMemoryDelete","arguments":{}}</voice_tool>'
  );
  assert.match(delivered[0], /error/);
  assert.equal(closed, 0);
  assert.ok(memory.read(visitorId));
  await post(`/session/${session.id}/end`, {});
});

test('a database reset overrides the browser welcome-back hint', async (t) => {
  const memory = createVisitorStore(':memory:');
  const inputs: VoiceInput[] = [];
  const { post } = await fixture(t, {
    memory,
    voiceConnect: async (input) => {
      inputs.push(input);
      return {
        answerSdp: 'v=0\r\n',
        sessionId: 'provider',
        deliver: () => {},
        speak: () => {},
        close: () => {}
      };
    }
  });
  const visitorId = randomUUID();
  const call = async () =>
    sessionResultSchema.parse(
      await (await post('/session', { sdp: 'v=0\r\n', returning: true, visitorId })).json()
    );
  const first = await call();
  assert.equal(inputs[0].returning, false);
  await post(`/session/${first.id}/end`, {});
  const second = await call();
  assert.equal(inputs[1].returning, true);
  await post(`/session/${second.id}/end`, {});
  memory.forget(visitorId);
  const fresh = await call();
  assert.equal(inputs[2].returning, false);
  assert.deepEqual(inputs[2].history, []);
  await post(`/session/${fresh.id}/end`, {});
});
