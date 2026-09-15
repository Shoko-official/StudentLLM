import type { CourseNote, CourseNoteBlock, Lesson, TranscriptSegment } from '../types';
import type { LLMProvider, ProviderResponseFormat } from './llm-provider';
import type { DocumentPage } from './document-engine';
import { normalizeDocumentLine, normalizeExtractedDocumentText } from './document-text';
import { isExtractedMathSourceLine } from './extracted-math';
import { parseVisualEnvelope, type VisualBlock } from './visual-blocks';

export const DOCUMENT_NOTE_LAYOUT_VERSION = 'layout-v11';

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

const PDF_SOURCE_TITLE_BLACKLIST = new Set([
  'BAC+2 Informatique',
]);

function extractFormula(text: string) {
  const explicit = text.match(/(\$\$[\s\S]+?\$\$|\\\[[\s\S]+?\\\]|\\\([\s\S]+?\\\)|\$(?!\$)[^$\n]+\$)/);
  if (explicit) return explicit[1];
  const lower = normalized(text);
  if (lower.includes('softmax') && lower.includes('square root') && lower.includes('multiplied by v')) return String.raw`$$\operatorname{softmax}\left(\frac{QK^\top}{\sqrt{d_k}}\right)V$$`;
  if (lower.includes('newton') && lower.includes('force')) return String.raw`$$F = ma$$`;
  if (lower.includes('einstein') || lower.includes('mass energy')) return String.raw`$$E = mc^2$$`;
  const equation = text.match(/(^|\s)([A-Z][A-Za-z0-9_]*)\s*=\s*([^,.!?;\n]{1,100})(?=$|[,.!?;\n])/);
  if (equation && !/[\u0000-\u001f\u007f-\u009f\u2192\u2190\u2194]/.test(equation[3])) return `$$${equation[2]} = ${equation[3].trim()}$$`;
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

const documentMarkdownResponseFormat: ProviderResponseFormat = {
  type: 'json_schema',
  json_schema: {
    name: 'course_document_markdown',
    strict: true,
    schema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        markdown: { type: 'string' },
        visuals: {
          type: 'array',
          items: {
            type: 'object',
            additionalProperties: false,
            properties: {
              type: { type: 'string', enum: ['chart', 'diagram', 'table'] },
              chartType: { type: 'string', enum: ['bar', 'line', 'pie'] },
              title: { type: 'string' },
              sourceId: { type: 'string' },
              sourcePage: { type: 'integer', minimum: 1 },
              sourceLabel: { type: 'string' },
              values: { type: 'array', items: { type: 'object', additionalProperties: false, properties: { label: { type: 'string' }, value: { type: 'number' } }, required: ['label', 'value'] } },
              nodes: { type: 'array', items: { type: 'object', additionalProperties: false, properties: { id: { type: 'string' }, label: { type: 'string' } }, required: ['id', 'label'] } },
              edges: { type: 'array', items: { type: 'object', additionalProperties: false, properties: { from: { type: 'string' }, to: { type: 'string' }, label: { type: 'string' } }, required: ['from', 'to'] } },
              columns: { type: 'array', items: { type: 'string' } },
              rows: { type: 'array', items: { type: 'array', items: { type: 'string' } } },
            },
            required: ['type', 'sourceId'],
          },
        },
      },
      required: ['markdown'],
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
  if (/^Page \d+$/i.test(segment.timestamp)) return blocks;
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

function normalizeHeadingSignal(line: string) {
  return normalizeDocumentLine(line)
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLocaleLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

const DOCUMENT_HEADING_LABELS = [
  'definition',
  'exemple',
  'theoreme',
  'sens physique',
  'a retenir',
  'astuce memo',
  'memo',
  'base trigonometrie',
  'identite',
  'reciprocite',
  'deux relations remarquables',
  'methode generale',
  'equation caracteristique',
  'solution homogene',
  'principe de superposition',
  'calcul des constantes',
  'formes de la decomposition',
  'poles simples',
  'synthese du cours',
] as const;

function isDocumentHeadingToken(text: string) {
  const line = normalizeDocumentLine(text);
  if (line.length > 64) return false;
  const normalized = normalizeHeadingSignal(line);
  if (!normalized) return false;
  return DOCUMENT_HEADING_LABELS.some((keyword) => normalized === keyword || normalized.startsWith(`${keyword} `));
}

function trimIncompleteHeadingSuffix(line: string) {
  const openingParenthesis = line.lastIndexOf('(');
  if (openingParenthesis >= 0 && !line.slice(openingParenthesis + 1).includes(')')) {
    return line.slice(0, openingParenthesis).trim();
  }
  return line;
}

function documentHeading(line: string): { level: 1 | 2; text: string } | null {
  const text = trimIncompleteHeadingSuffix(line);
  if (!text) return null;
  if (/^\d+\s+(?:[A-ZÀ-ÖØ-Þ]|identités\b)/.test(text)) return { level: 1, text };
  if (/^\d+\.\d+\s+\S/.test(text)) return { level: 2, text };
  if (isDocumentHeadingToken(text)) {
    return { level: 2, text };
  }
  return null;
}

function documentChrome(line: string, page: DocumentPage, blockY?: number) {
  const normalized = normalizeHeadingSignal(line);
  return !line
    || normalized === 'formulaire de mathematiques'
    || normalized === 'formulaire de maths'
    || normalized === 'bac 2 informatique'
    || (blockY !== undefined && blockY > 790 && /^\d+$/.test(line))
    || (page.pageNumber > 1 && normalized === 'formulaire de mathematiques');
}

function documentBlockText(text: string) {
  return normalizeExtractedDocumentText(text).split('\n').map(normalizeDocumentLine).filter(Boolean);
}

function joinDocumentParagraphLines(lines: string[]) {
  return lines.reduce((paragraph, line, index) => {
    if (!index) return line;
    const previous = lines[index - 1];
    return `${paragraph}${isExtractedMathSourceLine(previous) || isExtractedMathSourceLine(line) ? '\n' : ' '}${line}`;
  }, '');
}

function extractDocumentSourceTitle(pages: DocumentPage[], sourceName: string) {
  const normalizedSource = normalizeDocumentLine(sourceName).replace(/\.[^.]+$/, '');
  const lines = pages
    .flatMap((page) => (page.blocks.length ? page.blocks : [{ x: 0, y: 0, width: 0, height: 0, text: page.text }]))
    .flatMap((block) => documentBlockText(block.text).map((line) => ({ line, orderY: block.y })))
    .sort((left, right) => left.orderY - right.orderY);

  const titleLine = lines.find(({ line }) => {
    if (!line || line.length < 3 || line.length > 90) return false;
    if (PDF_SOURCE_TITLE_BLACKLIST.has(line)) return false;
    if (/^\d+(?:\.\d+)?(?:\s|$)/.test(line)) return false;
    if (/^page\s+\d+/i.test(line)) return false;
    if (line.toLocaleLowerCase() === normalizedSource.toLocaleLowerCase()) return true;
    return true;
  })?.line;
  return titleLine || normalizedSource;
}

export function buildDocumentCourseNote(
  lesson: Lesson,
  pages: DocumentPage[],
  sourceName: string,
  now: () => string = () => new Date().toISOString(),
): CourseNote {
  const sourceTitle = extractDocumentSourceTitle(pages, sourceName);
  const blocks: CourseNoteBlock[] = [
    { id: 'note-title', type: 'heading', level: 1, text: lesson.title },
    { id: 'document-source-title', type: 'heading', level: 1, text: sourceTitle },
    { id: 'note-context', type: 'paragraph', text: `${lesson.subject} / ${lesson.chapter} · Source: ${sourceName}` },
  ];
  let index = 0;
  pages.slice().sort((left, right) => left.pageNumber - right.pageNumber).forEach((page) => {
    const pageBlocks = page.blocks.length
      ? page.blocks.slice().sort((left, right) => left.y - right.y || left.x - right.x)
      : [{ x: 0, y: 0, width: 0, height: 0, text: page.text }];
    pageBlocks.forEach((documentBlock) => {
      const lines = documentBlockText(documentBlock.text);
      if (documentBlock.imageData) {
        const alt = lines.join(' ');
        if (alt) {
          blocks.push({
            id: `document-formula-image-${page.pageNumber}-${index++}`,
            type: 'formula-image',
            imageData: documentBlock.imageData,
            alt,
            sourceName,
          });
        }
        return;
      }
      const sourceId = `${sourceName}:page-${page.pageNumber}`;
      if (documentBlock.kind === 'table' && documentBlock.rows && documentBlock.rows.length >= 2) {
        const [header, ...rows] = documentBlock.rows;
        if (header.length && rows.every((row) => row.length === header.length)) {
          blocks.push({
            id: `document-table-${page.pageNumber}-${index++}`,
            type: 'visual',
            visual: {
              type: 'table',
              title: lines[0] && lines[0] !== header.join(' | ') ? lines[0] : undefined,
              sourceId,
              sourcePage: page.pageNumber,
              sourceLabel: sourceName,
              columns: header,
              rows,
            },
            sourceId,
          });
          return;
        }
      }
      if (documentBlock.kind === 'list' && lines.length) {
        blocks.push({
          id: `document-list-${page.pageNumber}-${index++}`,
          type: 'markdown',
          markdown: lines.map((line) => `- ${line.replace(/^[-*•]\s*/, '')}`).join('\n'),
          sourceName,
          sourceId,
        });
        return;
      }
      if (documentBlock.kind === 'heading' && lines.length) {
        blocks.push({ id: `document-heading-${page.pageNumber}-${index++}`, type: 'heading', level: 2, text: lines.join(' ') });
        return;
      }
      if (documentBlock.kind === 'code' && lines.length) {
        blocks.push({ id: `document-code-${page.pageNumber}-${index++}`, type: 'code', language: 'text', code: lines.join('\n'), sourceId });
        return;
      }
      let lineIndex = 0;
      while (lineIndex < lines.length) {
        const line = lines[lineIndex];
        if (documentChrome(line, page, documentBlock.y)) {
          lineIndex += 1;
          continue;
        }
        const combinedSection = /^\d+$/.test(line) && lines[lineIndex + 1] ? `${line} ${lines[lineIndex + 1]}` : line;
        const heading = documentHeading(combinedSection);
        if (heading) {
          blocks.push({ id: `document-heading-${page.pageNumber}-${index++}`, type: 'heading', ...heading });
          lineIndex += combinedSection === line ? 1 : 2;
          continue;
        }
        const label = isDocumentHeadingToken(line);
        if (label) {
          blocks.push({ id: `document-heading-${page.pageNumber}-${index++}`, type: 'heading', level: 2, text: line });
          lineIndex += 1;
          continue;
        }
        const paragraphLines = [line];
        lineIndex += 1;
        while (lineIndex < lines.length && !documentHeading(lines[lineIndex]) && !documentChrome(lines[lineIndex], page, documentBlock.y)) {
          paragraphLines.push(lines[lineIndex]);
          lineIndex += 1;
        }
        blocks.push({
          id: `document-paragraph-${page.pageNumber}-${index++}`,
          type: 'paragraph',
          text: joinDocumentParagraphLines(paragraphLines),
          speaker: sourceName,
        });
      }
    });
  });
  return {
    id: `course-note:${lesson.id}`,
    title: lesson.title,
    subject: lesson.subject,
    chapter: lesson.chapter,
    folderPath: ['Courses', lesson.subject, lesson.chapter, lesson.title],
    fileName: `${slug(lesson.title)}-course-notes.md`,
    updatedAt: now(),
    ...(lesson.sublesson ? { sublesson: lesson.sublesson } : {}),
    detection: { method: 'active course', confidence: 1, basis: `Imported from ${sourceName} with layout-aware text extraction (${DOCUMENT_NOTE_LAYOUT_VERSION}).` },
    blocks,
  };
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

function parseDocumentResult(content: string, sourceIds: Set<string>): { markdown: string; visuals: VisualBlock[] } | null {
  const candidates = [
    content.trim(),
    content.match(/```(?:json)?\s*([\s\S]*?)```/i)?.[1] ?? '',
    content.match(/\{[\s\S]*\}/)?.[0] ?? '',
  ];
  for (const candidate of candidates) {
    if (!candidate) continue;
    try {
      const parsed = JSON.parse(candidate) as Record<string, unknown>;
      if (typeof parsed.markdown === 'string' && parsed.markdown.trim()) {
        const visuals = parsed.visuals === undefined
          ? []
          : parseVisualEnvelope(JSON.stringify({ visuals: parsed.visuals }), sourceIds);
        if (visuals === null) return null;
        return { markdown: parsed.markdown.trim(), visuals };
      }
    } catch {
      // Try the next common provider wrapper.
    }
  }
  return null;
}

export async function formatDocumentCourseNoteWithProvider(
  lesson: Lesson,
  pages: DocumentPage[],
  sourceName: string,
  provider: LLMProvider | null | undefined,
  now: () => string = () => new Date().toISOString(),
): Promise<CourseNote> {
  const fallback = buildDocumentCourseNote(lesson, pages, sourceName, now);
  if (!provider || !pages.length) return fallback;
  const evidence = pages
    .slice()
    .sort((left, right) => left.pageNumber - right.pageNumber)
    .map((page) => `SOURCE ${sourceName}:page-${page.pageNumber} | PAGE ${page.pageNumber}\n${page.blocks.length ? page.blocks.slice().sort((left, right) => left.y - right.y || left.x - right.x).map((block) => block.text).join('\n') : page.text}`)
    .join('\n\n')
    .slice(0, 60_000);
  const sourceIds = new Set(pages.map((page) => `${sourceName}:page-${page.pageNumber}`));
  try {
    const result = await provider.generate([
      {
        role: 'system',
        content: [
          'Reconstruct a source-faithful study note from the extracted document text below.',
          'Return only valid JSON matching the supplied schema, with one Markdown string.',
          'Preserve all meaningful source content and its order. Do not summarize, invent, or correct facts without evidence.',
          'Use clean GitHub-Flavored Markdown: headings, paragraphs, lists, Markdown tables, and fenced code blocks when the source contains code.',
          'Convert mathematical expressions into valid LaTeX using $...$ for inline math and $$...$$ on its own lines for display math.',
          'Return a visuals array when the source contains a clearly supported chart, table, or diagram. Each visual must cite the exact SOURCE id from the evidence. Use chart for numeric values, table for tabular data, and diagram for explicit node relationships. Never invent coordinates, values, nodes, or edges.',
          'Never use image Markdown, HTML, or colored text. If an equation cannot be reconstructed confidently, keep its extracted source as plain text instead of guessing.',
          `Document source: ${sourceName}`,
          'BEGIN EXTRACTED DOCUMENT',
          evidence,
          'END EXTRACTED DOCUMENT',
        ].join('\n'),
      },
      { role: 'user', content: 'Return the complete, readable Markdown note.' },
    ], { responseFormat: documentMarkdownResponseFormat, maxTokens: 8_192 });
    const parsed = parseDocumentResult(result.content, sourceIds);
    if (!parsed) return fallback;
    return {
      ...fallback,
      updatedAt: now(),
      detection: { method: 'LM Studio', confidence: 0.88, basis: `LM Studio reconstructed the document as semantic Markdown with ${result.model}.` },
      blocks: [
        ...fallback.blocks.filter((block) => block.id === 'note-title' || block.id === 'document-source-title' || block.id === 'note-context'),
        { id: 'document-semantic-markdown', type: 'markdown', markdown: parsed.markdown, sourceName },
        ...parsed.visuals.map((visual, index) => ({ id: `document-visual-${index}`, type: 'visual' as const, visual, sourceId: visual.sourceId })),
      ],
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
    if (block.type === 'markdown') return block.markdown;
    if (block.type === 'paragraph') return `${block.timestamp ? `**${block.timestamp} · ${block.speaker ?? 'Lecture'}**\n` : ''}${block.text}`;
    if (block.type === 'formula') return `${block.caption ? `_${block.caption}_\n` : ''}${block.latex}`;
    if (block.type === 'formula-image') return `[Formula from ${block.sourceName}: ${block.alt}]`;
    if (block.type === 'code') return `\`\`\`${block.language}\n${block.code}\n\`\`\``;
    if (block.type === 'schema') return `Schema: ${block.edges.map((edge) => `${edge.from} -> ${edge.to}`).join(', ')}`;
    if (block.type === 'visual') {
      if (block.visual.type === 'chart') return `Chart: ${block.visual.title ?? 'Values'}\n${block.visual.values.map((item) => `- ${item.label}: ${item.value}`).join('\n')}`;
      if (block.visual.type === 'table') return `${block.visual.title ? `${block.visual.title}\n` : ''}| ${block.visual.columns.join(' | ')} |\n| ${block.visual.columns.map(() => '---').join(' | ')} |\n${block.visual.rows.map((row) => `| ${row.join(' | ')} |`).join('\n')}`;
      return `Diagram: ${block.visual.title ?? 'Relationships'}\n${block.visual.edges.map((edge) => `- ${edge.from} -> ${edge.to}${edge.label ? ` (${edge.label})` : ''}`).join('\n')}`;
    }
    return `### ${block.label}\n${block.values.map((item) => `- ${item.label}: ${item.value}`).join('\n')}`;
  }).join('\n\n');
}
