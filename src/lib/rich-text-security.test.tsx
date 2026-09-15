import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { RichText } from './rich-text';

describe('RichText external content', () => {
  it('does not load remote images or unsafe links from model content', () => {
    const { container } = render(<RichText content={'![tracking pixel](https://example.com/pixel.gif) [safe](https://example.com) [unsafe](javascript:alert(1))'} />);

    expect(container.querySelector('img')).toBeNull();
    expect(screen.getByRole('img', { name: 'tracking pixel' })).toHaveTextContent('tracking pixel');
    expect(container.querySelector('a[href="https://example.com"]')).not.toBeNull();
    expect(container.querySelector('a[href^="javascript:"]')).toBeNull();
    expect(container).toHaveTextContent('unsafe');
  });
});
