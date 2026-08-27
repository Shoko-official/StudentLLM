const DEFAULT_NVIDIA_BASE_URL = 'https://integrate.api.nvidia.com/v1';
const DEFAULT_LM_STUDIO_BASE_URL = 'http://127.0.0.1:1234/v1';
const DEFAULT_NVIDIA_MODEL = 'openai/gpt-oss-20b';
const DEFAULT_LM_STUDIO_MODEL = 'qwen/qwen3-4b';

function withTimeout(timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  return { signal: controller.signal, clear: () => clearTimeout(timer) };
}

async function requestJson(url, options = {}, timeoutMs = 20_000) {
  const timeout = withTimeout(timeoutMs);
  try {
    const response = await fetch(url, { ...options, signal: timeout.signal });
    const body = await response.json().catch(() => ({}));
    if (!response.ok) {
      const detail = typeof body?.error === 'string' ? body.error : body?.error?.message;
      throw new Error(`HTTP ${response.status}${detail ? `: ${detail}` : ''}`);
    }
    return body;
  } finally {
    timeout.clear();
  }
}

function chooseModel(models, requested, preferredPatterns) {
  const ids = models.map((model) => model.id).filter(Boolean);
  if (ids.includes(requested)) return requested;
  return preferredPatterns.find((pattern) => ids.some((id) => pattern.test(id)))
    ? ids.find((id) => preferredPatterns.some((pattern) => pattern.test(id)))
    : ids[0];
}

async function testProvider({ name, baseUrl, headers, requestedModel, preferredPatterns, prompt }) {
  const modelsResponse = await requestJson(`${baseUrl}/models`, { headers });
  const models = Array.isArray(modelsResponse.data) ? modelsResponse.data : [];
  if (!models.length) throw new Error('No models exposed by the provider');
  const model = chooseModel(models, requestedModel, preferredPatterns);
  if (!model) throw new Error('No usable model found');

  const startedAt = performance.now();
  const completion = await requestJson(`${baseUrl}/chat/completions`, {
    method: 'POST',
    headers: { ...headers, 'content-type': 'application/json' },
    body: JSON.stringify({
      model,
      messages: [{
        role: 'user',
        content: prompt,
      }],
      temperature: 0,
      max_tokens: 128,
      stream: false,
    }),
  }, 120_000);
  const elapsedMs = Math.round(performance.now() - startedAt);
  const message = completion?.choices?.[0]?.message ?? {};
  const text = message.content || message.reasoning_content || '';
  if (!text.trim()) throw new Error('The provider returned no message content');

  return { name, model, modelCount: models.length, elapsedMs, sample: text.trim().replace(/\s+/g, ' ').slice(0, 180) };
}

const nvidiaKey = process.env.NVIDIA_API_KEY;
const results = [];

try {
  results.push(await testProvider({
    name: 'NVIDIA',
    baseUrl: process.env.NVIDIA_BASE_URL || DEFAULT_NVIDIA_BASE_URL,
    headers: nvidiaKey ? { authorization: `Bearer ${nvidiaKey}` } : {},
    requestedModel: process.env.NVIDIA_MODEL || DEFAULT_NVIDIA_MODEL,
    preferredPatterns: [/mistral-7b/i, /nemotron.*nano/i, /llama.*8b/i],
    prompt: 'Reply with exactly one short sentence: original sources remain the source of truth.',
  }));
} catch (error) {
  results.push({ name: 'NVIDIA', status: 'failed', error: error instanceof Error ? error.message : String(error), keyConfigured: Boolean(nvidiaKey) });
}

try {
  results.push(await testProvider({
    name: 'LM Studio',
    baseUrl: process.env.LM_STUDIO_BASE_URL || DEFAULT_LM_STUDIO_BASE_URL,
    headers: {},
    requestedModel: process.env.LM_STUDIO_MODEL || DEFAULT_LM_STUDIO_MODEL,
    preferredPatterns: [/qwen3-4b/i, /qwen/i, /gemma/i],
    prompt: 'Reply with exactly one short sentence: original sources remain the source of truth. /no_think',
  }));
} catch (error) {
  results.push({ name: 'LM Studio', status: 'failed', error: error instanceof Error ? error.message : String(error) });
}

for (const result of results) {
  if (result.status === 'failed') {
    console.error(`${result.name}: FAILED - ${result.error}`);
    if ('keyConfigured' in result) console.error(`${result.name}: key configured = ${result.keyConfigured}`);
    continue;
  }
  console.log(`${result.name}: PASS - model=${result.model}; models=${result.modelCount}; latency_ms=${result.elapsedMs}`);
  console.log(`  sample: ${result.sample}`);
}

if (results.some((result) => result.status === 'failed')) process.exitCode = 1;
