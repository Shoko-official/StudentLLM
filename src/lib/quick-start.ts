import type { Lesson } from '../types';
import type { LLMProvider } from './llm-provider';

export interface QuickStartProposal {
  course: string;
  lesson: string;
  sublesson: string;
  subject: string;
  placement: 'existing' | 'new';
  targetCourseId: string | null;
  confidence: number;
  rationale: string;
}

function clean(value: unknown) {
  return typeof value === 'string' ? value.trim().replace(/\s+/g, ' ') : '';
}

function extractJson(content: string) {
  const fenced = content.match(/```(?:json)?\s*([\s\S]*?)```/i)?.[1];
  const candidate = fenced ?? content.match(/\{[\s\S]*\}/)?.[0];
  if (!candidate) throw new Error('LM Studio did not return a Quick Start structure. Try again.');
  try {
    return JSON.parse(candidate) as Record<string, unknown>;
  } catch {
    throw new Error('LM Studio returned an invalid Quick Start structure. Try again.');
  }
}

export async function analyzeQuickStart(
  input: string,
  lessons: Lesson[],
  provider: LLMProvider | null | undefined,
): Promise<QuickStartProposal> {
  const excerpt = input.trim();
  if (!excerpt) throw new Error('Add a lecture excerpt or course description first.');
  if (!provider) throw new Error('Connect LM Studio in Settings to use Quick Start.');

  const catalog = lessons.length
    ? lessons.map((lesson) => `id=${lesson.id} | course=${lesson.subject} | lesson=${lesson.chapter} | sublesson=${lesson.title}`).join('\n')
    : 'No existing courses.';
  const result = await provider.generate([
    {
      role: 'system',
      content: [
        'You organize study material into a small course tree.',
        'Return only valid JSON, with no markdown and no extra text.',
        'Use exactly these fields: placement, targetCourseId, course, lesson, sublesson, subject, confidence, rationale.',
        'placement must be "existing" only when one existing course clearly matches; otherwise use "new".',
        'targetCourseId must be an existing catalog id when placement is "existing", otherwise null.',
        'Keep names concise and in the language of the input. If a sublesson is not supported by the input, return an empty string.',
        'confidence is a number from 0 to 1. Do not invent a teacher, date, facts, or hierarchy that is not supported by the input.',
        `Existing course catalog:\n${catalog}`,
      ].join('\n'),
    },
    { role: 'user', content: excerpt.slice(0, 24_000) },
  ]);

  const parsed = extractJson(result.content);
  const targetCourseId = clean(parsed.targetCourseId);
  const targetExists = Boolean(targetCourseId && lessons.some((lesson) => lesson.id === targetCourseId));
  const placement = parsed.placement === 'existing' && targetExists ? 'existing' : 'new';
  const course = clean(parsed.course) || clean(parsed.subject) || 'General';
  const lesson = clean(parsed.lesson) || 'General notes';
  const sublesson = clean(parsed.sublesson);
  const confidence = typeof parsed.confidence === 'number' && Number.isFinite(parsed.confidence)
    ? Math.max(0, Math.min(1, parsed.confidence))
    : 0.6;

  return {
    course,
    lesson,
    sublesson,
    subject: clean(parsed.subject) || course,
    placement,
    targetCourseId: placement === 'existing' ? targetCourseId : null,
    confidence,
    rationale: clean(parsed.rationale) || 'The proposed structure is based on the supplied course material.',
  };
}
