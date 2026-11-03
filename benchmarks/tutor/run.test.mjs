// @vitest-environment node
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import committed from './cases.json';

// The runner only checks case files now, and never reads a key or opens a connection. Every call is a child process.
const root = fileURLToPath(new URL('../..', import.meta.url));
const runner = fileURLToPath(new URL('./run.mjs', import.meta.url));
const SLOW = 180_000;
const BOM = String.fromCharCode(0xFEFF);
const rateTotal = Object.values(committed.rate).reduce((sum, list) => sum + list.length, 0);
const summary = (holdouts = 0) => `${committed.quality.length + holdouts} quality cases, ${rateTotal} rate prompts`;

let tmp, counter = 0;
beforeAll(() => { tmp = mkdtempSync(join(tmpdir(), 'tutor-run-test-')); });
afterAll(() => { rmSync(tmp, { recursive: true, force: true }); });

const holdoutCase = (id, prompt) => ({ id, prompt, artefacts: [{ type: 'quiz', correct: { value: 8, unit: 'V' } }], proseFacts: [] });
const jsonFile = (value, prefix = 'holdouts') => {
  const path = join(tmp, `${prefix}-${counter++}.json`);
  writeFileSync(path, BOM + JSON.stringify(value));
  return path;
};
const holdoutsFile = (prompt = 'HOLD un') => jsonFile([holdoutCase('h1', `${prompt} a`), holdoutCase('h2', `${prompt} b`)]);
const outDir = () => { const path = join(tmp, `out-${counter++}`); mkdirSync(path); return path; };
const rateOf = (explanatory, definitions) => ({ explanatory, definitions });
const hiddenFile = (rate, quality = [holdoutCase('h1', 'HOLD un a'), holdoutCase('h2', 'HOLD un b')]) => jsonFile({ quality, rate });
const secretRate = () => rateOf(committed.rate.explanatory.map((_, index) => `SECRET e${index}`), committed.rate.definitions.map((_, index) => `SECRET d${index}`));

function run(args, { env: extra = {}, key = null } = {}) {
  const env = { ...process.env, ...extra };
  delete env.NVIDIA_API_KEY;
  if (key) env.NVIDIA_API_KEY = key;
  const result = spawnSync(process.execPath, [runner, ...args], { cwd: root, env, encoding: 'utf8', timeout: SLOW });
  return { code: result.status, stdout: result.stdout, stderr: result.stderr };
}
const check = (holdouts, out = outDir()) => run(['--dry-run', ...(holdouts ? ['--holdouts', holdouts] : []), '--out', out]);

describe('measurements', () => {
  it('are refused, with or without a key, and leave nothing behind', () => {
    for (const key of [null, 'fake-key-0123456789abcdef']) {
      const out = join(tmp, `never-${counter++}`);
      const result = run(['--holdouts', holdoutsFile(), '--out', out], { key });
      expect(result.code).toBe(1);
      expect(result.stderr).toMatch(/no longer runs measurements/);
      expect(result.stderr).toContain('8e3864f');
      expect(result.stdout).toBe('');
      expect(existsSync(out)).toBe(false);
      expect(existsSync(join(out, '..', 'posts.log'))).toBe(false);
    }
  }, SLOW);
});

describe('dry run', () => {
  it('counts the cases with and without holdouts, with no key and no request', () => {
    const without = check();
    expect(without.code).toBe(0);
    expect(without.stdout.trim()).toBe(summary());
    const withHoldouts = check(holdoutsFile());
    expect(withHoldouts.code).toBe(0);
    expect(withHoldouts.stdout.trim()).toBe(summary(2));
  }, SLOW);

  it('writes nothing but the module cache next to the output directory', () => {
    const parent = join(tmp, `parent-${counter++}`);
    mkdirSync(parent);
    const out = join(parent, 'out');
    expect(run(['--dry-run', '--out', out]).code).toBe(0);
    expect(readdirSync(parent)).toEqual(['out']);
    expect(readdirSync(out).filter((name) => name !== 'vite-cache')).toEqual([]);
  }, SLOW);

  it('requires --out', () => {
    const result = run(['--dry-run']);
    expect(result.code).toBe(1);
    expect(result.stderr).toMatch(/--out/);
  }, SLOW);
});

describe('hidden rate questions', () => {
  it('replaces the rate prompts of a check, keeps the same shape and never prints them', () => {
    const result = check(hiddenFile(secretRate()));
    expect(result.code).toBe(0);
    expect(result.stdout.trim()).toBe(summary(2));
    expect(result.stdout + result.stderr).not.toContain('SECRET');
  }, SLOW);

  it('refuses invalid rate data without printing the questions', () => {
    const attempts = [
      [{ explanatory: ['SECRET a'] }, /rate/],
      [{ ...secretRate(), extra: ['SECRET c'] }, /rate/],
      [rateOf(['SECRET a', 'SECRET b'], ['SECRET c']), /explanatory.*6/],
      [rateOf(committed.rate.explanatory.map((_, index) => `SECRET e${index}`), []), /definitions.*4/],
      [rateOf([42, ...committed.rate.explanatory.slice(1).map((_, index) => `SECRET e${index}`)], secretRate().definitions), /explanatory\[0\]/],
      [rateOf(secretRate().explanatory, ['   ', ...secretRate().definitions.slice(1)]), /definitions\[0\]/],
      [rateOf(secretRate().explanatory, ['SECRET d1', '  secret   D1 ', 'SECRET d2', 'SECRET d3']), /definitions\[1\].*duplicate/],
      [rateOf([committed.rate.explanatory[0].toUpperCase(), ...secretRate().explanatory.slice(1)], secretRate().definitions), /explanatory\[0\].*cases/],
      [['SECRET a'], /rate/],
    ];
    for (const [rate, message] of attempts) {
      const result = check(hiddenFile(rate));
      expect(result.code, JSON.stringify(rate)).toBe(1);
      expect(result.stderr).toMatch(message);
      expect(result.stdout + result.stderr).not.toMatch(/secret/i);
    }
  }, SLOW);

  it('does not echo the questions when the holdouts file is not valid JSON', () => {
    const path = join(tmp, `broken-${counter++}.json`);
    writeFileSync(path, '{"quality": [], "rate": {"explanatory": ["SECRET question", ], "definitions": []}}');
    const result = check(path);
    expect(result.code).toBe(1);
    expect(result.stderr).toMatch(/not valid JSON/);
    expect(result.stdout + result.stderr).not.toContain('SECRET');
  }, SLOW);

  it('does not print the name of an unknown top-level key of the holdouts object', () => {
    const result = check(jsonFile({ quality: [], rate: secretRate(), 'SECRET question?': 1 }));
    expect(result.code).toBe(1);
    expect(result.stderr).toMatch(/unknown key/);
    expect(result.stdout + result.stderr).not.toMatch(/SECRET/i);
  }, SLOW);
});

describe('holdout cases', () => {
  it('are refused when they cannot be scored', () => {
    const good = holdoutCase('h2', 'HOLD deux');
    const firstId = committed.quality[0].id;
    const attempts = [
      [[{ ...holdoutCase('h1', 'HOLD'), artefacts: [{ type: 'quiz', correct: '\\b8\\b' }] }, good], /regex|old/i],
      [[holdoutCase(firstId, 'HOLD'), good], new RegExp(`${firstId}.*already`)],
      [[holdoutCase('h1', 'HOLD'), holdoutCase('h1', 'HOLD bis')], /h1.*already/],
      [[{ ...holdoutCase('h1', 'HOLD'), artefacts: [{ type: 'plot', x: { min: 0, max: 1 }, sliders: [], curves: ['nosuchfn(x)'] }] }, good], /nosuchfn/],
      [[{ ...holdoutCase('h1', 'HOLD'), artefacts: [] }, good], /artefacts/],
      [[{ ...holdoutCase('h1', 'HOLD'), split: 'dev' }, good], /split/],
    ];
    for (const [list, message] of attempts) {
      const result = check(jsonFile(list));
      expect(result.code).toBe(1);
      expect(result.stderr).toMatch(message);
    }
  }, SLOW);
});
