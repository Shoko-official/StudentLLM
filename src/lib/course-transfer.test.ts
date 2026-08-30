import { describe, expect, it } from 'vitest';
import { buildCourseExport, readCourseExport } from './course-transfer';

const lesson = {
  id: 'lesson-1',
  subject: 'Machine Learning',
  chapter: 'Transformers',
  title: 'Attention',
  teacher: 'Professor',
  duration: '00:10:00',
  date: '2026-08-27',
  progress: 20,
};

const workspace = {
  resources: [
    { id: 'source-1', name: 'notes.md', meta: 'Text · 5 B', kind: 'transcript' as const, mimeType: 'text/markdown', sha256: 'abc' },
    { id: 'recording-1', name: 'Attention audio.webm', meta: 'Audio · 2 chunks', kind: 'audio' as const, mimeType: 'audio/webm' },
  ],
  transcript: [{ id: 'segment-1', sourceId: 'recording-1', timestamp: '00:00:01', speaker: 'Professor', text: 'Attention.', status: 'review' as const }],
  chat: [],
  artifacts: [],
};

describe('course transfer', () => {
  it('round-trips source blobs and audio chunks without losing metadata', async () => {
    const sourceBlob = new Blob(['notes'], { type: 'text/markdown' });
    const audioChunks = [
      { recordingId: 'recording-1', sequence: 0, blob: new Blob(['first'], { type: 'audio/webm' }), recordedAt: 100 },
      { recordingId: 'recording-1', sequence: 1, blob: new Blob(['second'], { type: 'audio/webm' }), recordedAt: 200 },
    ];
    const exportBlob = await buildCourseExport(lesson, workspace, {
      loadSourceBlob: async (resourceId) => resourceId === 'source-1' ? sourceBlob : null,
      listAudioChunks: async (recordingId) => recordingId === 'recording-1' ? audioChunks : [],
    }, () => '2026-08-27T12:00:00.000Z');

    const exported = JSON.parse(await exportBlob.text()) as { format: string; version: number; assets: Array<{ storage: string; chunks: unknown[] }> };
    expect(exported).toMatchObject({ format: 'studentllm-course', version: 1 });
    expect(exported.assets).toHaveLength(2);
    expect(exported.assets.map((asset) => asset.storage)).toEqual(['source', 'audio']);
    expect(exported.assets[1].chunks).toHaveLength(2);

    let id = 0;
    const imported = await readCourseExport(exportBlob, (prefix) => `${prefix}-imported-${id++}`);
    expect(imported.lesson.id).toBe('lesson-imported-0');
    expect(imported.workspace.resources.map((resource) => resource.id)).toEqual(['resource-imported-1', 'resource-imported-2']);
    expect(imported.assets.map((asset) => asset.resourceId)).toEqual(['resource-imported-1', 'resource-imported-2']);
    expect(imported.workspace.transcript[0]).toMatchObject({ sourceId: 'resource-imported-2' });
    expect(await imported.assets[0].chunks[0].blob.text()).toBe('notes');
    expect(await Promise.all(imported.assets[1].chunks.map((chunk) => chunk.blob.text()))).toEqual(['first', 'second']);
  });

  it('rejects malformed exports before any storage operation', async () => {
    await expect(readCourseExport(JSON.stringify({ format: 'other', version: 1 }))).rejects.toThrow('not supported');
    await expect(readCourseExport('{')).rejects.toThrow('not valid JSON');
  });
});
