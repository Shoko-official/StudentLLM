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
const BOM = String.fromCharCode(0xFEFF);

let tmp, counter = 0;
beforeAll(() => { tmp = mkdtempSync(join(tmpdir(), 'tutor-run-test-')); });
afterAll(() => { rmSync(tmp, { recursive: true, force: true }); });

const holdoutCase = (id, prompt) => ({ id, prompt, artefacts: [{ type: 'quiz', correct: { value: 8, unit: 'V' } }], proseFacts: [] });
const casesFile = () => {
  const path = join(tmp, `cases-${counter++}.json`);
  writeFileSync(path, JSON.stringify({ quality: [{ ...holdoutCase('q1', 'QCASE un'), split: 'dev' }], rate: { explanatory: ['EXPL un'], definitions: ['DEF un'] } }));
  return path;
};
const jsonFile = (value, prefix = 'holdouts') => {
  const path = join(tmp, `${prefix}-${counter++}.json`);
  writeFileSync(path, BOM + JSON.stringify(value));
  return path;
};
const holdoutsFile = (prompt = 'HOLD un') => jsonFile([holdoutCase('h1', `${prompt} a`), holdoutCase('h2', `${prompt} b`)]);
const workDir = () => { const path = join(tmp, `work-${counter++}`); mkdirSync(path); return path; };
const outDir = (parent = workDir()) => { const path = join(parent, `out-${counter++}`); mkdirSync(path); return path; };
const lines = (path) => (existsSync(path) ? readFileSync(path, 'utf8').split('\n').filter(Boolean) : []);
const rows = (out, name = 'results.jsonl') => lines(join(out, name)).map((line) => JSON.parse(line));
const gateOf = (out) => JSON.parse(readFileSync(join(out, 'gate.json'), 'utf8'));
// The runs of this file use --allow-dirty and --cases, which always make the decision incomplete; these are the other reasons.
const dataReasons = (gate) => gate.details.reasons.filter((reason) => !/--allow-dirty|--cases/.test(reason));
const ledgerOf = (out) => join(out, '..', 'posts.log');
const stable = (list) => list.map(({ firstTextSeconds, totalSeconds, ...rest }) => rest);
const oldCell = 'quality/nvidia/nemotron-3.5-lightning-30b-a3b/q1/old/0', newCell = 'quality/nvidia/nemotron-3.5-lightning-30b-a3b/q1/new/0';

function run(args, { fake = {}, cwd = root, key = KEY, env: extra = {} } = {}) {
  const stats = join(tmp, `stats-${counter++}.jsonl`);
  const env = { ...process.env, ...extra, TUTOR_FAKE: JSON.stringify(fake), TUTOR_FAKE_STATS: stats };
  delete env.NVIDIA_API_KEY;
  if (key) env.NVIDIA_API_KEY = key;
  const result = spawnSync(process.execPath, ['--import', fakeFetch, runner, ...args], { cwd, env, encoding: 'utf8', timeout: SLOW });
  const counts = lines(stats).map((line) => JSON.parse(line)).at(-1) ?? { calls: 0, old: 0, prose: 0, visual: 0, times: [] };
  return { code: result.status, stdout: result.stdout, stderr: result.stderr, counts };
}
const real = (out, cases, holdouts) => ['--cases', cases, ...(holdouts ? ['--holdouts', holdouts] : []), '--allow-dirty', '--out', out];
const filesUnder = (dir) => readdirSync(dir).flatMap((name) => { const path = join(dir, name); return statSync(path).isDirectory() ? filesUnder(path) : [path]; });
const keyedFiles = (dir) => filesUnder(dir).filter((path) => readFileSync(path).includes(KEY));

describe('dry run', () => {
  it('counts the cells with and without holdouts, with no key and no request, and writes no ledger', () => {
    const parent = workDir();
    const without = run(['--dry-run', '--out', outDir(parent)], { key: null });
    expect(without.code).toBe(0);
    expect(without.stdout).toContain('108 cells');
    const withHoldouts = run(['--dry-run', '--holdouts', holdoutsFile(), '--out', outDir(parent)], { key: null });
    expect(withHoldouts.code).toBe(0);
    expect(withHoldouts.stdout).toContain('132 cells');
    expect(without.counts.calls + withHoldouts.counts.calls).toBe(0);
    expect(existsSync(join(parent, 'posts.log')) || existsSync(join(parent, 'runs.jsonl')) || existsSync(join(parent, 'run.lock'))).toBe(false);
  }, SLOW);
});

const rateOf = (explanatory, definitions) => ({ explanatory, definitions });
const hiddenFile = (rate, quality = [holdoutCase('h1', 'HOLD un a'), holdoutCase('h2', 'HOLD un b')]) => jsonFile({ quality, rate });

describe('hidden rate questions', () => {
  it('replaces the rate prompts of this run and keeps the cells the same shape', () => {
    const parent = workDir();
    const dry = run(['--dry-run', '--holdouts', hiddenFile({ explanatory: ['a1', 'a2', 'a3', 'a4', 'a5', 'a6'].map((item) => `SECRET ${item}`), definitions: ['d1', 'd2', 'd3', 'd4'].map((item) => `SECRET ${item}`) }), '--out', outDir(parent)], { key: null });
    expect(dry.code).toBe(0);
    expect(dry.stdout).toContain('132 cells');
    expect(dry.stdout + dry.stderr).not.toContain('SECRET');

    const out = outDir(parent);
    const result = run(real(out, casesFile(), hiddenFile(rateOf(['HOLD secret e'], ['HOLD secret d']))));
    expect(result.code).toBe(2);
    const rate = rows(out).filter((row) => row.kind === 'rate');
    expect(rate).toHaveLength(12);
    expect(rate.filter((row) => row.arm === 'old').every((row) => row.requested)).toBe(true);
    expect(rate.map((row) => row.cell)).toContain('rate/nvidia/nemotron-3.5-lightning-30b-a3b/explanatory/0/old');
    expect(result.stdout + result.stderr).not.toContain('secret');
  }, SLOW);

  it('keeps the committed rate prompts when the holdouts are an array or have no rate', () => {
    const out = outDir(), noRate = outDir();
    run(real(out, casesFile(), holdoutsFile()));
    run(real(noRate, casesFile(), jsonFile({ quality: [holdoutCase('h1', 'HOLD un a'), holdoutCase('h2', 'HOLD un b')] })));
    for (const dir of [out, noRate]) expect(rows(dir).filter((row) => row.kind === 'rate' && row.arm === 'old').some((row) => row.requested)).toBe(false);
  }, SLOW);

  it('refuses invalid rate data before any request, without printing the questions', () => {
    const cases = casesFile();
    const attempts = [
      [{ explanatory: ['SECRET a'] }, /rate/],
      [{ explanatory: ['SECRET a'], definitions: ['SECRET b'], extra: ['SECRET c'] }, /rate/],
      [rateOf(['SECRET a', 'SECRET b'], ['SECRET c']), /explanatory.*1/],
      [rateOf(['SECRET a'], []), /definitions.*1/],
      [rateOf([42], ['SECRET c']), /explanatory\[0\]/],
      [rateOf(['SECRET a'], ['   ']), /definitions\[0\]/],
      [rateOf(['SECRET a'], ['  secret   A ']), /definitions\[0\].*duplicate/],
      [rateOf(['expl UN'], ['SECRET c']), /explanatory\[0\].*cases/],
      [['SECRET a'], /rate/],
    ];
    for (const [rate, message] of attempts) {
      const out = outDir();
      const result = run(real(out, cases, hiddenFile(rate)));
      expect(result.code, JSON.stringify(rate)).toBe(1);
      expect(result.stderr).toMatch(message);
      expect(result.stdout + result.stderr).not.toMatch(/secret a|secret b|secret c/i);
      expect(result.counts.calls).toBe(0);
      expect(existsSync(ledgerOf(out))).toBe(false);
    }
    expect(run(['--dry-run', '--holdouts', hiddenFile(attempts[0][0]), '--out', outDir()], { key: null }).code).toBe(1);
    const unknown = run(real(outDir(), cases, jsonFile({ quality: [], rate: rateOf(['SECRET a'], ['SECRET b']), rates: [] })));
    expect(unknown.code).toBe(1);
    expect(unknown.stdout + unknown.stderr).not.toContain('SECRET');
  }, SLOW);

  it('does not echo the questions when the holdouts file is not valid JSON', () => {
    const path = join(tmp, `broken-${counter++}.json`);
    writeFileSync(path, '{"quality": [], "rate": {"explanatory": ["SECRET question", ], "definitions": []}}');
    const result = run(['--dry-run', '--holdouts', path, '--out', outDir()], { key: null });
    expect(result.code).toBe(1);
    expect(result.stderr).toMatch(/not valid JSON/);
    expect(result.stdout + result.stderr).not.toContain('SECRET');
  }, SLOW);

  it('still requires two holdout cases', () => {
    const result = run(real(outDir(), casesFile(), hiddenFile(rateOf(['HOLD e'], ['HOLD d']), [holdoutCase('h1', 'HOLD un a')])));
    expect(result.code).toBe(2);
    expect(result.stdout).toContain('no holdouts');
    expect(result.counts.calls).toBe(0);
  }, SLOW);

  it('counts the rate questions in the holdouts hash and in the run metadata', () => {
    const parent = workDir(), cases = casesFile(), out = outDir(parent);
    run(real(out, cases, hiddenFile(rateOf(['HOLD e one'], ['HOLD d one']))), { fake: { oldMode: 'invalid' } });
    expect(lines(join(parent, 'runs.jsonl'))).toHaveLength(1);
    const same = run(real(outDir(parent), cases, hiddenFile(rateOf(['HOLD e one'], ['HOLD d one']))));
    expect(same.code).toBe(1);
    expect(same.stderr).toMatch(/holdouts.*already used/i);
    const array = run(real(outDir(parent), cases, holdoutsFile('HOLD un')));
    expect(array.stderr).not.toMatch(/already used/i);
    const changed = run(real(out, cases, hiddenFile(rateOf(['HOLD e two'], ['HOLD d one']))));
    expect(changed.code).toBe(1);
    expect(changed.stderr).toMatch(/mismatch in .*casesHash/);
    const other = run(real(outDir(parent), cases, hiddenFile(rateOf(['HOLD e two'], ['HOLD d one']))), { fake: { oldMode: 'invalid' } });
    expect(other.stderr).not.toMatch(/already used/i);
  }, SLOW);
});

describe('real run', () => {
  it('measures every cell once, keeps provenance, counts each POST and resumes without duplicates', () => {
    const out = outDir(), cases = casesFile(), holdouts = holdoutsFile();
    const first = run(real(out, cases, holdouts));
    const results = rows(out);
    expect(results).toHaveLength(48);
    expect(new Set(results.map((row) => row.cell)).size).toBe(48);
    expect(results.filter((row) => row.kind === 'quality').every((row) => row.contentHash && Number.isInteger(row.sample))).toBe(true);
    expect(existsSync(join(out, 'run.lock')) || existsSync(join(out, '..', 'run.lock'))).toBe(false);
    expect(existsSync(join(out, 'failures.jsonl'))).toBe(false);
    expect(lines(ledgerOf(out))).toHaveLength(first.counts.calls);
    expect(rows(join(out, '..'), 'runs.jsonl')).toHaveLength(1);
    const gate = gateOf(out);
    // The data is complete, yet a run made with --allow-dirty and --cases can never decide.
    expect(first.code).toBe(2);
    expect(gate.pass).toBe(false);
    expect(gate.incomplete).toBe(true);
    expect(dataReasons(gate)).toEqual([]);
    expect(gate.details.reasons.join(' ')).toMatch(/allow-dirty/);
    expect(gate.details.reasons.join(' ')).toMatch(/--cases/);
    expect(typeof gate.dirty).toBe('boolean');
    expect(gate.customCases).toBe(true);
    expect(gate.details.duplicates.pairs).toBeGreaterThan(0);
    const meta = JSON.parse(readFileSync(join(out, 'run.json'), 'utf8'));
    expect(meta.commit).toMatch(/^[0-9a-f]{40}$/);
    expect(meta.promptsHash).toMatch(/^[0-9a-f]{64}$/);
    expect(meta.casesHash).toMatch(/^[0-9a-f]{64}$/);
    expect(meta.models).toHaveLength(3);
    expect(meta.samples).toBe(2);

    const again = run(real(out, cases, holdouts));
    expect(again.code).toBe(2);
    expect(again.counts.calls).toBe(0);
    expect(gateOf(out).details.reasons.join(' ')).toMatch(/allow-dirty/);
    expect(rows(out)).toHaveLength(48);

    const changed = run(real(out, cases, holdoutsFile('HOLD autre')));
    expect(changed.code).toBe(1);
    expect(changed.stderr).toMatch(/mismatch/i);
    appendFileSync(join(out, 'results.jsonl'), '{"cell":"quality/nvidia/nemotron-3.5-lightning-30b-a3b/q1/old/0"');
    const truncated = run(real(out, cases, holdouts));
    expect(truncated.code).toBe(1);
    expect(truncated.stderr).toMatch(/truncated/i);
    writeFileSync(join(out, 'results.jsonl'), readFileSync(join(out, 'results.jsonl'), 'utf8').replace(/\{"cell":"quality\/nvidia\/nemotron-3.5-lightning-30b-a3b\/q1\/old\/0"$/, ''));
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
    expect(existsSync(ledgerOf(out))).toBe(false);
    // gate.json says so too, so a gate left by an earlier run in this directory cannot be read as the answer.
    const gate = gateOf(out);
    expect(gate).toMatchObject({ pass: false, incomplete: true, posts: 0, cells: 0, expected: 24 });
    expect(gate.details.reasons).toContain('no holdouts');
    expect(gate.details.missing).toHaveLength(24);
  }, SLOW);

  it('refuses invalid holdouts before any request', () => {
    const cases = casesFile();
    const good = holdoutCase('h2', 'HOLD deux');
    const attempts = [
      [[{ ...holdoutCase('h1', 'HOLD'), artefacts: [{ type: 'quiz', correct: '\\b8\\b' }] }, good], /regex|old/i],
      [[holdoutCase('q1', 'HOLD'), good], /q1.*already/],
      [[holdoutCase('h1', 'HOLD'), holdoutCase('h1', 'HOLD bis')], /h1.*already/],
      [[{ ...holdoutCase('h1', 'HOLD'), artefacts: [{ type: 'plot', x: { min: 0, max: 1 }, sliders: [], curves: ['nosuchfn(x)'] }] }, good], /nosuchfn/],
      [[{ ...holdoutCase('h1', 'HOLD'), artefacts: [] }, good], /artefacts/],
      [[{ ...holdoutCase('h1', 'HOLD'), split: 'dev' }, good], /split/],
    ];
    for (const [list, message] of attempts) {
      const out = outDir();
      const result = run(real(out, cases, jsonFile(list)));
      expect(result.code).toBe(1);
      expect(result.stderr).toMatch(message);
      expect(result.counts.calls).toBe(0);
      expect(existsSync(ledgerOf(out))).toBe(false);
    }
    expect(run(['--dry-run', '--holdouts', jsonFile(attempts[0][0]), '--out', outDir()], { key: null }).code).toBe(1);
  }, SLOW);

  it('keeps infrastructure failures out of the results, blocks the decision, and reruns the pair on resume', () => {
    const out = outDir(), cases = casesFile(), holdouts = holdoutsFile();
    const first = run(real(out, cases, holdouts), { fake: { first503: 2 } });
    expect(first.code).toBe(2);
    expect(rows(out, 'failures.jsonl')).toHaveLength(1);
    expect(rows(out)).toHaveLength(46);
    const gate = gateOf(out);
    expect(gate.pass).toBe(false);
    expect(gate.incomplete).toBe(true);
    expect(gate.details.missing).toHaveLength(2);
    expect(first.stdout).toContain('missing');

    const second = run(real(out, cases, holdouts));
    expect(rows(out)).toHaveLength(48);
    expect(new Set(rows(out).map((row) => row.cell)).size).toBe(48);
    expect(dataReasons(gateOf(out))).toEqual([]);
    expect(lines(ledgerOf(out))).toHaveLength(first.counts.calls + second.counts.calls);
  }, SLOW);

  it('keeps the pair when the provider retry succeeds', () => {
    const out = outDir();
    const result = run(real(out, casesFile(), holdoutsFile()), { fake: { first503: 1 } });
    expect(existsSync(join(out, 'failures.jsonl'))).toBe(false);
    expect(rows(out)).toHaveLength(48);
    expect(dataReasons(gateOf(out))).toEqual([]);
    expect(result.counts.calls).toBeGreaterThan(48);
  }, SLOW);

  it('treats a reply that is not a completion as an infrastructure failure, in both arms and on the visual path', () => {
    const expectations = [
      [{ kind: 'visual', mode: 'html' }, 'malformed'],
      [{ kind: 'visual', mode: 'error' }, 'malformed'],
      [{ kind: 'visual', mode: 'truncate' }, 'truncated'],
      [{ kind: 'prose', mode: 'error' }, 'malformed'],
      [{ kind: 'old', mode: 'html' }, 'malformed'],
    ];
    for (const [badBody, kind] of expectations) {
      const out = outDir();
      const result = run(real(out, casesFile(), holdoutsFile()), { fake: { badBody } });
      const failures = rows(out, 'failures.jsonl');
      expect(failures.length, JSON.stringify(badBody)).toBeGreaterThan(0);
      expect(failures[0].kind, JSON.stringify(badBody)).toBe(kind);
      expect(rows(out).some((row) => row.failed)).toBe(false);
      expect(gateOf(out).details.missing.length).toBeGreaterThan(0);
      expect(result.code).toBe(2);
    }
  }, SLOW);

  it('saves a model output failure as a measurement, with its own clock, and never retries it', () => {
    const out = outDir();
    const result = run(real(out, casesFile(), holdoutsFile()), { fake: { oldMode: 'invalid' } });
    const failedOld = rows(out).filter((row) => row.arm === 'old');
    expect(failedOld).toHaveLength(24);
    expect(failedOld.every((row) => row.failed && row.error)).toBe(true);
    const failedQuality = failedOld.filter((row) => row.kind === 'quality');
    expect(failedQuality).toHaveLength(18);
    expect(failedQuality.every((row) => row.totalSeconds > 0 && row.totalSeconds < 10 && row.complete === 0)).toBe(true);
    expect(failedOld.filter((row) => row.kind === 'rate').every((row) => row.requested === false)).toBe(true);
    // Rejected old rows are measured, with their real elapsed time: the gate is decided on them, not incomplete.
    expect(dataReasons(gateOf(out))).toEqual([]);
    expect(gateOf(out).details.perModel['nvidia/nemotron-3.5-lightning-30b-a3b'].failed.old).toBe(8);
    expect(result.counts.old).toBe(24);
    expect(existsSync(join(out, 'failures.jsonl'))).toBe(false);
  }, SLOW);

  it('keeps a call that hits the 120 s limit as a failed row with its real time, and counts it per arm', () => {
    const out = outDir();
    const result = run(real(out, casesFile(), holdoutsFile()), { fake: { hang: 'prose', speed: 400 } });
    // Every pair stalled once and was rerun; the second stall is the measurement.
    expect(rows(out, 'failures.jsonl').filter((item) => item.kind === 'timeout')).toHaveLength(24);
    expect(rows(out, 'failures.jsonl')).toHaveLength(24);
    const newRows = rows(out).filter((row) => row.arm === 'new');
    expect(newRows).toHaveLength(24);
    expect(newRows.every((row) => row.failed && row.timedOut)).toBe(true);
    expect(newRows.filter((row) => row.kind === 'quality').every((row) => row.totalSeconds > 100 && row.totalSeconds < 200)).toBe(true);
    const gate = gateOf(out);
    expect(gate.details.timeouts).toEqual({ old: 0, new: 24 });
    expect(gate.criteria.noMoreFailures).toBe(false);
    expect(dataReasons(gate)).toEqual([]);
    expect(result.code).toBe(2);
  }, SLOW);

  it('discards a pair once when a call stalls and reruns it, so a stall with a healthy retry changes nothing', () => {
    const cases = casesFile(), holdouts = holdoutsFile();
    const baseline = outDir();
    const reference = run(real(baseline, cases, holdouts));
    for (const [kind, extraPosts] of [['old', 1], ['prose', 2]]) {
      const out = outDir();
      const result = run(real(out, cases, holdouts), { fake: { hangCalls: { [kind]: [1] }, speed: 400 } });
      expect(stable(rows(out)), kind).toEqual(stable(rows(baseline)));
      const failures = rows(out, 'failures.jsonl');
      expect(failures, kind).toHaveLength(1);
      expect(failures[0]).toMatchObject({ kind: 'timeout', cells: [oldCell, newCell] });
      expect(rows(out).some((row) => row.failed || row.timedOut)).toBe(false);
      expect(gateOf(out).details.timeouts).toEqual({ old: 0, new: 0 });
      expect(gateOf(out).details.missing).toEqual([]);
      expect(dataReasons(gateOf(out))).toEqual([]);
      expect(result.counts.calls).toBe(reference.counts.calls + extraPosts);
      expect(lines(ledgerOf(out))).toHaveLength(result.counts.calls);
    }
  }, SLOW);

  it('counts a second stall of the same pair as a measurement, with its real elapsed time', () => {
    const cases = casesFile(), holdouts = holdoutsFile();
    const baseline = outDir();
    run(real(baseline, cases, holdouts));
    for (const [kind, arm, cell] of [['old', 'old', oldCell], ['prose', 'new', newCell]]) {
      const out = outDir();
      const result = run(real(out, cases, holdouts), { fake: { hangCalls: { [kind]: [1, 2] }, speed: 400 } });
      const failures = rows(out, 'failures.jsonl');
      expect(failures, kind).toHaveLength(1);
      expect(failures[0].kind).toBe('timeout');
      const measured = rows(out).find((row) => row.cell === cell);
      expect(measured).toMatchObject({ failed: true, timedOut: true, arm, complete: 0 });
      expect(measured.totalSeconds).toBeGreaterThan(100);
      expect(measured.totalSeconds).toBeLessThan(200);
      const others = (list) => stable(list.filter((row) => row.cell !== cell && !(arm === 'new' && row.cell === newCell)));
      expect(others(rows(out))).toEqual(others(rows(baseline)));
      expect(gateOf(out).details.timeouts).toEqual(arm === 'old' ? { old: 1, new: 0 } : { old: 0, new: 1 });
      expect(gateOf(out).details.missing).toEqual([]);
      expect(lines(ledgerOf(out))).toHaveLength(result.counts.calls);
    }
  }, SLOW);

  it('waits before rerunning a stalled pair, so the rerun is not inside the same outage', () => {
    const cases = casesFile(), holdouts = holdoutsFile();
    for (const [wait, env] of [[60_000, {}], [90_000, { TUTOR_RERUN_WAIT_MS: '90000' }]]) {
      const result = run(real(outDir(), cases, holdouts), { fake: { hangCalls: { old: [1] }, speed: 400 }, env });
      // The fake clock is compressed 400 times: these are the milliseconds of the real run. 120 s is the stalled call itself.
      expect(result.counts.times[1] - result.counts.times[0], String(wait)).toBeGreaterThanOrEqual(120_000 + wait - 15_000);
    }
  }, SLOW);

  it('never decides a run whose rerun wait was overridden, on resume too', () => {
    const out = outDir(), cases = casesFile(), holdouts = holdoutsFile();
    run(real(out, cases, holdouts), { env: { TUTOR_RERUN_WAIT_MS: '0' } });
    const gate = gateOf(out);
    expect(gate.pass).toBe(false);
    expect(gate.incomplete).toBe(true);
    expect(gate.details.reasons.join(' ')).toMatch(/TUTOR_RERUN_WAIT_MS/);
    // Resuming without the override is another configuration, not a way to launder the data.
    const again = run(real(out, cases, holdouts));
    expect(again.code).toBe(1);
    expect(again.stderr).toMatch(/mismatch/i);
    const plain = outDir();
    run(real(plain, cases, holdouts));
    expect(gateOf(plain).details.reasons.join(' ')).not.toMatch(/TUTOR_RERUN_WAIT_MS/);
  }, SLOW);

  it('measures a pair whose arms time out again on resume, and lets the later pairs of that model run', () => {
    const out = outDir(), cases = casesFile(), holdouts = holdoutsFile();
    const dead = 'nvidia/nemotron-3.5-lightning-30b-a3b';
    run(real(out, cases, holdouts), { fake: { hangModels: [dead], speed: 400 } });
    expect(rows(out).filter((row) => row.model === dead)).toHaveLength(0);
    const second = run(real(out, cases, holdouts), { fake: { hangModels: [dead], speed: 400 } });
    expect(second.code).toBe(2);
    const measured = rows(out).filter((row) => row.model === dead);
    // The three retried pairs are final now, then three later pairs get their first chance.
    expect(measured).toHaveLength(6);
    expect(measured.every((row) => row.timedOut && row.failed)).toBe(true);
    expect(rows(out, 'failures.jsonl').filter((item) => item.kind === 'both-timeout')).toHaveLength(6);
    expect(gateOf(out).details.reasons.join(' ')).toMatch(/lightning/);
  }, SLOW);

  it('does not store a pair where both arms time out, and moves past a dead model after three such pairs', () => {
    const out = outDir(), cases = casesFile(), holdouts = holdoutsFile();
    const dead = 'nvidia/nemotron-3.5-lightning-30b-a3b';
    const first = run(real(out, cases, holdouts), { fake: { hangModels: [dead], speed: 400 } });
    expect(first.code).toBe(2);
    const stored = rows(out);
    expect(stored).toHaveLength(32);
    expect(stored.some((row) => row.model === dead)).toBe(false);
    expect(new Set(stored.map((row) => row.model)).size).toBe(2);
    // Three pairs of wait at most: one discarded call, then the rerun of both arms.
    const waits = lines(ledgerOf(out)).map((line) => JSON.parse(line)).filter((entry) => entry.cell?.includes(dead));
    expect(waits.length).toBeLessThanOrEqual(9);
    expect(rows(out, 'failures.jsonl').map((item) => item.kind)).toEqual(['timeout', 'both-timeout', 'timeout', 'both-timeout', 'timeout', 'both-timeout']);
    const gate = gateOf(out);
    expect(gate.incomplete).toBe(true);
    expect(gate.details.missing).toHaveLength(16);
    expect(gate.details.reasons.join(' ')).toMatch(/lightning.*3 pairs in a row/);
    expect(gate.skippedModels).toEqual([dead]);
    expect(first.stdout).toMatch(/lightning.*skipped/);
    const others = () => lines(ledgerOf(out)).map((line) => JSON.parse(line)).filter((entry) => !entry.cell?.includes(dead)).length;
    const before = others();

    // A resume retries that model only.
    const second = run(real(out, cases, holdouts));
    expect(rows(out)).toHaveLength(48);
    expect(others()).toBe(before);
    expect(dataReasons(gateOf(out))).toEqual([]);
    expect(gateOf(out).skippedModels).toEqual([]);
    expect(second.counts.calls).toBeGreaterThan(0);
  }, SLOW);

  it('decides an old arm that always times out while the new arm answers', () => {
    const out = outDir();
    const result = run(real(out, casesFile(), holdoutsFile()), { fake: { hang: 'old', speed: 400 } });
    expect(rows(out)).toHaveLength(48);
    const oldRows = rows(out).filter((row) => row.arm === 'old');
    expect(oldRows.every((row) => row.failed && row.timedOut)).toBe(true);
    expect(rows(out).filter((row) => row.arm === 'new').some((row) => row.failed)).toBe(false);
    expect(rows(out, 'failures.jsonl').map((item) => item.kind)).toEqual(Array(24).fill('timeout'));
    const gate = gateOf(out);
    expect(dataReasons(gate)).toEqual([]);
    expect(gate.details.timeouts).toEqual({ old: 24, new: 0 });
    expect(gate.criteria.firstText).toBe(true);
    expect(gate.criteria.noMoreFailures).toBe(true);
    expect(result.code).toBe(2);
  }, SLOW);

  it('reruns a stalled pair at most once, also across a resume', () => {
    const out = outDir(), cases = casesFile(), holdouts = holdoutsFile();
    // The pair stalls, is discarded, and its rerun fails on infrastructure: it stays unmeasured.
    const first = run(real(out, cases, holdouts), { fake: { hangCalls: { old: [1] }, errorCalls: { old: [2, 3] }, speed: 400 } });
    expect(first.code).toBe(2);
    expect(rows(out, 'failures.jsonl').map((item) => item.kind)).toEqual(['timeout', 'http']);
    expect(rows(out)).toHaveLength(46);
    expect(gateOf(out).details.missing).toEqual([oldCell, newCell]);

    // On resume the same stall is the measurement: no second discard.
    const second = run(real(out, cases, holdouts), { fake: { hangCalls: { old: [1] }, speed: 400 } });
    expect(second.counts.old).toBe(1);
    expect(rows(out, 'failures.jsonl')).toHaveLength(2);
    expect(rows(out)).toHaveLength(48);
    expect(rows(out).find((row) => row.cell === oldCell)).toMatchObject({ failed: true, timedOut: true });
    expect(gateOf(out).details.timeouts.old).toBe(1);
    expect(dataReasons(gateOf(out))).toEqual([]);
    expect(lines(ledgerOf(out))).toHaveLength(first.counts.calls + second.counts.calls);
  }, SLOW);

  it('keeps a visual that runs out of its own deadline as a measurement', () => {
    const out = outDir();
    run(real(out, casesFile(), holdoutsFile()), { fake: { hang: 'visual', speed: 400 } });
    expect(existsSync(join(out, 'failures.jsonl'))).toBe(false);
    const timedOut = rows(out).filter((row) => row.kind === 'quality' && row.arm === 'new');
    expect(timedOut).toHaveLength(18);
    expect(timedOut.every((row) => row.complete === 0 && !row.failed && row.visualResults.every((visual) => !visual.ok && /timed out/.test(visual.errors[0])))).toBe(true);
    expect(timedOut.every((row) => row.totalSeconds >= 60 && row.totalSeconds < 119)).toBe(true);
    expect(dataReasons(gateOf(out))).toEqual([]);
  }, SLOW);

  it('runs cells one at a time, with at most two visuals together inside a cell', () => {
    const result = run(real(outDir(), casesFile(), holdoutsFile()), { fake: { latency: 5000 } });
    expect(result.counts.maxInFlight).toBe(2);
  }, SLOW);

  it('refuses a POST past the cap, counted across resumes and across --out directories', () => {
    const parent = workDir();
    writeFileSync(join(parent, 'posts.log'), '{"n":0}\n'.repeat(359));
    const out = outDir(parent);
    const result = run(real(out, casesFile(), holdoutsFile()));
    expect(result.code).toBe(2);
    expect(result.counts.calls).toBe(1);
    expect(lines(join(parent, 'posts.log'))).toHaveLength(360);
    expect(result.stdout + result.stderr).toMatch(/cap/i);
    const again = run(real(out, casesFile(), holdoutsFile()));
    expect(again.counts.calls).toBe(0);
  }, SLOW);

  it('refuses holdouts that another --out directory already used', () => {
    const parent = workDir(), cases = casesFile(), holdouts = holdoutsFile();
    run(real(outDir(parent), cases, holdouts), { fake: { oldMode: 'invalid' } });
    expect(lines(join(parent, 'runs.jsonl'))).toHaveLength(1);
    const second = run(real(outDir(parent), cases, holdouts));
    expect(second.code).toBe(1);
    expect(second.stderr).toMatch(/holdouts/i);
    expect(second.counts.calls).toBe(0);
    expect(lines(join(parent, 'runs.jsonl'))).toHaveLength(1);
  }, SLOW);

  it('recognises holdouts by their content, not by their bytes', () => {
    const parent = workDir(), cases = casesFile();
    const list = [holdoutCase('h1', 'HOLD un a'), holdoutCase('h2', 'HOLD un b')];
    run(real(outDir(parent), cases, jsonFile(list)), { fake: { oldMode: 'invalid' } });
    expect(lines(join(parent, 'runs.jsonl'))).toHaveLength(1);
    const variants = [
      `${JSON.stringify(list)} \n`,
      `${JSON.stringify(list, null, 4)}\n\n`,
      JSON.stringify(list.map((item) => Object.fromEntries(Object.entries(item).reverse()))),
    ];
    for (const text of variants) {
      const path = join(tmp, `variant-${counter++}.json`);
      writeFileSync(path, text.replaceAll('\n', '\r\n'));
      const result = run(real(outDir(parent), cases, path));
      expect(result.code, text).toBe(1);
      expect(result.stderr).toMatch(/holdouts/i);
      expect(result.counts.calls).toBe(0);
    }
    expect(lines(join(parent, 'runs.jsonl'))).toHaveLength(1);
  }, SLOW);

  it('refuses to start while another run holds a lock', () => {
    for (const where of ['out', 'parent']) {
      const parent = workDir(), out = outDir(parent);
      const lock = join(where === 'out' ? out : parent, 'run.lock');
      writeFileSync(lock, 'other');
      const result = run(real(out, casesFile(), holdoutsFile()));
      expect(result.code).toBe(1);
      expect(result.stderr).toMatch(/lock/i);
      expect(readFileSync(lock, 'utf8')).toBe('other');
      expect(result.counts.calls).toBe(0);
    }
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
      const parent = workDir(), out = outDir(parent);
      const result = run(real(out, casesFile(), holdoutsFile()), { fake });
      expect(result.code).toBe(2);
      expect(rows(out, 'failures.jsonl').length).toBeGreaterThan(0);
      expect(lines(join(out, 'failures.jsonl')).join('\n')).toContain('[key]');
      expect(result.stdout + result.stderr).not.toContain(KEY);
      expect(keyedFiles(parent)).toEqual([]);
    }
  }, SLOW);
});
