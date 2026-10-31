import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { runSmoke, testProvider } from './provider-smoke.mjs';

const DEFAULT_MODEL = 'nvidia/nemotron-3.5-lightning-30b-a3b';
const NVIDIA_BASE = 'https://nvidia.example/v1';
const logger = { log() {}, error() {} };

function fakeProvider({ models = [DEFAULT_MODEL], message = { content: 'OK' }, catalogStatus = 200, completionStatus = 200 } = {}) {
  const calls = [];
  const fetchImpl = async (url, options = {}) => {
    calls.push({ url, ...options, body: options.body ? JSON.parse(options.body) : undefined });
    const status = url.endsWith('/models') ? catalogStatus : completionStatus;
    return {
      ok: status === 200,
      status,
      json: async () => url.endsWith('/models')
        ? { data: models.map((id) => ({ id })), error: { message: 'synthetic private auth detail' } }
        : { choices: [{ message }] },
    };
  };
  return { calls, fetchImpl };
}

const nvidiaOptions = (overrides = {}) => ({
  name: 'NVIDIA', baseUrl: NVIDIA_BASE, headers: {}, requestedModel: DEFAULT_MODEL,
  preferredPatterns: [/other/], prompt: 'Reply with OK.', ...overrides,
});

test('a catalog entry does not establish readiness when its completion is retired', async () => {
  const fake = fakeProvider({ completionStatus: 410 });
  await assert.rejects(testProvider(nvidiaOptions(), fake), /HTTP 410/);
  assert.equal(fake.calls.length, 2);
});

test('NVIDIA transport failures do not expose raw request or auth details', async () => {
  await assert.rejects(testProvider(nvidiaOptions(), {
    fetchImpl: async () => { throw new Error('synthetic private auth detail'); },
  }), (error) => {
    assert.match(error.message, /NVIDIA request/);
    assert.doesNotMatch(error.message, /synthetic private auth detail/);
    return true;
  });
});

for (const finalAnswer of [true, false]) {
  test(`the CLI ${finalAnswer ? 'succeeds for a final answer' : 'fails for reasoning-only output'}`, () => {
    const scriptUrl = new URL('./provider-smoke.mjs', import.meta.url);
    const result = spawnSync(process.execPath, ['--input-type=module', '-e', `
      globalThis.fetch = async (url) => ({ ok: true, status: 200, json: async () =>
        url.endsWith('/models') ? { data: [{ id: ${JSON.stringify(DEFAULT_MODEL)} }] }
          : { choices: [{ message: ${JSON.stringify(finalAnswer ? { content: 'OK' } : { reasoning_content: 'synthetic reasoning only' })} }] }
      });
      process.argv[1] = ${JSON.stringify(fileURLToPath(scriptUrl))};
      await import(${JSON.stringify(scriptUrl.href)});
    `], { encoding: 'utf8', env: {} });
    assert.equal(result.status, finalAnswer ? 0 : 1, result.stderr);
    assert.match(finalAnswer ? result.stdout : result.stderr, finalAnswer ? /NVIDIA: PASS/ : /NVIDIA: FAILED.*no final message content/);
  });
}

test('importing the smoke module makes no requests or reads provider configuration', () => {
  const scriptUrl = new URL('./provider-smoke.mjs', import.meta.url).href;
  const result = spawnSync(process.execPath, ['--input-type=module', '-e', `
    globalThis.fetch = async () => { throw new Error('Unexpected network request'); };
    process.env = new Proxy({}, { get(_target, key) {
      if (/^(NVIDIA|LM_STUDIO)_/.test(String(key))) throw new Error('Unexpected provider environment read');
      return undefined;
    } });
    await import(${JSON.stringify(scriptUrl)});
  `], { encoding: 'utf8', env: {} });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, '');
  assert.equal(result.stderr, '');
});

test('the CLI uses the shared NVIDIA default and a tiny final-answer probe', async () => {
  const fake = fakeProvider();
  const results = await runSmoke({ NVIDIA_BASE_URL: NVIDIA_BASE }, { ...fake, logger });
  assert.equal(results[0].model, DEFAULT_MODEL);
  assert.equal(results[0].sample, 'OK');
  const request = fake.calls.find((call) => call.url === `${NVIDIA_BASE}/chat/completions`);
  assert.equal(request.body.model, DEFAULT_MODEL);
  assert.equal(request.body.max_tokens, 8);
  assert.deepEqual(request.body.chat_template_kwargs, { enable_thinking: false });
  assert.equal(request.body.stream, false);
});

for (const requestedModel of [undefined, 'explicit/missing']) {
  test(`NVIDIA fails when ${requestedModel ? 'the explicit model' : 'the default model'} is absent, without fallback`, async () => {
    const fake = fakeProvider({ models: ['other/catalog-model'] });
    const results = await runSmoke({ NVIDIA_BASE_URL: NVIDIA_BASE, NVIDIA_MODEL: requestedModel }, { ...fake, logger });
    assert.equal(results[0].status, 'failed');
    assert.match(results[0].error, /not.*catalog|not.*exposed/i);
    assert.equal(fake.calls.filter((call) => call.url === `${NVIDIA_BASE}/chat/completions`).length, 0);
  });
}

test('NVIDIA fails safely on a catalog HTTP error without sending a completion', async () => {
  const fake = fakeProvider({ catalogStatus: 401 });
  await assert.rejects(testProvider(nvidiaOptions(), fake), (error) => {
    assert.match(error.message, /HTTP 401/);
    assert.doesNotMatch(error.message, /synthetic private auth detail/);
    return true;
  });
  assert.equal(fake.calls.length, 1);
});

test('NVIDIA honors an explicit catalog model without applying another model thinking options', async () => {
  const fake = fakeProvider({ models: [DEFAULT_MODEL, 'explicit/working'] });
  const result = await testProvider(nvidiaOptions({ requestedModel: 'explicit/working' }), fake);
  assert.equal(result.model, 'explicit/working');
  assert.equal(fake.calls[1].body.model, 'explicit/working');
  assert.equal(fake.calls[1].body.chat_template_kwargs, undefined);
});

for (const message of [
  { content: '   ' },
  { reasoning_content: 'synthetic reasoning only' },
  { content: '<think>synthetic reasoning only</think>' },
  { content: '<think>unfinished synthetic reasoning' },
]) {
  test(`NVIDIA rejects a completion without final answer: ${JSON.stringify(message)}`, async () => {
    const fake = fakeProvider({ message });
    await assert.rejects(testProvider(nvidiaOptions(), fake), /no.*(final|message).*content/i);
  });
}

test('NVIDIA returns only the final answer after a thinking block', async () => {
  const fake = fakeProvider({ message: { content: '<think>synthetic reasoning</think> OK' } });
  const result = await testProvider(nvidiaOptions(), fake);
  assert.equal(result.sample, 'OK');
});

test('NVIDIA uses one 15-second deadline for catalog and completion', async (t) => {
  const scheduled = [];
  const cleared = [];
  t.mock.method(globalThis, 'setTimeout', (callback, delay) => {
    const timer = { callback, delay };
    scheduled.push(timer);
    return timer;
  });
  t.mock.method(globalThis, 'clearTimeout', (timer) => cleared.push(timer));
  const fake = fakeProvider();
  const catalogFetch = fake.fetchImpl;
  let completionStarted;
  const ready = new Promise((resolve) => { completionStarted = resolve; });
  fake.fetchImpl = async (url, options) => {
    if (url.endsWith('/models')) return catalogFetch(url, options);
    completionStarted();
    return new Promise((_resolve, reject) => {
      options.signal.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')), { once: true });
    });
  };
  const pending = testProvider(nvidiaOptions(), fake);
  await ready;
  assert.equal(scheduled.length, 1);
  assert.equal(scheduled[0].delay, 15_000);
  scheduled[0].callback();
  await assert.rejects(pending, /timed out.*15.*second/i);
  assert.deepEqual(cleared, scheduled);
});

test('LM Studio retains preferred fallback, local token budget and reasoning acceptance', async (t) => {
  const timeouts = [];
  const originalSetTimeout = globalThis.setTimeout;
  t.mock.method(globalThis, 'setTimeout', (callback, delay) => {
    timeouts.push(delay);
    return originalSetTimeout(callback, delay);
  });
  const fake = fakeProvider({ models: ['other/model', 'qwen/local'], message: { reasoning_content: 'local synthetic answer' } });
  const result = await testProvider({
    name: 'LM Studio', baseUrl: 'http://127.0.0.1:1234/v1', headers: {},
    requestedModel: 'missing/local', preferredPatterns: [/qwen/], prompt: 'Local synthetic probe. /no_think',
  }, fake);
  assert.equal(result.model, 'qwen/local');
  assert.equal(result.sample, 'local synthetic answer');
  assert.equal(fake.calls[1].body.max_tokens, 128);
  assert.equal(fake.calls[1].body.chat_template_kwargs, undefined);
  assert.deepEqual(timeouts, [20_000, 120_000]);
});
