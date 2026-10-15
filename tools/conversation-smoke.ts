import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { askLuna } from '../src/server/aria-openai.ts';
import type { ConversationControlName, ResponseItem } from '../src/shared/aria-contracts.ts';

// Explicit subscription eval. Tools are spies: no visitor data or calls are changed.
const question = (text: string): ResponseItem[] => [
  { type: 'message', role: 'assistant', content: [{ type: 'output_text', text }] }
];
const combined = question(
  'Did you want me to clear our saved conversation history and end the call here?'
);
const sessionId = randomUUID();
const scenarios: Array<{
  prompt: string;
  current: ResponseItem[];
  expected?: ConversationControlName;
  previous?: ResponseItem[];
}> = [
  ...[
    'Sure',
    'Yep',
    'Go ahead',
    'Go for it',
    'Fill yer boots',
    'Sí, adelante',
    'Oui, allez-y',
    'はい、お願いします'
  ].map((prompt) => ({ prompt, current: combined, expected: 'VisitorMemoryDelete' as const })),
  { prompt: 'Just end the call, keep the history', current: combined, expected: 'ConversationEnd' },
  {
    prompt: 'Sure',
    current: question('Did you want to end the call here?'),
    expected: 'ConversationEnd'
  },
  { prompt: 'No, keep it. I want to keep talking.', current: combined },
  { prompt: 'If you would, can you clear this session?', current: [] },
  { prompt: 'Sure', current: [], previous: combined }
];
for (const scenario of scenarios) {
  const executed: ConversationControlName[] = [];
  const started = performance.now();
  const answer = await askLuna({
    prompt: scenario.prompt,
    knowledge: '<resume>Shane Holloman leads AI at Cello Group.</resume>',
    history: scenario.previous,
    sessionId,
    conversationControl: {
      history: scenario.current,
      execute(name) {
        executed.push(name);
        return JSON.stringify({ status: name === 'VisitorMemoryDelete' ? 'cleared' : 'ending' });
      }
    }
  });
  assert.deepEqual(executed, scenario.expected ? [scenario.expected] : [], scenario.prompt);
  if (scenario.prompt.includes('clear this session')) {
    assert.match(answer, /history|memory/i);
    assert.match(answer, /end|call/i);
  }
  console.log(
    JSON.stringify({
      prompt: scenario.prompt,
      context: scenario.current.length ? 'current call' : 'no current confirmation',
      executed,
      elapsedMs: Math.round(performance.now() - started)
    })
  );
}
console.log('Conversation intent eval passed. No application controls were executed.');
