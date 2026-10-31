// Lifetimes and limits of the auth module, in one place. The values come from docs/cloud-api.md and
// docs/cloud-plan.md ("Authentication"); the rate-limit numbers are the plan's examples and are config-level
// choices (tune them here, not in the handlers).

const SECOND = 1000;
const MINUTE = 60 * SECOND;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

export const ACCESS_TOKEN_TTL_SECONDS = 900;

/** The OAuth client id the contract fixes for the desktop app. */
export const CLIENT_ID = "studentllm-desktop";

export const EMAIL_CODE_LENGTH = 8;
export const EMAIL_CODE_TTL_MS = 10 * MINUTE;
export const EMAIL_MAX_ATTEMPTS = 5;
/** Minimum interval between two code requests for one address. */
export const EMAIL_RESEND_AFTER_SECONDS = 60;
export const EMAIL_REQUESTS_PER_ADDRESS_PER_HOUR = 5;
/** The larger, independent cap per hashed connection address. */
export const EMAIL_REQUESTS_PER_CONNECTION_PER_HOUR = 20;
/** Failed code checks per address / per connection per hour, across codes (a new request resets a code's own cap). */
export const FAILED_VERIFY_PER_ADDRESS_PER_HOUR = 25;
export const FAILED_VERIFY_PER_CONNECTION_PER_HOUR = 50;

/** The pending Google sign-in lives while the user is in the browser. */
export const GOOGLE_STATE_TTL_MS = 10 * MINUTE;
/** The single-use authorization code handed to the app. */
export const GOOGLE_CODE_TTL_MS = 60 * SECOND;
export const LINK_TICKET_TTL_MS = 5 * MINUTE;
export const MANAGE_TOKEN_TTL_MS = 5 * MINUTE;

export const REFRESH_GRACE_MS = 30 * SECOND;
export const REFRESH_IDLE_MS = 30 * DAY;
export const REFRESH_ABSOLUTE_MS = 180 * DAY;

/** The general window of every unauthenticated route, per hashed connection address and route. */
export const CONNECTION_REQUESTS_PER_MINUTE = 60;

export const HOUR_MS = HOUR;
export const MINUTE_MS = MINUTE;
export const DAY_MS = DAY;

/** A device with no active session is kept this long before it can be pruned (the sign-in that just made it has no session yet). */
export const DEVICE_PRUNE_GRACE_MS = MINUTE;

/** Where the app's loopback listener answers (RFC 8252: scheme, host and exact path are matched, the port is not). */
export const LOOPBACK_REDIRECT_PATH = "/callback";
/** The deep-link fallback, matched exactly. */
export const DEEP_LINK_REDIRECT_URI = "studentllm://auth/callback";
