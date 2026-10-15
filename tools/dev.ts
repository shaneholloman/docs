import { spawn } from 'node:child_process';
import { watch } from 'node:fs';
import { mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { createRequire } from 'node:module';
import { buildBrowser } from './build.ts';
import { previewFiles, syncPreview } from './files.ts';

const mint = Bun.which('mint');
if (!mint) throw new Error('Install the Mintlify CLI with bun add --global mint.');
await buildBrowser();
const source = process.cwd();
const preview = await mkdtemp(join(tmpdir(), 'shane-cv-preview-'));
await syncPreview(source, preview);
// Bypass Mintlify's executable wrapper, which otherwise launches Node internally.
const requireMint = createRequire(await realpath(mint));
const mintStart = join(dirname(requireMint.resolve('@mintlify/cli')), 'start.js');
const children = [
  spawn(process.execPath, ['--watch', 'src/server/aria-server.ts'], { stdio: 'inherit' }),
  spawn(process.execPath, [mintStart, 'dev', '--no-open'], {
    cwd: preview,
    stdio: 'inherit',
    env: { ...process.env, MINTLIFY_PACKAGE_NAME: 'mint' }
  })
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
      .then(() => syncPreview(source, preview))
      .catch((error) => console.error('Browser build failed:', error));
  }, 100);
};
const watchers = [
  watch('src/client', { recursive: true }, schedule),
  watch('src/shared', { recursive: true }, schedule),
  watch('.', (_, filename) => {
    if (previewFiles.some((name) => name === filename)) schedule();
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
  void Promise.all(
    children.map(
      (child) =>
        new Promise<void>((resolve) => {
          if (child.exitCode !== null || child.signalCode !== null) resolve();
          else child.once('exit', () => resolve());
        })
    )
  ).then(() => rm(preview, { recursive: true, force: true }));
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
