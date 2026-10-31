// Turns the raw failures of the local AI, speech and document services into sentences a student can act on.
// Raw browser text such as "Failed to fetch" or "Provider request failed (502)" says nothing about what to do next.

const NETWORK_FAILURE = /failed to fetch|networkerror|network request failed|load failed|fetch failed|econnrefused|err_connection/i;
// The development proxy and most reverse proxies answer 502/503/504 with no detail when nothing listens behind them.
const BARE_GATEWAY_FAILURE = /^Provider request failed \((?:502|503|504)\)$/;

export const AI_UNREACHABLE_MESSAGE = 'The AI model is not reachable. Start LM Studio, load a model and switch on its local server (the desktop app also needs its "Enable CORS" option), then try again. Settings shows the connection status.';
export const AI_TIMEOUT_MESSAGE = 'The AI model took too long to answer. Try again, ask a shorter question, or pick a smaller model in Settings.';

export function isNetworkFailure(error: unknown) {
  return error instanceof Error && NETWORK_FAILURE.test(error.message);
}

/** Message shown when a request to the AI model fails (chat, study material, course organizer). */
export function describeAiFailure(error: unknown, fallback = 'The AI model could not answer. Check Settings and try again.') {
  if (!(error instanceof Error)) return fallback;
  const message = error.message.trim();
  if (!message) return fallback;
  if (isNetworkFailure(error) || BARE_GATEWAY_FAILURE.test(message)) return AI_UNREACHABLE_MESSAGE;
  if (/timed out/i.test(message)) return AI_TIMEOUT_MESSAGE;
  const rejected = /^Provider request failed \((4\d\d)\)(?:: (.+))?$/.exec(message);
  if (rejected) {
    return rejected[2]
      ? `The AI model refused the request: ${rejected[2]} Check the model name in Settings.`
      : `The AI model refused the request (HTTP ${rejected[1]}). Check the address and model name in Settings.`;
  }
  return message;
}

/** Short status for a speech or document service that did not answer its health check. */
export function describeServiceUnreachable(error: unknown) {
  if (error instanceof DOMException && error.name === 'AbortError') return 'Not answering (timed out). Start it, or check the address.';
  if (isNetworkFailure(error)) return 'Not running. Start it, or check the address above.';
  return error instanceof Error && error.message ? error.message : 'Health check failed.';
}

/** What went wrong with a document that was saved but could not be read, and what to do next. */
export function describeDocumentFailure(error: unknown) {
  const message = error instanceof Error ? error.message : '';
  if (isNetworkFailure(error)) return 'The document service is offline. Start it, then open Settings and refresh the local services.';
  if (/timed out/i.test(message)) return 'The document service is offline or took too long to answer. A large scan can need several minutes; open Settings to check the service, then try again.';
  if (/too large/i.test(message)) return message;
  // The service answered and refused this file, so starting it again will not help.
  if (/\((?:400|415|422)\)/.test(message)) return 'The document service could not read this file. It may be damaged or protected by a password: remove the protection or save a fresh copy, then import it again.';
  return 'The document service could not extract this file. Open Settings and refresh the local services.';
}

/** What to tell the student when an audio file could not be transcribed. The audio itself is always kept. */
export function describeSpeechFailure(error: unknown) {
  const message = error instanceof Error ? error.message.trim() : '';
  if (isNetworkFailure(error)) return 'The speech service is not running, so the audio was kept but not transcribed. Start it, then use Transcribe on the recording in Sources.';
  if (/timed out/i.test(message)) return 'The speech service took too long. The audio was kept: try Transcribe again, or use a smaller speech model.';
  // The service answered and refused this audio, so starting it again will not help.
  if (/\((?:400|415|422)\)/.test(message)) return 'The speech service could not read this audio: it may be silent, empty, damaged or in a format it does not support. The original was kept.';
  return message || 'Transcription failed. The audio was kept: check the speech service and try again.';
}
