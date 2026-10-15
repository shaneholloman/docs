import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const extension = import.meta.url.endsWith('.ts') ? 'ts' : 'js';
const children = ['aria-server', 'aria-preview'].map((file) =>
  spawn(process.execPath, [fileURLToPath(new URL(`./${file}.${extension}`, import.meta.url))], {
    stdio: 'inherit'
  })
);
let stopping = false;
const stop = (code: number = 0) => {
  if (stopping) return;
  stopping = true;
  process.exitCode = code;
  for (const child of children) child.kill('SIGTERM');
};
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
