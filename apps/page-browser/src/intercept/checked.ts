// The writes the map opens by their body (policy/operations.ts
// `CHECKED_ROWS`; owner decision 2026-10-23: the site's delivered marks, its
// read marks closed). The rules extension lets such a write through only as
// a script's POST in its exact spelling, and only to the operator: Fetch
// stops every request on the row's path, at its request stage
// (cdp/control.ts `FETCH_PATTERNS`), and it is decided here at once — on
// nothing but the request itself, never on the engine, a timer or another
// CDP call, so no pause outlives its event:
//   - a POST the map sends to the check: continued unchanged — no header,
//     no body, no URL changed — only when the bytes Fetch attached pass the
//     row's check (policy/body-checks.ts); else failed (BlockedByClient) and
//     journaled with why. A body Fetch did not attach whole (a stream; a
//     file among its parts) is refused unread: CDP has no other read of a
//     paused request's body (Chrome 155 has no Fetch.getRequestPostData),
//     and Network.getRequestPostData leaves files out — part of a body
//     would pass for the whole;
//   - its CORS preflight (the API is another origin, and the site's request
//     carries its own headers): continued when the request it is for would
//     be checked. Its body is not known yet: a read mark's preflight goes,
//     the read mark does not;
//   - a read the map opens on the path: continued, as it would go unpaused;
//   - anything else — another write, another spelling or query, another
//     resource type, an OPTIONS that is no preflight, a redirect's next
//     hop — failed.
// The same in both modes of the operator. What goes on is the site's own
// request: the observer (intercept/observe.ts) tells the engine of its send
// and end as of any other request of the site's.

import type { PausedDecision, PausedRequest } from "../cdp/paused.ts";
import { isPreflight } from "../hub-requests/hub.ts";
import { BODY_CHECKS } from "../policy/body-checks.ts";
import { checkedRowAt, decide as mapDecide, type OperatorMode } from "../policy/operations.ts";

function headerOf(headers: Record<string, string>, name: string): string | null {
  for (const [key, value] of Object.entries(headers)) if (key.toLowerCase() === name) return value;
  return null;
}

/** Whether a paused request is one of this path's: on a checked row's path
 *  (the operator keeps its body for the decision, cdp/paused.ts
 *  `readsBody`). */
export function checkedPath(url: string): boolean {
  return checkedRowAt(url) !== null;
}

/** The decision on a paused request on a checked row's path, or null for
 *  any other request (the other paths decide those). */
export function decideChecked(request: PausedRequest, mode: OperatorMode): PausedDecision | null {
  if (request.stage !== "request" || !checkedPath(request.url)) return null;
  const fail = (why: string): PausedDecision => ({ action: "fail", reason: "BlockedByClient", why });
  if (request.redirectedRequestId !== null) return fail("a redirect's next hop on a checked path: never followed");
  const preflight = isPreflight(request);
  if (request.method.toUpperCase() === "OPTIONS" && !preflight) return fail("an OPTIONS that is no CORS preflight");
  // A preflight is decided as the request it is for.
  const method = preflight ? (headerOf(request.headers, "access-control-request-method") ?? "").toUpperCase() : request.method.toUpperCase();
  const verdict = mapDecide({ method, url: request.url, resourceType: request.resourceType }, mode);
  switch (verdict.action) {
    case "check":
      break;
    case "admit":
      if (verdict.operation === "read") return { action: "continue", note: `${preflight ? "a read's preflight" : "a read"} on a checked path (${verdict.rule})` };
      return fail(`nothing opens it on a checked path (${verdict.rule})`);
    case "refuse":
      return fail(`${verdict.why} (${verdict.rule})`);
    default:
      return fail(`nothing opens it on a checked path (${verdict.rule})`);
  }
  if (preflight) return { action: "continue", note: `the preflight of ${verdict.rule}: its request's body is checked at its own pause` };
  const body = request.body;
  if (body === undefined || body === null) return fail(`a body Fetch did not attach whole: it cannot be checked (${verdict.rule})`);
  const judged = BODY_CHECKS[verdict.check](body);
  return judged.ok ? { action: "continue", note: judged.note } : fail(`${judged.why} (${verdict.rule})`);
}

/** What the journal says decided a pause of this path's (null: not one). */
export function describeChecked(request: PausedRequest): string | null {
  return checkedPath(request.url) ? "the check of a write opened by its body (owner decision 2026-10-23)" : null;
}
