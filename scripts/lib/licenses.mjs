// Shared licence helpers for scripts/check-licenses.mjs and scripts/generate-third-party-notices.mjs.
// Everything here is offline and deterministic: it classifies declared licence metadata, it does not read licence texts.

/** Risk ranks. Lower is safer for a product that is distributed commercially under MIT. */
export const RANK = { permissive: 0, 'weak-copyleft': 1, unknown: 2, 'strong-copyleft': 3, restricted: 3 };

const PERMISSIVE = new Set([
  '0BSD', 'AFL-2.1', 'Apache-1.1', 'Apache-2.0', 'Artistic-2.0', 'BlueOak-1.0.0', 'BSD-1-Clause', 'BSD-2-Clause',
  'BSD-3-Clause', 'BSL-1.0', 'CC-BY-3.0', 'CC-BY-4.0', 'CC0-1.0', 'CDLA-Permissive-1.0', 'CDLA-Permissive-2.0',
  'CNRI-Python', 'HPND', 'ISC', 'MIT', 'MIT-0', 'MIT-CMU', 'NCSA', 'OFL-1.1', 'PSF-2.0', 'Python-2.0', 'Unicode-3.0',
  'Unicode-DFS-2016', 'Unlicense', 'WTFPL', 'Zlib', 'X11', 'FTL', 'IJG', 'libpng-2.0', 'Public-Domain',
]);

// Exceptions that make an otherwise copyleft licence usable from proprietary code.
const LINKING_EXCEPTIONS = /^(GCC-exception|Classpath-exception|LLVM-exception|Linux-syscall-note|Font-exception|OpenSSL-exception)/i;

const NORMALIZED = [
  [/^(the )?mit( license)?( \(mit\))?$|^mit license$|^mit licen[cs]e$/i, 'MIT'],
  [/^mit-0$/i, 'MIT-0'],
  [/^(apache[- ]?(software )?licen[cs]e,? )?(apache[- ]?)?(2(\.0)?|version 2\.0)$|^apache[- ]?2(\.0)?( license)?$|^apache license,? version 2\.0$|^apache software license$|^apache2\.0$|^apache 2\.0 license$/i, 'Apache-2.0'],
  [/^bsd[- ]?3[- ]?clause( license)?$|^3-clause bsd licen[cs]e$|^bsd 3-clause( license)?$/i, 'BSD-3-Clause'],
  [/^bsd[- ]?2[- ]?clause( license)?$|^2-clause bsd licen[cs]e$/i, 'BSD-2-Clause'],
  [/^bsd( license)?$/i, 'BSD-3-Clause'],
  [/^isc( license( \(iscl\))?)?$/i, 'ISC'],
  [/^(the )?unlicense( \(unlicense\))?$/i, 'Unlicense'],
  [/^public domain$/i, 'Public-Domain'],
  [/^mozilla public license 2\.0( \(mpl 2\.0\))?$|^mpl-2\.0$/i, 'MPL-2.0'],
  [/^gnu lesser general public license v2 or later \(lgplv2\+\)$/i, 'LGPL-2.1-or-later'],
  [/^python software foundation license$|^psfl$|^psf-2\.0$/i, 'PSF-2.0'],
  [/^zlib( license)?$/i, 'Zlib'],
  [/^cc0( 1\.0)?$/i, 'CC0-1.0'],
];

/** Map a free-text licence label from package metadata to an SPDX-style expression when it is a well-known label. */
export function normalizeLicense(value) {
  if (!value) return '';
  const text = String(value).trim();
  if (!text) return '';
  // A full licence text pasted into the field.
  if (/permission is hereby granted, free of charge/i.test(text)) return 'MIT';
  if (/apache license\s+version 2\.0/i.test(text)) return 'Apache-2.0';
  if (/redistribution and use in source and binary forms/i.test(text)) return /neither the name|3\. /i.test(text) ? 'BSD-3-Clause' : 'BSD-2-Clause';
  if (text.length > 120 || text.includes('\n')) return ''; // some other pasted text: not machine-readable
  // "BSD 3-Clause OR Apache-2.0": normalise each side of a free-text expression.
  const parts = text.split(/\s+(OR|AND)\s+/i);
  if (parts.length > 1) return parts.map((part, index) => (index % 2 ? part.toUpperCase() : normalizeLicense(part))).join(' ');
  for (const [pattern, spdx] of NORMALIZED) if (pattern.test(text)) return spdx;
  return text;
}

/** Map PyPI "License :: OSI Approved :: X" classifier tails to SPDX-style identifiers. */
export function classifierToSpdx(tail) {
  const t = tail.trim();
  if (/^MIT License$/i.test(t)) return 'MIT';
  if (/^Apache Software License$/i.test(t)) return 'Apache-2.0';
  if (/^BSD License$/i.test(t)) return 'BSD-3-Clause';
  if (/^ISC License/i.test(t)) return 'ISC';
  if (/^The Unlicense/i.test(t)) return 'Unlicense';
  if (/^Mozilla Public License 2\.0/i.test(t)) return 'MPL-2.0';
  if (/^Python Software Foundation License$/i.test(t)) return 'PSF-2.0';
  if (/^Public Domain$/i.test(t)) return 'Public-Domain';
  if (/^GNU Lesser General Public License v2 or later/i.test(t)) return 'LGPL-2.1-or-later';
  if (/^GNU Lesser General Public License/i.test(t)) return 'LGPL-3.0-or-later';
  if (/^GNU Affero General Public License/i.test(t)) return 'AGPL-3.0-or-later';
  if (/^GNU General Public License/i.test(t)) return 'GPL-3.0-or-later';
  return `LicenseClassifier(${t})`;
}

/** Class of a single SPDX identifier. */
export function classifyId(id) {
  const name = id.replace(/\+$/, '');
  if (PERMISSIVE.has(name)) return 'permissive';
  if (/(^|-)NC(-|$)|NonCommercial|^BUSL|^SSPL|Elastic|PolyForm-Noncommercial|Commons-Clause|^CC-BY-ND/i.test(name)) return 'restricted';
  if (/^(A?GPL|EUPL|OSL|CPAL|RPL|CC-BY-SA)/i.test(name)) return 'strong-copyleft';
  if (/^(LGPL|MPL|EPL|CDDL|CPL|MS-RL|Ms-RL|APSL)/i.test(name)) return 'weak-copyleft';
  return 'unknown';
}

/**
 * Parse and evaluate an SPDX licence expression.
 * `OR` lets the recipient choose, so the least risky branch wins; `AND` needs all, so the riskiest wins.
 * Returns { class, choice } where `choice` is the branch that was selected.
 */
export function classifyExpression(expression) {
  const source = String(expression ?? '').trim();
  if (!source) return { class: 'unknown', choice: '' };
  // Legacy Cargo/npm metadata writes "MIT/Apache-2.0", "Apache-2.0 / MIT" or "Unlicense/MIT" for a dual licence.
  const tokens = source.replace(/\s*\/\s*/g, ' OR ').replace(/\(/g, ' ( ').replace(/\)/g, ' ) ').split(/\s+/).filter(Boolean);
  let position = 0;

  const peek = () => tokens[position];
  const take = () => tokens[position++];

  function parseOr() {
    let left = parseAnd();
    while (peek() && peek().toUpperCase() === 'OR') {
      take();
      const right = parseAnd();
      left = RANK[right.class] < RANK[left.class] ? right : left;
    }
    return left;
  }
  function parseAnd() {
    let left = parseAtom();
    while (peek() && peek().toUpperCase() === 'AND') {
      take();
      const right = parseAtom();
      left = { class: RANK[right.class] > RANK[left.class] ? right.class : left.class, choice: `${left.choice} AND ${right.choice}` };
    }
    return left;
  }
  function parseAtom() {
    const token = take();
    if (token === undefined) return { class: 'unknown', choice: '' };
    if (token === '(') {
      const inner = parseOr();
      if (peek() === ')') take();
      return inner;
    }
    let id = token;
    let kind = classifyId(id);
    if (peek() && peek().toUpperCase() === 'WITH') {
      take();
      const exception = take() ?? '';
      id = `${id} WITH ${exception}`;
      // GPL with the GCC runtime exception (libgfortran, libgcc) can be linked from proprietary code.
      if (LINKING_EXCEPTIONS.test(exception) && kind === 'strong-copyleft') kind = 'weak-copyleft';
    }
    return { class: kind, choice: id };
  }

  const result = parseOr();
  if (position < tokens.length) return { class: 'unknown', choice: source }; // trailing garbage: be conservative
  return result;
}

/** The licence identifiers of a selected branch such as "MPL-2.0 AND MIT" or "GPL-3.0-or-later WITH GCC-exception-3.1". */
function branchIds(choice) {
  return String(choice ?? '').split(/\s+AND\s+/i).map((part) => part.trim()).filter(Boolean);
}

/** True when every weak-copyleft part of the chosen branch is one the policy allows without an exception. */
function weakCopyleftAllowed(policy, choice) {
  const allowed = new Set((policy.allowedWeakCopyleft ?? []).map((id) => id.toLowerCase()));
  return branchIds(choice).every((part) => {
    const id = part.split(/\s+WITH\s+/i)[0];
    const kind = classifyExpression(part).class;
    return kind !== 'weak-copyleft' || allowed.has(id.toLowerCase());
  });
}

/** Find the policy exception for a package, if any. `scope` narrows by lockfile or requirements file. */
export function findException(policy, ecosystem, name, scope) {
  return (policy.exceptions ?? []).find((entry) => {
    if (entry.ecosystem !== ecosystem) return false;
    const matchesName = entry.namePattern
      ? new RegExp(`^(?:${entry.namePattern})$`, 'i').test(name)
      : entry.name?.toLowerCase() === name.toLowerCase();
    if (!matchesName) return false;
    return !entry.scope || !scope || entry.scope.includes(scope);
  });
}

/** Corrected metadata. An override with a `version` applies to that exact version only, so a new release is re-checked. */
export function findOverride(policy, ecosystem, name, version) {
  return (policy.overrides ?? []).find((entry) => (
    entry.ecosystem === ecosystem && entry.name.toLowerCase() === name.toLowerCase()
    && (!entry.version || entry.version === version)
  ));
}

/**
 * Evaluate one package. `declared` is the licence expression read from the ecosystem's metadata.
 * Returns the row with status "ok", "excepted" or "violation".
 */
export function evaluatePackage(policy, { ecosystem, name, version, declared, scope }) {
  const override = findOverride(policy, ecosystem, name, version);
  const expression = override ? override.license : declared;
  const { class: kind, choice } = classifyExpression(expression);
  const row = { ecosystem, name, version, declared: declared || '(none)', license: expression || '(none)', class: kind, choice, scope, override: Boolean(override) };
  if (kind === 'permissive') return { ...row, status: 'ok' };
  // Only the weak-copyleft licences listed in `allowedWeakCopyleft` (MPL-2.0) pass without an exception; LGPL needs one.
  if (kind === 'weak-copyleft' && weakCopyleftAllowed(policy, choice)) return { ...row, status: 'ok' };
  const exception = findException(policy, ecosystem, name, scope);
  if (exception) return { ...row, status: 'excepted', reason: exception.reason };
  return { ...row, status: 'violation' };
}

/** Packages that ship in the npm production tree: everything the lockfile does not mark as dev. */
export function npmProductionPackages(lockfile) {
  const rows = [];
  for (const [path, entry] of Object.entries(lockfile.packages ?? {})) {
    if (!path || entry.dev || entry.devOptional) continue;
    const name = entry.name ?? path.slice(path.lastIndexOf('node_modules/') + 'node_modules/'.length);
    rows.push({ name, version: entry.version, declared: typeof entry.license === 'string' ? entry.license : '', path });
  }
  return rows.sort((a, b) => a.name.localeCompare(b.name) || a.version.localeCompare(b.version));
}

/** Read the licence out of a `pip install --report` JSON document. */
export function pythonPackagesFromReport(report) {
  const rows = [];
  for (const item of report.install ?? []) {
    const metadata = item.metadata ?? {};
    let declared = metadata.license_expression || '';
    if (!declared) {
      const fromClassifiers = (metadata.classifier ?? [])
        .filter((value) => value.startsWith('License ::') && !/OSI Approved$/.test(value))
        .map((value) => classifierToSpdx(value.split('::').slice(-1)[0]));
      declared = fromClassifiers.length ? [...new Set(fromClassifiers)].join(' OR ') : '';
      if (!declared) declared = normalizeLicense(metadata.license);
      else if (fromClassifiers.length > 1 && /Dual|OR/i.test(metadata.license ?? '')) declared = [...new Set(fromClassifiers)].join(' OR ');
      else if (fromClassifiers.length > 1) declared = [...new Set(fromClassifiers)].join(' AND ');
    }
    rows.push({ name: metadata.name, version: metadata.version, declared });
  }
  return rows.sort((a, b) => a.name.localeCompare(b.name) || a.version.localeCompare(b.version));
}

/** Production crates from `cargo metadata`: the normal and build dependency closure of the root package. */
export function cargoPackagesFromMetadata(metadata) {
  const byId = new Map(metadata.packages.map((pkg) => [pkg.id, pkg]));
  const nodes = new Map(metadata.resolve.nodes.map((node) => [node.id, node]));
  const root = metadata.resolve.root ?? metadata.workspace_members[0];
  const seen = new Set();
  const stack = [root];
  while (stack.length) {
    const id = stack.pop();
    if (seen.has(id)) continue;
    seen.add(id);
    for (const dep of nodes.get(id)?.deps ?? []) {
      if ((dep.dep_kinds ?? []).some((kind) => kind.kind === null || kind.kind === 'build')) stack.push(dep.pkg);
    }
  }
  return [...seen]
    .filter((id) => id !== root)
    .map((id) => byId.get(id))
    .map((pkg) => ({ name: pkg.name, version: pkg.version, declared: pkg.license ?? '', repository: pkg.repository ?? '', manifestPath: pkg.manifest_path }))
    .sort((a, b) => a.name.localeCompare(b.name) || a.version.localeCompare(b.version));
}
