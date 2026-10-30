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
});
