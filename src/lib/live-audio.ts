import workletUrl from './pcm-capture.worklet.js?url&no-inline';

export interface AudioPreviewWindow { audio: Blob; start: number; end: number }

// The durable MediaRecorder archive is separate. Only the rolling preview is bounded.
export class PcmPreviewBuffer {
  private readonly samples: Float32Array;
  private total = 0;
  constructor(private readonly sampleRate: number, seconds = 120) {
    this.samples = new Float32Array(Math.ceil(sampleRate * seconds));
  }
  get retainedSamples() { return Math.min(this.total, this.samples.length); }
  append(samples: Float32Array) {
    for (const value of samples) this.samples[this.total++ % this.samples.length] = value;
  }
  read(fromSeconds: number): AudioPreviewWindow | null {
    const start = Math.max(Math.round(fromSeconds * this.sampleRate), this.total - this.samples.length, 0);
    const end = Math.min(this.total, start + this.sampleRate * 24);
    if (end - start < this.sampleRate) return null;
    const data = new ArrayBuffer(44 + (end - start) * 2);
    const view = new DataView(data);
    const ascii = (offset: number, text: string) => [...text].forEach((letter, i) => view.setUint8(offset + i, letter.charCodeAt(0)));
    ascii(0, 'RIFF'); view.setUint32(4, data.byteLength - 8, true); ascii(8, 'WAVE');
    ascii(12, 'fmt '); view.setUint32(16, 16, true); view.setUint16(20, 1, true); view.setUint16(22, 1, true);
    view.setUint32(24, this.sampleRate, true); view.setUint32(28, this.sampleRate * 2, true);
    view.setUint16(32, 2, true); view.setUint16(34, 16, true); ascii(36, 'data'); view.setUint32(40, data.byteLength - 44, true);
    for (let i = start; i < end; i++) {
      const value = Math.max(-1, Math.min(1, this.samples[i % this.samples.length]));
      view.setInt16(44 + (i - start) * 2, Math.round(value * (value < 0 ? 32768 : 32767)), true);
    }
    return { audio: new Blob([data], { type: 'audio/wav' }), start: start / this.sampleRate, end: end / this.sampleRate };
  }
}

export async function captureLiveAudio(stream: MediaStream) {
  if (typeof AudioContext === 'undefined' || typeof AudioWorkletNode === 'undefined') return null;
  let context: AudioContext | undefined;
  try {
    context = new AudioContext({ sampleRate: 48000 });
    await context.audioWorklet.addModule(workletUrl);
    const buffer = new PcmPreviewBuffer(context.sampleRate);
    const source = context.createMediaStreamSource(stream);
    const capture = new AudioWorkletNode(context, 'studentllm-pcm-capture');
    capture.port.onmessage = (event: MessageEvent<Float32Array>) => buffer.append(event.data);
    source.connect(capture);
    // The processor outputs silence, so the microphone is never played back.
    capture.connect(context.destination);
    await context.resume();
    return {
      read: (from: number) => buffer.read(from),
      close: () => { capture.port.onmessage = null; source.disconnect(); capture.disconnect(); void context!.close().catch(() => undefined); },
    };
  } catch {
    await context?.close().catch(() => undefined);
    return null;
  }
}
