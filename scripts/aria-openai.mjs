import { homedir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import WebSocket from 'ws';
import { reasoningInstructions, voiceInstructions } from './aria-knowledge.mjs';
import { subscriptionReader } from './aria-auth.mjs';

// The subscription Live contract is taken from Aria's proven OpenAI adapter.
// This is intentionally separate from the public API-key Realtime contract.
const base = 'https://chatgpt.com/backend-api/codex';
export const voiceModel = 'gpt-live-1-codex';
export const reasoningModel = 'gpt-6-luna';
export const voices = ['cove', 'juniper', 'maple', 'spruce', 'ember', 'vale', 'breeze', 'arbor', 'sol'];

export const readSubscription = subscriptionReader({
  file: join(process.env.CODEX_HOME || join(homedir(), '.codex'), 'auth.json'),
  refresh: process.env.ARIA_REFRESH_AUTH === '1'
});

function headers(auth, sessionId) {
  return {
    Authorization: `Bearer ${auth.token}`,
    'Content-Type': 'application/json',
    originator: 'aria',
    'session-id': sessionId,
    'thread-id': sessionId,
    'x-session-id': sessionId,
    ...(auth.accountId ? { 'ChatGPT-Account-Id': auth.accountId } : {})
  };
}

async function providerError(response, label) {
  // Never relay raw upstream bodies or credentials into the browser or logs.
  await response.body?.cancel();
  if (response.status === 401) return new Error('Your ChatGPT login needs refreshing. Run codex login.');
  if (response.status === 403) return new Error(`Your ChatGPT account did not authorize ${label}.`);
  if (response.status === 429) return new Error('Your subscription usage limit has been reached. Please try later.');
  return new Error(`OpenAI could not start ${label} (HTTP ${response.status}).`);
}

export function chunks(text, maxBytes = 500) {
  const result = [];
  let part = '';
  for (const character of text) {
    if (part && Buffer.byteLength(part + character) > maxBytes) { result.push(part); part = ''; }
    part += character;
  }
  if (part) result.push(part);
  return result;
}

export async function askLuna({ prompt, knowledge, history = [], signal, sessionId = randomUUID() }) {
  const auth = await readSubscription();
  const response = await fetch(`${base}/responses`, {
    method: 'POST', headers: headers(auth, sessionId),
    body: JSON.stringify({
      model: reasoningModel, store: false, stream: true,
      instructions: reasoningInstructions(knowledge),
      input: [...history.slice(-16), { role: 'user', content: [{ type: 'input_text', text: prompt }] }],
      tools: [], reasoning: { effort: 'low' }
    }),
    signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(45_000)]) : AbortSignal.timeout(45_000)
  });
  if (!response.ok) throw await providerError(response, 'Luna');
  let buffer = '';
  let answer = '';
  let completed = false;
  const decoder = new TextDecoder();
  for await (const bytes of response.body) {
    buffer += decoder.decode(bytes, { stream: true }).replaceAll('\r\n', '\n');
    let end;
    while ((end = buffer.indexOf('\n\n')) !== -1) {
      const packet = buffer.slice(0, end); buffer = buffer.slice(end + 2);
      const data = packet.split('\n').filter(line => line.startsWith('data: ')).map(line => line.slice(6)).join('\n');
      if (!data || data === '[DONE]') continue;
      const event = JSON.parse(data);
      if (event.type === 'response.output_text.delta') answer += event.delta || '';
      if (event.type === 'error' || event.type === 'response.failed') throw new Error('Luna could not complete this answer. Please try again.');
      if (event.type === 'response.completed') {
        completed = event.response?.status === 'completed';
        if (!answer) answer = (event.response?.output || []).flatMap(item => item.content || []).filter(item => item.type === 'output_text').map(item => item.text).join('');
      }
    }
  }
  if (!completed || !answer.trim()) throw new Error('Luna did not return a complete answer. Please try again.');
  return answer.trim().replaceAll('\u2014', ' • ');
}

export async function connectVoice({ sdp, knowledge, voice = 'cove', onEvent, onDelegation, onClose, signal }) {
  const auth = await readSubscription();
  const sessionId = randomUUID();
  const response = await fetch(`${base}/realtime/calls?intent=quicksilver&architecture=avas`, {
    method: 'POST', headers: { ...headers(auth, sessionId), 'openai-alpha': 'quicksilver=v2' },
    body: JSON.stringify({ sdp, session: {
      model: voiceModel, instructions: voiceInstructions(knowledge),
      audio: { output: { voice } }, delegation: { type: 'client' }
    } }),
    signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(20_000)]) : AbortSignal.timeout(20_000)
  });
  if (!response.ok) throw await providerError(response, 'voice');
  const callId = response.headers.get('location')?.split('?')[0].split('/').filter(Boolean).at(-1);
  const answerSdp = await response.text();
  if (!callId || !answerSdp.startsWith('v=')) throw new Error('OpenAI did not return a usable voice connection.');
  const socket = new WebSocket(`wss://api.openai.com/v1/live/${encodeURIComponent(callId)}`, {
    headers: {
      Authorization: `Bearer ${auth.token}`, 'openai-alpha': 'quicksilver=v2',
      originator: 'aria', 'session-id': sessionId, 'thread-id': sessionId, 'x-session-id': sessionId
    },
    handshakeTimeout: 15_000, maxPayload: 2 * 1024 * 1024
  });
  const seen = new Set();
  socket.on('message', data => {
    let event;
    try { event = JSON.parse(String(data)); } catch { return; }
    if (['input_transcript.added', 'output_transcript.added'].includes(event.type)) {
      onEvent({ type: 'aria.caption', role: event.type === 'input_transcript.added' ? 'user' : 'assistant', delta: event.item?.text || '', timestamp: Date.now() });
    }
    if (event.type === 'delegation.created' && event.item?.target === 'client' && event.item?.id && !seen.has(event.item.id)) {
      seen.add(event.item.id);
      const prompt = (event.item.content || []).filter(item => item.type === 'input_text').map(item => item.text || '').join('');
      if (prompt) void onDelegation(event.item.id, prompt);
    }
    // Audio is carried by WebRTC. Forward only bounded UI events.
    if (['session.started', 'session.closed', 'output_audio_buffer.started', 'output_audio_buffer.stopped'].includes(event.type)) onEvent({ type: event.type });
    if (event.type === 'turn.done' && event.turn?.role === 'assistant') onEvent({ type: 'aria.turn.done' });
    if (event.type === 'error') {
      const detail = String(event.error?.message || '').replaceAll(auth.token, '[redacted]').slice(0, 320);
      console.warn('Aria voice error:', event.error?.code || event.error?.type || 'unknown', detail);
      onEvent({ type: 'aria.error', message: 'OpenAI reported a voice-session error. Please reconnect.' });
    }
  });
  socket.on('close', onClose);
  socket.on('error', () => onEvent({ type: 'aria.error', message: 'The voice connection was interrupted. Please reconnect.' }));
  await new Promise((resolve, reject) => {
    const abort = () => { socket.close(); reject(new Error('Voice connection cancelled.')); };
    signal?.addEventListener('abort', abort, { once: true });
    const cleanup = () => signal?.removeEventListener('abort', abort);
    socket.once('open', () => { cleanup(); resolve(); });
    socket.once('error', error => { cleanup(); console.warn('Aria control connection:', error.message.replaceAll(auth.token, '[redacted]').slice(0, 180)); reject(new Error('OpenAI voice could not open its control connection.')); });
    socket.once('close', () => { cleanup(); reject(new Error('OpenAI voice closed before it was ready.')); });
  });
  const send = event => { if (socket?.readyState === WebSocket.OPEN) socket.send(JSON.stringify(event)); };
  return {
    answerSdp, sessionId,
    deliver: (id, text) => { for (const part of chunks(text)) send({ type: 'delegation.context.append', delegation_item_id: id, content: [{ type: 'input_text', text: part }] }); },
    speak: text => {
      for (const part of chunks(text)) send({ type: 'session.context.append', channel: 'speakable', content: [{ type: 'input_text', text: part }] });
    },
    close: () => {
      if (!socket) return;
      send({ type: 'session.close' });
      const timeout = setTimeout(() => socket.terminate(), 2000);
      timeout.unref(); socket.once('close', () => clearTimeout(timeout));
    }
  };
}
