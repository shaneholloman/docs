import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import assert from 'node:assert/strict';
import { loadKnowledge } from '../src/server/aria-knowledge.ts';
import { askLuna } from '../src/server/aria-openai.ts';

// Explicit live integration check, excluded from the default offline test suite.
// The fixture contains only approved career facts already present in the CV.
const directory = await mkdtemp(join(tmpdir(), 'aria-live-lookup-'));
try {
  await writeFile(
    join(directory, 'career-background.md'),
    '# Career background\n\nShane led IT and systems engineering at 8i, a 90-person video photogrammetry startup. His role at Cello Group is Head of AI.\n'
  );
  const material = await loadKnowledge(resolve('index.mdx'), directory);
  const tools: string[] = [];
  let readBackground = false;
  const answer = await askLuna({
    prompt:
      'Use KnowledgeQuery with mode search to find the supplemental career background, then mode page to read that source. Where did Shane lead IT for a 90-person startup, and how does that differ from his Cello role?',
    knowledge: material.text,
    lookup: material.lookup,
    onTool(name, args) {
      tools.push(name);
      if (
        name === 'KnowledgeQuery' &&
        typeof args === 'object' &&
        args !== null &&
        'page' in args &&
        args.page === 'career-background.md'
      )
        readBackground = true;
      console.log(`Executed ${name}`);
    }
  });
  assert.ok(
    tools.filter((name) => name === 'KnowledgeQuery').length >= 2,
    'Knowledge discovery and page reading must execute.'
  );
  assert.ok(
    readBackground && /8i/i.test(answer) && /Head of AI/i.test(answer),
    'Luna must retrieve the supplemental career source and answer correctly.'
  );
  console.log(
    'Live subscription retrieval passed. Both retrieval modes executed and Luna read the supplemental career source.'
  );
} finally {
  await rm(directory, { recursive: true, force: true });
}
