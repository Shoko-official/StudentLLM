#!/usr/bin/env node
// Prove that the built desktop bundle really carries the licence notices (bundle.resources in tauri.conf.json).
//
//   node scripts/check-bundle-licenses.mjs [bundle-directory]
//
// Linux: lists the .deb with `dpkg -c`. macOS: looks inside the .app that the dmg is made from. Windows: reads the
// NSIS script that Tauri generates for the installer (next to the bundle directory), which names every file the
// installer unpacks.

import { execFileSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';

const bundle = resolve(process.argv[2] ?? 'src-tauri/target/debug/bundle');
const expected = ['LICENSE.txt', 'NOTICE.md', 'THIRD_PARTY_LICENSES.md'];

function walk(directory) {
  const found = [];
  for (const name of readdirSync(directory)) {
    const path = join(directory, name);
    if (statSync(path).isDirectory()) found.push(...walk(path));
    else found.push(path);
  }
  return found;
}

function listing() {
  if (!existsSync(bundle)) throw new Error(`No bundle directory at ${bundle}`);
  if (process.platform === 'linux') {
    const deb = walk(bundle).find((path) => path.endsWith('.deb'));
    if (!deb) throw new Error(`No .deb found under ${bundle}`);
    return { source: `dpkg -c ${deb}`, text: execFileSync('dpkg', ['-c', deb], { encoding: 'utf8' }) };
  }
  if (process.platform === 'darwin') {
    const files = walk(bundle).filter((path) => /\.app[\\/]/.test(path));
    if (!files.length) throw new Error(`No .app contents found under ${bundle}`);
    return { source: 'the .app bundle', text: files.join('\n') };
  }
  // Tauri writes the NSIS script next to the bundle directory (target/<profile>/nsis/<arch>/installer.nsi), not inside it.
  const profile = resolve(bundle, '..');
  const skip = new Set(['deps', 'build', 'incremental', '.fingerprint', 'examples']);
  const scripts = [];
  const search = (directory) => {
    for (const name of readdirSync(directory)) {
      const path = join(directory, name);
      if (statSync(path).isDirectory()) {
        if (!skip.has(name)) search(path);
      } else if (path.endsWith('.nsi')) scripts.push(path);
    }
  };
  search(profile);
  if (!scripts.length) throw new Error(`No NSIS script found under ${profile}; it holds ${readdirSync(profile).join(', ')}`);
  return { source: `the NSIS script ${scripts[0]}`, text: scripts.map((path) => readFileSync(path, 'utf8')).join('\n') };
}

const { source, text } = listing();
const missing = expected.filter((name) => !new RegExp(`licenses[\\\\/]+${name.replace('.', '\\.')}`, 'i').test(text));
if (missing.length) {
  console.error(`The bundle does not carry licenses/${missing.join(', licenses/')} according to ${source}.`);
  console.error(text.split('\n').filter((line) => /licen[sc]e|notice/i.test(line)).slice(0, 40).join('\n'));
  process.exit(1);
}
console.log(`The bundle carries ${expected.map((name) => `licenses/${name}`).join(', ')} (checked in ${source}).`);
