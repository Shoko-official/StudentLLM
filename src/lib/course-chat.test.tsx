import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { CourseChat } from './course-chat';
import styles from '../styles.css?raw';
import type { ChatMessage } from '../types';

const noop = () => undefined;
const chat = (props: { streamingText?: string | null; messages?: ChatMessage[]; isSending?: boolean }) => <CourseChat
  messages={props.messages ?? [{ id: 'u1', role: 'user', content: 'Question' }]} streamingText={props.streamingText ?? null}
  sourceCount={0} hasMaterial providerName="Local AI" draft="" isSending={props.isSending ?? true} error={null}
  onDraftChange={noop} onSubmit={vi.fn()} onOpenSources={noop} onOpenSettings={noop} onOpenCitation={noop}
/>;

/** Gives the thread what jsdom has no layout for: a height, and a position clamped to its range as in a browser. */
function scrollArea() {
  const thread = screen.getByRole('region', { name: 'Conversation history' });
  const layout = { content: 1000, view: 200, top: 0 };
  const limit = () => Math.max(0, layout.content - layout.view);
  Object.defineProperty(thread, 'clientHeight', { configurable: true, get: () => layout.view });
  Object.defineProperty(thread, 'scrollHeight', { configurable: true, get: () => layout.content });
  Object.defineProperty(thread, 'scrollTop', { configurable: true, get: () => layout.top, set: (value: number) => { layout.top = Math.min(Math.max(0, value), limit()); } });
  return { thread, resize(content: number) { layout.content = content; layout.top = Math.min(layout.top, limit()); } };
}

function scrollTo(thread: HTMLElement, top: number) {
  thread.scrollTop = top;
  fireEvent.scroll(thread);
}

function streamingAtTheEnd() {
  const view = render(chat({ streamingText: 'One' }));
  const area = scrollArea();
  view.rerender(chat({ streamingText: 'One two' }));
  expect(area.thread.scrollTop).toBe(800);
  fireEvent.scroll(area.thread);
  let words = 'One two';
  const grow = () => {
    words += ' more';
    area.resize(1000 + words.length);
    view.rerender(chat({ streamingText: words }));
  };
  return { ...view, ...area, grow };
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

  it('shows the progress status, not a blank message, while the reply is only a request block', () => {
    for (const streamingText of ['```student-visual-request\n{"id":"v1","type":"quiz"', '```student-visual-request\n{"id":"v1","type":"quiz","intent":"I","content":"C"}\n```']) {
      const { unmount } = render(chat({ streamingText }));
      expect(screen.queryByRole('article', { name: 'Course assistant response' })).not.toBeInTheDocument();
      expect(screen.getByRole('status', { name: 'Answer in progress' })).toHaveTextContent('Preparing an answer');
      unmount();
    }
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
    const { thread, grow } = streamingAtTheEnd();
    grow();
    expect(thread.scrollHeight - thread.scrollTop - thread.clientHeight).toBe(0);
    fireEvent.scroll(thread);
    grow();
    expect(thread.scrollHeight - thread.scrollTop - thread.clientHeight).toBe(0);
  });

  it.each([1, 40, 95, 96, 600])('leaves a learner where they are after scrolling up by %i px, however small', (amount) => {
    const { thread, grow } = streamingAtTheEnd();
    const top = thread.scrollTop - amount;
    scrollTo(thread, top);
    grow();
    expect(thread.scrollTop).toBe(top);
    grow();
    expect(thread.scrollTop).toBe(top);
  });

  it('adds up small steps instead of undoing each one', () => {
    const { thread, grow } = streamingAtTheEnd();
    for (const expected of [760, 720, 680]) {
      scrollTo(thread, thread.scrollTop - 40);
      grow();
      expect(thread.scrollTop).toBe(expected);
    }
  });

  it('still reads a step up as one when the text grew since the last programmatic scroll', () => {
    const { thread, grow } = streamingAtTheEnd();
    grow();
    const end = thread.scrollTop;
    scrollTo(thread, end - 5);
    grow();
    expect(thread.scrollTop).toBe(end - 5);
  });

  it.each([['ArrowUp', false], ['PageUp', false], ['Home', false], [' ', true]])('stops following on %j before the scroll event, which a render could otherwise cancel', (key, shiftKey) => {
    const { thread, grow } = streamingAtTheEnd();
    const top = thread.scrollTop;
    fireEvent.keyDown(thread, { key, shiftKey });
    grow();
    expect(thread.scrollTop).toBe(top);
  });

  it('stops following on a wheel up before the scroll event', () => {
    const { thread, grow } = streamingAtTheEnd();
    const top = thread.scrollTop;
    fireEvent.wheel(thread, { deltaY: -3 });
    grow();
    expect(thread.scrollTop).toBe(top);
  });

  it('keeps following on keys and wheel moves that do not scroll this thread up', () => {
    const { thread, grow } = streamingAtTheEnd();
    fireEvent.wheel(thread, { deltaY: 3 });
    fireEvent.wheel(thread, { deltaX: -3 });
    fireEvent.keyDown(thread, { key: 'ArrowDown' });
    fireEvent.keyDown(thread, { key: ' ' });
    grow();
    expect(thread.scrollHeight - thread.scrollTop - thread.clientHeight).toBe(0);
    const inner = document.createElement('input');
    inner.type = 'range';
    thread.appendChild(inner);
    fireEvent.keyDown(inner, { key: 'ArrowUp' });
    grow();
    expect(thread.scrollHeight - thread.scrollTop - thread.clientHeight).toBe(0);
  });

  it('keeps following a thread with nothing above to scroll to', () => {
    const view = render(chat({ streamingText: 'One' }));
    const { thread, resize } = scrollArea();
    resize(100);
    view.rerender(chat({ streamingText: 'One two' }));
    fireEvent.wheel(thread, { deltaY: -3 });
    fireEvent.keyDown(thread, { key: 'ArrowUp' });
    resize(1000);
    view.rerender(chat({ streamingText: 'One two three' }));
    expect(thread.scrollTop).toBe(800);
  });

  it('does not take a thread shrinking under the learner for a scroll up', () => {
    const { thread, grow, resize } = streamingAtTheEnd();
    resize(900);
    fireEvent.scroll(thread);
    grow();
    expect(thread.scrollHeight - thread.scrollTop - thread.clientHeight).toBe(0);
  });

  it('holds through the end of the answer', () => {
    const { thread, rerender } = streamingAtTheEnd();
    scrollTo(thread, 100);
    rerender(chat({ isSending: false, messages: [{ id: 'u1', role: 'user', content: 'Question' }, { id: 'a1', role: 'assistant', content: 'Complete' }] }));
    expect(thread.scrollTop).toBe(100);
  });

  it('does not resume on a move down that stops short of the end', () => {
    const { thread, grow } = streamingAtTheEnd();
    scrollTo(thread, 600);
    scrollTo(thread, 740);
    grow();
    expect(thread.scrollTop).toBe(740);
  });

  it('resumes on a move down that lands just short of the end, as a smooth scroll does while text arrives', () => {
    const { thread, grow } = streamingAtTheEnd();
    scrollTo(thread, 600);
    scrollTo(thread, 770);
    grow();
    expect(thread.scrollHeight - thread.scrollTop - thread.clientHeight).toBe(0);
  });

  it('keeps the hidden status from growing the page: its scroller is its containing block', () => {
    expect(styles).toMatch(/\.chat-scroll \{[^}]*position: relative;/);
  });

  it('resumes following when the learner returns to the end', () => {
    const { thread, grow } = streamingAtTheEnd();
    scrollTo(thread, 100);
    grow();
    scrollTo(thread, thread.scrollHeight);
    grow();
    expect(thread.scrollHeight - thread.scrollTop - thread.clientHeight).toBe(0);
  });

  it('resumes following when the learner sends a new message', () => {
    const { thread, grow } = streamingAtTheEnd();
    scrollTo(thread, 100);
    fireEvent.submit(screen.getByRole('button', { name: 'Send' }).closest('form')!);
    grow();
    expect(thread.scrollHeight - thread.scrollTop - thread.clientHeight).toBe(0);
  });
});
