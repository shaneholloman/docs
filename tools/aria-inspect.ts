import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { loadKnowledge } from '../src/server/aria-knowledge.ts';
import { openAriaGuide } from '../src/server/aria-guide.ts';
import { prepareKnowledge } from './guide-assets.ts';

const directory = process.env.ARIA_KNOWLEDGE_DIR || resolve('data/knowledge');
await prepareKnowledge();
const guide = openAriaGuide(resolve('dist/knowledge/Aria-guide'));
const material = await loadKnowledge(
  resolve('index.mdx'),
  directory,
  guide.lookup,
  resolve('dist/knowledge')
);
guide.close();
await mkdir('data', { recursive: true });
await writeFile('data/aria-context.xml', material.text);
console.log(`Initial agent context: ${resolve('data/aria-context.xml')}`);
console.log(`Approved background: ${directory}`);
console.log(
  `Sources: ${material.count}; Luna tools: ${material.lookup.tools.map((tool) => tool.name).join(', ')}`
);
