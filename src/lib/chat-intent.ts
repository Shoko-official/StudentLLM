const GENERAL_EDUCATIONAL_PATTERN = /\b(?:génère|genere|generate|visualisation|visualization|diagramme|diagram|schéma|schema|dessine|draw|trace|plot)\b/iu;
const COURSE_SPECIFIC_PATTERN = /\b(?:dans ce cours|dans le cours|in this course|in the course|selon|according to|d['’]?après|from (?:this|the) (?:source|document|notes)|source|document|notes|transcription|formulaire)\b/iu;

export interface ChatQuestionIntent {
  generalEducationalRequest: boolean;
  courseSpecificQuestion: boolean;
}

export function classifyChatQuestion(message: string, hasRelevantEvidence: boolean): ChatQuestionIntent {
  const generalEducationalRequest = GENERAL_EDUCATIONAL_PATTERN.test(message);
  const courseSpecificQuestion = COURSE_SPECIFIC_PATTERN.test(message)
    || (hasRelevantEvidence && !generalEducationalRequest);
  return { generalEducationalRequest, courseSpecificQuestion };
}
