import { describe, expect, it } from "vitest";

import { fanslyWireSpec, type FanslyWireOutcome } from "@agency_hub_core/fansly";
import { activeFanslyPageHold, CARRIED_TIMED_HOLD_FIELD, INDEFINITE_UNTIL } from "@agency_hub_core/shared";

import {
  activeResourceHold,
  BLOCKED_PROBE_EVERY_MS,
  classifyWireOutcome,
  NETWORK_ALERT_AFTER_MS,
  NETWORK_FAILURES_TO_PAUSE,
  NETWORK_PAUSE_LADDER_MS,
  onOutcome,
  RESOURCE_BREAKER_SUBJECTS,
  RESOURCE_BREAKER_WINDOW_MS,
  RESOURCE_HOLD_LADDER_MS,
  SUBJECT_BLOCK_AFTER,
  SUBJECT_BREAKER_LADDER_MS,
  type OutcomeClass,
  type OutcomeInput,
  type PageErrorState,
  type RouteOutcomeInput,
} from "../apps/runtime/src/sync/engine/errors.ts";
import type { RouteStateEntry } from "../apps/runtime/src/sync/engine/route-policy.ts";
import { routePolicyVersion, type FanslyRoute } from "../apps/runtime/src/sync/fansly/routes.ts";

// Plan §9 / design §3.8: what each answer means and what it does. The
// classification reads the answer against its wire spec; `onOutcome` decides
// every consequence in one place, purely.

const NOW = new Date("2026-10-02T12:00:00.000Z");
const MIN = 60_000;
const HOUR = 60 * MIN;
const at = (ms: number) => new Date(NOW.getTime() + ms);

function answer(status: number, body: unknown, headers: Record<string, string> = {}): FanslyWireOutcome {
  const bodyText = typeof body === "string" ? body : JSON.stringify(body);
  return { kind: "response", status, headers, bodyText, bodyBytes: bodyText.length, sendMark: "request_start" };
}

const accountMe = fanslyWireSpec("account.me");
const ok = { success: true, response: { account: { id: "123", followCount: 5 } } };

function classify(outcome: FanslyWireOutcome, terminalStatuses?: readonly number[]) {
  return classifyWireOutcome(outcome, accountMe, {}, terminalStatuses === undefined
    ? { now: NOW }
    : { now: NOW, terminalStatuses });
}

describe("sync errors: classification of one outcome", () => {
  it("nothing sent: a refused or cancelled dispatch learns nothing about Fansly", () => {
    expect(classify({ kind: "aborted_before_send", refusal: "pace" }).errorClass).toBe("not_sent");
  });

  it("transport errors, timeouts and 408 are the network", () => {
    expect(classify({ kind: "transport_error", sent: false, message: "ECONNREFUSED" }).errorClass).toBe("network");
    expect(classify({ kind: "timeout", sent: true, message: "budget" }).errorClass).toBe("network");
    expect(classify(answer(408, "")).errorClass).toBe("network");
  });

  it("a 2xx success envelope the contract accepts is ok; the read is returned", () => {
    const classified = classify(answer(200, ok));
    expect(classified.errorClass).toBe("ok");
    expect(classified.httpStatus).toBe(200);
    expect(classified.read).toMatchObject({ kind: "accepted", value: { account: { id: "123" } } });
  });

  it("a 2xx the contract refuses is a contract violation", () => {
    const classified = classify(answer(200, { success: true, response: { account: { id: "" } } }));
    expect(classified.errorClass).toBe("contract");
    expect(classified.read).toMatchObject({ kind: "contract_violation", violation: { field: "account.id" } });
  });

  it("a 2xx without a success envelope is envelope_unsuccessful", () => {
    expect(classify(answer(200, { success: false, error: { code: 1, details: "no" } })).errorClass)
      .toBe("envelope_unsuccessful");
    expect(classify(answer(200, "<html>proxy</html>")).errorClass).toBe("envelope_unsuccessful");
  });

  it("429 is the rate limit on every route, with Retry-After in either wire form", () => {
    const seconds = classify(answer(429, "", { "retry-after": "120" }));
    expect(seconds).toMatchObject({ errorClass: "rate_limit", httpStatus: 429, retryAfterMs: 120_000 });
    const date = classify(answer(429, "", { "retry-after": at(90_000).toUTCString() }));
    expect(date).toMatchObject({ errorClass: "rate_limit", retryAfterMs: 90_000 });
    expect(classify(answer(429, "")).retryAfterMs).toBeNull();
    // The list and the media statistics are routes like any other: no class of their own.
    expect(classifyWireOutcome(answer(429, ""), fanslyWireSpec("messaging.groups"), { offset: 0 }, { now: NOW }).errorClass)
      .toBe("rate_limit");
    const stats = { mediaOfferId: "777", beforeMs: NOW.getTime(), afterMs: NOW.getTime() - 31 * 86_400_000, periodMs: 86_400_000 };
    expect(classifyWireOutcome(answer(429, ""), fanslyWireSpec("media.offer_stats"), stats as never, { now: NOW }).errorClass)
      .toBe("rate_limit");
  });

  it("an HTTP-date Retry-After is measured against the answer's own Date too: a local clock ahead never shortens it", () => {
    // The provider's clock is 30 s behind ours: its 90 s is 90 s from ITS now.
    const served = at(-30_000).toUTCString();
    const until = at(60_000).toUTCString();
    expect(classify(answer(429, "", { "retry-after": until, date: served })).retryAfterMs).toBe(90_000);
    // A provider clock ahead of ours: our own reading is the longer one.
    expect(classify(answer(429, "", { "retry-after": until, date: at(30_000).toUTCString() })).retryAfterMs).toBe(60_000);
    // Delta-seconds and an unreadable Date read as stated.
    expect(classify(answer(429, "", { "retry-after": "45", date: served })).retryAfterMs).toBe(45_000);
    expect(classify(answer(429, "", { "retry-after": until, date: "not a date" })).retryAfterMs).toBe(60_000);
  });

  it("401 and 403 are auth, even when a resource lists them as terminal", () => {
    expect(classify(answer(401, "")).errorClass).toBe("auth");
    expect(classify(answer(403, ""), [403]).errorClass).toBe("auth");
  });

  it("a 401/403 a resource declares about its subject closes the subject and holds nothing (G16)", () => {
    const cdn = fanslyWireSpec("cdn.media");
    const scoped = { now: NOW, subjectScopedAuthStatuses: [401, 403] as const };
    for (const status of [401, 403]) {
      expect(classifyWireOutcome(answer(status, ""), cdn, { hop: 0 }, scoped).errorClass, String(status)).toBe("subject_terminal");
      // Without the declaration the same answer is the page's session.
      expect(classifyWireOutcome(answer(status, ""), cdn, { hop: 0 }, { now: NOW }).errorClass, String(status)).toBe("auth");
    }
    // Only the listed statuses: a 401 stays the page's when only 403 is listed.
    expect(classifyWireOutcome(answer(401, ""), accountMe, {}, { now: NOW, subjectScopedAuthStatuses: [403] }).errorClass).toBe("auth");
    expect(classifyWireOutcome(answer(403, ""), accountMe, {}, { now: NOW, subjectScopedAuthStatuses: [403] }).errorClass).toBe("subject_terminal");
    // A 429 is the provider's pace whatever the resource says (plan §9).
    expect(classifyWireOutcome(answer(429, ""), cdn, { hop: 0 }, scoped).errorClass).toBe("rate_limit");
  });

  it("reads a CDN hop and an Upgrade by status: every non-page-level answer is theirs to apply", () => {
    const cdn = fanslyWireSpec("cdn.media");
    const upgrade = fanslyWireSpec("ws.upgrade");
    for (const status of [200, 302, 404, 500]) {
      expect(classifyWireOutcome(answer(status, ""), cdn, { hop: 0 }, { now: NOW }).errorClass, String(status)).toBe("ok");
    }
    expect(classifyWireOutcome(answer(503, "", { "retry-after": "60" }), cdn, { hop: 0 }, { now: NOW }).errorClass).toBe("rate_limit");
    expect(classifyWireOutcome(answer(101, ""), upgrade, {}, { now: NOW }).errorClass).toBe("ok");
    expect(classifyWireOutcome(answer(401, ""), upgrade, {}, { now: NOW }).errorClass).toBe("auth");
    expect(classifyWireOutcome(answer(429, ""), upgrade, {}, { now: NOW }).errorClass).toBe("rate_limit");
    expect(classifyWireOutcome(answer(400, ""), upgrade, {}, { now: NOW }).errorClass).toBe("subject_failure");
  });

  it("a 5xx naming its own deadline is the provider's pace (its route's), not the subject's failure", () => {
    const classified = classify(answer(503, "", { "retry-after": "30" }));
    expect(classified).toMatchObject({ errorClass: "rate_limit", retryAfterMs: 30_000 });
  });

  it("other non-2xx answers fail the subject; a 3xx is an answer, never a hop", () => {
    const envelope = { success: false, error: { code: 500, details: "error getting graph" } };
    expect(classify(answer(500, envelope)).errorClass).toBe("subject_failure");
    expect(classify(answer(404, "")).errorClass).toBe("subject_failure");
    expect(classify(answer(302, "", { location: "https://elsewhere.example/" })).errorClass).toBe("subject_failure");
  });

  it("a status the resource declares terminal closes the subject", () => {
    expect(classify(answer(404, ""), [404, 410, 422]).errorClass).toBe("subject_terminal");
    expect(classify(answer(410, ""), [404, 410, 422]).errorClass).toBe("subject_terminal");
    expect(classify(answer(400, ""), [404, 410, 422]).errorClass).toBe("subject_failure");
  });

  it("a route's opted-in empty answer is ok", () => {
    const replies = fanslyWireSpec("post.replies");
    const classified = classifyWireOutcome(answer(204, ""), replies, { postId: "1", before: null }, { now: NOW });
    expect(classified.errorClass).toBe("ok");
  });
});

// ── decisions ──────────────────────────────────────────────────────────────

function pageState(overrides: Partial<PageErrorState> = {}): PageErrorState {
  return {
    holdKind: null,
    holdUntil: null,
    holdSince: null,
    holdStep: 0,
    holdDetail: {},
    networkFailureStreak: 0,
    resourceHolds: {},
    credentialsGeneration: "gen-1",
    ...overrides,
  };
}

function input(errorClass: OutcomeClass, overrides: Partial<OutcomeInput> = {}): OutcomeInput {
  return {
    errorClass,
    now: NOW,
    resource: "media-stats.walk",
    subject: "m1",
    httpStatus: null,
    retryAfterMs: null,
    page: pageState(),
    subjectState: { failureCount: 0, breakerUntil: null, blockedByVendorAt: null },
    subjectQueue: false,
    recentFailedSubjects: 1,
    ...overrides,
  };
}

describe("sync errors: ok", () => {
  it("ends a network streak, resets the subject breaker, goes to apply", () => {
    const decision = onOutcome(input("ok", {
      page: pageState({ networkFailureStreak: 2 }),
      subjectState: { failureCount: 3, breakerUntil: at(-MIN), blockedByVendorAt: null },
    }));
    expect(decision.work).toEqual({ action: "apply" });
    expect(decision.networkFailureStreak).toBe(0);
    expect(decision.subjectBreaker).toEqual({ failureCount: 0, breakerUntil: null, blockedByVendorAt: null, terminal: false });
    expect(decision.attemptErrorClass).toBeNull();
    expect(decision.alerts).toEqual([]);
  });

  it("writes nothing it does not have to", () => {
    const decision = onOutcome(input("ok"));
    expect(decision.networkFailureStreak).toBeNull();
    expect(decision.subjectBreaker).toBeNull();
    expect(decision.pageHold).toEqual({ action: "keep" });
    expect(decision.resourceHold).toEqual({ action: "keep" });
    expect(decision.routeHold).toEqual({ action: "keep" });
  });

  it("clears an expired hold (an imported legacy 429 hold) without a ladder of its own", () => {
    const decision = onOutcome(input("ok", { page: pageState({ holdKind: "rate_limit", holdUntil: at(-1) }) }));
    expect(decision.pageHold).toEqual({ action: "clear", resetStep: false });
  });

  it("zeroes a page-wide 429 ladder step an older build left on the row", () => {
    expect(onOutcome(input("ok", { page: pageState({ holdStep: 3 }) })).pageHold).toEqual({ action: "clear", resetStep: true });
    expect(onOutcome(input("ok", { page: pageState({ holdKind: "rate_limit", holdUntil: at(-1), holdStep: 2 }) })).pageHold)
      .toEqual({ action: "clear", resetStep: true });
  });

  it("never lifts a hold still in force", () => {
    const decision = onOutcome(input("ok", { page: pageState({ holdKind: "network", holdUntil: at(5_000), holdStep: 3 }) }));
    expect(decision.pageHold).toEqual({ action: "keep" });
  });

  it("never lifts a route's hold or slowdown: a success after a 429 leaves the route state alone", () => {
    const entry: RouteStateEntry = {
      holdUntil: at(-1).toISOString(), ladderStep: 2, effectivePerMin: 3.75, policyVersion: "v", last429AttemptId: 9,
      last429At: at(-MIN).toISOString(), revision: 2,
    };
    const decision = onOutcome(input("ok", { route: { route: "messages.page", entry, attemptId: 10, jitter: () => 0 } }));
    expect(decision.routeHold).toEqual({ action: "keep" });
  });

  it("never clears a credentials hold, whatever digest the engine trusts now (ruling 5: only an identity proof's apply does)", () => {
    const decision = onOutcome(input("ok", {
      page: pageState({
        holdKind: "auth",
        holdUntil: INDEFINITE_UNTIL,
        holdDetail: { credentialsGeneration: "gen-0", failedAttemptId: 7, failedAt: at(-MIN).toISOString() },
        credentialsGeneration: "gen-1",
      }),
    }));
    expect(decision.pageHold).toEqual({ action: "keep" });
  });

  it("clears an expired resource hold of its file", () => {
    const decision = onOutcome(input("ok", {
      page: pageState({ resourceHolds: { "media-stats": { until: at(-1).toISOString(), step: 1, since: at(-HOUR).toISOString() } } }),
    }));
    expect(decision.resourceHold).toEqual({ action: "clear", file: "media-stats" });
  });
});

describe("sync errors: nothing sent", () => {
  it("changes nothing and reopens the work", () => {
    const decision = onOutcome(input("not_sent", { page: pageState({ networkFailureStreak: 2 }) }));
    expect(decision).toMatchObject({
      networkFailureStreak: null,
      pageHold: { action: "keep" },
      subjectBreaker: null,
      resourceHold: { action: "keep" },
      work: { action: "reopen", dueAt: null, waitingReason: null },
      alerts: [],
    });
  });
});

describe("sync errors: network", () => {
  it(`counts the streak and pauses the page at ${NETWORK_FAILURES_TO_PAUSE}: 10 s → 30 s → 1 min → 2 min → 5 min`, () => {
    expect(onOutcome(input("network")).networkFailureStreak).toBe(1);
    expect(onOutcome(input("network")).pageHold).toEqual({ action: "keep" });
    const holds = [2, 3, 4, 5, 6, 7, 20].map((streak) => onOutcome(input("network", {
      page: pageState({ networkFailureStreak: streak }),
    })));
    expect(holds.map((d) => d.networkFailureStreak)).toEqual([3, 4, 5, 6, 7, 8, 21]);
    expect(holds.map((d) => (d.pageHold.action === "set" && d.pageHold.until !== "infinity"
      ? d.pageHold.until.getTime() - NOW.getTime()
      : null))).toEqual([10_000, 30_000, 60_000, 120_000, 300_000, 300_000, 300_000]);
    expect(holds[0]!.work).toEqual({ action: "reopen", dueAt: null, waitingReason: "page_hold", waitingUntil: at(10_000) });
  });

  it("alerts once the network has been gone for more than 10 minutes; keeps the 429 ladder", () => {
    const since = at(-NETWORK_ALERT_AFTER_MS - 1);
    const page = pageState({
      networkFailureStreak: 8,
      holdKind: "network",
      holdUntil: at(-1),
      holdSince: at(-1_000),
      holdStep: 2,
      holdDetail: { streak: 8, networkSince: since.toISOString() },
    });
    const decision = onOutcome(input("network", { page }));
    expect(decision.alerts).toEqual([{ subKey: "page_stopped", detail: "network" }]);
    expect(decision.pageHold).toMatchObject({ action: "set", kind: "network", step: 2, detail: { networkSince: since.toISOString() } });
    const fresh = onOutcome(input("network", { page: pageState({ networkFailureStreak: 2 }) }));
    expect(fresh.alerts).toEqual([]);
    expect(fresh.pageHold).toMatchObject({ detail: { networkSince: NOW.toISOString() } });
  });
});

// Owner decisions №21–№23 (step 3b ruling 2 / A2, D3, D5): a 429 holds only
// the route that answered it — the ladder and the slowdown are
// tests/sync-route-holds.test.ts; here, what one outcome decides.
describe("sync errors: a 429 holds only its route", () => {
  const routeInput = (
    route: FanslyRoute,
    entry: RouteStateEntry | null = null,
    attemptId = 7,
    jitter = 0,
  ): RouteOutcomeInput => ({ route, entry, attemptId, jitter: () => jitter });

  it("holds the route that answered — never the page, a file or the route's family — and slows it; the work is due again at once", () => {
    const decision = onOutcome(input("rate_limit", {
      resource: "dm-messages.head",
      subject: "g1",
      httpStatus: 429,
      route: routeInput("messages.page"),
      page: pageState({ networkFailureStreak: 1 }),
    }));
    expect(decision.pageHold).toEqual({ action: "keep" });
    expect(decision.resourceHold).toEqual({ action: "keep" });
    expect(decision.subjectBreaker).toBeNull();
    expect(decision.networkFailureStreak).toBe(0);
    expect(decision.attemptErrorClass).toBe("rate_limit");
    expect(decision.routeHold).toEqual({
      action: "set",
      route: "messages.page",
      expectRevision: 0,
      holdUntil: at(5_000),
      rateLimited: true,
      entry: {
        holdUntil: at(5_000).toISOString(),
        ladderStep: 1,
        effectivePerMin: 7.5,
        policyVersion: routePolicyVersion("messages.page"),
        last429AttemptId: 7,
        last429At: NOW.toISOString(),
        revision: 1,
      },
    });
    // The route admission keeps a key whose routes are all held out of the
    // pick; a plan on a held route is deferred by the final check.
    expect(decision.work).toEqual({ action: "reopen", dueAt: null, waitingReason: null, waitingUntil: null });
    expect(decision.alerts).toEqual([{ subKey: "route_limited", detail: "rate_limit", route: "messages.page" }]);
  });

  it("the conversation list and the media statistics are held like any route (no group, no held-key list)", () => {
    for (const [route, resource, effective] of [
      ["messaging.groups", "dm-conversations.find", 6],
      ["media.offer_stats", "media-stats.walk", 2.5],
    ] as const) {
      const decision = onOutcome(input("rate_limit", { resource, httpStatus: 429, retryAfterMs: 42_000, route: routeInput(route) }));
      expect(decision.resourceHold, route).toEqual({ action: "keep" });
      expect(decision.routeHold, route).toMatchObject({
        action: "set", route, holdUntil: at(42_000), entry: { ladderStep: 1, effectivePerMin: effective },
      });
      expect(decision.work, route).toEqual({ action: "reopen", dueAt: null, waitingReason: null, waitingUntil: null });
    }
  });

  it("a candidate identity check's 429 under an auth hold holds its route and leaves the auth hold alone", () => {
    const authHeld = pageState({ holdKind: "auth", holdUntil: INDEFINITE_UNTIL, holdDetail: { status: 401, credentialsGeneration: "gen-1" } });
    const decision = onOutcome(input("rate_limit", {
      resource: "account.identity",
      subject: "",
      httpStatus: 429,
      retryAfterMs: 90_000,
      page: authHeld,
      route: routeInput("account.me"),
      requestCredentialsGeneration: "candidate-gen",
    }));
    expect(decision.pageHold).toEqual({ action: "keep" });
    expect(decision.routeHold).toMatchObject({ action: "set", route: "account.me", holdUntil: at(90_000) });
  });

  it("a 5xx naming its Retry-After holds its route to the letter, without a slowdown or a ladder step", () => {
    const decision = onOutcome(input("rate_limit", {
      resource: "transactions.head", httpStatus: 503, retryAfterMs: 120_000, route: routeInput("transactions.page"),
    }));
    expect(decision.routeHold).toMatchObject({
      action: "set",
      route: "transactions.page",
      holdUntil: at(120_000),
      rateLimited: false,
      entry: { holdUntil: at(120_000).toISOString(), ladderStep: 0, effectivePerMin: null, last429AttemptId: null, revision: 1 },
    });
    expect(decision.alerts).toEqual([{ subKey: "route_limited", detail: "unavailable", route: "transactions.page" }]);
  });

  it("the same attempt's 429 is recorded once", () => {
    const first = onOutcome(input("rate_limit", { httpStatus: 429, route: routeInput("messages.page", null, 7) }));
    if (first.routeHold.action !== "set") throw new Error("no route hold");
    const again = onOutcome(input("rate_limit", { httpStatus: 429, route: routeInput("messages.page", first.routeHold.entry, 7) }));
    expect(again.routeHold).toEqual({ action: "keep" });
  });

  it("a page whose route state this build cannot read writes none (its admission is closed; alert 1 says so)", () => {
    const decision = onOutcome(input("rate_limit", { httpStatus: 429 }));
    expect(decision.routeHold).toEqual({ action: "keep" });
    expect(decision.pageHold).toEqual({ action: "keep" });
    expect(decision.alerts).toEqual([]);
    expect(decision.work).toEqual({ action: "reopen", dueAt: null, waitingReason: null, waitingUntil: null });
  });
});

describe("sync errors: auth and identity", () => {
  it("auth holds the page until an identity proof after the refusal, records the refusal as the latest, and alerts at once", () => {
    const decision = onOutcome(input("auth", { httpStatus: 401, attempt: { id: 42, sentAt: at(-300) } }));
    expect(decision.pageHold).toEqual({
      action: "set",
      kind: "auth",
      until: "infinity",
      step: 0,
      detail: { status: 401, credentialsGeneration: "gen-1", failedAttemptId: 42, failedAt: at(-300).toISOString() },
    });
    expect(decision.alerts).toEqual([{ subKey: "page_stopped", detail: "auth" }]);
  });

  it("names the digest the refused request carried, else the trusted one; without an attempt the refusal is dated now", () => {
    expect(onOutcome(input("auth", { httpStatus: 403, requestCredentialsGeneration: "gen-9" })).pageHold).toMatchObject({
      detail: { status: 403, credentialsGeneration: "gen-9", failedAttemptId: null, failedAt: NOW.toISOString() },
    });
  });

  it("a later refusal under the hold replaces the latest refusal (the episode start is the row's, setPageHold)", () => {
    const held = pageState({
      holdKind: "auth",
      holdUntil: INDEFINITE_UNTIL,
      holdSince: at(-HOUR),
      holdDetail: { status: 401, credentialsGeneration: "gen-1", failedAttemptId: 7, failedAt: at(-HOUR).toISOString() },
    });
    const decision = onOutcome(input("auth", {
      httpStatus: 401,
      page: held,
      requestCredentialsGeneration: "gen-2",
      attempt: { id: 9, sentAt: at(-1_000) },
    }));
    expect(decision.pageHold).toMatchObject({
      kind: "auth",
      detail: { credentialsGeneration: "gen-2", failedAttemptId: 9, failedAt: at(-1_000).toISOString() },
    });
  });

  it("an identity mismatch holds the page, records the refusal, quarantines the work, and raises alerts 1 and 2", () => {
    const decision = onOutcome(input("identity_mismatch", { attempt: { id: 5, sentAt: at(-2_000) } }));
    expect(decision.pageHold).toEqual({
      action: "set",
      kind: "identity_mismatch",
      until: "infinity",
      step: 0,
      detail: { credentialsGeneration: "gen-1", failedAttemptId: 5, failedAt: at(-2_000).toISOString() },
    });
    expect(decision.work).toEqual({ action: "quarantine", reason: "identity_mismatch" });
    expect(decision.quarantineAttempt).toBe(true);
    expect(decision.alerts.map((a) => a.subKey)).toEqual(["page_stopped", "live_degraded"]);
  });

  it("an auth hold is in force whatever digest the engine trusts (the A-verified, B-refused case)", () => {
    const held = { holdKind: "auth" as const, holdUntil: INDEFINITE_UNTIL, holdSince: at(-MIN), holdDetail: { credentialsGeneration: "gen-B" } };
    for (const trusted of ["gen-A", "gen-B", null]) {
      const page = pageState({ ...held, credentialsGeneration: trusted });
      expect(activeFanslyPageHold(page, NOW)?.credentials?.kind).toBe("auth");
    }
  });
});

// A 429 hold of the page comes only from the legacy engine now (the switch's
// import, I.4); a network hold is the engine's own.
describe("sync errors: an auth/identity hold and a 429/network hold at once", () => {
  const authHeld = (detail: Record<string, unknown> = {}) => pageState({
    holdKind: "auth",
    holdUntil: INDEFINITE_UNTIL,
    holdSince: at(-HOUR),
    holdDetail: { status: 401, credentialsGeneration: "gen-1", failedAttemptId: 3, failedAt: at(-HOUR).toISOString(), ...detail },
  });
  const carried = (kind: "rate_limit" | "network", untilMs: number, detail: Record<string, unknown> = {}) => ({
    [CARRIED_TIMED_HOLD_FIELD]: { kind, until: at(untilMs).toISOString(), detail },
  });

  it("a candidate identity check's network failures under an auth hold carry a network hold beside it", () => {
    const decision = onOutcome(input("network", {
      resource: "account.identity",
      page: { ...authHeld(), networkFailureStreak: NETWORK_FAILURES_TO_PAUSE - 1 },
    }));
    expect(decision.pageHold).toMatchObject({
      action: "set",
      kind: "auth",
      until: "infinity",
      detail: { credentialsGeneration: "gen-1", [CARRIED_TIMED_HOLD_FIELD]: { kind: "network", until: at(NETWORK_PAUSE_LADDER_MS[0]!).toISOString() } },
    });
    // The network's start rides along across retries of the carried hold.
    const since = at(-20 * MIN).toISOString();
    const again = onOutcome(input("network", {
      resource: "account.identity",
      page: { ...authHeld(carried("network", -1, { streak: 3, networkSince: since })), networkFailureStreak: NETWORK_FAILURES_TO_PAUSE },
    }));
    expect(again.pageHold).toMatchObject({ kind: "auth", detail: { [CARRIED_TIMED_HOLD_FIELD]: { kind: "network", detail: { networkSince: since } } } });
    expect(again.alerts).toEqual([{ subKey: "page_stopped", detail: "network" }]);
  });

  it("an auth refusal over a 429 hold in force carries it", () => {
    const rateLimited = pageState({ holdKind: "rate_limit", holdUntil: at(5 * MIN), holdStep: 2, holdDetail: { status: 429 } });
    expect(onOutcome(input("auth", { httpStatus: 401, page: rateLimited })).pageHold).toMatchObject({
      kind: "auth",
      step: 2,
      detail: { [CARRIED_TIMED_HOLD_FIELD]: { kind: "rate_limit", until: at(5 * MIN).toISOString() } },
    });
  });

  it("a 429 under an auth hold whose trusted digest moved holds only its route: the hold (not history) and its carried 429 stay", () => {
    const moved = { ...authHeld(carried("rate_limit", 30_000)), credentialsGeneration: "renewed" };
    const decision = onOutcome(input("rate_limit", {
      httpStatus: 429,
      retryAfterMs: 60_000,
      page: moved,
      route: { route: "account.me", entry: null, attemptId: 7, jitter: () => 0 },
    }));
    expect(decision.pageHold).toEqual({ action: "keep" });
    expect(decision.routeHold).toMatchObject({ action: "set", route: "account.me", holdUntil: at(60_000) });
    expect(activeFanslyPageHold(moved, NOW)).toMatchObject({ kind: "auth", timed: { kind: "rate_limit", until: at(30_000), carried: true } });
  });
});

describe("sync errors: contract", () => {
  it.each(["contract", "cursor_stuck"] as const)("%s quarantines the work and the attempt, alert 2", (errorClass) => {
    const decision = onOutcome(input(errorClass, { page: pageState({ networkFailureStreak: 1 }) }));
    expect(decision.work).toEqual({ action: "quarantine", reason: errorClass });
    expect(decision.quarantineAttempt).toBe(true);
    expect(decision.alerts).toEqual([{ subKey: "live_degraded", detail: "quarantined" }]);
    expect(decision.networkFailureStreak).toBe(0);
    expect(decision.subjectBreaker).toBeNull();
  });
});

describe("sync errors: subject breaker", () => {
  it("1 min → 10 min → 1 h → 6 h → 24 h; at 5 the subject is blocked_by_vendor, probed daily", () => {
    let state = { failureCount: 0, breakerUntil: null as Date | null, blockedByVendorAt: null as Date | null };
    const steps: Array<{ ms: number; blocked: boolean; reason: string | null }> = [];
    for (let i = 0; i < 7; i += 1) {
      const decision = onOutcome(input("subject_failure", { httpStatus: 500, subjectState: state }));
      const breaker = decision.subjectBreaker!;
      steps.push({
        ms: breaker.breakerUntil!.getTime() - NOW.getTime(),
        blocked: breaker.blockedByVendorAt !== null,
        reason: decision.work.action === "reopen" ? decision.work.waitingReason : null,
      });
      expect(decision.work).toMatchObject({ action: "reopen", dueAt: breaker.breakerUntil, waitingUntil: breaker.breakerUntil });
      state = breaker;
    }
    expect(steps.map((s) => s.ms)).toEqual([MIN, 10 * MIN, HOUR, 6 * HOUR, 24 * HOUR, 24 * HOUR, 24 * HOUR]);
    expect(steps.map((s) => s.blocked)).toEqual([false, false, false, false, true, true, true]);
    expect(steps[3]!.reason).toBe("subject_breaker");
    expect(steps[4]!.reason).toBe("blocked_by_vendor");
    expect(SUBJECT_BLOCK_AFTER).toBe(5);
    expect(BLOCKED_PROBE_EVERY_MS).toBe(24 * HOUR);
  });

  it("keeps the first blocked instant on later failed probes", () => {
    const blockedAt = at(-3 * 24 * HOUR);
    const decision = onOutcome(input("subject_failure", {
      subjectState: { failureCount: 6, breakerUntil: at(-1), blockedByVendorAt: blockedAt },
    }));
    expect(decision.subjectBreaker?.blockedByVendorAt).toBe(blockedAt);
  });

  it("a 2xx without a success envelope is a subject failure", () => {
    const decision = onOutcome(input("envelope_unsuccessful"));
    expect(decision.attemptErrorClass).toBe("envelope_unsuccessful");
    expect(decision.subjectBreaker).toMatchObject({ failureCount: 1 });
  });

  it("a subject-queue walk breaks the queue subject and goes on with the next subject", () => {
    const decision = onOutcome(input("subject_failure", { subjectQueue: true }));
    expect(decision.subjectBreaker).toMatchObject({ failureCount: 1, breakerUntil: at(MIN) });
    expect(decision.work).toEqual({ action: "reopen", dueAt: null, waitingReason: null, waitingUntil: null });
  });

  it("a terminal answer closes the subject with a receipt and no breaker", () => {
    const decision = onOutcome(input("subject_terminal", { httpStatus: 410, subjectState: { failureCount: 2, breakerUntil: null, blockedByVendorAt: null } }));
    expect(decision.work).toEqual({ action: "close", closeReason: "subject_terminal:410" });
    expect(decision.subjectBreaker).toEqual({ failureCount: 0, breakerUntil: null, blockedByVendorAt: null, terminal: true });
    const queued = onOutcome(input("subject_terminal", { httpStatus: 410, subjectQueue: true }));
    expect(queued.work).toMatchObject({ action: "reopen" });
  });
});

describe("sync errors: resource breaker", () => {
  it(`holds the resource file at ${RESOURCE_BREAKER_SUBJECTS} failing subjects within the window: 30 min → 2 h → 6 h`, () => {
    expect(RESOURCE_BREAKER_WINDOW_MS).toBe(10 * MIN);
    const four = onOutcome(input("subject_failure", { recentFailedSubjects: 4 }));
    expect(four.resourceHold).toEqual({ action: "keep" });
    const first = onOutcome(input("subject_failure", { recentFailedSubjects: 5 }));
    expect(first.resourceHold).toEqual({ action: "set", file: "media-stats", until: at(30 * MIN), step: 1 });
    const expired = (step: number) => pageState({
      resourceHolds: { "media-stats": { until: at(-1).toISOString(), step, since: at(-HOUR).toISOString() } },
    });
    expect(onOutcome(input("subject_failure", { recentFailedSubjects: 5, page: expired(1) })).resourceHold)
      .toEqual({ action: "set", file: "media-stats", until: at(2 * HOUR), step: 2 });
    expect(onOutcome(input("subject_failure", { recentFailedSubjects: 5, page: expired(2) })).resourceHold)
      .toEqual({ action: "set", file: "media-stats", until: at(6 * HOUR), step: 3 });
    expect(onOutcome(input("subject_failure", { recentFailedSubjects: 5, page: expired(9) })).resourceHold)
      .toEqual({ action: "set", file: "media-stats", until: at(6 * HOUR), step: 10 });
  });

  it("an active hold is not re-taken", () => {
    const page = pageState({
      resourceHolds: { "media-stats": { until: at(MIN).toISOString(), step: 1, since: at(-MIN).toISOString() } },
    });
    expect(onOutcome(input("subject_failure", { recentFailedSubjects: 9, page })).resourceHold).toEqual({ action: "keep" });
  });

  it("never holds for, and never stops, dm-messages.head (live confirmations continue)", () => {
    const head = onOutcome(input("subject_failure", { resource: "dm-messages.head", recentFailedSubjects: 50 }));
    expect(head.resourceHold).toEqual({ action: "keep" });
    const catchup = onOutcome(input("subject_failure", { resource: "dm-messages.catchup", recentFailedSubjects: 5 }));
    expect(catchup.resourceHold).toMatchObject({ action: "set", file: "dm-messages" });
    const holds = { "dm-messages": { until: at(MIN).toISOString(), step: 1, since: NOW.toISOString() } };
    expect(activeResourceHold(holds, "dm-messages.head", NOW)).toBeNull();
    expect(activeResourceHold(holds, "dm-messages.catchup", NOW))
      .toEqual({ file: "dm-messages", until: at(MIN), step: 1, kind: "breaker" });
    expect(activeResourceHold(holds, "dm-messages.catchup", at(MIN))).toBeNull();
  });
});

describe("sync errors: the ladders are the plan's", () => {
  it("pins every constant of plan §9", () => {
    expect(SUBJECT_BREAKER_LADDER_MS).toEqual([MIN, 10 * MIN, HOUR, 6 * HOUR, 24 * HOUR]);
    expect(RESOURCE_HOLD_LADDER_MS).toEqual([30 * MIN, 2 * HOUR, 6 * HOUR]);
    expect(NETWORK_FAILURES_TO_PAUSE).toBe(3);
    expect(NETWORK_PAUSE_LADDER_MS).toEqual([10_000, 30_000, MIN, 2 * MIN, 5 * MIN]);
    expect(NETWORK_ALERT_AFTER_MS).toBe(10 * MIN);
  });
});
