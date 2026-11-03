import { describe, expect, it } from 'vitest';
import { conversationLanguage, detectMessageLanguage, languageName, namesALanguage } from './message-language';

const STATEMENT_EN = 'A ball is thrown from the top of a building at 20 m/s. What is the maximum height it can reach?';
const STATEMENT_FR = "Une balle est lancée du haut d'un immeuble. Quelle est la hauteur maximale ?";

describe('detectMessageLanguage', () => {
  it.each([
    'Show me a plot of it.', 'Please explain.', 'Draw it', 'Give me an example', 'Plot y = x^2 from 0 to 5.', 'What is a naïve Bayes classifier?', 'Quiz me on the levers.', 'Define the term pressure.',
    "Explain L'Hôpital's rule to me", 'Explain the Poincaré conjecture.', "What is Ampère's law?", "Explain Schrödinger's equation to me", 'Find du/dt for this function.',
  ])('reads %j as English', (text) => { expect(detectMessageLanguage(text)).toBe('en'); });

  it.each([
    'Teste-moi sur les leviers.', 'Fais un QCM stp', "C'est quoi l'entropie ?", 'Explique-moi la dérivée.', 'Pourquoi le ciel est bleu ?', 'Peux-tu me faire un quiz ?',
    'Le théorème de Bézout est faux.', 'Pourquoi la loi de Boyle est vraie ?', "Quelle est la formule d'Ampère ?",
  ])('reads %j as French', (text) => { expect(detectMessageLanguage(text)).toBe('fr'); });

  it.each([
    // Neutral, or one word, which is not enough to state a language.
    'QCM', 'Quiz', 'x = 2 ?', "f'(x) ?", '', '42', '$a = b$', 'Plot y = x^2', 'Courbe', 'Merci', 'Encore', 'Thanks', 'Help !', 'Hello', 'Why?', 'Pourquoi ?', 'Question 2 please',
    // One clear word and shared words are not two hits. This is the cost of stating less.
    'Explique la dérivée.', 'Quiz me on levers.', 'Un schéma',
    // Formulas.
    'F = ma', 'du/dx', 'Find du/dt', 'Solve du/dx = 3u', 'Compute du/dx',
    // Names: an accent or a capital elision says nothing about the learner.
    "Explain L'Hôpital's rule", "L'Hôpital's rule", "Use L'Hôpital", "Ampère's law", 'Poincaré conjecture', 'Bézier curves', 'Fréchet derivative', "Le Chatelier's principle", "d'Alembert's principle", 'Naïve Bayes', "Vitamin C's role", 'La loi de Boyle',
    // Capitals are an acronym, not a word.
    'IT',
    // Italian, with nothing to tell it from French but one word.
    'Le forze',
  ])('leaves %j unknown', (text) => { expect(detectMessageLanguage(text)).toBe('unknown'); });

  it.each([
    'Explícame la derivada por favor.', '¿Qué es una derivada?', 'Hazme un quiz sobre la historia.', 'Me puedes ayudar',
    'Spiegami la derivata per favore.', 'Cosa è una derivata?', 'Fammi un quiz sulla storia.', 'Il teorema di Pitagora', "C'è un errore nell'esercizio",
    'Explica isso para mim.', 'Erkläre mir das bitte.', 'Was ist das und wie geht es?', 'Wat is een afgeleide?',
    'Что такое производная?', 'ما هي المشتقة',
  ])('does not read %j as French or English', (text) => { expect(detectMessageLanguage(text)).toBe('other'); });

  it.each([
    ['one word of each', 'Explain le Chatelier'],
    ['a French request about an English title', 'Résume The Lord of the Rings'],
    ['a French request naming a tool', 'Calcule ça in R'],
    ['a statement, then a question', `${STATEMENT_EN}\n\nJe ne comprends pas la question b.`],
    ['a statement, then a question on the next line', `${STATEMENT_EN}\nJe ne comprends pas.`],
    ['an English question under a French statement', `${STATEMENT_FR}\n\nPlease explain.`],
    ['a question, then a statement', `Résous cet exercice :\n${STATEMENT_EN}`],
    ['a longer question, then a statement', `Peux-tu m'expliquer cet énoncé ?\n${STATEMENT_EN}`],
    ['a question, then bare code', 'Pourquoi ce code plante ?\nfor i in range(10): print(i)'],
    ['a question, then an error', 'Pourquoi cette erreur ?\nTypeError: x is not a function'],
    ['a question, then options', 'Quelle réponse ?\nA) the mass\nB) the weight'],
    ['two French sentences, then one word', "Je ne comprends pas. Peux-tu m'aider ?\nThanks"],
    ['an English question over a French sentence', 'Can you translate this?\nLe chat est sur la table.'],
  ])('calls %s mixed', (_name, text) => { expect(detectMessageLanguage(text)).toBe('mixed'); });

  it('reads the whole message when one line says nothing', () => {
    expect(detectMessageLanguage('Le courant dans le circuit est de 2 A.\n\nx = 2 ?')).toBe('fr');
    expect(detectMessageLanguage('The current in the circuit is 2 A.\n\nA) 2\nB) 4')).toBe('en');
    expect(detectMessageLanguage('Pourquoi\nce code ?')).toBe('fr');
  });

  it('gives no language to a long message that holds one foreign word', () => {
    expect(detectMessageLanguage('Le courant est dans le circuit et il passe par la résistance avec une tension, comme le dit und.')).toBe('other');
  });

  it('does not read code, formulas, links or images', () => {
    expect(detectMessageLanguage('```\nshow me the code\n```')).toBe('unknown');
    expect(detectMessageLanguage('`the code`')).toBe('unknown');
    expect(detectMessageLanguage('$the = this$ ?')).toBe('unknown');
    expect(detectMessageLanguage('![show me the](https://example.com/the.png)')).toBe('unknown');
    expect(detectMessageLanguage('https://example.com/show/me/the/page')).toBe('unknown');
    expect(detectMessageLanguage('Pourquoi ce code plante ?\n```\nfor i in range(10): print(the)\n```')).toBe('fr');
  });

  it('counts a word once, however often it comes', () => {
    expect(detectMessageLanguage('the the the')).toBe('unknown');
    expect(detectMessageLanguage('le Le le')).toBe('unknown');
    expect(detectMessageLanguage("l'eau l'eau")).toBe('unknown');
  });

  it('counts an elision only in lower case, and once for its word', () => {
    expect(detectMessageLanguage("c'est")).toBe('unknown');
    expect(detectMessageLanguage("l'eau et l'air")).toBe('fr');
    expect(detectMessageLanguage("L'Eau L'Air")).toBe('unknown');
  });

  it('reads decomposed accents like composed ones', () => {
    expect(detectMessageLanguage('Pourquoi ça ?')).toBe('fr');
  });
});

describe('namesALanguage', () => {
  it.each([
    'Réponds en anglais.', 'Reponds en anglais', 'Explique la dérivée in French please.', 'Answer in Spanish.', 'Traduis ça en espagnol', 'Write in English', 'En français stp', 'English please', 'Translate this into German',
    "Tu peux utiliser l'anglais ?", "Je veux l'anglais", 'Could you use French?', 'Use English', 'Use French', 'Utilise le français', 'I want French', 'Reply using English', 'Write English', 'Écris français',
    'English', 'english.', 'Anglais', 'Français', 'français ?', "L'anglais", 'French!',
    "Passe à l'anglais", 'Passons au français', 'Parle-moi anglais', 'Parle-nous en anglais', "Je préfère l'anglais", 'Je prefere le français', "Parle anglais s'il te plaît", "Parle français s’il te plait", 'Speak French with me', 'Speak English', 'I prefer French', 'Switch to English', 'Anglais uniquement', 'English only',
  ])('finds a request for a language in %j', (text) => { expect(namesALanguage(text)).toBe(true); });

  it.each([
    'La Révolution française', 'The French Revolution', 'la guerre anglaise', 'Explique la guerre anglaise.', 'Parle de la Révolution française', 'The English Channel', 'I read a French novel', 'I prefer the French Revolution', 'Explain the French Revolution.', 'French Revolution', 'Use the French Revolution as an example', 'Anglais et français', 'Je veux la guerre anglaise',
    'Explique la dérivée.', 'Quiz me on levers.', 'Le français est une langue.', 'in france',
  ])('finds none in %j', (text) => { expect(namesALanguage(text)).toBe(false); });
});

describe('conversationLanguage', () => {
  it('takes the language of the message', () => {
    expect(conversationLanguage('Show me a plot.', ['Explique-moi la dérivée.'])).toBe('en');
    expect(conversationLanguage('Explique-moi la dérivée.', ['Show me a plot.'])).toBe('fr');
  });

  it('falls back on a neutral or one-word message to the latest earlier message that has a language', () => {
    expect(conversationLanguage('QCM', ['Show me a plot.', 'Explique-moi la dérivée.', 'x = 2 ?'])).toBe('fr');
    expect(conversationLanguage('x = 2 ?', ['Explique-moi la dérivée.', 'Show me a plot.'])).toBe('en');
    expect(conversationLanguage('Merci', ['Explique-moi la dérivée.'])).toBe('fr');
    expect(conversationLanguage('Encore', ['Show me a plot.'])).toBe('en');
  });

  it.each([
    ['Explique la dérivée.', 'What is a derivative?'],
    ['Pourquoi ?', 'What is a derivative?'],
    ['Merci', 'What is a derivative?'],
    ['Calcule la limite', 'What is a derivative?'],
    ['Explain photosynthesis.', 'Pourquoi le ciel est bleu ?'],
    ['Define entropy.', 'Pourquoi le ciel est bleu ?'],
    ['Quiz me on levers.', 'Pourquoi le ciel est bleu ?'],
    ['Thanks', 'Explique-moi la dérivée.'],
  ])('lets a lone word of one language stop the fallback to another: %j after %j', (question, earlier) => {
    expect(conversationLanguage(question, [earlier])).toBeUndefined();
  });

  it('keeps the fallback when a lone word agrees with the earlier language', () => {
    expect(conversationLanguage('Explique la dérivée.', ['Pourquoi le ciel est bleu ?'])).toBe('fr');
    expect(conversationLanguage('Explain photosynthesis.', ['What is a derivative?'])).toBe('en');
    expect(conversationLanguage('Thanks', ['Show me a plot.'])).toBe('en');
  });

  it('keeps the fallback for a message with no word of either language', () => {
    for (const earlier of ['What is a derivative?', 'Pourquoi le ciel est bleu ?']) {
      expect(conversationLanguage('Quiz', [earlier])).toBe(conversationLanguage(earlier));
      expect(conversationLanguage('Encore', [earlier])).toBe(conversationLanguage(earlier));
    }
  });

  it('does not let a pasted statement decide for the question after it', () => {
    expect(conversationLanguage('Explique la dérivée.', [STATEMENT_EN])).toBeUndefined();
  });

  it('lets a lone word on the way back stop the fallback too', () => {
    expect(conversationLanguage('QCM', ['Explique-moi la dérivée.', 'Why?'])).toBeUndefined();
    expect(conversationLanguage('QCM', ['Explique-moi la dérivée.', 'Pourquoi ?'])).toBe('fr');
  });

  it('states nothing for a lone word on a first message', () => {
    expect(conversationLanguage('Explique la dérivée.')).toBeUndefined();
    expect(conversationLanguage('Quiz me on levers.', [])).toBeUndefined();
  });

  it('does not bring a name or formula back as a language', () => {
    expect(conversationLanguage('Encore', ['Find du/dt'])).toBeUndefined();
    expect(conversationLanguage("Explain L'Hôpital's rule", ['Ampère\'s law'])).toBeUndefined();
  });

  it('states nothing with no language anywhere', () => {
    expect(conversationLanguage('QCM', [])).toBeUndefined();
    expect(conversationLanguage('QCM')).toBeUndefined();
    expect(conversationLanguage('QCM', ['x = 2 ?'])).toBeUndefined();
  });

  it('states nothing for another language, even after French or English', () => {
    expect(conversationLanguage('Explícame la derivada por favor.', ['Explique-moi la dérivée.'])).toBeUndefined();
    expect(conversationLanguage('QCM', ['Explique-moi la dérivée.', 'Spiegami la derivata per favore.'])).toBeUndefined();
    expect(conversationLanguage('Что такое производная?', ['Show me a plot.'])).toBeUndefined();
  });

  it('gives a mixed message no fallback, and takes none from one', () => {
    const mixed = `Résous cet exercice :\n${STATEMENT_EN}`;
    expect(conversationLanguage(mixed, ['Explique-moi la dérivée.'])).toBeUndefined();
    expect(conversationLanguage(mixed, ['Show me a plot.'])).toBeUndefined();
    expect(conversationLanguage('Merci', [mixed])).toBeUndefined();
    expect(conversationLanguage('Merci', ['Explique-moi la dérivée.', mixed])).toBeUndefined();
  });

  it.each([
    'Réponds en anglais.', "Passe à l'anglais", 'Parle-moi anglais', "Je préfère l'anglais", "Parle anglais s'il te plaît", 'Speak French with me', 'Explique la dérivée in French please.',
    "Tu peux utiliser l'anglais ?", "Je veux l'anglais", 'Could you use French?', 'Use English', 'Use French', 'I want French', 'Reply using English', 'English', 'Anglais', 'Français',
  ])('states nothing when the learner asks for a language: %j', (text) => {
    expect(conversationLanguage(text)).toBeUndefined();
    expect(conversationLanguage(text, ['Show me a plot.'])).toBeUndefined();
    expect(conversationLanguage(text, ['Explique-moi la dérivée.'])).toBeUndefined();
  });

  it('keeps stating nothing after an earlier request for a language', () => {
    expect(conversationLanguage('Explique-moi la dérivée.', ['Réponds toujours en anglais.'])).toBeUndefined();
    expect(conversationLanguage('QCM', ['Answer in Spanish.'])).toBeUndefined();
  });

  it('does not take a bare adjective for a request', () => {
    expect(conversationLanguage('Explain the French Revolution.')).toBe('en');
    expect(conversationLanguage('Explique-moi la guerre anglaise.', ['The French Revolution'])).toBe('fr');
  });
});

it('names the two languages', () => {
  expect(languageName('en')).toBe('English');
  expect(languageName('fr')).toBe('French');
});
