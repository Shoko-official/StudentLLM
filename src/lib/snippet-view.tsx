import { buildSnippet } from './snippet';

/** Compact one-line plain-text excerpt with the query match highlighted. */
export function Snippet({ text, query = '' }: { text: string; query?: string }) {
  return <>{buildSnippet(text, query).map((part, index) => part.match ? <mark key={index}>{part.text}</mark> : part.text)}</>;
}
