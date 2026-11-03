import { describe, expect, it } from 'vitest';
import { conversationLanguage, detectMessageLanguage, languageName, namesALanguage } from './message-language';

describe('detectMessageLanguage', () => {
  it.each([
    'Quiz me on levers.', 'Show me a plot of it.', 'Draw it', 'Please explain.', 'Why?', 'Thanks!', 'Test my knowledge', 'Give me an example', 'Plot y = x^2 from 0 to 5.', 'What is a naïve Bayes classifier?',
  ])('reads %j as English', (text) => { expect(detectMessageLanguage(text)).toBe('en'); });

  it.each([
    'Teste-moi sur les leviers.', 'Fais un QCM stp', 'Un schéma', "C'est quoi l'entropie ?", 'Explique la dérivée.', 'Montre-moi.', 'Pourquoi ?', 'Merci', "J'ai besoin d'aide", 'Peux-tu me faire un quiz ?',
  ])('reads %j as French', (text) => { expect(detectMessageLanguage(text)).toBe('fr'); });

  it.each(['QCM', 'Quiz', 'x = 2 ?', "f'(x) ?", '', '42', '$a = b$', 'Plot y = x^2', 'Courbe', 'Explain le Chatelier'])('leaves %j unknown', (text) => { expect(detectMessageLanguage(text)).toBe('unknown'); });

  it.each([
    'Explícame la derivada por favor.', '¿Qué es una derivada?', 'Hazme un quiz sobre la historia.',
    'Spiegami la derivata per favore.', 'Cosa è una derivata?', 'Fammi un quiz sulla storia.', 'Il teorema di Pitagora',
    'Explica isso para mim.', 'Erkläre mir das bitte.', 'Was ist das und wie geht es?', 'Wat is een afgeleide?',
  ])('does not read %j as French or English', (text) => { expect(detectMessageLanguage(text)).toBe('other'); });

  it('reads the last line first, so a pasted statement does not decide', () => {
    const english = 'A ball is thrown from the top of a building at 20 m/s. What is the maximum height it can reach?';
    const french = "Une balle est lancée du haut d'un immeuble. Quelle est la hauteur maximale ?";
    expect(detectMessageLanguage(`${english}\n\nJe ne comprends pas la question b.`)).toBe('fr');
    expect(detectMessageLanguage(`${english}\nJe ne comprends pas.`)).toBe('fr');
    expect(detectMessageLanguage(`${french}\n\nPlease explain.`)).toBe('en');
  });

  it('reads the whole message when the last line says nothing', () => {
    expect(detectMessageLanguage('Le courant dans le circuit est de 2 A.\n\nx = 2 ?')).toBe('fr');
    expect(detectMessageLanguage('The current in the circuit is 2 A.\n\nA) 2\nB) 4')).toBe('en');
  });

  it('does not let a last line in another language fall through to the statement', () => {
    expect(detectMessageLanguage('The current in the circuit is 2 A.\n\nExplícame por favor.')).toBe('other');
  });

  it('lets a long message hold a stray foreign word', () => {
    expect(detectMessageLanguage('Le courant est dans le circuit et il passe par la résistance avec une tension, comme le dit und.')).toBe('fr');
  });

  it('does not read code, formulas, links or images', () => {
    expect(detectMessageLanguage('```\nshow me the code\n```')).toBe('unknown');
    expect(detectMessageLanguage('`the`')).toBe('unknown');
    expect(detectMessageLanguage('$the = 2$ ?')).toBe('unknown');
    expect(detectMessageLanguage('![show me the](https://example.com/the.png)')).toBe('unknown');
    expect(detectMessageLanguage('https://example.com/show/me/the/page')).toBe('unknown');
  });

  it('reads decomposed accents as French', () => {
    expect(detectMessageLanguage('Un schéma')).toBe('fr');
  });
});

describe('namesALanguage', () => {
  it.each(['Réponds en anglais.', 'Reponds en anglais', 'Explique la dérivée in French please.', 'Answer in Spanish.', 'Traduis ça en espagnol', 'Write in English', 'En français stp', 'English please', 'Translate this into German'])('finds a language asked for in %j', (text) => { expect(namesALanguage(text)).toBe(true); });
  it.each(['La Révolution française', 'The French Revolution', 'Explique la dérivée.', 'Quiz me on levers.', 'Le français est une langue.', 'in france'])('finds none in %j', (text) => { expect(namesALanguage(text)).toBe(false); });
});

describe('conversationLanguage', () => {
  it('takes the language of the message', () => {
    expect(conversationLanguage('Show me a plot.', ['Explique la dérivée.'])).toBe('en');
    expect(conversationLanguage('Explique la dérivée.', ['Show me a plot.'])).toBe('fr');
  });

  it('falls back on a neutral message to the latest earlier message that has a language', () => {
    expect(conversationLanguage('QCM', ['Show me a plot.', 'Explique la dérivée.', 'x = 2 ?'])).toBe('fr');
    expect(conversationLanguage('x = 2 ?', ['Explique la dérivée.', 'Show me a plot.'])).toBe('en');
  });

  it('states nothing with no language anywhere', () => {
    expect(conversationLanguage('QCM', [])).toBeUndefined();
    expect(conversationLanguage('QCM')).toBeUndefined();
    expect(conversationLanguage('QCM', ['x = 2 ?'])).toBeUndefined();
  });

  it('states nothing for another language, even after French or English', () => {
    expect(conversationLanguage('Explícame la derivada por favor.', ['Explique la dérivée.'])).toBeUndefined();
    expect(conversationLanguage('QCM', ['Explique la dérivée.', 'Spiegami la derivata per favore.'])).toBeUndefined();
  });

  it('states nothing when the learner names a language, in this message or an earlier one', () => {
    expect(conversationLanguage('Réponds en anglais.')).toBeUndefined();
    expect(conversationLanguage('Explique la dérivée in French please.', ['Show me a plot.'])).toBeUndefined();
    expect(conversationLanguage('Explique la dérivée.', ['Réponds toujours en anglais.'])).toBeUndefined();
    expect(conversationLanguage('QCM', ['Answer in Spanish.'])).toBeUndefined();
  });
});

it('names the two languages', () => {
  expect(languageName('en')).toBe('English');
  expect(languageName('fr')).toBe('French');
});
