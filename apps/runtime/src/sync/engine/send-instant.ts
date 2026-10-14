import type { SyncAttemptRow } from "@agency_hub_core/db";

// An attempt's send instant for anything ordered against an engine event by
// time (Astra's review of PR 15, rounds 5 and 6): an identity proof against
// the end of a login and against a credentials hold's latest refusal (the
// trusted digest it writes), an identity check's proof presented to the
// owner's save.
//
// A send is known only when its sender said when it left: undici's
// `onRequestStart` in this process (`request_start`), or a page browser's
// `sent` received as it came — the gate's first bytes on the operator's own
// clock (`transport_reported`). Otherwise — no mark, `completion_fallback`
// (a `sent` lost on the way; a result's own instant proves nothing), a
// shadow send — the instant is unknown, and an unknown send counts as early
// as it can have been: its admission. It then proves nothing fenced after
// its admission. The pacer takes the other bound for an unknown send — the
// completion, the latest it can have left (`engine/pacer.ts` `complete`).

/** The instant `attempt` is known to have left by, for an ordering against a
 *  fence: its reported send, else its admission. */
export function provenSentAt(attempt: Pick<SyncAttemptRow, "sendMark" | "sentAt" | "admittedAt">): Date {
  const known = attempt.sendMark === "request_start" || attempt.sendMark === "transport_reported";
  return known && attempt.sentAt !== null ? attempt.sentAt : attempt.admittedAt;
}
