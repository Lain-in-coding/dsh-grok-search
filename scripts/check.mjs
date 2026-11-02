import { readdirSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

const files = [];
function collect(directory) {
  for (const item of readdirSync(directory, { withFileTypes: true })) {
    const path = join(directory, item.name);
    if (item.isDirectory()) collect(path);
    else if (path.endsWith('.mjs') || path.endsWith('.js')) files.push(path);
  }
}
for (const directory of ['scripts', 'src', 'fixtures', 'test']) collect(directory);
for (const file of files) {
  const result = spawnSync(process.execPath, ['--check', file], { stdio: 'inherit', windowsHide: true });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status ?? 1);
}
console.log(`Syntax checked ${files.length} JavaScript modules.`);
