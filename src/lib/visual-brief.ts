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

export function prepareTutorMarkdown(input: string): { markdown: string; jobs: VisualJob[] } {
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

/** History keeps what a follow-up needs, without replaying JSON the model could learn to copy. */
export function compactVisualFences(content: string) {
  if (!content.includes(DIRECT)) return content;
  const edits: Edit[] = [];
  for (const fence of scanFences(content).fences) {
    if (fence.language === REQUEST) {
      const brief = parseVisualBrief(fence.raw);
      if (brief) edits.push({ start: fence.start, end: fence.end, text: `[Visual not generated: ${brief.intent}]` });
    } else {
      const visual = parseTeachingVisual(fence.raw);
      if (visual) edits.push({ start: fence.start, end: fence.end, text: `[Visual shown to the learner: ${describeVisual(visual)}]` });
    }
  }
  return applyEdits(content, edits);
}
