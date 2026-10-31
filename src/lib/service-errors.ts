// Turns the raw failures of the local AI, speech and document services into sentences a student can act on.
// The raw text ("Failed to fetch", "Provider request failed (502)") stays available through the console.

const NETWORK_FAILURE = /failed to fetch|networkerror|network request failed|load failed|fetch failed|econnrefused|err_connection/i;
// The development proxy and most reverse proxies answer 502/503/504 with no detail when nothing listens behind them.
const BARE_GATEWAY_FAILURE = /^Provider request failed \((?:502|503|504)\)$/;

export const AI_UNREACHABLE_MESSAGE = 'The AI model is not reachable. Start LM Studio, load a model and switch on its local server, then try again. Settings shows the connection status.';
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
