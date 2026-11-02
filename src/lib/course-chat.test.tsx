import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { CourseChat } from './course-chat';
import type { ChatMessage } from '../types';

const noop = () => undefined;
const chat = (props: { streamingText?: string | null; messages?: ChatMessage[]; isSending?: boolean }) => <CourseChat
  messages={props.messages ?? [{ id: 'u1', role: 'user', content: 'Question' }]} streamingText={props.streamingText ?? null}
  sourceCount={0} hasMaterial providerName="Local AI" draft="" isSending={props.isSending ?? true} error={null}
  onDraftChange={noop} onSubmit={vi.fn()} onOpenSources={noop} onOpenSettings={noop} onOpenCitation={noop}
/>;

function scrollArea() {
  const thread = screen.getByRole('region', { name: 'Conversation history' });
  Object.defineProperty(thread, 'clientHeight', { configurable: true, value: 200 });
  Object.defineProperty(thread, 'scrollHeight', { configurable: true, value: 1000 });
  return thread;
}

function scrollTo(thread: HTMLElement, top: number) {
  thread.scrollTop = top;
  fireEvent.scroll(thread);
}

describe('CourseChat streaming', () => {
  it('shows the progress indicator until there is visible text, then the text', () => {
    const { container, rerender } = render(chat({}));
    expect(container.querySelector('.chat-progress')).toHaveTextContent('Preparing an answer');
    rerender(chat({ streamingText: '```student-visual-request\n{"id":"v1"}' }));
    expect(container.querySelector('.chat-progress')).toBeInTheDocument();
    expect(screen.queryByRole('article', { name: 'Course assistant response' })).not.toBeInTheDocument();
    expect(container).not.toHaveTextContent('"id"');
    rerender(chat({ streamingText: 'Partial **answer**' }));
    expect(container.querySelector('.chat-progress')).not.toBeInTheDocument();
    expect(screen.getByRole('article', { name: 'Course assistant response' })).toHaveTextContent('Partial answer');
    expect(screen.getByText('answer').tagName).toBe('STRONG');
  });

  it('keeps one status for the answer in progress and silences the growing text inside the log', () => {
    const { rerender } = render(chat({}));
    const status = screen.getByRole('status', { name: 'Answer in progress' });
    rerender(chat({ streamingText: 'Partial answer' }));
    expect(screen.getByRole('status', { name: 'Answer in progress' })).toBe(status);
    expect(status).toHaveClass('visually-hidden');
    const article = screen.getByRole('article', { name: 'Course assistant response' });
    expect(article).toHaveAttribute('aria-busy', 'true');
    expect(article).toHaveAttribute('aria-live', 'off');
    expect(screen.getByRole('log')).toContainElement(article);
  });

  it('replaces the streaming element with a new one, so the log announces the saved message as an addition', () => {
    const { rerender } = render(chat({ streamingText: 'Partial answer' }));
    const article = screen.getByRole('article', { name: 'Course assistant response' });
    rerender(chat({ isSending: false, messages: [{ id: 'u1', role: 'user', content: 'Question' }, { id: 'a1', role: 'assistant', content: 'Complete answer' }] }));
    const saved = screen.getByRole('article', { name: 'Course assistant response' });
    expect(saved).not.toBe(article);
    expect(saved).not.toHaveAttribute('aria-busy');
    expect(saved).not.toHaveAttribute('aria-live');
    expect(saved).toHaveTextContent('Complete answer');
    expect(screen.queryByRole('status', { name: 'Answer in progress' })).not.toBeInTheDocument();
  });

  it('renders no interactive visual in the streaming text', () => {
    render(chat({ streamingText: 'Before.\n\n```student-visual\n{"type":"quiz","title":"T","question":"Q?","options":["A","B"],"answer":1,"explanation":"E"}\n```\n\nAfter.' }));
    expect(screen.queryByRole('radio')).not.toBeInTheDocument();
    const article = screen.getByRole('article', { name: 'Course assistant response' });
    expect(article).toHaveTextContent('Before.');
    expect(article).toHaveTextContent('After.');
    expect(article).not.toHaveTextContent('quiz');
  });

  it('follows the text while the learner stays at the end', () => {
    const { rerender } = render(chat({ streamingText: 'One' }));
    const thread = scrollArea();
    scrollTo(thread, 790);
    rerender(chat({ streamingText: 'One two' }));
    expect(thread.scrollTop).toBe(1000);
  });

  it('does not pull a learner back down who scrolled up, until they return to the end', () => {
    const { rerender } = render(chat({ streamingText: 'One' }));
    const thread = scrollArea();
    scrollTo(thread, 100);
    rerender(chat({ streamingText: 'One two' }));
    expect(thread.scrollTop).toBe(100);
    rerender(chat({ isSending: false, messages: [{ id: 'u1', role: 'user', content: 'Question' }, { id: 'a1', role: 'assistant', content: 'Complete' }] }));
    expect(thread.scrollTop).toBe(100);
    scrollTo(thread, 790);
    rerender(chat({ isSending: true, streamingText: 'New' }));
    expect(thread.scrollTop).toBe(1000);
  });
});
