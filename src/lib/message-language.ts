export type MessageLanguage = 'fr' | 'en';
export type MessageReading = MessageLanguage | 'other' | 'unknown';

const wordList = (words: string) => new Set(words.split(/\s+/).filter(Boolean));

// Short chat messages have few words, so one clear hit is enough, and a word only counts if it says little else. Words that
// French shares with Spanish or Italian (la, de, un, en, que, il, se) or with English (on, a, plus, question) are in no list.
const FRENCH = wordList(`
  le les des du une est sont dans avec qui cette ces aux nous vous ils elles pas mais donc sur par aussi comme sans sous
  leur leurs ses ainsi quand chaque depuis tous toutes selon ont fait dont ce au elle et ou je tu moi toi mon ma mes ton
  ta tes pour pourquoi comment quoi quel quelle quels quelles stp svp merci bonjour salut explique expliquez expliquer
  montre montrez montrer donne donnez fais faites faire peux peut veux voudrais aide dis dessine
`);
const ENGLISH = wordList(`
  the of and to is that it for with was are this at from which not have has they their can will what how why when where
  who these those you your we my me please pls show explain give make draw help tell could would should does did want
  need thanks thank hi hello about in let
`);
// Words that mark Spanish, Italian, Portuguese, German and Dutch, and that a French or English message rarely holds. They
// keep a message in those languages from reading as French or English, so they need not be complete.
const OTHERS = wordList(`
  el los las una por para pero también muy qué él sobre hola gracias explica dame muestra hazme está
  gli della delle dei di nel nella sulla che sono anche questo questa perché più già città è ciao grazie favore spiegami
  fammi mostrami puoi cosa
  uma são você isso obrigado obrigada pelo pela é
  das und ist nicht ein eine zu auf für auch sich sind wird bitte zeig wie
  een het niet ook zijn voor deze wordt maar als naar wat
`);
const OTHER_LETTER = /[áíóúñãõäößìò]/u;
const OTHER_MARK = /[¿¡]/gu;
const FRENCH_LETTER = /[éèêëàâîïôûùçœ]/u;
const ELISION = /(?<!\p{L})(?:l|d|qu|j|c|n|s|m|t|jusqu|lorsqu|puisqu)['’]\p{L}/gu;
// One foreign word stops a short message, and takes this many hits to outweigh in a long one.
const HITS_PER_OTHER = 5;

const LANGUAGE_NAMES = 'français|francais|anglais|espagnol|allemand|italien|portugais|chinois|japonais|arabe|russe|french|english|spanish|german|italian|portuguese|chinese|japanese|arabic|russian';
const NAMED_LANGUAGE = new RegExp(`(?<!\\p{L})(?:(?:en|in|into|to|vers)\\s+(?:${LANGUAGE_NAMES})|(?:${LANGUAGE_NAMES})\\s+(?:please|pls|stp|svp))(?!\\p{L})`, 'u');

const lowered = (text: string) => text.normalize('NFC').toLowerCase();

/** A formula, code or a link is not prose, and its letters must not be read as words. */
const proseOf = (text: string) => lowered(text)
  .replace(/```[\s\S]*?```/g, ' ')
  .replace(/`[^`]*`/g, ' ')
  .replace(/!?\[[^\]]*\]\([^)]*\)/g, ' ')
  .replace(/(?:https?|data):\S+/g, ' ')
  .replace(/\$\$?[^$]*\$\$?/g, ' ')
  .replace(/\\[a-z]+/g, ' ');

function read(text: string): MessageReading {
  const prose = proseOf(text);
  const hits = { fr: prose.match(ELISION)?.length ?? 0, en: 0, other: prose.match(OTHER_MARK)?.length ?? 0 };
  for (const word of prose.split(/[^\p{L}]+/u)) {
    if (OTHERS.has(word) || OTHER_LETTER.test(word)) hits.other++;
    else if (FRENCH.has(word) || FRENCH_LETTER.test(word)) hits.fr++;
    else if (ENGLISH.has(word)) hits.en++;
  }
  const [language, found, against] = hits.fr >= hits.en ? ['fr', hits.fr, hits.en] as const : ['en', hits.en, hits.fr] as const;
  if (hits.other * HITS_PER_OTHER > found) return 'other';
  return found > 0 && found >= against * 2 ? language : 'unknown';
}

/**
 * The language of a learner's message, French against English. The last line goes first, because a statement pasted in
 * another language may come before the learner's own question, and the whole message after it. Another language gives
 * "other", and a message with too little to read gives "unknown".
 */
export function detectMessageLanguage(text: string): MessageReading {
  const lastLine = text.split(/\r?\n/).map((line) => line.trim()).filter(Boolean).at(-1) ?? '';
  const last = read(lastLine);
  return last === 'unknown' ? read(text) : last;
}

/** Whether a message names a language to work in, as in "réponds en anglais" or "in French please". It can also be a topic, and then too the model is left to read it. */
export const namesALanguage = (text: string) => NAMED_LANGUAGE.test(lowered(text));

/**
 * The language to state to a model for this conversation, if any. A learner who has named a language decides, and is left
 * to the model to follow. A neutral message takes the language of the latest earlier message that has one. Another language
 * states nothing: the model follows it better than a note could.
 */
export function conversationLanguage(question: string, earlierLearnerTexts: string[] = []): MessageLanguage | undefined {
  if ([question, ...earlierLearnerTexts].some(namesALanguage)) return undefined;
  for (const text of [question, ...[...earlierLearnerTexts].reverse()]) {
    const reading = detectMessageLanguage(text);
    if (reading === 'other') return undefined;
    if (reading !== 'unknown') return reading;
  }
  return undefined;
}

export const languageName = (language: MessageLanguage) => (language === 'fr' ? 'French' : 'English');
