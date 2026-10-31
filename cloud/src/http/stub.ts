import type { Handler } from "./context";
import { notImplementedResponse } from "./envelope";

/**
 * Placeholder handler for a route that is in the contract but not built yet: HTTP 501 with the error
 * envelope. A module replaces it with a real handler in its own `register<Module>Routes`.
 */
export const notImplemented: Handler = (ctx) => notImplementedResponse(ctx.requestId);
