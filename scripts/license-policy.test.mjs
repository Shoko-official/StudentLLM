// Run with: node --test scripts/license-policy.test.mjs
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  cargoPackagesFromMetadata, classifyExpression, evaluatePackage, normalizeLicense, npmProductionPackages, pythonPackagesFromReport,
} from './lib/licenses.mjs';

const policy = JSON.parse(readFileSync(join(dirname(fileURLToPath(import.meta.url)), 'license-policy.json'), 'utf8'));
const evaluate = (declared, extra = {}) => evaluatePackage(policy, { ecosystem: 'npm', name: 'example', version: '1.0.0', declared, scope: 'package-lock.json', ...extra });

test('permissive licences pass', () => {
  for (const id of ['MIT', 'ISC', 'Apache-2.0', 'BSD-3-Clause', 'OFL-1.1', '(MIT OR Apache-2.0)', 'Apache-2.0 WITH LLVM-exception']) {
    assert.equal(evaluate(id).status, 'ok', id);
  }
});

test('a deliberately added GPL or AGPL dependency fails', () => {
  for (const id of ['GPL-3.0-only', 'GPL-2.0-or-later', 'AGPL-3.0-or-later', 'AGPL-3.0', 'CC-BY-SA-4.0', 'GPL-3.0-or-later AND MIT']) {
    assert.equal(evaluate(id).status, 'violation', id);
  }
});

test('non-commercial and unknown licences fail', () => {
  for (const id of ['CC-BY-NC-4.0', 'BUSL-1.1', 'SSPL-1.0', '', 'SEE LICENSE IN LICENSE.md', 'Proprietary']) {
    assert.equal(evaluate(id).status, 'violation', id || '(empty)');
  }
});

test('a dual licence passes when one option is permissive', () => {
  assert.equal(evaluate('(MIT OR GPL-3.0-or-later)').status, 'ok');
  assert.equal(evaluate('Apache-2.0 OR LGPL-2.1-or-later OR MIT').status, 'ok');
  assert.equal(classifyExpression('(MIT OR GPL-3.0-or-later)').choice, 'MIT');
  assert.equal(evaluate('GPL-3.0-or-later OR AGPL-3.0-or-later').status, 'violation');
});

test('weak copyleft is allowed but reported as such', () => {
  const row = evaluate('MPL-2.0');
  assert.equal(row.status, 'ok');
  assert.equal(row.class, 'weak-copyleft');
  assert.equal(evaluate('LGPL-2.1-or-later').class, 'weak-copyleft');
  assert.equal(evaluatePackage({ ...policy, allowWeakCopyleft: false }, { ecosystem: 'npm', name: 'x', version: '1', declared: 'MPL-2.0' }).status, 'violation');
});

test('the GCC runtime exception makes GPL usable from proprietary code', () => {
  assert.equal(classifyExpression('GPL-3.0-or-later WITH GCC-exception-3.1').class, 'weak-copyleft');
  assert.equal(classifyExpression('GPL-3.0-or-later WITH Bison-exception-2.2').class, 'strong-copyleft');
});

test('an exception needs a matching ecosystem, name and scope', () => {
  const gpl = { ecosystem: 'python', name: 'html2text', version: '1', declared: 'GPL-3.0-or-later' };
  assert.equal(evaluatePackage(policy, { ...gpl, scope: 'requirements-bfcl.txt' }).status, 'excepted');
  assert.equal(evaluatePackage(policy, { ...gpl, scope: 'requirements-local-documents.txt' }).status, 'violation');
  assert.equal(evaluatePackage(policy, { ...gpl, ecosystem: 'npm', scope: 'package-lock.json' }).status, 'violation');
});

test('an override replaces missing metadata', () => {
  assert.equal(evaluatePackage(policy, { ecosystem: 'python', name: 'qwen-agent', version: '1', declared: '', scope: 'requirements-bfcl.txt' }).status, 'ok');
  assert.equal(evaluatePackage(policy, { ecosystem: 'python', name: 'unknown-thing', version: '1', declared: '', scope: 'requirements-bfcl.txt' }).status, 'violation');
});

test('every override and exception documents its evidence', () => {
  for (const entry of policy.overrides) assert.match(entry.evidence, /https?:\/\//, entry.name);
  for (const entry of policy.exceptions) assert.ok(entry.reason.length > 40, entry.name);
});

test('only non-dev lockfile entries are production packages', () => {
  const lock = { packages: {
    '': { name: 'app' },
    'node_modules/prod': { version: '1.0.0', license: 'MIT' },
    'node_modules/tool': { version: '2.0.0', license: 'GPL-3.0-only', dev: true },
    'node_modules/prod/node_modules/nested': { version: '3.0.0', license: 'GPL-3.0-only' },
  } };
  assert.deepEqual(npmProductionPackages(lock).map((row) => row.name), ['nested', 'prod']);
  const statuses = npmProductionPackages(lock).map((row) => evaluate(row.declared).status);
  assert.deepEqual(statuses, ['violation', 'ok']);
});

test('pip report licences come from the expression, then classifiers, then the field', () => {
  const report = { install: [
    { metadata: { name: 'a', version: '1', license_expression: 'MIT' } },
    { metadata: { name: 'b', version: '1', classifier: ['License :: OSI Approved :: Apache Software License'] } },
    { metadata: { name: 'c', version: '1', license: 'MIT' } },
    { metadata: { name: 'd', version: '1', classifier: ['License :: OSI Approved :: GNU Affero General Public License v3'] } },
    { metadata: { name: 'e', version: '1' } },
  ] };
  const rows = pythonPackagesFromReport(report);
  assert.deepEqual(rows.map((row) => row.declared), ['MIT', 'Apache-2.0', 'MIT', 'AGPL-3.0-or-later', '']);
  assert.deepEqual(rows.map((row) => evaluatePackage(policy, { ecosystem: 'python', scope: 'requirements-x.txt', ...row }).status), ['ok', 'ok', 'ok', 'violation', 'violation']);
});

test('PyMuPDF would be rejected by the policy', () => {
  assert.equal(evaluatePackage(policy, { ecosystem: 'python', name: 'PyMuPDF', version: '1.28.2', declared: 'AGPL-3.0-only', scope: 'requirements-local-documents.txt' }).status, 'violation');
});

test('normalizeLicense maps common labels and ignores pasted licence text', () => {
  assert.equal(normalizeLicense('Apache 2.0'), 'Apache-2.0');
  assert.equal(normalizeLicense('MIT License'), 'MIT');
  assert.equal(normalizeLicense('Permission is hereby granted, free of charge, to any person obtaining a copy of this software'), 'MIT');
  assert.equal(normalizeLicense(''), '');
  assert.equal(normalizeLicense('BSD 3-Clause OR Apache-2.0'), 'BSD-3-Clause OR Apache-2.0');
  assert.equal(evaluate(normalizeLicense('BSD 3-Clause OR Apache-2.0')).status, 'ok');
});

test('cargo metadata closure follows normal and build dependencies and skips dev dependencies', () => {
  const metadata = {
    workspace_members: ['root'],
    packages: ['root', 'a', 'b', 'c'].map((id) => ({ id, name: id, version: '1.0.0', license: 'MIT', manifest_path: `/x/${id}/Cargo.toml` })),
    resolve: { root: 'root', nodes: [
      { id: 'root', deps: [{ pkg: 'a', dep_kinds: [{ kind: null }] }, { pkg: 'b', dep_kinds: [{ kind: 'dev' }] }] },
      { id: 'a', deps: [{ pkg: 'c', dep_kinds: [{ kind: 'build' }] }] },
      { id: 'b', deps: [] }, { id: 'c', deps: [] },
    ] },
  };
  assert.deepEqual(cargoPackagesFromMetadata(metadata).map((row) => row.name), ['a', 'c']);
});
