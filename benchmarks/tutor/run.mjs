// Compares the single-envelope pipeline with the two-step tutor pipeline on real hosted models.
// Synthetic text only. NVIDIA_API_KEY comes from the process environment and is never logged.
// Usage: node benchmarks/tutor/run.mjs --out <dir> [--holdouts <file>] [--dry-run]
import { appendFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import { createServer } from 'vite';

const argument = (name) => { const index = process.argv.indexOf(name); return index === -1 ? undefined : process.argv[index + 1]; };
const out = argument('--out');
if (!out) throw new Error('Pass --out with a directory outside Git.');
const dryRun = process.argv.includes('--dry-run');
const key = process.env.NVIDIA_API_KEY;
if (!key && !dryRun) throw new Error('NVIDIA_API_KEY is not set in this process.');

const MODELS = [
  { id: 'nvidia/nemotron-3.5-lightning-30b-a3b', chatTemplateKwargs: { enable_thinking: false } },
  { id: 'nvidia/nemotron-3.5-super-vl-120b-a12b', chatTemplateKwargs: { enable_thinking: false } },
  { id: 'mistralai/mistral-large-4-1t-a52b' },
];
const SAMPLES = 2, POST_CAP = 360, CONCURRENCY = 2, SPACING_MS = 1700, DEADLINE_MS = 120_000, WINDOW = 1_000_000, OUTPUT = 8192;

const server = await createServer({ configFile: false, appType: 'custom', root: process.cwd(), cacheDir: `${out}/vite-cache`, optimizeDeps: { noDiscovery: true, include: [] }, server: { middlewareMode: true, hmr: false, watch: null }, logLevel: 'error' });
const load = (path) => server.ssrLoadModule(path);
const [{ OpenAICompatibleProvider }, { buildChatContext, estimateContextTokens }, prompts, oldPipeline, newPipeline, briefs, { evaluateAnswer, requestedVisual, decideGate }] = await Promise.all([
  load('/src/lib/llm-provider.ts'), load('/src/lib/chat-context.ts'), load('/src/prompts/index.ts'), load('/src/lib/teaching-answer.ts'), load('/src/lib/teaching-generation.ts'), load('/src/lib/visual-brief.ts'), load('/benchmarks/tutor/evaluate.mjs'),
]);

await mkdir(out, { recursive: true });
const cases = JSON.parse(await readFile(new URL('./cases.json', import.meta.url), 'utf8'));
const holdoutsPath = argument('--holdouts');
const holdouts = holdoutsPath ? JSON.parse((await readFile(holdoutsPath, 'utf8')).replace(/^﻿/, '')) : [];
const quality = [...cases.quality, ...holdouts.map((item) => ({ ...item, split: 'holdout' }))];

let posts = 0, active = 0, nextStart = 0;
const waiting = [];
const release = () => { active--; waiting.shift()?.(); };
const countingFetch = (onPost) => async (url, init) => {
  if (posts >= POST_CAP) throw new Error('Benchmark request cap reached.');
  if (active >= CONCURRENCY) await new Promise((resolve) => waiting.push(resolve));
  active++;
  try {
    const delay = Math.max(0, nextStart - Date.now());
    nextStart = Math.max(nextStart, Date.now()) + SPACING_MS;
    if (delay) await new Promise((resolve) => setTimeout(resolve, delay));
    // Checked again after the waits: concurrent callers that passed the first check must not overshoot the cap.
    if (posts >= POST_CAP) throw new Error('Benchmark request cap reached.');
    posts++; onPost();
    return await fetch(url, { ...init, headers: { ...init.headers, authorization: `Bearer ${key}` } });
  } finally { release(); }
};
const providerFor = (model, onPost) => {
  const provider = new OpenAICompatibleProvider({ baseUrl: 'https://integrate.api.nvidia.com/v1', model: model.id, fetchImpl: countingFetch(onPost), timeoutMs: DEADLINE_MS, chatTemplateKwargs: model.chatTemplateKwargs });
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
    await newPipeline.runVisualJobs(provider, tutor.jobs.slice(0, briefs.MAX_AUTOMATIC_VISUALS), { deadlineMs: 60_000, onResult: (brief, result) => {
      visualResults.push({ id: brief.id, type: brief.type, attempts: result.attempts, ok: Boolean(result.visual), errors: result.errors });
      if (result.visual) content = briefs.replaceVisualFence(content, brief.id, briefs.visualFence(result.visual));
    } });
  }
  return { content, firstTextSeconds, totalSeconds: (performance.now() - started) / 1000, visualResults };
}

const resultsPath = `${out}/results.jsonl`;
const previous = await readFile(resultsPath, 'utf8').catch(() => '');
const results = previous.split('\n').filter(Boolean).map((line) => JSON.parse(line));
const done = new Set(results.map((item) => item.cell));

const tasks = [];
for (const model of MODELS) {
  for (const testCase of quality) {
    for (let sample = 0; sample < SAMPLES; sample++) {
      // Alternate the order of the arms to reduce position and cache effects.
      const order = (tasks.length + sample) % 2 ? ['new', 'old'] : ['old', 'new'];
      for (const arm of order) tasks.push({ kind: 'quality', model, testCase, arm, sample, cell: `quality/${model.id}/${testCase.id}/${arm}/${sample}` });
    }
  }
  for (const [group, prompts_] of Object.entries(cases.rate)) {
    prompts_.forEach((prompt, index) => { for (const arm of ['old', 'new']) tasks.push({ kind: 'rate', model, prompt, group, arm, cell: `rate/${model.id}/${group}/${index}/${arm}` }); });
  }
}
console.log(`${tasks.length} cells, ${tasks.filter((task) => !done.has(task.cell)).length} left, ${quality.length} quality cases`);
if (dryRun) { await server.close(); process.exit(0); }

async function runTask(task) {
  let taskPosts = 0;
  const provider = providerFor(task.model, () => { taskPosts++; });
  const prompt = task.kind === 'quality' ? task.testCase.prompt : task.prompt;
  const base = { cell: task.cell, kind: task.kind, model: task.model.id, arm: task.arm };
  try {
    const answer = task.arm === 'old' ? await runOld(provider, prompt) : await runNew(provider, prompt, task.kind === 'quality');
    await writeFile(`${out}/${task.cell.replaceAll('/', '--')}.md`, answer.content);
    if (task.kind === 'rate') return { ...base, group: task.group, requested: requestedVisual(answer.content), posts: taskPosts };
    const evaluation = evaluateAnswer(task.testCase, answer.content);
    return { ...base, case: task.testCase.id, split: task.testCase.split, required: evaluation.artefacts.length, complete: evaluation.artefacts.filter((item) => item.status === 'complete').length, numeric: evaluation.artefacts.filter((item) => item.status === 'numeric').length, artefacts: evaluation.artefacts, proseMissing: evaluation.prose.missing, firstTextSeconds: answer.firstTextSeconds, totalSeconds: answer.totalSeconds, visualResults: answer.visualResults, posts: taskPosts };
  } catch (error) {
    const message = error instanceof Error ? error.message.replace(key, '[key]') : 'failed';
    if (task.kind === 'rate') return { ...base, group: task.group, requested: false, error: message, posts: taskPosts };
    return { ...base, case: task.testCase.id, split: task.testCase.split, required: task.testCase.artefacts.length, complete: 0, numeric: 0, artefacts: [], proseMissing: [], firstTextSeconds: DEADLINE_MS / 1000, totalSeconds: DEADLINE_MS / 1000, error: message, posts: taskPosts };
  }
}

const queue = tasks.filter((task) => !done.has(task.cell));
await Promise.all(Array.from({ length: CONCURRENCY }, async () => {
  for (let task = queue.shift(); task; task = queue.shift()) {
    if (posts >= POST_CAP) return;
    const result = await runTask(task);
    results.push(result);
    await appendFile(resultsPath, `${JSON.stringify(result)}\n`);
    console.log(`${result.cell}: posts ${posts}${result.error ? ` (${result.error})` : ''}`);
  }
}));
const gate = decideGate(results);
await writeFile(`${out}/gate.json`, JSON.stringify({ ...gate, posts, cells: results.length, expected: tasks.length }, null, 2));
console.log(JSON.stringify(gate, null, 2));
await server.close();
