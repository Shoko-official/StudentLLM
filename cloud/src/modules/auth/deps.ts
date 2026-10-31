// The auth module's services. `AuthDeps` also implements `AuthSeam`: other modules call it through `deps.auth`.

import type { CoreDeps } from "../../deps";
import { lazy } from "../../lazy";
import type { AuthSeam } from "../seams";
import { unconfiguredEmailSender, type EmailSender } from "./email";
import { createGoogleClient, type GoogleClient } from "./google";
import { loadTokenKeys, parsePreviousPublicKeys, type TokenKeys } from "./tokens";

export interface AuthDeps extends AuthSeam {
  /** Outgoing email (codes and notifications). No provider yet: the default fails every send. */
  email: EmailSender;
  /** The signing key and the verification keys, imported once per isolate. */
  keys: () => Promise<TokenKeys>;
  google: GoogleClient;
}

export function createAuthDeps(core: CoreDeps, overrides: Partial<AuthDeps> = {}): AuthDeps {
  const { stores, config } = core;
  return {
    email: unconfiguredEmailSender,
    keys: lazy(() =>
      loadTokenKeys(config.secret("TOKEN_SIGNING_KEY").reveal(), parsePreviousPublicKeys(config.var("TOKEN_PREVIOUS_PUBLIC_KEYS"))),
    ),
    google: createGoogleClient({
      fetch: (input, init) => core.fetch(input, init),
      clientId: () => config.googleClientId,
      clientSecret: () => config.secret("GOOGLE_CLIENT_SECRET").reveal(),
    }),
    async revokeAllSessions(accountId) {
      await stores.sessions.revokeAllForAccount(accountId, core.clock.now());
    },
    async revokeManageTokens(accountId) {
      await stores.devices.revokeManageTokens(accountId);
    },
    ...overrides,
  };
}
