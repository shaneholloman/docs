import { test, expect } from 'bun:test';
import { mkdtemp, mkdir, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { previewFiles, syncPreview } from '../tools/files.ts';

test('Mintlify receives only site content and unchanged syncs do not trigger reloads', async () => {
  const root = await mkdtemp(join(tmpdir(), 'cv-preview-test-'));
  const source = join(root, 'source');
  const preview = join(root, 'preview');
  try {
    await mkdir(join(source, 'dist/server'), { recursive: true });
    await mkdir(join(source, 'data/auth'), { recursive: true });
    for (const name of previewFiles) await Bun.write(join(source, name), `fixture: ${name}`);
    await Bun.write(join(source, 'dist/server/server.js'), 'import http from "http";');
    await Bun.write(join(source, 'data/auth/auth.json'), 'private fixture');
    await syncPreview(source, preview);
    const files = Array.from(new Bun.Glob('**/*').scanSync(preview)).sort();
    expect(files).toEqual([...previewFiles].sort());
    const before = await stat(join(preview, 'header.js'));
    await syncPreview(source, preview);
    expect((await stat(join(preview, 'header.js'))).mtimeMs).toBe(before.mtimeMs);
    await Bun.write(join(source, 'index.mdx'), 'updated CV');
    await syncPreview(source, preview);
    expect(await Bun.file(join(preview, 'index.mdx')).text()).toBe('updated CV');
    expect((await stat(join(preview, 'header.js'))).mtimeMs).toBe(before.mtimeMs);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
