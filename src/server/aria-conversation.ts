import { z } from 'zod';
import type { AriaEvent, FunctionTool } from '../shared/aria-contracts.ts';

export const toolCallSchema = z.strictObject({
  name: z.enum(['ConversationEnd', 'VisitorMemoryDelete']),
  arguments: z.strictObject({})
});

export const conversationTools: FunctionTool[] = [
  {
    type: 'function',
    name: 'ConversationEnd',
    description:
      'End only the current caller’s voice call after a clear goodbye or request to end. Keeps saved history. Do not use for ordinary thanks or an ambiguous clear/reset request.',
    strict: true,
    parameters: { type: 'object', properties: {}, required: [], additionalProperties: false }
  },
  {
    type: 'function',
    name: 'VisitorMemoryDelete',
    description:
      'Delete the current caller’s saved transcript, visitor record and memory, then end the call. Use only for an explicit deletion request or confirmation in this current call. An ambiguous clear/reset request needs clarification first. Cannot target other visitors.',
    strict: true,
    parameters: { type: 'object', properties: {}, required: [], additionalProperties: false }
  }
];

/** Match the client-delegation tool envelope used by the native Aria app. */
export function parseConversationTool(prompt: string) {
  const text = prompt.trim();
  if (!text.startsWith('<voice_tool>')) return;
  if (!text.endsWith('</voice_tool>')) throw new Error('Incomplete voice tool call.');
  return toolCallSchema.parse(JSON.parse(text.slice(12, -13)));
}

/** Let the farewell play before releasing the current voice session. */
export function createConversationEnding(
  finish: () => void,
  { drainMilliseconds = 250, turnMilliseconds = 1000, timeoutMilliseconds = 15_000 } = {}
) {
  let pending = false;
  let outputStarted = false;
  let closed = false;
  let drain: ReturnType<typeof setTimeout> | undefined;
  let deadline: ReturnType<typeof setTimeout> | undefined;
  function dispose() {
    closed = true;
    clearTimeout(drain);
    clearTimeout(deadline);
  }
  function complete() {
    if (closed) return;
    dispose();
    finish();
  }
  return {
    get pending() {
      return pending;
    },
    begin(restart = false) {
      if ((pending && !restart) || closed) return false;
      clearTimeout(drain);
      clearTimeout(deadline);
      outputStarted = false;
      pending = true;
      deadline = setTimeout(complete, timeoutMilliseconds);
      return true;
    },
    observe(event: AriaEvent) {
      if (!pending || closed) return;
      if (event.type === 'output_audio_buffer.started') {
        outputStarted = true;
        clearTimeout(drain);
      }
      if (event.type === 'aria.caption' && event.role === 'assistant' && event.delta.trim())
        outputStarted = true;
      if (event.type === 'aria.turn.done' && event.transcript?.trim()) outputStarted = true;
      // An empty turn completing the delegation is not the spoken farewell.
      if (!outputStarted) return;
      if (event.type === 'output_audio_buffer.stopped' || event.type === 'aria.turn.done') {
        clearTimeout(drain);
        // The subscription transport also exposes turn.done. Allow its queued
        // WebRTC audio to drain when no buffer-stopped event is available.
        drain = setTimeout(
          complete,
          event.type === 'output_audio_buffer.stopped' ? drainMilliseconds : turnMilliseconds
        );
      }
    },
    dispose
  };
}
