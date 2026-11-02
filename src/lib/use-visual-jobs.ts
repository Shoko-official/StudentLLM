import { useCallback, useEffect, useRef, useState } from 'react';
import type { LLMProvider } from './llm-provider';
import { decideVisual, runVisualJobs } from './teaching-generation';
import { appendVisualRequest, hasVisualFence, replaceVisualFence, visualFence, type VisualJob } from './visual-brief';

export const pendingVisualKey = (messageId: string, briefId: string) => `${messageId}\u0000${briefId}`;

/** Visual calls in flight at once, across every answer and retry. */
export const MAX_CONCURRENT_VISUAL_CALLS = 2;

interface VisualJobsOptions {
  provider: LLMProvider | null;
  deadlineMs?: number;
  updateMessage: (lessonId: string, messageId: string, update: (content: string) => string) => void;
}

/** One `start` or `decide` call: its lesson, and the controller that stops everything it queued. */
interface Run { lessonId: string; controller: AbortController; remaining: number }
type QueuedJob =
  | { kind: 'visual'; run: Run; messageId: string; job: VisualJob }
  | { kind: 'decision'; run: Run; messageId: string; question: string; answer: string; earlierVisuals: string[]; earlierMessages: string[] };

/** Running-job state stays in memory: a request fence with no running job is what offers a retry after a reload. */
export function useVisualJobs(options: VisualJobsOptions) {
  const latest = useRef(options);
  latest.current = options;
  const runs = useRef(new Set<Run>());
  const queue = useRef<QueuedJob[]>([]);
  const active = useRef(0);
  const [pending, setPending] = useState<ReadonlySet<string>>(new Set());
  const change = (keys: string[], running: boolean) => setPending((current) => {
    const next = new Set(current);
    for (const key of keys) { if (running) next.add(key); else next.delete(key); }
    return next;
  });
  // One controller per run, not one per mount: StrictMode runs this cleanup once right after the first mount.
  useEffect(() => {
    const all = runs.current;
    return () => { for (const run of all) run.controller.abort(); };
  }, []);
  // A single pump serves all runs. An aborted item still goes through it: it reports the stop without a model call
  // and clears its pending key. The deadline starts inside the attempt, so it does not tick while an item waits.
  // The provider is read when a job leaves the queue: course text must not reach a provider the learner has left.
  const pump = useCallback(() => {
    const settle = (run: Run) => { if (--run.remaining === 0) runs.current.delete(run); };
    while (active.current < MAX_CONCURRENT_VISUAL_CALLS && queue.current.length) {
      const item = queue.current.shift()!;
      const { run, messageId } = item;
      const { provider, deadlineMs } = latest.current;
      if (item.kind === 'decision') {
        if (!provider) { settle(run); continue; }
        active.current++;
        // A decision shows nothing while it runs and nothing when it fails: only a brief reaches the learner.
        decideVisual(provider, { question: item.question, answer: item.answer, earlierVisuals: item.earlierVisuals, earlierMessages: item.earlierMessages }, { deadlineMs, signal: run.controller.signal }).then(({ brief }) => {
          if (!brief) return;
          const { job } = appendVisualRequest(item.answer, brief);
          if (!job) return;
          latest.current.updateMessage(run.lessonId, messageId, (content) => hasVisualFence(content) ? content : appendVisualRequest(content, brief).markdown);
          run.remaining++;
          change([pendingVisualKey(messageId, brief.id)], true);
          queue.current.push({ kind: 'visual', run, messageId, job });
        }).catch((error) => {
          console.error('A visual decision failed', error);
        }).finally(() => {
          settle(run);
          active.current--;
          pump();
        });
        continue;
      }
      const { job } = item;
      const key = pendingVisualKey(messageId, job.brief.id);
      if (!provider) {
        change([key], false);
        settle(run);
        continue;
      }
      let reported = false;
      active.current++;
      runVisualJobs(provider, [job], {
        concurrency: 1,
        deadlineMs,
        signal: run.controller.signal,
        onResult: (brief, result) => {
          reported = true;
          const { visual } = result;
          try {
            if (visual) latest.current.updateMessage(run.lessonId, messageId, (content) => replaceVisualFence(content, brief.id, visualFence(visual)));
          } finally {
            change([key], false);
          }
        },
      }).catch((error) => {
        console.error('A visual job failed', error);
      }).finally(() => {
        if (!reported) change([key], false);
        settle(run);
        active.current--;
        pump();
      });
    }
  }, []);
  const start = useCallback((lessonId: string, messageId: string, jobs: VisualJob[]) => {
    if (!latest.current.provider || !jobs.length) return;
    const run: Run = { lessonId, controller: new AbortController(), remaining: jobs.length };
    runs.current.add(run);
    change(jobs.map((job) => pendingVisualKey(messageId, job.brief.id)), true);
    queue.current.push(...jobs.map((job): QueuedJob => ({ kind: 'visual', run, messageId, job })));
    pump();
  }, [pump]);
  const decide = useCallback((lessonId: string, messageId: string, question: string, answer: string, earlierVisuals: string[] = [], earlierMessages: string[] = []) => {
    if (!latest.current.provider) return;
    const run: Run = { lessonId, controller: new AbortController(), remaining: 1 };
    runs.current.add(run);
    queue.current.push({ kind: 'decision', run, messageId, question, answer, earlierVisuals, earlierMessages });
    pump();
  }, [pump]);
  const cancel = useCallback((lessonIds: string[]) => {
    for (const run of runs.current) if (lessonIds.includes(run.lessonId)) run.controller.abort();
  }, []);
  return { pending, start, decide, cancel };
}
