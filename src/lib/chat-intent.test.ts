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
  });

  it('keeps normal explanations grounded when evidence exists and explicit course requests grounded when it does not', () => {
    expect(classifyChatQuestion('Explain attention', true)).toEqual({ generalEducationalRequest: false, courseSpecificQuestion: true });
    expect(classifyChatQuestion('Crée un graphique selon les données dans mon cours', false).courseSpecificQuestion).toBe(true);
    expect(classifyChatQuestion('What is the secret password?', false).generalEducationalRequest).toBe(false);
  });
});
