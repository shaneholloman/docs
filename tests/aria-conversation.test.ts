import { expect, test } from 'bun:test';
import {
  createConversationEnding,
  parseConversationTool
} from '../src/server/aria-conversation.ts';

test('voice control accepts only the declared conversation tools with no arguments', () => {
  expect(parseConversationTool('Tell me about Shane.')).toBeUndefined();
  expect(
    parseConversationTool('<voice_tool>{"name":"ConversationEnd","arguments":{}}</voice_tool>')
  ).toEqual({ name: 'ConversationEnd', arguments: {} });
  expect(
    parseConversationTool('<voice_tool>{"name":"VisitorMemoryDelete","arguments":{}}</voice_tool>')
  ).toEqual({ name: 'VisitorMemoryDelete', arguments: {} });
  for (const input of [
    '<voice_tool>{"name":"VisitorMemoryDelete","arguments":{"visitorId":"someone-else"}}</voice_tool>',
    '<voice_tool>{"name":"shutdown","arguments":{}}</voice_tool>',
    '<voice_tool>{"name":"ConversationEnd","arguments":{"session":"other"}}</voice_tool>',
    '<voice_tool>{"name":"ConversationEnd","arguments":{},"extra":true}</voice_tool>',
    '<voice_tool>{"name":"ConversationEnd","arguments":{}}',
    '<voice_tool>not JSON</voice_tool>'
  ])
    expect(() => parseConversationTool(input)).toThrow();
});

test('ending ignores an empty delegation turn and waits for the spoken farewell', async () => {
  let finished = 0;
  const ending = createConversationEnding(() => finished++, {
    turnMilliseconds: 5,
    timeoutMilliseconds: 1000
  });
  expect(ending.begin()).toBe(true);
  expect(ending.begin()).toBe(false);
  ending.observe({ type: 'aria.turn.done' });
  await Bun.sleep(20);
  expect(finished).toBe(0);
  ending.observe({ type: 'aria.caption', role: 'assistant', delta: 'Goodbye!', timestamp: 1 });
  ending.observe({ type: 'aria.turn.done' });
  await Bun.sleep(20);
  expect(finished).toBe(1);
  expect(ending.begin()).toBe(false);
});

test('a drained audio buffer finishes the call once and releases its timers', async () => {
  let finished = 0;
  const ending = createConversationEnding(() => finished++, {
    drainMilliseconds: 5,
    turnMilliseconds: 100,
    timeoutMilliseconds: 1000
  });
  ending.begin();
  ending.observe({ type: 'output_audio_buffer.started' });
  ending.observe({ type: 'aria.turn.done' });
  ending.observe({ type: 'output_audio_buffer.stopped' });
  await Bun.sleep(20);
  expect(finished).toBe(1);
  ending.observe({ type: 'output_audio_buffer.stopped' });
  await Bun.sleep(20);
  expect(finished).toBe(1);
});

test('unrequested endings never act, and manual closure cancels a pending goodbye', async () => {
  let finished = 0;
  const ending = createConversationEnding(() => finished++, { timeoutMilliseconds: 5 });
  ending.observe({ type: 'output_audio_buffer.started' });
  ending.observe({ type: 'output_audio_buffer.stopped' });
  expect(finished).toBe(0);
  ending.begin();
  ending.dispose();
  await Bun.sleep(20);
  expect(finished).toBe(0);
});

test('a missing farewell cannot leave the microphone session open indefinitely', async () => {
  let finished = 0;
  const ending = createConversationEnding(() => finished++, { timeoutMilliseconds: 5 });
  ending.begin();
  await Bun.sleep(20);
  expect(finished).toBe(1);
});

test('a completed spoken transcript can finish the farewell when caption events are absent', async () => {
  let finished = 0;
  const ending = createConversationEnding(() => finished++, {
    turnMilliseconds: 5,
    timeoutMilliseconds: 1000
  });
  ending.begin();
  ending.observe({ type: 'aria.turn.done', transcript: 'Thanks for visiting. Goodbye!' });
  await Bun.sleep(20);
  expect(finished).toBe(1);
});

test('clearing memory restarts farewell timing instead of reusing a pending goodbye', async () => {
  let finished = 0;
  const ending = createConversationEnding(() => finished++, {
    drainMilliseconds: 5,
    timeoutMilliseconds: 1000
  });
  ending.begin();
  ending.observe({ type: 'output_audio_buffer.started' });
  ending.observe({ type: 'output_audio_buffer.stopped' });
  expect(ending.begin(true)).toBe(true);
  await Bun.sleep(20);
  expect(finished).toBe(0);
  ending.observe({ type: 'output_audio_buffer.started' });
  ending.observe({ type: 'output_audio_buffer.stopped' });
  await Bun.sleep(20);
  expect(finished).toBe(1);
});
