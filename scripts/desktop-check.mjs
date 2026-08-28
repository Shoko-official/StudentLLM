import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

const localCargo = process.platform === 'win32' && process.env.USERPROFILE
  ? join(process.env.USERPROFILE, '.cargo', 'bin', 'cargo.exe')
  : null;
const cargo = localCargo && existsSync(localCargo) ? localCargo : 'cargo';
const environment = { ...process.env };
if (process.platform === 'win32' && !environment.CARGO_TARGET_DIR && environment.LOCALAPPDATA) {
  environment.CARGO_TARGET_DIR = join(environment.LOCALAPPDATA, 'StudentLLM', 'cargo-target');
}
const result = spawnSync(cargo, ['check', '--manifest-path', 'src-tauri/Cargo.toml'], {
  stdio: 'inherit',
  env: environment,
});

if (result.error) {
  console.error(`Unable to run Cargo: ${result.error.message}`);
  process.exit(1);
}

process.exit(result.status ?? 1);
