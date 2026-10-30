import { describe, expect, it } from 'vitest';
import { chapterForFile, EXERCISE_CHAPTER, folderNameOf, isImportableSource, LECTURE_CHAPTER, lessonTitleFromFile, planBatchImport } from './batch-import';

function file(name: string, path = name, type = 'application/pdf') {
  const value = new File(['x'], name, { type });
  Object.defineProperty(value, 'webkitRelativePath', { value: path });
  return value;
}

describe('batch import planning', () => {
  it('orders a course folder as introduction, chapters, other lectures, then exercise sheets', () => {
    const names = ['TD2.pdf', 'Chapitre 2 manuscrit.pdf', 'TD10.pdf', 'Cours de méthodes numériques.pdf', 'chapitre1 manuscrit.pdf', 'Introduction.pdf', 'TD1.pdf', 'Annexe.pdf'];
    const plan = planBatchImport(names.map((name) => file(name)));

    expect(plan.map(({ title }) => title)).toEqual([
      'Introduction',
      'Chapitre 1 manuscrit',
      'Chapitre 2 manuscrit',
      'Cours de méthodes numériques',
      'Annexe',
      'TD 1',
      'TD 2',
      'TD 10',
    ]);
    expect(plan.filter(({ chapter }) => chapter === EXERCISE_CHAPTER)).toHaveLength(3);
  });

  it('classifies exercise sheets in French and English', () => {
    expect(chapterForFile('TD3.pdf')).toBe(EXERCISE_CHAPTER);
    expect(chapterForFile('TP 4 - interpolation.pdf')).toBe(EXERCISE_CHAPTER);
    expect(chapterForFile('Exercices corrigés.pdf')).toBe(EXERCISE_CHAPTER);
    expect(chapterForFile('Problem set 2.pdf')).toBe(EXERCISE_CHAPTER);
    expect(chapterForFile('Introduction.pdf')).toBe(LECTURE_CHAPTER);
    expect(chapterForFile('Méthode de Newton.pdf')).toBe(LECTURE_CHAPTER);
  });

  it('skips hidden, empty and unsupported files from a folder', () => {
    const empty = new File([], 'empty.pdf', { type: 'application/pdf' });
    expect(isImportableSource(file('.DS_Store', 'Course/.DS_Store', ''))).toBe(false);
    expect(isImportableSource(file('setup.exe', 'Course/setup.exe', 'application/octet-stream'))).toBe(false);
    expect(isImportableSource(empty)).toBe(false);
    expect(isImportableSource(file('HEAD.pdf', 'Course/.git/HEAD.pdf'))).toBe(false);
    expect(isImportableSource(file('~$notes.docx', 'Course/~$notes.docx', ''))).toBe(false);
    expect(isImportableSource(file('lecture.m4a', 'Course/lecture.m4a', 'audio/mp4'))).toBe(true);
    expect(isImportableSource(file('notes.docx', 'Course/notes.docx', ''))).toBe(true);
  });

  it('reads the selected folder name and readable lesson titles', () => {
    expect(folderNameOf([file('TD1.pdf', 'Méthodes numériques/TD1.pdf')])).toBe('Méthodes numériques');
    expect(folderNameOf([file('TD1.pdf')])).toBe('');
    expect(lessonTitleFromFile('chapitre1_manuscrit.pdf')).toBe('Chapitre 1 manuscrit');
  });
});
