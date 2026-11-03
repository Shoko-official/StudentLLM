import type { LLMProvider, ProviderMessage, ProviderResponseFormat } from './llm-provider';
import { redactContextImages } from './context-text';
import { repairLatexJson } from './latex-json';
import { conversationLanguage, languageName } from './message-language';
import { visualDecisionResponseFormat, visualResponseFormat } from './teaching-schemas';
import { diagnoseTeachingVisual, type TeachingVisual } from './teaching-visuals';
import { appendVisualRequest, hasVisualFence, jobFromMarkdown, missingArtefacts, namedArtefacts, parseVisualBrief, refusesVisual, prepareTutorMarkdown, repairVisualFences, stripVisualNotes, withoutVisualFences, type VisualBrief, type VisualJob, type VisualType } from './visual-brief';
import { checkVisualAgainstBrief, disagreeingChecks, quizAgreesWithItself, quizWorkingNotes, quizWorkingPointsElsewhere, stillPlotNotes } from './visual-checks';
import { TUTOR_LENGTH_REMINDER, TUTOR_VISUAL_REQUEST_NOTE, VISUAL_DECISION_PROMPT, VISUAL_MODULES, tutorLanguageNote, visualLanguageTask, visualTargetNote } from '../prompts';

const VISUAL_MAX_TOKENS = 4096;
const stoppedMessage = 'Visual generation was stopped.';
const recheckTask = 'Recheck this visual against the request. The listed values disagree with values the tutor gave, and either side may be wrong. Correct the formula only if it is wrong, never bend a correct formula to match a value. Return the complete object.';
const stillPlotTask = 'Recheck this plot against the request. Follow each listed note where it applies and keep what is right: a curve that is truly constant stays constant. Return the complete object.';
const quizRecheckTask = 'Recheck this quiz. The option you keyed may disagree with your working or with the answer the tutor expected, and either may be wrong. Solve the question again in explanation, then key the option equal to your result, even if it differs from the expected answer. If no option holds your result, correct the options. Explanation, options and key must agree. Return the complete object.';
const noAnswerMessage = 'The model returned no answer. Try again or choose another model in Settings.';
const LEARNER_MESSAGE_FOR_PLOT_CHARACTERS = 2000;

export interface VisualJobResult { visual: TeachingVisual | null; attempts: number; errors: string[]; unconfirmed: string[] }

/**
 * The note sent after the question. A history that holds a refusal outweighs the system prompt, so when the learner has
 * refused visuals and this message has a word for one, the note says a new request would end the refusal. Whether this
 * message is a request stays the model's to read. The note also names the language when it can: only naming it held the
 * language on the models measured, where rules and "the language of the learner's message" did not.
 */
export function tutorNote(question: string, earlierLearnerTexts: string[]) {
  const language = conversationLanguage(question, earlierLearnerTexts);
  const lifted = namedArtefacts(question).length > 0 && !refusesVisual(question) && earlierLearnerTexts.some(refusesVisual);
  return [TUTOR_LENGTH_REMINDER, ...(language ? [tutorLanguageNote(languageName(language))] : []), ...(lifted ? [TUTOR_VISUAL_REQUEST_NOTE] : [])].join(' ');
}

export async function generateTutorProse(provider: LLMProvider, messages: ProviderMessage[], options: { maxTokens: number; signal?: AbortSignal; onText?: (text: string) => void }) {
  // The system prompt alone did not hold the length on small models: a note after the question does. It is never saved or shown.
  const learner = messages.filter((message) => message.role === 'user' && !message.content.includes('"kind":"course_evidence"') && !message.content.includes('"kind":"extractive_conversation_memory"')).map((message) => message.content);
  const question = learner.at(-1) ?? '';
  const earlier = learner.slice(0, -1);
  const note = tutorNote(question, earlier);
  const language = conversationLanguage(question, earlier);
  const response = await provider.generate([...messages, { role: 'user', content: note }], options);
  const reply = repairVisualFences(response.content.trim(), repairLatexJson);
  const { markdown, jobs } = prepareTutorMarkdown(reply);
  // "Quiz me on X" can get only a request, which the learner then sees as a pending visual. A block that cannot be read is no answer.
  if (!withoutVisualFences(stripVisualNotes(reply)).trim() && !hasVisualFence(markdown)) throw new Error(noAnswerMessage);
  return { markdown, model: response.model, jobs: jobs.map((job) => ({ ...job, learnerMessage: question, ...(language ? { language } : {}) })), needsDecision: !hasVisualFence(markdown) || missingArtefacts(question, markdown).length > 0 };
}

function jsonObjectIn(content: string) {
  const trimmed = content.trim();
  const start = trimmed.indexOf('{'), end = trimmed.lastIndexOf('}');
  return start >= 0 && end > start ? trimmed.slice(start, end + 1) : trimmed;
}

function assess(output: string, brief: VisualBrief): { visual: TeachingVisual | null; errors: string[]; disagreements: string[] } {
  const { visual, errors } = diagnoseTeachingVisual(repairLatexJson(jsonObjectIn(output)));
  if (!visual) return { visual: null, errors, disagreements: [] };
  const problems = checkVisualAgainstBrief(visual, brief);
  const notes = [...stillPlotNotes(visual), ...quizWorkingNotes(visual)];
  return problems.length ? { visual: null, errors: [...problems, ...notes], disagreements: [] } : { visual, errors: [], disagreements: [...disagreeingChecks(visual, brief), ...notes] };
}

function recheckTaskFor(visual: TeachingVisual, brief: VisualBrief) {
  if (visual.type === 'quiz') return quizRecheckTask;
  if (!disagreeingChecks(visual, brief).length) return stillPlotTask;
  return stillPlotNotes(visual).length ? `${recheckTask} ${stillPlotTask}` : recheckTask;
}

function attemptSignal(deadlineMs: number | undefined, parent: AbortSignal | undefined) {
  const controller = new AbortController();
  let reason: 'stopped' | 'deadline' | undefined;
  const stop = (cause: 'stopped' | 'deadline') => () => { reason ??= cause; controller.abort(); };
  const onParentAbort = stop('stopped');
  parent?.addEventListener('abort', onParentAbort, { once: true });
  if (parent?.aborted) onParentAbort();
  const timer = deadlineMs === undefined ? undefined : setTimeout(stop('deadline'), deadlineMs);
  return {
    signal: controller.signal,
    reason: () => reason,
    done: () => { clearTimeout(timer); parent?.removeEventListener('abort', onParentAbort); },
  };
}

async function generateWithin(provider: LLMProvider, messages: ProviderMessage[], request: { maxTokens: number; responseFormat?: ProviderResponseFormat }, options: { deadlineMs?: number; signal?: AbortSignal }) {
  const attempt = attemptSignal(options.deadlineMs, options.signal);
  try {
    return (await provider.generate(messages, { ...request, signal: attempt.signal })).content;
  } catch (error) {
    if (attempt.reason() === 'stopped') throw new Error(stoppedMessage);
    if (attempt.reason() === 'deadline') throw new Error(`The visual request timed out after ${Math.max(1, Math.round((options.deadlineMs ?? 0) / 1000))} s.`);
    throw error;
  } finally { attempt.done(); }
}

export async function generateVisual(provider: LLMProvider, job: VisualJob, options: { deadlineMs?: number; signal?: AbortSignal } = {}): Promise<VisualJobResult> {
  const { brief } = job;
  const stopped = (attempts: number): VisualJobResult => ({ visual: null, attempts, errors: [stoppedMessage], unconfirmed: [] });
  if (options.signal?.aborted) return stopped(0);
  // The tutor's request can lose a formula, a range or a readout that the learner wrote out: the plot builder gets the original too.
  const learner = brief.type === 'plot' && job.learnerMessage ? { learnerMessage: [...redactContextImages(job.learnerMessage)].slice(0, LEARNER_MESSAGE_FOR_PLOT_CHARACTERS).join('') } : {};
  const writeIn = job.language ? ` ${visualLanguageTask(languageName(job.language))}` : '';
  const ask = (data: { task: string } & Record<string, unknown>) => generateWithin(
    provider,
    [{ role: 'system', content: VISUAL_MODULES[brief.type] }, { role: 'user', content: JSON.stringify({ ...data, task: `${data.task}${writeIn}`, request: brief, surroundingExplanation: job.section, ...learner }) }],
    { maxTokens: VISUAL_MAX_TOKENS, ...(provider.supportsStructuredOutputs ? { responseFormat: visualResponseFormat(brief.type) } : {}) },
    options,
  );
  const failed = (attempts: number, error: unknown): VisualJobResult => ({ visual: null, attempts, errors: [error instanceof Error ? error.message : 'The visual request failed.'], unconfirmed: [] });
  let attempts = 0;
  let output = job.initialOutput;
  if (output === undefined) {
    attempts++;
    try { output = await ask({ task: 'Build the visual described by this request.' }); }
    catch (error) { return failed(attempts, error); }
  }
  const first = assess(output, brief);
  if (first.visual && !first.disagreements.length) return { visual: first.visual, attempts, errors: [], unconfirmed: [] };
  if (options.signal?.aborted) return stopped(attempts);
  attempts++;
  if (first.visual) {
    const kept: VisualJobResult = { visual: first.visual, attempts, errors: [], unconfirmed: first.disagreements };
    let rechecked: string;
    try { rechecked = await ask({ task: recheckTaskFor(first.visual, brief), previousOutput: output.slice(0, 16384), disagreements: first.disagreements }); }
    catch { return options.signal?.aborted ? stopped(attempts) : kept; }
    if (options.signal?.aborted) return stopped(attempts);
    const second = assess(rechecked, brief);
    // A reply that keys the expected answer against its own working has been pushed there, not convinced.
    if (second.visual && quizAgreesWithItself(second.visual)) return { visual: second.visual, attempts, errors: [], unconfirmed: second.disagreements };
    // A lasting doubt keeps the quiz. Only a key the tutor differs from, while the working states another option and not this one, is lost.
    return !quizWorkingPointsElsewhere(first.visual) || !disagreeingChecks(first.visual, brief).length ? kept : { visual: null, attempts, errors: ['the key and the explanation of the quiz disagree'], unconfirmed: [] };
  }
  let repaired: string;
  try { repaired = await ask({ task: 'Correct this visual. Fix every listed error and return the complete object.', invalidOutput: output.slice(0, 16384), errors: first.errors }); }
  catch (error) { return failed(attempts, error); }
  if (options.signal?.aborted) return stopped(attempts);
  const second = assess(repaired, brief);
  return { visual: second.visual, attempts, errors: second.errors, unconfirmed: second.disagreements };
}

const invalidDecision = 'invalid decision';
const LEARNER_MESSAGES_KEPT = 3;
const LEARNER_MESSAGE_CHARACTERS = 300;
const SEQUENCE_DEADLINES = 2;

/** The decision call reads these for a standing refusal: only the latest few, redacted, and cut by code points. */
const recentLearnerMessages = (messages: string[]) => messages.slice(-LEARNER_MESSAGES_KEPT).map((message) => [...redactContextImages(message)].slice(0, LEARNER_MESSAGE_CHARACTERS).join(''));
const present = (value: unknown) => value !== undefined && value !== null && value !== '' && !(Array.isArray(value) && !value.length);

interface DecisionInput { question: string; answer: string; earlierVisuals?: string[]; earlierMessages?: string[] }

/**
 * Asks once whether an answer should get a visual, or with a target whether it should get one of those types, which is
 * what the word the learner used can mean. Every failure leaves the answer as it is.
 */
export async function decideVisual(provider: LLMProvider, input: DecisionInput & { target?: VisualType[] }, options: { deadlineMs?: number; signal?: AbortSignal; id?: string } = {}): Promise<{ brief: VisualBrief | null; error?: string }> {
  const { target } = input;
  if (options.signal?.aborted) return { brief: null, error: stoppedMessage };
  const language = conversationLanguage(input.question, input.earlierMessages);
  try {
    const content = await generateWithin(
      provider,
      [{ role: 'system', content: VISUAL_DECISION_PROMPT }, { role: 'user', content: JSON.stringify({ learnerMessage: redactContextImages(input.question).slice(0, 2000), tutorAnswer: redactContextImages(input.answer).slice(0, 6000), earlierVisuals: (input.earlierVisuals ?? []).map((item) => redactContextImages(item)), earlierLearnerMessages: recentLearnerMessages(input.earlierMessages ?? []), ...(language ? { writeIn: languageName(language) } : {}) }) }, ...(target ? [{ role: 'user' as const, content: visualTargetNote(target.join(' or ')) }] : [])],
      { maxTokens: VISUAL_MAX_TOKENS, ...(provider.supportsStructuredOutputs ? { responseFormat: visualDecisionResponseFormat(target) } : {}) },
      options,
    );
    if (options.signal?.aborted) return { brief: null, error: stoppedMessage };
    let value: unknown;
    try { value = JSON.parse(repairLatexJson(jsonObjectIn(content))); } catch { return { brief: null, error: invalidDecision }; }
    if (!value || typeof value !== 'object' || Array.isArray(value)) return { brief: null, error: invalidDecision };
    const decision = value as Record<string, unknown>;
    if (decision.visual === false) return { brief: null };
    if (decision.visual !== true || (target && !target.includes(decision.type as VisualType))) return { brief: null, error: invalidDecision };
    const request: Record<string, unknown> = { id: options.id ?? 'auto-1', type: decision.type, intent: decision.intent, content: decision.content };
    for (const key of ['parameters', 'outputs', 'nodes', 'correctAnswer'] as const) if (present(decision[key])) request[key] = decision[key];
    const brief = parseVisualBrief(JSON.stringify(request));
    return brief ? { brief } : { brief: null, error: invalidDecision };
  } catch (error) {
    return { brief: null, error: error instanceof Error ? error.message : 'The visual decision failed.' };
  }
}

/**
 * Every decision call an answer gets, one at a time: one for each artefact the learner named and the answer lacks, then
 * the general call if the answer still has no visual. The app and the benchmark both go through here. The provider is read
 * before each call, so course text never reaches one the learner has left. A failed call stops the rest: only an invalid
 * reply lets the next one go ahead. The whole sequence gets twice the deadline of one call, so it cannot hold a slot for
 * minutes on calls that each just make it.
 */
export async function decideVisuals(getProvider: () => LLMProvider | null, input: DecisionInput, options: { deadlineMs?: number; signal?: AbortSignal; onRequest: (job: VisualJob, markdown: string, target?: VisualType[]) => void }) {
  let markdown = input.answer, requested = 0, error: string | undefined;
  const targets = missingArtefacts(input.question, markdown);
  const language = conversationLanguage(input.question, input.earlierMessages);
  const endsAt = options.deadlineMs === undefined ? undefined : Date.now() + options.deadlineMs * SEQUENCE_DEADLINES;
  const declined = new Set<string>();
  const ask = async (target?: VisualType[]) => {
    const provider = getProvider();
    const left = endsAt === undefined ? undefined : endsAt - Date.now();
    if (!provider || (left !== undefined && left <= 0)) return false;
    let free = 1;
    while (jobFromMarkdown(markdown, `auto-${free}`)) free++;
    const result = await decideVisual(provider, { ...input, answer: markdown, ...(target ? { target } : {}) }, { deadlineMs: left === undefined ? undefined : Math.min(left, options.deadlineMs!), signal: options.signal, id: `auto-${free}` });
    error = result.error ?? error;
    if (target && !result.brief && result.error === undefined) declined.add(target.join('|'));
    if (result.brief) {
      const appended = appendVisualRequest(markdown, result.brief);
      if (appended.job) {
        markdown = appended.markdown;
        requested++;
        options.onRequest({ ...appended.job, learnerMessage: input.question, ...(language ? { language } : {}) }, markdown, target);
      }
    }
    return !options.signal?.aborted && (result.error === undefined || result.error === invalidDecision);
  };
  let going = true;
  for (const target of targets) if (going && !declined.has(target.join('|'))) going = await ask(target);
  if (going && !hasVisualFence(markdown) && !refusesVisual(input.question)) await ask();
  return { markdown, requested, targets: targets.map((types) => types.join('|')), ...(error === undefined ? {} : { error }) };
}

export async function runVisualJobs(provider: LLMProvider, jobs: VisualJob[], options: { deadlineMs?: number; signal?: AbortSignal; concurrency?: number; onResult: (brief: VisualBrief, result: VisualJobResult) => void }) {
  const queue = [...jobs];
  const worker = async () => {
    for (let job = queue.shift(); job; job = queue.shift()) {
      const result = await generateVisual(provider, job, options);
      try { options.onResult(job.brief, result); }
      catch (error) { console.error('A visual result handler failed', error); }
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, options.concurrency ?? 2) }, worker));
}
