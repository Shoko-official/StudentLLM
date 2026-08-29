import { spawn } from 'node:child_process';

const binaryPath = process.argv[2];
const smokeDurationMs = 15_000;
const shutdownGraceMs = 5_000;

if (!binaryPath) {
  console.error('Usage: node scripts/desktop-runtime-smoke.mjs <binary-path>');
  process.exit(2);
}

const child = spawn(binaryPath, [], {
  stdio: ['ignore', 'pipe', 'pipe'],
  env: {
    ...process.env,
    WEBKIT_DISABLE_DMABUF_RENDERER: '1',
  },
});

let stdout = '';
let stderr = '';
let timedOut = false;
child.stdout.setEncoding('utf8');
child.stderr.setEncoding('utf8');
child.stdout.on('data', (chunk) => { stdout += chunk; });
child.stderr.on('data', (chunk) => { stderr += chunk; });

const shutdownTimer = setTimeout(() => {
  timedOut = true;
  child.kill('SIGTERM');
  setTimeout(() => child.kill('SIGKILL'), shutdownGraceMs).unref();
}, smokeDurationMs);

child.once('error', (error) => {
  clearTimeout(shutdownTimer);
  console.error(`Desktop runtime failed to start: ${error.message}`);
  process.exit(1);
});

child.once('exit', (code, signal) => {
  clearTimeout(shutdownTimer);
  if (timedOut) {
    console.log(`Desktop runtime stayed alive for ${smokeDurationMs / 1000}s and was stopped.`);
    process.exit(0);
  }

  console.error(`Desktop runtime exited before the ${smokeDurationMs / 1000}s smoke window (code=${code}, signal=${signal}).`);
  if (stdout.trim()) console.error(stdout.trim());
  if (stderr.trim()) console.error(stderr.trim());
  process.exit(1);
});
