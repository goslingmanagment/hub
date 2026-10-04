import { readFile } from "node:fs/promises";

import { describe, expect, it } from "vitest";

import {
  CLIENT_FAN_LEASE_TTL_MS,
  CLIENT_PREVIEW_SEND_RATE_LIMIT,
  CLIENT_SEND_TICKET_TTL_MS,
  custodyViewState,
  decideClaimTransition,
  deriveClientClaimView,
  isAcceptedFailureEvidence,
  type ClientClaimGroup,
  type ClientClaimRequest,
  type ClientCustodyRow,
  type ClientFanClaimSnapshot,
  type ClientLeaseRow,
} from "@agency_hub_core/db";

// hub-pr-plan H-7a: the rules of the chat-extension greeting lease and send
// custody, without a database. The repository reads the snapshot under the
// fan's lock and applies exactly the writes decided here
// (tests/client-claim.integration.test.ts covers the SQL and the races).

const NOW = new Date("2026-10-03T12:00:00.000Z");
const later = (ms: number) => new Date(NOW.getTime() + ms);
const PAGE = 8;
const FAN = "518588958";
const ME = 11;
const OTHER = 12;
const I1 = "00000000-0000-4000-8000-000000000001";
const I2 = "00000000-0000-4000-8000-000000000002";
const L1 = "10000000-0000-4000-8000-000000000001";
const L2 = "10000000-0000-4000-8000-000000000002";
const A1 = "20000000-0000-4000-8000-000000000001";
const A2 = "20000000-0000-4000-8000-000000000002";
const GROUP: ClientClaimGroup = { generationRef: "gen-1", variant: 1, partCount: 3 };

const snapshot = (over: Partial<ClientFanClaimSnapshot> = {}): ClientFanClaimSnapshot => ({
  pageId: PAGE, fanRef: FAN, now: NOW, activeLease: null, requestedLease: null, greeting: null, desktop: null,
  openCustody: null, attempt: null, messageOwner: null, group: null, groupParts: [], recentPreviewSends: 0, ...over,
});
const lease = (over: Partial<ClientLeaseRow> = {}): ClientLeaseRow => ({
  leaseId: L1, pageId: PAGE, fanRef: FAN, userId: ME, instanceId: I1, state: "active", expiresAt: later(60_000), ...over,
});
const custody = (over: Partial<ClientCustodyRow> = {}): ClientCustodyRow => ({
  attemptId: A1, pageId: PAGE, fanRef: FAN, userId: ME, instanceId: I1, purpose: "greeting", origin: "preview-send",
  generationRef: GROUP.generationRef, variant: GROUP.variant, partCount: GROUP.partCount, partIndex: 0,
  requestHash: "h1", state: "dispatching", ticketExpiresAt: later(5_000), platformMessageId: null,
  failureReason: null, failureHttpStatus: null, ...over,
});
const actor = { pageId: PAGE, fanRef: FAN, userId: ME };
const dispatch = (over: Partial<Extract<ClientClaimRequest, { action: "dispatch" }>> = {}): ClientClaimRequest => ({
  ...actor, action: "dispatch", attemptId: A2, instanceId: I1, purpose: "greeting", group: GROUP, partIndex: 0,
  textRevision: 1, leaseToken: L1, flagRevision: 7, requestHash: "h2", ...over,
});
const ownedLease = { activeLease: lease(), requestedLease: lease() };

describe("lease: claim, renew, release", () => {
  it("claims a free fan for 120 s, and a repeat by the holder changes nothing", () => {
    expect(decideClaimTransition(snapshot(), { ...actor, action: "claim", leaseToken: L1, instanceId: I1 })).toEqual({
      outcome: "applied", writes: [{ op: "insertLease", leaseId: L1, instanceId: I1, expiresAt: later(CLIENT_FAN_LEASE_TTL_MS) }],
    });
    expect(decideClaimTransition(snapshot(ownedLease), { ...actor, action: "claim", leaseToken: L1, instanceId: I1 }))
      .toEqual({ outcome: "applied", writes: [] });
  });

  it("refuses a live lease of another person, instance or tab, and names nobody", () => {
    for (const held of [lease({ userId: OTHER }), lease({ instanceId: I2 }), lease({ leaseId: L2 })]) {
      const state = snapshot({ activeLease: held });
      expect(decideClaimTransition(state, { ...actor, action: "claim", leaseToken: L1, instanceId: I1 }))
        .toMatchObject({ outcome: "rejected", code: "claim_busy" });
      const view = deriveClientClaimView(state, { userId: ME, instanceId: I1, leaseToken: L1, attemptId: null });
      expect(view.lease).toEqual({
        state: "held", leaseToken: null, expiresAt: held.expiresAt,
        heldBy: held.userId === ME ? "you-elsewhere" : "someone-else",
      });
    }
  });

  it("expires a dead lease lazily on the next claim and grants the new one", () => {
    const dead = lease({ userId: OTHER, leaseId: L2, expiresAt: NOW });
    expect(decideClaimTransition(snapshot({ activeLease: dead }), { ...actor, action: "claim", leaseToken: L1, instanceId: I1 }).writes)
      .toEqual([
        { op: "expireLease", leaseId: L2 },
        { op: "insertLease", leaseId: L1, instanceId: I1, expiresAt: later(CLIENT_FAN_LEASE_TTL_MS) },
      ]);
  });

  it("gives no lease on a greeted fan to anyone but the greeting's owner", () => {
    const claim: ClientClaimRequest = { ...actor, action: "claim", leaseToken: L1, instanceId: I1 };
    const greeted = (ownerUserId: number | null) => ({
      ownerUserId, generationRef: GROUP.generationRef, variant: GROUP.variant, partCount: GROUP.partCount,
      confirmedAt: NOW, firstMessageRef: "901", source: "preview-send" as const,
    });
    // Someone else's greeting, one whose owner is gone, and the desktop's: no first greeting is left to work out.
    for (const state of [
      snapshot({ greeting: greeted(OTHER) }),
      snapshot({ greeting: greeted(null) }),
      snapshot({ desktop: { commandId: "c1", state: "confirmed", at: NOW, messageRef: "9001" } }),
      // Also for the holder of a lease taken before a colleague's native send confirmed the greeting.
      snapshot({ ...ownedLease, greeting: greeted(OTHER) }),
    ]) {
      expect(decideClaimTransition(state, claim)).toEqual({ outcome: "rejected", code: "greeting_done", writes: [] });
    }
    // The owner still holds the fan for the rest of the group; a desktop command that only may have greeted refuses no lease.
    expect(decideClaimTransition(snapshot({ greeting: greeted(ME) }), claim)).toMatchObject({ outcome: "applied" });
    expect(decideClaimTransition(snapshot({ desktop: { commandId: "c1", state: "held", at: NOW, messageRef: null } }), claim))
      .toMatchObject({ outcome: "applied" });
    // A lease that is already running is renewed and released as before.
    expect(decideClaimTransition(snapshot({ ...ownedLease, greeting: greeted(OTHER) }), { ...claim, action: "renew" }))
      .toMatchObject({ outcome: "applied" });
  });

  it("never revives a released or expired token", () => {
    const state = snapshot({ requestedLease: lease({ state: "released" }) });
    expect(decideClaimTransition(state, { ...actor, action: "claim", leaseToken: L1, instanceId: I1 }))
      .toMatchObject({ outcome: "rejected", code: "claim_expired" });
  });

  it("renews only its own live lease; a late renew is claim_expired and still expires the row", () => {
    expect(decideClaimTransition(snapshot(ownedLease), { ...actor, action: "renew", leaseToken: L1, instanceId: I1 }).writes)
      .toEqual([{ op: "renewLease", leaseId: L1, expiresAt: later(CLIENT_FAN_LEASE_TTL_MS) }]);
    const dead = lease({ expiresAt: later(-1) });
    expect(decideClaimTransition(snapshot({ activeLease: dead, requestedLease: dead }), {
      ...actor, action: "renew", leaseToken: L1, instanceId: I1,
    })).toEqual({ outcome: "rejected", code: "claim_expired", writes: [{ op: "expireLease", leaseId: L1 }] });
    expect(decideClaimTransition(snapshot(ownedLease), { ...actor, action: "renew", leaseToken: L1, instanceId: I2 }))
      .toMatchObject({ outcome: "rejected", code: "claim_busy" });
    expect(decideClaimTransition(snapshot(), { ...actor, action: "renew", leaseToken: L1, instanceId: I1 }))
      .toMatchObject({ outcome: "rejected", code: "claim_expired" });
    // A token of another fan's lease renews nothing here.
    expect(decideClaimTransition(snapshot({ requestedLease: lease({ fanRef: "77" }) }), {
      ...actor, action: "renew", leaseToken: L1, instanceId: I1,
    })).toMatchObject({ outcome: "rejected", code: "claim_expired" });
  });

  it("releases idempotently", () => {
    expect(decideClaimTransition(snapshot(ownedLease), { ...actor, action: "release", leaseToken: L1, instanceId: I1 }).writes)
      .toEqual([{ op: "releaseLease", leaseId: L1 }]);
    expect(decideClaimTransition(snapshot({ requestedLease: lease({ state: "released" }) }), {
      ...actor, action: "release", leaseToken: L1, instanceId: I1,
    })).toEqual({ outcome: "applied", writes: [] });
  });

  it("shows a dead lease as expired to its holder only", () => {
    const state = snapshot({ activeLease: lease({ expiresAt: NOW }) });
    expect(deriveClientClaimView(state, { userId: ME, instanceId: I1, leaseToken: null, attemptId: null }).lease.state).toBe("expired");
    expect(deriveClientClaimView(state, { userId: OTHER, instanceId: I2, leaseToken: null, attemptId: null }).lease.state).toBe("none");
  });
});

describe("dispatch, in the plan's order", () => {
  it("issues a 10 s ticket against the owned lease", () => {
    expect(decideClaimTransition(snapshot(ownedLease), dispatch())).toEqual({
      outcome: "applied",
      writes: [{
        op: "insertDispatch", attemptId: A2, instanceId: I1, purpose: "greeting", group: GROUP, partIndex: 0,
        textRevision: 1, requestHash: "h2", leaseId: L1, flagRevision: 7, ticketExpiresAt: later(CLIENT_SEND_TICKET_TTL_MS),
      }],
    });
  });

  it("only reads on a repeat of the same body; another body is an attempt conflict", () => {
    const attempt = custody({ attemptId: A2, requestHash: "h2" });
    // Even with everything else now refusing, a repeat reads.
    const busy = { ...ownedLease, attempt, openCustody: attempt, recentPreviewSends: 99 };
    expect(decideClaimTransition(snapshot(busy), dispatch())).toEqual({ outcome: "applied", writes: [] });
    expect(decideClaimTransition(snapshot(busy), dispatch({ textRevision: 2, requestHash: "h3" })))
      .toMatchObject({ outcome: "rejected", code: "attempt_conflict" });
  });

  it("limits a user to six preview sends a minute", () => {
    const at = (n: number) => decideClaimTransition(snapshot({ ...ownedLease, recentPreviewSends: n }), dispatch());
    expect(at(CLIENT_PREVIEW_SEND_RATE_LIMIT - 1).outcome).toBe("applied");
    expect(at(CLIENT_PREVIEW_SEND_RATE_LIMIT)).toMatchObject({ outcome: "rejected", code: "preview_send_rate_limited" });
  });

  it("holds the fan for anyone's unresolved send, ticket expired or not", () => {
    for (const open of [custody({ userId: OTHER }), custody({ ticketExpiresAt: later(-1) }), custody({ purpose: "preview-reply" })]) {
      expect(decideClaimTransition(snapshot({ ...ownedLease, openCustody: open }), dispatch()))
        .toMatchObject({ outcome: "rejected", code: "custody_held" });
      expect(decideClaimTransition(snapshot({ ...ownedLease, openCustody: open }), dispatch({ purpose: "preview-reply" })))
        .toMatchObject({ outcome: "rejected", code: "custody_held" });
    }
  });

  it("treats a desktop greeting the outbox confirmed as done and an unresolved one as held (critic 1)", () => {
    const confirmed = snapshot({ ...ownedLease, desktop: { commandId: "c", state: "confirmed", at: later(-60_000), messageRef: "901" } });
    expect(decideClaimTransition(confirmed, dispatch())).toMatchObject({ outcome: "rejected", code: "greeting_done" });
    expect(deriveClientClaimView(confirmed, { userId: ME, instanceId: I1, leaseToken: L1, attemptId: null }).greeting).toEqual({
      state: "confirmed", at: later(-60_000), messageRef: "901", source: "desktop-outbox",
    });
    const held = snapshot({ ...ownedLease, desktop: { commandId: "c", state: "held", at: NOW, messageRef: null } });
    expect(decideClaimTransition(held, dispatch())).toMatchObject({ outcome: "rejected", code: "custody_held" });
    expect(deriveClientClaimView(held, { userId: ME, instanceId: I1, leaseToken: L1, attemptId: null }))
      .toMatchObject({ greeting: { state: "none" }, desktopOutreachHeld: true });
    // A reply to a fan the desktop greeted is not a greeting.
    expect(decideClaimTransition(confirmed, dispatch({ purpose: "preview-reply" })).outcome).toBe("applied");
  });

  it("after confirmation lets only its owner send the rest of the same group, without a lease", () => {
    const greeting = {
      ownerUserId: ME, generationRef: GROUP.generationRef, variant: GROUP.variant, partCount: GROUP.partCount,
      confirmedAt: NOW, firstMessageRef: "901", source: "preview-send" as const,
    };
    const sentPart = custody({ state: "sent", platformMessageId: "901" });
    const state = snapshot({ greeting, group: GROUP, groupParts: [sentPart] });
    expect(decideClaimTransition(state, dispatch({ partIndex: 1, leaseToken: null }))).toMatchObject({
      outcome: "applied", writes: [{ op: "insertDispatch", leaseId: null, partIndex: 1 }],
    });
    expect(decideClaimTransition(state, dispatch({ partIndex: 0, leaseToken: null })))
      .toMatchObject({ outcome: "rejected", code: "part_already_sent" });
    expect(decideClaimTransition(state, dispatch({ partIndex: 1, group: { ...GROUP, generationRef: "gen-2" } })))
      .toMatchObject({ outcome: "rejected", code: "generation_mismatch" });
    expect(decideClaimTransition(state, dispatch({ partIndex: 1, group: { ...GROUP, variant: 0 } })))
      .toMatchObject({ outcome: "rejected", code: "generation_mismatch" });
    expect(decideClaimTransition(state, { ...dispatch({ partIndex: 1 }), userId: OTHER }))
      .toMatchObject({ outcome: "rejected", code: "greeting_done" });
  });

  it("needs the live lease of this user, instance and token before confirmation", () => {
    expect(decideClaimTransition(snapshot(), dispatch())).toMatchObject({ code: "claim_expired" });
    expect(decideClaimTransition(snapshot(), dispatch({ leaseToken: null }))).toMatchObject({ code: "claim_expired" });
    expect(decideClaimTransition(snapshot({ activeLease: lease({ expiresAt: NOW }) }), dispatch()))
      .toMatchObject({ code: "claim_expired" });
    expect(decideClaimTransition(snapshot({ activeLease: lease({ userId: OTHER }) }), dispatch())).toMatchObject({ code: "claim_busy" });
    expect(decideClaimTransition(snapshot({ activeLease: lease({ instanceId: I2 }) }), dispatch())).toMatchObject({ code: "claim_busy" });
    expect(decideClaimTransition(snapshot(ownedLease), dispatch({ leaseToken: L2 }))).toMatchObject({ code: "claim_busy" });
    // A preview reply needs no lease.
    expect(decideClaimTransition(snapshot(), dispatch({ purpose: "preview-reply", leaseToken: null })).outcome).toBe("applied");
  });

  it("refuses a part index outside its group", () => {
    expect(decideClaimTransition(snapshot(ownedLease), dispatch({ partIndex: 3 }))).toMatchObject({ code: "invalid_request" });
  });
});

describe("sent and failed: only the dispatching user and instance (critic 12)", () => {
  const sent = (over: Partial<Extract<ClientClaimRequest, { action: "sent" }>> = {}): ClientClaimRequest => ({
    ...actor, action: "sent", attemptId: A1, instanceId: I1, platformMessageId: "901", ...over,
  });
  const failed = (reason: "not_enqueued" | "native_rejected", httpStatus: number | null, instanceId = I1): ClientClaimRequest => ({
    ...actor, action: "failed", attemptId: A1, instanceId, reason, httpStatus,
  });

  it("confirms the greeting with its first sent part, also after the ticket ran out", () => {
    for (const attempt of [custody(), custody({ ticketExpiresAt: later(-60_000) })]) {
      expect(decideClaimTransition(snapshot({ attempt, openCustody: attempt }), sent()).writes).toEqual([
        { op: "markSent", attemptId: A1, platformMessageId: "901" },
        { op: "confirmGreeting", source: "preview-send", ownerUserId: ME, attemptId: A1, messageRef: "901", group: GROUP },
      ]);
    }
    const reply = custody({ purpose: "preview-reply" });
    expect(decideClaimTransition(snapshot({ attempt: reply }), sent()).writes).toEqual([
      { op: "markSent", attemptId: A1, platformMessageId: "901" },
    ]);
  });

  it("refuses another user's or another instance's report", () => {
    expect(decideClaimTransition(snapshot({ attempt: custody() }), { ...sent(), userId: OTHER })).toMatchObject({ code: "custody_not_owned" });
    expect(decideClaimTransition(snapshot({ attempt: custody() }), sent({ instanceId: I2 }))).toMatchObject({ code: "custody_not_owned" });
    expect(decideClaimTransition(snapshot({ attempt: custody() }), failed("not_enqueued", null, I2))).toMatchObject({ code: "custody_not_owned" });
    expect(decideClaimTransition(snapshot({ attempt: custody({ fanRef: "77" }) }), sent())).toMatchObject({ code: "custody_not_owned" });
    expect(decideClaimTransition(snapshot(), sent())).toMatchObject({ code: "custody_not_owned" });
  });

  it("is idempotent on the same message and refuses a different one", () => {
    const done = custody({ state: "sent", platformMessageId: "901" });
    expect(decideClaimTransition(snapshot({ attempt: done }), sent())).toEqual({ outcome: "applied", writes: [] });
    expect(decideClaimTransition(snapshot({ attempt: done }), sent({ platformMessageId: "902" }))).toMatchObject({ code: "attempt_conflict" });
    const taken = custody({ attemptId: A2, state: "sent", origin: "native-register", platformMessageId: "901" });
    expect(decideClaimTransition(snapshot({ attempt: custody(), messageOwner: taken }), sent())).toMatchObject({ code: "attempt_conflict" });
  });

  it("accepts failure only with evidence the native queue never took it", () => {
    for (const status of [400, 403, 404, 422, 429, 499]) expect(isAcceptedFailureEvidence("native_rejected", status)).toBe(true);
    for (const status of [null, 401, 399, 500, 503, 302]) expect(isAcceptedFailureEvidence("native_rejected", status)).toBe(false);
    expect(isAcceptedFailureEvidence("not_enqueued", null)).toBe(true);
    expect(isAcceptedFailureEvidence("not_enqueued", 400)).toBe(false);
    expect(decideClaimTransition(snapshot({ attempt: custody() }), failed("native_rejected", 401))).toMatchObject({ code: "invalid_request" });
    expect(decideClaimTransition(snapshot({ attempt: custody() }), failed("native_rejected", 403)).writes).toEqual([
      { op: "markFailed", attemptId: A1, reason: "native_rejected", httpStatus: 403 },
    ]);
    expect(decideClaimTransition(snapshot({ attempt: custody({ state: "sent", platformMessageId: "901" }) }), failed("not_enqueued", null)))
      .toMatchObject({ code: "attempt_conflict" });
    const failedRow = custody({ state: "failed", failureReason: "not_enqueued" });
    expect(decideClaimTransition(snapshot({ attempt: failedRow }), failed("not_enqueued", null))).toEqual({ outcome: "applied", writes: [] });
  });

  it("takes a failure only inside the ticket: uncertain-held never becomes failed", () => {
    // The client's frozen CUSTODY_TRANSITIONS: past the ticket only `sent` or a resolve ends the send.
    for (const ticketExpiresAt of [NOW, later(-1), later(-60_000)]) {
      const uncertain = custody({ ticketExpiresAt });
      for (const report of [failed("not_enqueued", null), failed("native_rejected", 403)]) {
        expect(decideClaimTransition(snapshot({ attempt: uncertain, openCustody: uncertain }), report))
          .toEqual({ outcome: "rejected", code: "custody_held", writes: [] });
      }
      // Who may report is decided first: a stranger learns nothing about the send's state.
      expect(decideClaimTransition(snapshot({ attempt: uncertain }), failed("not_enqueued", null, I2)))
        .toMatchObject({ code: "custody_not_owned" });
    }
    expect(decideClaimTransition(snapshot({ attempt: custody({ ticketExpiresAt: later(1) }) }), failed("not_enqueued", null)).writes)
      .toEqual([{ op: "markFailed", attemptId: A1, reason: "not_enqueued", httpStatus: null }]);
    // A failure the hub took in time is repeated freely afterwards.
    const failedRow = custody({ state: "failed", failureReason: "not_enqueued", ticketExpiresAt: later(-60_000) });
    expect(decideClaimTransition(snapshot({ attempt: failedRow }), failed("not_enqueued", null))).toEqual({ outcome: "applied", writes: [] });
  });
});

describe("registerNativeSend and resolve", () => {
  const register = (over: Partial<Extract<ClientClaimRequest, { action: "registerNativeSend" }>> = {}): ClientClaimRequest => ({
    ...actor, action: "registerNativeSend", attemptId: A2, instanceId: I1, purpose: "greeting", group: GROUP,
    partIndex: 0, platformMessageId: "905", requestHash: "r1", ...over,
  });

  it("records a proven native send and confirms the greeting, never touching another's custody", () => {
    expect(decideClaimTransition(snapshot(), register()).writes).toEqual([
      {
        op: "insertNativeSend", attemptId: A2, instanceId: I1, purpose: "greeting", group: GROUP, partIndex: 0,
        platformMessageId: "905", requestHash: "r1",
      },
      { op: "confirmGreeting", source: "native-register", ownerUserId: ME, attemptId: A2, messageRef: "905", group: GROUP },
    ]);
    // Another user's send to this fan stays held: the registration only adds its own row.
    const foreign = custody({ userId: OTHER, generationRef: "gen-9", purpose: "preview-reply" });
    const writes = decideClaimTransition(snapshot({ openCustody: foreign }), register()).writes;
    expect(writes.map((write) => write.op)).toEqual(["insertNativeSend", "confirmGreeting"]);
    expect(decideClaimTransition(snapshot({ group: GROUP, groupParts: [custody({ userId: OTHER })] }), register()))
      .toMatchObject({ code: "custody_held" });
    expect(decideClaimTransition(snapshot({ group: GROUP, groupParts: [custody({ state: "sent", platformMessageId: "1" })] }), register()))
      .toMatchObject({ code: "part_already_sent" });
  });

  it("is idempotent per page and message, only for a record of the same part", () => {
    const recorded = custody({ attemptId: A1, origin: "native-register", state: "sent", platformMessageId: "905" });
    expect(decideClaimTransition(snapshot({ messageOwner: recorded }), register())).toEqual({ outcome: "applied", writes: [] });
    const resolvedSent = custody({ state: "resolved_sent", platformMessageId: "905" });
    expect(decideClaimTransition(snapshot({ messageOwner: resolvedSent }), register())).toEqual({ outcome: "applied", writes: [] });
    // Any other owner of the id contradicts the proof: ok would drop the send unrecorded.
    for (const owner of [
      { ...recorded, fanRef: "77" }, { ...recorded, partIndex: 1 }, { ...recorded, generationRef: "gen-9" },
      { ...recorded, variant: 2 }, { ...recorded, purpose: "preview-reply" as const },
      { ...recorded, state: "resolved_not_sent" as const }, { ...recorded, state: "failed" as const },
    ]) {
      expect(decideClaimTransition(snapshot({ messageOwner: owner }), register())).toEqual({
        outcome: "rejected", code: "attempt_conflict", writes: [],
      });
    }
  });

  it("does not record a second greeting over a desktop one", () => {
    const desktop = { commandId: "c", state: "confirmed" as const, at: NOW, messageRef: "1" };
    expect(decideClaimTransition(snapshot({ desktop }), register()).writes.map((write) => write.op)).toEqual(["insertNativeSend"]);
  });

  it("resolves only a held send, once, and a sent greeting confirms the fan", () => {
    const resolve = (outcome: "sent" | "not_sent", platformMessageId: string | null = null): ClientClaimRequest => ({
      ...actor, userId: 1, action: "resolve", attemptId: A1, outcome, platformMessageId, note: "checked the chat",
    });
    const uncertain = custody({ ticketExpiresAt: later(-1) });
    expect(decideClaimTransition(snapshot({ attempt: uncertain }), resolve("not_sent")).writes).toEqual([{
      op: "resolve", attemptId: A1, outcome: "not_sent", platformMessageId: null, note: "checked the chat", priorState: "uncertain-held",
    }]);
    expect(decideClaimTransition(snapshot({ attempt: custody() }), resolve("sent", "906")).writes).toEqual([
      { op: "resolve", attemptId: A1, outcome: "sent", platformMessageId: "906", note: "checked the chat", priorState: "dispatching" },
      { op: "confirmGreeting", source: "resolve", ownerUserId: ME, attemptId: A1, messageRef: "906", group: GROUP },
    ]);
    expect(decideClaimTransition(snapshot({ attempt: custody({ state: "sent", platformMessageId: "1" }) }), resolve("not_sent")))
      .toMatchObject({ code: "custody_not_held" });
    const resolved = custody({ state: "resolved_not_sent" });
    expect(decideClaimTransition(snapshot({ attempt: resolved }), resolve("not_sent"))).toEqual({ outcome: "applied", writes: [] });
    expect(decideClaimTransition(snapshot({ attempt: resolved }), resolve("sent"))).toMatchObject({ code: "attempt_conflict" });
    expect(decideClaimTransition(snapshot(), resolve("sent"))).toMatchObject({ code: "not_found" });
  });

  it("refuses a not-sent resolve that carries a message id: it would take the real send's id slot", () => {
    const resolve: ClientClaimRequest = {
      ...actor, userId: 1, action: "resolve", attemptId: A1, outcome: "not_sent", platformMessageId: "906", note: "checked",
    };
    for (const attempt of [custody(), custody({ ticketExpiresAt: later(-1) }), custody({ state: "resolved_not_sent" })]) {
      expect(decideClaimTransition(snapshot({ attempt }), resolve)).toEqual({ outcome: "rejected", code: "invalid_request", writes: [] });
    }
  });
});

describe("the view", () => {
  it("derives custody states; time alone never releases a dispatch", () => {
    expect(custodyViewState({ state: "dispatching", ticketExpiresAt: later(1) }, NOW)).toBe("dispatching");
    expect(custodyViewState({ state: "dispatching", ticketExpiresAt: NOW }, NOW)).toBe("uncertain-held");
    expect(custodyViewState({ state: "resolved_sent", ticketExpiresAt: null }, NOW)).toBe("resolved-sent");
    expect(custodyViewState({ state: "resolved_not_sent", ticketExpiresAt: null }, NOW)).toBe("resolved-not-sent");
    expect(custodyViewState({ state: "failed", ticketExpiresAt: NOW }, NOW)).toBe("failed");
  });

  it("reports the group's sent and held parts and the fan's open send", () => {
    const parts = [custody({ state: "sent", partIndex: 2, platformMessageId: "1" }), custody({ partIndex: 1, ticketExpiresAt: NOW })];
    const view = deriveClientClaimView(snapshot({ group: GROUP, groupParts: parts, openCustody: parts[1]! }), {
      userId: OTHER, instanceId: I2, leaseToken: null, attemptId: null,
    });
    expect(view.group).toEqual({ ...GROUP, sentParts: [2], heldParts: [1] });
    expect(view.custody).toEqual({ attemptId: A1, state: "uncertain-held", ticket: null, ticketExpiresAt: NOW });
  });
});

describe("the status read's own last dispatch", () => {
  const reader = { userId: ME, instanceId: null, leaseToken: null, attemptId: null };

  it("reports the reader's own last dispatched send while nothing is open, in the state it ended", () => {
    for (const [state, viewState] of [
      ["resolved_not_sent", "resolved-not-sent"], ["resolved_sent", "resolved-sent"], ["sent", "sent"], ["failed", "failed"],
    ] as const) {
      const last = custody({ state, ticketExpiresAt: later(-60_000) });
      const view = deriveClientClaimView(snapshot({ lastOwnDispatch: last }), reader);
      expect(view.custody, state).toEqual({ attemptId: A1, state: viewState, ticket: null, ticketExpiresAt: last.ticketExpiresAt });
    }
  });

  it("puts the fan's open send first, and never shows another person's finished send", () => {
    const open = custody({ attemptId: A2, userId: OTHER, instanceId: I2 });
    const last = custody({ state: "resolved_not_sent" });
    expect(deriveClientClaimView(snapshot({ openCustody: open, lastOwnDispatch: last }), reader).custody)
      .toMatchObject({ attemptId: A2, state: "dispatching" });
    // The repository loads the reader's own row; the view does not trust it to.
    expect(deriveClientClaimView(snapshot({ lastOwnDispatch: last }), { ...reader, userId: OTHER }).custody).toBeNull();
    expect(deriveClientClaimView(snapshot({ lastOwnDispatch: custody({ state: "sent", fanRef: "77" }) }), reader).custody).toBeNull();
    // An action's answer never loads it.
    expect(deriveClientClaimView(snapshot(), reader).custody).toBeNull();
  });
});

describe("migration 0241", () => {
  it("is additive and listed as rollback-compatible", async () => {
    const migration = await readFile("packages/db/migrations/0241_client_claim_tables.sql", "utf8");
    expect(migration).not.toMatch(/\b(alter|drop|truncate|delete|update)\b/i);
    for (const table of ["client_fan_leases", "client_greetings", "client_send_custody"]) {
      expect(migration).toContain(`create table if not exists ${table} (`);
    }
    const deploy = await readFile("scripts/deploy-production.sh", "utf8");
    expect(deploy.match(/ROLLBACK_COMPATIBLE_MIGRATIONS=\([\s\S]*?\n\)/)?.[0]).toContain('"0241_client_claim_tables.sql"');
  });
});
