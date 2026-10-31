import { useState } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';

const markdownRenders = vi.hoisted(() => ({ count: 0 }));
vi.mock('react-markdown', () => ({
  default: ({ children }: { children: string }) => {
    markdownRenders.count += 1;
    return <p>{children}</p>;
  },
}));

import { RichText } from './rich-text';

function Page() {
  const [typed, setTyped] = useState('');
  return (
    <>
      <input aria-label="Search" value={typed} onChange={(event) => setTyped(event.target.value)} />
      <RichText content="A long note that does not change." />
    </>
  );
}

describe('RichText rendering cost', () => {
  it('does not typeset the same Markdown again when only unrelated state changes', () => {
    markdownRenders.count = 0;
    render(<Page />);
    expect(markdownRenders.count).toBe(1);

    for (const value of ['d', 'de', 'der']) fireEvent.change(screen.getByLabelText('Search'), { target: { value } });
    expect(markdownRenders.count).toBe(1);
  });
});
