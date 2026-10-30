// Plans an import of many course files at once: one lesson per file, grouped and ordered the way
// a student's folder usually is (introduction and chapters first, then exercise sheets).

const IMPORTABLE_EXTENSIONS = new Set(['pdf', 'txt', 'md', 'html', 'htm', 'rtf', 'docx', 'pptx']);
const EXERCISE_PATTERN = /\b(td|tp|tds|tps|exercices?|exercises?|worksheets?|problem\s*sets?|devoirs?|homework)\b|^(td|tp)\s*\d/i;

export const LECTURE_CHAPTER = 'Cours';
export const EXERCISE_CHAPTER = 'Travaux dirigés';

export interface PlannedSourceImport {
  file: File;
  title: string;
  chapter: string;
}

function relativePath(file: File) {
  return (file as File & { webkitRelativePath?: string }).webkitRelativePath || file.name;
}

function extension(name: string) {
  const match = name.toLowerCase().match(/\.([a-z0-9]+)$/);
  return match ? match[1] : '';
}

export function isImportableSource(file: File) {
  // Skip hidden files and folders (.git, .venv) and Office lock files (~$notes.docx).
  if (relativePath(file).split('/').some((segment) => segment.startsWith('.')) || file.name.startsWith('~$') || file.size === 0) return false;
  return IMPORTABLE_EXTENSIONS.has(extension(file.name)) || file.type.startsWith('audio/') || file.type.startsWith('image/');
}

/** The top-level folder name of a folder selection, used as the course subject. */
export function folderNameOf(files: File[]) {
  const first = files.map(relativePath).find((path) => path.includes('/'));
  return first ? first.split('/')[0].trim() : '';
}

export function lessonTitleFromFile(name: string) {
  const stem = name.replace(/\.[^.]+$/, '').replace(/[_]+/g, ' ').replace(/\s+/g, ' ').trim();
  const spaced = stem.replace(/([a-zà-ÿ])(\d)/gi, '$1 $2');
  return spaced ? spaced.charAt(0).toLocaleUpperCase() + spaced.slice(1) : name;
}

export function chapterForFile(name: string) {
  return EXERCISE_PATTERN.test(lessonTitleFromFile(name)) ? EXERCISE_CHAPTER : LECTURE_CHAPTER;
}

const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' });

function lectureRank(title: string) {
  if (/^intro/i.test(title)) return 0;
  if (/^(chapitre|chapter|chap|cours|lecture|le[cç]on)\b/i.test(title)) return 1;
  return 2;
}

export function planBatchImport(files: File[]): PlannedSourceImport[] {
  return files
    .filter(isImportableSource)
    .map((file) => ({ file, title: lessonTitleFromFile(file.name), chapter: chapterForFile(file.name) }))
    .sort((left, right) => {
      if (left.chapter !== right.chapter) return left.chapter === LECTURE_CHAPTER ? -1 : 1;
      return lectureRank(left.title) - lectureRank(right.title) || collator.compare(left.title, right.title);
    });
}
