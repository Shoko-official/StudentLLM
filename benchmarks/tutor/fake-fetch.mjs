// Test double for run.test.mjs, loaded with node --import. It replaces the global fetch with a local fake and
// compresses time, so a whole run takes seconds. Any host other than the benchmark's own endpoint throws.
// Configuration comes from TUTOR_FAKE (JSON: speed, onlyRequest (the tutor replies with one request and no text), decide (the decision call asks for a quiz instead of declining), latency, first503, oldMode, echoKey, echoVisual, hang, hangModels (model ids whose every call hangs), errorModels (model ids whose every call answers 503), hangCalls and errorCalls ({ old | prose | visual | decision: [1-based call numbers of that kind] } that hang for ever or answer 503), badBody {kind, mode: html | error | truncate}, recordOld (a file that receives each old arm request body, one per line)); TUTOR_FAKE_STATS names a file that receives the call counts at exit.
import { appendFileSync } from 'node:fs';

const config = JSON.parse(process.env.TUTOR_FAKE ?? '{}');
const SPEED = config.speed ?? 100;
const realNow = Date.now.bind(Date), realPerf = performance.now.bind(performance);
const realTimeout = globalThis.setTimeout.bind(globalThis), realSignalTimeout = AbortSignal.timeout.bind(AbortSignal);
const t0 = realNow(), p0 = realPerf();
Date.now = () => t0 + (realNow() - t0) * SPEED;
performance.now = () => p0 + (realPerf() - p0) * SPEED;
// Vite's module runner gives each transform 60 s, which is real work and not run time: compressed, a slow load times out.
globalThis.setTimeout = (fn, ms, ...rest) => realTimeout(fn, new Error().stack?.includes('module-runner') ? ms : (ms ?? 0) / SPEED, ...rest);
AbortSignal.timeout = (ms) => realSignalTimeout(ms / SPEED);

const request = (id, type, content) => '```student-visual-request\n' + JSON.stringify({ id, type, intent: 'intent', content }) + '\n```';
const quiz = { type: 'quiz', title: 'Q', question: 'Q?', options: ['8 V', '4 V'], answer: 0, explanation: 'E' };
const diagram = { type: 'diagram', title: 'D', nodes: [{ id: 'a', label: 'A' }], edges: [] };
const counts = { calls: 0, old: 0, prose: 0, visual: 0, decision: 0, reminders: { old: 0, prose: 0, visual: 0, decision: 0 }, maxInFlight: 0, times: [] };
const isReminder = (message) => message.content.startsWith('Note from StudentLLM');
let inFlight = 0;

const sleep = (ms, signal) => new Promise((resolve, reject) => {
  const abort = () => reject(new DOMException('This operation was aborted', 'AbortError'));
  if (signal?.aborted) return abort();
  const timer = setTimeout(resolve, ms);
  signal?.addEventListener('abort', () => { clearTimeout(timer); abort(); }, { once: true });
});
const json = (status, body) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
const answer = (content, model) => json(200, { model, choices: [{ message: { content } }] });
const failure = (status, message) => json(status, { error: { message } });
const badResponse = (mode) => {
  if (mode === 'html') return new Response('<html>gateway</html>', { status: 200, headers: { 'content-type': 'text/html' } });
  if (mode === 'error') return json(200, { error: { message: 'overloaded' } });
  const stream = new ReadableStream({ start(controller) { controller.enqueue(new TextEncoder().encode('{"choices":[')); controller.error(new TypeError('terminated')); } });
  return new Response(stream, { status: 200, headers: { 'content-type': 'application/json' } });
};

globalThis.fetch = async (url, init) => {
  if (!String(url).startsWith('https://integrate.api.nvidia.com/')) throw new Error('The fake fetch only serves the benchmark endpoint.');
  const authorization = init.headers.authorization;
  if (authorization !== `Bearer ${process.env.NVIDIA_API_KEY}`) throw new Error('The request did not carry the process key.');
  counts.calls++;
  counts.times.push(Date.now());
  const body = JSON.parse(init.body);
  const format = body.response_format?.json_schema?.name;
  const kind = format === 'teaching_answer' ? 'old' : format === 'teaching_visual_decision' ? 'decision' : format ? 'visual' : 'prose';
  counts[kind]++;
  if (config.recordOld && kind === 'old') appendFileSync(config.recordOld, `${init.body}
`);
  if (body.messages.some(isReminder)) counts.reminders[kind]++;
  if (config.echoKey || (config.echoVisual && kind === 'visual')) return failure(401, `rejected ${authorization} and again ${authorization}`);
  if (counts.calls <= (config.first503 ?? 0) || config.errorModels?.includes(body.model) || config.errorCalls?.[kind]?.includes(counts[kind])) return failure(503, 'busy');
  inFlight++;
  counts.maxInFlight = Math.max(counts.maxInFlight, inFlight);
  try {
    await sleep(config.hang === kind || config.hangModels?.includes(body.model) || config.hangCalls?.[kind]?.includes(counts[kind]) ? 1e9 : (config.latency ?? 100), init.signal);
    if (config.badBody?.kind === kind) return badResponse(config.badBody.mode);
    // Only the tutor call ends with a length reminder from StudentLLM; the question is the message before it.
    const user = (kind === 'prose' ? body.messages.findLast((message) => !isReminder(message)) : body.messages.at(-1)).content;
    if (kind === 'old') {
      if (config.oldMode === 'invalid') return answer('not json', body.model);
      return answer(JSON.stringify({ sections: [{ markdown: 'Texte', visual: /QCASE|HOLD/.test(user) ? quiz : null }] }), body.model);
    }
    if (kind === 'prose') {
      if (config.onlyRequest) return answer(request('v1', 'quiz', 'quiz'), body.model);
      if (/QCASE|HOLD/.test(user)) return answer(`Prose.\n\n${request('v1', 'quiz', 'quiz')}\n\nSuite.\n\n${request('v2', 'quiz', 'quiz')}`, body.model);
      return answer(/DEF/.test(user) ? 'Une definition.' : `Une explication.\n\n${request('v1', 'quiz', 'quiz')}`, body.model);
    }
    // A targeted decision may only name its type, so the fake answers with the one its schema allows.
    if (kind === 'decision') return answer(JSON.stringify(config.decide ? { visual: true, type: body.response_format.json_schema.schema.properties.type.enum.at(-1), intent: 'intent', content: 'quiz' } : { visual: false }), body.model);
    return answer(JSON.stringify(format === 'teaching_diagram' ? diagram : quiz), body.model);
  } finally { inFlight--; }
};

process.on('exit', () => { if (process.env.TUTOR_FAKE_STATS) appendFileSync(process.env.TUTOR_FAKE_STATS, JSON.stringify(counts) + '\n'); });
