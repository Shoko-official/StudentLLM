const GENERAL_EDUCATIONAL_PATTERN = /\b(?:genere|generate|cree|create|visualisations?|visualizations?|diagrammes?|diagrams?|schemas?|dessine|draw|trace|plot|graphiques?|graphs?|interactif|interactive|interactifs|quiz|simulateur|simulation)\b/iu;
const EXPLANATION_PATTERN = /\b(?:explique|explain|enseigne|teach|apprends|cours sur|lesson on|comment fonctionne|how does)\b/iu;
const COURSE_SPECIFIC_PATTERN = /\b(?:dans (?:ce|le|mon) cours|in (?:this|the|my) course|selon|according to|d['’]?apres|from (?:this|the|my) (?:source|document|notes)|source|document|notes|transcription|formulaire)\b/iu;

export interface ChatQuestionIntent {
  generalEducationalRequest: boolean;
  courseSpecificQuestion: boolean;
}

export function classifyChatQuestion(message: string, hasRelevantEvidence: boolean): ChatQuestionIntent {
  const normalized = message.normalize('NFD').replace(/[\u0300-\u036f]/g, '');
  const generalEducationalRequest = GENERAL_EDUCATIONAL_PATTERN.test(normalized)
    || (!hasRelevantEvidence && EXPLANATION_PATTERN.test(normalized));
  const courseSpecificQuestion = COURSE_SPECIFIC_PATTERN.test(normalized)
    || (hasRelevantEvidence && !generalEducationalRequest);
  return { generalEducationalRequest, courseSpecificQuestion };
}
