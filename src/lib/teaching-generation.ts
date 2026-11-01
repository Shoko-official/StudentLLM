import type { LLMProvider, ProviderMessage } from './llm-provider';
import { visualResponseFormat } from './teaching-schemas';
import { diagnoseTeachingVisual, type TeachingVisual } from './teaching-visuals';
import { prepareTutorMarkdown, replaceVisualFence, type VisualBrief, type VisualJob } from './visual-brief';
import { checkVisualAgainstBrief } from './visual-checks';
import { VISUAL_MODULES } from '../prompts';

const VISUAL_MAX_TOKENS = 4096;
const stoppedMessage = 'Visual generation was stopped.';
const noAnswerMessage = 'The model returned no answer. Try again or choose another model in Settings.';

export interface VisualJobResult { visual: TeachingVisual | null; attempts: number; errors: string[] }

export async function generateTutorProse(provider: LLMProvider, messages: ProviderMessage[], options: { maxTokens: number; signal?: AbortSignal }) {
  const response = await provider.generate(messages, options);
  const { markdown, jobs } = prepareTutorMarkdown(response.content.trim());
  const readable = jobs.reduce((text, job) => replaceVisualFence(text, job.brief.id, ''), markdown);
  if (!readable.trim()) throw new Error(noAnswerMessage);
  return { markdown, model: response.model, jobs };
}

function jsonObjectIn(content: string) {
  const trimmed = content.trim();
  const start = trimmed.indexOf('{'), end = trimmed.lastIndexOf('}');
  return start >= 0 && end > start ? trimmed.slice(start, end + 1) : trimmed;
}

function assess(output: string, brief: VisualBrief): { visual: TeachingVisual | null; errors: string[] } {
  const { visual, errors } = diagnoseTeachingVisual(jsonObjectIn(output));
  if (!visual) return { visual: null, errors };
  const problems = checkVisualAgainstBrief(visual, brief);
  return problems.length ? { visual: null, errors: problems } : { visual, errors: [] };
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

export async function generateVisual(provider: LLMProvider, job: VisualJob, options: { deadlineMs?: number; signal?: AbortSignal } = {}): Promise<VisualJobResult> {
  const { brief } = job;
  const stopped = (attempts: number): VisualJobResult => ({ visual: null, attempts, errors: [stoppedMessage] });
  if (options.signal?.aborted) return stopped(0);
  const ask = async (data: Record<string, unknown>) => {
    const attempt = attemptSignal(options.deadlineMs, options.signal);
    try {
      const response = await provider.generate(
        [{ role: 'system', content: VISUAL_MODULES[brief.type] }, { role: 'user', content: JSON.stringify({ ...data, request: brief, surroundingExplanation: job.section }) }],
        { maxTokens: VISUAL_MAX_TOKENS, signal: attempt.signal, ...(provider.supportsStructuredOutputs ? { responseFormat: visualResponseFormat(brief.type) } : {}) },
      );
      return response.content;
    } catch (error) {
      if (attempt.reason() === 'stopped') throw new Error(stoppedMessage);
      if (attempt.reason() === 'deadline') throw new Error(`The visual request timed out after ${Math.max(1, Math.round((options.deadlineMs ?? 0) / 1000))} s.`);
      throw error;
    } finally { attempt.done(); }
  };
  const failed = (attempts: number, error: unknown): VisualJobResult => ({ visual: null, attempts, errors: [error instanceof Error ? error.message : 'The visual request failed.'] });
  let attempts = 0;
  let output = job.initialOutput;
  if (output === undefined) {
    attempts++;
    try { output = await ask({ task: 'Build the visual described by this request.' }); }
    catch (error) { return failed(attempts, error); }
  }
  const first = assess(output, brief);
  if (first.visual) return { visual: first.visual, attempts, errors: [] };
  if (options.signal?.aborted) return stopped(attempts);
  attempts++;
  let repaired: string;
  try { repaired = await ask({ task: 'Correct this visual. Fix every listed error and return the complete object.', invalidOutput: output.slice(0, 16384), errors: first.errors }); }
  catch (error) { return failed(attempts, error); }
  const second = assess(repaired, brief);
  return { visual: second.visual, attempts, errors: second.errors };
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
