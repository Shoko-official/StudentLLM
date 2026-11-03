export type MessageLanguage = 'fr' | 'en';
export type MessageReading = MessageLanguage | 'mixed' | 'other' | 'unknown';

const wordList = (words: string) => new Set(words.split(/\s+/).filter(Boolean));

// A wrong statement puts a whole turn in the wrong language, while no statement only leaves the prompts to it. So a word is
// here only if it says little else: what French shares with Spanish or Italian (la, de, un, en, que, il, se) or with English
// (on, a, plus, question) is in no list, and an accent proves nothing, since names carry them.
const FRENCH = wordList(`
  le les des du une est sont dans avec qui cette cet ces aux nous vous ils elles pas mais donc sur par aussi comme sans sous
  leur leurs ses ainsi quand chaque depuis tous toutes selon ont fait dont ce au elle et ou je tu moi toi mon ma mes ton
  ta tes pour pourquoi comment quoi quel quelle quels quelles stp svp merci bonjour salut explique expliquez expliquer
  montre montrez montrer donne donnez fais faites faire peux peut veux voudrais aide dis dessine à où très été être était
  après avant même déjà ça cela calcule résous trouve décris résume définis
`);
const ENGLISH = wordList(`
  the of and to is that it for with was are this at from which not have has they their can will what how why when where
  who these those you your we my me please pls show explain give make draw help tell could would should does did want
  need thanks thank hi hello about in let define find solve compute calculate describe
`);
// "me" is French too, so it only counts for English in a message with no French word.
const ALSO_FRENCH = 'me';
// Words that mark Spanish, Italian, Portuguese, German and Dutch, and that a French or English message rarely holds. They
// keep a message in those languages from reading as French or English, so they need not be complete.
const OTHERS = wordList(`
  el los las una por para pero también muy qué él sobre hola gracias explica explícame explicas dame muestra hazme está
  puedes puede ayuda ayudas quiero necesito
  gli della delle dei di nel nella sulla dell nell sull che sono anche questo questa perché più già città è ciao grazie
  favore spiegami fammi mostrami puoi cosa
  uma são você isso obrigado obrigada pelo pela é
  das und ist nicht ein eine zu auf für auch sich sind wird bitte zeig wie
  een het niet ook zijn voor deze wordt maar als naar wat
`);
const OTHER_LETTER = /[áíóúñãõäößìò]/u;
const OTHER_MARK = /[¿¡]/u;
const NOT_LATIN = /[^\p{Script=Latin}'’]/u;
const WORD = /\p{L}+(?:['’]\p{L}+)*/gu;
const ELISION = /^(?:l|d|qu|j|c|n|s|m|t|jusqu|lorsqu|puisqu)['’]\p{Ll}/u;
const MIN_HITS = 2;

const LANGUAGE_NAMES = 'français|francais|anglais|espagnol|allemand|italien|portugais|chinois|japonais|arabe|russe|french|english|spanish|german|italian|portuguese|chinese|japanese|arabic|russian';
const SWITCH_VERBS = "parle|parles|parlez|parlons|speak|passe|passes|passez|passons|switch|pr[ée]f[èe]re|pr[ée]f[èe]res|pr[ée]f[ée]rez|prefer";
// A request says it with a verb, a preposition or a please. A bare adjective, as in "the French Revolution", is no request.
const LANGUAGE_REQUEST = new RegExp(`(?<!\\p{L})(?:(?:en|in|into|to|vers)\\s+(?:${LANGUAGE_NAMES})|(?:${LANGUAGE_NAMES})\\s+(?:please|pls|stp|svp|s['’]il|only|uniquement|seulement)|(?:${SWITCH_VERBS})(?:[\\s-]+(?:moi|nous|me|us))?(?:\\s+(?:à|a|au|to|in|en|vers))?\\s+(?:le\\s+|l['’])?(?:${LANGUAGE_NAMES}))(?!\\p{L})`, 'u');

/** Code, links, formulas and what touches an operator are not prose, and their letters must not be read as words: "F = ma", "du/dx". */
const proseOf = (text: string) => text
  .replace(/```[\s\S]*?```/g, ' ')
  .replace(/`[^`]*`/g, ' ')
  .replace(/!?\[[^\]]*\]\([^)]*\)/g, ' ')
  .replace(/(?:https?|data):\S+/g, ' ')
  .replace(/\$\$?[^$]*\$\$?/g, ' ')
  .replace(/\\[A-Za-z]+/g, ' ')
  .replace(/\S+\s*=\s*\S+/g, ' ')
  .replace(/\S*[/=^]\S*/g, ' ');

/**
 * The language of a learner's message, French against English, and only when it is plain: two different words of one
 * language and none of the other. Any line of the message counts towards this, so two lines in different languages give
 * "mixed". One word or none gives "unknown". Words of another language, or another script, give "other".
 */
export function detectMessageLanguage(text: string): MessageReading {
  const prose = proseOf(text.normalize('NFC'));
  const fr = new Set<string>(), en = new Set<string>();
  if (OTHER_MARK.test(prose)) return 'other';
  for (const [token] of prose.matchAll(WORD)) {
    const lower = token.toLowerCase();
    const parts = lower.split(/['’]/);
    // A capitalised word can be a name, so its letters say nothing: "Schrödinger".
    if (NOT_LATIN.test(token) || parts.some((part) => OTHERS.has(part)) || (token === lower && OTHER_LETTER.test(token))) return 'other';
    if (ELISION.test(token)) fr.add(lower);
    else if (token.length > 1 && token === token.toUpperCase()) continue;
    else if (FRENCH.has(parts[0])) fr.add(parts[0]);
    else if (ENGLISH.has(parts[0])) en.add(parts[0]);
  }
  if (fr.size) en.delete(ALSO_FRENCH);
  if (fr.size && en.size) return 'mixed';
  if (fr.size >= MIN_HITS) return 'fr';
  return en.size >= MIN_HITS ? 'en' : 'unknown';
}

/** Whether a message asks for a language to work in, as in "réponds en anglais" or "Speak French with me". It can also be a topic, and then too the model is left to read it. */
export const namesALanguage = (text: string) => LANGUAGE_REQUEST.test(text.normalize('NFC').toLowerCase());

/**
 * The language to state to a model for this conversation, if any. A learner who has asked for a language decides, and is
 * left to the model to follow. A message that reads as unknown takes the language of the latest earlier message, as long as
 * nothing mixed or foreign comes first. Whenever in doubt this states nothing, which leaves the rules in the prompts.
 */
export function conversationLanguage(question: string, earlierLearnerTexts: string[] = []): MessageLanguage | undefined {
  if ([question, ...earlierLearnerTexts].some(namesALanguage)) return undefined;
  for (const text of [question, ...[...earlierLearnerTexts].reverse()]) {
    const reading = detectMessageLanguage(text);
    if (reading === 'fr' || reading === 'en') return reading;
    if (reading !== 'unknown') return undefined;
  }
  return undefined;
}

export const languageName = (language: MessageLanguage) => (language === 'fr' ? 'French' : 'English');
