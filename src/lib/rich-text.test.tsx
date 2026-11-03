import { render, screen, waitFor } from '@testing-library/react';
import katex from 'katex';
import { afterEach, describe, expect, it, vi } from 'vitest';
import packageLock from '../../package-lock.json';
import { RichText } from './rich-text';

function classNames(root: Element) {
  return new Set([...root.querySelectorAll('[class]')].flatMap((element) => [...element.classList]));
}

describe('RichText', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    Reflect.deleteProperty(document, 'fonts');
  });

  // KaTeX renames classes between versions, so Markdown math must come from the build that katex.min.css belongs to.
  it('installs one KaTeX, shared by rehype-katex and the stylesheet', () => {
    expect(Object.keys(packageLock.packages).filter((path) => /(^|\/)node_modules\/katex$/.test(path))).toEqual(['node_modules/katex']);

    const { container } = render(<RichText content={'$(x+y)^n$'} />);
    const direct = document.createElement('div');
    direct.innerHTML = katex.renderToString('(x+y)^n');
    expect(classNames(container.querySelector('.katex')!)).toEqual(classNames(direct.querySelector('.katex')!));
  });

  it('makes a scroller of a formula with a run wider than its line, and follows new content', () => {
    // jsdom has no layout: a run that says "wide" measures wider than every line.
    vi.spyOn(Element.prototype, 'scrollWidth', 'get').mockImplementation(function (this: Element) { return this.textContent?.includes('wide') ? 900 : 10; });
    vi.spyOn(Element.prototype, 'clientWidth', 'get').mockReturnValue(300);
    const wide = '$\\text{wide}$';
    const { container, rerender } = render(<RichText content={`${wide} and $x$\n\n$$\\text{wide}$$\n\n$$y$$`} />);
    const formulas = () => [...container.querySelectorAll('p .katex')];
    expect(formulas()[0]).toHaveClass('katex-scrolls');
    expect(formulas()[0]).toHaveAttribute('tabindex', '0');
    expect(formulas()[1]).not.toHaveClass('katex-scrolls');
    expect(formulas()[1]).not.toHaveAttribute('tabindex');
    expect(container.querySelector('.katex-display .katex-scrolls')).toBeNull();
    // Without the conversation's opt-in, only the display formula that overflows takes a tab stop.
    expect([...container.querySelectorAll('.katex-display')].map((display) => display.getAttribute('tabindex'))).toEqual(['0', null]);

    rerender(<RichText content={`$x$ and ${wide}`} />);
    expect(formulas()[0]).not.toHaveClass('katex-scrolls');
    expect(formulas()[1]).toHaveClass('katex-scrolls');
  });

  it('measures formulas again once the KaTeX fonts have loaded', async () => {
    let loaded = () => {};
    Object.defineProperty(document, 'fonts', { configurable: true, value: { ready: new Promise<void>((resolve) => { loaded = resolve; }) } });
    const scrollWidth = vi.spyOn(Element.prototype, 'scrollWidth', 'get').mockReturnValue(10);
    vi.spyOn(Element.prototype, 'clientWidth', 'get').mockReturnValue(300);
    const { container } = render(<RichText content={'$x$'} />);
    expect(container.querySelector('.katex')).not.toHaveClass('katex-scrolls');

    scrollWidth.mockReturnValue(900);
    loaded();
    await waitFor(() => expect(container.querySelector('.katex')).toHaveClass('katex-scrolls'));
  });

  it('lets a conversation opt into keyboard scrolling for formulas, code and tables', () => {
    const { container } = render(<RichText focusableScrollRegions content={'$$y=\\frac{x}{2}$$\n\n```text\na long code line\n```\n\n| A | B |\n| --- | --- |\n| one | two |'} />);
    for (const selector of ['.katex-display', 'pre', 'table']) expect(container.querySelector(selector)).toHaveAttribute('tabindex', '0');
    expect(container.querySelector('.katex-html')).toHaveAttribute('aria-hidden', 'true');
  });
  it('renders GitHub-flavored Markdown, code, tables, and LaTeX together', () => {
    const { container } = render(<RichText content={'## Key ideas\n\n- Scale by $\\sqrt{d_k}$\n- Keep the source visible\n\n```ts\nconst answer = 42;\n```\n\n| Term | Value |\n| --- | ---: |\n| Batch | 32 |'} />);

    expect(container.querySelector('h2')).toHaveTextContent('Key ideas');
    expect(container.querySelector('ul')).toHaveTextContent('Scale by');
    expect(screen.getByText('const answer = 42;')).toBeVisible();
    expect(container.querySelector('table')).toHaveTextContent('Batch');
    expect(document.querySelector('.katex')).not.toBeNull();
  });

  it('renders inline and display LaTeX with semantic KaTeX markup', () => {
    const { container } = render(<RichText content={'Scale by $\\sqrt{d_k}$ before applying softmax.\n$$y = \\frac{x}{2}$$'} />);

    expect(container.querySelectorAll('.katex')).toHaveLength(2);
    expect(container.querySelectorAll('.katex-display')).toHaveLength(1);
    expect(container.querySelectorAll('math')).toHaveLength(2);
  });

  it('renders multi-line display environments such as cases with spacing and tags', () => {
    const { container } = render(<RichText content={String.raw`La suite :

$$
\begin{cases}
y_0(t) = \alpha \\[6pt]
y_k(t) = \alpha + \int_a^t f(z, y_{k-1}(z))\, dz
\end{cases}
\tag{3}
$$

\[
\begin{pmatrix} 1 & 0 \\ 0 & 1 \end{pmatrix}
\]`} />);

    expect(container.querySelectorAll('.katex-display')).toHaveLength(2);
    expect(container.textContent).not.toContain('$\\begin');
  });

  it('renders display math opened on the same line as an environment', () => {
    const { container } = render(<RichText content={String.raw`Pour chacune des fonctions :

$$\begin{aligned}
f_1(t,y) &= t^2 y + 1 \\
f_2(t,y) &= ty
\end{aligned}$$`} />);

    expect(container.querySelectorAll('.katex-display')).toHaveLength(1);
    container.querySelectorAll('.katex').forEach((node) => node.remove());
    expect(container.textContent).not.toMatch(/\\begin|\$/);
  });

  it('keeps absolute values inside display math instead of treating them as table cells', () => {
    const { container } = render(<RichText content={String.raw`$$\forall \varepsilon > 0,\quad |z(t) - y(t)| \leq K\varepsilon$$`} />);

    expect(container.querySelectorAll('.katex-display')).toHaveLength(1);
    container.querySelectorAll('.katex').forEach((node) => node.remove());
    expect(container.textContent).not.toContain('$');
  });

  it('repairs a \\tag whose backslash-t was decoded as a tab by a model', () => {
    const { container } = render(<RichText content={'$$y(0) = 2 \u0009ag{1}$$'} />);

    expect(container.querySelectorAll('.katex-display')).toHaveLength(1);
    container.querySelectorAll('.katex').forEach((node) => node.remove());
    expect(container.textContent).not.toContain('ag{1}');
  });

  it('keeps malformed LaTeX legible instead of displaying a KaTeX error', () => {
    const { container } = render(<RichText content={'\\(\\notARealCommand{x}\\)'} />);

    expect(container).toHaveTextContent('\\notARealCommand{x}');
    expect(container.querySelector('.katex-error')).toBeNull();
    expect(container.querySelector('[style*="color: red"]')).toBeNull();
  });

  it('sets extracted mathematical source apart from surrounding prose', () => {
    render(<div><RichText content={'Divergence of a vector field\n∂Fₓ/∂x + ∂Fᵧ/∂y'} highlightExtractedMath /></div>);

    const source = screen.getByText('∂Fₓ/∂x + ∂Fᵧ/∂y');
    expect(source).toHaveClass('extracted-math-line');
    expect(source).toHaveAttribute('aria-label', 'Extracted mathematical source');
  });
  it('repairs legacy LaTeX controls and renders bare formulas in Markdown tables', () => {
    const { container } = render(<RichText content={'| Formula |\n| --- |\n| \u000crac{x}{2} |'} />);

    expect(container.querySelector('td .katex')).not.toBeNull();
    expect(container.textContent).not.toContain('\u000c');
  });

  it('renders bare LaTeX formulas inside Markdown list items', () => {
    const { container } = render(<RichText content={"- \\\\operatorname{th}'x=1-\\\\operatorname{th}^2x=\\\\frac{1}{\\\\operatorname{ch}^2x}"} />);

    expect(container.querySelector('li .katex')).not.toBeNull();
  });

  it('renders extracted bare derivative lines instead of exposing raw commands', () => {
    const { container } = render(<RichText content={'Gradient\n\\partialx + \\partialFy\n\\partialz'} />);

    expect(container.querySelectorAll('.katex')).toHaveLength(2);
    expect(container.textContent).not.toContain('\\partialx');
    expect(container.textContent).not.toContain('\\partialFy');
  });

  it('keeps dollar signs inside code fences untouched', () => {
    const { container } = render(<RichText content={'```python\nprice = "$5"\n```'} />);

    expect(container.querySelector('code')).toHaveTextContent('price = "$5"');
    expect(container.querySelector('.katex')).toBeNull();
  });

  it('renders LaTeX fragments embedded in prose list items', () => {
    const { container } = render(<RichText content={'- Connect operators: (\\operatorname{div}(\\nabla f)=\\Delta f).'} />);

    expect(container.querySelector('li .katex')).not.toBeNull();
    expect(container.querySelector('li')?.firstChild?.textContent).toBe('Connect operators: (');
  });

  it('repairs an unclosed inline LaTeX delimiter in a Markdown table cell', () => {
    const { container } = render(<RichText content={'| Function | Primitive |\n| --- | --- |\n| 1/x | $\\text{ln} |'} />);

    expect(container.querySelector('table .katex')).not.toBeNull();
    expect(container.textContent).not.toContain('$\\text{ln}');
  });

  it('repairs a truncated Markdown table cell without a trailing row pipe', () => {
    const { container } = render(<RichText content={'| Function | Primitive |\n| --- | --- |\n| 1/x | $\\text{ln}'} />);

    expect(container.querySelector('table .katex')).not.toBeNull();
    expect(container.textContent).not.toContain('$\\text{ln}');
  });
});
