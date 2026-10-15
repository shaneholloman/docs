import { FingerprintPattern } from 'lucide';
import { writeChanged } from './files.ts';

const escapeAttribute = (value: unknown) =>
  String(value).replaceAll('&', '&amp;').replaceAll('"', '&quot;').replaceAll('<', '&lt;');
const paths = FingerprintPattern.map(([tag, attributes]) => {
  const attrs = Object.entries(attributes)
    .map(([name, value]) => `${name}="${escapeAttribute(value)}"`)
    .join(' ');
  return `  <${tag} ${attrs}/>`;
}).join('\n');

export async function generateLogo() {
  await writeChanged(
    new URL('../favicon.svg', import.meta.url),
    `<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
  <style>
    :root { color-scheme: light dark; color: #737373; }
  </style>
${paths}
</svg>
`
  );
}
if (import.meta.main) await generateLogo();
