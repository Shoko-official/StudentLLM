import { describe, expect, it, vi } from 'vitest';
import { analyzeQuickStart } from './quick-start';
import type { Lesson } from '../types';

const lessons: Lesson[] = [{
  id: 'ml-transformers', subject: 'Machine Learning', chapter: 'Transformers', title: 'Attention',
  teacher: '', duration: '00:00:00', date: '10/09/2026', progress: 0,
}];

describe('Quick Start analysis', () => {
  it('parses an AI proposal and accepts only a catalog course as an existing target', async () => {
    const generate = vi.fn().mockResolvedValue({
      model: 'fixture-model',
      content: '```json\n{"placement":"existing","targetCourseId":"ml-transformers","course":"Machine Learning","lesson":"Transformers","title":"Cross-attention notes","sublesson":"Decoder reads encoder context","subject":"Machine Learning","confidence":0.91,"rationale":"The excerpt discusses queries, keys and values."}\n```',
    });

    const proposal = await analyzeQuickStart('Queries attend to keys and values.', lessons, { generate });

    expect(proposal).toMatchObject({
      placement: 'existing', targetCourseId: 'ml-transformers', title: 'Cross-attention notes',
      lesson: 'Transformers', sublesson: 'Decoder reads encoder context', confidence: 0.91,
    });
    expect(generate).toHaveBeenCalledWith(expect.arrayContaining([
      expect.objectContaining({ role: 'user', content: 'Queries attend to keys and values.' }),
    ]));
  });

  it('falls back to a new course when the model invents an existing course id', async () => {
    const generate = vi.fn().mockResolvedValue({
      model: 'fixture-model',
      content: '{"placement":"existing","targetCourseId":"not-in-catalog","course":"Physics","lesson":"Waves","sublesson":"Interference","subject":"Physics","confidence":1,"rationale":"The excerpt mentions waves."}',
    });

    await expect(analyzeQuickStart('Waves interfere.', lessons, { generate })).resolves.toMatchObject({
      placement: 'new', targetCourseId: null, course: 'Physics', lesson: 'Waves',
    });
  });

  it('reports provider and malformed response failures clearly', async () => {
    await expect(analyzeQuickStart('Some notes', lessons, null)).rejects.toThrow('Connect LM Studio');
    await expect(analyzeQuickStart('Some notes', lessons, { generate: vi.fn().mockResolvedValue({ content: 'not json', model: 'fixture' }) })).rejects.toThrow('did not return a Quick Start structure');
  });
});
