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

export function jobFromMarkdown(markdown: string, id: string): VisualJob | null {
  return jobsOf(markdown, new Map()).find((job) => job.brief.id === id) ?? null;
}

/** True when the prepared markdown holds a request or a direct fence; quoted and demoted fences do not count. */
export function hasVisualFence(markdown: string) { return scanFences(markdown).fences.length > 0; }

const QUIZ_LABEL = /^(?:(?:\*\*|__)\s*(?:quiz|qcm)\s*:?\s*(?:\*\*|__)\s*:?|(?:quiz|qcm)\s*:|(?:quiz|qcm)[ \t]*(?=\r?\n|$))\s*/i;
const QUIZ_CONTENT = /\?|\b(?:choix|choices|options?|correction|answer|r[ée]ponse)\s*:/i;

/**
 * Removes a quiz the tutor wrote in its prose: only a top-level paragraph or heading labelled Quiz or QCM that holds a
 * question or choices, so an explanation is never taken. Used when a quiz block takes over, and never empties the prose.
 */
function withoutProseQuiz(markdown: string) {
  const nodes = (fromMarkdown(markdown) as unknown as MarkdownNode).children ?? [];
  const source = (node: MarkdownNode | undefined) => (node ? markdown.slice(node.position?.start.offset ?? 0, node.position?.end.offset ?? 0) : '');
  const removed = new Set<number>();
  nodes.forEach((node, index) => {
    if (node.type !== 'paragraph' && node.type !== 'heading') return;
    const text = source(node).replace(/^#+\s*/, '');
    const label = QUIZ_LABEL.exec(text);
    if (!label) return;
    const next = nodes[index + 1];
    if (next?.type === 'list') return;
    if (node.type === 'paragraph' && QUIZ_CONTENT.test(text.slice(label[0].length))) { removed.add(index); return; }
    // A label alone: the quiz is the paragraph under it.
    if (!text.slice(label[0].length).trim() && next?.type === 'paragraph' && QUIZ_CONTENT.test(source(next)) && nodes[index + 2]?.type !== 'list') { removed.add(index); removed.add(index + 1); }
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
// Verbs that mean "show a picture" by themselves: a noun a few words later is enough.
const VISUAL_VERBS = 'dessin(?:e|es|er|ez)|trac(?:e|es|er|ez)|affich(?:e|es|er|ez)|represent(?:e|es|er|ez)|illustr(?:e|es|er|ez)|draw|plot|sketch|display|illustrate|visuali[sz]e';
// Everyday verbs ("show that", "give the definition of"): only verb, article and noun together, with nothing like "que" or "of" before the noun.
const GENERIC_VERBS = 'montr(?:e|es|er|ez)|fais|faire|faites|donn(?:e|es|er|ez)|propos(?:e|es|er|ez)|construi(?:s|re|sez)|cre(?:e|es|er|ez)|ajout(?:e|es|er|ez)|gener(?:e|es|er|ez)|show|shows|make|give|create|generate|add|include|produce|build';
const ARTICLE = "(?:un|une|le|la|les|l'|des|a|an|the|some|ce|cette|this|these)";
const SIZE = '(?:(?:petit|petite|simple|quick|small|rapide|rapid|nouveau|nouvelle|new|bon|good)\\s+)?';
const ASKS_FOR_VISUAL = [
  new RegExp(`\\b(?:${VISUAL_VERBS})\\b[^.!?;\\n]{0,50}?\\b(?:${VISUAL_NOUNS})\\b`),
  new RegExp(`\\b(?:${GENERIC_VERBS})\\b(?:[ -](?:moi|toi|nous|lui|me|us|him|her|them|te))?\\s+${ARTICLE}\\s*${SIZE}(?:${VISUAL_NOUNS})\\b(?!\\s+(?:theory|theorie))`),
];
// "Make a chart in Python" asks for a program, not to be shown a picture; a diagram of some code is a real request.
const CODE_TOOLS = 'python|matplotlib|plotly|seaborn|pandas|numpy|ggplot|tikz|latex|excel|javascript|typescript|matlab|sql';
const CODE_REQUEST = new RegExp(`\\b(?:en|in|avec|with|using|via)\\s+(?:${CODE_TOOLS}|r)\\b`);
// Without the languages R and C: once lower-cased, "avec r de 0,2 a 1" is a variable far more often than a language. "In C" is the one reading kept.
const NAMED_CODE_REQUEST = new RegExp(`\\b(?:en|in|avec|with|using|via)\\s+(?:${CODE_TOOLS}|java|rust|php|react|html|css|c\\+\\+)(?![\\w+])|\\bin\\s+c\\b`);
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

/**
 * Whether a learner message asks to see a visual (French or English): a request verb followed by an artefact noun, and no
 * refusal of visuals in the same message. Code and image references do not count, a request for code does not count, and a
 * question about a thing is not a request.
 */
export function asksForVisual(text: string): boolean {
  const plain = plainMessage(text).replace(/\bfigures? (?:de style|of speech)\b/g, ' ');
  const [visualVerb, genericVerb] = ASKS_FOR_VISUAL;
  const asks = visualVerb.test(plain) || (genericVerb.test(plain) && !CODE_REQUEST.test(plain));
  return asks && !REFUSES_VISUAL.some((pattern) => pattern.test(plain));
}

// Each word and the block types that can stand for it, the one to ask for first. Schemas, figures and diagrams stand for
// one another, and a graph can be a chart or a network. A bar diagram is a chart, so the chart words come first.
const ARTEFACT_WORDS: { words: string; types: VisualType[] }[] = [
  { words: 'graphiques?|courbes?|histogrammes?|diagrammes?\\s+(?:en\\s+(?:barres?|batons?|secteurs?)|circulaires?)|plots?|charts?|curves?|histograms?', types: ['plot'] },
  { words: 'graphes?|graphs?', types: ['plot', 'diagram'] },
  { words: 'schemas?|diagrammes?|diagrams?', types: ['diagram', 'figure'] },
  { words: 'arbres?|trees?|organigrammes?|logigrammes?|flowcharts?', types: ['diagram'] },
  { words: 'figures?|dessins?|croquis|illustrations?|drawings?|sketch(?:es)?|pictures?|visuels?|visuals?', types: ['figure', 'diagram'] },
  { words: 'quiz(?:zes)?|qcm|questions?\\s+a\\s+choix\\s+multiples?|questions?\\s+de\\s+(?:quiz|qcm)|multiple[- ]choice(?:\\s+(?:questions?|quiz(?:zes)?))?', types: ['quiz'] },
];
const ANY_ARTEFACT = ARTEFACT_WORDS.map(({ words }) => words).join('|');
const typesOfWord = (word: string) => ARTEFACT_WORDS.find(({ words }) => new RegExp(`^(?:${words})$`).test(word))?.types ?? [];

// The words a request can be made with. Each stands at the start of a clause: "le graphique montre", "tu as tracé", "why would you plot" and "how do I make" do not.
const MAKE = "fais|faites|faisons|refais|refaites|donne|donnez|redonne|ajoute|ajoutez|rajoute|rajoutez|inclus|inclue|incluez|cree|creez|recree|genere|generez|propose|proposez|construis|construisez|prepare|preparez|mets|mettez|montre|montrez|fournis|fournissez|realise|realisez|etablis|etablissez|redige|redigez|ecris|ecrivez|produis|produisez|pose|posez|show|make|give|create|generate|add|include|produce|build|prepare|provide|write|redo|remake|ask|let's do|let's have";
const DRAW = 'dessine|dessinez|redessine|trace|tracez|retrace|affiche|affichez|represente|representez|illustre|illustrez|draw|redraw|plot|sketch|display|illustrate|visuali[sz]e';
const INFINITIVE = 'faire|refaire|donner|ajouter|rajouter|inclure|creer|generer|proposer|construire|preparer|mettre|montrer|fournir|realiser|etablir|rediger|ecrire|produire|poser|dessiner|redessiner|tracer|retracer|afficher|representer|illustrer|show|make|give|create|generate|add|include|produce|build|prepare|provide|write|redo|draw|redraw|plot|sketch|display|illustrate|visuali[sz]e';
const MODAL = "peux[ -]tu|pourrais[ -]tu|tu peux|tu pourrais|pouvez[ -]vous|vous pouvez|pourriez[ -]vous|peut[ -]on|on peut|on pourrait|pourrait[ -]on|can you|could you|would you|will you|i want you to|i'd like you to|merci de";
const SEE = '(?:\\s+to\\s+(?:see|have|get)|\\s+(?:voir|avoir|obtenir))?';
const HAVE = `(?:je (?:veux|voudrais|souhaite|souhaiterais|aimerais)|j'aimerais|on (?:veut|voudrait)|i want|i'd like|i would like|i'd love|we want)${SEE}|on fait|il (?:me |nous )?(?:faut|faudrait)|j'ai besoin d'|besoin d'|i need|we need|(?:can|could|may) (?:i|we) (?:have|get|see)|(?:puis|pourrais)[ -]je (?:avoir|voir)|(?:peut|pourrait)[ -]on (?:avoir|voir)`;
const FINISH = '(?:termine|terminez|finis|finissez|conclus|concluez|commence|commencez)\\s+(?:par|avec|sur)|(?:finish|end|close|conclude|start|wrap\\s+up)\\s+(?:with|on)';
const JOIN = "puis|ensuite|then|plus|enfin|finally|maintenant|now|next|pour (?:finir|terminer|conclure)|a la fin|at the end|to (?:finish|end)|followed by|suivie? d'|ainsi qu'|as well as|along with";
const MANNER = "sous forme d(?:e |')|a l'aide d(?:e |')|en utilisant|avec|with|using|as|via";
const CONNECTOR = "et|puis|ensuite|mais|aussi|alors|donc|enfin|maintenant|and|then|but|also|so|now|finally|next|please|svp|stp|s'il te plait|s'il vous plait|ok|okay|bon|just|juste|d'abord|first|apres|ou|or|est-ce que|est ce que";
const AT_CLAUSE_START = new RegExp(`(?:^|[,:(]|\\b(?:${CONNECTOR}))[\\s*_-]*$`);
// A clause that already asks for something or for an explanation, which "with a diagram" can then complete.
const OPENED = new RegExp(`(?:^|[,:(]\\s*|\\b(?:${CONNECTOR})\\s+)(?:explique[zr]?|explain|decris|decrivez|describe|presente[zr]?|present|resume[zr]?|summari[sz]e|detaille[zr]?|${MAKE}|${DRAW}|${MODAL}|${HAVE})\\b`);

const INDEFINITE = 'un|une|des|a|an|one|some|deux|trois|quatre|two|three|four|another|2|3|4';
const ANY_ARTICLE = `${INDEFINITE}|le|la|les|l'|the|ce|cette|this|these`;
// Adjectives may sit between the article and the noun. A preposition or an article there means the noun belongs to something else.
const FILLER = "(?:(?!(?:de|du|des|d|of|que|qu|that|sur|on|about|pour|for|dans|in|a|an|to|au|aux|en|par|by|with|avec|sans|without|et|and|ou|or|entre|between|from|un|une|le|la|les|l|the|binary|decision)\\b)[\\p{L}\\d'-]+\\s+){0,3}?";
// What the noun belongs to when these follow: "the graph is connected", "the tree height", "la figure 3", "the plot bigger".
const AFTER_NOUN = "(?![\\p{L}\\d'-])(?!\\s+(?:est|sont|is|are|was|were|has|have|ont|theory|theorie|equation|formula|height|apps?|applications?|classifiers?|bigger|smaller|larger|wider|ci-dessus|above|precedente?|previous|of\\s+what)\\b)(?!\\s+\\d)";
const NOUN = `(?<noun>${ANY_ARTEFACT})${AFTER_NOUN}`;
const OBJECT = `${FILLER}${NOUN}`;
const PRONOUN = "(?:[ -](?:moi|nous|me|us)\\b|\\s+(?:pour moi|for me)\\b)?";
// "Donne-moi un résumé, un schéma": the verb may reach past one plain object.
const REACHING = `(?:(?:${ANY_ARTICLE})\\s*${FILLER}[\\p{L}'-]+\\s*(?:,|\\bet\\b|\\band\\b)\\s*)??`;
const REQUEST_FORMS = [
  { at: 'start', pattern: `\\b(?:${MAKE}|${DRAW}|${FINISH})\\b${PRONOUN}[\\s,:]*${REACHING}(?<count>${ANY_ARTICLE})\\s*${OBJECT}` },
  { at: 'start', pattern: `\\b(?:${MODAL})(?:\\s+(?:me|nous|us)\\b|\\s+m')?\\s*(?:${INFINITIVE})\\b${PRONOUN}[\\s,:]*${REACHING}(?<count>${ANY_ARTICLE})\\s*${OBJECT}` },
  { at: 'start', pattern: `\\b(?:${HAVE})(?:\\s|\\b)\\s*(?<count>${ANY_ARTICLE})\\s*${OBJECT}` },
  { at: 'start', pattern: `\\b(?:${MAKE}|${FINISH}|${JOIN})\\b${PRONOUN}[\\s,:]*(?<noun>${ARTEFACT_WORDS[5].words})${AFTER_NOUN}` },
  // "Sketch the forces in a diagram": only a drawing verb reaches a noun this way.
  { at: 'start', pattern: `\\b(?:(?:${MODAL})(?:\\s+(?:me|nous|us)\\b|\\s+m')?\\s*)?(?:${DRAW}|${INFINITIVE})\\b[^.!?;\\n]{0,40}?\\b(?:in|on|sur|dans)\\s+(?<count>${INDEFINITE})\\s*${OBJECT}` },
  { at: 'opened', pattern: `\\b(?:${JOIN})[\\s,:]*(?<count>${INDEFINITE})\\s*${OBJECT}` },
  { at: 'opened', pattern: `\\b(?:${MANNER})\\s*(?<count>${INDEFINITE})\\s*${OBJECT}` },
  { at: 'opened', pattern: `\\bsous forme d(?:e |')${OBJECT}` },
].map(({ at, pattern }) => ({ at, pattern: new RegExp(pattern, 'gu') }));
const LISTED_AFTER = new RegExp(`(?:,|\\bet\\b|\\band\\b|\\bplus\\b)\\s*(?<count>${INDEFINITE})\\s*${OBJECT}`, 'gu');
const QUIZ_ME = /\b(?:quiz|test)\s+(?:me|us)\b|\b(?:interroge|teste|questionne)[ -](?:moi|nous)\b/g;
// A sentence that is only the thing: "Un schéma ?", "One chart only.", "Graphique de sin(x), merci." Anything that reads as a statement is out.
const BARE_FORMS = [
  new RegExp(`^[\\s*_-]*(?:(?:encore|just|juste|only|seulement)\\s+)?(?<count>${INDEFINITE})\\s*${OBJECT}(?<rest>.*)$`, 'su'),
  new RegExp(`^[\\s*_-]*(?<noun>${ARTEFACT_WORDS.slice(0, 5).map(({ words }) => words).join('|')})(?=\\s+(?:de|du|des|d'|of)\\b)(?<rest>.*)$`, 'su'),
];
const BARE_REST = /^\s*(?:$|,|(?:de|du|des|d'|of|for|pour|sur|on|about|only|seule?|please|svp|stp|s'il|merci|thanks|a la|at the|interactifs?|interactives?)(?![\p{L}]))/u;
const BARE_STATEMENT = /\b(?:est|sont|is|are|shows?|montre|donne|gives?|has|have|stands?|pourquoi|why|comment|how|what|quoi)\b/;
const BARE_WORDS = 8;

const COUNTS: Record<string, number> = { deux: 2, two: 2, 2: 2, trois: 3, three: 3, 3: 3, quatre: 4, four: 4, 4: 4 };
// Other things these words mean.
const OTHER_MEANINGS = /\bfigures? (?:de style|of speech|de rhetorique|of merit|for)\b|\bcourbes? de niveau\b/g;
// Whoever is reported as asking: the course, the statement, the teacher. The learner is asking about it, not for it.
const REPORTED = /\b(?:dit|disent|disait|demande|indique|stipule|says|said|states?|asks|reads|consigne|enonce)\b/;
const REFUSES_NAMED = [
  /\b(?:sans|pas\s+de|pas\s+d'|no|without|ni)\s+(?:\w+\s+){0,2}(?:quiz|qcm|arbres?|trees?)\b/,
  /(?:^|[,;]\s*)not\s+(?:a|an)\s+(?:\w+\s+)?(?:quiz|tree)\b/,
  /\b(?:do not|don't|dont|never|stop)\s+(?:quiz|test)\b|\bne\s+me\s+(?:teste|interroge)\s+pas\b/,
  new RegExp(`\\b(?:do not|don't|dont|never|stop)\\s+(?:give|add|make|create|include|generate|build|write|show|draw|use|want|need)\\b[^.!?;,\\n]{0,25}\\b(?:${ANY_ARTEFACT})\\b`),
  new RegExp(`\\b(?:inutile de|pas la peine de|pas besoin de|pas besoin d'|no need (?:to|for))[^.!?;,\\n]{0,25}\\b(?:${ANY_ARTEFACT})\\b`),
  new RegExp(`\\b(?:evite[sz]?|avoid|skip|hold off on|aucune?)\\s+(?:\\w+\\s+){0,2}(?:${ANY_ARTEFACT})\\b`),
  new RegExp(`\\bne\\s+(?:me\\s+|nous\\s+)?(?:fais|faites|donne|donnez|ajoute|ajoutez|mets|mettez|montre|montrez|trace|tracez|dessine|dessinez|propose|proposez|veux|voudrais)\\s+(?:surtout\\s+|plus\\s+)?pas\\b[^.!?;,\\n]{0,25}\\b(?:${ANY_ARTEFACT})\\b`),
  new RegExp(`\\b(?:n'(?:ai|as|avons|avez)\\s+pas\\s+besoin|il ne faut pas)\\b[^.!?;,\\n]{0,25}\\b(?:${ANY_ARTEFACT})\\b`),
];

/** What the detector reads: quoted text gone, and a past participle no longer spelled like the imperative once accents go ("tracé", "trace"). */
function requestText(text: string) {
  const unquoted = text.replace(/^[ \t]*>.*$/gm, ' ').replace(/«[^»]*»|“[^”]*”|"[^"\n]*"/g, (quote) => (/\S\s+\S/.test(quote.slice(1, -1).trim()) ? ' ' : quote));
  const marked = unquoted.toLowerCase().replace(/\p{L}+é(?:e?s?)(?!\p{L})/gu, (word) => (/^(?:re)?cr[ée]es?$/.test(word) ? word : 'participle'));
  return plainMessage(marked);
}

export interface NamedArtefact { type: VisualType; count: number; also?: VisualType[] }

/**
 * The artefact types a learner message asks for by name (French or English), in the order of the message. A name is a
 * request only as a request form plus the artefact: exclusions go first (a refusal, code, quoted or reported text), and
 * a form stands at the start of a clause, so past mentions and questions about a thing never match. Doubtful wording
 * does not fire, because the general decision call is still there. Curves live inside a plot, so they never count as plots.
 */
export function namedArtefacts(text: string): NamedArtefact[] {
  const plain = requestText(text).replace(OTHER_MEANINGS, ' ');
  if (!plain.trim() || NAMED_CODE_REQUEST.test(plain) || REFUSES_VISUAL.some((pattern) => pattern.test(plain)) || REFUSES_NAMED.some((pattern) => pattern.test(plain))) return [];
  const found = new Map<VisualType, { at: number; count: number; also?: VisualType[] }>();
  const add = (word: string, countWord: string | undefined, at: number) => {
    const [type, ...also] = typesOfWord(word);
    if (!type) return;
    const count = /^(?:courbes?|curves?)$/.test(word) ? 1 : COUNTS[countWord ?? ''] ?? 1;
    const known = found.get(type);
    found.set(type, { at: Math.min(known?.at ?? at, at), count: Math.max(known?.count ?? 1, count), ...(also.length ? { also } : {}) });
  };
  for (const sentence of plain.matchAll(/[^.!?;\n]+/g)) {
    const base = sentence.index, body = sentence[0];
    if (REPORTED.test(body)) continue;
    let first = -1;
    for (const { at, pattern } of REQUEST_FORMS) {
      for (const match of body.matchAll(pattern)) {
        const prefix = body.slice(0, match.index);
        if (!AT_CLAUSE_START.test(prefix) && !(at === 'opened' && OPENED.test(prefix))) continue;
        add(match.groups!.noun, match.groups!.count, base + match.index);
        if (first < 0 || match.index < first) first = match.index;
      }
    }
    for (const form of BARE_FORMS) {
      const match = form.exec(body);
      if (!match || !BARE_REST.test(match.groups!.rest) || BARE_STATEMENT.test(match.groups!.rest) || body.trim().split(/\s+/).length > BARE_WORDS) continue;
      add(match.groups!.noun, match.groups!.count, base);
      if (first < 0) first = 0;
    }
    if (first >= 0) for (const match of body.slice(first).matchAll(LISTED_AFTER)) add(match.groups!.noun, match.groups!.count, base + first + match.index);
    for (const match of body.matchAll(QUIZ_ME)) if (AT_CLAUSE_START.test(body.slice(0, match.index))) add('quiz', undefined, base + match.index);
  }
  return [...found].sort(([, a], [, b]) => a.at - b.at).map(([type, { count, also }]) => ({ type, count, ...(also ? { also } : {}) }));
}

/** A real request for a visual: the general rule and the detector agree. Only this may end a refusal the learner made earlier. */
export function requestsVisual(text: string) { return asksForVisual(text) && namedArtefacts(text).length > 0; }

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
