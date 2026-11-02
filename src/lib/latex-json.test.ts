import { describe, expect, it } from 'vitest';
import { repairLatexJson } from './latex-json';

const read = (reply: string) => JSON.parse(repairLatexJson(reply)) as { text: string };
const replyWith = (text: string) => `{"text":"${text}"}`;

describe('repairLatexJson', () => {
  // Each of these parses without complaint and without it the formula is silently corrupted.
  it.each([
    [String.raw`$6{,}02 \times 10^{23}$`],
    [String.raw`$\frac{a}{b}$`],
    [String.raw`$\beta = 2$`],
    [String.raw`$\binom{n}{k}$`],
    [String.raw`$a \neq b$`],
    [String.raw`$\rho = m/V$`],
    [String.raw`$\tau$ puis $\theta$`],
    [String.raw`$\forall x, \nabla f \rightarrow 0$`],
    [String.raw`$\nu = 3$ et $a \ne b$ et $\neg p$`],
  ])('restores %s written with a valid escape', (text) => {
    expect(read(replyWith(text)).text).toBe(text);
  });

  it.each([
    ['a real tab', '$a \times b$', String.raw`$a \times b$`],
    ['a real form feed', '$\frac{a}{b}$', String.raw`$\frac{a}{b}$`],
    ['a real backspace', '$\beta$', String.raw`$\beta$`],
    ['a real newline', '$a \neq b$', String.raw`$a \neq b$`],
    ['a real carriage return', '$\rho$', String.raw`$\rho$`],
  ])('reads %s inside a string, the failure "Bad control character"', (_name, text, expected) => {
    expect(() => JSON.parse(replyWith(text))).toThrow();
    expect(read(replyWith(text)).text).toBe(expected);
  });

  it.each([[String.raw`$\alpha + \gamma$`], [String.raw`$\sqrt{2} \approx 1,41$`], [String.raw`$\underline{x} \sigma$`], [String.raw`$\Delta$`]])('reads %s, which is not valid JSON at all', (text) => {
    expect(() => JSON.parse(replyWith(text))).toThrow();
    expect(read(replyWith(text)).text).toBe(text);
  });

  it('keeps a newline before ordinary text, in the words that start like a command', () => {
    expect(read(replyWith(String.raw`Ligne 1\nLigne 2`)).text).toBe('Ligne 1\nLigne 2');
    expect(read(replyWith(String.raw`D'abord\nequal parts\nnothing\neglect`)).text).toBe("D'abord\nequal parts\nnothing\neglect");
    expect(read(replyWith('Deux\nlignes réelles')).text).toBe('Deux\nlignes réelles');
    expect(read(replyWith(String.raw`Un\tmot\ttabulé`)).text).toBe('Un\tmot\ttabulé');
    // These could as well be a variable or a word on a new line, so they stay what they parsed to.
    expect(read(replyWith(String.raw`Soit\nu = 3`)).text).toBe('Soit\nu = 3');
    expect(read(replyWith(String.raw`Il\ne sait pas`)).text).toBe('Il\ne sait pas');
    expect(read(replyWith(String.raw`Voici\toù aller`)).text).toBe('Voici\toù aller');
  });

  it('leaves what is already right as it was', () => {
    for (const reply of [
      '{"a":1.0,"b":"x"}',
      replyWith(String.raw`$\\times \\frac{a}{b}$`),
      replyWith(String.raw`guillemet \" barre \/ accent é fin`),
      '{ "spaced" : [ 1 , 2 ] }',
    ]) expect(repairLatexJson(reply)).toBe(reply);
  });

  it('reaches every string of the object, and no key or number', () => {
    const reply = String.raw`{"options":["$\times$","2"],"nested":{"text":"$\beta$"},"answer":1}`;
    expect(JSON.parse(repairLatexJson(reply))).toEqual({ options: [String.raw`$\times$`, '2'], nested: { text: String.raw`$\beta$` }, answer: 1 });
  });

  it('returns what it cannot read, so the caller reports it as before', () => {
    for (const reply of ['not json', '{"a":', '{"a":"open', '']) expect(repairLatexJson(reply)).toBe(reply);
  });

  it('does not touch a backslash outside a string', () => {
    expect(repairLatexJson(String.raw`{"a":\q}`)).toBe(String.raw`{"a":\q}`);
  });
});
