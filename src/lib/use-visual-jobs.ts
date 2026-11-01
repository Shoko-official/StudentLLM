import { useCallback, useEffect, useRef, useState } from 'react';
import type { LLMProvider } from './llm-provider';
import { runVisualJobs } from './teaching-generation';
import { replaceVisualFence, visualFence, type VisualJob } from './visual-brief';

export const pendingVisualKey = (messageId: string, briefId: string) => `${messageId}\u0000${briefId}`;

/** Visual calls in flight at once, across every answer and retry. */
export const MAX_CONCURRENT_VISUAL_CALLS = 2;

interface VisualJobsOptions {
  provider: LLMProvider | null;
  deadlineMs?: number;
  updateMessage: (lessonId: string, messageId: string, update: (content: string) => string) => void;
}

/** One `start` call: its lesson, and the controller that stops every job it queued. */
interface Run { lessonId: string; controller: AbortController; remaining: number }
interface QueuedJob { run: Run; messageId: string; job: VisualJob }

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
    while (active.current < MAX_CONCURRENT_VISUAL_CALLS && queue.current.length) {
      const { run, messageId, job } = queue.current.shift()!;
      const key = pendingVisualKey(messageId, job.brief.id);
      const { provider, deadlineMs } = latest.current;
      if (!provider) {
        change([key], false);
        if (--run.remaining === 0) runs.current.delete(run);
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
        if (--run.remaining === 0) runs.current.delete(run);
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
    queue.current.push(...jobs.map((job) => ({ run, messageId, job })));
    pump();
  }, [pump]);
  const cancel = useCallback((lessonIds: string[]) => {
    for (const run of runs.current) if (lessonIds.includes(run.lessonId)) run.controller.abort();
  }, []);
  return { pending, start, cancel };
}
