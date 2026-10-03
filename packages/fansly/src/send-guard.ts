import type { Dispatcher } from "undici";

// Plan §2.5 step 1: every request the hub sends to a Fansly page passes ONE
// per-page guard that all processes share. The guard itself (a conditional
// UPDATE of the page's row, by DB clock) lives in the runtime; this package only
// knows the contract, so the adapter never imports the database.
//
// A lease is one admission for ONE physical request:
//   1. `acquire` returns once the page had no request in flight and at least
//      S × (1 + u) passed since the previous request COMPLETED;
//   2. the adapter dispatches through `lease.bind(dispatcher)`, whose
//      interceptor checks the lease synchronously right before the request
//      headers are written (undici `onRequestStart`) and aborts the request
//      otherwise — a second dispatch of the same lease (a redirect hop, undici's
//      hidden 421 re-send) is refused there, so zero bytes reach the origin;
//   3. `complete` is written after the response body was read, or after the
//      error or timeout. It is the only thing that opens the page again.

/** Who sends. A closed vocabulary, mirrored by the CHECK on
 *  `fansly_send_log.source` (migration 0225). The last four are the senders
 *  outside the adapter that join the guard in the next step. */
export const FANSLY_SEND_SOURCES = [
  "sync_stream",
  "ws_hint",
  "ai_accelerator",
  "targeted_backfill",
  "ai_fast_lane",
  "account_me_api",
  "account_me_cli",
  "endpoint_probe",
  "replay_probe",
  "alias_backfill",
  "onboarding",
  "credentials_verify",
  "media_download",
  "ws_connect",
  "binding_preflight",
  "ws_probe",
] as const;
export type FanslySendSource = (typeof FANSLY_SEND_SOURCES)[number];

export const FANSLY_SEND_OUTCOMES = [
  "response",
  "transport_error",
  "timeout",
  "aborted_before_send",
  "confirmed_terminated",
] as const;
export type FanslySendOutcome = (typeof FANSLY_SEND_OUTCOMES)[number];
/** What a lease holder reports. `confirmed_terminated` is written only by the
 *  confirmation of a dead holder, never by the holder itself. */
export type FanslySendCompletionOutcome = Exclude<FanslySendOutcome, "confirmed_terminated">;

export interface FanslySendGuardAcquireInput {
  /** The adapter operation (`account_me`, `messages`, …), for the journal. */
  operation: string;
  /** The timeout the request runs under. The send window and the lease term
   *  are derived from it. */
  requestTimeoutMs: number;
  /** Admission cancellation. A capture that lands after the signal fired is
   *  released before `acquire` rejects. */
  signal?: AbortSignal | null;
}

export interface FanslySendLease {
  readonly token: string;
  /** The page whose guard this lease holds; null for a check of an unknown
   *  session, which is journaled but paced against no page (owner decision №4). */
  readonly pageId: number | null;
  /** True once the bound dispatcher wrote request headers for this lease. */
  readonly sent: boolean;
  /** True once the bound dispatcher refused a dispatch of this lease. */
  readonly sendRefused: boolean;
  /** The dispatcher with this lease's send check composed on top. Bind per
   *  request: the check closes over THIS lease (an AsyncLocalStorage read inside
   *  `onRequestStart` can see a previous request's context). */
  bind(dispatcher: Dispatcher): Dispatcher;
  /** Write the completion. Idempotent; resolves once it is durable. `headers`
   *  are the answer's safe headers (`safeFanslyAnswerHeaders`), for a holder
   *  that classifies the answer (the Sync Engine's Upgrade lease); a guard that
   *  journals the send keeps the status only. */
  complete(input: {
    outcome: FanslySendCompletionOutcome;
    httpStatus?: number | null;
    headers?: Readonly<Record<string, string>>;
  }): Promise<void>;
}

/** The headers of an answer a lease completion may carry: those the Sync
 *  Engine's classifier reads about the provider's pace (the `Retry-After` of a
 *  429 or of a 5xx). Nothing else of an answer — a cookie, the socket's accept
 *  key — goes past the transport callback that saw it. */
export const FANSLY_SAFE_ANSWER_HEADERS: ReadonlySet<string> = new Set(["retry-after"]);

/** The safe headers of an answer (`FANSLY_SAFE_ANSWER_HEADERS`) by lower-case
 *  name; a repeated header is joined as the wire layer joins a REST answer's. */
export function safeFanslyAnswerHeaders(
  headers: Readonly<Record<string, string | readonly string[] | undefined>> | null | undefined,
): Record<string, string> {
  const safe: Record<string, string> = {};
  if (headers === null || headers === undefined) return safe;
  for (const [name, value] of Object.entries(headers)) {
    const key = name.toLowerCase();
    if (value === undefined || !FANSLY_SAFE_ANSWER_HEADERS.has(key)) continue;
    safe[key] = typeof value === "string" ? value : value.join(", ");
  }
  return safe;
}

export interface FanslySendGuard {
  acquire(input: FanslySendGuardAcquireInput): Promise<FanslySendLease>;
}

/** Why a send check refused a dispatch. The first three are every lease's;
 *  `pace` (closer than S × (1 + u) to the previous send) and `takeover_floor`
 *  (before the first-send floor after an ownership takeover) are the Sync
 *  Engine pacer's, which reuses this check contract (`composeFanslySendCheck`). */
export type FanslySendRefusalReason =
  | "lease_inactive"
  | "lease_used"
  | "send_deadline_passed"
  | "pace"
  | "takeover_floor";

/** A dispatch the lease's send check refused. Nothing was written to the
 *  socket for it. */
export class FanslySendRefusedError extends Error {
  constructor(readonly reason: FanslySendRefusalReason) {
    super(`Fansly send refused by the page send guard (${reason})`);
    this.name = "FanslySendRefusedError";
  }
}

/** The synchronous check a lease runs when the transport is about to write the
 *  request headers. Returns the refusal, or null when the request may go. */
export type FanslySendCheck = () => FanslySendRefusedError | null;

/**
 * Compose `check` onto `dispatcher`. `onRequestStart` is called by undici
 * immediately before the request headers are written, after the connection and
 * any proxy tunnel are up; aborting there writes nothing. Every physical
 * dispatch passes through here, including redirect hops and undici's internal
 * re-sends. The returned dispatcher is a view of `dispatcher` — closing it
 * closes the underlying one, so callers never close it.
 */
export function composeFanslySendCheck(dispatcher: Dispatcher, check: FanslySendCheck): Dispatcher {
  return dispatcher.compose((dispatch) => (options, handler) => dispatch(options, {
    onRequestStart(controller, context) {
      const refusal = check();
      if (refusal) {
        controller.abort(refusal);
        return;
      }
      handler.onRequestStart?.(controller, context);
    },
    onRequestUpgrade(controller, statusCode, headers, socket) {
      handler.onRequestUpgrade?.(controller, statusCode, headers, socket);
    },
    onResponseStart(controller, statusCode, headers, statusMessage) {
      handler.onResponseStart?.(controller, statusCode, headers, statusMessage);
    },
    onResponseData(controller, chunk) {
      handler.onResponseData?.(controller, chunk);
    },
    onResponseEnd(controller, trailers) {
      handler.onResponseEnd?.(controller, trailers);
    },
    onResponseError(controller, error) {
      handler.onResponseError?.(controller, error);
    },
  }));
}

/** Whether `error` (or anything in its cause chain) is a send-guard refusal.
 *  Matched by name, so a refusal from another copy of this module counts. */
export function findFanslySendRefusal(error: unknown): FanslySendRefusedError | null {
  const seen = new Set<unknown>();
  let current: unknown = error;
  while (current instanceof Error && !seen.has(current)) {
    if (current.name === "FanslySendRefusedError" && "reason" in current) {
      return current as FanslySendRefusedError;
    }
    seen.add(current);
    current = current.cause;
  }
  return null;
}
