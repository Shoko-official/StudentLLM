import { useEffect, useRef, useState } from 'react';
import type { CourseNoteBlock, Lesson, TranscriptSegment } from '../types';
import type { LLMProvider } from './llm-provider';
import { formatCourseNoteWithProvider } from './course-notes';

export function useLiveNotes(recordingId: string | undefined, lesson: Lesson, transcript: TranscriptSegment[], provider: LLMProvider | null | undefined, settledThrough = (transcript.at(-1)?.end ?? 0) - 2) {
  const latest = useRef({ lesson, transcript, settledThrough });
  latest.current = { lesson, transcript, settledThrough };
  const [draft, setDraft] = useState<{ blocks: CourseNoteBlock[]; covered: string[]; status: string }>({ blocks: [], covered: [], status: '' });
  useEffect(() => {
    setDraft({ blocks: [], covered: [], status: '' });
    if (!recordingId || !provider) return;
    const controller = new AbortController();
    const covered = new Set<string>();
    let inFlight = false;
    let lastAttempt = '';
    const update = async () => {
      if (inFlight || controller.signal.aborted) return;
      const { lesson: currentLesson, transcript: current, settledThrough: boundary } = latest.current;
      // Leave the decoder's still-changing tail out of polished notes.
      let size = 0;
      const batch = current.filter(segment => {
        if (covered.has(segment.id) || segment.end === undefined || segment.end > boundary || size >= 6000) return false;
        size += segment.text.length;
        return true;
      });
      const signature = JSON.stringify(batch.map(segment => [segment.id, segment.text]));
      if (size < 100 || signature === lastAttempt) return;
      lastAttempt = signature;
      inFlight = true;
      setDraft(value => ({ ...value, status: 'Writing notes...' }));
      try {
        const note = await formatCourseNoteWithProvider(currentLesson, batch, provider, undefined, controller.signal);
        if (controller.signal.aborted) return;
        const unchanged = batch.every(segment => latest.current.transcript.some(now => now.id === segment.id && now.text === segment.text));
        const prose = note.blocks.filter(block => !block.id.startsWith('note-'));
        if (!unchanged) { lastAttempt = ''; return; }
        if (!prose.some(block => block.type === 'markdown')) {
          setDraft(value => ({ ...value, status: 'Notes unavailable. The original transcript is retained.' }));
          return;
        }
        batch.forEach(segment => covered.add(segment.id));
        setDraft(value => ({ blocks: [...value.blocks, ...prose], covered: [...covered], status: 'Draft notes - review against the transcript' }));
      } finally { inFlight = false; }
    };
    void update();
    const interval = window.setInterval(() => void update(), 10_000);
    return () => { controller.abort(); window.clearInterval(interval); };
  }, [recordingId, provider]);
  return draft;
}
