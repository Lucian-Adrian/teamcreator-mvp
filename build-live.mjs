import { spawnSync } from 'node:child_process';
const run = (script, args = [], env = process.env) => {
  const result = spawnSync(process.execPath, [script, ...args], { stdio: 'inherit', env });
  if (result.status !== 0) process.exit(result.status ?? 1);
};
run('node_modules/typescript/bin/tsc', ['-b']);
run('node_modules/vite/bin/vite.js', ['build', '--outDir', 'dist-live'], { ...process.env, VITE_PUBLIC_DEMO: 'true' });
