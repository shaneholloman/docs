import { mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';

export async function writeChanged(path: string | URL, content: string | Uint8Array) {
  const file = Bun.file(path);
  const bytes = typeof content === 'string' ? new TextEncoder().encode(content) : content;
  if ((await file.exists()) && Buffer.from(await file.arrayBuffer()).equals(Buffer.from(bytes)))
    return false;
  await Bun.write(path, bytes);
  return true;
}

// A strict content boundary: Mintlify's local scanner does not honor .mintignore.
export const previewFiles = [
  'docs.json',
  'index.mdx',
  'style.css',
  'favicon.svg',
  'aria.svg',
  'header.js'
] as const;

export async function syncPreview(source: string, destination: string) {
  await mkdir(destination, { recursive: true });
  for (const name of previewFiles) {
    const target = `${destination}/${name}`;
    await mkdir(dirname(target), { recursive: true });
    await writeChanged(target, new Uint8Array(await Bun.file(`${source}/${name}`).arrayBuffer()));
  }
}
