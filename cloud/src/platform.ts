// Local types for the few Cloudflare runtime objects the gateway touches. This replaces
// `@cloudflare/workers-types`: that package redeclares Request, Response, crypto and streams, which collide
// with `@types/node` in the test project, and it adds a dependency. These interfaces are structural, so the
// real runtime objects satisfy them. Types only; nothing here exists at run time.

export interface ExecutionContext {
  /** Keeps the Worker alive until the promise settles (after the response was sent). */
  waitUntil(promise: Promise<unknown>): void;
  passThroughOnException?(): void;
}

export interface ScheduledController {
  /** Epoch milliseconds the cron trigger was scheduled for. */
  readonly scheduledTime: number;
  readonly cron: string;
  noRetry?(): void;
}

/** What a Durable Object receives. Only the parts the scaffold names; the adapters will extend it. */
export interface DurableObjectState {
  readonly id: { toString(): string };
  waitUntil(promise: Promise<unknown>): void;
}
