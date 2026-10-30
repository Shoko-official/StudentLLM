import { memo, useMemo } from 'react';
import { buildSnippet } from './snippet';

/** Compact one-line plain-text excerpt with the query match highlighted. */
export const Snippet = memo(function Snippet({ text, query = '' }: { text: string; query?: string }) {
  const parts = useMemo(() => buildSnippet(text, query), [text, query]);
  return <>{parts.map((part, index) => part.match ? <mark key={index}>{part.text}</mark> : part.text)}</>;
});
