// Compares the single-envelope pipeline with the two-step tutor pipeline on real hosted models.
// Synthetic text only. NVIDIA_API_KEY comes from the process environment and never reaches a file or a stream.
// Usage: node benchmarks/tutor/run.mjs --out <dir> [--holdouts <file>] [--dry-run]
// --holdouts is an array of quality cases, or { quality, rate } where rate replaces the committed rate prompts for this run.
// Test aids: --cases <file> replaces cases.json, --allow-dirty skips the clean tree check. Either one makes the
// result incomplete, never a decision.
// Exit codes: 0 a decision was reached (pass or fail), 1 a refusal or an error, 2 the data is incomplete.
// The request ledger (posts.log) and the run register (runs.jsonl) live in the parent of --out, so the budget and
// the no-rerun rule hold across --out directories.
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { appendFileSync, closeSync, existsSync, mkdirSync, openSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer } from 'vite';

const argument = (name) => { const index = process.argv.indexOf(name); return index === -1 ? undefined : process.argv[index + 1]; };
const out = argument('--out');
const dryRun = process.argv.includes('--dry-run');
const allowDirty = process.argv.includes('--allow-dirty');
const customCases = argument('--cases') !== undefined;
const key = process.env.NVIDIA_API_KEY;

// Everything that leaves this process (files and both standard streams) goes through one scrub.
const scrub = (value) => (key ? String(value).split(key).join('[key]') : String(value));
for (const stream of [process.stdout, process.stderr]) {
  const write = stream.write.bind(stream);
  stream.write = (chunk, ...rest) => write(typeof chunk === 'string' || Buffer.isBuffer(chunk) ? scrub(chunk) : chunk, ...rest);
}
const fail = (message, code = 1) => { console.error(message); process.exit(code); };
if (!out) fail('Pass --out with a directory outside Git.');
if (!key && !dryRun) fail('NVIDIA_API_KEY is not set in this process.');
const target = resolve(out);
const parent = dirname(target);
const ledgerPath = join(parent, 'posts.log');
const runsPath = join(parent, 'runs.jsonl');
const appendAt = (path, text) => appendFileSync(path, scrub(text));
const append = (name, text) => appendAt(join(out, name), text);
const save = (name, text) => writeFileSync(join(out, name), scrub(text));
const lineCount = (path) => (existsSync(path) ? readFileSync(path, 'utf8').split('\n').filter(Boolean).length : 0);
const sha256 = (value) => createHash('sha256').update(value).digest('hex');
const text = (path) => readFileSync(path, 'utf8').replace(/^\uFEFF/, '').replace(/\r\n/g, '\n');

function readRows(path) {
  if (!existsSync(path)) return [];
  const parts = readFileSync(path, 'utf8').split('\n');
  const name = relative(parent, path);
  return parts.flatMap((line, index) => {
    if (!line) return [];
    try { return [JSON.parse(line)]; }
    catch {
      if (index === parts.length - 1) fail(`${name} ends with a truncated line (a run was killed while writing). Delete that last line, and the other row of its pair if only one remains, then resume: the pair is rerun.`);
      return fail(`${name} line ${index + 1} is not valid JSON, so the file is damaged. Use a new --out.`);
    }
  });
}

const MODELS = [
  { id: 'nvidia/nemotron-3.5-lightning-30b-a3b', chatTemplateKwargs: { enable_thinking: false } },
  { id: 'nvidia/nemotron-3.5-super-vl-120b-a12b', chatTemplateKwargs: { enable_thinking: false } },
  { id: 'mistralai/mistral-large-4-1t-a52b' },
];
const SAMPLES = 2, POST_CAP = 360, SPACING_MS = 1700, DEADLINE_MS = 120_000, VISUAL_DEADLINE_MS = 120_000, WINDOW = 1_000_000, OUTPUT = 8192, MAX_CONSECUTIVE_FAILURES = 3;
// Wait before a stalled pair is rerun, so the rerun is not inside the same outage. The environment variable is a test aid.
const rerunWaitOverridden = Boolean(process.env.TUTOR_RERUN_WAIT_MS);
const RERUN_WAIT_MS = process.env.TUTOR_RERUN_WAIT_MS && Number.isFinite(Number(process.env.TUTOR_RERUN_WAIT_MS)) ? Number(process.env.TUTOR_RERUN_WAIT_MS) : 60_000;

mkdirSync(out, { recursive: true });
const casesText = text(argument('--cases') ?? fileURLToPath(new URL('./cases.json', import.meta.url)));
const holdoutsPath = argument('--holdouts');
const holdoutsText = holdoutsPath ? text(holdoutsPath) : '';
let cases, holdouts;
try { cases = JSON.parse(casesText); }
catch (error) { fail(`A cases or holdouts file is not valid JSON: ${error instanceof Error ? error.message : 'unreadable'}`); }
// No parser detail for the holdouts: it quotes the text, and the hidden rate questions must not reach a stream.
try { holdouts = holdoutsPath ? JSON.parse(holdoutsText) : []; }
catch { fail('A cases or holdouts file is not valid JSON (the holdouts file is not quoted: it may hold hidden questions).'); }
// The holdouts are an array of quality cases, or { quality, rate } where rate replaces cases.rate for this run.
const objectForm = Boolean(holdouts) && typeof holdouts === 'object' && !Array.isArray(holdouts);
const holdoutCases = objectForm ? holdouts.quality ?? [] : holdouts;
const promptKey = (value) => value.trim().replace(/\s+/g, ' ').toLowerCase();
// Positions only, never the questions: nothing here may print them.
function rateProblems(rate, committed) {
  if (!rate || typeof rate !== 'object' || Array.isArray(rate)) return ['rate must be an object with the groups of cases.rate'];
  const groups = Object.keys(committed), errors = [];
  for (const name of Object.keys(rate)) if (!groups.includes(name)) errors.push(`rate has an unknown group (${groups.join(', ')} expected)`);
  const known = new Set(Object.values(committed).flat().map(promptKey)), seen = new Set();
  for (const name of groups) {
    const list = rate[name];
    if (!Array.isArray(list) || list.length !== committed[name].length) { errors.push(`rate.${name} must be a list of ${committed[name].length} prompts`); continue; }
    list.forEach((prompt, index) => {
      const label = `rate.${name}[${index}]`;
      if (typeof prompt !== 'string' || !prompt.trim()) { errors.push(`${label} must be non-empty text`); return; }
      if (seen.has(promptKey(prompt))) errors.push(`${label} is a duplicate of another rate prompt`);
      else if (known.has(promptKey(prompt))) errors.push(`${label} equals a prompt of cases.rate`);
      seen.add(promptKey(prompt));
    });
  }
  return errors;
}
const rateErrors = objectForm && 'rate' in holdouts ? rateProblems(holdouts.rate, cases.rate) : [];
const hidden = objectForm && 'rate' in holdouts && !rateErrors.length;
const rateCases = hidden ? holdouts.rate : cases.rate;
const quality = [...cases.quality, ...(Array.isArray(holdoutCases) ? holdoutCases : []).map((item) => ({ ...item, split: 'holdout' }))];

// A pair is the old and the new arm of one prompt. Cells run one at a time; a pair is stored or discarded as a whole.
const pairs = [], expected = [];
const cellOf = (fields) => { expected.push(fields); return fields; };
for (const model of MODELS) {
  for (const testCase of quality) {
    for (let sample = 0; sample < SAMPLES; sample++) {
      const cell = (arm) => cellOf({ cell: `quality/${model.id}/${testCase.id}/${arm}/${sample}`, kind: 'quality', model: model.id, arm, case: testCase.id, split: testCase.split, sample });
      pairs.push({ model, testCase, prompt: testCase.prompt, cells: { old: cell('old'), new: cell('new') }, order: pairs.length % 2 ? ['new', 'old'] : ['old', 'new'] });
    }
  }
  for (const [group, prompts_] of Object.entries(rateCases)) {
    prompts_.forEach((prompt, index) => {
      const cell = (arm) => cellOf({ cell: `rate/${model.id}/${group}/${index}/${arm}`, kind: 'rate', model: model.id, arm, group, index });
      pairs.push({ model, prompt, cells: { old: cell('old'), new: cell('new') }, order: pairs.length % 2 ? ['new', 'old'] : ['old', 'new'] });
    });
  }
}
const stored = readRows(join(out, 'results.jsonl'));
const done = new Set(stored.map((item) => item.cell));
console.log(`${expected.length} cells, ${expected.filter((item) => !done.has(item.cell)).length} left, ${quality.length} quality cases`);

const git = (...args) => execFileSync('git', args, { cwd: process.cwd(), encoding: 'utf8' }).trim();
let commit = 'unknown', dirty = false;
if (!dryRun) {
  try { commit = git('rev-parse', 'HEAD'); dirty = git('status', '--porcelain') !== ''; }
  catch (error) { fail(`Cannot read the Git state of ${process.cwd()}: ${error instanceof Error ? error.message : 'failed'}`); }
  if (dirty && !allowDirty) fail('The working tree is dirty. Commit or stash first: a result must name the exact code that produced it.');
}

const server = await createServer({ configFile: false, appType: 'custom', root: process.cwd(), cacheDir: join(out, 'vite-cache'), optimizeDeps: { noDiscovery: true, include: [] }, server: { middlewareMode: true, hmr: false, watch: null }, logLevel: 'error' });
const load = (path) => server.ssrLoadModule(path);
const [{ OpenAICompatibleProvider }, { buildChatContext, estimateContextTokens }, prompts, oldPipeline, newPipeline, briefs, { scoreSafely, requestedVisual, decideGate, missingHoldouts, validateCases }] = await Promise.all([
  load('/src/lib/llm-provider.ts'), load('/src/lib/chat-context.ts'), load('/src/prompts/index.ts'), load('/src/lib/teaching-answer.ts'), load('/src/lib/teaching-generation.ts'), load('/src/lib/visual-brief.ts'), load('/benchmarks/tutor/evaluate.mjs'),
]);

// Nothing is sent before every case can be scored.
// A key name could be a pasted question: report its position, never the name.
const topKeys = objectForm ? Object.keys(holdouts).flatMap((name, index) => (['quality', 'rate'].includes(name) ? [] : [`the holdouts object has an unknown key (position ${index + 1})`])) : [];
const problems = [...validateCases(cases.quality, { allowSplit: true }), ...validateCases(holdoutCases, { taken: cases.quality.map((item) => item.id) }), ...topKeys, ...rateErrors];
if (problems.length) fail(['The cases cannot be scored, so nothing was sent:', ...problems.map((problem) => `  ${problem}`)].join('\n'));
if (dryRun) { await server.close(); process.exit(0); }

const invalidations = [];
if (allowDirty) invalidations.push('run with --allow-dirty: not a valid decision');
if (customCases) invalidations.push('run with --cases: not the committed cases');
if (rerunWaitOverridden) invalidations.push('run with TUTOR_RERUN_WAIT_MS: not the 60 s wait, not a valid decision');

if (missingHoldouts(expected)) {
  // gate.json says so as well, so a gate left in this directory by an earlier run cannot be read as the answer.
  const gate = decideGate(stored, expected, { invalidations });
  save('gate.json', JSON.stringify({ ...gate, dirty, allowDirty, customCases, hiddenRate: hidden, posts: lineCount(ledgerPath), cells: stored.length, expected: expected.length, pendingFailures: 0, stopped: null, skippedModels: [] }, null, 2));
  console.log(JSON.stringify({ pass: false, incomplete: true, reasons: ['no holdouts'] }));
  await server.close();
  process.exit(2);
}

const held = [];
process.on('exit', () => { for (const path of held) rmSync(path, { force: true }); });
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => process.exit(130));
for (const path of [join(out, 'run.lock'), join(parent, 'run.lock')]) {
  try { closeSync(openSync(path, 'wx')); held.push(path); }
  catch { fail(`Another run holds ${path}. Remove it only if no run is active.`); }
}

// Hashes of the parsed holdouts, keys sorted: a trailing space, a reformat or a key order cannot hide a reuse.
// holdoutsHash covers the quality cases only, in both file forms; the hidden rate questions have their own hash, order of a group ignored.
const canonical = (value) => JSON.stringify(value, (_, item) => (item && typeof item === 'object' && !Array.isArray(item) ? Object.fromEntries(Object.entries(item).sort(([a], [b]) => (a < b ? -1 : 1))) : item));
const holdoutsHash = sha256(canonical(holdoutCases));
const rateHash = hidden ? sha256(canonical(Object.fromEntries(Object.entries(holdouts.rate).map(([name, list]) => [name, [...list].sort()])))) : undefined;
const register = readRows(runsPath);
const earlier = register.find((item) => item.holdoutsHash === holdoutsHash && item.out !== target);
if (earlier) fail(`These holdouts were already used by ${earlier.out}. A second run on the same holdouts is not allowed: write new holdouts. If that run made no measurement at all, delete its line from ${runsPath}.`);
const earlierRate = rateHash && register.find((item) => item.rateHash === rateHash && item.out !== target);
if (earlierRate) fail(`These hidden rate questions were already used by ${earlierRate.out}. A second run on the same questions is not allowed: write new ones. If that run made no measurement at all, delete its line from ${runsPath}.`);

const filesIn = (dir) => readdirSync(dir, { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : 1)).flatMap((entry) => (entry.isDirectory() ? filesIn(join(dir, entry.name)) : [join(dir, entry.name)]));
const promptsDir = join(process.cwd(), 'src', 'prompts');
const meta = {
  commit, dirty, allowDirty, customCases, hiddenRate: hidden, rerunWaitOverridden,
  promptsHash: sha256(filesIn(promptsDir).map((file) => `${relative(promptsDir, file).replaceAll('\\', '/')}\0${text(file)}`).join('\0\0')),
  casesHash: sha256(`${casesText}\0${holdoutsText}`),
  models: MODELS, samples: SAMPLES, postCap: POST_CAP,
};
if (existsSync(join(out, 'run.json'))) {
  const previous = JSON.parse(readFileSync(join(out, 'run.json'), 'utf8'));
  const differing = Object.keys(meta).filter((name) => JSON.stringify(previous[name]) !== JSON.stringify(meta[name]));
  if (differing.length) fail(`This directory belongs to another run (mismatch in ${differing.join(', ')}). Use a new --out.`);
} else save('run.json', JSON.stringify(meta, null, 2));
if (!register.some((item) => item.out === target)) appendAt(runsPath, `${JSON.stringify({ at: new Date().toISOString(), out: target, commit, dirty, allowDirty, customCases, holdoutsHash, ...(rateHash ? { rateHash } : {}), casesHash: meta.casesHash })}\n`);

const expectedIds = new Set(expected.map((item) => item.cell));
const stale = stored.filter((item) => !expectedIds.has(item.cell));
if (stale.length) fail(`results.jsonl holds ${stale.length} stale rows that this run does not expect (first: ${stale[0].cell}). Use a new --out.`);
if (done.size !== stored.length) fail('results.jsonl holds a cell twice. Use a new --out.');
const partial = pairs.filter((pair) => done.has(pair.cells.old.cell) !== done.has(pair.cells.new.cell));
if (partial.length) fail(`results.jsonl holds half a pair (first: ${partial[0].cells.old.cell}). Delete that row, then resume: the pair is rerun.`);

let postCount = lineCount(ledgerPath), nextStart = 0;
let current = null;
const refuse = (events) => { events.push({ kind: 'cap' }); throw new Error('Benchmark request cap reached.'); };
const aborted = (error) => ['AbortError', 'TimeoutError'].includes(error?.name);
const countingFetch = async (url, init, events) => {
  if (postCount >= POST_CAP) refuse(events);
  const delay = Math.max(0, nextStart - Date.now());
  nextStart = Math.max(nextStart, Date.now()) + SPACING_MS;
  if (delay) await new Promise((resolve) => setTimeout(resolve, delay));
  // Checked again after the wait, with no await before the count: the cap holds across processes, resumes and directories.
  if (postCount >= POST_CAP) refuse(events);
  postCount++;
  appendAt(ledgerPath, `${JSON.stringify({ n: postCount, at: new Date().toISOString(), out: target, cell: current?.cell })}\n`);
  if (current) current.posts++;
  try {
    const response = await globalThis.fetch(url, { ...init, headers: { ...init.headers, authorization: `Bearer ${key}` } });
    if (!response.ok) { events.push({ kind: 'http', status: response.status }); return response; }
    // A 200 that is not a completion (a gateway page, an error body, a body cut off mid-read) is the provider's failure.
    try { events.push({ kind: Array.isArray(JSON.parse(await response.clone().text())?.choices) ? 'ok' : 'malformed' }); }
    catch (error) { events.push({ kind: error?.name === 'SyntaxError' ? 'malformed' : aborted(error) ? 'abort' : 'truncated' }); }
    return response;
  } catch (error) {
    events.push({ kind: aborted(error) ? 'abort' : 'network' });
    throw error;
  }
};
// One provider per call, so the events of a call that finally succeeded (after a retried 429 or 5xx) are dropped,
// and a call that failed keeps them: generateVisual swallows errors, the events are what the runner can still see.
const providerFor = (model) => ({
  supportsStructuredOutputs: true,
  async generate(messages, options) {
    const events = [];
    const provider = new OpenAICompatibleProvider({ baseUrl: 'https://integrate.api.nvidia.com/v1', model: model.id, fetchImpl: (url, init) => countingFetch(url, init, events), timeoutMs: DEADLINE_MS, chatTemplateKwargs: model.chatTemplateKwargs });
    try { return await provider.generate(messages, { ...options, signal: options?.signal ?? AbortSignal.timeout(DEADLINE_MS) }); }
    catch (error) {
      // A good completion as the last event means the failure is the model's (an empty answer), not the retried ones before it.
      if (events.at(-1)?.kind !== 'ok') current?.events.push(...events);
      throw error;
    }
  },
});
const context = (prompt, systemPrompt, schemaTokens) => buildChatContext({ documents: [], history: [], question: prompt, systemPrompt, contextWindowTokens: WINDOW, outputTokens: OUTPUT, schemaTokens });

async function runOld(provider, prompt) {
  const schema = estimateContextTokens(JSON.stringify(oldPipeline.teachingAnswerSchema)) + estimateContextTokens(prompts.STRUCTURED_TEACHING_CONTRACT) + 32;
  const { messages } = await context(prompt, `${prompts.CHAT_ASSISTANT_PROMPT}\n\n${prompts.TEACHING_VISUAL_PROMPT}`, schema);
  const started = performance.now();
  const { content } = await oldPipeline.generateTeachingAnswer(provider, messages, { maxTokens: OUTPUT });
  const seconds = (performance.now() - started) / 1000;
  return { content, firstTextSeconds: seconds, totalSeconds: seconds };
}

async function runNew(provider, prompt, withVisuals) {
  const { messages } = await context(prompt, prompts.TUTOR_SYSTEM_PROMPT, 0);
  const started = performance.now();
  const tutor = await newPipeline.generateTutorProse(provider, messages, { maxTokens: OUTPUT });
  const firstTextSeconds = (performance.now() - started) / 1000;
  let content = tutor.markdown;
  const visualResults = [];
  const jobs = tutor.jobs.slice(0, briefs.MAX_AUTOMATIC_VISUALS);
  let decision = { asked: false };
  if (tutor.needsDecision) {
    const decided = await newPipeline.decideVisual(provider, { question: prompt, answer: tutor.markdown }, { deadlineMs: VISUAL_DEADLINE_MS });
    decision = { asked: true, requested: decided.brief !== null, ...(decided.error === undefined ? {} : { error: decided.error }) };
    if (decided.brief) {
      const appended = briefs.appendVisualRequest(content, decided.brief);
      content = appended.markdown;
      if (appended.job) jobs.push(appended.job);
    }
  }
  if (withVisuals) {
    await newPipeline.runVisualJobs(provider, jobs, { deadlineMs: VISUAL_DEADLINE_MS, concurrency: 2, onResult: (brief, result) => {
      visualResults.push({ id: brief.id, type: brief.type, attempts: result.attempts, ok: Boolean(result.visual), errors: result.errors, unconfirmed: result.unconfirmed });
      if (result.visual) content = briefs.replaceVisualFence(content, brief.id, briefs.visualFence(result.visual));
    } });
  }
  return { content, firstTextSeconds, totalSeconds: (performance.now() - started) / 1000, visualResults, decision };
}

// Infrastructure failures are not measurements: an HTTP error that outlived the provider's retry, a network error, the
// cap, a reply that is not a completion. A call that runs out of its own time limit is a measurement: the learner would
// get an error there too.
const INFRASTRUCTURE = ['http', 'network', 'cap', 'malformed', 'truncated'];

async function runCell(pair, arm) {
  const info = pair.cells[arm];
  const slot = { cell: info.cell, events: [], posts: 0 };
  current = slot;
  const started = performance.now();
  let answer, error;
  try { answer = arm === 'old' ? await runOld(providerFor(pair.model), pair.prompt) : await runNew(providerFor(pair.model), pair.prompt, info.kind === 'quality'); }
  catch (caught) { error = caught; }
  current = null;
  const elapsed = (performance.now() - started) / 1000;
  const message = error instanceof Error ? error.message : error === undefined ? undefined : 'failed';
  const visualResults = answer?.visualResults ?? [];
  const kinds = slot.events.map((event) => event.kind);
  const timedOut = Boolean(error) && kinds.includes('abort');
  if (kinds.some((kind) => INFRASTRUCTURE.includes(kind)) || (error && !timedOut && !/^The model returned /.test(message))) {
    return { infra: { cell: info.cell, kind: kinds.find((kind) => INFRASTRUCTURE.includes(kind)) ?? 'error', events: slot.events, error: message, visualResults } };
  }
  const base = { cell: info.cell, kind: info.kind, model: info.model, arm, posts: slot.posts };
  const failure = error ? { failed: true, timedOut, error: message } : {};
  if (info.kind === 'rate') {
    let requested = false, unscored;
    if (!error) { try { requested = requestedVisual(answer.content); } catch (caught) { unscored = caught instanceof Error ? caught.message : 'scoring failed'; } }
    return { row: { ...base, group: info.group, index: info.index, requested, ...(answer?.decision ? { decision: answer.decision } : {}), ...failure, ...(unscored === undefined ? {} : { unscored: true, scoringError: unscored }) }, content: answer?.content };
  }
  const identity = { case: info.case, split: info.split, sample: info.sample, required: pair.testCase.artefacts.length };
  if (error) return { row: { ...base, ...identity, complete: 0, numeric: 0, artefacts: [], proseMissing: [], firstTextSeconds: elapsed, totalSeconds: elapsed, visualResults, contentHash: null, ...failure } };
  const scored = scoreSafely(pair.testCase, answer.content);
  const timing = { firstTextSeconds: answer.firstTextSeconds, totalSeconds: answer.totalSeconds, visualResults, ...(answer.decision ? { decision: answer.decision } : {}), contentHash: sha256(answer.content) };
  if (scored.error !== undefined) return { row: { ...base, ...identity, complete: 0, numeric: 0, artefacts: [], proseMissing: [], ...timing, unscored: true, scoringError: scored.error }, content: answer.content };
  const { evaluation } = scored;
  return { row: { ...base, ...identity, required: evaluation.artefacts.length, complete: evaluation.artefacts.filter((item) => item.status === 'complete').length, numeric: evaluation.artefacts.filter((item) => item.status === 'numeric').length, artefacts: evaluation.artefacts, proseMissing: evaluation.prose.missing, ...timing }, content: answer.content };
}

const results = [...stored];
const failedInARow = new Map(), skipped = new Map();
let stopped = null;
// A pair whose 120 s stall was already discarded (kept in failures.jsonl, so it also holds across a resume) is rerun no more.
const stalled = new Set(readRows(join(out, 'failures.jsonl')).filter((item) => item.kind === 'timeout').flatMap((item) => item.cells));
const retriedBothStalled = new Set(readRows(join(out, 'failures.jsonl')).filter((item) => item.kind === 'both-timeout').flatMap((item) => item.cells));

// An attempt stops at the first cell that is not a measurement. A stall counts as one only when the pair was already rerun.
async function attempt(pair, mayDiscard) {
  const outcomes = [];
  for (const arm of pair.order) {
    const outcome = await runCell(pair, arm);
    outcomes.push(outcome);
    if (outcome.infra || (mayDiscard && outcome.row?.timedOut)) break;
  }
  return outcomes;
}

for (const pair of pairs.filter((item) => !done.has(item.cells.old.cell))) {
  const model = pair.model.id;
  if (skipped.has(model)) continue;
  const cells = [pair.cells.old.cell, pair.cells.new.cell];
  let outcomes = await attempt(pair, !stalled.has(cells[0]));
  const stall = outcomes.find((item) => item.row?.timedOut && !stalled.has(cells[0]));
  if (stall) {
    // One stalled call (a 120 s timeout, either arm) must not decide the gate: discard the pair, once, wait, and rerun it.
    // The rerun is final: a timeout there is the model's, saved as a failed row with its real elapsed time.
    append('failures.jsonl', `${JSON.stringify({ at: new Date().toISOString(), cells, kind: 'timeout', cell: stall.row.cell, error: stall.row.error })}\n`);
    stalled.add(cells[0]);
    console.log(`${stall.row.cell}: hit the 120 s limit, the pair is discarded and rerun once after ${RERUN_WAIT_MS / 1000} s`);
    await new Promise((resolve) => setTimeout(resolve, RERUN_WAIT_MS));
    outcomes = await attempt(pair, false);
  }
  const failure = outcomes.find((item) => item.infra)?.infra;
  // Both arms timing out compares nothing: the endpoint may be down, so the pair gets one more run on resume.
  // After that it is a measurement, or a prompt too slow for both arms could never be decided.
  const bothStalled = !failure && !retriedBothStalled.has(cells[0]) && outcomes.length === 2 && outcomes.every((item) => item.row?.timedOut);
  if (failure || bothStalled) {
    if (failure) {
      append('failures.jsonl', `${JSON.stringify({ at: new Date().toISOString(), cells, ...failure })}\n`);
      console.log(`${failure.cell}: not a measurement (${failure.kind}), the pair will be rerun on resume`);
    } else {
      append('failures.jsonl', `${JSON.stringify({ at: new Date().toISOString(), cells, kind: 'both-timeout', error: outcomes[0].row.error })}\n`);
      console.log(`${cells[0]}: both arms hit the 120 s limit, nothing is stored, the pair will be rerun on resume`);
    }
    if (failure?.kind === 'cap') { stopped = 'the request cap was reached'; break; }
    failedInARow.set(model, (failedInARow.get(model) ?? 0) + 1);
    if (failedInARow.get(model) >= MAX_CONSECUTIVE_FAILURES) {
      skipped.set(model, `${model} skipped: ${MAX_CONSECUTIVE_FAILURES} pairs in a row failed before any measurement (a resume retries it)`);
      console.log(skipped.get(model));
    }
    continue;
  }
  failedInARow.set(model, 0);
  for (const outcome of outcomes) if (outcome.content !== undefined) save(`${outcome.row.cell.replaceAll('/', '--')}.md`, outcome.content);
  append('results.jsonl', outcomes.map((outcome) => `${JSON.stringify(outcome.row)}\n`).join(''));
  results.push(...outcomes.map((outcome) => outcome.row));
  console.log(`${pair.cells.old.cell}: posts ${postCount}${outcomes.some((outcome) => outcome.row.failed) ? ' (model output failure recorded)' : ''}`);
}

const gate = decideGate(results, expected, { invalidations: [...invalidations, ...skipped.values()] });
const pending = readRows(join(out, 'failures.jsonl')).filter((item) => item.cells.some((cell) => !results.some((row) => row.cell === cell))).length;
save('gate.json', JSON.stringify({ ...gate, dirty, allowDirty, customCases, hiddenRate: hidden, posts: postCount, cells: results.length, expected: expected.length, pendingFailures: pending, stopped, skippedModels: [...skipped.keys()] }, null, 2));
console.log(JSON.stringify(gate, null, 2));
if (stopped) console.log(`Stopped early: ${stopped}.`);
if (gate.incomplete) console.log(`INCOMPLETE, no decision: ${gate.details.reasons.join('; ')}. Missing cells: ${gate.details.missing.slice(0, 10).join(', ') || 'none'}${gate.details.missing.length > 10 ? ' ...' : ''}.`);
await server.close();
process.exit(gate.incomplete ? 2 : 0);
