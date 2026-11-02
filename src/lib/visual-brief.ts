import { fromMarkdown } from 'mdast-util-from-markdown';
import { redactContextImages } from './context-text';
import { diagnoseTeachingVisual, parseTeachingVisual, type TeachingVisual } from './teaching-visuals';

export const VISUAL_TYPES = ['plot', 'diagram', 'figure', 'quiz'] as const;
export type VisualType = typeof VISUAL_TYPES[number];
export interface VisualCheck { output: string; at: Record<string, number>; expected: number; tolerance?: number }
export interface VisualBrief {
  id: string; type: VisualType; intent: string; content: string;
  parameters?: string[]; outputs?: string[]; checks?: VisualCheck[]; nodes?: string[]; correctAnswer?: string;
}
export interface VisualJob { brief: VisualBrief; section: string; initialOutput?: string }
export const MAX_AUTOMATIC_VISUALS = 4;

const REQUEST = 'student-visual-request';
const DIRECT = 'student-visual';
const VISUAL_NOTES = { notGenerated: '[Visual not generated:', shown: '[Visual shown to the learner:' };
const NOTE_PREFIXES = Object.values(VISUAL_NOTES);

function record(value: unknown): value is Record<string, unknown> { return !!value && typeof value === 'object' && !Array.isArray(value); }
function shortText(value: unknown, limit: number): value is string { return typeof value === 'string' && !!value.trim() && value.length <= limit; }
function names(value: unknown): value is string[] { return Array.isArray(value) && value.length <= 8 && value.every((item) => shortText(item, 100)); }
function check(value: unknown): value is VisualCheck {
  return record(value) && shortText(value.output, 100) && typeof value.expected === 'number' && Number.isFinite(value.expected)
    && (value.tolerance === undefined || (typeof value.tolerance === 'number' && value.tolerance >= 0))
    && record(value.at) && Object.values(value.at).every((item) => typeof item === 'number' && Number.isFinite(item));
}

export function parseVisualBrief(raw: string): VisualBrief | null {
  if (raw.length > 8192) return null;
  let value: unknown;
  try { value = JSON.parse(raw); } catch { return null; }
  if (!record(value) || typeof value.id !== 'string' || !/^[A-Za-z0-9_-]{1,32}$/.test(value.id)) return null;
  if (!VISUAL_TYPES.includes(value.type as VisualType) || !shortText(value.intent, 300) || !shortText(value.content, 1500)) return null;
  for (const key of ['parameters', 'outputs', 'nodes'] as const) if (value[key] !== undefined && !names(value[key])) return null;
  if (value.checks !== undefined && (!Array.isArray(value.checks) || value.checks.length > 8 || !value.checks.every(check))) return null;
  if (value.correctAnswer !== undefined && !shortText(value.correctAnswer, 500)) return null;
  return {
    id: value.id, type: value.type as VisualType, intent: value.intent, content: value.content,
    ...(value.parameters === undefined ? {} : { parameters: value.parameters as string[] }),
    ...(value.outputs === undefined ? {} : { outputs: value.outputs as string[] }),
    ...(value.checks === undefined ? {} : { checks: value.checks as VisualCheck[] }),
    ...(value.nodes === undefined ? {} : { nodes: value.nodes as string[] }),
    ...(value.correctAnswer === undefined ? {} : { correctAnswer: value.correctAnswer as string }),
  };
}

interface MarkdownNode { type: string; lang?: string | null; value?: string; position?: { start: { offset?: number }; end: { offset?: number } }; children?: MarkdownNode[] }
interface Fence { language: string; raw: string; start: number; end: number }
interface Edit { start: number; end: number; text: string }

function applyEdits(markdown: string, edits: Edit[]) {
  for (const edit of [...edits].sort((a, b) => b.start - a.start)) markdown = markdown.slice(0, edit.start) + edit.text + markdown.slice(edit.end);
  return markdown;
}

/** Reads the actual Markdown AST: a fence quoted inside a code sample is never treated as a visual. */
function scanFences(markdown: string) {
  const fences: Fence[] = [];
  const demotions: Edit[] = [];
  const root = fromMarkdown(markdown) as unknown as MarkdownNode;
  const visit = (node: MarkdownNode, topLevel: boolean) => {
    for (const child of node.children ?? []) visit(child, false);
    if (node.type !== 'code' || typeof node.lang !== 'string') return;
    const start = node.position?.start.offset, end = node.position?.end.offset;
    if (start === undefined || end === undefined) return;
    const newline = markdown.indexOf('\n', start);
    const opening = /^([ \t]*)(`{3,}|~{3,})([^\r\n]*)/.exec(markdown.slice(start, newline === -1 ? markdown.length : newline));
    if (!opening) return;
    const language = opening[3].trim().split(/\s+/, 1)[0];
    const plain = /^[A-Za-z0-9_+.#-]+$/.test(language);
    const visual = language === REQUEST || language === DIRECT;
    // Only plain language names are retained; escapes and entities cannot smuggle an interactive language.
    if (plain && !visual) return;
    if (visual && topLevel) { fences.push({ language, raw: node.value ?? '', start, end }); return; }
    demotions.push({ start: start + opening[1].length + opening[2].length, end: start + opening[0].length, text: 'text' });
  };
  for (const child of root.children ?? []) visit(child, true);
  return { fences, demotions };
}

function codeRanges(markdown: string) {
  const ranges: { start: number; end: number }[] = [];
  const visit = (node: MarkdownNode) => {
    for (const child of node.children ?? []) visit(child);
    const start = node.position?.start.offset, end = node.position?.end.offset;
    if (node.type === 'code' && start !== undefined && end !== undefined) ranges.push({ start, end });
  };
  visit(fromMarkdown(markdown) as unknown as MarkdownNode);
  return ranges;
}

/** A model that sees these notes in its history copies them, so a line that is only a note never belongs in an answer. */
export function stripVisualNotes(markdown: string) {
  if (!NOTE_PREFIXES.some((prefix) => markdown.includes(prefix))) return markdown;
  const code = codeRanges(markdown);
  let kept = '', offset = 0, afterNote = false, afterBlank = true;
  for (const line of markdown.match(/[^\r\n]*(?:\r\n?|\n)|[^\r\n]+$/g) ?? []) {
    const start = offset, text = line.trim();
    offset += line.length;
    if (text.endsWith(']') && NOTE_PREFIXES.some((prefix) => text.startsWith(prefix)) && !code.some((range) => range.start <= start && start < range.end)) { afterNote = true; continue; }
    if (afterNote && afterBlank && !text) continue;
    kept += line;
    afterBlank = !text;
    if (text) afterNote = false;
  }
  return afterNote ? kept.trimEnd() : kept;
}

function fenceText(language: string, body: string) {
  // A body may hold its own backtick runs; the fence must be strictly longer than any of them.
  const longest = Math.max(0, ...(body.match(/`+/g) ?? []).map((run) => run.length));
  const fence = '`'.repeat(Math.max(3, longest + 1));
  return fence + language + '\n' + body + '\n' + fence;
}
export function visualFence(visual: TeachingVisual) { return fenceText(DIRECT, JSON.stringify(visual)); }

function sectionAround(markdown: string, fences: Fence[], target: Fence) {
  const without = (start: number, end: number) => {
    let text = '';
    let cursor = start;
    for (const fence of fences) {
      if (fence.end <= start || fence.start >= end) continue;
      text += markdown.slice(cursor, fence.start);
      cursor = fence.end;
    }
    return text + markdown.slice(cursor, end);
  };
  const before = redactContextImages(without(0, target.start)).trim().slice(-1200);
  const after = redactContextImages(without(target.end, markdown.length)).trim().slice(0, 400);
  return `${before}\n\n[the requested visual appears here]\n\n${after}`.trim();
}

function jobsOf(markdown: string, outputs: Map<string, string>): VisualJob[] {
  const { fences } = scanFences(markdown);
  return fences.flatMap((fence) => {
    const brief = fence.language === REQUEST ? parseVisualBrief(fence.raw) : null;
    if (!brief) return [];
    const initialOutput = outputs.get(brief.id);
    return [{ brief, section: sectionAround(markdown, fences, fence), ...(initialOutput === undefined ? {} : { initialOutput }) }];
  });
}

export function prepareTutorMarkdown(answer: string): { markdown: string; jobs: VisualJob[] } {
  const input = stripVisualNotes(answer);
  const { fences, demotions } = scanFences(input);
  const edits = [...demotions];
  const seen = new Set<string>();
  const outputs = new Map<string, string>();
  const demote = (fence: Fence) => edits.push({ start: fence.start, end: fence.end, text: fenceText('text', fence.raw) });
  fences.forEach((fence, index) => {
    if (fence.language === REQUEST) {
      const brief = parseVisualBrief(fence.raw);
      if (!brief || seen.has(brief.id)) demote(fence);
      else seen.add(brief.id);
      return;
    }
    const { visual } = diagnoseTeachingVisual(fence.raw);
    if (visual) { edits.push({ start: fence.start, end: fence.end, text: visualFence(visual) }); return; }
    let type: unknown;
    try { type = (JSON.parse(fence.raw) as { type?: unknown }).type; } catch { /* Unreadable output has no type to repair. */ }
    if (!VISUAL_TYPES.includes(type as VisualType)) { demote(fence); return; }
    let id = `direct-${index + 1}`;
    for (let n = 2; seen.has(id); n++) id = `direct-${index + 1}-${n}`;
    outputs.set(id, fence.raw);
    seen.add(id);
    const brief: VisualBrief = { id, type: type as VisualType, intent: 'Correct the supplied visual so that it renders', content: fence.raw.slice(0, 1500) };
    edits.push({ start: fence.start, end: fence.end, text: fenceText(REQUEST, JSON.stringify(brief)) });
  });
  const markdown = applyEdits(input, edits);
  return { markdown, jobs: jobsOf(markdown, outputs) };
}

export function jobFromMarkdown(markdown: string, id: string): VisualJob | null {
  return jobsOf(markdown, new Map()).find((job) => job.brief.id === id) ?? null;
}

/** True when the prepared markdown holds a request or a direct fence; quoted and demoted fences do not count. */
export function hasVisualFence(markdown: string) { return scanFences(markdown).fences.length > 0; }

export function appendVisualRequest(markdown: string, brief: VisualBrief): { markdown: string; job: VisualJob | null } {
  const next = markdown.trimEnd() + '\n\n' + fenceText(REQUEST, JSON.stringify(brief));
  return { markdown: next, job: jobFromMarkdown(next, brief.id) };
}

export function replaceVisualFence(markdown: string, id: string, replacement: string) {
  const target = scanFences(markdown).fences.find((fence) => fence.language === REQUEST && parseVisualBrief(fence.raw)?.id === id);
  return target ? markdown.slice(0, target.start) + replacement + markdown.slice(target.end) : markdown;
}

/** What may be shown of an answer still arriving. The AST ends an unclosed fence at the end of the text, so it is removed the same way. */
export function streamingPreview(answer: string) {
  const noteStart = Math.max(answer.lastIndexOf('\n'), answer.lastIndexOf('\r')) + 1;
  const tail = answer.slice(noteStart).trimStart();
  const mayBecomeNote = !!tail && NOTE_PREFIXES.some((prefix) => prefix.startsWith(tail) || tail.startsWith(prefix));
  const held = mayBecomeNote && !codeRanges(answer).some((range) => range.start <= noteStart && noteStart < range.end);
  const text = stripVisualNotes(held ? answer.slice(0, noteStart) : answer);
  const lastLine = Math.max(text.lastIndexOf('\n'), text.lastIndexOf('\r')) + 1;
  const mayBecomeFence = /^ {0,3}(?:`{3,}|~{3,})/.test(text.slice(lastLine));
  const edits: Edit[] = [];
  const visit = (node: MarkdownNode) => {
    for (const child of node.children ?? []) visit(child);
    const start = node.position?.start.offset, end = node.position?.end.offset;
    if (node.type !== 'code' || start === undefined || end === undefined) return;
    const language = node.lang ?? '';
    if (language === REQUEST || language === DIRECT || (mayBecomeFence && start >= lastLine && REQUEST.startsWith(language))) edits.push({ start, end, text: '' });
  };
  visit(fromMarkdown(text) as unknown as MarkdownNode);
  return applyEdits(text, edits);
}

function describeVisual(visual: TeachingVisual) {
  if (visual.type === 'plot') {
    const parameters = (visual.parameters ?? []).map((item) => `${item.name} from ${item.min} to ${item.max} step ${item.step}, initial ${item.value}`);
    const series = visual.series.map((item) => `${item.label} = ${item.expression ?? 'supplied points'}`);
    const outputs = (visual.outputs ?? []).map((item) => `${item.label} = ${item.expression}`);
    return [`plot "${visual.title}", x from ${visual.x.min} to ${visual.x.max}`, parameters.length ? `parameters: ${parameters.join('; ')}` : '', `series: ${series.join('; ')}`, outputs.length ? `readouts: ${outputs.join('; ')}` : ''].filter(Boolean).join('. ');
  }
  if (visual.type === 'diagram') return `diagram "${visual.title}" with nodes: ${visual.nodes.slice(0, 12).map((node) => node.label).join(', ')}`;
  if (visual.type === 'figure') return `figure "${visual.title}"${visual.description ? `: ${visual.description}` : ''}`;
  return `quiz "${visual.title}": ${visual.question} correct option: ${visual.options[visual.answer]}`;
}

const EARLIER_VISUALS_LIMIT = 6;
const EARLIER_VISUAL_CHARACTERS = 300;

/** What the learner already saw, oldest first, so a later decision does not draw the same idea again. Requests never built are not visuals yet. */
export function describeEarlierVisuals(contents: string[]): string[] {
  const described: string[] = [];
  for (const content of contents) {
    if (!content.includes(DIRECT)) continue;
    for (const fence of scanFences(content).fences) {
      if (fence.language !== DIRECT) continue;
      const visual = parseTeachingVisual(fence.raw);
      // Cut by code points, so an emoji or other pair is never split.
      if (visual) described.push([...describeVisual(visual).replace(/\s*[\r\n]+\s*/g, ' ')].slice(0, EARLIER_VISUAL_CHARACTERS).join(''));
    }
  }
  return described.slice(-EARLIER_VISUALS_LIMIT);
}

const VISUAL_NOUNS = 'schemas?|diagrammes?|graphiques?|graphes?|courbes?|figures?|dessins?|illustrations?|visuels?|visualisations?|diagrams?|charts?|graphs?|curves?|plots?|pictures?|drawings?|sketch(?:es)?|visuals?';
const REQUEST_VERBS = 'montr(?:e|es|er|ez)|dessin(?:e|es|er|ez)|trac(?:e|es|er|ez)|fais|faire|faites|affich(?:e|es|er|ez)|gener(?:e|es|er|ez)|represent(?:e|es|er|ez)|donn(?:e|es|er|ez)|propos(?:e|es|er|ez)|construi(?:s|re|sez)|cre(?:e|es|er|ez)|ajout(?:e|es|er|ez)|show|shows|draw|plot|sketch|make|give|create|generate|display|illustrate|visuali[sz]e|add|include|produce|build';
const ASKS_FOR_VISUAL = new RegExp(`\\b(?:${REQUEST_VERBS})\\b[^.!?;\\n]{0,50}?\\b(?:${VISUAL_NOUNS})\\b`);
const REFUSES_VISUAL = [
  new RegExp(`\\bsans\\b[^.!?;\\n]{0,30}\\b(?:${VISUAL_NOUNS})\\b`),
  new RegExp(`\\bpas\\s+(?:de|d')\\s*(?:\\w+\\s+){0,2}(?:${VISUAL_NOUNS})\\b`),
  new RegExp(`\\b(?:no|without)\\b[^.!?;\\n]{0,25}\\b(?:${VISUAL_NOUNS})\\b`),
  /\b(?:do not|don't|dont|never|stop)\s+(?:draw|plot|sketch|show|make|display|use)/,
  /\bne\s+(?:me\s+)?(?:montr|dessin|trac|fais|affich)\w*\s+pas\b/,
  /\bjuste le texte\b|\btext only\b|\bonly text\b|\btexte (?:seulement|uniquement)\b/,
];

/**
 * Whether a learner message asks to see a visual (French or English): a request verb followed by an artefact noun, and no
 * refusal of visuals in the same message. Code and image references do not count, and a question about a thing is not a request.
 */
export function asksForVisual(text: string): boolean {
  let plain = text;
  for (const range of codeRanges(text).sort((a, b) => b.start - a.start)) plain = plain.slice(0, range.start) + ' ' + plain.slice(range.end);
  plain = plain.replace(/`[^`]*`/g, ' ').replace(/!\[[^\]]*\]\([^)]*\)/g, ' ').normalize('NFD').replace(/\p{M}/gu, '').replace(/[‘’]/g, "'").toLowerCase();
  return ASKS_FOR_VISUAL.test(plain) && !REFUSES_VISUAL.some((pattern) => pattern.test(plain));
}

/** History keeps what a follow-up needs, without replaying JSON the model could learn to copy. */
export function compactVisualFences(content: string) {
  const text = stripVisualNotes(content);
  if (!text.includes(DIRECT)) return text;
  const edits: Edit[] = [];
  for (const fence of scanFences(text).fences) {
    if (fence.language === REQUEST) {
      const gap = /^(?:[ \t]*(?:\r\n?|\n))*/.exec(text.slice(fence.end))?.[0].length ?? 0;
      if (parseVisualBrief(fence.raw)) edits.push({ start: fence.start, end: fence.end + gap, text: '' });
    } else {
      const visual = parseTeachingVisual(fence.raw);
      if (visual) edits.push({ start: fence.start, end: fence.end, text: `${VISUAL_NOTES.shown} ${describeVisual(visual).replace(/\s*[\r\n]+\s*/g, ' ')}]` });
    }
  }
  return edits.length ? applyEdits(text, edits).trimEnd() : text;
}
