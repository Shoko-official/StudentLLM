import { existsSync } from 'node:fs';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const requestedBinaryPath = process.argv[2];
const recoveryRequested = process.argv[3] === '--crash-recovery';
const sidecarSupervisionRequested = process.argv.includes('--sidecar-supervision');
const frontendIpcRequested = process.argv.includes('--frontend-ipc');
const recoveryCyclesArgument = process.argv.find((argument) => argument.startsWith('--recovery-cycles='));
const recoveryCycles = recoveryCyclesArgument ? Number(recoveryCyclesArgument.slice('--recovery-cycles='.length)) : 1;
const smokeDurationMs = 15_000;
const shutdownGraceMs = 5_000;

if (!requestedBinaryPath) {
  console.error('Usage: node scripts/desktop-runtime-smoke.mjs <binary-path> [--crash-recovery] [--recovery-cycles=N] [--sidecar-supervision] [--frontend-ipc]');
  process.exit(2);
}

if (!Number.isInteger(recoveryCycles) || recoveryCycles < 1) {
  console.error('The recovery cycle count must be a positive integer.');
  process.exit(2);
}

const binaryPath = existsSync(requestedBinaryPath) ? requestedBinaryPath : `${requestedBinaryPath}.exe`;
const hostWindowsAppData = process.platform === 'win32' && process.env.CI === 'true' ? process.env.APPDATA : undefined;

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

function runSmoke(environment, { forceKill = false, durationMs = smokeDurationMs, allowEarlyExit = false } = {}) {
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
        if (allowEarlyExit && code === 0 && !signal) {
          finish(resolve, { code, signal, ...getOutput() });
          return;
        }
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

async function findWorkspaceDatabases(dataRoot) {
  const roots = [dataRoot, hostWindowsAppData].filter(Boolean);
  const matches = await Promise.all(roots.map((root) => findFiles(root, 'studentllm.sqlite3')));
  return [...new Set(matches.flat())];
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
    XDG_DATA_HOME: dataRoot,
    XDG_CACHE_HOME: join(dataRoot, 'cache'),
    XDG_CONFIG_HOME: join(dataRoot, 'config'),
    APPDATA: dataRoot,
    LOCALAPPDATA: dataRoot,
    GDK_BACKEND: 'x11',
    LIBGL_ALWAYS_SOFTWARE: '1',
    WEBKIT_DISABLE_DMABUF_RENDERER: '1',
  };
  if (process.platform !== 'win32') environment.HOME = dataRoot;
  return environment;
}

function sidecarCommand(readyFileVariable) {
  const script = `const fs=require('node:fs');const file=process.env.${readyFileVariable};fs.writeFileSync(file,String(process.pid));const cleanup=()=>{try{fs.rmSync(file,{force:true})}catch{};process.exit(0)};process.on('SIGTERM',cleanup);process.on('SIGINT',cleanup);setInterval(()=>{},1000);`;
  return `node -e "${script}"`;
}

async function waitForSidecarPid(readyFile, timeoutMs = 10_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const pid = Number((await readFile(readyFile, 'utf8')).trim());
      if (Number.isInteger(pid) && pid > 0) return pid;
    } catch {
      // The managed process has not written its readiness file yet.
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`Managed sidecar did not publish its readiness file within ${timeoutMs / 1000}s.`);
}

async function waitForSmokeMarker(markerFile, timeoutMs = 15_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const value = (await readFile(markerFile, 'utf8')).trim();
      if (value === 'ok') return;
    } catch {
      // The frontend has not completed its IPC call yet.
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`Packaged frontend IPC smoke marker was not written within ${timeoutMs / 1000}s.`);
}

function isProcessRunning(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function waitForProcessExit(pid, timeoutMs = 10_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!isProcessRunning(pid)) return;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`Managed sidecar process ${pid} remained alive after the desktop runtime exited.`);
}

async function runSidecarSupervision() {
  const dataRoot = await mkdtemp(join(tmpdir(), 'studentllm-desktop-sidecars-'));
  const asrReadyFile = join(dataRoot, 'asr.ready');
  const documentsReadyFile = join(dataRoot, 'documents.ready');
  const environment = {
    ...createRuntimeEnvironment(dataRoot),
    STUDENTLLM_AUTOSTART_SIDECARS: 'true',
    STUDENTLLM_ASR_COMMAND: sidecarCommand('STUDENTLLM_ASR_READY_FILE'),
    STUDENTLLM_DOCUMENT_COMMAND: sidecarCommand('STUDENTLLM_DOCUMENT_READY_FILE'),
    STUDENTLLM_ASR_READY_FILE: asrReadyFile,
    STUDENTLLM_DOCUMENT_READY_FILE: documentsReadyFile,
    STUDENTLLM_SMOKE_EXIT_AFTER_MS: '5000',
  };

  try {
    const runtime = runSmoke(environment, { durationMs: smokeDurationMs, allowEarlyExit: true });
    const asrPid = await waitForSidecarPid(asrReadyFile);
    const documentsPid = await waitForSidecarPid(documentsReadyFile);
    await runtime;
    await Promise.all([waitForProcessExit(asrPid), waitForProcessExit(documentsPid)]);
    console.log(`Packaged runtime autostarted two configured sidecars (pids ${asrPid}, ${documentsPid}) and stopped both after a clean exit.`);
  } finally {
    await rm(dataRoot, { recursive: true, force: true });
  }
}

async function runFrontendIpcSmoke() {
  const dataRoot = await mkdtemp(join(tmpdir(), 'studentllm-desktop-ipc-'));
  const markerFile = join(dataRoot, 'frontend-ipc-smoke.ok');
  const environment = {
    ...createRuntimeEnvironment(dataRoot),
    STUDENTLLM_FRONTEND_IPC_SMOKE_MARKER: markerFile,
    STUDENTLLM_SMOKE_EXIT_AFTER_MS: '5000',
  };

  try {
    const runtime = runSmoke(environment, { durationMs: smokeDurationMs, allowEarlyExit: true });
    try {
      await Promise.race([
        waitForSmokeMarker(markerFile),
        runtime.then(() => {
          throw new Error('Packaged frontend exited before completing the IPC smoke call.');
        }),
      ]);
      await runtime;
      console.log('Packaged frontend invoked the native smoke command and received the expected response.');
    } finally {
      await runtime.catch(() => undefined);
    }
  } finally {
    await rm(dataRoot, { recursive: true, force: true });
  }
}

async function runCrashRecovery() {
  const dataRoot = await mkdtemp(join(tmpdir(), 'studentllm-desktop-recovery-'));
  const environment = createRuntimeEnvironment(dataRoot);

  try {
    const firstRun = await runSmoke(environment, { forceKill: true, durationMs: 30_000 });
    const runs = [firstRun];
    const databasesAfterCrash = await findWorkspaceDatabases(dataRoot);
    if (databasesAfterCrash.length !== 1) {
      throw new Error(`Expected one workspace database after the forced stop, found ${databasesAfterCrash.length}.`);
    }

    for (let cycle = 0; cycle < recoveryCycles; cycle += 1) {
      runs.push(await runSmoke(environment));
      const databasesAfterRelaunch = await findWorkspaceDatabases(dataRoot);
      if (databasesAfterRelaunch.length !== 1 || databasesAfterRelaunch[0] !== databasesAfterCrash[0]) {
        throw new Error(`Workspace database was not preserved across recovery cycle ${cycle + 1}.`);
      }

      try {
        await checkWorkspaceDatabase(databasesAfterRelaunch[0]);
      } catch (error) {
        const outputs = runs
          .flatMap(({ stdout, stderr }, index) => [
            `Runtime ${index + 1} stdout:\n${stdout.trim()}`,
            `Runtime ${index + 1} stderr:\n${stderr.trim()}`,
          ])
          .filter((output) => !output.endsWith(':'))
          .join('\n');
        throw new Error(`${error instanceof Error ? error.message : error}\n${outputs}`);
      }
    }
    console.log(`Desktop runtime recovered after SIGKILL and ${recoveryCycles} relaunch cycle${recoveryCycles === 1 ? '' : 's'} with a frontend-persisted workspace snapshot and SQLite integrity_check returning ok.`);
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
  if (recoveryRequested) await runCrashRecovery();
  if (sidecarSupervisionRequested) await runSidecarSupervision();
  if (frontendIpcRequested) await runFrontendIpcSmoke();
  if (!recoveryRequested && !sidecarSupervisionRequested && !frontendIpcRequested) {
    await runSmoke(environment);
    console.log(`Desktop runtime stayed alive for ${smokeDurationMs / 1000}s and was stopped.`);
  }
} catch (error) {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
}
