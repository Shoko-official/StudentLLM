// `checkTermsAndStatus`: step 3 of the contract's order, right after authentication. It runs only for the gated
// routes; the data-rights routes (account, export, delete, refresh, logout, devices, billing portal, terms, and the
// consent route for withdrawals) are marked `gate: "exempt"` in their route meta and never reach it, so they are
// never blocked by, and never return, `terms_required` or `account_suspended`.
//
// `POST /v1/consent` is exempt because a withdrawal must always work ("withdrawal as easy as consent"), also for a
// suspended account or one that has not accepted the current terms. Its handler applies this same gate to a GRANT
// with `assertGateOpen`, so the exemption cannot be used to give consent while suspended or without the terms.

import type { Deps } from "../../deps";
import type { Step } from "../../http/context";
import { ApiError } from "../../http/envelope";
import type { AccountRecord } from "../../storage";

/** Throws what the gated routes throw for this account: nothing when the account may use gated routes. */
export function assertGateOpen(deps: Deps, account: AccountRecord): void {
  // An account being deleted is gone as far as every gated route is concerned.
  if (account.status === "deleting") throw new ApiError("session_revoked");
  // A suspended account is stopped before anything else is evaluated for it.
  if (account.status === "suspended") throw new ApiError("account_suspended");
  // Anything but the current version (not accepted, outdated) needs the terms accepted again.
  if (account.termsVersion !== deps.config.termsVersion) {
    throw new ApiError("terms_required", { details: { terms_version: deps.config.termsVersion } });
  }
}

export function checkTermsAndStatusStep(deps: Deps): Step {
  return (ctx) => {
    if (!ctx.account) throw new Error("terms check reached without an account");
    assertGateOpen(deps, ctx.account);
  };
}
