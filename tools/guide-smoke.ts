import assert from 'node:assert/strict';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { openAriaGuide } from '../src/server/aria-guide.ts';
import { loadKnowledge } from '../src/server/aria-knowledge.ts';
import { askLuna } from '../src/server/aria-openai.ts';

// Explicit local subscription integration check. No microphone or visitor data.
const guide = openAriaGuide(
  dirname(fileURLToPath(import.meta.resolve('@shane/aria-guide/package.json')))
);
try {
  const material = await loadKnowledge('index.mdx', undefined, guide.lookup, 'knowledge');
  const calls: string[] = [];
  const answer = await askLuna({
    prompt:
      'Tell me more about the Aria platform. What does it do, and did Shane create the entire Aria harness?',
    knowledge: material.text,
    lookup: material.lookup,
    onTool(name, args) {
      calls.push(name);
      console.log(JSON.stringify({ tool: name, arguments: args }));
    }
  });
  assert.ok(calls.includes('AriaQuery'), 'Luna must retrieve platform documentation.');
  assert.ok(calls.includes('KnowledgeQuery'), 'Luna must retrieve Shane’s stated contribution.');
  assert.match(answer, /Aria/i);
  assert.match(answer, /entire|whole|all|complete/i);
  console.log(answer);
  console.log('Local subscription Guide retrieval passed.');
} finally {
  guide.close();
}
