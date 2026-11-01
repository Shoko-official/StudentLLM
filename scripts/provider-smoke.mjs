import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import probes from '../src/prompts/probes.json' with { type: 'json' };

const DEFAULT_NVIDIA_BASE_URL = 'https://integrate.api.nvidia.com/v1';
const DEFAULT_LM_STUDIO_BASE_URL = 'http://127.0.0.1:1234/v1';
const nvidiaModels = JSON.parse(readFileSync(new URL('../src/lib/nvidia-nim-models.json', import.meta.url), 'utf8'));
const DEFAULT_LM_STUDIO_MODEL = 'openai/gpt-oss-20b';

function withTimeout(timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  return { signal: controller.signal, clear: () => clearTimeout(timer) };
}

async function requestJson(url, options = {}, timeoutMs = 20_000, fetchImpl = globalThis.fetch, signal) {
  const timeout = signal ? undefined : withTimeout(timeoutMs);
  try {
    let response;
    try {
      response = await fetchImpl(url, { ...options, signal: signal ?? timeout.signal });
    } catch (error) {
      // Remote errors can echo request details. Keep NVIDIA diagnostics content-free.
      if (signal) throw new Error('The NVIDIA request could not be completed');
      throw error;
    }
    const body = await response.json().catch(() => ({}));
    if (!response.ok) {
      const detail = signal ? undefined : typeof body?.error === 'string' ? body.error : body?.error?.message;
      throw new Error(`HTTP ${response.status}${detail ? `: ${detail}` : ''}`);
    }
    return body;
  } finally {
    timeout?.clear();
  }
}

function chooseModel(models, requested, preferredPatterns) {
  const ids = models.map((model) => model.id).filter(Boolean);
  if (ids.includes(requested)) return requested;
  return preferredPatterns.find((pattern) => ids.some((id) => pattern.test(id)))
    ? ids.find((id) => preferredPatterns.some((pattern) => pattern.test(id)))
    : ids[0];
}

export async function testProvider({ name, baseUrl, headers, requestedModel, preferredPatterns, prompt }, { fetchImpl = globalThis.fetch } = {}) {
  const isNvidia = name === 'NVIDIA';
  const timeout = isNvidia ? withTimeout(15_000) : undefined;
  try {
    const modelsResponse = await requestJson(`${baseUrl}/models`, { headers }, 20_000, fetchImpl, timeout?.signal);
    const models = Array.isArray(modelsResponse.data) ? modelsResponse.data : [];
    if (!models.length) throw new Error('No models exposed by the provider');
    if (isNvidia && !models.some((model) => model?.id === requestedModel)) {
      throw new Error('The requested NVIDIA model is not exposed in the catalog');
    }
    const model = isNvidia ? requestedModel : chooseModel(models, requestedModel, preferredPatterns);
    if (!model) throw new Error('No usable model found');
    const chatTemplateKwargs = isNvidia
      ? nvidiaModels.models.find((entry) => entry.id === model)?.chatTemplateKwargs
      : undefined;

    const startedAt = performance.now();
    // A catalog entry can be retired: only a final answer proves readiness.
    const completion = await requestJson(`${baseUrl}/chat/completions`, {
      method: 'POST',
      headers: { ...headers, 'content-type': 'application/json' },
      body: JSON.stringify({
        model,
        messages: [{ role: 'user', content: prompt }],
        temperature: 0,
        max_tokens: isNvidia ? nvidiaModels.models.find((entry) => entry.id === model)?.probeMaxTokens ?? 8 : 128,
        stream: false,
        ...(chatTemplateKwargs ? { chat_template_kwargs: chatTemplateKwargs } : {}),
      }),
    }, 120_000, fetchImpl, timeout?.signal);
    const elapsedMs = Math.round(performance.now() - startedAt);
    const message = completion?.choices?.[0]?.message ?? {};
    const text = isNvidia
      ? (typeof message.content === 'string' ? message.content.replace(/<think\b[^>]*>[\s\S]*?(?:<\/think\s*>|$)/gi, '') : '')
      : message.content || message.reasoning_content || '';
    if (!text.trim()) throw new Error(isNvidia ? 'The provider returned no final message content' : 'The provider returned no message content');

    return { name, model, modelCount: models.length, elapsedMs, sample: text.trim().replace(/\s+/g, ' ').slice(0, 180) };
  } catch (error) {
    if (timeout?.signal.aborted) throw new Error('The NVIDIA readiness check timed out after 15 seconds');
    throw error;
  } finally {
    timeout?.clear();
  }
}

export async function runSmoke(env = process.env, { fetchImpl = globalThis.fetch, logger = console } = {}) {
  const nvidiaKey = env.NVIDIA_API_KEY;
  const results = [];

  try {
    results.push(await testProvider({
      name: 'NVIDIA',
      baseUrl: env.NVIDIA_BASE_URL || DEFAULT_NVIDIA_BASE_URL,
      headers: nvidiaKey ? { authorization: `Bearer ${nvidiaKey}` } : {},
      requestedModel: env.NVIDIA_MODEL || nvidiaModels.defaultModel,
      prompt: probes.nimSmoke,
    }, { fetchImpl }));
  } catch (error) {
    results.push({ name: 'NVIDIA', status: 'failed', error: error instanceof Error ? error.message : String(error), keyConfigured: Boolean(nvidiaKey) });
  }

  try {
    results.push(await testProvider({
      name: 'LM Studio',
      baseUrl: env.LM_STUDIO_BASE_URL || DEFAULT_LM_STUDIO_BASE_URL,
      headers: {},
      requestedModel: env.LM_STUDIO_MODEL || DEFAULT_LM_STUDIO_MODEL,
      preferredPatterns: [/qwen3-4b/i, /qwen/i, /gemma/i],
      prompt: probes.localSmoke,
    }, { fetchImpl }));
  } catch (error) {
    results.push({ name: 'LM Studio', status: 'failed', error: error instanceof Error ? error.message : String(error) });
  }

  for (const result of results) {
    if (result.status === 'failed') {
      logger.error(`${result.name}: FAILED - ${result.error}`);
      if ('keyConfigured' in result) logger.error(`${result.name}: key configured = ${result.keyConfigured}`);
      continue;
    }
    logger.log(`${result.name}: PASS - model=${result.model}; models=${result.modelCount}; latency_ms=${result.elapsedMs}`);
    logger.log(`  sample: ${result.sample}`);
  }

  return results;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const results = await runSmoke();
  if (results.some((result) => result.status === 'failed')) process.exitCode = 1;
}
