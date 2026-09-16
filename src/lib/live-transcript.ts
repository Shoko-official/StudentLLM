import type { TranscriptSegment } from '../types';

export function speakerLabel(value?: string) {
  return !value || /^(speaker|unknown|unknown speaker)$/i.test(value.trim()) ? '' : value.trim();
}

export function transcriptSeconds(segment: TranscriptSegment) {
  return segment.start ?? segment.timestamp.split(':').reduce((total, part) => total * 60 + Number(part), 0);
}

export function formatTranscriptTime(seconds: number) {
  const value = Math.max(0, Math.floor(seconds));
  return [Math.floor(value / 3600), Math.floor(value / 60) % 60, value % 60].map(part => String(part).padStart(2, '0')).join(':');
}

export function groupTranscript(segments: TranscriptSegment[]) {
  const groups: TranscriptSegment[] = [];
  for (const segment of segments) {
    const last = groups.at(-1);
    const start = transcriptSeconds(segment);
    const gap = last ? start - (last.end ?? transcriptSeconds(last)) : Infinity;
    if (last && last.sourceId === segment.sourceId && speakerLabel(last.speaker) === speakerLabel(segment.speaker)
      && last.provisional === segment.provisional && !/^Page /i.test(segment.timestamp)
      && gap >= 0 && gap <= 8 && last.text.length + segment.text.length < 1000) {
      last.text += ` ${segment.text}`;
      last.end = segment.end ?? start;
    } else groups.push({ ...segment, end: segment.end ?? start, speaker: speakerLabel(segment.speaker) });
  }
  return groups;
}

export function mergeLiveWindow(previous: TranscriptSegment[], incoming: TranscriptSegment[], window: { start: number; end: number }, recordingId: string) {
  const segments = previous.filter(segment => (segment.end ?? transcriptSeconds(segment)) <= window.start);
  const cutoff = Math.max(window.start, window.end - 2);
  let nextStart = cutoff;
  for (const segment of incoming) {
    const start = window.start + transcriptSeconds(segment);
    const end = Math.min(window.end, window.start + (segment.end ?? transcriptSeconds(segment)));
    if (start >= window.end || end < start) continue;
    if (end > cutoff) nextStart = Math.min(nextStart, start);
    segments.push({ ...segment, id: `${recordingId}:live:${start.toFixed(3)}`, sourceId: recordingId,
      timestamp: formatTranscriptTime(start), start, end, speaker: speakerLabel(segment.speaker), provisional: true, status: 'review',
      ...(segment.words ? { words: segment.words.map(word => ({ ...word, start: word.start + window.start, end: word.end + window.start })) } : {}),
    });
  }
  // Unusually long segments can fill the whole window. Split only at a timed word.
  if (nextStart <= window.start && window.end - window.start >= 24) {
    const last = segments.at(-1);
    const boundary = last?.words?.find(word => word.end > cutoff)?.start;
    if (last && boundary !== undefined) {
      const stable = last.words!.filter(word => word.start < boundary);
      const tail = last.words!.filter(word => word.start >= boundary);
      segments.splice(-1, 1, { ...last, text: stable.map(word => word.word).join('').trim(), words: stable, end: boundary },
        { ...last, id: `${last.id}:tail`, text: tail.map(word => word.word).join('').trim(), words: tail, start: boundary, timestamp: formatTranscriptTime(boundary) });
      nextStart = boundary;
    } else nextStart = last?.end ?? cutoff;
  }
  return { segments, nextStart };
}
