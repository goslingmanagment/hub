// chat-extension greeting lease and send custody (hub-pr-plan H-7a): the
// rules, as a pure function over a snapshot the repository reads under the
// fan's advisory lock (client-claim.ts). No SQL here, so every rule has a unit
// test (tests/client-claim-transition.test.ts).
//
// Three facts per fan (architecture §6.7.7–§6.7.9): the first greeting is
// confirmed; one human and instance holds the lease on working it out; one
// attempt holds the custody of a part being sent. Custody never expires: a
// dispatch whose ticket ran out is uncertain-held until it is reported sent,
// failed with evidence, or resolved by hand.

export const CLIENT_FAN_LEASE_TTL_MS = 120_000;
export const CLIENT_SEND_TICKET_TTL_MS = 10_000;
/** At most this many preview sends per user in the window (per-user lock). */
export const CLIENT_PREVIEW_SEND_RATE_LIMIT = 6;
export const CLIENT_PREVIEW_SEND_RATE_WINDOW_MS = 60_000;

export type ClientClaimPurpose = "greeting" | "preview-reply";
export type ClientLeaseState = "active" | "released" | "expired";
export type ClientCustodyStoredState = "dispatching" | "sent" | "failed" | "resolved_sent" | "resolved_not_sent";
export type ClientCustodyViewState =
  | "dispatching" | "sent" | "failed" | "uncertain-held" | "resolved-sent" | "resolved-not-sent";
export type ClientGreetingSource = "preview-send" | "native-register" | "resolve" | "desktop-outbox";
export type ClientSendFailureReason = "not_enqueued" | "native_rejected";

export interface ClientClaimGroup {
  generationRef: string;
  variant: number;
  partCount: number;
}

export interface ClientLeaseRow {
  leaseId: string;
  pageId: number;
  fanRef: string;
  userId: number;
  instanceId: string;
  state: ClientLeaseState;
  expiresAt: Date;
}

export interface ClientGreetingRow {
  ownerUserId: number | null;
  generationRef: string | null;
  variant: number | null;
  partCount: number | null;
  confirmedAt: Date;
  firstMessageRef: string | null;
  /**
   * The custody row of the first confirmed part (`first_attempt_id`). The rules read it to know
   * the part a native send confirmed over a held preview send; a reader that only shows the
   * greeting may leave it out.
   */
  firstAttemptId?: string | null;
  source: "preview-send" | "native-register" | "resolve";
}

/**
 * A desktop new-follower command that holds the fan under the predicate of
 * `ofapi_commands_follower_outreach_uniq` (0195): `confirmed` when OnlyFans
 * took the greeting, `held` for every other state the index still holds
 * (queued, in flight, indeterminate, failed without proof it never left).
 */
export interface DesktopFollowerOutreach {
  commandId: string;
  state: "confirmed" | "held";
  at: Date;
  messageRef: string | null;
}

export interface ClientCustodyRow {
  attemptId: string;
  pageId: number;
  fanRef: string;
  userId: number;
  instanceId: string;
  purpose: ClientClaimPurpose;
  origin: "preview-send" | "native-register";
  generationRef: string;
  variant: number;
  partCount: number;
  partIndex: number;
  requestHash: string;
  state: ClientCustodyStoredState;
  ticketExpiresAt: Date | null;
  platformMessageId: string | null;
  failureReason: ClientSendFailureReason | null;
  failureHttpStatus: number | null;
}

/** Everything the rules read about one fan, taken under the fan's lock. */
export interface ClientFanClaimSnapshot {
  pageId: number;
  fanRef: string;
  now: Date;
  /** The fan's lease in state active, even when past its expiry. */
  activeLease: ClientLeaseRow | null;
  /** The row of the request's leaseToken, wherever it is. */
  requestedLease: ClientLeaseRow | null;
  greeting: ClientGreetingRow | null;
  desktop: DesktopFollowerOutreach | null;
  /** The fan's dispatching attempt (one at most). */
  openCustody: ClientCustodyRow | null;
  /** The row of the request's attemptId, wherever it is. */
  attempt: ClientCustodyRow | null;
  /** The row that already carries the request's platform message id on this page. */
  messageOwner: ClientCustodyRow | null;
  /**
   * The group the view reports, and its dispatching / sent / resolved-sent parts, plus, in whatever
   * state, the row of the greeting's first confirmed part when it is of this group.
   */
  group: ClientClaimGroup | null;
  groupParts: ClientCustodyRow[];
  /** The user's preview sends inside the rate window (dispatch only). */
  recentPreviewSends: number;
  /**
   * The viewer's own last send to this fan dispatched from the preview, in
   * whatever state it ended. Only the status read loads it (H-7b), and only
   * while no send to the fan is open; an action leaves it undefined.
   */
  lastOwnDispatch?: ClientCustodyRow | null;
}

interface ActorFields {
  pageId: number;
  fanRef: string;
  userId: number;
}

export type ClientClaimRequest = ActorFields & (
  | { action: "claim" | "renew" | "release"; leaseToken: string; instanceId: string }
  | {
    action: "dispatch"; attemptId: string; instanceId: string; purpose: ClientClaimPurpose;
    group: ClientClaimGroup; partIndex: number; textRevision: number; leaseToken: string | null;
    flagRevision: number | null; requestHash: string;
  }
  | { action: "sent"; attemptId: string; instanceId: string; platformMessageId: string }
  | {
    action: "failed"; attemptId: string; instanceId: string; reason: ClientSendFailureReason;
    httpStatus: number | null;
  }
  | {
    action: "registerNativeSend"; attemptId: string; instanceId: string; purpose: ClientClaimPurpose;
    group: ClientClaimGroup; partIndex: number; platformMessageId: string; requestHash: string;
  }
  // userId is the resolver (owner or team lead; the route checks the role).
  | { action: "resolve"; attemptId: string; outcome: "sent" | "not_sent"; platformMessageId: string | null; note: string }
);

/**
 * Refusals. `invalid_request` is a 400; `not_found` a 404; the rest are 409/429 (plan §4.11).
 * `custody_not_held` and `ticket_live` are the manual resolve's alone.
 */
export type ClientClaimRejectionCode =
  | "invalid_request"
  | "not_found"
  | "claim_busy"
  | "claim_expired"
  | "custody_held"
  | "custody_not_owned"
  | "custody_not_held"
  | "ticket_live"
  | "greeting_done"
  | "generation_mismatch"
  | "part_already_sent"
  | "attempt_conflict"
  | "preview_send_rate_limited";

export type ClientClaimWrite =
  | { op: "expireLease"; leaseId: string }
  | { op: "insertLease"; leaseId: string; instanceId: string; expiresAt: Date }
  | { op: "renewLease"; leaseId: string; expiresAt: Date }
  | { op: "releaseLease"; leaseId: string }
  | {
    op: "insertDispatch"; attemptId: string; instanceId: string; purpose: ClientClaimPurpose;
    group: ClientClaimGroup; partIndex: number; textRevision: number; requestHash: string;
    leaseId: string | null; flagRevision: number | null; ticketExpiresAt: Date;
  }
  | { op: "markSent"; attemptId: string; platformMessageId: string }
  | { op: "markFailed"; attemptId: string; reason: ClientSendFailureReason; httpStatus: number | null }
  | {
    op: "insertNativeSend"; attemptId: string; instanceId: string; purpose: ClientClaimPurpose;
    group: ClientClaimGroup; partIndex: number; platformMessageId: string; requestHash: string;
  }
  | {
    op: "resolve"; attemptId: string; outcome: "sent" | "not_sent"; platformMessageId: string | null;
    note: string; priorState: "dispatching" | "uncertain-held";
  }
  | {
    op: "confirmGreeting"; source: "preview-send" | "native-register" | "resolve"; ownerUserId: number;
    group: ClientClaimGroup; messageRef: string | null; attemptId: string;
  };

export type ClientClaimDecision =
  /** `writes` may hold only the lazy lease expiry when the action itself is refused. */
  | { outcome: "rejected"; code: ClientClaimRejectionCode; writes: ClientClaimWrite[] }
  | { outcome: "applied"; writes: ClientClaimWrite[] };

const isLive = (lease: ClientLeaseRow | null, now: Date): lease is ClientLeaseRow =>
  lease !== null && lease.state === "active" && lease.expiresAt.getTime() > now.getTime();

/** A part's identity is the one `client_send_custody_part_once` keys on: generation, variant, index. */
const sameGroup = (row: ClientCustodyRow, group: ClientClaimGroup) =>
  row.generationRef === group.generationRef && row.variant === group.variant;

/** The row is about this page and fan (a token or attempt id may name another). */
const isPartOf = (row: { pageId: number; fanRef: string }, key: { pageId: number; fanRef: string }) =>
  row.pageId === key.pageId && row.fanRef === key.fanRef;

/** The row already records this send: same fan, purpose and part, counted as sent. */
const recordsSend = (
  row: ClientCustodyRow,
  send: { pageId: number; fanRef: string; purpose: ClientClaimPurpose; group: ClientClaimGroup; partIndex: number },
) => isPartOf(row, send) && (row.state === "sent" || row.state === "resolved_sent") && row.purpose === send.purpose
  && sameGroup(row, send.group) && row.partIndex === send.partIndex;

/**
 * The part a proven native send confirmed the fan's greeting with while a send of that very part
 * from the preview was still held. The held send keeps the part's one custody row, so the proof is
 * recorded on the greeting alone (its first attempt is that row, its source native-register), and
 * the part counts as sent whatever becomes of the row.
 */
const greetedNativelyOver = (snapshot: Pick<ClientFanClaimSnapshot, "greeting">, row: ClientCustodyRow) =>
  snapshot.greeting?.source === "native-register" && snapshot.greeting.firstAttemptId === row.attemptId
  && row.origin === "preview-send";

/** The part is sent: its row says so, or a native send of it confirmed the greeting over a held one. */
const partSent = (snapshot: Pick<ClientFanClaimSnapshot, "greeting">, row: ClientCustodyRow) =>
  row.state === "sent" || row.state === "resolved_sent" || greetedNativelyOver(snapshot, row);

/** failed releases custody: only proof the native queue never took the part. */
export function isAcceptedFailureEvidence(reason: ClientSendFailureReason, httpStatus: number | null): boolean {
  if (reason === "not_enqueued") return httpStatus === null;
  return httpStatus !== null && Number.isInteger(httpStatus) && httpStatus >= 400 && httpStatus <= 499 && httpStatus !== 401;
}

export function custodyViewState(row: Pick<ClientCustodyRow, "state" | "ticketExpiresAt">, now: Date): ClientCustodyViewState {
  switch (row.state) {
    case "dispatching":
      return row.ticketExpiresAt !== null && row.ticketExpiresAt.getTime() > now.getTime() ? "dispatching" : "uncertain-held";
    case "resolved_sent": return "resolved-sent";
    case "resolved_not_sent": return "resolved-not-sent";
    default: return row.state;
  }
}

/** The confirmed first greeting: the client's own record, else the desktop outbox. */
export function confirmedGreeting(snapshot: Pick<ClientFanClaimSnapshot, "greeting" | "desktop">): {
  at: Date; messageRef: string | null; source: ClientGreetingSource;
} | null {
  if (snapshot.greeting) {
    return { at: snapshot.greeting.confirmedAt, messageRef: snapshot.greeting.firstMessageRef, source: snapshot.greeting.source };
  }
  if (snapshot.desktop?.state === "confirmed") {
    return { at: snapshot.desktop.at, messageRef: snapshot.desktop.messageRef, source: "desktop-outbox" };
  }
  return null;
}

/**
 * Decide one action. Ordered like hub-pr-plan H-7b `dispatch`: replay, (the
 * owner switch: the repository's gate, between replay and the rest), rate,
 * open custody, desktop greeting, greeting or lease, part.
 */
export function decideClaimTransition(snapshot: ClientFanClaimSnapshot, request: ClientClaimRequest): ClientClaimDecision {
  const { now } = snapshot;
  const writes: ClientClaimWrite[] = [];
  // Lazy expiry: any action on the fan moves its dead lease to expired.
  let activeLease = snapshot.activeLease;
  let requestedLease = snapshot.requestedLease;
  if (activeLease && activeLease.expiresAt.getTime() <= now.getTime()) {
    writes.push({ op: "expireLease", leaseId: activeLease.leaseId });
    if (requestedLease?.leaseId === activeLease.leaseId) requestedLease = { ...requestedLease, state: "expired" };
    activeLease = null;
  }
  const reject = (code: ClientClaimRejectionCode): ClientClaimDecision => ({ outcome: "rejected", code, writes });
  const apply = (...more: ClientClaimWrite[]): ClientClaimDecision => ({ outcome: "applied", writes: [...writes, ...more] });
  const ownsLease = (lease: ClientLeaseRow, instanceId: string) =>
    lease.userId === request.userId && lease.instanceId === instanceId;

  switch (request.action) {
    case "claim": {
      // A greeted fan has no first greeting left to work out. Only the greeting's owner may still
      // hold the fan (the rest of its group); for everyone else the lease would only lead to a
      // second greeting, by hand if not from the preview.
      if (confirmedGreeting(snapshot) && snapshot.greeting?.ownerUserId !== request.userId) return reject("greeting_done");
      if (isLive(activeLease, now)) {
        return activeLease.leaseId === request.leaseToken && ownsLease(activeLease, request.instanceId) ? apply() : reject("claim_busy");
      }
      // A token names one lease, once: a released or expired one is not revived.
      if (requestedLease) return reject("claim_expired");
      return apply({
        op: "insertLease", leaseId: request.leaseToken, instanceId: request.instanceId,
        expiresAt: new Date(now.getTime() + CLIENT_FAN_LEASE_TTL_MS),
      });
    }
    case "renew":
    case "release": {
      if (!requestedLease || !isPartOf(requestedLease, request)) return reject("claim_expired");
      if (!ownsLease(requestedLease, request.instanceId)) return reject("claim_busy");
      if (request.action === "release") {
        return requestedLease.state === "active" ? apply({ op: "releaseLease", leaseId: requestedLease.leaseId }) : apply();
      }
      if (requestedLease.state !== "active") return reject("claim_expired");
      return apply({ op: "renewLease", leaseId: requestedLease.leaseId, expiresAt: new Date(now.getTime() + CLIENT_FAN_LEASE_TTL_MS) });
    }
    case "dispatch": {
      if (request.partIndex >= request.group.partCount) return reject("invalid_request");
      // 1. A repeat only reads: no second ticket once the first could have reached the page.
      if (snapshot.attempt) return snapshot.attempt.requestHash === request.requestHash ? apply() : reject("attempt_conflict");
      // 3. Rate, counted under the user's lock.
      if (snapshot.recentPreviewSends >= CLIENT_PREVIEW_SEND_RATE_LIMIT) return reject("preview_send_rate_limited");
      // 4. Nobody's send to this fan is unresolved.
      if (snapshot.openCustody) return reject("custody_held");
      let leaseId: string | null = null;
      if (request.purpose === "greeting") {
        // 5. The desktop greeted (confirmed) or may have (anything else the index holds).
        if (snapshot.desktop?.state === "confirmed") return reject("greeting_done");
        if (snapshot.desktop?.state === "held") return reject("custody_held");
        // 6. Confirmed: only its owner, only the rest of the same group.
        const greeting = snapshot.greeting;
        if (greeting) {
          if (greeting.ownerUserId !== request.userId) return reject("greeting_done");
          if (greeting.generationRef !== request.group.generationRef || greeting.variant !== request.group.variant
            || greeting.partCount !== request.group.partCount) return reject("generation_mismatch");
        } else {
          // Before confirmation only the live lease of this user, instance and token.
          if (!isLive(activeLease, now)) return reject("claim_expired");
          // The fan is held by this very install under another token: the lease the request names
          // (or fails to name) is gone, which is not "someone else is working on the fan".
          if (!ownsLease(activeLease, request.instanceId)) return reject("claim_busy");
          if (activeLease.leaseId !== request.leaseToken) return reject("claim_expired");
          leaseId = activeLease.leaseId;
        }
      }
      // 7. Each part once.
      if (snapshot.groupParts.some((row) => sameGroup(row, request.group) && row.partIndex === request.partIndex
        && partSent(snapshot, row))) return reject("part_already_sent");
      return apply({
        op: "insertDispatch", attemptId: request.attemptId, instanceId: request.instanceId, purpose: request.purpose,
        group: request.group, partIndex: request.partIndex, textRevision: request.textRevision,
        requestHash: request.requestHash, leaseId, flagRevision: request.flagRevision,
        ticketExpiresAt: new Date(now.getTime() + CLIENT_SEND_TICKET_TTL_MS),
      });
    }
    case "sent":
    case "failed": {
      if (request.action === "failed" && !isAcceptedFailureEvidence(request.reason, request.httpStatus)) {
        return reject("invalid_request");
      }
      const attempt = snapshot.attempt;
      // Only the user AND the instance that dispatched report its outcome.
      if (!attempt || !isPartOf(attempt, request) || attempt.userId !== request.userId
        || attempt.instanceId !== request.instanceId) return reject("custody_not_owned");
      if (request.action === "sent") {
        if (attempt.state === "sent") {
          return attempt.platformMessageId === request.platformMessageId ? apply() : reject("attempt_conflict");
        }
        if (attempt.state !== "dispatching") return reject("attempt_conflict");
        if (snapshot.messageOwner && snapshot.messageOwner.attemptId !== attempt.attemptId) return reject("attempt_conflict");
        return apply(
          { op: "markSent", attemptId: attempt.attemptId, platformMessageId: request.platformMessageId },
          ...greetingConfirmation(snapshot, attempt, "preview-send", request.platformMessageId),
        );
      }
      if (attempt.state === "failed") {
        return attempt.failureReason === request.reason && attempt.failureHttpStatus === request.httpStatus
          ? apply() : reject("attempt_conflict");
      }
      if (attempt.state !== "dispatching") return reject("attempt_conflict");
      // Past its ticket the send is uncertain-held, and that never becomes failed: the report
      // says what the client knew inside the ticket, and nothing since. Only the late proof
      // (sent) or the manual resolve ends it.
      if (custodyViewState(attempt, now) !== "dispatching") return reject("custody_held");
      return apply({ op: "markFailed", attemptId: attempt.attemptId, reason: request.reason, httpStatus: request.httpStatus });
    }
    case "registerNativeSend": {
      if (request.partIndex >= request.group.partCount) return reject("invalid_request");
      // Idempotent per page and message: the send is recorded once, by whoever came first. Only
      // a record of this very part is a repeat; any other owner of the id contradicts the proof,
      // and answering ok would drop the send (and with it the greeting) unrecorded.
      if (snapshot.messageOwner) return recordsSend(snapshot.messageOwner, request) ? apply() : reject("attempt_conflict");
      if (snapshot.attempt) return snapshot.attempt.requestHash === request.requestHash ? apply() : reject("attempt_conflict");
      // The message that confirmed the greeting over a held send (below) is on no custody row: a
      // repeat of that proof reads, the same message with other facts contradicts it.
      const greeting = snapshot.greeting;
      if (greeting?.source === "native-register" && greeting.firstMessageRef === request.platformMessageId) {
        const first = snapshot.groupParts.find((row) => row.attemptId === greeting.firstAttemptId);
        return request.purpose === "greeting" && greeting.ownerUserId === request.userId && first !== undefined
          && sameGroup(first, request.group) && first.partIndex === request.partIndex ? apply() : reject("attempt_conflict");
      }
      const parts = snapshot.groupParts.filter((row) => sameGroup(row, request.group) && row.partIndex === request.partIndex);
      const held = parts.find((row) => row.state === "dispatching");
      if (held) {
        // Never touches another attempt's custody: a held part stays held, and its one row stays
        // the preview send's, which only its own report or the manual resolve ends. But the proof
        // that the fan IS greeted is not dropped with the refusal. Dropped, the fan would read as
        // not greeted, and after a truthful "not sent" resolve of the preview send a colleague
        // would greet again. So a greeting is confirmed here, on the greeting alone.
        if (request.purpose === "greeting" && !confirmedGreeting(snapshot)) {
          return apply({
            op: "confirmGreeting", source: "native-register", ownerUserId: request.userId, group: request.group,
            messageRef: request.platformMessageId, attemptId: held.attemptId,
          });
        }
        return reject("custody_held");
      }
      if (parts.some((row) => partSent(snapshot, row))) return reject("part_already_sent");
      const row: ClientCustodyRow = {
        attemptId: request.attemptId, pageId: request.pageId, fanRef: request.fanRef, userId: request.userId,
        instanceId: request.instanceId, purpose: request.purpose, origin: "native-register",
        generationRef: request.group.generationRef, variant: request.group.variant, partCount: request.group.partCount,
        partIndex: request.partIndex, requestHash: request.requestHash, state: "sent", ticketExpiresAt: null,
        platformMessageId: request.platformMessageId, failureReason: null, failureHttpStatus: null,
      };
      return apply(
        {
          op: "insertNativeSend", attemptId: request.attemptId, instanceId: request.instanceId, purpose: request.purpose,
          group: request.group, partIndex: request.partIndex, platformMessageId: request.platformMessageId,
          requestHash: request.requestHash,
        },
        ...greetingConfirmation(snapshot, row, "native-register", request.platformMessageId),
      );
    }
    case "resolve": {
      // A message id is evidence of a send: with not_sent it contradicts the outcome, and
      // kept on the row it would take the page's id slot from the real send's later proof.
      if (request.outcome === "not_sent" && request.platformMessageId !== null) return reject("invalid_request");
      const attempt = snapshot.attempt;
      if (!attempt || !isPartOf(attempt, request)) return reject("not_found");
      if (attempt.state === "resolved_sent" || attempt.state === "resolved_not_sent") {
        const same = request.outcome === "sent"
          ? attempt.state === "resolved_sent" && attempt.platformMessageId === request.platformMessageId
          : attempt.state === "resolved_not_sent";
        return same ? apply() : reject("attempt_conflict");
      }
      if (attempt.state !== "dispatching") return reject("custody_not_held");
      // Inside its ticket the page may still put the part into the native queue. "Not sent" would
      // free the part for a second dispatch while the first can yet go out.
      if (request.outcome === "not_sent" && custodyViewState(attempt, now) === "dispatching") return reject("ticket_live");
      if (request.platformMessageId !== null && snapshot.messageOwner) return reject("attempt_conflict");
      const resolveWrite: ClientClaimWrite = {
        op: "resolve", attemptId: attempt.attemptId, outcome: request.outcome, platformMessageId: request.platformMessageId,
        note: request.note, priorState: custodyViewState(attempt, now) === "dispatching" ? "dispatching" : "uncertain-held",
      };
      return request.outcome === "sent"
        ? apply(resolveWrite, ...greetingConfirmation(snapshot, attempt, "resolve", request.platformMessageId))
        : apply(resolveWrite);
    }
  }
}

/** The first confirmed part of a greeting confirms the fan as greeted, once. */
function greetingConfirmation(
  snapshot: ClientFanClaimSnapshot,
  attempt: ClientCustodyRow,
  source: "preview-send" | "native-register" | "resolve",
  messageRef: string | null,
): ClientClaimWrite[] {
  if (attempt.purpose !== "greeting" || confirmedGreeting(snapshot)) return [];
  return [{
    op: "confirmGreeting", source, ownerUserId: attempt.userId, attemptId: attempt.attemptId, messageRef,
    group: { generationRef: attempt.generationRef, variant: attempt.variant, partCount: attempt.partCount },
  }];
}

export interface ClientClaimViewer {
  userId: number;
  instanceId: string | null;
  leaseToken: string | null;
  attemptId: string | null;
}

export interface ClientFanClaimView {
  greeting: { state: "none" | "confirmed"; at: Date | null; messageRef: string | null; source: ClientGreetingSource | null };
  lease: {
    state: "none" | "owned" | "held" | "expired" | "released";
    leaseToken: string | null;
    expiresAt: Date | null;
    heldBy: "you-elsewhere" | "someone-else" | null;
  };
  group: (ClientClaimGroup & { sentParts: number[]; heldParts: number[] }) | null;
  custody: { attemptId: string; state: ClientCustodyViewState; ticket: string | null; ticketExpiresAt: Date | null } | null;
  /** A desktop new-follower command that still holds the fan (not confirmed). */
  desktopOutreachHeld: boolean;
  serverNow: Date;
}

/** What one viewer may see. The lease holder is never named: only you-elsewhere or someone-else. */
export function deriveClientClaimView(snapshot: ClientFanClaimSnapshot, viewer: ClientClaimViewer): ClientFanClaimView {
  const { now } = snapshot;
  const greeting = confirmedGreeting(snapshot);
  const lease = ((): ClientFanClaimView["lease"] => {
    const active = snapshot.activeLease;
    if (isLive(active, now)) {
      const mine = active.userId === viewer.userId && active.instanceId === viewer.instanceId
        && (viewer.leaseToken === null || viewer.leaseToken === active.leaseId);
      return mine
        ? { state: "owned", leaseToken: active.leaseId, expiresAt: active.expiresAt, heldBy: null }
        : {
          state: "held", leaseToken: null, expiresAt: active.expiresAt,
          heldBy: active.userId === viewer.userId ? "you-elsewhere" : "someone-else",
        };
    }
    // Not live: only the viewer's own lease (its token, or its dead active row) is shown.
    const own = [snapshot.requestedLease, active].find((row): row is ClientLeaseRow => row !== null
      && isPartOf(row, snapshot) && row.userId === viewer.userId && row.instanceId === viewer.instanceId);
    if (!own) return { state: "none", leaseToken: null, expiresAt: null, heldBy: null };
    return { state: own.state === "active" ? "expired" : own.state, leaseToken: own.leaseId, expiresAt: own.expiresAt, heldBy: null };
  })();
  const attempt = snapshot.attempt && viewer.attemptId === snapshot.attempt.attemptId && isPartOf(snapshot.attempt, snapshot)
    ? snapshot.attempt : null;
  // The send the answer is about, else the fan's open send (anyone's: it holds the fan), else, for the
  // status read, the viewer's own last dispatched send: its final state is how a client that lost
  // track of it (a restart, a manual resolve) learns the outcome.
  const lastOwn = snapshot.lastOwnDispatch && snapshot.lastOwnDispatch.userId === viewer.userId
    && isPartOf(snapshot.lastOwnDispatch, snapshot) ? snapshot.lastOwnDispatch : null;
  const shown = attempt ?? snapshot.openCustody ?? lastOwn;
  const group = snapshot.group && {
    ...snapshot.group,
    sentParts: partIndexes(snapshot, (row) => partSent(snapshot, row)),
    // Held is what stops the row for a person: a send nobody can vouch for. A part still inside
    // its ticket is only in flight, and `custody` says so.
    heldParts: partIndexes(snapshot, (row) => row.state === "dispatching" && custodyViewState(row, now) === "uncertain-held"),
  };
  return {
    greeting: greeting
      ? { state: "confirmed", at: greeting.at, messageRef: greeting.messageRef, source: greeting.source }
      : { state: "none", at: null, messageRef: null, source: null },
    lease,
    group,
    custody: shown && {
      attemptId: shown.attemptId, state: custodyViewState(shown, now), ticket: null,
      ticketExpiresAt: shown.ticketExpiresAt,
    },
    desktopOutreachHeld: snapshot.desktop?.state === "held",
    serverNow: now,
  };
}

function partIndexes(snapshot: ClientFanClaimSnapshot, keep: (row: ClientCustodyRow) => boolean): number[] {
  const group = snapshot.group;
  if (!group) return [];
  return [...new Set(snapshot.groupParts.filter((row) => sameGroup(row, group) && keep(row)).map((row) => row.partIndex))]
    .sort((a, b) => a - b);
}

/**
 * The group the view reports: the request's, else its attempt's, the greeting's, the open send's,
 * the viewer's own last dispatched send's (the status read).
 */
export function viewGroup(input: {
  requestGroup: ClientClaimGroup | null;
  attempt: ClientCustodyRow | null;
  greeting: ClientGreetingRow | null;
  openCustody: ClientCustodyRow | null;
  lastOwnDispatch?: ClientCustodyRow | null;
}): ClientClaimGroup | null {
  if (input.requestGroup) return input.requestGroup;
  const fromRow = (row: ClientCustodyRow | null) =>
    row && { generationRef: row.generationRef, variant: row.variant, partCount: row.partCount };
  const greeting = input.greeting;
  return fromRow(input.attempt)
    ?? (greeting?.generationRef != null && greeting.variant != null && greeting.partCount != null
      ? { generationRef: greeting.generationRef, variant: greeting.variant, partCount: greeting.partCount }
      : null)
    ?? fromRow(input.openCustody)
    ?? fromRow(input.lastOwnDispatch ?? null);
}
