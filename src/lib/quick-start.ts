import type { Lesson } from '../types';
import type { LLMProvider, ProviderResponseFormat } from './llm-provider';
import { ORGANIZATION_PROMPT } from '../prompts';

export interface QuickStartProposal {
  course: string;
  lesson: string;
  title: string;
  sublesson: string;
  subject: string;
  placement: 'existing' | 'new';
  targetCourseId: string | null;
  confidence: number;
  rationale: string;
}

const quickStartResponseFormat: ProviderResponseFormat = {
  type: 'json_schema',
  json_schema: {
    name: 'quick_start',
    strict: true,
    schema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        placement: { type: 'string', enum: ['new', 'existing'] },
        targetCourseId: { anyOf: [{ type: 'string' }, { type: 'null' }] },
        course: { type: 'string' },
        lesson: { type: 'string' },
        title: { type: 'string' },
        sublesson: { type: 'string' },
        subject: { type: 'string' },
        confidence: { type: 'number' },
        rationale: { type: 'string' },
      },
      required: ['placement', 'targetCourseId', 'course', 'lesson', 'title', 'sublesson', 'subject', 'confidence', 'rationale'],
    },
  },
};

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
    ? lessons.map((lesson) => `id=${lesson.id} | course=${lesson.subject} | lesson=${lesson.chapter} | title=${lesson.title} | sublesson=${lesson.sublesson ?? ''}`).join('\n')
    : 'No existing courses.';
  const result = await provider.generate([
    {
      role: 'system',
      content: ORGANIZATION_PROMPT,
    },
    { role: 'user', content: JSON.stringify({ knownDestinations: catalog }) },
    { role: 'user', content: excerpt.slice(0, 24_000) },
  ], { responseFormat: quickStartResponseFormat });

  const parsed = extractJson(result.content);
  const targetCourseId = clean(parsed.targetCourseId);
  const targetExists = Boolean(targetCourseId && lessons.some((lesson) => lesson.id === targetCourseId));
  const placement = parsed.placement === 'existing' && targetExists ? 'existing' : 'new';
  const course = clean(parsed.course) || clean(parsed.subject) || 'General';
  const lesson = clean(parsed.lesson) || 'General notes';
  const sublesson = clean(parsed.sublesson);
  const title = clean(parsed.title) || sublesson || lesson || course;
  const confidence = typeof parsed.confidence === 'number' && Number.isFinite(parsed.confidence)
    ? Math.max(0, Math.min(1, parsed.confidence))
    : 0.6;

  return {
    course,
    lesson,
    title,
    sublesson,
    subject: clean(parsed.subject) || course,
    placement,
    targetCourseId: placement === 'existing' ? targetCourseId : null,
    confidence,
    rationale: clean(parsed.rationale) || 'The proposed structure is based on the supplied course material.',
  };
}
