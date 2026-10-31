#!/usr/bin/env node
// Fail when a production dependency carries a strong-copyleft, non-commercial or unknown licence that
// scripts/license-policy.json does not except. Covers npm (root and cloud/ lockfiles), Cargo and the
// Python requirements files. See docs/licensing.md.
//
//   node scripts/check-licenses.mjs                 npm + Cargo (Cargo skipped when cargo is missing)
//   node scripts/check-licenses.mjs --python        also resolve every requirements-*.txt with pip
//   node scripts/check-licenses.mjs --python --python-file requirements-x.txt   limit the Python check to one file
//   node scripts/check-licenses.mjs --require-cargo fail instead of skipping when cargo is missing
//   node scripts/check-licenses.mjs --json          machine-readable result

import { execFile, spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  cargoPackagesFromMetadata, evaluatePackage, npmProductionPackages, pythonPackagesFromReport,
} from './lib/licenses.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const args = new Set(process.argv.slice(2));
const policy = JSON.parse(readFileSync(join(root, 'scripts', 'license-policy.json'), 'utf8'));

const results = [];
const notes = [];

function record(rows, ecosystem, scope) {
  for (const row of rows) results.push(evaluatePackage(policy, { ecosystem, scope, ...row }));
}

function checkNpm() {
  for (const lockPath of ['package-lock.json', 'cloud/package-lock.json']) {
    const file = join(root, lockPath);
    if (!existsSync(file)) continue;
    const rows = npmProductionPackages(JSON.parse(readFileSync(file, 'utf8')));
    record(rows, 'npm', lockPath);
    notes.push(`${lockPath}: ${rows.length} production packages`);
  }
}

function checkCargo() {
  const manifest = join(root, 'src-tauri', 'Cargo.toml');
  const run = spawnSync('cargo', ['metadata', '--locked', '--format-version', '1', '--manifest-path', manifest], {
    encoding: 'utf8', maxBuffer: 256 * 1024 * 1024, cwd: root,
  });
  if (run.error || run.status !== 0) {
    const message = run.error ? `cargo is not available (${run.error.code})` : `cargo metadata failed: ${run.stderr.trim().split('\n').pop()}`;
    if (args.has('--require-cargo')) {
      results.push({ ecosystem: 'cargo', name: '(cargo metadata)', version: '', status: 'violation', class: 'unknown', license: message, scope: 'src-tauri/Cargo.lock' });
    } else {
      notes.push(`Cargo skipped: ${message}. CI runs it with --require-cargo.`);
    }
    return;
  }
  const rows = cargoPackagesFromMetadata(JSON.parse(run.stdout));
  record(rows, 'cargo', 'src-tauri/Cargo.lock');
  notes.push(`src-tauri/Cargo.lock: ${rows.length} crates (normal and build dependencies)`);
}

async function checkPython() {
  const python = process.env.PYTHON || (process.platform === 'win32' ? 'python' : 'python3');
  const only = process.argv.flatMap((value, index, all) => (value === '--python-file' ? [all[index + 1]] : []));
  const files = readdirSync(root).filter((name) => /^requirements-.*\.txt$/.test(name) && (!only.length || only.includes(name))).sort();
  const work = mkdtempSync(join(tmpdir(), 'licenses-'));
  try {
    // Resolving torch-sized trees is slow, so the files are resolved concurrently.
    const outcomes = await Promise.all(files.map((file) => new Promise((done) => {
      const reportPath = join(work, `${file}.json`);
      const started = Date.now();
      execFile(python, [
        '-m', 'pip', 'install', '--dry-run', '--ignore-installed', '--disable-pip-version-check', '--quiet',
        '--report', reportPath, '-r', join(root, file),
      ], { cwd: root, timeout: 30 * 60 * 1000, maxBuffer: 64 * 1024 * 1024 }, (error, _stdout, stderr) => {
        done({ file, reportPath, error, stderr, seconds: Math.round((Date.now() - started) / 1000) });
      });
    })));
    for (const { file, reportPath, error, stderr, seconds } of outcomes) {
      if (error || !existsSync(reportPath)) {
        results.push({ ecosystem: 'python', name: `(resolve ${file})`, version: '', status: 'violation', class: 'unknown', license: (stderr || error?.message || 'pip failed').trim().split('\n').pop(), scope: file });
        continue;
      }
      const rows = pythonPackagesFromReport(JSON.parse(readFileSync(reportPath, 'utf8')));
      record(rows, 'python', file);
      notes.push(`${file}: ${rows.length} resolved packages in ${seconds} s`);
    }
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}

checkNpm();
checkCargo();
if (args.has('--python')) await checkPython();
else notes.push('Python skipped: pass --python to resolve the requirements files with pip (CI does).');

const violations = results.filter((row) => row.status === 'violation');
const excepted = results.filter((row) => row.status === 'excepted');
const weak = results.filter((row) => row.status === 'ok' && row.class === 'weak-copyleft');

if (args.has('--json')) {
  console.log(JSON.stringify({ violations, excepted, weakCopyleft: weak, notes }, null, 2));
} else {
  for (const note of notes) console.log(note);
  console.log(`\nChecked ${results.length} entries: ${violations.length} violation(s), ${excepted.length} excepted, ${weak.length} weak-copyleft allowed.`);
  for (const row of excepted) console.log(`  excepted  ${row.ecosystem}:${row.name}@${row.version} [${row.license}] (${row.scope}) - ${row.reason}`);
  const weakNames = [...new Set(weak.map((row) => `${row.ecosystem}:${row.name} [${row.license}]`))];
  if (weakNames.length) console.log(`  weak copyleft (allowed, keep notices): ${weakNames.join(', ')}`);
  for (const row of violations) {
    console.error(`  VIOLATION ${row.ecosystem}:${row.name}@${row.version} declares "${row.declared ?? row.license}" -> ${row.class} (${row.scope}). Replace it, add a verified override, or add a justified exception to scripts/license-policy.json.`);
  }
}
if (violations.length) process.exit(1);
