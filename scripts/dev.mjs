import { spawn } from 'node:child_process';

const mint = Bun.which('mint');
if (!mint) throw new Error('Install the Mintlify CLI with bun add --global mint.');
const children = [
  spawn(process.execPath, ['--watch', 'scripts/aria-server.mjs'], { stdio: 'inherit' }),
  spawn(process.execPath, ['--bun', mint, 'dev', '--no-open'], { stdio: 'inherit' })
];
if (process.argv.includes('--preview')) children.push(spawn(process.execPath, ['--watch', 'scripts/aria-preview.mjs'], { stdio: 'inherit' }));
let stopping = false;
function stop(code = 0) {
  if (stopping) return;
  stopping = true;
  process.exitCode = code;
  for (const child of children) child.kill('SIGTERM');
}
for (const child of children) {
  child.once('error', error => { console.error(error.message); stop(1); });
  child.once('exit', code => { if (!stopping) stop(code || 0); });
}
process.once('SIGINT', () => stop());
process.once('SIGTERM', () => stop());
