const generated = new Set(['header.js']);
const result = Bun.spawnSync([
  'git',
  'ls-files',
  '--cached',
  '--others',
  '--exclude-standard',
  '-z'
]);
if (result.exitCode !== 0) throw new Error('Unable to audit repository source files.');
for (const name of result.stdout.toString().split('\0').filter(Boolean)) {
  if (!/\.(?:[cm]?js|jsx)$/.test(name) || !(await Bun.file(name).exists())) continue;
  if (!generated.has(name)) throw new Error(`Authored JavaScript is not allowed: ${name}`);
  if (!(await Bun.file(name).text()).startsWith('/* eslint-disable -- Generated bundle'))
    throw new Error(`Browser asset must be generated from TypeScript: ${name}`);
}
console.log('Source audit passed: application, tooling, and tests are TypeScript.');
