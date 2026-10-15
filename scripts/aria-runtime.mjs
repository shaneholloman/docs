import { spawn } from 'node:child_process';

const children = ['aria-server.mjs', 'aria-preview.mjs'].map(file => spawn(process.execPath, [`scripts/${file}`], { stdio: 'inherit' }));
let stopping = false;
const stop = (code = 0) => {
  if (stopping) return;
  stopping = true; process.exitCode = code;
  for (const child of children) child.kill('SIGTERM');
};
for (const child of children) {
  child.once('error', error => { console.error(error.message); stop(1); });
  child.once('exit', code => { if (!stopping) stop(code || 0); });
}
process.once('SIGINT', () => stop()); process.once('SIGTERM', () => stop());
