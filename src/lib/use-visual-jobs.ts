import { useCallback, useEffect, useRef, useState } from 'react';
import type { LLMProvider } from './llm-provider';
import { runVisualJobs } from './teaching-generation';
import { replaceVisualFence, visualFence, type VisualJob } from './visual-brief';

export const pendingVisualKey = (messageId: string, briefId: string) => `${messageId}\u0000${briefId}`;

interface VisualJobsOptions {
  provider: LLMProvider | null;
  deadlineMs?: number;
  updateMessage: (lessonId: string, messageId: string, update: (content: string) => string) => void;
}

/** Running-job state stays in memory: a request fence with no running job is what offers a retry after a reload. */
export function useVisualJobs(options: VisualJobsOptions) {
  const latest = useRef(options);
  latest.current = options;
  const controllers = useRef(new Set<AbortController>());
  const [pending, setPending] = useState<ReadonlySet<string>>(new Set());
  const change = (keys: string[], running: boolean) => setPending((current) => {
    const next = new Set(current);
    for (const key of keys) { if (running) next.add(key); else next.delete(key); }
    return next;
  });
  // One controller per run, not one per mount: StrictMode runs this cleanup once right after the first mount.
  useEffect(() => {
    const running = controllers.current;
    return () => { for (const controller of running) controller.abort(); };
  }, []);
  const start = useCallback((lessonId: string, messageId: string, jobs: VisualJob[]) => {
    const { provider, deadlineMs } = latest.current;
    if (!provider || !jobs.length) return;
    const controller = new AbortController();
    controllers.current.add(controller);
    change(jobs.map((job) => pendingVisualKey(messageId, job.brief.id)), true);
    void runVisualJobs(provider, jobs, {
      deadlineMs,
      signal: controller.signal,
      onResult: (brief, result) => {
        const { visual } = result;
        try {
          if (visual) latest.current.updateMessage(lessonId, messageId, (content) => replaceVisualFence(content, brief.id, visualFence(visual)));
        } finally {
          change([pendingVisualKey(messageId, brief.id)], false);
        }
      },
    }).finally(() => { controllers.current.delete(controller); });
  }, []);
  return { pending, start };
}
