import { describe, expect, it } from 'vitest';
import { OpenAICompatibleProvider } from './llm-provider';

describe('provider response limits', () => {
  it('rejects an unexpectedly large provider request', async () => {
    const provider = new OpenAICompatibleProvider({
      baseUrl: 'http://127.0.0.1:1234/v1',
      model: 'test',
      fetchImpl: async () => new Response('{}', { status: 200 }),
    });

    await expect(provider.generate([{ role: 'user', content: 'x'.repeat(8 * 1024 * 1024 + 1) }])).rejects.toThrow('request is too large');
  });

  it('rejects an unexpectedly large provider response', async () => {
    const content = 'x'.repeat(8 * 1024 * 1024 + 1);
    const provider = new OpenAICompatibleProvider({
      baseUrl: 'http://127.0.0.1:1234/v1',
      model: 'test',
      fetchImpl: async () => new Response(JSON.stringify({ choices: [{ message: { content } }] }), { status: 200 }),
    });

    await expect(provider.generate([])).rejects.toThrow('response is too large');
  });
});
