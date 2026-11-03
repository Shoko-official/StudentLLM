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
export interface VisualJob { brief: VisualBrief; section: string; initialOutput?: string; learnerMessage?: string }
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

/** Rewrites the JSON of each visual fence of an answer. The rest of the answer is left as it is. */
export function repairVisualFences(markdown: string, repair: (raw: string) => string) {
  return applyEdits(markdown, scanFences(markdown).fences.flatMap((fence) => {
    const raw = repair(fence.raw);
    return raw === fence.raw ? [] : [{ start: fence.start, end: fence.end, text: fenceText(fence.language, raw) }];
  }));
}

/** The answer without its visual fences, valid or not: what is left is the text the model wrote. */
export function withoutVisualFences(markdown: string) {
  return applyEdits(markdown, scanFences(markdown).fences.map(({ start, end }) => ({ start, end, text: '' })));
}

export function jobFromMarkdown(markdown: string, id: string): VisualJob | null {
  return jobsOf(markdown, new Map()).find((job) => job.brief.id === id) ?? null;
}

/** True when the prepared markdown holds a request or a direct fence; quoted and demoted fences do not count. */
export function hasVisualFence(markdown: string) { return scanFences(markdown).fences.length > 0; }

const QUIZ_LABEL = /^(?:(?:\*\*|__)\s*(?:quiz|qcm)\s*:?\s*(?:\*\*|__)\s*:?|(?:quiz|qcm)\s*:|(?:quiz|qcm)[ \t]*(?=\r?\n|$))\s*/i;
const QUIZ_CHOICES = /(?:^|\s)(?:(?:choix|choices|options?|propositions?)\s*:|[A-Da-d][).]\s)/i;
const QUIZ_ANSWER = /(?:^|\s)(?:correction|corrig[ée]|r[ée]ponse|answer|solution)\s*:/i;
const GIVES_A_REASON = /\b(?:parce que|because|car|donc|puisque|therefore|since|ce qui|which)\b/i;
const QUESTION_CHARACTERS = 400, CHOICES_CHARACTERS = 300, ANSWER_CHARACTERS = 120;

/** A question at the end of a short text that explains nothing. */
const isQuizQuestion = (text: string) => text.trim().endsWith('?') && text.length <= QUESTION_CHARACTERS && !GIVES_A_REASON.test(text);
const isShortAnswer = (text: string) => text.length <= ANSWER_CHARACTERS && !GIVES_A_REASON.test(text);

/** A question followed by its choices and at most a short correction, with no sentence of explanation among them. */
function holdsQuiz(text: string) {
  const choices = QUIZ_CHOICES.exec(text);
  if (!choices || !isQuizQuestion(text.slice(0, choices.index))) return false;
  const rest = text.slice(choices.index);
  const answer = QUIZ_ANSWER.exec(rest);
  const listed = answer ? rest.slice(0, answer.index) : rest;
  return listed.length <= CHOICES_CHARACTERS && !GIVES_A_REASON.test(listed) && (!answer || isShortAnswer(rest.slice(answer.index)));
}

/**
 * Removes a quiz the tutor wrote in its prose when a quiz block takes over: only a top-level paragraph or heading labelled
 * Quiz or QCM that really holds answer choices, with what directly follows if that is only choices or a short labelled
 * answer. Anything else stays, so an explanation is never taken, and the prose is never emptied.
 */
function withoutProseQuiz(markdown: string) {
  const nodes = (fromMarkdown(markdown) as unknown as MarkdownNode).children ?? [];
  const source = (node: MarkdownNode | undefined) => (node ? markdown.slice(node.position?.start.offset ?? 0, node.position?.end.offset ?? 0) : '');
  const paragraph = (index: number) => (nodes[index]?.type === 'paragraph' ? source(nodes[index]) : '');
  const onlyChoices = (index: number) => {
    const text = paragraph(index), found = QUIZ_CHOICES.exec(text);
    return found !== null && !text.slice(0, found.index).trim() && text.length <= CHOICES_CHARACTERS && !GIVES_A_REASON.test(text);
  };
  const removed = new Set<number>();
  nodes.forEach((node, index) => {
    if (node.type !== 'paragraph' && node.type !== 'heading') return;
    const text = source(node).replace(/^#+\s*/, '');
    const label = QUIZ_LABEL.exec(text);
    if (!label) return;
    const own = text.slice(label[0].length).trim();
    if (own && node.type !== 'paragraph') return;
    // The quiz is this paragraph, or under a label alone, the paragraph after it.
    const quiz = own ? index : index + 1;
    const body = own || paragraph(quiz);
    if (!holdsQuiz(body) && !(isQuizQuestion(body) && onlyChoices(quiz + 1))) return;
    let end = quiz + 1;
    while (onlyChoices(end)) end++;
    const after = paragraph(end);
    if (QUIZ_ANSWER.exec(after)?.index === 0 && isShortAnswer(after)) end++;
    // Choices left in a list under the question would make no sense on their own.
    if (nodes[end]?.type === 'list') return;
    for (let at = index; at < end; at++) removed.add(at);
  });
  const kept = nodes.filter((node, index) => !removed.has(index) && !(node.type === 'code' && (node.lang === REQUEST || node.lang === DIRECT)));
  if (!removed.size || !kept.length) return markdown;
  return applyEdits(markdown, [...removed].map((index) => ({ start: nodes[index].position?.start.offset ?? 0, end: nodes[index + 1]?.position?.start.offset ?? markdown.length, text: '' })));
}

export function appendVisualRequest(markdown: string, brief: VisualBrief): { markdown: string; job: VisualJob | null } {
  const next = (brief.type === 'quiz' ? withoutProseQuiz(markdown) : markdown).trimEnd() + '\n\n' + fenceText(REQUEST, JSON.stringify(brief));
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
const ARTICLE = "(?:un|une|le|la|les|l'|des|a|an|the|some|ce|cette|this|these)";
const REFUSES_VISUAL = [
  new RegExp(`\\bsans\\b[^.!?;\\n]{0,30}\\b(?:${VISUAL_NOUNS})\\b`),
  new RegExp(`\\bpas\\s+(?:de|d')\\s*(?:\\w+\\s+){0,2}(?:${VISUAL_NOUNS})\\b`),
  new RegExp(`(?:^|[,;]\\s*|\\bmais\\s+|\\bet\\s+)pas\\s+${ARTICLE}\\s*(?:\\w+\\s+)?(?:${VISUAL_NOUNS})\\b`),
  new RegExp(`(?:^|[,;]\\s*|\\bbut\\s+)not\\s+(?:a|an|the)\\s+(?:\\w+\\s+)?(?:${VISUAL_NOUNS})\\b`),
  new RegExp(`\\bplutot\\b[^.!?;\\n]{0,40}\\bqu(?:'|e\\s)\\s*(?:\\w+\\s+)?(?:${VISUAL_NOUNS})\\b`),
  new RegExp(`\\b(?:no|without)\\b[^.!?;\\n]{0,25}\\b(?:${VISUAL_NOUNS})\\b`),
  new RegExp(`\\b(?:instead of|rather than|plutot qu|au lieu d)\\b[^.!?;\\n]{0,25}\\b(?:${VISUAL_NOUNS})\\b`),
  new RegExp(`\\b(?:do not|don't|dont)\\s+(?:want|need)\\b[^.!?;\\n]{0,25}\\b(?:${VISUAL_NOUNS})\\b`),
  new RegExp(`\\b(?:ne veux pas|pas besoin)\\b[^.!?;\\n]{0,25}\\b(?:${VISUAL_NOUNS})\\b`),
  /\b(?:do not|don't|dont|never|stop)\s+(?:draw|plot|sketch|display)\b/,
  /\bne\s+(?:me\s+)?(?:dessin|trac|affich)\w*\s+pas\b/,
  // "Don't use jargon" and "ne me montre pas la solution" refuse nothing visual: these verbs count only with a visual noun.
  new RegExp(`\\b(?:do not|don't|dont|never|stop)\\s+(?:show|make|use)\\b[^.!?;\\n]{0,25}\\b(?:${VISUAL_NOUNS})\\b`),
  new RegExp(`\\bne\\s+(?:me\\s+)?(?:montr|fais)\\w*\\s+pas\\b[^.!?;\\n]{0,25}\\b(?:${VISUAL_NOUNS})\\b`),
  /\bjuste le texte\b|\btext only\b|\bonly text\b|\btexte (?:seulement|uniquement)\b/,
];

/** Lower case, without accents, code and image references: what the detectors read. */
function plainMessage(text: string) {
  let plain = text;
  for (const range of codeRanges(text).sort((a, b) => b.start - a.start)) plain = plain.slice(0, range.start) + ' ' + plain.slice(range.end);
  return plain.replace(/`[^`]*`/g, ' ').replace(/!\[[^\]]*\]\([^)]*\)/g, ' ').normalize('NFD').replace(/\p{M}/gu, '').replace(/[‘’]/g, "'").toLowerCase();
}

/** Whether a learner message refuses visuals (French or English), including in contrast: "not a diagram", "instead of a chart". */
export function refusesVisual(text: string): boolean {
  const plain = plainMessage(text);
  return REFUSES_VISUAL.some((pattern) => pattern.test(plain));
}

// Each family of words and the block types that can stand for it, the one to ask for first. Schemas, figures and diagrams
// stand for one another, and a graph can be a chart or a network. A specific form goes first: a bar diagram is a chart, and
// a flowchart is not.
const ARTEFACT_FAMILIES: { words: string; types: VisualType[] }[] = [
  { words: "flow[- ]?charts?|organigrammes?|logigrammes?|arbres?|trees?|mind[- ]?maps?|concept[- ]maps?|cartes?\\s+(?:mentales?|conceptuelles?)", types: ['diagram'] },
  { words: "diagrammes?\\s+(?:en\\s+(?:barres?|batons?|secteurs?)|circulaires?)|graphiques?|grafiques?|courbes?|histogrammes?|plots?|plotted|plotting|charts?|curves?|histograms?", types: ['plot'] },
  { words: "graphes?|graphs?|graphing", types: ['plot', 'diagram'] },
  { words: "schemas?|shemas?|schematiques?|schematics?|diagrammes?|diagrames?|diagrams?", types: ['diagram', 'figure'] },
  { words: "figures?|dessins?|croquis|illustrations?|drawings?|sketches|pictures?|visuels?|visuals?|visuali[sz]ations?", types: ['figure', 'diagram'] },
  { words: "quizz?(?:es|zes|s)?|quizzing|qcm|qcu|mcqs?|questions?\\s+a\\s+choix\\s+multiples?|multiple[- ]choice|(?:teste|testez|interroge|interrogez|questionne|questionnez)[ -](?:moi|nous)|test\\s+(?:me|us|my)|teste\\s+mes\\s+connaissances|test[ -]moi|pose[ -]moi\\s+(?:une|des)\\s+questions?|ask\\s+me\\s+(?:a|some)\\s+questions?", types: ['quiz'] },
];
// A drawing verb only says how: "Draw a plot" is one plot. So these count only in a clause with no word above.
const ARTEFACT_VERBS: { words: string; types: VisualType[] }[] = [
  { words: "trace[rz]?|traces", types: ['plot', 'diagram'] },
  { words: "dessine[rz]?|dessines|dessinons|draw|sketch|illustre[rz]?|illustrate|visuali[sz]e[rz]?|visualisons", types: ['figure', 'diagram'] },
  { words: "schematise", types: ['diagram', 'figure'] },
  { words: "represente", types: ['plot', 'diagram', 'figure'] },
];
const COUNTS: Record<string, number> = { deux: 2, two: 2, 2: 2, trois: 3, three: 3, 3: 3, quatre: 4, four: 4, 4: 4 };
const artefactWord = (families: typeof ARTEFACT_FAMILIES) => new RegExp(`(?<![\\p{L}\\d])(?:(?<count>${Object.keys(COUNTS).join('|')})\\s+(?:[\\p{L}'-]+\\s+)?)?(?:${families.map(({ words }, index) => `(?<family${index}>${words})`).join('|')})(?![\\p{L}\\d])`, 'gu');
const ARTEFACT_WORD = artefactWord(ARTEFACT_FAMILIES), ARTEFACT_VERB = artefactWord(ARTEFACT_VERBS);
const CLAUSE_BREAK = /[.!?;,\r\n]+|(?<![\p{L}\d])(?:and|then|puis|et)(?![\p{L}\d])/u;

export interface NamedArtefact { type: VisualType; count: number; also?: VisualType[] }

/**
 * The artefact families a learner message has a word for, in the order of the message. This is a gate and nothing more: it
 * cannot tell a request from a refusal, a past mention or a topic, and it does not try to. A family it finds gets a decision
 * call, and that call may decline. A message with none of these words costs no call. Curves live inside a plot, so they
 * never count as plots.
 */
export function namedArtefacts(text: string): NamedArtefact[] {
  const found = new Map<VisualType, { count: number; also: VisualType[] }>();
  for (const clause of plainMessage(text).split(CLAUSE_BREAK)) {
    const nouns = [...clause.matchAll(ARTEFACT_WORD)];
    const families = nouns.length ? ARTEFACT_FAMILIES : ARTEFACT_VERBS;
    for (const { groups } of nouns.length ? nouns : clause.matchAll(ARTEFACT_VERB)) {
      const index = families.findIndex((_, at) => groups![`family${at}`] !== undefined);
      const [type, ...also] = families[index].types;
      const count = /^(?:courbes?|curves?)$/.test(groups![`family${index}`]) ? 1 : COUNTS[groups!.count ?? ''] ?? 1;
      const known = found.get(type);
      found.set(type, { count: Math.max(known?.count ?? 1, count), also: [...new Set([...(known?.also ?? []), ...also])] });
    }
  }
  return [...found].map(([type, { count, also }]) => ({ type, count, ...(also.length ? { also } : {}) }));
}

function visualTypesIn(markdown: string): VisualType[] {
  return scanFences(markdown).fences.flatMap((fence) => {
    const type = fence.language === REQUEST ? parseVisualBrief(fence.raw)?.type : parseTeachingVisual(fence.raw)?.type;
    return type ? [type] : [];
  });
}

/**
 * What the latest learner message names and the prepared answer does not hold, as far as the limit of automatic visuals
 * allows: for each, the types that would do. A block of another type a word can mean satisfies it, so "un seul schéma" with a figure stays at one block.
 */
export function missingArtefacts(question: string, markdown: string): VisualType[][] {
  const held = visualTypesIn(markdown);
  const free = [...held];
  const take = (types: VisualType[]) => {
    const index = free.findIndex((type) => types.includes(type));
    if (index >= 0) free.splice(index, 1);
    return index >= 0;
  };
  const wanted = namedArtefacts(question).flatMap(({ type, also, count }) => Array.from({ length: count }, () => [type, ...(also ?? [])]));
  // The exact type is taken first, so "a graph and a diagram" does not spend the diagram on the graph.
  const missing = wanted.filter((types) => !take(types.slice(0, 1))).filter((types) => !take(types.slice(1)));
  return missing.slice(0, Math.max(0, MAX_AUTOMATIC_VISUALS - held.length));
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
