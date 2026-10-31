/**
 * Memoized lazy initialization for deps that need `await` to build (an imported CryptoKey, a fetched JWKS,
 * a provider client). `createDeps` is synchronous, so a module must not await while building its deps.
 * It stores a getter instead:
 *
 *   export interface AuthDeps { signingKey: () => Promise<CryptoKey> }
 *   export function createAuthDeps(core: CoreDeps): AuthDeps {
 *     return { signingKey: lazy(() => importSigningKey(core.config.secret("TOKEN_SIGNING_KEY").reveal())) };
 *   }
 *
 * The first caller starts the work, every concurrent caller shares the same promise, and later callers get
 * the settled value. A rejection is NOT cached: the next call retries, so one transient failure (a network
 * blip) does not poison the isolate until it restarts.
 */
export function lazy<T>(init: () => Promise<T>): () => Promise<T> {
  let pending: Promise<T> | undefined;
  return () => {
    if (!pending) {
      pending = init().catch((error: unknown) => {
        pending = undefined;
        throw error;
      });
    }
    return pending;
  };
}
