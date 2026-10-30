/** The StudentLLM glyph: an open notebook, written notes on the left page and a spark on the right. */
export function BrandGlyph({ size = 16 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M12 7.4C9.4 5.8 6.6 5.6 4 6.5v11.6c2.6-.9 5.4-.7 8 .9 2.6-1.6 5.4-1.8 8-.9V6.5c-2.6-.9-5.4-.7-8 .9V19" />
      <path d="M6.6 10.2l2.8.8M6.6 13.2l2.8.8" />
      <path d="M16.2 9.6c.3 1.5.7 1.9 2.2 2.2-1.5.3-1.9.7-2.2 2.2-.3-1.5-.7-1.9-2.2-2.2 1.5-.3 1.9-.7 2.2-2.2z" transform="matrix(1.15 0 0 1.15 -2.43 -1.77)" fill="currentColor" strokeWidth={1.2} />
    </svg>
  );
}
