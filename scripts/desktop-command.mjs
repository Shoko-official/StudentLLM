import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

const localCargoDir = process.platform === 'win32' && process.env.USERPROFILE
  ? join(process.env.USERPROFILE, '.cargo', 'bin')
  : null;
const environment = { ...process.env };
if (localCargoDir && existsSync(join(localCargoDir, 'cargo.exe'))) {
  const pathKey = Object.keys(environment).find((key) => key.toLowerCase() === 'path') ?? 'PATH';
  environment[pathKey] = [localCargoDir, environment[pathKey]].filter(Boolean).join(';');
}

const tauriScript = join(process.cwd(), 'node_modules', '@tauri-apps', 'cli', 'tauri.js');
const result = spawnSync(process.execPath, [tauriScript, ...process.argv.slice(2)], {
  stdio: 'inherit',
  env: environment,
});

if (result.error) {
  console.error(`Unable to run Tauri: ${result.error.message}`);
  process.exit(1);
}

process.exit(result.status ?? 1);
