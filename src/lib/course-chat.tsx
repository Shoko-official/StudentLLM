import { useLayoutEffect, useRef } from 'react';
import type { FormEvent } from 'react';
import { ArrowUp, BookOpen, ChevronDown, FileText, LoaderCircle } from 'lucide-react';
import type { ChatMessage } from '../types';
import { RichText } from './rich-text';

interface CourseChatProps {
  messages: ChatMessage[];
  sourceCount: number;
  hasMaterial: boolean;
  providerName: string | null;
  draft: string;
  isSending: boolean;
  error: string | null;
  onDraftChange: (value: string) => void;
  onSubmit: (event: FormEvent) => void;
  onOpenSources: () => void;
  onOpenSettings: () => void;
  onOpenCitation: (target: string) => void;
}

/** Presentation and keyboard interaction; the parent owns requests, history and recovery. */
export function CourseChat({ messages, sourceCount, hasMaterial, providerName, draft, isSending, error, onDraftChange, onSubmit, onOpenSources, onOpenSettings, onOpenCitation }: CourseChatProps) {
  const threadRef = useRef<HTMLDivElement>(null);
  const viewRef = useRef<HTMLElement>(null);
  const headingRef = useRef<HTMLElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const composeAreaRef = useRef<HTMLDivElement>(null);
  const followingRef = useRef(true);

  useLayoutEffect(() => {
    const area = composeAreaRef.current;
    const shell = area?.closest<HTMLElement>('.app-shell');
    if (!area || !shell) return;
    const previous = shell.style.getPropertyValue('--toast-bottom');
    const positionToasts = () => shell.style.setProperty('--toast-bottom', `${Math.max(20, window.innerHeight - area.getBoundingClientRect().top + 12)}px`);
    const observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(positionToasts);
    observer?.observe(area);
    window.addEventListener('resize', positionToasts);
    positionToasts();
    return () => {
      observer?.disconnect();
      window.removeEventListener('resize', positionToasts);
      if (previous) shell.style.setProperty('--toast-bottom', previous);
      else shell.style.removeProperty('--toast-bottom');
    };
  }, []);

  useLayoutEffect(() => {
    const thread = threadRef.current;
    if (thread && followingRef.current) thread.scrollTop = thread.scrollHeight;
  }, [messages.length, isSending]);

  useLayoutEffect(() => {
    const field = textareaRef.current;
    const view = viewRef.current;
    const heading = headingRef.current;
    const area = composeAreaRef.current;
    const thread = threadRef.current;
    if (!field || !view || !heading || !area || !thread) return;
    const resizeField = () => {
      field.style.height = 'auto';
      const threadStyle = getComputedStyle(thread);
      // Reserve readable history beyond its padding; longer drafts scroll inside the field.
      const threadSpace = Math.max(72, parseFloat(threadStyle.paddingTop || '0') + parseFloat(threadStyle.paddingBottom || '0') + 48);
      const composerChrome = area.getBoundingClientRect().height - field.getBoundingClientRect().height;
      const available = view.clientHeight - heading.getBoundingClientRect().height - composerChrome - threadSpace;
      const limit = Math.max(40, Math.min(200, available));
      field.style.height = `${Math.min(Math.max(64, field.scrollHeight), limit)}px`;
      if (followingRef.current) thread.scrollTop = thread.scrollHeight;
    };
    const observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(resizeField);
    observer?.observe(view);
    observer?.observe(heading);
    window.addEventListener('resize', resizeField);
    resizeField();
    return () => { observer?.disconnect(); window.removeEventListener('resize', resizeField); };
  }, [draft, error]);

  return <section className="chat-view" id="view-panel-chat" role="tabpanel" aria-labelledby="view-tab-chat" ref={viewRef}>
    <header className="chat-heading" ref={headingRef}>
      <span className="chat-heading-label">Course conversation</span>
      <details className="chat-context">
        <summary><BookOpen size={14} aria-hidden="true" /><span>{sourceCount} source{sourceCount === 1 ? '' : 's'}</span><ChevronDown size={13} aria-hidden="true" /></summary>
        <div className="chat-context-content"><p>Course-specific answers use the notes and sources saved in this course.</p><button type="button" className="text-action" onClick={onOpenSources}>Open course sources</button></div>
      </details>
    </header>
    <div className="chat-scroll" ref={threadRef} tabIndex={0} role="region" aria-label="Conversation history" onScroll={(event) => {
      const node = event.currentTarget;
      followingRef.current = node.scrollHeight - node.scrollTop - node.clientHeight < 96;
    }}>
      {!messages.length && <div className="chat-intro">
        <BookOpen size={26} strokeWidth={1.5} aria-hidden="true" />
        <h2>Ask about this course</h2>
        <p>{providerName ? 'Work through an idea, compare explanations, or ask a question about your material. Source references let you check the original.' : 'Connect an AI provider in Settings to generate answers. Your notes and sources stay available while it is offline.'}</p>
        {!hasMaterial && <p className="chat-empty-hint">Import material or record a lecture to ask source-grounded questions.</p>}
      </div>}
      <div className="chat-list" role="log" aria-label="Course conversation" aria-live="polite" aria-relevant="additions">
        {messages.map((message) => <article className={`chat-message ${message.role}`} data-role={message.role} aria-label={message.role === 'user' ? 'Your message' : 'Course assistant response'} key={message.id}>
          <header className="message-header"><span className="message-role">{message.role === 'user' ? 'You' : 'Course assistant'}</span></header>
          <div className="message-content"><RichText content={message.content} className="chat-markdown" focusableScrollRegions allowTeachingVisuals={message.role === 'assistant'} /></div>
          {message.citations && <div className="citation-list" aria-label="Response context">{message.citations.map((citation, index) => message.citationTargets?.[index]
            ? <button type="button" className="citation-chip" title="Open original source" key={citation} onClick={() => onOpenCitation(message.citationTargets![index])}><FileText size={13} /><span>{citation}</span></button>
            : <span className={/^(?:LM Studio|NVIDIA NIM) ·/.test(citation) ? 'citation-model' : 'citation-context'} key={citation}>{citation}</span>)}</div>}
        </article>)}
      </div>
      {isSending && <div className="chat-progress" role="status" aria-label="Answer in progress"><LoaderCircle size={15} aria-hidden="true" /><span>Preparing an answer...</span></div>}
    </div>
    <div className="chat-compose-area" ref={composeAreaRef}>
      {error && <div className="action-error chat-error" role="alert"><p>{error}</p><button type="button" className="text-action" onClick={onOpenSettings}>Open Settings</button></div>}
      <form className="chat-composer" onSubmit={(event) => { followingRef.current = true; onSubmit(event); }}>
        <textarea ref={textareaRef} rows={2} aria-label="Ask the course chat" aria-describedby="chat-composer-help" value={draft} onChange={(event) => onDraftChange(event.target.value)} onKeyDown={(event) => {
          if (event.key !== 'Enter' || event.shiftKey || event.nativeEvent.isComposing || event.keyCode === 229) return;
          event.preventDefault();
          if (!isSending && draft.trim()) event.currentTarget.form?.requestSubmit();
        }} placeholder="Ask a question about your course" disabled={isSending} />
        <div className="chat-composer-footer"><span className="chat-provider">{providerName ?? 'AI not connected'}</span><button className="primary-action" type="submit" aria-label="Send" disabled={isSending || !draft.trim()}><ArrowUp size={19} aria-hidden="true" /></button></div>
      </form>
      <p className="chat-composer-help" id="chat-composer-help"><span>Enter to send <span aria-hidden="true">·</span> Shift+Enter for a new line</span><span>Check important answers against your sources.</span></p>
    </div>
  </section>;
}
