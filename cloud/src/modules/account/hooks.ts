// `checkTermsAndStatus`: step 3 of the contract's order, right after authentication. It runs only for the gated
// routes; the data-rights routes (account, export, delete, refresh, logout, devices, billing portal, terms) are
// marked `gate: "exempt"` in their route meta and never reach it, so they are never blocked by, and never return,
// `terms_required` or `account_suspended`.

import type { Deps } from "../../deps";
import type { Step } from "../../http/context";
import { ApiError } from "../../http/envelope";

export function checkTermsAndStatusStep(deps: Deps): Step {
  return (ctx) => {
    const account = ctx.account;
    if (!account) throw new Error("terms check reached without an account");
    // An account being deleted is gone as far as every gated route is concerned.
    if (account.status === "deleting") throw new ApiError("session_revoked");
    // A suspended account is stopped before anything else is evaluated for it.
    if (account.status === "suspended") throw new ApiError("account_suspended");
    // Anything but the current version (not accepted, outdated) needs the terms accepted again.
    if (account.termsVersion !== deps.config.termsVersion) {
      throw new ApiError("terms_required", { details: { terms_version: deps.config.termsVersion } });
    }
  };
}
