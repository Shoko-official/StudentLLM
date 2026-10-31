import { describe, expect, it } from 'vitest';
import { mergeSegments } from './transcript-merge';
import type { TranscriptSegment } from '../types';

const segment = (id: string, sourceId?: string, text = id): TranscriptSegment => ({ id, sourceId, timestamp: '00:00', speaker: 'S', text, status: 'review' });

describe('mergeSegments', () => {
  it('appends new segments after what the transcript holds now', () => {
    const merged = mergeSegments([segment('a'), segment('late-import')], [segment('b'), segment('c')]);
    expect(merged.map((item) => item.id)).toEqual(['a', 'late-import', 'b', 'c']);
  });

  it('keeps one copy of a segment that is already present', () => {
    expect(mergeSegments([segment('a', 's1', 'edited')], [segment('a', 's1', 'again')]).map((item) => item.text)).toEqual(['edited']);
  });

  it('replaces the earlier result of the same source and leaves other sources alone', () => {
    const merged = mergeSegments([segment('x1', 's1'), segment('y1', 's2')], [segment('x2', 's1')], { replaceSourceId: 's1' });
    expect(merged.map((item) => item.id)).toEqual(['y1', 'x2']);
  });

  it('does not mutate its inputs', () => {
    const existing = [segment('a')];
    mergeSegments(existing, [segment('b')]);
    expect(existing).toHaveLength(1);
  });
});
