import { describe, expect, it } from "vitest";

import {
  activeFanslyPageHold,
  admitUnderFanslyPageHolds,
  CARRIED_TIMED_HOLD_FIELD,
  combineFanslyPageHold,
  credentialsFailureDetail,
  fanslyPageHoldAfterCredentials,
  fanslyPageHoldInForce,
  fanslyTimedHoldEnd,
  INDEFINITE_UNTIL,
  proofClearsCredentialsHold,
  readFanslyPageHolds,
  verifyAdmittedUnderCredentialsHold,
  type FanslyPageHoldColumns,
  type FanslyPageHoldWrite,
} from "@agency_hub_core/shared";

import { onOutcome, type OutcomeInput, type PageErrorState } from "../apps/runtime/src/sync/engine/errors.ts";

// The shared page-hold core (step 3b ruling 5, A3): one rule for what a page
// hold is, what it admits, what clears a credentials hold and how two holds
// share the row — read by the actor, the final admission, the rollback's
// hand-back, status/why and the alerts.

const NOW = new Date("2026-10-03T12:00:00.000Z");
const MIN = 60_000;
const at = (ms: number) => new Date(NOW.getTime() + ms);

function columns(overrides: Partial<FanslyPageHoldColumns> = {}): FanslyPageHoldColumns {
  return { holdKind: null, holdUntil: null, holdSince: null, holdDetail: {}, ...overrides };
}

function authHeld(failure: { attemptId: number | null; at: Date | null; digest: string | null }, extra: Record<string, unknown> = {}) {
  return columns({
    holdKind: "auth",
    holdUntil: INDEFINITE_UNTIL,
    holdSince: at(-10 * MIN),
    holdDetail: credentialsFailureDetail(failure, { status: 401, ...extra }),
  });
}

const carried = (kind: "rate_limit" | "network", untilMs: number, detail: Record<string, unknown> = {}) => ({
  [CARRIED_TIMED_HOLD_FIELD]: { kind, until: at(untilMs).toISOString(), detail },
});

describe("page holds: what the row records", () => {
  it("no hold, a timed hold of its own, a credentials hold with its latest refusal", () => {
    expect(readFanslyPageHolds(columns())).toEqual({ credentials: null, timed: null });
    expect(readFanslyPageHolds(columns({ holdKind: "network", holdUntil: at(MIN), holdSince: at(-MIN), holdDetail: { streak: 3 } })))
      .toEqual({ credentials: null, timed: { kind: "network", until: at(MIN), since: at(-MIN), detail: { streak: 3 }, carried: false } });
    expect(readFanslyPageHolds(authHeld({ attemptId: 42, at: at(-MIN), digest: "gen-b" }))).toEqual({
      credentials: { kind: "auth", since: at(-10 * MIN), until: INDEFINITE_UNTIL, failure: { attemptId: 42, at: at(-MIN), digest: "gen-b" } },
      timed: null,
    });
  });

  it("a refusal written before refusals carried their attempt (or imported) has none; malformed fields read as unknown", () => {
    const legacy = columns({ holdKind: "auth", holdUntil: INDEFINITE_UNTIL, holdSince: at(-MIN), holdDetail: { credentialsGeneration: "gen-a" } });
    expect(readFanslyPageHolds(legacy).credentials?.failure).toEqual({ attemptId: null, at: null, digest: "gen-a" });
    const odd = columns({
      holdKind: "identity_mismatch",
      holdUntil: INDEFINITE_UNTIL,
      holdDetail: { failedAttemptId: -3, failedAt: "yesterday", credentialsGeneration: "" },
    });
    expect(readFanslyPageHolds(odd).credentials?.failure).toEqual({ attemptId: null, at: null, digest: null });
    // A bigint id serialised as text is read as the number it is.
    const text = columns({ holdKind: "auth", holdUntil: INDEFINITE_UNTIL, holdDetail: { failedAttemptId: "77" } });
    expect(readFanslyPageHolds(text).credentials?.failure.attemptId).toBe(77);
  });

  it("a hold whose end is not an instant holds indefinitely (fail closed)", () => {
    const unreadable = columns({ holdKind: "auth", holdUntil: new Date("infinity"), holdDetail: {} });
    expect(activeFanslyPageHold(unreadable, NOW)).toMatchObject({ kind: "auth", until: INDEFINITE_UNTIL });
  });

  it("a timed hold a credentials hold carries is read beside it, dated by its own detail; a malformed one is none", () => {
    const held = authHeld({ attemptId: 1, at: at(-MIN), digest: "gen-a" }, carried("rate_limit", 90_000, { lastRateLimitAt: at(-5_000).toISOString() }));
    expect(readFanslyPageHolds(held).timed).toEqual({
      kind: "rate_limit",
      until: at(90_000),
      since: at(-5_000),
      detail: { lastRateLimitAt: at(-5_000).toISOString() },
      carried: true,
    });
    const broken = authHeld({ attemptId: 1, at: null, digest: null }, { [CARRIED_TIMED_HOLD_FIELD]: { kind: "auth", until: "soon" } });
    expect(readFanslyPageHolds(broken).timed).toBeNull();
  });
});

describe("page holds: in force", () => {
  it("a credentials hold is in force until a proof clears it; the carried timed hold until its end", () => {
    const held = authHeld({ attemptId: 1, at: at(-MIN), digest: "gen-a" }, carried("network", 30_000));
    expect(activeFanslyPageHold(held, NOW)).toMatchObject({ kind: "auth", until: INDEFINITE_UNTIL, timed: { kind: "network", until: at(30_000) } });
    expect(activeFanslyPageHold(held, at(30_000))).toMatchObject({ kind: "auth", until: INDEFINITE_UNTIL, timed: null });
  });

  it("a timed hold of its own until its end, then nothing", () => {
    const held = columns({ holdKind: "rate_limit", holdUntil: at(MIN), holdSince: NOW, holdDetail: { status: 429 } });
    expect(activeFanslyPageHold(held, NOW)).toMatchObject({ kind: "rate_limit", until: at(MIN), credentials: null });
    expect(activeFanslyPageHold(held, at(MIN))).toBeNull();
    expect(fanslyTimedHoldEnd(readFanslyPageHolds(held), NOW)).toEqual(at(MIN));
    expect(fanslyTimedHoldEnd(readFanslyPageHolds(held), at(MIN))).toBeNull();
  });

  it("the rollback floor of a page hold is the timed hold's end — the carried one too — never a credentials hold's", () => {
    const held = authHeld({ attemptId: 1, at: null, digest: null }, carried("rate_limit", 45_000));
    expect(fanslyTimedHoldEnd(readFanslyPageHolds(held), NOW)).toEqual(at(45_000));
    expect(fanslyTimedHoldEnd(readFanslyPageHolds(authHeld({ attemptId: 1, at: null, digest: null })), NOW)).toBeNull();
  });
});

describe("page holds: admission (A3)", () => {
  const held = readFanslyPageHolds(authHeld({ attemptId: 10, at: at(-MIN), digest: "gen-b" }));

  it("without a hold everything is admitted", () => {
    expect(admitUnderFanslyPageHolds(readFanslyPageHolds(columns()), { kind: "request" }, NOW)).toEqual({ admitted: true, exception: null });
  });

  it("under a credentials hold: a candidate check, and the verify of a digest other than the latest refusal's", () => {
    expect(admitUnderFanslyPageHolds(held, { kind: "request" }, NOW))
      .toEqual({ admitted: false, scope: "credentials", kind: "auth", until: INDEFINITE_UNTIL });
    expect(admitUnderFanslyPageHolds(held, { kind: "candidate_check" }, NOW)).toEqual({ admitted: true, exception: "candidate_check" });
    expect(admitUnderFanslyPageHolds(held, { kind: "verify", digest: "gen-b" }, NOW)).toMatchObject({ admitted: false, scope: "credentials" });
    expect(admitUnderFanslyPageHolds(held, { kind: "verify", digest: null }, NOW)).toMatchObject({ admitted: false });
    expect(admitUnderFanslyPageHolds(held, { kind: "verify", digest: "gen-c" }, NOW)).toEqual({ admitted: true, exception: "verify" });
  });

  it("a refusal of unknown credentials admits the verify of any known digest", () => {
    const unknown = readFanslyPageHolds(authHeld({ attemptId: null, at: null, digest: null })).credentials!;
    expect(verifyAdmittedUnderCredentialsHold(unknown, "gen-a")).toBe(true);
    expect(verifyAdmittedUnderCredentialsHold(unknown, null)).toBe(false);
  });

  it("a timed hold in force admits nothing — not a candidate check, not a verify — also beside a credentials hold", () => {
    const both = readFanslyPageHolds(authHeld({ attemptId: 10, at: null, digest: "gen-b" }, carried("rate_limit", 20_000)));
    for (const operation of [{ kind: "request" }, { kind: "candidate_check" }, { kind: "verify", digest: "gen-c" }] as const) {
      expect(admitUnderFanslyPageHolds(both, operation, NOW)).toEqual({ admitted: false, scope: "timed", kind: "rate_limit", until: at(20_000) });
    }
    expect(admitUnderFanslyPageHolds(both, { kind: "verify", digest: "gen-c" }, at(20_000))).toEqual({ admitted: true, exception: "verify" });
  });
});

describe("page holds: what clears a credentials hold (ruling 5)", () => {
  it("only a proof sent after the LATEST refusal, by attempt order", () => {
    const hold = readFanslyPageHolds(authHeld({ attemptId: 10, at: at(-MIN), digest: "gen-b" })).credentials!;
    expect(proofClearsCredentialsHold(hold, { attemptId: 11, sentAt: at(-30_000) })).toBe(true);
    // Sent before the refusal (its apply came late): never.
    expect(proofClearsCredentialsHold(hold, { attemptId: 9, sentAt: at(-2 * MIN) })).toBe(false);
    expect(proofClearsCredentialsHold(hold, { attemptId: 10, sentAt: at(-MIN) })).toBe(false);
  });

  it("a refusal without an attempt: by the send instant against the later of the refusal and the episode start", () => {
    const imported = readFanslyPageHolds(authHeld({ attemptId: null, at: null, digest: "gen-b" })).credentials!;
    expect(proofClearsCredentialsHold(imported, { attemptId: 1, sentAt: at(-10 * MIN) })).toBe(false);
    expect(proofClearsCredentialsHold(imported, { attemptId: 1, sentAt: at(-10 * MIN + 1) })).toBe(true);
    const dated = readFanslyPageHolds(authHeld({ attemptId: null, at: at(-MIN), digest: "gen-b" })).credentials!;
    expect(proofClearsCredentialsHold(dated, { attemptId: 1, sentAt: at(-2 * MIN) })).toBe(false);
    expect(proofClearsCredentialsHold(dated, { attemptId: 1, sentAt: at(-MIN + 1) })).toBe(true);
    const undated = { ...dated, since: null, failure: { ...dated.failure, at: null } };
    expect(proofClearsCredentialsHold(undated, { attemptId: 1, sentAt: NOW })).toBe(false);
  });

  it("clearing leaves the timed hold it carried while that is in force", () => {
    const held = authHeld({ attemptId: 1, at: null, digest: null }, carried("rate_limit", 30_000, { status: 429 }));
    expect(fanslyPageHoldAfterCredentials(held, NOW)).toEqual({ kind: "rate_limit", until: at(30_000), detail: { status: 429 } });
    expect(fanslyPageHoldAfterCredentials(held, at(30_000))).toBeNull();
    expect(fanslyPageHoldAfterCredentials(authHeld({ attemptId: 1, at: null, digest: null }), NOW)).toBeNull();
  });
});

describe("page holds: two holds in one slot", () => {
  const auth: FanslyPageHoldWrite = { kind: "auth", until: "infinity", detail: { credentialsGeneration: "gen-1" } };

  it("a credentials hold taken over a timed hold in force carries it; over one that ended it does not", () => {
    const rateLimited = columns({ holdKind: "rate_limit", holdUntil: at(5 * MIN), holdDetail: { status: 429 } });
    const combined = combineFanslyPageHold(rateLimited, auth, NOW);
    expect(combined).toEqual({
      ...auth,
      detail: { credentialsGeneration: "gen-1", [CARRIED_TIMED_HOLD_FIELD]: { kind: "rate_limit", until: at(5 * MIN).toISOString(), detail: { status: 429 } } },
    });
    expect(combineFanslyPageHold(rateLimited, auth, at(5 * MIN))).toEqual(auth);
    // A refusal over a credentials hold keeps the carried timed hold.
    const written = columns({ holdKind: "auth", holdUntil: INDEFINITE_UNTIL, holdDetail: combined.detail });
    expect(combineFanslyPageHold(written, auth, NOW).detail[CARRIED_TIMED_HOLD_FIELD]).toEqual(combined.detail[CARRIED_TIMED_HOLD_FIELD]);
  });

  it("a timed hold under a credentials hold rides beside it, keeping the later end; the refusal it names stays", () => {
    const held = authHeld({ attemptId: 4, at: at(-MIN), digest: "gen-b" }, carried("network", 10 * MIN, { streak: 3 }));
    const later = combineFanslyPageHold(held, { kind: "rate_limit", until: at(20 * MIN), detail: { status: 429 } }, NOW);
    expect(later).toMatchObject({
      kind: "auth",
      until: "infinity",
      detail: { failedAttemptId: 4, credentialsGeneration: "gen-b", [CARRIED_TIMED_HOLD_FIELD]: { kind: "rate_limit", until: at(20 * MIN).toISOString() } },
    });
    const earlier = combineFanslyPageHold(held, { kind: "rate_limit", until: at(2 * MIN), detail: { status: 429 } }, NOW);
    expect(earlier.detail[CARRIED_TIMED_HOLD_FIELD]).toEqual({ kind: "network", until: at(10 * MIN).toISOString(), detail: { streak: 3 } });
  });

  it("a timed hold over another one in force keeps the later end; over nothing it is the page's own", () => {
    const network = columns({ holdKind: "network", holdUntil: at(10 * MIN), holdDetail: { streak: 3 } });
    const rateLimit: FanslyPageHoldWrite = { kind: "rate_limit", until: at(2 * MIN), detail: { status: 429 } };
    expect(combineFanslyPageHold(network, rateLimit, NOW)).toEqual({ kind: "network", until: at(10 * MIN), detail: { streak: 3 } });
    expect(combineFanslyPageHold(network, { ...rateLimit, until: at(20 * MIN) }, NOW)).toEqual({ ...rateLimit, until: at(20 * MIN) });
    expect(combineFanslyPageHold(columns(), rateLimit, NOW)).toEqual(rateLimit);
  });
});

// ── the credentials episode, step by step, through onOutcome and the core ───

function page(columnsNow: FanslyPageHoldColumns, trusted: string | null): PageErrorState {
  return { ...columnsNow, holdStep: 0, networkFailureStreak: 0, resourceHolds: {}, credentialsGeneration: trusted };
}

function refusal(state: PageErrorState, attempt: { id: number; sentAt: Date }, digest: string): FanslyPageHoldColumns {
  const input: OutcomeInput = {
    errorClass: "auth",
    now: attempt.sentAt,
    resource: "account.verify",
    subject: "",
    httpStatus: 401,
    retryAfterMs: null,
    page: state,
    subjectState: { failureCount: 0, breakerUntil: null, blockedByVendorAt: null },
    subjectQueue: false,
    recentFailedSubjects: 0,
    requestCredentialsGeneration: digest,
    attempt,
  };
  const decision = onOutcome(input).pageHold;
  if (decision.action !== "set") throw new Error("a refusal sets the hold");
  return {
    holdKind: decision.kind,
    holdUntil: decision.until === "infinity" ? INDEFINITE_UNTIL : decision.until,
    // setPageHold keeps the episode start of a credentials hold in force.
    holdSince: state.holdKind === null ? attempt.sentAt : state.holdSince,
    holdDetail: decision.detail,
  };
}

describe("page holds: a credentials episode (A verified, B refused, C renewed)", () => {
  it("B's refusal holds although A is trusted; B's verify is not admitted; C's is, once; a late proof of A clears nothing", () => {
    // A verified (trusted), B stored out of band, B's verify refused (#20).
    let row = refusal(page(columns(), "gen-a"), { id: 20, sentAt: at(-5 * MIN) }, "gen-b");
    const holds = () => readFanslyPageHolds(row);
    expect(fanslyPageHoldInForce(holds(), NOW)?.credentials?.kind).toBe("auth");
    // The stored digest is still B: no verify under the hold (no 401 loop).
    expect(admitUnderFanslyPageHolds(holds(), { kind: "verify", digest: "gen-b" }, NOW).admitted).toBe(false);
    // A poll of A sent before B's refusal, applied late (#19): not a proof
    // after the latest refusal.
    expect(proofClearsCredentialsHold(holds().credentials!, { attemptId: 19, sentAt: at(-6 * MIN) })).toBe(false);

    // The owner stores C: one verify of C is admitted under the hold …
    expect(admitUnderFanslyPageHolds(holds(), { kind: "verify", digest: "gen-c" }, NOW)).toEqual({ admitted: true, exception: "verify" });
    // … refused too (#21): C becomes the latest refusal and closes the
    // exception — one verify per digest, the episode keeps its start.
    row = refusal(page(row, "gen-a"), { id: 21, sentAt: at(-MIN) }, "gen-c");
    expect(holds().credentials).toMatchObject({ since: at(-5 * MIN), failure: { attemptId: 21, digest: "gen-c" } });
    expect(admitUnderFanslyPageHolds(holds(), { kind: "verify", digest: "gen-c" }, NOW).admitted).toBe(false);
    // C passing at #21 is no proof after #21; D's verify at #22 is.
    expect(proofClearsCredentialsHold(holds().credentials!, { attemptId: 21, sentAt: at(-MIN) })).toBe(false);
    expect(admitUnderFanslyPageHolds(holds(), { kind: "verify", digest: "gen-d" }, NOW).admitted).toBe(true);
    expect(proofClearsCredentialsHold(holds().credentials!, { attemptId: 22, sentAt: NOW })).toBe(true);
  });
});
