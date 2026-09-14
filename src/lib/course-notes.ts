import type { CourseNote, CourseNoteBlock, Lesson, TranscriptSegment } from '../types';
import type { LLMProvider, ProviderResponseFormat } from './llm-provider';

const SUBJECT_SIGNALS: Record<string, string[]> = {
  Mathematics: ['equation', 'matrix', 'vector', 'derivative', 'integral', 'theorem', 'proof', 'probability', 'softmax', 'logit', 'gradient'],
  Philosophy: ['philosophy', 'ethics', 'epistemology', 'ontology', 'argument', 'thesis', 'kant', 'plato', 'aristotle'],
  Programming: ['function', 'variable', 'class', 'array', 'database', 'algorithm', 'python', 'javascript', 'typescript', 'compile'],
  Physics: ['force', 'energy', 'momentum', 'velocity', 'mass', 'quantum', 'newton', 'wave', 'field'],
  Biology: ['cell', 'gene', 'protein', 'organism', 'evolution', 'DNA', 'ecosystem'],
};

function normalized(text: string) {
  return text.toLocaleLowerCase();
}

function slug(value: string) {
  return value.normalize('NFKD').replace(/[\u0300-\u036f]/g, '').replace(/[^a-z0-9]+/gi, '-').replace(/^-|-$/g, '').toLocaleLowerCase() || 'course';
}

function extractFormula(text: string) {
  const explicit = text.match(/(\$\$[\s\S]+?\$\$|\\\[[\s\S]+?\\\]|\\\([\s\S]+?\\\)|\$(?!\$)[^$\n]+\$)/);
  if (explicit) return explicit[1];
  const lower = normalized(text);
  if (lower.includes('softmax') && lower.includes('square root') && lower.includes('multiplied by v')) return String.raw`$$\operatorname{softmax}\left(\frac{QK^\top}{\sqrt{d_k}}\right)V$$`;
  if (lower.includes('newton') && lower.includes('force')) return String.raw`$$F = ma$$`;
  if (lower.includes('einstein') || lower.includes('mass energy')) return String.raw`$$E = mc^2$$`;
  const equation = text.match(/\b([A-Z][A-Za-z0-9_]*)\s*=\s*([^,.!?;]+)/);
  if (equation) return `$$${equation[1]} = ${equation[2].trim()}$$`;
  return null;
}

function extractCode(text: string) {
  const fenced = text.match(/```([a-zA-Z0-9_+-]*)\n([\s\S]*?)```/);
  if (fenced) return { language: fenced[1] || 'text', code: fenced[2].trim() };
  if (/^(?:const|let|var|function|class|import|export|def|for\s|while\s|SELECT\s)/im.test(text.trim())) {
    return { language: /\b(?:def|import\s+\w+|print\s*\()/i.test(text) ? 'python' : 'code', code: text.trim() };
  }
  return null;
}

function extractSchema(text: string) {
  const edges = [...text.matchAll(/([A-Za-z][\w ]{1,32})\s*(?:->|leads to|causes|depends on)\s*([A-Za-z][\w ]{1,32})/gi)]
    .map((match) => ({ from: match[1].trim(), to: match[2].trim() }));
  if (!edges.length) return null;
  return { nodes: [...new Set(edges.flatMap((edge) => [edge.from, edge.to]))], edges };
}

function extractChart(text: string) {
  const values = [...text.matchAll(/([A-Za-z][\w -]{1,24})\s*[:=]\s*(-?\d+(?:\.\d+)?)/g)]
    .map((match) => ({ label: match[1].trim(), value: Number(match[2]) }))
    .filter((item) => Number.isFinite(item.value));
  return values.length >= 2 ? { label: 'Values mentioned in the lecture', values } : null;
}

const richNoteResponseFormat: ProviderResponseFormat = {
  type: 'json_schema',
  json_schema: {
    name: 'course_note_rich_blocks',
    strict: true,
    schema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        blocks: {
          type: 'array',
          items: {
            type: 'object',
            additionalProperties: false,
            properties: {
              type: { type: 'string', enum: ['formula', 'code', 'schema', 'chart'] },
              sourceId: { type: 'string' },
              latex: { type: 'string' },
              caption: { type: 'string' },
              language: { type: 'string' },
              code: { type: 'string' },
              label: { type: 'string' },
              nodes: { type: 'array', items: { type: 'string' } },
              edges: {
                type: 'array',
                items: {
                  type: 'object',
                  additionalProperties: false,
                  properties: { from: { type: 'string' }, to: { type: 'string' } },
                  required: ['from', 'to'],
                },
              },
              values: {
                type: 'array',
                items: {
                  type: 'object',
                  additionalProperties: false,
                  properties: { label: { type: 'string' }, value: { type: 'number' } },
                  required: ['label', 'value'],
                },
              },
            },
            required: ['type', 'sourceId'],
          },
        },
      },
      required: ['blocks'],
    },
  },
};

const richBlockTypes = new Set(['formula', 'code', 'schema', 'chart']);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function parseRichBlocks(content: string, transcript: TranscriptSegment[]): Array<CourseNoteBlock & { sourceId: string }> | null {
  const candidate = content.match(/```(?:json)?\s*([\s\S]*?)```/i)?.[1] ?? content.match(/\{[\s\S]*\}/)?.[0];
  if (!candidate) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(candidate);
  } catch {
    return null;
  }
  if (!isRecord(parsed) || !Array.isArray(parsed.blocks)) return null;
  const sourceIds = new Set(transcript.map((segment) => segment.id));
  const blocks: Array<CourseNoteBlock & { sourceId: string }> = [];
  for (const rawBlock of parsed.blocks) {
    if (!isRecord(rawBlock) || typeof rawBlock.type !== 'string' || !richBlockTypes.has(rawBlock.type) || typeof rawBlock.sourceId !== 'string' || !sourceIds.has(rawBlock.sourceId)) return null;
    if (rawBlock.type === 'formula') {
      if (typeof rawBlock.latex !== 'string' || !rawBlock.latex.trim()) return null;
      blocks.push({ id: `ai-formula-${blocks.length}`, type: 'formula', latex: rawBlock.latex.trim(), ...(typeof rawBlock.caption === 'string' && rawBlock.caption.trim() ? { caption: rawBlock.caption.trim() } : {}), sourceId: rawBlock.sourceId });
      continue;
    }
    if (rawBlock.type === 'code') {
      if (typeof rawBlock.language !== 'string' || !rawBlock.language.trim() || typeof rawBlock.code !== 'string' || !rawBlock.code.trim()) return null;
      blocks.push({ id: `ai-code-${blocks.length}`, type: 'code', language: rawBlock.language.trim(), code: rawBlock.code.trim(), sourceId: rawBlock.sourceId });
      continue;
    }
    if (rawBlock.type === 'schema') {
      if (!Array.isArray(rawBlock.nodes) || !rawBlock.nodes.length || !rawBlock.nodes.every((node) => typeof node === 'string' && node.trim()) || !Array.isArray(rawBlock.edges) || !rawBlock.edges.length) return null;
      const nodes = rawBlock.nodes.map((node) => node.trim());
      const edges = rawBlock.edges.map((edge) => {
        if (!isRecord(edge) || typeof edge.from !== 'string' || typeof edge.to !== 'string' || !nodes.includes(edge.from.trim()) || !nodes.includes(edge.to.trim())) return null;
        return { from: edge.from.trim(), to: edge.to.trim() };
      });
      if (edges.some((edge) => edge === null)) return null;
      blocks.push({ id: `ai-schema-${blocks.length}`, type: 'schema', nodes, edges: edges as Array<{ from: string; to: string }>, sourceId: rawBlock.sourceId });
      continue;
    }
    if (typeof rawBlock.label !== 'string' || !rawBlock.label.trim() || !Array.isArray(rawBlock.values) || rawBlock.values.length < 2) return null;
    const values = rawBlock.values.map((value) => {
      if (!isRecord(value) || typeof value.label !== 'string' || !value.label.trim() || typeof value.value !== 'number' || !Number.isFinite(value.value)) return null;
      return { label: value.label.trim(), value: value.value };
    });
    if (values.some((value) => value === null)) return null;
    blocks.push({ id: `ai-chart-${blocks.length}`, type: 'chart', label: rawBlock.label.trim(), values: values as Array<{ label: string; value: number }>, sourceId: rawBlock.sourceId });
  }
  return blocks;
}

export function detectCourse(lesson: Lesson, transcript: TranscriptSegment[]): CourseNote['detection'] {
  const text = normalized(transcript.map((segment) => segment.text).join(' '));
  const ranked = Object.entries(SUBJECT_SIGNALS)
    .map(([subject, signals]) => ({ subject, score: signals.filter((signal) => text.includes(signal.toLocaleLowerCase())).length }))
    .sort((left, right) => right.score - left.score);
  const winner = ranked[0];
  if (winner && winner.score >= 3 && winner.subject.toLocaleLowerCase() !== lesson.subject.toLocaleLowerCase()) {
    return { method: 'transcript signals', confidence: Math.min(0.96, 0.58 + winner.score * 0.08), basis: `${winner.score} transcript signals matched ${winner.subject}.` };
  }
  if (transcript.length) return { method: 'transcript signals', confidence: Math.min(0.99, 0.72 + Math.min(transcript.length, 9) * 0.02), basis: `Transcript is attached to ${lesson.title}.` };
  return { method: 'active course', confidence: 1, basis: 'Using the selected course until transcript evidence is available.' };
}

function blocksForSegment(segment: TranscriptSegment): CourseNoteBlock[] {
  const blocks: CourseNoteBlock[] = [{
    id: `paragraph-${segment.id}`,
    type: 'paragraph',
    text: segment.text.replace(/\$\$[\s\S]*?\$\$|\$[^$\n]+\$/g, '').trim() || segment.text,
    timestamp: segment.timestamp,
    speaker: segment.speaker,
    sourceId: segment.sourceId,
  }];
  const formula = extractFormula(segment.text);
  if (formula) blocks.push({ id: `formula-${segment.id}`, type: 'formula', latex: formula, sourceId: segment.sourceId });
  const code = extractCode(segment.text);
  if (code) blocks.push({ id: `code-${segment.id}`, type: 'code', ...code, sourceId: segment.sourceId });
  const schema = extractSchema(segment.text);
  if (schema) blocks.push({ id: `schema-${segment.id}`, type: 'schema', ...schema, sourceId: segment.sourceId });
  const chart = extractChart(segment.text);
  if (chart) blocks.push({ id: `chart-${segment.id}`, type: 'chart', ...chart, sourceId: segment.sourceId });
  return blocks;
}

export function buildCourseNote(lesson: Lesson, transcript: TranscriptSegment[], now: () => string = () => new Date().toISOString()): CourseNote {
  const detection = detectCourse(lesson, transcript);
  const subject = detection.method === 'transcript signals' && detection.basis.includes('matched')
    ? detection.basis.replace(/^\d+ transcript signals matched /, '').replace(/\.$/, '')
    : lesson.subject;
  const sublesson = lesson.sublesson?.trim();
  return {
    id: `course-note:${lesson.id}`,
    title: lesson.title,
    subject,
    chapter: lesson.chapter,
    folderPath: ['Courses', subject, lesson.chapter, lesson.title],
    fileName: `${slug(lesson.title)}-course-notes.md`,
    updatedAt: now(),
    ...(sublesson ? { sublesson } : {}),
    detection,
    blocks: [
      { id: 'note-title', type: 'heading', level: 1, text: lesson.title },
      ...(sublesson ? [{ id: 'note-sublesson', type: 'heading' as const, level: 2 as const, text: sublesson }] : []),
      { id: 'note-context', type: 'paragraph', text: `${subject} / ${lesson.chapter} · ${lesson.teacher}` },
      ...transcript.flatMap(blocksForSegment),
    ],
  };
}

export async function formatCourseNoteWithProvider(
  lesson: Lesson,
  transcript: TranscriptSegment[],
  provider: LLMProvider | null | undefined,
  now: () => string = () => new Date().toISOString(),
): Promise<CourseNote> {
  const fallback = buildCourseNote(lesson, transcript, now);
  if (!provider || !transcript.length) return fallback;
  const evidence = transcript.map((segment) => `SOURCE ${segment.id} | ${segment.timestamp} | ${segment.speaker}\n${segment.text}`).join('\n\n').slice(0, 24_000);
  try {
    const result = await provider.generate([
      {
        role: 'system',
        content: [
          'Format a course transcript into rich note annotations.',
          'Return only valid JSON matching the supplied schema. Do not return headings or paragraphs.',
          'Every block must use a sourceId from the supplied evidence. Add a formula, code block, causal schema, or numeric chart only when it is clearly supported by that source.',
          'Do not invent facts, values, relationships, code, or formulas. Return an empty blocks array when no rich annotation is justified.',
        ].join('\n'),
      },
      { role: 'user', content: evidence },
    ], { responseFormat: richNoteResponseFormat });
    const richBlocks = parseRichBlocks(result.content, transcript);
    if (!richBlocks?.length) return fallback;
    const segmentBySource = new Map<string, TranscriptSegment>();
    transcript.forEach((segment) => {
      segmentBySource.set(segment.id, segment);
      if (segment.sourceId) segmentBySource.set(segment.sourceId, segment);
    });
    const bySource = new Map<string, Array<CourseNoteBlock & { sourceId: string }>>();
    richBlocks.forEach((block) => {
      const segment = segmentBySource.get(block.sourceId);
      if (segment) bySource.set(segment.id, [...(bySource.get(segment.id) ?? []), block]);
    });
    const blocks: CourseNoteBlock[] = [];
    fallback.blocks.forEach((block) => {
      const segment = 'sourceId' in block && block.sourceId
        ? segmentBySource.get(block.sourceId)
        : transcript.find((candidate) => block.id.endsWith(candidate.id));
      const sourceId = segment?.id;
      if (block.type !== 'paragraph' && sourceId && bySource.has(sourceId)) return;
      const nextBlock = block.type === 'paragraph' && sourceId && !block.sourceId ? { ...block, sourceId } : block;
      blocks.push(nextBlock);
      if (block.type === 'paragraph' && sourceId) blocks.push(...(bySource.get(sourceId) ?? []));
    });
    return {
      ...fallback,
      updatedAt: now(),
      detection: { method: 'LM Studio', confidence: 0.9, basis: `LM Studio formatted source-linked rich blocks with ${result.model}.` },
      blocks,
    };
  } catch {
    return fallback;
  }
}

export async function detectCourseWithProvider(lesson: Lesson, transcript: TranscriptSegment[], provider: LLMProvider): Promise<CourseNote | null> {
  const excerpt = transcript.slice(-12).map((segment) => `${segment.timestamp} ${segment.text}`).join('\n');
  if (!excerpt.trim()) return null;
  const result = await provider.generate([
    { role: 'system', content: 'Identify the current course from the lecture excerpt. Return only JSON with string fields title, subject, chapter and a number confidence between 0 and 1. Keep the selected course metadata when the excerpt is insufficient.' },
    { role: 'user', content: `Selected course: ${lesson.title}\nSubject: ${lesson.subject}\nChapter: ${lesson.chapter}\nLecture excerpt:\n${excerpt}` },
  ]);
  const match = result.content.match(/\{[\s\S]*\}/);
  if (!match) return null;
  try {
    const parsed = JSON.parse(match[0]) as Record<string, unknown>;
    if (typeof parsed.title !== 'string' || typeof parsed.subject !== 'string' || typeof parsed.chapter !== 'string') return null;
    const confidence = typeof parsed.confidence === 'number' && Number.isFinite(parsed.confidence)
      ? Math.max(0, Math.min(1, parsed.confidence))
      : 0.6;
    const note = buildCourseNote(lesson, transcript);
    const title = parsed.title.trim() || note.title;
    const subject = parsed.subject.trim() || note.subject;
    const chapter = parsed.chapter.trim() || note.chapter;
    return {
      ...note,
      title,
      subject,
      chapter,
      folderPath: ['Courses', subject, chapter, title],
      fileName: `${slug(title)}-course-notes.md`,
      detection: { method: 'LM Studio', confidence, basis: `LM Studio classified the latest lecture excerpt with ${result.model}.` },
      blocks: note.blocks.map((block) => block.id === 'note-title' && block.type === 'heading' ? { ...block, text: title } : block),
    };
  } catch {
    return null;
  }
}

export function courseNoteMarkdown(note: CourseNote) {
  return note.blocks.map((block) => {
    if (block.type === 'heading') return `${'#'.repeat(block.level)} ${block.text}`;
    if (block.type === 'paragraph') return `${block.timestamp ? `**${block.timestamp} · ${block.speaker ?? 'Lecture'}**\n` : ''}${block.text}`;
    if (block.type === 'formula') return `${block.caption ? `_${block.caption}_\n` : ''}${block.latex}`;
    if (block.type === 'code') return `\`\`\`${block.language}\n${block.code}\n\`\`\``;
    if (block.type === 'schema') return `Schema: ${block.edges.map((edge) => `${edge.from} -> ${edge.to}`).join(', ')}`;
    return `### ${block.label}\n${block.values.map((item) => `- ${item.label}: ${item.value}`).join('\n')}`;
  }).join('\n\n');
}
