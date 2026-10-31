#!/usr/bin/env node
// Generate THIRD_PARTY_LICENSES.md from the lockfiles.
//
//   node scripts/generate-third-party-notices.mjs                 write the committed summary table
//   node scripts/generate-third-party-notices.mjs --check         fail when a lockfile changed since the summary was written
//   node scripts/generate-third-party-notices.mjs --full --out F  write every licence text (needs `npm ci`; Rust texts need cargo + fetched crates)
//
// The package set is deterministic: npm packages the lockfile does not mark as dev, and every crate reachable from the
// app crate in Cargo.lock. Rust licence strings come from `cargo metadata` when cargo is installed, otherwise from the
// deps.dev API; the summary header says which. The release workflow generates the full-text file with cargo.

import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { npmProductionPackages } from './lib/licenses.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const argv = process.argv.slice(2);
const flag = (name) => argv.includes(name);
const option = (name) => (argv.includes(name) ? argv[argv.indexOf(name) + 1] : undefined);
const SUMMARY_FILE = join(root, 'THIRD_PARTY_LICENSES.md');
const LOCKFILES = ['package-lock.json', 'cloud/package-lock.json', 'src-tauri/Cargo.lock'];

function digest(path) {
  // Normalise line endings so a Windows checkout with autocrlf hashes like the repository.
  const text = readFileSync(join(root, path), 'utf8').replace(/\r\n/g, '\n');
  return createHash('sha256').update(text).digest('hex');
}

function lockfileLines() {
  return LOCKFILES.filter((path) => existsSync(join(root, path))).map((path) => `- \`${path}\`: sha256 \`${digest(path)}\``);
}

// ---------------------------------------------------------------------------------------------------------------- Cargo

function parseCargoLock(text) {
  const packages = text.split('[[package]]').slice(1).map((block) => ({
    name: /name = "([^"]+)"/.exec(block)[1],
    version: /version = "([^"]+)"/.exec(block)[1],
    source: /source = "([^"]+)"/.exec(block)?.[1] ?? '',
    dependencies: [...(/dependencies = \[([\s\S]*?)\]/.exec(block)?.[1] ?? '').matchAll(/"([^"]+)"/g)].map((match) => match[1]),
  }));
  return packages;
}

function cargoClosure() {
  const lockPath = join(root, 'src-tauri', 'Cargo.lock');
  if (!existsSync(lockPath)) return [];
  const packages = parseCargoLock(readFileSync(lockPath, 'utf8').replace(/\r\n/g, '\n'));
  const rootCrate = packages.find((pkg) => !pkg.source);
  const byName = new Map();
  for (const pkg of packages) byName.set(pkg.name, [...(byName.get(pkg.name) ?? []), pkg]);
  const resolveDependency = (entry) => {
    const [name, version] = entry.split(' ');
    const candidates = byName.get(name) ?? [];
    return version ? candidates.find((pkg) => pkg.version === version) : candidates[0];
  };
  const seen = new Set();
  const stack = [rootCrate];
  while (stack.length) {
    const pkg = stack.pop();
    if (!pkg || seen.has(pkg)) continue;
    seen.add(pkg);
    for (const dependency of pkg.dependencies) stack.push(resolveDependency(dependency));
  }
  return [...seen].filter((pkg) => pkg.source).sort((a, b) => a.name.localeCompare(b.name) || a.version.localeCompare(b.version));
}

function cargoMetadataLicenses() {
  const run = spawnSync('cargo', ['metadata', '--locked', '--format-version', '1', '--manifest-path', join(root, 'src-tauri', 'Cargo.toml')], {
    encoding: 'utf8', maxBuffer: 256 * 1024 * 1024, cwd: root,
  });
  if (run.error || run.status !== 0) return undefined;
  const map = new Map();
  for (const pkg of JSON.parse(run.stdout).packages) map.set(`${pkg.name}@${pkg.version}`, { license: pkg.license ?? '', directory: dirname(pkg.manifest_path) });
  return map;
}

async function depsDevLicense(name, version) {
  const url = `https://api.deps.dev/v3/systems/cargo/packages/${encodeURIComponent(name)}/versions/${encodeURIComponent(version)}`;
  for (let attempt = 0; attempt < 4; attempt++) {
    try {
      const response = await fetch(url);
      if (response.ok) return ((await response.json()).licenses ?? []).join(' AND ') || 'NONE';
      if (response.status === 404) return 'NONE';
    } catch { /* retry */ }
    await new Promise((done) => setTimeout(done, 400 * (attempt + 1)));
  }
  throw new Error(`Could not read the licence of ${name}@${version} from deps.dev`);
}

async function rustRows() {
  const closure = cargoClosure();
  const metadata = cargoMetadataLicenses();
  const rows = [];
  let cursor = 0;
  async function worker() {
    while (cursor < closure.length) {
      const pkg = closure[cursor++];
      const key = `${pkg.name}@${pkg.version}`;
      const known = metadata?.get(key);
      const license = known ? known.license || 'NONE' : await depsDevLicense(pkg.name, pkg.version);
      rows.push({ name: pkg.name, version: pkg.version, license, directory: known?.directory, url: `https://crates.io/crates/${pkg.name}/${pkg.version}` });
    }
  }
  await Promise.all(Array.from({ length: 8 }, worker));
  rows.sort((a, b) => a.name.localeCompare(b.name) || a.version.localeCompare(b.version));
  return { rows, source: metadata ? '`cargo metadata`' : 'the deps.dev API (cargo is not installed here)' };
}

// ------------------------------------------------------------------------------------------------------------------ npm

function npmRows() {
  const rows = [];
  for (const lockPath of ['package-lock.json', 'cloud/package-lock.json']) {
    const file = join(root, lockPath);
    if (!existsSync(file)) continue;
    const base = dirname(file);
    for (const pkg of npmProductionPackages(JSON.parse(readFileSync(file, 'utf8')))) {
      rows.push({
        name: pkg.name, version: pkg.version, license: pkg.declared || 'NONE',
        directory: join(base, pkg.path), lockfile: lockPath, url: `https://www.npmjs.com/package/${pkg.name}/v/${pkg.version}`,
      });
    }
  }
  const seen = new Set();
  return rows.filter((row) => (seen.has(`${row.name}@${row.version}`) ? false : seen.add(`${row.name}@${row.version}`)))
    .sort((a, b) => a.name.localeCompare(b.name) || a.version.localeCompare(b.version));
}

// -------------------------------------------------------------------------------------------------------------- output

const escapeCell = (value) => String(value).replace(/\|/g, '\\|');

function table(rows) {
  return [
    '| Package | Version | Licence | Source |', '| --- | --- | --- | --- |',
    ...rows.map((row) => `| ${escapeCell(row.name)} | ${row.version} | ${escapeCell(row.license)} | <${row.url}> |`),
  ].join('\n');
}

function licenseText(directory) {
  if (!directory || !existsSync(directory)) return undefined;
  const files = readdirSync(directory).filter((name) => /^(licen[sc]e|copying|notice|unlicense)([-._].*)?$/i.test(name)).sort();
  const parts = files.map((name) => readFileSync(join(directory, name), 'utf8').replace(/\r\n/g, '\n').trim()).filter(Boolean);
  return parts.length ? parts.join('\n\n---\n\n') : undefined;
}

function fullText(sections) {
  const groups = new Map();
  const missing = [];
  for (const { heading, rows } of sections) {
    for (const row of rows) {
      const text = licenseText(row.directory);
      if (!text) { missing.push(`${row.name}@${row.version} (${row.license})`); continue; }
      const key = createHash('sha256').update(text).digest('hex');
      const entry = groups.get(key) ?? { text, packages: [] };
      entry.packages.push(`${row.name}@${row.version}`);
      groups.set(key, entry);
      void heading;
    }
  }
  const body = [...groups.values()]
    .sort((a, b) => a.packages[0].localeCompare(b.packages[0]))
    .map((group) => `### ${group.packages.join(', ')}\n\n\`\`\`text\n${group.text}\n\`\`\``)
    .join('\n\n');
  const gaps = missing.length
    ? `\n\n## Packages without a licence file in their distribution\n\nThese declare the licence shown; refer to the project page for the text.\n\n${missing.map((entry) => `- ${entry}`).join('\n')}\n`
    : '';
  return `\n## Licence texts\n\nIdentical texts are grouped.\n\n${body}${gaps}`;
}

const STATIC_NOTES = `## Bundled fonts and icons

- **Fraunces** (variable font, \`@fontsource-variable/fraunces\`): SIL Open Font License 1.1, Copyright 2020 The Fraunces Project Authors (<https://github.com/undercasetype/Fraunces>). The licence file ships in the npm package and is included in the full-text file.
- **KaTeX fonts** (\`katex\`, \`KaTeX_*.woff2\`): the KaTeX code is MIT. The font files embed their own licence in the name table (IDs 13 and 14): SIL Open Font License 1.1, Copyright (c) 2009-2010 Design Science, Inc. and (c) 2014-2018 Khan Academy, Reserved Font Name \`KaTeX_Main\` (checked on \`KaTeX_Main-Regular.ttf\` from \`katex@0.18.9\`). The OFL text is reproduced with the Fraunces licence in the full-text file. The fonts must not be sold on their own or renamed in modified form.
- **Lucide icons** (\`lucide-react\`): ISC, with MIT-licensed icons derived from Feather (Copyright (c) 2013-present Cole Bemis). Both notices are in the package's \`LICENSE\` (<https://github.com/lucide-icons/lucide/blob/main/LICENSE>).
- The StudentLLM favicon and desktop icons are the project's own artwork under the MIT licence.

## Not listed here

Development and test tooling is not distributed. The Python sidecars and benchmark tooling are installed by the user from the requirements files and are not part of the desktop bundle; they are audited in [docs/licensing.md](docs/licensing.md).
`;

async function build({ full }) {
  const npm = npmRows();
  const rust = await rustRows();
  const header = [
    '# Third-party licences',
    '',
    full
      ? 'Complete third-party licence texts for the StudentLLM desktop app. Generated by `scripts/generate-third-party-notices.mjs --full` in the release workflow.'
      : 'Summary of the open-source components shipped in the StudentLLM desktop app, generated by `scripts/generate-third-party-notices.mjs`. Do not edit by hand: run `npm run licenses:notices`. The release workflow also attaches a full-text version.',
    '',
    'StudentLLM itself is released under the MIT licence (see `LICENSE`). Components below keep their own licences.',
    '',
    'Generated from these lockfiles (line endings normalised):',
    '',
    ...lockfileLines(),
    '',
    `Rust licence strings were read from ${rust.source}.`,
    '',
    `## npm production dependencies (${npm.length})`,
    '',
    'Every package the lockfile does not mark as development-only. This is a superset of what the Vite bundle contains: it also lists optional platform binaries such as `@napi-rs/canvas-*`, which `pdfjs-dist` only uses under Node.',
    '',
    table(npm),
    '',
    `## Rust crates reachable from the desktop app (${rust.rows.length})`,
    '',
    'Every crate reachable from the app crate in \`Cargo.lock\`, including platform-specific and build-time crates, so the list is a superset of what one platform links. Crates under MPL-2.0 (\`cssparser\`, \`cssparser-macros\`, \`dtoa-short\`, \`option-ext\`, \`selectors\`) are used unmodified; their source is available from the crates.io pages below. SQLite is compiled into the app through \`rusqlite\` with the \`bundled\` feature (SQLite is in the public domain).',
    '',
    table(rust.rows),
    '',
    STATIC_NOTES,
  ].join('\n');
  return full ? header + fullText([{ heading: 'npm', rows: npm }, { heading: 'rust', rows: rust.rows }]) : header;
}

if (flag('--check')) {
  if (!existsSync(SUMMARY_FILE)) {
    console.error('THIRD_PARTY_LICENSES.md is missing. Run `npm run licenses:notices`.');
    process.exit(1);
  }
  const recorded = readFileSync(SUMMARY_FILE, 'utf8').replace(/\r\n/g, '\n');
  const stale = LOCKFILES.filter((path) => existsSync(join(root, path)) && !recorded.includes(`\`${path}\`: sha256 \`${digest(path)}\``));
  if (stale.length) {
    console.error(`THIRD_PARTY_LICENSES.md is out of date: ${stale.join(', ')} changed. Run \`npm run licenses:notices\` and commit the result.`);
    process.exit(1);
  }
  console.log('THIRD_PARTY_LICENSES.md matches the lockfiles.');
} else {
  const full = flag('--full');
  const text = (await build({ full })).replace(/\r\n/g, '\n').replace(/\n*$/, '\n');
  const out = full ? resolve(option('--out') ?? 'THIRD_PARTY_LICENSES.full.md') : SUMMARY_FILE;
  writeFileSync(out, text, { encoding: 'utf8' });
  console.log(`Wrote ${out} (${(Buffer.byteLength(text) / 1024).toFixed(0)} KiB)`);
}
