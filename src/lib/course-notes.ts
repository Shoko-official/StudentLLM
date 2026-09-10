import type { CourseNote, CourseNoteBlock, Lesson, TranscriptSegment } from '../types';
import type { LLMProvider } from './llm-provider';

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
