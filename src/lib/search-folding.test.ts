import { describe, expect, it } from 'vitest';
import { buildSnippet, foldForSearch, textMatchesQuery } from './snippet';

describe('accent-insensitive search for French text', () => {
  it('finds accented words from an unaccented query, in any case', () => {
    expect(textMatchesQuery('Le cours de thermodynamique de l’été dernier', 'ete')).toBe(true);
    expect(textMatchesQuery('École normale', 'ecole')).toBe(true);
    expect(textMatchesQuery('école normale', 'ÉCOLE')).toBe(true);
    expect(textMatchesQuery('Fonction dérivée et intégrale', 'derivee integrale')).toBe(false);
    expect(textMatchesQuery('Fonction dérivée et intégrale', 'derivee')).toBe(true);
    expect(textMatchesQuery('Français, garçon, où, naïve', 'francais garcon')).toBe(false);
    expect(textMatchesQuery('Français, garçon, où, naïve', 'garcon, ou, naive')).toBe(true);
  });

  it('treats the straight and the typographic apostrophe alike', () => {
    expect(textMatchesQuery('Il faut l’intégrale', "l'integrale")).toBe(true);
    expect(textMatchesQuery("l'intégrale", 'l’integrale')).toBe(true);
  });

  it('still tells different letters apart', () => {
    expect(textMatchesQuery('cote', 'côté')).toBe(true);
    expect(textMatchesQuery('Le château', 'chateaux')).toBe(false);
    expect(textMatchesQuery('naïve', 'naive')).toBe(true);
    expect(textMatchesQuery('œuvre', 'oeuvre')).toBe(false);
  });

  it('keeps the same length so the highlighted part is the original accented text', () => {
    const sample = 'Éléphant, ÇA, œuvre, l’été, Ǻ ǻ ẞ İ';
    expect(foldForSearch('Éléphant, ça, l’été').length).toBe('Éléphant, ça, l’été'.length);
    expect(foldForSearch(sample).length).toBeGreaterThan(0);

    const parts = buildSnippet('Nous étudions la dérivée des fonctions composées.', 'derivee');
    expect(parts.find((part) => part.match)?.text).toBe('dérivée');
  });

  it('handles queries that look like regular expressions or emoji without throwing', () => {
    for (const query of ['(((', '[a-', '\\', '.*', '😀', 'x'.repeat(5000)]) {
      expect(() => textMatchesQuery('texte avec 😀 et (parenthèses) .* [a-z]', query)).not.toThrow();
    }
    expect(textMatchesQuery('texte avec 😀 et (parenthèses)', '😀')).toBe(true);
    expect(textMatchesQuery('texte avec (parenthèses)', '(parentheses)')).toBe(true);
  });
});
