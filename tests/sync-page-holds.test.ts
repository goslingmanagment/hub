import { describe, expect, it } from "vitest";

import {
  admitUnderFanslyPageHolds,
  credentialsFailureDetail,
  FANSLY_PAGE_HOLD_KINDS,
  fanslyPageHoldInForce,
  INDEFINITE_UNTIL,
  isFanslyPageHoldKind,
  NO_FANSLY_PAGE_HOLDS,
  proofClearsCredentialsHold,
  readFanslyPageHolds,
  verifyAdmittedUnderCredentialsHold,
  type FanslyPageHoldRow,
  type FanslyPageHolds,
} from "@agency_hub_core/shared";

import { onOutcome, type OutcomeInput, type PageErrorState } from "../apps/runtime/src/sync/engine/errors.ts";

// The shared page-hold core (step 3b ruling 5, A3; step 4 owner decision №26):
// one rule for what a page hold is, what it admits and what clears a
// credentials hold, over the page-scope rows of a page's hold set — read by
// the hold evaluator for the actor, the final admission, status/why and the
// alerts.

const NOW = new Date("2026-10-03T12:00:00.000Z");
const MIN = 60_000;
const at = (ms: number) => new Date(NOW.getTime() + ms);

function authRow(
  failure: { attemptId: number | null; at: Date | null; digest: string | null },
  extra: Record<string, unknown> = {},
): FanslyPageHoldRow {
  return { kind: "auth", until: INDEFINITE_UNTIL, since: at(-10 * MIN), detail: credentialsFailureDetail(failure, { status: 401, ...extra }) };
}

const networkRow = (untilMs: number, detail: Record<string, unknown> = {}): FanslyPageHoldRow =>
  ({ kind: "network", until: at(untilMs), since: at(-MIN), detail });

describe("page holds: the kinds", () => {
  it("are a credentials hold of two kinds and the network hold — a 429 holds its route, never the page", () => {
    expect([...FANSLY_PAGE_HOLD_KINDS]).toEqual(["auth", "identity_mismatch", "network"]);
    expect(isFanslyPageHoldKind("network")).toBe(true);
    expect(isFanslyPageHoldKind("rate_limit")).toBe(false);
  });
});

describe("page holds: what the rows record", () => {
  it("no hold, a network hold, a credentials hold with its latest refusal", () => {
    expect(readFanslyPageHolds([])).toEqual(NO_FANSLY_PAGE_HOLDS);
    expect(readFanslyPageHolds([networkRow(MIN, { streak: 3 })]))
      .toEqual({ credentials: null, timed: { kind: "network", until: at(MIN), since: at(-MIN), detail: { streak: 3 } } });
    expect(readFanslyPageHolds([authRow({ attemptId: 42, at: at(-MIN), digest: "gen-b" })])).toEqual({
      credentials: { kind: "auth", since: at(-10 * MIN), until: INDEFINITE_UNTIL, failure: { attemptId: 42, at: at(-MIN), digest: "gen-b" } },
      timed: null,
    });
  });

  it("a network hold beside a credentials hold is a row of its own: both are recorded", () => {
    const both = readFanslyPageHolds([authRow({ attemptId: 1, at: at(-MIN), digest: "gen-a" }), networkRow(90_000, { streak: 3 })]);
    expect(both.credentials?.kind).toBe("auth");
    expect(both.timed).toEqual({ kind: "network", until: at(90_000), since: at(-MIN), detail: { streak: 3 } });
  });

  it("a refusal written before refusals carried their attempt has none; malformed fields read as unknown", () => {
    const early: FanslyPageHoldRow = { kind: "auth", until: INDEFINITE_UNTIL, since: at(-MIN), detail: { credentialsGeneration: "gen-a" } };
    expect(readFanslyPageHolds([early]).credentials?.failure).toEqual({ attemptId: null, at: null, digest: "gen-a" });
    const odd: FanslyPageHoldRow = {
      kind: "identity_mismatch",
      until: INDEFINITE_UNTIL,
      since: null,
      detail: { failedAttemptId: -3, failedAt: "yesterday", credentialsGeneration: "" },
    };
    expect(readFanslyPageHolds([odd]).credentials?.failure).toEqual({ attemptId: null, at: null, digest: null });
    // A bigint id serialised as text is read as the number it is.
    const text: FanslyPageHoldRow = { kind: "auth", until: INDEFINITE_UNTIL, since: null, detail: { failedAttemptId: "77" } };
    expect(readFanslyPageHolds([text]).credentials?.failure.attemptId).toBe(77);
  });

  it("a hold whose end is not an instant — or that names none — holds indefinitely (fail closed)", () => {
    for (const until of [new Date("infinity"), null]) {
      const unreadable = readFanslyPageHolds([{ kind: "auth", until, since: null, detail: {} }]);
      expect(fanslyPageHoldInForce(unreadable, NOW)).toMatchObject({ kind: "auth", until: INDEFINITE_UNTIL });
      const network = readFanslyPageHolds([{ kind: "network", until, since: null, detail: {} }]);
      expect(fanslyPageHoldInForce(network, at(365 * 24 * 60 * MIN))).toMatchObject({ kind: "network", until: INDEFINITE_UNTIL });
    }
  });
});

describe("page holds: in force", () => {
  it("a credentials hold is in force until a proof clears it; the network hold beside it until its end", () => {
    const held = readFanslyPageHolds([authRow({ attemptId: 1, at: at(-MIN), digest: "gen-a" }), networkRow(30_000)]);
    expect(fanslyPageHoldInForce(held, NOW)).toMatchObject({ kind: "auth", until: INDEFINITE_UNTIL, timed: { kind: "network", until: at(30_000) } });
    expect(fanslyPageHoldInForce(held, at(30_000))).toMatchObject({ kind: "auth", until: INDEFINITE_UNTIL, timed: null });
  });

  it("a network hold alone until its end, then nothing", () => {
    const held = readFanslyPageHolds([networkRow(MIN, { streak: 3 })]);
    expect(fanslyPageHoldInForce(held, NOW)).toMatchObject({ kind: "network", until: at(MIN), credentials: null });
    expect(fanslyPageHoldInForce(held, at(MIN))).toBeNull();
  });
});

describe("page holds: admission (A3)", () => {
  const held = readFanslyPageHolds([authRow({ attemptId: 10, at: at(-MIN), digest: "gen-b" })]);

  it("without a hold everything is admitted", () => {
    expect(admitUnderFanslyPageHolds(NO_FANSLY_PAGE_HOLDS, { kind: "request" }, NOW)).toEqual({ admitted: true, exception: null });
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
    const unknown = readFanslyPageHolds([authRow({ attemptId: null, at: null, digest: null })]).credentials!;
    expect(verifyAdmittedUnderCredentialsHold(unknown, "gen-a")).toBe(true);
    expect(verifyAdmittedUnderCredentialsHold(unknown, null)).toBe(false);
  });

  it("a network hold in force admits nothing — not a candidate check, not a verify — also beside a credentials hold", () => {
    const both = readFanslyPageHolds([authRow({ attemptId: 10, at: null, digest: "gen-b" }), networkRow(20_000)]);
    for (const operation of [{ kind: "request" }, { kind: "candidate_check" }, { kind: "verify", digest: "gen-c" }] as const) {
      expect(admitUnderFanslyPageHolds(both, operation, NOW)).toEqual({ admitted: false, scope: "timed", kind: "network", until: at(20_000) });
    }
    expect(admitUnderFanslyPageHolds(both, { kind: "verify", digest: "gen-c" }, at(20_000))).toEqual({ admitted: true, exception: "verify" });
  });
});

describe("page holds: what clears a credentials hold (ruling 5)", () => {
  it("only a proof sent after the LATEST refusal, by attempt order", () => {
    const hold = readFanslyPageHolds([authRow({ attemptId: 10, at: at(-MIN), digest: "gen-b" })]).credentials!;
    expect(proofClearsCredentialsHold(hold, { attemptId: 11, sentAt: at(-30_000) })).toBe(true);
    // Sent before the refusal (its apply came late): never.
    expect(proofClearsCredentialsHold(hold, { attemptId: 9, sentAt: at(-2 * MIN) })).toBe(false);
    expect(proofClearsCredentialsHold(hold, { attemptId: 10, sentAt: at(-MIN) })).toBe(false);
    // Engine-own requests keep their attempt ordering even when times differ.
    expect(proofClearsCredentialsHold(hold, { attemptId: 11, sentAt: at(-2 * MIN) })).toBe(true);
    expect(proofClearsCredentialsHold(hold, { attemptId: 9, sentAt: NOW })).toBe(false);
  });

  it.each([
    { attemptId: 11, sentAt: at(-2 * MIN), clears: false },
    { attemptId: 11, sentAt: at(-MIN), clears: false },
    { attemptId: 9, sentAt: at(-MIN + 1), clears: true },
    { attemptId: 10, sentAt: at(-MIN + 1), clears: true },
  ])("an observed site's proof uses its send lower bound, never id $attemptId ($clears)", ({ attemptId, sentAt, clears }) => {
    const hold = readFanslyPageHolds([authRow({ attemptId: 10, at: at(-MIN), digest: "gen-b" })]).credentials!;
    expect(proofClearsCredentialsHold(hold, { attemptId, sentAt, observed: true })).toBe(clears);
  });

  it("an observed site's proof must also be after the episode start", () => {
    const hold = { ...readFanslyPageHolds([authRow({ attemptId: 10, at: at(-MIN), digest: "gen-b" })]).credentials!, since: NOW };
    expect(proofClearsCredentialsHold(hold, { attemptId: 11, sentAt: at(-30_000), observed: true })).toBe(false);
    expect(proofClearsCredentialsHold(hold, { attemptId: 11, sentAt: NOW, observed: true })).toBe(false);
    expect(proofClearsCredentialsHold(hold, { attemptId: 9, sentAt: at(1), observed: true })).toBe(true);
  });

  it.each([10, null])("an observed site's proof cannot clear a hold without a failure instant (attempt %s), even with a known episode start", (attemptId) => {
    const hold = readFanslyPageHolds([authRow({ attemptId, at: null, digest: "gen-b" })]).credentials!;
    expect(proofClearsCredentialsHold(hold, { attemptId: 11, sentAt: NOW, observed: true })).toBe(false);
  });

  it("a refusal without an attempt: by the send instant against the later of the refusal and the episode start", () => {
    const imported = readFanslyPageHolds([authRow({ attemptId: null, at: null, digest: "gen-b" })]).credentials!;
    expect(proofClearsCredentialsHold(imported, { attemptId: 1, sentAt: at(-10 * MIN) })).toBe(false);
    expect(proofClearsCredentialsHold(imported, { attemptId: 1, sentAt: at(-10 * MIN + 1) })).toBe(true);
    const dated = readFanslyPageHolds([authRow({ attemptId: null, at: at(-MIN), digest: "gen-b" })]).credentials!;
    expect(proofClearsCredentialsHold(dated, { attemptId: 1, sentAt: at(-2 * MIN) })).toBe(false);
    expect(proofClearsCredentialsHold(dated, { attemptId: 1, sentAt: at(-MIN + 1) })).toBe(true);
    const undated = { ...dated, since: null, failure: { ...dated.failure, at: null } };
    expect(proofClearsCredentialsHold(undated, { attemptId: 1, sentAt: NOW })).toBe(false);
  });
});

// ── the credentials episode, step by step, through onOutcome and the core ───

function page(holds: FanslyPageHolds, trusted: string | null): PageErrorState {
  return { holds, networkFailureStreak: 0, resourceHolds: {}, credentialsGeneration: trusted };
}

/** The page's holds after a refusal of `digest` at `attempt`, as `setPageHold`
 *  writes the decision: the credentials row replaced, its episode start kept.
 *  `observed`: the refusal of the site's own request (variant Б). */
function refusal(state: PageErrorState, attempt: { id: number; sentAt: Date }, digest: string, observed = false): FanslyPageHolds {
  const input: OutcomeInput = {
    ...(observed ? { observed: true } : {}),
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
  if (decision.action !== "set" || decision.kind === "network") throw new Error("a refusal sets the credentials hold");
  return readFanslyPageHolds([{
    kind: decision.kind,
    until: decision.until === "infinity" ? INDEFINITE_UNTIL : decision.until,
    since: state.holds.credentials?.since ?? attempt.sentAt,
    detail: decision.detail,
  }]);
}

describe("page holds: a credentials episode (A verified, B refused, C renewed)", () => {
  it("B's refusal holds although A is trusted; B's verify is not admitted; C's is, once; a late proof of A clears nothing", () => {
    // A verified (trusted), B stored out of band, B's verify refused (#20).
    let holds = refusal(page(NO_FANSLY_PAGE_HOLDS, "gen-a"), { id: 20, sentAt: at(-5 * MIN) }, "gen-b");
    expect(fanslyPageHoldInForce(holds, NOW)?.credentials?.kind).toBe("auth");
    // The stored digest is still B: no verify under the hold (no 401 loop).
    expect(admitUnderFanslyPageHolds(holds, { kind: "verify", digest: "gen-b" }, NOW).admitted).toBe(false);
    // A poll of A sent before B's refusal, applied late (#19): not a proof
    // after the latest refusal.
    expect(proofClearsCredentialsHold(holds.credentials!, { attemptId: 19, sentAt: at(-6 * MIN) })).toBe(false);

    // The owner stores C: one verify of C is admitted under the hold …
    expect(admitUnderFanslyPageHolds(holds, { kind: "verify", digest: "gen-c" }, NOW)).toEqual({ admitted: true, exception: "verify" });
    // … refused too (#21): C becomes the latest refusal and closes the
    // exception — one verify per digest, the episode keeps its start.
    holds = refusal(page(holds, "gen-a"), { id: 21, sentAt: at(-MIN) }, "gen-c");
    expect(holds.credentials).toMatchObject({ since: at(-5 * MIN), failure: { attemptId: 21, digest: "gen-c" } });
    expect(admitUnderFanslyPageHolds(holds, { kind: "verify", digest: "gen-c" }, NOW).admitted).toBe(false);
    // C passing at #21 is no proof after #21; D's verify at #22 is.
    expect(proofClearsCredentialsHold(holds.credentials!, { attemptId: 21, sentAt: at(-MIN) })).toBe(false);
    expect(admitUnderFanslyPageHolds(holds, { kind: "verify", digest: "gen-d" }, NOW).admitted).toBe(true);
    expect(proofClearsCredentialsHold(holds.credentials!, { attemptId: 22, sentAt: NOW })).toBe(true);
  });
});

describe("page holds: the site's own refusal on a browser page (variant Б)", () => {
  // H: the browser's session, trusted — every request of the page carries
  // it, the site's own and the engine's verify alike.
  const trusted = page(NO_FANSLY_PAGE_HOLDS, "gen-h");

  it("names no digest and no attempt: one verify of H is admitted under it, and a proof sent after the site's request clears it", () => {
    // The site's request carried H; its attempt (#30) was journaled late.
    const holds = refusal(trusted, { id: 30, sentAt: at(-MIN) }, "gen-h", true);
    // Marked as the site's own, so the proof that clears it says so.
    expect(holds.credentials).toMatchObject({ kind: "auth", failure: { attemptId: null, at: at(-MIN), digest: null, observed: true } });
    expect(admitUnderFanslyPageHolds(holds, { kind: "request" }, NOW).admitted).toBe(false);
    expect(admitUnderFanslyPageHolds(holds, { kind: "verify", digest: "gen-h" }, NOW)).toEqual({ admitted: true, exception: "verify" });
    // Ordered by the site's send, never by ids: a proof sent before it
    // clears nothing whatever its id; the verify sent after it clears it.
    expect(proofClearsCredentialsHold(holds.credentials!, { attemptId: 31, sentAt: at(-2 * MIN) })).toBe(false);
    expect(proofClearsCredentialsHold(holds.credentials!, { attemptId: 29, sentAt: NOW })).toBe(true);
  });

  it("the verify refused in turn names H: no second verify of H, also after a later site refusal; a new session's verify goes once", () => {
    let holds = refusal(trusted, { id: 30, sentAt: at(-3 * MIN) }, "gen-h", true);
    holds = refusal(page(holds, "gen-h"), { id: 31, sentAt: at(-2 * MIN) }, "gen-h");
    // The engine's own refusal: a digest, an attempt, no mark of the site.
    expect(holds.credentials?.failure).toEqual({ attemptId: 31, at: at(-2 * MIN), digest: "gen-h" });
    expect(admitUnderFanslyPageHolds(holds, { kind: "verify", digest: "gen-h" }, NOW).admitted).toBe(false);
    // The site goes on and is refused again: the latest refusal moves to its
    // send, the refused digest stays — no verify loop.
    holds = refusal(page(holds, "gen-h"), { id: 32, sentAt: at(-MIN) }, "gen-h", true);
    expect(holds.credentials).toMatchObject({ since: at(-3 * MIN), failure: { attemptId: null, at: at(-MIN), digest: "gen-h" } });
    expect(admitUnderFanslyPageHolds(holds, { kind: "verify", digest: "gen-h" }, NOW).admitted).toBe(false);
    // The owner's new login (H2): its verify, once.
    expect(admitUnderFanslyPageHolds(holds, { kind: "verify", digest: "gen-h2" }, NOW)).toEqual({ admitted: true, exception: "verify" });
  });

  it("a network hold beside it (the verify's network failures) admits nothing, the verify included, until it ends", () => {
    const holds = refusal(trusted, { id: 30, sentAt: at(-MIN) }, "gen-h", true);
    const both: FanslyPageHolds = { ...holds, timed: readFanslyPageHolds([networkRow(20_000)]).timed };
    expect(admitUnderFanslyPageHolds(both, { kind: "verify", digest: "gen-h" }, NOW))
      .toEqual({ admitted: false, scope: "timed", kind: "network", until: at(20_000) });
    expect(admitUnderFanslyPageHolds(both, { kind: "verify", digest: "gen-h" }, at(20_000))).toEqual({ admitted: true, exception: "verify" });
  });
});
