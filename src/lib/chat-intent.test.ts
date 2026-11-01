import { describe, expect, it } from 'vitest';
import { classifyChatQuestion } from './chat-intent';

describe('classifyChatQuestion', () => {
  it('keeps an accented French visualization request general even when course evidence matches', () => {
    expect(classifyChatQuestion('génère une visualisation du cercle trigo', true)).toEqual({
      generalEducationalRequest: true,
      courseSpecificQuestion: false,
    });
  });

  it('keeps an explicit course question grounded in the course evidence', () => {
    expect(classifyChatQuestion('Quel est le rôle du gradient dans ce cours ?', true)).toEqual({
      generalEducationalRequest: false,
      courseSpecificQuestion: true,
    });
  });

  it('accepts an interactive lesson and a natural explanation without sources', () => {
    expect(classifyChatQuestion('Crée un cours interactif sur Taylor', false).generalEducationalRequest).toBe(true);
    expect(classifyChatQuestion('Explique les probabilités avec un exemple', false)).toEqual({ generalEducationalRequest: true, courseSpecificQuestion: false });
    expect(classifyChatQuestion('Donne-moi 15 exercices de probabilités corrigés', false).generalEducationalRequest).toBe(true);
    expect(classifyChatQuestion('Fais-moi un cours complet de probabilités', false).generalEducationalRequest).toBe(true);
    expect(classifyChatQuestion('Python Masterclass', false).generalEducationalRequest).toBe(true);
  });

  it('keeps normal explanations grounded when evidence exists and explicit course requests grounded when it does not', () => {
    expect(classifyChatQuestion('Explain attention', true)).toEqual({ generalEducationalRequest: false, courseSpecificQuestion: true });
    expect(classifyChatQuestion('Crée un graphique selon les données dans mon cours', false).courseSpecificQuestion).toBe(true);
    expect(classifyChatQuestion('What is the secret password?', false).generalEducationalRequest).toBe(false);
    expect(classifyChatQuestion('Donne-moi des exercices selon mes notes', false).courseSpecificQuestion).toBe(true);
  });
});
