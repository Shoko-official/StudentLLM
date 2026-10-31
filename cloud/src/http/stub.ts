import type { Handler } from "./context";
import { notImplementedResponse } from "./envelope";

const stubs = new WeakSet<Handler>();

/**
 * Placeholder handler for a route that is in the contract but not built yet: HTTP 501 with the error
 * envelope. A module replaces it with a real handler in its own `register<Module>Routes`. This path exists
 * for the scaffold only; the pipeline lets a stub through its pass-through hooks, but never a real handler.
 */
export const notImplemented: Handler = (ctx) => notImplementedResponse(ctx.requestId);
stubs.add(notImplemented);

export function isStubHandler(handler: Handler): boolean {
  return stubs.has(handler);
}
