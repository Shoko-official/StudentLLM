// @vitest-environment node
import { spawnSync } from 'node:child_process';
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

// Every run is a child process with a fake fetch and a fake key: no request can leave this machine.
const root = fileURLToPath(new URL('../..', import.meta.url));
const runner = fileURLToPath(new URL('./run.mjs', import.meta.url));
const fakeFetch = pathToFileURL(fileURLToPath(new URL('./fake-fetch.mjs', import.meta.url))).href;
const KEY = 'fake-key-0123456789abcdef';
const SLOW = 180_000;

let tmp, counter = 0;
beforeAll(() => { tmp = mkdtempSync(join(tmpdir(), 'tutor-run-test-')); });
afterAll(() => { rmSync(tmp, { recursive: true, force: true }); });

const quizCase = (id, prompt) => ({ id, split: 'dev', prompt, artefacts: [{ type: 'quiz', correct: { value: 8, unit: 'V' } }], proseFacts: [] });
const casesFile = () => {
  const path = join(tmp, `cases-${counter++}.json`);
  writeFileSync(path, JSON.stringify({ quality: [quizCase('q1', 'QCASE un')], rate: { explanatory: ['EXPL un'], definitions: ['DEF un'] } }));
  return path;
};
const holdoutsFile = (prompt = 'HOLD un') => {
  const path = join(tmp, `holdouts-${counter++}.json`);
  writeFileSync(path, '\uFEFF' + JSON.stringify([quizCase('h1', `${prompt} a`), quizCase('h2', `${prompt} b`)]));
  return path;
};
const outDir = () => { const path = join(tmp, `out-${counter++}`); mkdirSync(path); return path; };
const lines = (path) => (existsSync(path) ? readFileSync(path, 'utf8').split('\n').filter(Boolean) : []);
const rows = (out, name = 'results.jsonl') => lines(join(out, name)).map((line) => JSON.parse(line));

function run(args, { fake = {}, cwd = root, key = KEY } = {}) {
  const stats = join(tmp, `stats-${counter++}.jsonl`);
  const env = { ...process.env, TUTOR_FAKE: JSON.stringify(fake), TUTOR_FAKE_STATS: stats };
  delete env.NVIDIA_API_KEY;
  if (key) env.NVIDIA_API_KEY = key;
  const result = spawnSync(process.execPath, ['--import', fakeFetch, runner, ...args], { cwd, env, encoding: 'utf8', timeout: SLOW });
  const counts = lines(stats).map((line) => JSON.parse(line)).at(-1) ?? { calls: 0, old: 0, prose: 0, visual: 0 };
  return { code: result.status, stdout: result.stdout, stderr: result.stderr, counts };
}
const real = (out, cases, holdouts) => ['--cases', cases, ...(holdouts ? ['--holdouts', holdouts] : []), '--allow-dirty', '--out', out];
const filesUnder = (dir) => readdirSync(dir).flatMap((name) => { const path = join(dir, name); return statSync(path).isDirectory() ? filesUnder(path) : [path]; });
const keyedFiles = (dir) => filesUnder(dir).filter((path) => readFileSync(path).includes(KEY));

describe('dry run', () => {
  it('counts the cells with and without holdouts, with no key and no request', () => {
    const without = run(['--dry-run', '--out', outDir()], { key: null });
    expect(without.code).toBe(0);
    expect(without.stdout).toContain('108 cells');
    const withHoldouts = run(['--dry-run', '--holdouts', holdoutsFile(), '--out', outDir()], { key: null });
    expect(withHoldouts.code).toBe(0);
    expect(withHoldouts.stdout).toContain('132 cells');
    expect(without.counts.calls + withHoldouts.counts.calls).toBe(0);
  }, SLOW);
});

describe('real run', () => {
  it('measures every cell once, keeps provenance, counts each POST and resumes without duplicates', () => {
    const out = outDir(), cases = casesFile(), holdouts = holdoutsFile();
    const first = run(real(out, cases, holdouts));
    expect(first.code).toBe(0);
    const results = rows(out);
    expect(results).toHaveLength(48);
    expect(new Set(results.map((row) => row.cell)).size).toBe(48);
    expect(results.filter((row) => row.kind === 'quality').every((row) => row.contentHash && Number.isInteger(row.sample))).toBe(true);
    expect(existsSync(join(out, 'run.lock'))).toBe(false);
    expect(existsSync(join(out, 'failures.jsonl'))).toBe(false);
    expect(lines(join(out, 'posts.log'))).toHaveLength(first.counts.calls);
    const gate = JSON.parse(readFileSync(join(out, 'gate.json'), 'utf8'));
    expect(gate.incomplete).toBe(false);
    expect(gate.details.duplicates.pairs).toBeGreaterThan(0);
    const meta = JSON.parse(readFileSync(join(out, 'run.json'), 'utf8'));
    expect(meta.commit).toMatch(/^[0-9a-f]{40}$/);
    expect(meta.promptsHash).toMatch(/^[0-9a-f]{64}$/);
    expect(meta.casesHash).toMatch(/^[0-9a-f]{64}$/);
    expect(meta.models).toHaveLength(3);
    expect(meta.samples).toBe(2);

    const again = run(real(out, cases, holdouts));
    expect(again.code).toBe(0);
    expect(again.counts.calls).toBe(0);
    expect(rows(out)).toHaveLength(48);

    const changed = run(real(out, cases, holdoutsFile('HOLD autre')));
    expect(changed.code).toBe(1);
    expect(changed.stderr).toMatch(/mismatch/i);
    appendFileSync(join(out, 'results.jsonl'), '{"cell":"quality/elsewhere/x/old/0"}\n');
    const stale = run(real(out, cases, holdouts));
    expect(stale.code).toBe(1);
    expect(stale.stderr).toMatch(/stale/i);
  }, SLOW);

  it('does not decide without both holdouts, and sends nothing', () => {
    const out = outDir();
    const result = run(real(out, casesFile()));
    expect(result.code).toBe(2);
    expect(result.stdout).toContain('no holdouts');
    expect(result.counts.calls).toBe(0);
    expect(existsSync(join(out, 'posts.log'))).toBe(false);
  }, SLOW);

  it('keeps infrastructure failures out of the results, blocks the decision, and reruns the pair on resume', () => {
    const out = outDir(), cases = casesFile(), holdouts = holdoutsFile();
    const first = run(real(out, cases, holdouts), { fake: { first503: 2 } });
    expect(first.code).toBe(2);
    expect(rows(out, 'failures.jsonl')).toHaveLength(1);
    expect(rows(out)).toHaveLength(46);
    const gate = JSON.parse(readFileSync(join(out, 'gate.json'), 'utf8'));
    expect(gate.pass).toBe(false);
    expect(gate.incomplete).toBe(true);
    expect(gate.details.missing).toHaveLength(2);
    expect(first.stdout).toContain('missing');

    const second = run(real(out, cases, holdouts));
    expect(second.code).toBe(0);
    expect(rows(out)).toHaveLength(48);
    expect(new Set(rows(out).map((row) => row.cell)).size).toBe(48);
    expect(lines(join(out, 'posts.log'))).toHaveLength(first.counts.calls + second.counts.calls);
  }, SLOW);

  it('saves a model output failure as a measurement, with its own clock, and never retries it', () => {
    const out = outDir();
    const result = run(real(out, casesFile(), holdoutsFile()), { fake: { oldMode: 'invalid' } });
    expect(result.code).toBe(0);
    const failedOld = rows(out).filter((row) => row.arm === 'old');
    expect(failedOld).toHaveLength(24);
    expect(failedOld.every((row) => row.failed && row.error)).toBe(true);
    const failedQuality = failedOld.filter((row) => row.kind === 'quality');
    expect(failedQuality).toHaveLength(18);
    expect(failedQuality.every((row) => row.totalSeconds > 0 && row.totalSeconds < 10 && row.complete === 0)).toBe(true);
    expect(failedOld.filter((row) => row.kind === 'rate').every((row) => row.requested === false)).toBe(true);
    expect(JSON.parse(readFileSync(join(out, 'gate.json'), 'utf8')).incomplete).toBe(false);
    expect(result.counts.old).toBe(24);
    expect(existsSync(join(out, 'failures.jsonl'))).toBe(false);
  }, SLOW);

  it('runs cells one at a time, with at most two visuals together inside a cell', () => {
    const result = run(real(outDir(), casesFile(), holdoutsFile()), { fake: { latency: 5000 } });
    expect(result.code).toBe(0);
    expect(result.counts.maxInFlight).toBe(2);
  }, SLOW);

  it('keeps a visual that runs out of its own deadline as a measurement', () => {
    const out = outDir();
    const result = run(real(out, casesFile(), holdoutsFile()), { fake: { hang: 'visual' } });
    expect(result.code).toBe(0);
    expect(existsSync(join(out, 'failures.jsonl'))).toBe(false);
    const timedOut = rows(out).filter((row) => row.kind === 'quality' && row.arm === 'new');
    expect(timedOut).toHaveLength(18);
    expect(timedOut.every((row) => row.complete === 0 && !row.failed && row.visualResults.every((visual) => !visual.ok && /timed out/.test(visual.errors[0])))).toBe(true);
    expect(timedOut.every((row) => row.totalSeconds >= 60 && row.totalSeconds < 119)).toBe(true);
  }, SLOW);

  it('treats a prose call that times out as an infrastructure failure', () => {
    const out = outDir();
    const result = run(real(out, casesFile(), holdoutsFile()), { fake: { hang: 'prose' } });
    expect(result.code).toBe(2);
    expect(rows(out, 'failures.jsonl').length).toBeGreaterThan(0);
    expect(rows(out, 'failures.jsonl').every((failure) => failure.kind === 'abort')).toBe(true);
    expect(rows(out).some((row) => row.arm === 'new')).toBe(false);
  }, SLOW);

  it('refuses a POST past the cap, counted across resumes', () => {
    const out = outDir();
    writeFileSync(join(out, 'posts.log'), '{"n":0}\n'.repeat(360));
    const result = run(real(out, casesFile(), holdoutsFile()));
    expect(result.code).toBe(2);
    expect(result.counts.calls).toBe(0);
    expect(lines(join(out, 'posts.log'))).toHaveLength(360);
    expect(result.stdout + result.stderr).toMatch(/cap/i);
  }, SLOW);

  it('refuses to start while another run holds the lock', () => {
    const out = outDir();
    writeFileSync(join(out, 'run.lock'), 'other');
    const result = run(real(out, casesFile(), holdoutsFile()));
    expect(result.code).toBe(1);
    expect(result.stderr).toMatch(/lock/i);
    expect(readFileSync(join(out, 'run.lock'), 'utf8')).toBe('other');
    expect(result.counts.calls).toBe(0);
  }, SLOW);

  it('refuses a dirty working tree', () => {
    const repo = mkdtempSync(join(tmp, 'repo-'));
    const git = (...args) => spawnSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.test', ...args], { cwd: repo, encoding: 'utf8' });
    git('init', '-q');
    writeFileSync(join(repo, 'a.txt'), 'a');
    git('add', 'a.txt');
    git('commit', '-q', '-m', 'init');
    writeFileSync(join(repo, 'b.txt'), 'untracked');
    const out = outDir();
    const result = run(['--cases', casesFile(), '--holdouts', holdoutsFile(), '--out', out], { cwd: repo });
    expect(result.code).toBe(1);
    expect(result.stderr).toMatch(/dirty/i);
    expect(result.counts.calls).toBe(0);
  }, SLOW);

  it('never writes the key, whether a 401 or a visual error echoes it', () => {
    for (const fake of [{ echoKey: true }, { echoVisual: true }]) {
      const out = outDir();
      const result = run(real(out, casesFile(), holdoutsFile()), { fake });
      expect(result.code).toBe(2);
      expect(rows(out, 'failures.jsonl').length).toBeGreaterThan(0);
      expect(lines(join(out, 'failures.jsonl')).join('\n')).toContain('[key]');
      expect(result.stdout + result.stderr).not.toContain(KEY);
      expect(keyedFiles(out)).toEqual([]);
    }
  }, SLOW);
});
