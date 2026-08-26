export interface RecorderSession {
  stop: () => void;
  stream: MediaStream | null;
}

export async function requestRecorderSession(): Promise<RecorderSession> {
  if (!navigator.mediaDevices?.getUserMedia) {
    return { stop: () => undefined, stream: null };
  }

  const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
  return {
    stream,
    stop: () => stream.getTracks().forEach((track) => track.stop()),
  };
}
