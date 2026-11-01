// Compares the single-envelope pipeline with the two-step tutor pipeline on real hosted models.
// Synthetic text only. NVIDIA_API_KEY comes from the process environment and never reaches a file or a stream.
// Usage: node benchmarks/tutor/run.mjs --out <dir> [--holdouts <file>] [--dry-run]
// Test aids: --cases <file> replaces cases.json, --allow-dirty skips the clean tree check (recorded in run.json).
// Exit codes: 0 a decision was reached (pass or fail), 1 a refusal or an error, 2 the data is incomplete.
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { appendFileSync, closeSync, existsSync, mkdirSync, openSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer } from 'vite';

const argument = (name) => { const index = process.argv.indexOf(name); return index === -1 ? undefined : process.argv[index + 1]; };
const out = argument('--out');
const dryRun = process.argv.includes('--dry-run');
const allowDirty = process.argv.includes('--allow-dirty');
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
const append = (name, text) => appendFileSync(join(out, name), scrub(text));
const save = (name, text) => writeFileSync(join(out, name), scrub(text));
const lineCount = (name) => (existsSync(join(out, name)) ? readFileSync(join(out, name), 'utf8').split('\n').filter(Boolean).length : 0);
const readRows = (name) => (existsSync(join(out, name)) ? readFileSync(join(out, name), 'utf8').split('\n').filter(Boolean).map((line) => JSON.parse(line)) : []);
const sha256 = (text) => createHash('sha256').update(text).digest('hex');
const text = (path) => readFileSync(path, 'utf8').replace(/^\uFEFF/, '').replace(/\r\n/g, '\n');

const MODELS = [
  { id: 'nvidia/nemotron-3.5-lightning-30b-a3b', chatTemplateKwargs: { enable_thinking: false } },
  { id: 'nvidia/nemotron-3.5-super-vl-120b-a12b', chatTemplateKwargs: { enable_thinking: false } },
  { id: 'mistralai/mistral-large-4-1t-a52b' },
];
const SAMPLES = 2, POST_CAP = 360, SPACING_MS = 1700, DEADLINE_MS = 120_000, VISUAL_DEADLINE_MS = 60_000, WINDOW = 1_000_000, OUTPUT = 8192, MAX_CONSECUTIVE_FAILURES = 3;

mkdirSync(out, { recursive: true });
const casesText = text(argument('--cases') ?? fileURLToPath(new URL('./cases.json', import.meta.url)));
const cases = JSON.parse(casesText);
const holdoutsPath = argument('--holdouts');
const holdoutsText = holdoutsPath ? text(holdoutsPath) : '';
const holdouts = holdoutsPath ? JSON.parse(holdoutsText) : [];
const quality = [...cases.quality, ...holdouts.map((item) => ({ ...item, split: 'holdout' }))];

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
  for (const [group, prompts_] of Object.entries(cases.rate)) {
    prompts_.forEach((prompt, index) => {
      const cell = (arm) => cellOf({ cell: `rate/${model.id}/${group}/${index}/${arm}`, kind: 'rate', model: model.id, arm, group, index });
      pairs.push({ model, prompt, cells: { old: cell('old'), new: cell('new') }, order: pairs.length % 2 ? ['new', 'old'] : ['old', 'new'] });
    });
  }
}
const stored = readRows('results.jsonl');
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
const [{ OpenAICompatibleProvider }, { buildChatContext, estimateContextTokens }, prompts, oldPipeline, newPipeline, briefs, { evaluateAnswer, requestedVisual, decideGate, missingHoldouts }] = await Promise.all([
  load('/src/lib/llm-provider.ts'), load('/src/lib/chat-context.ts'), load('/src/prompts/index.ts'), load('/src/lib/teaching-answer.ts'), load('/src/lib/teaching-generation.ts'), load('/src/lib/visual-brief.ts'), load('/benchmarks/tutor/evaluate.mjs'),
]);
if (dryRun) { await server.close(); process.exit(0); }

if (missingHoldouts(expected)) {
  console.log(JSON.stringify({ pass: false, incomplete: true, reasons: ['no holdouts'] }));
  await server.close();
  process.exit(2);
}

const lockPath = join(out, 'run.lock');
try { closeSync(openSync(lockPath, 'wx')); }
catch { fail(`Another run holds ${lockPath}. Remove it only if no run is active.`); }
process.on('exit', () => rmSync(lockPath, { force: true }));
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => process.exit(130));

const filesIn = (dir) => readdirSync(dir, { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : 1)).flatMap((entry) => (entry.isDirectory() ? filesIn(join(dir, entry.name)) : [join(dir, entry.name)]));
const promptsDir = join(process.cwd(), 'src', 'prompts');
const meta = {
  commit, dirty,
  promptsHash: sha256(filesIn(promptsDir).map((file) => `${relative(promptsDir, file).replaceAll('\\', '/')}\0${text(file)}`).join('\0\0')),
  casesHash: sha256(`${casesText}\0${holdoutsText}`),
  models: MODELS, samples: SAMPLES, postCap: POST_CAP,
};
if (existsSync(join(out, 'run.json'))) {
  const previous = JSON.parse(readFileSync(join(out, 'run.json'), 'utf8'));
  const differing = Object.keys(meta).filter((name) => JSON.stringify(previous[name]) !== JSON.stringify(meta[name]));
  if (differing.length) fail(`This directory belongs to another run (mismatch in ${differing.join(', ')}). Use a new --out.`);
} else save('run.json', JSON.stringify(meta, null, 2));

const expectedIds = new Set(expected.map((item) => item.cell));
const stale = stored.filter((item) => !expectedIds.has(item.cell));
if (stale.length) fail(`results.jsonl holds ${stale.length} stale rows that this run does not expect (first: ${stale[0].cell}). Use a new --out.`);
if (done.size !== stored.length) fail('results.jsonl holds a cell twice. Use a new --out.');
const partial = pairs.filter((pair) => done.has(pair.cells.old.cell) !== done.has(pair.cells.new.cell));
if (partial.length) fail(`results.jsonl holds half a pair (first: ${partial[0].cells.old.cell}). Use a new --out.`);

let postCount = lineCount('posts.log'), nextStart = 0;
let current = null;
const refuse = () => { current?.events.push({ kind: 'cap' }); throw new Error('Benchmark request cap reached.'); };
const countingFetch = async (url, init) => {
  const slot = current;
  if (postCount >= POST_CAP) refuse();
  const delay = Math.max(0, nextStart - Date.now());
  nextStart = Math.max(nextStart, Date.now()) + SPACING_MS;
  if (delay) await new Promise((resolve) => setTimeout(resolve, delay));
  // Checked again after the wait, with no await before the count: the cap holds across processes and resumes.
  if (postCount >= POST_CAP) refuse();
  postCount++;
  append('posts.log', `${JSON.stringify({ n: postCount, at: new Date().toISOString(), cell: slot?.cell })}\n`);
  if (slot) slot.posts++;
  try {
    const response = await globalThis.fetch(url, { ...init, headers: { ...init.headers, authorization: `Bearer ${key}` } });
    if (!response.ok) slot?.events.push({ kind: 'http', status: response.status });
    return response;
  } catch (error) {
    slot?.events.push({ kind: ['AbortError', 'TimeoutError'].includes(error?.name) ? 'abort' : 'network', phase: slot.phase });
    throw error;
  }
};
const providerFor = (model) => {
  const provider = new OpenAICompatibleProvider({ baseUrl: 'https://integrate.api.nvidia.com/v1', model: model.id, fetchImpl: countingFetch, timeoutMs: DEADLINE_MS, chatTemplateKwargs: model.chatTemplateKwargs });
  return { supportsStructuredOutputs: true, generate: (messages, options) => provider.generate(messages, { ...options, signal: options?.signal ?? AbortSignal.timeout(DEADLINE_MS) }) };
};
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
  if (withVisuals) {
    current.phase = 'visual';
    await newPipeline.runVisualJobs(provider, tutor.jobs.slice(0, briefs.MAX_AUTOMATIC_VISUALS), { deadlineMs: VISUAL_DEADLINE_MS, concurrency: 2, onResult: (brief, result) => {
      visualResults.push({ id: brief.id, type: brief.type, attempts: result.attempts, ok: Boolean(result.visual), errors: result.errors });
      if (result.visual) content = briefs.replaceVisualFence(content, brief.id, briefs.visualFence(result.visual));
    } });
  }
  return { content, firstTextSeconds, totalSeconds: (performance.now() - started) / 1000, visualResults };
}

// Infrastructure failures are not measurements: any HTTP error, network error, the cap, or a timeout of the
// prose or old call. A visual that runs out of its own deadline is the model's failure and stays a measurement.
const infrastructure = (events) => events.some((event) => event.kind !== 'abort' || event.phase === 'main');

async function runCell(pair, arm) {
  const info = pair.cells[arm];
  const slot = { cell: info.cell, events: [], posts: 0, phase: 'main' };
  current = slot;
  const started = performance.now();
  let answer, error;
  try { answer = arm === 'old' ? await runOld(providerFor(pair.model), pair.prompt) : await runNew(providerFor(pair.model), pair.prompt, info.kind === 'quality'); }
  catch (caught) { error = caught; }
  current = null;
  const elapsed = (performance.now() - started) / 1000;
  const message = error instanceof Error ? error.message : error === undefined ? undefined : 'failed';
  const visualResults = answer?.visualResults ?? [];
  if (infrastructure(slot.events) || (error && !/^The model returned /.test(message))) {
    return { infra: { cell: info.cell, kind: slot.events[0]?.kind ?? 'error', events: slot.events, error: message, visualResults } };
  }
  const base = { cell: info.cell, kind: info.kind, model: info.model, arm, posts: slot.posts };
  if (info.kind === 'rate') {
    const row = error ? { ...base, index: info.index, group: info.group, requested: false, failed: true, error: message }
      : { ...base, group: info.group, index: info.index, requested: requestedVisual(answer.content) };
    return { row, content: answer?.content };
  }
  const identity = { case: info.case, split: info.split, sample: info.sample, required: pair.testCase.artefacts.length };
  if (error) return { row: { ...base, ...identity, complete: 0, numeric: 0, artefacts: [], proseMissing: [], firstTextSeconds: elapsed, totalSeconds: elapsed, visualResults, contentHash: null, failed: true, error: message } };
  const evaluation = evaluateAnswer(pair.testCase, answer.content);
  return { row: { ...base, ...identity, required: evaluation.artefacts.length, complete: evaluation.artefacts.filter((item) => item.status === 'complete').length, numeric: evaluation.artefacts.filter((item) => item.status === 'numeric').length, artefacts: evaluation.artefacts, proseMissing: evaluation.prose.missing, firstTextSeconds: answer.firstTextSeconds, totalSeconds: answer.totalSeconds, visualResults, contentHash: sha256(answer.content) }, content: answer.content };
}

const results = [...stored];
let consecutive = 0, stopped = null;
for (const pair of pairs.filter((item) => !done.has(item.cells.old.cell))) {
  const outcomes = [];
  for (const arm of pair.order) {
    const outcome = await runCell(pair, arm);
    outcomes.push(outcome);
    if (outcome.infra) break;
  }
  const failure = outcomes.find((item) => item.infra)?.infra;
  if (failure) {
    append('failures.jsonl', `${JSON.stringify({ at: new Date().toISOString(), cells: [pair.cells.old.cell, pair.cells.new.cell], ...failure })}\n`);
    console.log(`${failure.cell}: not a measurement (${failure.kind}), the pair will be rerun on resume`);
    consecutive++;
    if (failure.kind === 'cap') { stopped = 'the request cap was reached'; break; }
    if (consecutive >= MAX_CONSECUTIVE_FAILURES) { stopped = `${MAX_CONSECUTIVE_FAILURES} pairs in a row failed before any measurement`; break; }
    continue;
  }
  consecutive = 0;
  for (const outcome of outcomes) if (outcome.content !== undefined) save(`${outcome.row.cell.replaceAll('/', '--')}.md`, outcome.content);
  append('results.jsonl', outcomes.map((outcome) => `${JSON.stringify(outcome.row)}\n`).join(''));
  results.push(...outcomes.map((outcome) => outcome.row));
  console.log(`${pair.cells.old.cell}: posts ${postCount}${outcomes.some((outcome) => outcome.row.failed) ? ' (model output failure recorded)' : ''}`);
}

const gate = decideGate(results, expected);
const pending = readRows('failures.jsonl').filter((item) => item.cells.some((cell) => !results.some((row) => row.cell === cell))).length;
save('gate.json', JSON.stringify({ ...gate, posts: postCount, cells: results.length, expected: expected.length, pendingFailures: pending, stopped }, null, 2));
console.log(JSON.stringify(gate, null, 2));
if (stopped) console.log(`Stopped early: ${stopped}.`);
if (gate.incomplete) console.log(`INCOMPLETE, no decision: ${gate.details.reasons.join('; ')}. Missing cells: ${gate.details.missing.slice(0, 10).join(', ') || 'none'}${gate.details.missing.length > 10 ? ' ...' : ''}.`);
await server.close();
process.exit(gate.incomplete ? 2 : 0);
