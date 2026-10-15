import { mkdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { writeChanged } from './files.ts';

export async function prepareKnowledge() {
  const packageDirectory = dirname(
    fileURLToPath(import.meta.resolve('@shane/aria-guide/package.json'))
  );
  const target = 'dist/knowledge/Aria-guide';
  await mkdir(target, { recursive: true });
  for (const name of ['guide.sqlite', 'manifest.json'])
    await writeChanged(
      join(target, name),
      new Uint8Array(await Bun.file(join(packageDirectory, name)).arrayBuffer())
    );
  for await (const name of new Bun.Glob('*.md').scan('knowledge'))
    await writeChanged(
      join('dist/knowledge', name),
      await Bun.file(join('knowledge', name)).text()
    );
}
