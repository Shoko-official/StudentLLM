import { describe, expect, it } from 'vitest';
import benchmark from '../../benchmarks/tutor/cases.json';
import { missingArtefacts, namedArtefacts } from './visual-brief';

const read = (text: string) => namedArtefacts(text).map(({ type, also, count }) => `${[type, ...(also ?? [])].join('|')}${count > 1 ? `*${count}` : ''}`).join(' ');

const PLOT = 'plot', GRAPH = 'plot|diagram', SCHEMA = 'diagram|figure', TREE = 'diagram', FIGURE = 'figure|diagram', QUIZ = 'quiz';

const WORDS: [string[], string][] = [
  [['graphique', 'graphiques', 'grafique', 'courbe', 'courbes', 'histogramme', 'plot', 'plots', 'plotting', 'chart', 'charts', 'curve', 'curves', 'histogram', 'diagramme en barres', 'diagramme en bâtons', 'diagramme circulaire'], PLOT],
  [['graphe', 'graphes', 'graph', 'graphs', 'graphing', 'trace', 'tracer', 'tracez'], GRAPH],
  [['schéma', 'schema', 'schémas', 'shema', 'schématique', 'schematic', 'diagramme', 'diagrammes', 'diagrame', 'diagram', 'diagrams'], SCHEMA],
  [['arbre', 'arbres', 'tree', 'trees', 'flowchart', 'flow chart', 'flow-chart', 'organigramme', 'logigramme', 'mind map', 'mindmap', 'concept map', 'carte mentale', 'carte conceptuelle'], TREE],
  [['figure', 'figures', 'dessin', 'dessine', 'dessiner', 'croquis', 'illustration', 'illustre', 'illustrate', 'drawing', 'draw', 'sketch', 'picture', 'visuel', 'visual', 'visualisation', 'visualization', 'visualise', 'visualiser'], FIGURE],
  [['quiz', 'quizz', 'quizzes', 'quizes', 'QCM', 'QCU', 'MCQ', 'MCQs', 'question à choix multiples', 'questions à choix multiples', 'multiple choice', 'multiple-choice', 'teste-moi', 'interroge-moi', 'questionne-nous', 'test me', 'test my'], QUIZ],
];

// Whatever the sentence does with the word: telling these apart is the decision call's work, not the gate's.
const ANY_USE: [string, string][] = [
  ['Courbe de Phillips', PLOT],
  ['A chart? No thanks.', PLOT],
  ['Sans schéma, explique.', SCHEMA],
  ["Tu m'as donné un quiz tout à l'heure.", QUIZ],
  ['Exercice 2 : Trace la courbe de f. Je bloque à la question b.', PLOT],
  ['Plot y = x^2 from 0 to 5.', PLOT],
  ['Mets ça sur un graphique et termine par un QCM.', `${PLOT} ${QUIZ}`],
  ['First a QUIZ, then a Graph.', `${QUIZ} ${GRAPH}`],
];

const NO_WORD = [
  '',
  'Pourquoi le ciel est-il bleu ?',
  'What is a derivative?',
  'Explique la loi de Boyle.',
  'Donne-moi la définition de la pression.',
  'Merci, je comprends mieux.',
  // Close to a quiz request, and no more than a question.
  "J'ai une question : pourquoi ?",
  'Ask me later.',
  'Pose-moi cette question demain.',
  // A word inside another word, code or an image reference is not the word.
  'Le transfigurateur et les subgraphiques sans espace, le paragraphe, the charter, a street.',
  'Voici mon code :\n```\n# show me a diagram\nshow_me_a_diagram()\n```',
  'Utilise `montre-moi un schéma` comme texte.',
  '![show me a diagram](https://example.com/a.png) Explain this.',
];

describe('the gate on artefact words', () => {
  it.each(WORDS.flatMap(([words, family]) => words.map((word) => [word, family])))('finds %j as %s', (word, family) => {
    expect(read(`Un mot : ${word}.`)).toBe(family);
  });

  it.each(ANY_USE)('finds the word in %j, whatever the sentence does with it', (text, expected) => { expect(read(text)).toBe(expected); });
  it.each(NO_WORD)('costs no call on %j', (text) => { expect(namedArtefacts(text)).toEqual([]); });

  it('finds every artefact the benchmark asks for, and costs no call on its rate prompts', () => {
    const types = (text: string) => namedArtefacts(text).map((item) => item.type);
    for (const item of benchmark.quality) expect(types(item.prompt).sort()).toEqual(item.artefacts.map((artefact) => artefact.type).sort());
    expect(Object.values(benchmark.rate).flat().flatMap(types)).toEqual([]);
  });

  it.each([
    ['teste mes connaissances', QUIZ], ['test-moi', QUIZ], ['test moi', QUIZ],
    ['pose-moi une question', QUIZ], ['pose moi des questions', QUIZ], ['ask me a question', QUIZ], ['ask me some questions', QUIZ],
    ['schématise', SCHEMA], ['représente', 'plot|diagram|figure'],
    ['dessines', FIGURE], ['dessinons', FIGURE], ['visualisons', FIGURE],
  ])('also finds %j as %s', (word, family) => { expect(read(`Un mot : ${word}.`)).toBe(family); });

  it.each([
    ['Draw a plot', PLOT],
    ['Draw a diagram of the cell.', SCHEMA],
    ['Sketch a graph of it.', GRAPH],
    ['Trace le graphique de f.', PLOT],
    ['Dessine un seul schéma du pendule.', SCHEMA],
    ['Représente la force sur un graphique.', PLOT],
    ['Visualise it with a chart.', PLOT],
    ['Illustre ça avec un quiz.', QUIZ],
  ])('takes a drawing verb for no artefact of its own when the message has a noun: %j', (text, expected) => { expect(read(text)).toBe(expected); });

  it.each([
    ['Draw it', FIGURE],
    ['Dessine-le.', FIGURE],
    ['Illustrate this for me.', FIGURE],
    ['Trace la fonction f.', GRAPH],
    ['Schématise le cycle.', SCHEMA],
  ])('still fires on a drawing verb alone: %j', (text, expected) => { expect(read(text)).toBe(expected); });

  it.each([
    ['Trace y = x^2 puis ajoute un quiz.', `${GRAPH} ${QUIZ}`],
    ['Trace la fonction sin(x), puis un quiz.', `${GRAPH} ${QUIZ}`],
    ['Dessine le cycle et ajoute un quiz.', `${FIGURE} ${QUIZ}`],
    ['Dessine les forces, puis fais un QCM.', `${FIGURE} ${QUIZ}`],
    ['Draw the forces and quiz me.', `${FIGURE} ${QUIZ}`],
    ['Sketch the setup, then give me a quiz.', `${FIGURE} ${QUIZ}`],
    ['Illustre le principe et fais un quiz.', `${FIGURE} ${QUIZ}`],
    ['Représente la fonction et fais un quiz.', `plot|diagram|figure ${QUIZ}`],
    ['Schématise le cycle puis un quiz.', `${SCHEMA} ${QUIZ}`],
    ['Visualize the flow and add a quiz.', `${FIGURE} ${QUIZ}`],
    ['Draw the forces. Then quiz me.', `${FIGURE} ${QUIZ}`],
    ['Draw the forces; a quiz after.', `${FIGURE} ${QUIZ}`],
    ['Dessine les forces\nUn quiz ensuite.', `${FIGURE} ${QUIZ}`],
  ])('counts a verb with no noun in its own clause: %j', (text, expected) => { expect(read(text)).toBe(expected); });

  it('asks for both parts of a verb in one clause and a noun in another', () => {
    expect(missingArtefacts('Draw the forces and quiz me.', 'Prose.')).toEqual([['figure', 'diagram'], ['quiz']]);
  });

  it('keeps one schema at one block when a verb asks for it and the tutor made a figure', () => {
    const figure = '```student-visual-request\n{"id":"v1","type":"figure","intent":"I","content":"C"}\n```';
    expect(missingArtefacts('Dessine un seul schéma du pendule.', `Prose.\n\n${figure}`)).toEqual([]);
    expect(missingArtefacts('Draw a plot', 'Prose.')).toEqual([['plot']]);
    expect(missingArtefacts('Draw it', 'Prose.')).toEqual([['figure', 'diagram']]);
  });

  it('merges the words of one family, in the order of the message', () => {
    expect(read('Un quiz, puis un arbre et un schéma, puis un graphique.')).toBe(`${QUIZ} ${SCHEMA} ${PLOT}`);
  });

  it('reads a count next to the word, and never counts curves as plots', () => {
    expect(namedArtefacts('Fais un seul graphique de la force.')).toEqual([{ type: 'plot', count: 1 }]);
    expect(namedArtefacts('Fais deux graphiques de la force et un quiz.')).toEqual([{ type: 'plot', count: 2 }, { type: 'quiz', count: 1 }]);
    expect(namedArtefacts('Fais deux petits graphiques.')).toEqual([{ type: 'plot', count: 2 }]);
    expect(namedArtefacts('Give me three quizzes on it.')).toEqual([{ type: 'quiz', count: 3 }]);
    expect(namedArtefacts('Fais un graphique avec deux courbes.')).toEqual([{ type: 'plot', count: 1 }]);
    expect(namedArtefacts('Fais un graphique, puis un autre graphique.')).toEqual([{ type: 'plot', count: 1 }]);
  });
});
