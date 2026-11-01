import { StrictMode, createElement, type ReactNode } from 'react';
import { act, renderHook, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { LLMProvider } from './llm-provider';
import { pendingVisualKey, useVisualJobs } from './use-visual-jobs';
import type { VisualJob } from './visual-brief';

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
});
