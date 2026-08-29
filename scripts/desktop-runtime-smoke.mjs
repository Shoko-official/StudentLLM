import { existsSync } from 'node:fs';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const requestedBinaryPath = process.argv[2];
const recoveryRequested = process.argv[3] === '--crash-recovery';
const smokeDurationMs = 15_000;
const shutdownGraceMs = 5_000;

if (!requestedBinaryPath) {
  console.error('Usage: node scripts/desktop-runtime-smoke.mjs <binary-path> [--crash-recovery]');
  process.exit(2);
}

const binaryPath = existsSync(requestedBinaryPath) ? requestedBinaryPath : `${requestedBinaryPath}.exe`;

if (!existsSync(binaryPath)) {
  console.error(`Desktop runtime binary was not found at ${requestedBinaryPath}.`);
  process.exit(2);
}

function spawnRuntime(environment) {
  const child = spawn(binaryPath, [], {
    stdio: ['ignore', 'pipe', 'pipe'],
    env: environment,
  });

  let stdout = '';
  let stderr = '';
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  child.stdout.on('data', (chunk) => { stdout += chunk; });
  child.stderr.on('data', (chunk) => { stderr += chunk; });

  return { child, getOutput: () => ({ stdout, stderr }) };
}

function runSmoke(environment, { forceKill = false, durationMs = smokeDurationMs } = {}) {
  const { child, getOutput } = spawnRuntime(environment);

  return new Promise((resolve, reject) => {
    let timedOut = false;
    let settled = false;
    let shutdownTimer;
    let forceTimer;

    const finish = (callback, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(shutdownTimer);
      clearTimeout(forceTimer);
      callback(value);
    };

    shutdownTimer = setTimeout(() => {
      timedOut = true;
      if (forceKill) {
        child.kill('SIGKILL');
      } else {
        child.kill('SIGTERM');
        forceTimer = setTimeout(() => child.kill('SIGKILL'), shutdownGraceMs);
      }
    }, durationMs);

    child.once('error', (error) => {
      finish(reject, new Error(`Desktop runtime failed to start: ${error.message}`));
    });

    child.once('exit', (code, signal) => {
      if (!timedOut) {
        const { stdout, stderr } = getOutput();
        const details = [
          `Desktop runtime exited before the ${durationMs / 1000}s smoke window (code=${code}, signal=${signal}).`,
          stdout.trim(),
          stderr.trim(),
        ].filter(Boolean).join('\n');
        finish(reject, new Error(details));
        return;
      }

      if (forceKill && process.platform !== 'win32' && signal !== 'SIGKILL') {
        finish(reject, new Error(`Crash-recovery process did not receive SIGKILL (code=${code}, signal=${signal}).`));
        return;
      }

      finish(resolve, { code, signal, ...getOutput() });
    });
  });
}

async function findFiles(root, fileName) {
  const matches = [];
  async function visit(directory) {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) {
        await visit(path);
      } else if (entry.isFile() && entry.name === fileName) {
        matches.push(path);
      }
    }
  }

  await visit(root);
  return matches;
}

const SQLITE_CHECK = `PRAGMA integrity_check;
      SELECT CASE WHEN EXISTS (
        SELECT 1 FROM workspace WHERE id = 1 AND version = 1 AND length(snapshot) > 0
      ) THEN 'snapshot-present' ELSE 'snapshot-missing' END;
      SELECT CASE WHEN EXISTS (
        SELECT 1 FROM workspace
        WHERE id = 1 AND version = 1 AND json_valid(snapshot)
          AND json_type(snapshot, '$.lessons') = 'array'
          AND json_array_length(json_extract(snapshot, '$.lessons')) > 0
      ) THEN 'frontend-snapshot-present' ELSE 'frontend-snapshot-missing' END;`;

function validateWorkspaceDatabaseOutput(stdout, stderr, code, signal) {
  if (code !== 0 || signal) {
    throw new Error(`SQLite integrity check failed (code=${code}, signal=${signal}): ${stderr.trim()}`);
  }
  const results = stdout.trim().split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  if (results[0] !== 'ok') {
    throw new Error(`SQLite integrity check returned ${JSON.stringify(results[0] ?? '')}.`);
  }
  if (results[1] !== 'snapshot-present') {
    throw new Error(`Workspace snapshot check returned ${JSON.stringify(results[1] ?? '')}.`);
  }
  if (results[2] !== 'frontend-snapshot-present') {
    throw new Error(`Frontend snapshot check returned ${JSON.stringify(results[2] ?? '')}.`);
  }
}

function checkWorkspaceDatabaseWithPython(databasePath) {
  const python = process.platform === 'win32' ? 'python' : 'python3';
  const script = `
import json
import sqlite3
import sys

connection = sqlite3.connect(sys.argv[1])
try:
    print(connection.execute('PRAGMA integrity_check').fetchone()[0])
    snapshot = connection.execute(
        'SELECT snapshot FROM workspace WHERE id = 1 AND version = 1 AND length(snapshot) > 0'
    ).fetchone()
    print('snapshot-present' if snapshot else 'snapshot-missing')
    lessons_present = False
    if snapshot:
        try:
            lessons_present = isinstance(json.loads(snapshot[0]).get('lessons'), list) and bool(json.loads(snapshot[0]).get('lessons'))
        except (AttributeError, TypeError, json.JSONDecodeError):
            lessons_present = False
    print('frontend-snapshot-present' if lessons_present else 'frontend-snapshot-missing')
finally:
    connection.close()
`;

  return new Promise((resolve, reject) => {
    const child = spawn(python, ['-c', script, databasePath], { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.once('error', (error) => reject(new Error(`Python SQLite integrity check could not start: ${error.message}`)));
    child.once('exit', (code, signal) => {
      try {
        validateWorkspaceDatabaseOutput(stdout, stderr, code, signal);
        resolve();
      } catch (error) {
        reject(error);
      }
    });
  });
}

function checkWorkspaceDatabase(databasePath) {
  return new Promise((resolve, reject) => {
    const sqlite = spawn('sqlite3', [databasePath, SQLITE_CHECK], {
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    let fallbackStarted = false;
    sqlite.stdout.setEncoding('utf8');
    sqlite.stderr.setEncoding('utf8');
    sqlite.stdout.on('data', (chunk) => { stdout += chunk; });
    sqlite.stderr.on('data', (chunk) => { stderr += chunk; });
    sqlite.once('error', (error) => {
      if (error.code === 'ENOENT') {
        fallbackStarted = true;
        checkWorkspaceDatabaseWithPython(databasePath).then(resolve, reject);
        return;
      }
      reject(new Error(`SQLite integrity check could not start: ${error.message}`));
    });
    sqlite.once('exit', (code, signal) => {
      if (fallbackStarted) return;
      try {
        validateWorkspaceDatabaseOutput(stdout, stderr, code, signal);
        resolve();
      } catch (error) {
        reject(error);
      }
    });
  });
}

function createRuntimeEnvironment(dataRoot) {
  const environment = {
    ...process.env,
    HOME: dataRoot,
    USERPROFILE: dataRoot,
    XDG_DATA_HOME: dataRoot,
    XDG_CACHE_HOME: join(dataRoot, 'cache'),
    XDG_CONFIG_HOME: join(dataRoot, 'config'),
    APPDATA: join(dataRoot, 'appdata'),
    LOCALAPPDATA: join(dataRoot, 'localappdata'),
    GDK_BACKEND: 'x11',
    LIBGL_ALWAYS_SOFTWARE: '1',
    WEBKIT_DISABLE_DMABUF_RENDERER: '1',
  };
  return environment;
}

async function runCrashRecovery() {
  const dataRoot = await mkdtemp(join(tmpdir(), 'studentllm-desktop-recovery-'));
  const environment = createRuntimeEnvironment(dataRoot);

  try {
    const firstRun = await runSmoke(environment, { forceKill: true, durationMs: 30_000 });
    const databasesAfterCrash = await findFiles(dataRoot, 'studentllm.sqlite3');
    if (databasesAfterCrash.length !== 1) {
      throw new Error(`Expected one workspace database after the forced stop, found ${databasesAfterCrash.length}.`);
    }

    const secondRun = await runSmoke(environment);
    const databasesAfterRelaunch = await findFiles(dataRoot, 'studentllm.sqlite3');
    if (databasesAfterRelaunch.length !== 1 || databasesAfterRelaunch[0] !== databasesAfterCrash[0]) {
      throw new Error('Workspace database was not preserved across the forced stop and relaunch.');
    }

    try {
      await checkWorkspaceDatabase(databasesAfterRelaunch[0]);
    } catch (error) {
      const outputs = [firstRun, secondRun]
        .flatMap(({ stdout, stderr }, index) => [
          `Runtime ${index + 1} stdout:\n${stdout.trim()}`,
          `Runtime ${index + 1} stderr:\n${stderr.trim()}`,
        ])
        .filter((output) => !output.endsWith(':'))
        .join('\n');
      throw new Error(`${error instanceof Error ? error.message : error}\n${outputs}`);
    }
    console.log('Desktop runtime recovered after SIGKILL with a frontend-persisted workspace snapshot and SQLite integrity_check returning ok.');
  } finally {
    await rm(dataRoot, { recursive: true, force: true });
  }
}

try {
  const environment = {
    ...process.env,
    GDK_BACKEND: 'x11',
    LIBGL_ALWAYS_SOFTWARE: '1',
    WEBKIT_DISABLE_DMABUF_RENDERER: '1',
  };
  if (recoveryRequested) {
    await runCrashRecovery();
  } else {
    await runSmoke(environment);
    console.log(`Desktop runtime stayed alive for ${smokeDurationMs / 1000}s and was stopped.`);
  }
} catch (error) {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
}
