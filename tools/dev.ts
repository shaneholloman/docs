import { spawn } from 'node:child_process';
import { watch } from 'node:fs';
import { buildBrowser } from './build.ts';

const mint = Bun.which('mint');
if (!mint) throw new Error('Install the Mintlify CLI with bun add --global mint.');
await buildBrowser();
const children = [
  spawn(process.execPath, ['--watch', 'src/server/aria-server.ts'], { stdio: 'inherit' }),
  spawn(process.execPath, ['--bun', mint, 'dev', '--no-open'], { stdio: 'inherit' })
];
if (process.argv.includes('--preview'))
  children.push(
    spawn(process.execPath, ['--watch', 'src/server/aria-preview.ts'], { stdio: 'inherit' })
  );
let rebuild = Promise.resolve();
let timer: ReturnType<typeof setTimeout> | undefined;
const schedule = () => {
  clearTimeout(timer);
  timer = setTimeout(() => {
    rebuild = rebuild
      .then(buildBrowser)
      .catch((error) => console.error('Browser build failed:', error));
  }, 100);
};
const watchers = [
  watch('src/client', { recursive: true }, schedule),
  watch('src/shared', { recursive: true }, schedule),
  watch('.', (_, filename) => {
    if (filename === 'aria.svg' || filename === 'style.css') schedule();
  })
];
let stopping = false;
function stop(code: number = 0) {
  if (stopping) return;
  stopping = true;
  process.exitCode = code;
  clearTimeout(timer);
  for (const watcher of watchers) watcher.close();
  for (const child of children) child.kill('SIGTERM');
}
for (const child of children) {
  child.once('error', (error) => {
    console.error(error.message);
    stop(1);
  });
  child.once('exit', (code) => {
    if (!stopping) stop(code || 0);
  });
}
process.once('SIGINT', () => stop());
process.once('SIGTERM', () => stop());
