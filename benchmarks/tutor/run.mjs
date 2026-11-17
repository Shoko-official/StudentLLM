// The comparison gate of the tutor pipeline was decided at commit 8e3864f (numbers in docs/status.md). It compared the
// single-envelope pipeline (old arm) with the two-step tutor pipeline (new arm) on hosted models. The old pipeline no
// longer exists in this tree, so this script can no longer run a measurement and refuses to. Results from before the
// commit that removed it compared both arms and stay valid only for the commit recorded in their run.json: to repeat or
// extend one, check out that commit.
// What remains is the check of the case files, with no key and no request:
// node benchmarks/tutor/run.mjs --dry-run --out <dir> [--holdouts <file>] [--cases <file>]
// --out only holds the module cache of the check. --holdouts is an array of quality cases, or { quality, rate } where
// rate replaces the committed rate prompts. Exit codes: 0 the files are valid, 1 a refusal or an invalid file.
import { mkdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { createServer } from 'vite';

const argument = (name) => { const index = process.argv.indexOf(name); return index === -1 ? undefined : process.argv[index + 1]; };
const out = argument('--out');
const fail = (message, code = 1) => { console.error(message); process.exit(code); };
if (!process.argv.includes('--dry-run')) fail('The tutor benchmark no longer runs measurements: its gate was decided at commit 8e3864f and the old pipeline it compared against was removed. To repeat a run, check out the commit recorded in its run.json. To check case files, pass --dry-run.');
if (!out) fail('Pass --out with a directory outside Git.');
const text = (path) => readFileSync(path, 'utf8').replace(/^\uFEFF/, '').replace(/\r\n/g, '\n');

mkdirSync(out, { recursive: true });
const casesText = text(argument('--cases') ?? fileURLToPath(new URL('./cases.json', import.meta.url)));
const holdoutsPath = argument('--holdouts');
let cases, holdouts;
try { cases = JSON.parse(casesText); }
catch (error) { fail(`A cases or holdouts file is not valid JSON: ${error instanceof Error ? error.message : 'unreadable'}`); }
// No parser detail for the holdouts: it quotes the text, and the hidden rate questions must not reach a stream.
try { holdouts = holdoutsPath ? JSON.parse(text(holdoutsPath)) : []; }
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
const rateCases = objectForm && 'rate' in holdouts && !rateErrors.length ? holdouts.rate : cases.rate;
const quality = [...cases.quality, ...(Array.isArray(holdoutCases) ? holdoutCases : []).map((item) => ({ ...item, split: 'holdout' }))];
const rateTotal = Object.values(rateCases).reduce((sum, list) => sum + list.length, 0);

const server = await createServer({ configFile: false, appType: 'custom', root: process.cwd(), cacheDir: join(out, 'vite-cache'), optimizeDeps: { noDiscovery: true, include: [] }, server: { middlewareMode: true, hmr: false, watch: null }, logLevel: 'error' });
const { validateCases } = await server.ssrLoadModule('/benchmarks/tutor/evaluate.mjs');

// A key name could be a pasted question: report its position, never the name.
const topKeys = objectForm ? Object.keys(holdouts).flatMap((name, index) => (['quality', 'rate'].includes(name) ? [] : [`the holdouts object has an unknown key (position ${index + 1})`])) : [];
const problems = [...validateCases(cases.quality, { allowSplit: true }), ...validateCases(holdoutCases, { taken: cases.quality.map((item) => item.id) }), ...topKeys, ...rateErrors];
await server.close();
if (problems.length) fail(['The cases cannot be scored:', ...problems.map((problem) => `  ${problem}`)].join('\n'));
console.log(`${quality.length} quality cases, ${rateTotal} rate prompts`);
