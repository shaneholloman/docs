import { FingerprintPattern } from 'lucide';
import { writeFile } from 'node:fs/promises';

const escapeAttribute = value => String(value).replaceAll('&', '&amp;').replaceAll('"', '&quot;').replaceAll('<', '&lt;');
const paths = FingerprintPattern.map(([tag, attributes]) => {
  const attrs = Object.entries(attributes).map(([name, value]) => `${name}="${escapeAttribute(value)}"`).join(' ');
  return `  <${tag} ${attrs}/>`;
}).join('\n');

await writeFile(new URL('../favicon.svg', import.meta.url), `<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
  <style>
    :root { color-scheme: light dark; color: CanvasText; }
  </style>
${paths}
</svg>
`);
