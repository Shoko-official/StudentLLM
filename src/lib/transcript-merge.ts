import type { TranscriptSegment } from '../types';

/**
 * Adds segments to a course transcript without dropping what was added in the meantime.
 *
 * Imports, transcriptions and recordings finish minutes after they started. They must merge their result into the
 * transcript as it is *when they finish*, not into the copy they saw when they started; otherwise a text file
 * imported or a segment marked as verified during a long transcription silently disappears. Segments that are
 * already present (same id) are kept once, and `replaceSourceId` swaps out the previous result of the same source.
 */
export function mergeSegments(
  existing: readonly TranscriptSegment[],
  incoming: readonly TranscriptSegment[],
  options: { replaceSourceId?: string } = {},
): TranscriptSegment[] {
  const base = options.replaceSourceId
    ? existing.filter((segment) => segment.sourceId !== options.replaceSourceId)
    : [...existing];
  const present = new Set(base.map((segment) => segment.id));
  for (const segment of incoming) {
    if (present.has(segment.id)) continue;
    present.add(segment.id);
    base.push(segment);
  }
  return base;
}
