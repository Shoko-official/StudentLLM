import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const binaryPath = process.argv[2];
const recoveryRequested = process.argv[3] === '--crash-recovery';
const smokeDurationMs = 15_000;
const shutdownGraceMs = 5_000;

if (!binaryPath) {
  console.error('Usage: node scripts/desktop-runtime-smoke.mjs <binary-path> [--crash-recovery]');
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

      if (forceKill && signal !== 'SIGKILL') {
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

function checkWorkspaceDatabase(databasePath) {
  return new Promise((resolve, reject) => {
    const sqlite = spawn('sqlite3', [databasePath, `PRAGMA integrity_check;
      SELECT CASE WHEN EXISTS (
        SELECT 1 FROM workspace WHERE id = 1 AND version = 1 AND length(snapshot) > 0
      ) THEN 'snapshot-present' ELSE 'snapshot-missing' END;`], {
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    sqlite.stdout.setEncoding('utf8');
    sqlite.stderr.setEncoding('utf8');
    sqlite.stdout.on('data', (chunk) => { stdout += chunk; });
    sqlite.stderr.on('data', (chunk) => { stderr += chunk; });
    sqlite.once('error', (error) => reject(new Error(`SQLite integrity check could not start: ${error.message}`)));
    sqlite.once('exit', (code, signal) => {
      if (code !== 0 || signal) {
        reject(new Error(`SQLite integrity check failed (code=${code}, signal=${signal}): ${stderr.trim()}`));
        return;
      }
      const results = stdout.trim().split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
      if (results[0] !== 'ok') {
        reject(new Error(`SQLite integrity check returned ${JSON.stringify(results[0] ?? '')}.`));
        return;
      }
      if (results[1] !== 'snapshot-present') {
        reject(new Error(`Workspace snapshot check returned ${JSON.stringify(results[1] ?? '')}.`));
        return;
      }
      resolve();
    });
  });
}

async function runCrashRecovery() {
  const dataRoot = await mkdtemp(join(tmpdir(), 'studentllm-desktop-recovery-'));
  const environment = {
    ...process.env,
    HOME: dataRoot,
    XDG_DATA_HOME: dataRoot,
    XDG_CACHE_HOME: join(dataRoot, 'cache'),
    XDG_CONFIG_HOME: join(dataRoot, 'config'),
    WEBKIT_DISABLE_DMABUF_RENDERER: '1',
  };

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
    console.log('Desktop runtime recovered after SIGKILL with a persisted workspace snapshot and SQLite integrity_check returning ok.');
  } finally {
    await rm(dataRoot, { recursive: true, force: true });
  }
}

try {
  const environment = {
    ...process.env,
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
