import { safeFanslyAnswerHeaders, type FanslySendCompletionOutcome, type FanslySendLease } from "@agency_hub_core/fansly";
import type { Dispatcher } from "undici";

// Plan §2.4: the page socket's handshake rides the page's egress on a send
// lease — one physical HTTP request, whose dispatcher refuses a second
// dispatch and which is completed once it has settled. The lease is the Sync
// Engine's (`createEngineUpgradeLease`: the pacer's admission); the legacy
// guard's senders are deleted (step 4).

/** Hosts of Fansly's origins: the REST API, the WebSocket and the media CDNs. */
export function isFanslyHost(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/\.$/, "");
  return host === "fansly.com" || host.endsWith(".fansly.com");
}

/** The completion outcome of a request that threw: its own deadline (a
 *  `TimeoutError` anywhere in the cause chain), or else the transport. A
 *  dispatch the lease refused is journaled `aborted_before_send` by the lease
 *  itself, whatever is passed here. */
export function fanslySendFailureOutcome(error: unknown): FanslySendCompletionOutcome {
  const seen = new Set<unknown>();
  for (let current = error; current instanceof Error && !seen.has(current); current = current.cause) {
    if (current.name === "TimeoutError") return "timeout";
    seen.add(current);
  }
  return "transport_error";
}

/**
 * The dispatcher for ONE guarded HTTP Upgrade (a WebSocket handshake). The
 * lease's send check is composed outermost, so it is the last thing to run
 * before the request headers are written, after any check of `dispatcher`.
 * The lease completes as soon as the handshake settles: at 101, at any other
 * response status, or at a transport error. A response completes it with its
 * status and its safe headers (`safeFanslyAnswerHeaders`: a 429's or a 503's
 * `Retry-After` reaches the engine's classifier; a cookie never leaves this
 * callback). The frames of the open socket are not HTTP requests and are not
 * paced. The owner still completes the lease when the attempt ends
 * (idempotent), which covers a handshake that never reached the transport.
 */
export function bindFanslyUpgradeLease(lease: FanslySendLease, dispatcher: Dispatcher): Dispatcher {
  const complete = (outcome: FanslySendCompletionOutcome, httpStatus: number | null, headers: Readonly<Record<string, string>> = {}) => {
    // Never rejects in practice (the write is retried until durable); a
    // transport callback must not throw either way.
    void lease.complete({ outcome, httpStatus, headers }).catch(() => undefined);
  };
  const settled = dispatcher.compose((dispatch) => (options, handler) => dispatch(options, {
    onRequestStart: (controller, context) => handler.onRequestStart?.(controller, context),
    onRequestUpgrade(controller, statusCode, headers, socket) {
      complete("response", statusCode, safeFanslyAnswerHeaders(headers));
      handler.onRequestUpgrade?.(controller, statusCode, headers, socket);
    },
    onResponseStart(controller, statusCode, headers, statusMessage) {
      complete("response", statusCode, safeFanslyAnswerHeaders(headers));
      handler.onResponseStart?.(controller, statusCode, headers, statusMessage);
    },
    onResponseData: (controller, chunk) => handler.onResponseData?.(controller, chunk),
    onResponseEnd: (controller, trailers) => handler.onResponseEnd?.(controller, trailers),
    onResponseError(controller, error) {
      complete(fanslySendFailureOutcome(error), null);
      handler.onResponseError?.(controller, error);
    },
  }));
  return lease.bind(settled);
}
