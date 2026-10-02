import { describe, expect, it } from "vitest";

import { fanslyWireSpec, type FanslyWireOutcome } from "@agency_hub_core/fansly";

import {
  activePageHold,
  activeResourceHold,
  BLOCKED_PROBE_EVERY_MS,
  classifyWireOutcome,
  INDEFINITE_UNTIL,
  LIST_RATE_LIMIT_HELD_KEYS,
  LIST_RATE_LIMIT_LADDER_MS,
  LIST_RATE_LIMIT_LADDER_RESET_MS,
  listRateLimitHold,
  listRateLimitStep,
  NETWORK_ALERT_AFTER_MS,
  NETWORK_FAILURES_TO_PAUSE,
  NETWORK_PAUSE_LADDER_MS,
  onOutcome,
  RATE_LIMIT_HOLD_LADDER_MS,
  RATE_LIMIT_LADDER_RESET_MS,
  rateLimitStep,
  RESOURCE_BREAKER_SUBJECTS,
  RESOURCE_BREAKER_WINDOW_MS,
  RESOURCE_HOLD_LADDER_MS,
  SUBJECT_BLOCK_AFTER,
  SUBJECT_BREAKER_LADDER_MS,
  type OutcomeClass,
  type OutcomeInput,
  type PageErrorState,
  type ResourceHoldEntry,
} from "../apps/runtime/src/sync/engine/errors.ts";

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

  it("429 is the rate limit, with Retry-After in either wire form", () => {
    const seconds = classify(answer(429, "", { "retry-after": "120" }));
    expect(seconds).toMatchObject({ errorClass: "rate_limit", httpStatus: 429, retryAfterMs: 120_000 });
    const date = classify(answer(429, "", { "retry-after": at(90_000).toUTCString() }));
    expect(date).toMatchObject({ errorClass: "rate_limit", retryAfterMs: 90_000 });
    expect(classify(answer(429, "")).retryAfterMs).toBeNull();
  });

  it("401 and 403 are auth, even when a resource lists them as terminal", () => {
    expect(classify(answer(401, "")).errorClass).toBe("auth");
    expect(classify(answer(403, ""), [403]).errorClass).toBe("auth");
  });

  it("a 5xx naming its own deadline is the provider's pace (page-wide), not the subject's failure", () => {
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
    lastRateLimitAt: null,
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
  });

  it("clears an expired hold but keeps the 429 ladder within the hour", () => {
    const decision = onOutcome(input("ok", {
      page: pageState({ holdKind: "rate_limit", holdUntil: at(-1), holdStep: 2 }),
      lastRateLimitAt: at(-10 * MIN),
    }));
    expect(decision.pageHold).toEqual({ action: "clear", resetStep: false });
  });

  it("restarts the 429 ladder after an hour without a 429 ([A8])", () => {
    const decision = onOutcome(input("ok", {
      page: pageState({ holdStep: 3 }),
      lastRateLimitAt: at(-RATE_LIMIT_LADDER_RESET_MS),
    }));
    expect(decision.pageHold).toEqual({ action: "clear", resetStep: true });
  });

  it("never lifts a hold still in force", () => {
    const decision = onOutcome(input("ok", {
      page: pageState({ holdKind: "network", holdUntil: at(5_000), holdStep: 3 }),
      lastRateLimitAt: null,
    }));
    expect(decision.pageHold).toEqual({ action: "keep" });
  });

  it("clears an auth hold taken under older credentials", () => {
    const decision = onOutcome(input("ok", {
      page: pageState({
        holdKind: "auth",
        holdUntil: INDEFINITE_UNTIL,
        holdDetail: { credentialsGeneration: "gen-0" },
        credentialsGeneration: "gen-1",
      }),
    }));
    expect(decision.pageHold).toEqual({ action: "clear", resetStep: false });
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

describe("sync errors: rate limit", () => {
  it("holds the whole page 2 → 4 → 8 → 30 min without Retry-After, alerting every time", () => {
    let step = 0;
    let last: Date | null = null;
    const minutes: number[] = [];
    for (let i = 0; i < 5; i += 1) {
      const decision = onOutcome(input("rate_limit", {
        httpStatus: 429,
        page: pageState({ holdStep: step }),
        lastRateLimitAt: last,
      }));
      if (decision.pageHold.action !== "set" || decision.pageHold.until === "infinity") throw new Error("no hold");
      minutes.push((decision.pageHold.until.getTime() - NOW.getTime()) / MIN);
      expect(decision.pageHold.kind).toBe("rate_limit");
      expect(decision.alerts).toEqual([{ subKey: "page_stopped", detail: "rate_limit" }]);
      expect(decision.work).toMatchObject({ action: "reopen", waitingReason: "page_hold" });
      step = decision.pageHold.step;
      last = at(-MIN);
    }
    expect(minutes).toEqual([2, 4, 8, 30, 30]);
  });

  it("honours Retry-After as stated, longer or shorter than the ladder", () => {
    for (const retryAfterMs of [5_000, 3 * HOUR]) {
      const decision = onOutcome(input("rate_limit", { httpStatus: 429, retryAfterMs }));
      expect(decision.pageHold).toMatchObject({ action: "set", until: at(retryAfterMs), step: 1 });
    }
  });

  it("starts the ladder over after an hour without a 429", () => {
    expect(rateLimitStep(3, at(-RATE_LIMIT_LADDER_RESET_MS), NOW)).toBe(0);
    expect(rateLimitStep(3, at(-RATE_LIMIT_LADDER_RESET_MS + 1), NOW)).toBe(3);
    expect(rateLimitStep(3, null, NOW)).toBe(0);
  });
});

// Owner decision 2026-10-02 «редко + мягкий 429» (design §3.8 `rate_limit_list`,
// §5.3): the conversation list's quota is stricter than the page pause, so a
// 429 on it holds only the list; any other 429 still holds the page.
describe("sync errors: a 429 on the conversation list", () => {
  const listSpec = fanslyWireSpec("messaging.groups");
  const listHold = (entry: Partial<ResourceHoldEntry> & { until: string }): PageErrorState => pageState({
    resourceHolds: {
      "dm-conversations": { step: 1, since: at(-MIN).toISOString(), kind: "rate_limit_list", ...entry },
    },
  });

  it("is the list's rate limit; a 429 on any other route stays the page's", () => {
    const list = classifyWireOutcome(answer(429, "", { "retry-after": "7" }), listSpec, { offset: 0 }, { now: NOW });
    expect(list).toMatchObject({ errorClass: "rate_limit_list", httpStatus: 429, retryAfterMs: 7_000 });
    for (const id of ["group.detail", "messages.page", "transactions.page"] as const) {
      const params = id === "group.detail" ? { groupId: "1" } : id === "messages.page" ? { groupId: "1", before: null } : { limit: 20, offset: 0 };
      expect(classifyWireOutcome(answer(429, ""), fanslyWireSpec(id), params as never, { now: NOW }).errorClass, id).toBe("rate_limit");
    }
    // A list 5xx is still the subject's, and a list 5xx naming its deadline the page's pace.
    expect(classifyWireOutcome(answer(500, ""), listSpec, { offset: 0 }, { now: NOW }).errorClass).toBe("subject_failure");
    expect(classifyWireOutcome(answer(503, "", { "retry-after": "30" }), listSpec, { offset: 0 }, { now: NOW }).errorClass)
      .toBe("rate_limit");
  });

  it("holds only the list, never the page: 5 → 10 → 20 → 40 → 80 → 160 → 300 s by consecutive list 429s", () => {
    let entry: ResourceHoldEntry | undefined;
    const seconds: number[] = [];
    const alerted: boolean[] = [];
    for (let i = 0; i < 9; i += 1) {
      const decision = onOutcome(input("rate_limit_list", {
        resource: "dm-conversations.full",
        subject: "",
        httpStatus: 429,
        page: pageState({ resourceHolds: entry === undefined ? {} : { "dm-conversations": entry } }),
      }));
      expect(decision.pageHold).toEqual({ action: "keep" });
      if (decision.resourceHold.action !== "set") throw new Error("no list hold");
      expect(decision.resourceHold).toMatchObject({ file: "dm-conversations", kind: "rate_limit_list", lastRateLimitAt: NOW });
      // Due again at the hold's end, not before: the held row never looks due to the idle actor.
      expect(decision.work).toEqual({
        action: "reopen", dueAt: decision.resourceHold.until, waitingReason: "resource_hold", waitingUntil: decision.resourceHold.until,
      });
      seconds.push((decision.resourceHold.until.getTime() - NOW.getTime()) / 1_000);
      alerted.push(decision.alerts.length > 0);
      // The hold ran out before the next try (the next try is never sooner).
      entry = {
        until: at(-1).toISOString(),
        step: decision.resourceHold.step,
        since: NOW.toISOString(),
        kind: "rate_limit_list",
        lastRateLimitAt: at(-1_000).toISOString(),
      };
    }
    expect(seconds).toEqual([5, 10, 20, 40, 80, 160, 300, 300, 300]);
    // Alert 1 only once the hold reaches the top step (sustained).
    expect(alerted).toEqual([false, false, false, false, false, false, true, true, true]);
    const top = onOutcome(input("rate_limit_list", { resource: "dm-conversations.head", httpStatus: 429, page: pageState({
      resourceHolds: { "dm-conversations": { ...entry!, step: 6 } },
    }) }));
    expect(top.alerts).toEqual([{ subKey: "page_stopped", detail: "rate_limit_list" }]);
  });

  it("starts the list ladder over after 10 minutes without a list 429", () => {
    expect(LIST_RATE_LIMIT_LADDER_RESET_MS).toBe(10 * MIN);
    const entry = (lastAgoMs: number): ResourceHoldEntry => ({
      until: at(-lastAgoMs + 5_000).toISOString(), step: 4, since: at(-HOUR).toISOString(),
      kind: "rate_limit_list", lastRateLimitAt: at(-lastAgoMs).toISOString(),
    });
    expect(listRateLimitStep(entry(LIST_RATE_LIMIT_LADDER_RESET_MS - 1), NOW)).toBe(4);
    expect(listRateLimitStep(entry(LIST_RATE_LIMIT_LADDER_RESET_MS), NOW)).toBe(0);
    expect(listRateLimitStep(undefined, NOW)).toBe(0);
    // A breaker entry of the file is not a list ladder.
    expect(listRateLimitStep({ until: at(MIN).toISOString(), step: 2, since: NOW.toISOString() }, NOW)).toBe(0);
    const decision = onOutcome(input("rate_limit_list", {
      resource: "dm-conversations.head", httpStatus: 429,
      page: pageState({ resourceHolds: { "dm-conversations": entry(LIST_RATE_LIMIT_LADDER_RESET_MS) } }),
    }));
    expect(decision.resourceHold).toMatchObject({ action: "set", until: at(5_000), step: 1 });
  });

  it("honours Retry-After as stated, and never shortens a list hold in force", () => {
    const stated = onOutcome(input("rate_limit_list", { resource: "dm-conversations.head", httpStatus: 429, retryAfterMs: 42_000 }));
    expect(stated.resourceHold).toMatchObject({ action: "set", until: at(42_000), step: 1 });
    const short = onOutcome(input("rate_limit_list", {
      resource: "dm-conversations.find", httpStatus: 429, retryAfterMs: 1_000,
      page: listHold({ until: at(30_000).toISOString(), lastRateLimitAt: at(-1_000).toISOString() }),
    }));
    expect(short.resourceHold).toMatchObject({ action: "set", until: at(30_000), step: 2 });
  });

  it("lets .find go on at once: its next step is the group detail", () => {
    const decision = onOutcome(input("rate_limit_list", { resource: "dm-conversations.find", subject: "g1", httpStatus: 429 }));
    expect(decision.work).toEqual({ action: "reopen", dueAt: null, waitingReason: null, waitingUntil: null });
    expect(decision.resourceHold).toMatchObject({ action: "set", kind: "rate_limit_list" });
  });

  it("stops only the keys that can only read the list", () => {
    const holds = { "dm-conversations": { until: at(5_000).toISOString(), step: 1, since: NOW.toISOString(), kind: "rate_limit_list" as const } };
    for (const key of LIST_RATE_LIMIT_HELD_KEYS) {
      expect(activeResourceHold(holds, key, NOW), key)
        .toEqual({ file: "dm-conversations", until: at(5_000), step: 1, kind: "rate_limit_list" });
    }
    for (const key of ["dm-conversations.find", "dm-conversations.detail", "dm-messages.head", "dm-messages.catchup", "transactions.head"]) {
      expect(activeResourceHold(holds, key, NOW), key).toBeNull();
    }
    expect(activeResourceHold(holds, "dm-conversations.head", at(5_000))).toBeNull();
    expect(listRateLimitHold(holds, NOW)).toEqual({ until: at(5_000), step: 1 });
    expect(listRateLimitHold(holds, at(5_000))).toBeNull();
  });

  it("keeps an expired list hold on the row until its ladder resets", () => {
    const recent = listHold({ until: at(-1).toISOString(), lastRateLimitAt: at(-MIN).toISOString() });
    expect(onOutcome(input("ok", { resource: "dm-conversations.head", page: recent })).resourceHold).toEqual({ action: "keep" });
    const quiet = listHold({ until: at(-1).toISOString(), lastRateLimitAt: at(-LIST_RATE_LIMIT_LADDER_RESET_MS).toISOString() });
    expect(onOutcome(input("ok", { resource: "dm-conversations.detail", page: quiet })).resourceHold)
      .toEqual({ action: "clear", file: "dm-conversations" });
  });

  it("a breaker of the file stops more for longer: a list 429 keeps it, the breaker replaces a list hold", () => {
    const breaker = pageState({
      resourceHolds: { "dm-conversations": { until: at(20 * MIN).toISOString(), step: 1, since: NOW.toISOString() } },
    });
    const kept = onOutcome(input("rate_limit_list", { resource: "dm-conversations.find", httpStatus: 429, page: breaker }));
    expect(kept.resourceHold).toEqual({ action: "keep" });
    const keptHead = onOutcome(input("rate_limit_list", { resource: "dm-conversations.head", httpStatus: 429, page: breaker }));
    expect(keptHead.resourceHold).toEqual({ action: "keep" });
    expect(keptHead.work).toEqual({ action: "reopen", dueAt: at(20 * MIN), waitingReason: "resource_hold", waitingUntil: at(20 * MIN) });
    const listInForce = listHold({ until: at(10_000).toISOString(), lastRateLimitAt: NOW.toISOString() });
    const escalated = onOutcome(input("subject_failure", { resource: "dm-conversations.detail", recentFailedSubjects: 5, page: listInForce }));
    expect(escalated.resourceHold).toEqual({ action: "set", file: "dm-conversations", until: at(30 * MIN), step: 1 });
  });

  it("pins the owner's list constants", () => {
    expect(LIST_RATE_LIMIT_LADDER_MS).toEqual([5_000, 10_000, 20_000, 40_000, 80_000, 160_000, 300_000]);
  });
});

describe("sync errors: auth and identity", () => {
  it("auth holds the page until new credentials and alerts at once", () => {
    const decision = onOutcome(input("auth", { httpStatus: 401 }));
    expect(decision.pageHold).toEqual({
      action: "set",
      kind: "auth",
      until: "infinity",
      step: 0,
      detail: { status: 401, credentialsGeneration: "gen-1" },
    });
    expect(decision.alerts).toEqual([{ subKey: "page_stopped", detail: "auth" }]);
  });

  it("an identity mismatch holds the page, quarantines the work, and raises alerts 1 and 2", () => {
    const decision = onOutcome(input("identity_mismatch"));
    expect(decision.pageHold).toMatchObject({ action: "set", kind: "identity_mismatch", until: "infinity" });
    expect(decision.work).toEqual({ action: "quarantine", reason: "identity_mismatch" });
    expect(decision.quarantineAttempt).toBe(true);
    expect(decision.alerts.map((a) => a.subKey)).toEqual(["page_stopped", "live_degraded"]);
  });

  it("an auth hold is in force until the credentials generation changes", () => {
    const held = { holdKind: "auth" as const, holdUntil: INDEFINITE_UNTIL, holdDetail: { credentialsGeneration: "gen-1" } };
    expect(activePageHold({ ...held, credentialsGeneration: "gen-1" }, NOW)).toEqual({ kind: "auth", until: INDEFINITE_UNTIL });
    expect(activePageHold({ ...held, credentialsGeneration: "gen-2" }, NOW)).toBeNull();
    expect(activePageHold({ ...held, credentialsGeneration: null }, NOW)).not.toBeNull();
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
    expect(RATE_LIMIT_HOLD_LADDER_MS).toEqual([2 * MIN, 4 * MIN, 8 * MIN, 30 * MIN]);
    expect(RATE_LIMIT_LADDER_RESET_MS).toBe(HOUR);
    expect(SUBJECT_BREAKER_LADDER_MS).toEqual([MIN, 10 * MIN, HOUR, 6 * HOUR, 24 * HOUR]);
    expect(RESOURCE_HOLD_LADDER_MS).toEqual([30 * MIN, 2 * HOUR, 6 * HOUR]);
    expect(NETWORK_FAILURES_TO_PAUSE).toBe(3);
    expect(NETWORK_PAUSE_LADDER_MS).toEqual([10_000, 30_000, MIN, 2 * MIN, 5 * MIN]);
    expect(NETWORK_ALERT_AFTER_MS).toBe(10 * MIN);
  });
});
