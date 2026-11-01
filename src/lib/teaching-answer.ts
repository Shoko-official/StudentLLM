import type { LLMProvider, ProviderMessage, ProviderResponse, ProviderResponseFormat } from './llm-provider';
import { fromMarkdown } from 'mdast-util-from-markdown';
import { parseTeachingVisual } from './teaching-visuals';
import { STRUCTURED_TEACHING_CONTRACT } from '../prompts';
import { object, sectionArray, sectionText, visualTypeSchemas, type Schema } from './teaching-schemas';

const visualSchema: Schema = { anyOf: [visualTypeSchemas.plot, visualTypeSchemas.diagram, visualTypeSchemas.figure, visualTypeSchemas.quiz, { type: 'null' }] };

export const teachingAnswerSchema: Schema = object({
  sections: sectionArray(object({ markdown: sectionText(12000, 0), visual: visualSchema }), 1, 16),
});

export const teachingAnswerResponseFormat: ProviderResponseFormat = {
  type: 'json_schema',
  json_schema: { name: 'teaching_answer', strict: true, schema: teachingAnswerSchema },
};

const invalidAnswerMessage = 'The model returned an incomplete or invalid lesson response. Try again or choose another model in Settings.';
const visualFallback = '> This visualization could not be displayed. Ask for a simpler graph or diagram; the accompanying explanation is retained.';

function record(value: unknown): value is Record<string, unknown> { return !!value && typeof value === 'object' && !Array.isArray(value); }
function exactKeys(value: Record<string, unknown>, keys: string[]) { return Object.keys(value).length === keys.length && keys.every((key) => Object.hasOwn(value, key)); }
function sectionVisual(value: unknown) {
  try { return parseTeachingVisual(JSON.stringify(value)); } catch { return null; }
}
interface MarkdownNode { type: string; lang?: string | null; position?: { start: { offset?: number } }; children?: MarkdownNode[] }
function inertProseVisualFences(markdown: string) {
  // The actual Markdown AST identifies outer fences, including list/quote containers.
  // Never scan code bodies: a Python string containing a fence must stay verbatim.
  const pending: MarkdownNode[] = [fromMarkdown(markdown)];
  const edits: Array<{ start: number; end: number }> = [];
  while (pending.length) {
    const node = pending.pop()!;
    if (node.children) pending.push(...node.children);
    const start = node.position?.start.offset;
    if (node.type !== 'code' || typeof node.lang !== 'string' || start === undefined) continue;
    const newline = markdown.indexOf('\n', start);
    const lineEnd = newline === -1 ? markdown.length : newline;
    const opening = /^([ \t]*)(`{3,}|~{3,})([^\r\n]*)/.exec(markdown.slice(start, lineEnd));
    if (!opening) continue;
    const language = opening[3].trim().split(/\s+/, 1)[0];
    // Only plain language names are retained; escapes/entities cannot smuggle an interactive language.
    if (language !== 'student-visual' && /^[A-Za-z0-9_+.#-]+$/.test(language)) continue;
    edits.push({ start: start + opening[1].length + opening[2].length, end: start + opening[0].length });
  }
  for (const edit of edits.sort((a, b) => b.start - a.start)) markdown = markdown.slice(0, edit.start) + 'text' + markdown.slice(edit.end);
  return markdown;
}

function canonicalAnswer(content: string): string {
  if (content.length > 262144) throw new Error(invalidAnswerMessage);
  let parsed: unknown;
  try { parsed = JSON.parse(content); } catch { throw new Error(invalidAnswerMessage); }
  if (!record(parsed) || !exactKeys(parsed, ['sections']) || !Array.isArray(parsed.sections) || parsed.sections.length < 1 || parsed.sections.length > 16) throw new Error(invalidAnswerMessage);
  const rendered: string[] = [];
  let visuals = 0;
  for (const section of parsed.sections) {
    if (!record(section) || !exactKeys(section, ['markdown', 'visual']) || typeof section.markdown !== 'string' || section.markdown.length > 12000) throw new Error(invalidAnswerMessage);
    if (section.markdown.trim()) rendered.push(inertProseVisualFences(section.markdown.trim()));
    if (section.visual !== null) {
      const visual = visuals < 8 ? sectionVisual(section.visual) : null;
      if (visual) { visuals++; rendered.push('```student-visual\n' + JSON.stringify(visual) + '\n```'); }
      else rendered.push(visualFallback);
    }
  }
  if (!rendered.length) throw new Error(invalidAnswerMessage);
  return rendered.join('\n\n');
}

/** One generation with a constrained envelope when available; never retries or repairs malformed output. */
export async function generateTeachingAnswer(provider: LLMProvider, messages: ProviderMessage[], options: { maxTokens: number }): Promise<ProviderResponse> {
  if (!provider.supportsStructuredOutputs) return provider.generate(messages, options);
  const systemIndex = messages.findIndex(message => message.role === 'system');
  const formattedMessages = messages.map((message, index) => index === systemIndex
    ? { ...message, content: message.content + '\n\n' + STRUCTURED_TEACHING_CONTRACT }
    : message);
  if (systemIndex === -1) formattedMessages.unshift({ role: 'system', content: STRUCTURED_TEACHING_CONTRACT });
  const response = await provider.generate(formattedMessages, { ...options, responseFormat: teachingAnswerResponseFormat });
  return { ...response, content: canonicalAnswer(response.content) };
}
