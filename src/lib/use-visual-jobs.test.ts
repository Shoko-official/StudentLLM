import { StrictMode, createElement, type ReactNode } from 'react';
import { act, renderHook, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { LLMProvider } from './llm-provider';
import * as generation from './teaching-generation';
import { pendingVisualKey, useVisualJobs } from './use-visual-jobs';
import type { VisualJob } from './visual-brief';
import { VISUAL_DECISION_PROMPT } from '../prompts';

vi.mock('./teaching-generation', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./teaching-generation')>();
  return { ...actual, runVisualJobs: vi.fn(actual.runVisualJobs) };
});

const quiz = { type: 'quiz', title: 'Check', question: 'Q?', options: ['A', 'B'], answer: 1, explanation: 'B follows.' };
const job: VisualJob = { brief: { id: 'v1', type: 'quiz', intent: 'Check', content: 'Ask' }, section: 'Around.' };
const fence = '```student-visual-request\n' + JSON.stringify(job.brief) + '\n```';

describe('useVisualJobs', () => {
  it('writes the result to the course and message that asked for it, then clears the pending state', async () => {
    let release: (content: string) => void = () => undefined;
    const provider: LLMProvider = { supportsStructuredOutputs: true, generate: () => new Promise((resolve) => { release = (content) => resolve({ content, model: 'fixture' }); }) };
    const updateMessage = vi.fn();
    const { result } = renderHook(() => useVisualJobs({ provider, updateMessage }));
    act(() => result.current.start('lesson-a', 'm1', [job]));
    expect(result.current.pending.has(pendingVisualKey('m1', 'v1'))).toBe(true);
    await act(async () => release(JSON.stringify(quiz)));
    await waitFor(() => expect(result.current.pending.size).toBe(0));
    expect(updateMessage).toHaveBeenCalledTimes(1);
    const [lessonId, messageId, update] = updateMessage.mock.calls[0];
    expect([lessonId, messageId]).toEqual(['lesson-a', 'm1']);
    expect(update(fence)).toContain('```student-visual\n');
  });

  it('leaves the message alone when the visual fails', async () => {
    const provider: LLMProvider = { supportsStructuredOutputs: true, generate: async () => ({ content: '{"bad":', model: 'fixture' }) };
    const updateMessage = vi.fn();
    const { result } = renderHook(() => useVisualJobs({ provider, updateMessage }));
    act(() => result.current.start('lesson-a', 'm1', [job]));
    await waitFor(() => expect(result.current.pending.size).toBe(0));
    expect(updateMessage).not.toHaveBeenCalled();
  });

  it('clears the pending state even when the message update throws', async () => {
    const provider: LLMProvider = { supportsStructuredOutputs: true, generate: async () => ({ content: JSON.stringify(quiz), model: 'fixture' }) };
    const updateMessage = vi.fn(() => { throw new Error('storage full'); });
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const { result } = renderHook(() => useVisualJobs({ provider, updateMessage }));
    act(() => result.current.start('lesson-a', 'm1', [job]));
    await waitFor(() => expect(result.current.pending.size).toBe(0));
    expect(updateMessage).toHaveBeenCalledTimes(1);
  });

  it('starts nothing without a provider', () => {
    const { result } = renderHook(() => useVisualJobs({ provider: null, updateMessage: vi.fn() }));
    act(() => result.current.start('lesson-a', 'm1', [job]));
    expect(result.current.pending.size).toBe(0);
  });

  it('keeps running jobs started after the mount-time cleanup of a StrictMode render', async () => {
    const provider: LLMProvider = { supportsStructuredOutputs: true, generate: async () => ({ content: JSON.stringify(quiz), model: 'fixture' }) };
    const updateMessage = vi.fn();
    const wrapper = ({ children }: { children: ReactNode }) => createElement(StrictMode, null, children);
    const { result } = renderHook(() => useVisualJobs({ provider, updateMessage }), { wrapper });
    act(() => result.current.start('lesson-a', 'm1', [job]));
    await waitFor(() => expect(updateMessage).toHaveBeenCalledTimes(1));
  });

  it('aborts a running job on unmount and starts no model call for the queued jobs', async () => {
    const signals: AbortSignal[] = [];
    const generate = vi.fn((_messages: unknown, options?: { signal?: AbortSignal }) => new Promise<never>((_resolve, reject) => {
      signals.push(options!.signal!);
      options!.signal!.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')));
    }));
    const provider: LLMProvider = { supportsStructuredOutputs: true, generate };
    const updateMessage = vi.fn();
    const jobs: VisualJob[] = ['v1', 'v2', 'v3', 'v4'].map((id) => ({ ...job, brief: { ...job.brief, id } }));
    const { result, unmount } = renderHook(() => useVisualJobs({ provider, updateMessage }));
    act(() => result.current.start('lesson-a', 'm1', jobs));
    await waitFor(() => expect(generate).toHaveBeenCalledTimes(2));
    expect(signals.every((signal) => !signal.aborted)).toBe(true);
    unmount();
    expect(signals.every((signal) => signal.aborted)).toBe(true);
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(generate).toHaveBeenCalledTimes(2);
    expect(updateMessage).not.toHaveBeenCalled();
  });
  describe('decide', () => {
    const decision = { visual: true, type: 'quiz', intent: 'Check', content: 'Ask about the answer' };
    const isDecision = (messages: Array<{ content: string }>) => messages[0].content === VISUAL_DECISION_PROMPT;
    /** A store the hook can write to, so the appended fence can be read back. */
    const store = (initial: string) => {
      let content = initial;
      const updateMessage = vi.fn((_lessonId: string, _messageId: string, update: (current: string) => string) => { content = update(content); });
      return { updateMessage, content: () => content };
    };

    it('appends the request, then replaces it with the built visual', async () => {
      const calls: string[] = [];
      const generate = vi.fn(async (messages: Array<{ content: string }>) => {
        calls.push(isDecision(messages) ? 'decision' : 'visual');
        return { content: JSON.stringify(isDecision(messages) ? decision : quiz), model: 'fixture' };
      });
      const messages = store('Answer text.');
      const { result } = renderHook(() => useVisualJobs({ provider: { supportsStructuredOutputs: true, generate }, updateMessage: messages.updateMessage }));
      act(() => result.current.decide('lesson-a', 'm1', 'Why?', 'Answer text.'));
      expect(result.current.pending.size).toBe(0);
      await waitFor(() => expect(messages.content()).toContain('```student-visual\n'));
      await waitFor(() => expect(result.current.pending.size).toBe(0));
      expect(calls).toEqual(['decision', 'visual']);
      expect(messages.content()).not.toContain('student-visual-request');
      expect(messages.updateMessage.mock.calls.map(([lessonId, messageId]) => [lessonId, messageId])).toEqual([['lesson-a', 'm1'], ['lesson-a', 'm1']]);
    });

    it('passes the earlier visuals to the decision call, and an empty list by default', async () => {
      const generate = vi.fn(async () => ({ content: '{"visual":false}', model: 'fixture' }));
      const { result } = renderHook(() => useVisualJobs({ provider: { supportsStructuredOutputs: true, generate }, updateMessage: vi.fn() }));
      act(() => {
        result.current.decide('lesson-a', 'm1', 'Why?', 'A.', ['diagram "Lock" with nodes: A, B'], ['No diagrams.']);
        result.current.decide('lesson-a', 'm2', 'Why?', 'A.');
      });
      await waitFor(() => expect(generate).toHaveBeenCalledTimes(2));
      const sent = (generate.mock.calls as unknown as Array<[Array<{ content: string }>]>).map(([messages]) => JSON.parse(messages[1].content));
      expect(sent.map((item) => item.earlierVisuals)).toEqual([['diagram "Lock" with nodes: A, B'], []]);
      expect(sent.map((item) => item.earlierLearnerMessages)).toEqual([['No diagrams.'], []]);
    });

    it('marks the follow-up job pending as soon as the request is appended', async () => {
      let release: (content: string) => void = () => undefined;
      const generate = vi.fn((messages: Array<{ content: string }>) => isDecision(messages)
        ? Promise.resolve({ content: JSON.stringify(decision), model: 'fixture' })
        : new Promise<{ content: string; model: string }>((resolve) => { release = (content) => resolve({ content, model: 'fixture' }); }));
      const messages = store('Answer text.');
      const { result } = renderHook(() => useVisualJobs({ provider: { supportsStructuredOutputs: true, generate }, updateMessage: messages.updateMessage }));
      act(() => result.current.decide('lesson-a', 'm1', 'Why?', 'Answer text.'));
      await waitFor(() => expect(result.current.pending.has(pendingVisualKey('m1', 'auto-1'))).toBe(true));
      expect(messages.content()).toContain('student-visual-request');
      await act(async () => release(JSON.stringify(quiz)));
      await waitFor(() => expect(result.current.pending.size).toBe(0));
      expect(messages.content()).toContain('```student-visual\n');
    });

    it('adds nothing when the model declines or the decision fails', async () => {
      for (const reply of ['{"visual":false}', '{"bad":']) {
        const generate = vi.fn(async () => ({ content: reply, model: 'fixture' }));
        const messages = store('Answer text.');
        const { result } = renderHook(() => useVisualJobs({ provider: { supportsStructuredOutputs: true, generate }, updateMessage: messages.updateMessage }));
        act(() => result.current.decide('lesson-a', 'm1', 'Why?', 'Answer text.'));
        await waitFor(() => expect(generate).toHaveBeenCalledTimes(1));
        await new Promise((resolve) => setTimeout(resolve, 20));
        expect(messages.updateMessage).not.toHaveBeenCalled();
        expect(messages.content()).toBe('Answer text.');
        expect(result.current.pending.size).toBe(0);
      }
    });

    it('leaves a message alone when it already holds a visual fence', async () => {
      const generate = vi.fn(async (messages: Array<{ content: string }>) => ({ content: JSON.stringify(isDecision(messages) ? decision : quiz), model: 'fixture' }));
      const messages = store('Answer.\n\n' + fence);
      const { result } = renderHook(() => useVisualJobs({ provider: { supportsStructuredOutputs: true, generate }, updateMessage: messages.updateMessage }));
      act(() => result.current.decide('lesson-a', 'm1', 'Why?', 'Answer.'));
      await waitFor(() => expect(messages.updateMessage).toHaveBeenCalled());
      await waitFor(() => expect(result.current.pending.size).toBe(0));
      expect(messages.content().match(/student-visual-request/g)).toHaveLength(1);
    });

    it('stops a decision in flight when its lesson is cancelled or the hook unmounts', async () => {
      const signals: AbortSignal[] = [];
      const generate = vi.fn((_messages: unknown, options?: { signal?: AbortSignal }) => new Promise<never>((_resolve, reject) => {
        signals.push(options!.signal!);
        options!.signal!.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')));
      }));
      const updateMessage = vi.fn();
      const { result, unmount } = renderHook(() => useVisualJobs({ provider: { supportsStructuredOutputs: true, generate }, updateMessage }));
      act(() => { result.current.decide('lesson-a', 'm1', 'Why?', 'A.'); result.current.decide('lesson-b', 'm2', 'Why?', 'A.'); });
      await waitFor(() => expect(generate).toHaveBeenCalledTimes(2));
      act(() => result.current.cancel(['lesson-a']));
      expect(signals.map((signal) => signal.aborted)).toEqual([true, false]);
      unmount();
      expect(signals.every((signal) => signal.aborted)).toBe(true);
      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(updateMessage).not.toHaveBeenCalled();
    });

    it('does nothing without a provider, and drops a queued decision when the provider is gone', async () => {
      const none = renderHook(() => useVisualJobs({ provider: null, updateMessage: vi.fn() }));
      act(() => none.result.current.decide('lesson-a', 'm1', 'Why?', 'A.'));
      expect(none.result.current.pending.size).toBe(0);

      const gated: Array<() => void> = [];
      const generate = vi.fn(() => new Promise<{ content: string; model: string }>((resolve) => { gated.push(() => resolve({ content: '{"visual":false}', model: 'fixture' })); }));
      const provider: LLMProvider = { supportsStructuredOutputs: true, generate };
      const { result, rerender } = renderHook(({ current }: { current: LLMProvider | null }) => useVisualJobs({ provider: current, updateMessage: vi.fn() }), { initialProps: { current: provider as LLMProvider | null } });
      act(() => { result.current.decide('lesson-a', 'm1', 'Why?', 'A.'); result.current.decide('lesson-a', 'm2', 'Why?', 'A.'); result.current.decide('lesson-a', 'm3', 'Why?', 'A.'); });
      await waitFor(() => expect(generate).toHaveBeenCalledTimes(2));
      rerender({ current: null });
      act(() => gated.forEach((release) => release()));
      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(generate).toHaveBeenCalledTimes(2);
    });

    it('shares the two-call limit with visual jobs', async () => {
      let inFlight = 0, peak = 0;
      const releases: Array<() => void> = [];
      const generate = vi.fn((messages: Array<{ content: string }>) => new Promise<{ content: string; model: string }>((resolve) => {
        inFlight++; peak = Math.max(peak, inFlight);
        releases.push(() => { inFlight--; resolve({ content: isDecision(messages) ? '{"visual":false}' : JSON.stringify(quiz), model: 'fixture' }); });
      }));
      const { result } = renderHook(() => useVisualJobs({ provider: { supportsStructuredOutputs: true, generate }, updateMessage: vi.fn() }));
      act(() => {
        result.current.start('lesson-a', 'm1', [job]);
        result.current.decide('lesson-a', 'm2', 'Why?', 'A.');
        result.current.decide('lesson-a', 'm3', 'Why?', 'A.');
      });
      await waitFor(() => expect(generate).toHaveBeenCalledTimes(2));
      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(generate).toHaveBeenCalledTimes(2);
      for (let released = 0; released < 3; released++) { await waitFor(() => expect(releases.length).toBeGreaterThan(released)); act(() => releases[released]()); }
      await waitFor(() => expect(result.current.pending.size).toBe(0));
      expect(peak).toBe(2);
    });
  });
  describe('shared queue', () => {
    const jobsFor = (...ids: string[]): VisualJob[] => ids.map((id) => ({ ...job, brief: { ...job.brief, id } }));
    const briefId = (messages: Array<{ content: string }>) => (JSON.parse(messages.at(-1)!.content) as { request: { id: string } }).request.id;
    /** A provider whose calls stay open until released, and reject when their signal aborts. */
    function gatedProvider() {
      const calls: Array<{ id: string; signal: AbortSignal; release: () => void }> = [];
      let inFlight = 0, peak = 0;
      const generate = vi.fn((messages: Array<{ content: string }>, options?: { signal?: AbortSignal }) => new Promise<{ content: string; model: string }>((resolve, reject) => {
        inFlight++; peak = Math.max(peak, inFlight);
        const signal = options!.signal!;
        const settle = (action: () => void) => () => { inFlight--; action(); };
        signal.addEventListener('abort', settle(() => reject(new DOMException('aborted', 'AbortError'))), { once: true });
        calls.push({ id: briefId(messages), signal, release: settle(() => resolve({ content: JSON.stringify(quiz), model: 'fixture' })) });
      }));
      const provider: LLMProvider = { supportsStructuredOutputs: true, generate };
      return { provider, generate, calls, peak: () => peak };
    }
    const releaseAll = async (calls: Array<{ id: string; release: () => void }>, expected: number) => {
      const released = new Set<string>();
      await waitFor(() => {
        for (const call of calls) if (!released.has(call.id)) { released.add(call.id); act(() => call.release()); }
        expect(released.size).toBe(expected);
      });
    };

    it('keeps at most two visual calls in flight across separate starts, and finishes every job', async () => {
      const { provider, generate, calls, peak } = gatedProvider();
      const updateMessage = vi.fn();
      const { result } = renderHook(() => useVisualJobs({ provider, updateMessage }));
      act(() => { result.current.start('lesson-a', 'm1', jobsFor('v1', 'v2')); result.current.start('lesson-a', 'm2', jobsFor('v3', 'v4')); });
      await waitFor(() => expect(generate).toHaveBeenCalledTimes(2));
      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(generate).toHaveBeenCalledTimes(2);
      await releaseAll(calls, 4);
      await waitFor(() => expect(result.current.pending.size).toBe(0));
      expect(peak()).toBe(2);
      expect(updateMessage).toHaveBeenCalledTimes(4);
    });

    it('does not count the deadline while a job waits in the queue', async () => {
      const { provider, generate, calls } = gatedProvider();
      const { result } = renderHook(() => useVisualJobs({ provider, deadlineMs: 150, updateMessage: vi.fn() }));
      act(() => result.current.start('lesson-a', 'm1', jobsFor('v1', 'v2', 'v3')));
      await waitFor(() => expect(generate).toHaveBeenCalledTimes(3), { interval: 5 });
      expect(calls[0].signal.aborted).toBe(true);
      expect(calls[2].signal.aborted).toBe(false);
      await waitFor(() => expect(result.current.pending.size).toBe(0));
    });

    it('passes the deadline to the attempt', async () => {
      const { provider, calls } = gatedProvider();
      const updateMessage = vi.fn();
      const { result } = renderHook(() => useVisualJobs({ provider, deadlineMs: 25, updateMessage }));
      act(() => result.current.start('lesson-a', 'm1', jobsFor('v1')));
      await waitFor(() => expect(calls[0].signal.aborted).toBe(true));
      await waitFor(() => expect(result.current.pending.size).toBe(0));
      expect(updateMessage).not.toHaveBeenCalled();
    });

    it('clears the pending key and logs when a run rejects without reporting', async () => {
      const failure = vi.spyOn(console, 'error').mockImplementation(() => undefined);
      vi.mocked(generation.runVisualJobs).mockImplementationOnce(() => Promise.reject(new Error('boom')));
      const provider: LLMProvider = { supportsStructuredOutputs: true, generate: async () => ({ content: JSON.stringify(quiz), model: 'fixture' }) };
      const { result } = renderHook(() => useVisualJobs({ provider, updateMessage: vi.fn() }));
      act(() => result.current.start('lesson-a', 'm1', jobsFor('v1')));
      await waitFor(() => expect(result.current.pending.size).toBe(0));
      expect(failure).toHaveBeenCalled();
    });

    it('sends a queued job to the current provider, and none at all when the provider is gone', async () => {
      const first = gatedProvider();
      const second = gatedProvider();
      const updateMessage = vi.fn();
      const { result, rerender } = renderHook(({ provider }: { provider: LLMProvider | null }) => useVisualJobs({ provider, updateMessage }), { initialProps: { provider: first.provider as LLMProvider | null } });
      act(() => result.current.start('lesson-a', 'm1', jobsFor('a', 'b', 'c', 'd')));
      await waitFor(() => expect(first.generate).toHaveBeenCalledTimes(2));
      rerender({ provider: second.provider });
      await releaseAll(first.calls, 2);
      await waitFor(() => expect(second.generate).toHaveBeenCalledTimes(2));
      expect(first.generate).toHaveBeenCalledTimes(2);
      act(() => result.current.start('lesson-a', 'm2', jobsFor('e')));
      rerender({ provider: null });
      await releaseAll(second.calls, 2);
      await waitFor(() => expect(result.current.pending.size).toBe(0));
      expect(second.generate).toHaveBeenCalledTimes(2);
    });

    it('cancels the jobs of the named lessons, running or queued, and lets the others continue', async () => {
      const { provider, generate, calls } = gatedProvider();
      const updateMessage = vi.fn();
      const { result } = renderHook(() => useVisualJobs({ provider, updateMessage }));
      act(() => {
        result.current.start('lesson-a', 'ma', jobsFor('a1'));
        result.current.start('lesson-b', 'mb', jobsFor('b1', 'b2'));
        result.current.start('lesson-a', 'ma2', jobsFor('a2'));
      });
      await waitFor(() => expect(generate).toHaveBeenCalledTimes(2));
      expect(calls.map((call) => call.id)).toEqual(['a1', 'b1']);
      act(() => result.current.cancel(['lesson-a']));
      expect(calls[0].signal.aborted).toBe(true);
      expect(calls[1].signal.aborted).toBe(false);
      await waitFor(() => expect(generate).toHaveBeenCalledTimes(3));
      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(calls.map((call) => call.id)).toEqual(['a1', 'b1', 'b2']);
      await releaseAll(calls.slice(1), 2);
      await waitFor(() => expect(result.current.pending.size).toBe(0));
      expect(updateMessage.mock.calls.map(([lessonId]) => lessonId)).toEqual(['lesson-b', 'lesson-b']);
    });
  });
});
