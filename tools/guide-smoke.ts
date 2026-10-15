import assert from 'node:assert/strict';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { openAriaGuide } from '../src/server/aria-guide.ts';
import { loadKnowledge } from '../src/server/aria-knowledge.ts';
import { askLuna } from '../src/server/aria-openai.ts';
import type { ResponseItem } from '../src/shared/aria-contracts.ts';

// Explicit local subscription regression scenarios. No microphone or visitor data.
const guide = openAriaGuide(
  dirname(fileURLToPath(import.meta.resolve('@shane/aria-guide/package.json')))
);
try {
  const material = await loadKnowledge('index.mdx', undefined, guide.lookup, 'knowledge');
  assert.match(material.text, /<project_brief>[\s\S]*entire Aria harness/);
  const scenarios = [
    {
      name: 'overview after a weak earlier answer',
      prompt: "Tell me more about the platform he's working on.",
      history: [
        {
          type: 'message',
          role: 'assistant',
          content: [
            {
              type: 'output_text',
              text: "Shane works on Aria, though the intro doesn't go into the specific harness details."
            }
          ]
        }
      ] satisfies ResponseItem[],
      detailed: false
    },
    {
      name: 'general platform and harness interest',
      prompt:
        "I'm particularly interested in the Aria platform and the harness he's built. What does it do?",
      history: [],
      detailed: false
    },
    {
      name: 'direct authorship scope',
      prompt: 'How much of the Aria agent harness did Shane build himself?',
      detailed: false,
      authorship: true,
      history: []
    },
    {
      name: 'harness architecture',
      prompt: 'How does the Aria harness work under the hood?',
      history: [],
      detailed: true
    },
    {
      name: 'specific harness capability',
      prompt: 'How does the Aria harness route a voice request to a background agent?',
      history: [],
      detailed: true
    }
  ];
  for (const scenario of scenarios) {
    const calls: Array<{ name: string; mode?: string; page?: string }> = [];
    const started = performance.now();
    const answer = await askLuna({
      prompt: scenario.prompt,
      history: scenario.history,
      knowledge: material.text,
      lookup: material.lookup,
      onTool(name, args) {
        const input = args as { mode?: string; page?: string };
        calls.push({ name, mode: input.mode, page: input.page });
      }
    });
    if (!('authorship' in scenario && scenario.authorship)) {
      assert.ok(
        calls.some((call) => call.name === 'AriaQuery'),
        'Platform capability answers must retrieve evidence.'
      );
    }
    assert.doesNotMatch(
      answer,
      /(?:intro(?:duction)?|guide|documentation)\s+(?:does(?:n't| not)|lacks?)\s+(?:go into|explain|provide|cover).*harness/i
    );
    if (scenario.detailed) {
      assert.ok(
        calls.some(
          (call) =>
            call.name === 'AriaQuery' &&
            (call.mode === 'reference' ||
              (call.mode === 'page' && call.page !== 'orientation-getting-started'))
        ),
        'Harness detail must retrieve beyond the introduction.'
      );
    } else if ('authorship' in scenario && scenario.authorship) {
      assert.match(answer, /entire|whole|complete|top to bottom|end.to.end|all of/i);
      assert.match(answer, /harness/i);
    } else {
      assert.match(answer, /Shane/i);
      assert.doesNotMatch(
        answer,
        /YOLO|local orchestration runtime|entire harness|entire Aria harness|top to bottom/i
      );
    }
    console.log(
      JSON.stringify({
        scenario: scenario.name,
        elapsedMs: Math.round(performance.now() - started),
        calls
      })
    );
    console.log(answer);
  }
  console.log('Local subscription guidance scenarios passed.');
} finally {
  guide.close();
}
