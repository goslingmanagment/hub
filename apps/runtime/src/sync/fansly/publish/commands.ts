import type { FanslyWriteCommandRecord, FanslyWriteStep, SyncAttemptRow } from "@agency_hub_core/db";
import type { FanslyWireId } from "@agency_hub_core/fansly";

import type { OutcomeClass, OutcomeDecision } from "../../engine/errors.ts";

// The state machine of one Fansly write command (wall posts PR 6, spec §8.2):
//
//   queued ──admission (tx 1: attempt + fingerprint)──► sending
//   sending ──2xx the apply reads──────────────────────► answered
//   sending ──4xx carrying Fansly's own error──────────► rejected
//   sending ──anything else: no answer, a 5xx, a proxy's page, a crash
//             after the admission, an answer without the ids──► unknown
//   sending ──its attempt provably never left (aborted before the send)──► queued
//   queued ──a guard says no (a switch, the approval, the window)──► refused
//
// One attempt: a command is sent only from `queued`, and leaves `queued` only
// in the admission transaction of that one attempt. After a restart its
// attempt is closed `unknown` by the engine's recovery, and the command
// follows it to `unknown` — it is never planned again. A person decides an
// unknown one (spec §8.2).

/** The wire route of each step of a publication's chain (spec §5). */
export const FANSLY_WRITE_STEP_ROUTES: Readonly<Record<FanslyWriteStep, FanslyWireId>> = {
  upload_create: "publish.upload_create",
  upload_complete: "publish.upload_complete",
  account_media: "publish.account_media",
  account_media_bundle: "publish.account_media_bundle",
  post: "publish.post",
  story: "publish.story",
  post_cancel: "publish.post_cancel",
};

/** Every route a write command sends: the registry entries' operations. */
export const FANSLY_WRITE_OPERATIONS: readonly FanslyWireId[] = Object.values(FANSLY_WRITE_STEP_ROUTES);

/** The steps that take a scheduled post off the schedule: allowed while
 *  publishing is off (spec §8.4), never while the page is stopped. */
export const FANSLY_WITHDRAW_STEPS: readonly FanslyWriteStep[] = ["post_cancel"];

/** The error class of an attempt refused as a write before it left
 *  (`not_sent:<refusal>`, engine/commit.ts). */
export const WRITE_REFUSED_CLASS = "not_sent:write_refused";

/** What comes next for a command, by its state and its one attempt. */
export type WriteCommandNext =
  /** Queued: the guard, then the request derived from the approval. */
  | { kind: "derive" }
  /** Its attempt never left: back to the queue — no send was made. */
  | { kind: "requeue"; reason: string }
  /** Its attempt never left because the page's browser would not let this
   *  very write go, or the engine no longer admitted it at the browser's
   *  check (`write_refused`, wall posts PR 7): the same request would be
   *  refused again — back to the queue and refused there, never sent. */
  | { kind: "refuse_not_sent"; reason: string }
  /** Its attempt may have reached Fansly and no answer will be read: never
   *  sent again. */
  | { kind: "settle_unknown"; reason: string }
  /** Its answer is captured and the apply is due (or was deferred). */
  | { kind: "await_apply" }
  /** Its attempt is still open (the engine's recovery closes it first). */
  | { kind: "await_attempt" }
  /** It is answered, rejected, unknown or refused: nothing more, ever. */
  | { kind: "closed" };

export function nextWriteStep(
  command: Pick<FanslyWriteCommandRecord, "state" | "attemptId">,
  attempt: Pick<SyncAttemptRow, "id" | "outcome" | "applyState" | "errorClass"> | null,
): WriteCommandNext {
  switch (command.state) {
    case "answered":
    case "rejected":
    case "unknown":
    case "refused":
      return { kind: "closed" };
    case "queued":
      return { kind: "derive" };
    case "sending":
      break;
  }
  if (attempt === null || command.attemptId === null || attempt.id !== command.attemptId) {
    // The attempt it was admitted under is not to be found: whether it left
    // cannot be known.
    return { kind: "settle_unknown", reason: "attempt_missing" };
  }
  switch (attempt.outcome) {
    case "admitted":
    case "sent":
      return { kind: "await_attempt" };
    case "aborted_before_send":
      if (attempt.errorClass === WRITE_REFUSED_CLASS) return { kind: "refuse_not_sent", reason: `not_sent:${attempt.errorClass}` };
      return { kind: "requeue", reason: `not_sent:${attempt.errorClass ?? "aborted_before_send"}` };
    case "response":
      if (attempt.applyState === "captured" || attempt.applyState === "deferred") return { kind: "await_apply" };
      // An applied answer settles the command in the same transaction; one
      // that was not applied (an error answer whose capture hook could not
      // settle it, a quarantined apply) is no answer Hub can read.
      return { kind: "settle_unknown", reason: `answer_not_applied:${attempt.applyState}` };
    default:
      // A transport error or a timeout after the send, an attempt the
      // recovery closed `unknown` (a crash between the admission and the
      // capture): it may have gone.
      return { kind: "settle_unknown", reason: `no_answer:${attempt.outcome}` };
  }
}

/** What an answer that is not a 2xx the apply reads makes of the command. */
export interface WriteAnswerVerdict {
  to: "rejected" | "unknown";
  reason: string;
  /** spec §8.3: a 401, 403 or 429 on a publishing request stops the page's
   *  publishing at once (the reason it is stopped with); null: it does not. */
  autostop: string | null;
}

const AUTOSTOP_STATUSES: ReadonlySet<number> = new Set([401, 403, 429]);

/**
 * The end of a write whose answer is not one to apply (spec §4, §8.2). Only a
 * client error that carries Fansly's own error envelope is Fansly's refusal
 * (`rejected`: nothing was created); a 5xx, a proxy's or a gateway's page, a
 * 2xx without the success envelope that is no Fansly error, and no answer at
 * all may hide a created post (`unknown`). Null: a 2xx the apply reads.
 */
export function writeAnswerVerdict(input: {
  errorClass: OutcomeClass;
  outcome: "response" | "transport_error" | "timeout";
  httpStatus: number | null;
  fanslyErrorEnvelope: boolean;
}): WriteAnswerVerdict | null {
  if (input.errorClass === "ok") return null;
  const status = input.httpStatus;
  const autostop = status !== null && AUTOSTOP_STATUSES.has(status) ? `fansly_http_${status}` : null;
  if (input.outcome !== "response" || status === null) return { to: "unknown", reason: `no_answer:${input.outcome}`, autostop: null };
  if (input.fanslyErrorEnvelope && status >= 400 && status <= 499) return { to: "rejected", reason: `fansly_http_${status}`, autostop };
  if (input.fanslyErrorEnvelope && status >= 200 && status <= 299) return { to: "rejected", reason: "fansly_unsuccessful", autostop };
  return { to: "unknown", reason: `answer_${input.errorClass}:${status}`, autostop };
}

/**
 * The engine's decision on a write's outcome, as a write needs it: a 2xx
 * goes to the apply; anything else never re-reads the row on a breaker's
 * ladder — the work is due again at once, and its next plan settles the
 * command from the attempt (unless the capture hook already did, and closed
 * it). The page's and the route's holds stay as decided: a 401 still holds
 * the page, a 429 its route.
 */
export function writeOutcomeDecision(decision: OutcomeDecision): OutcomeDecision {
  if (decision.work.action === "apply") return decision;
  return {
    ...decision,
    subjectBreaker: null,
    work: { action: "reopen", dueAt: null, waitingReason: null, waitingUntil: null },
  };
}
