import { describe, expect, it } from "vitest";

import { NEVER_CANONICALIZED_PARSE_VERSION, type SyncAttemptRow, type SyncWorkRow } from "@agency_hub_core/db";
import { fanslyWireSpec, type FanslyWireOutcome } from "@agency_hub_core/fansly";
import {
  FANSLY_DM_MESSAGE_SYNC_EXCLUDED_REASON_PARTNER_MISSING_FROM_AGGREGATION_ACCOUNTS,
} from "@agency_hub_core/shared";

import { CANONICALIZER_FAMILIES } from "../apps/runtime/src/services/canonicalize/index.ts";
import { classifyWireOutcome, onOutcome, type OutcomeDecision, type PageErrorState } from "../apps/runtime/src/sync/engine/errors.ts";
import type { PlanContext } from "../apps/runtime/src/sync/engine/resource.ts";
import { buildSyncExcludedCommandGroup, type SyncExcludedCliDeps } from "../apps/runtime/src/sync/cli/excluded.ts";
import {
  judgeExcludedProbe,
  liftRefusalOf,
  summarizeExcludedProbes,
} from "../apps/runtime/src/sync/excluded.ts";
import { fanslyResourceSpec } from "../apps/runtime/src/sync/fansly/registry.ts";
import {
  EXCLUDED_CHAT_PROBE_KEY,
  excludedChatProbeOutcome,
  probeExcludedChatModule,
} from "../apps/runtime/src/sync/fansly/resources/probe.ts";

// Owner decision №8 (step-3 design S3-06), the pure halves: what the probe of
// an excluded chat plans, which answers are the chat's own (closed `served:
// false`, nothing held) and which stay the page's (401, 429), how a probe
// batch is judged and when its verdict can lift an exclusion (E2), and the
// CLI's options.

const NOW = new Date("2026-10-02T12:00:00.000Z");
const CHAT = "710000000000000001";
const REASON = FANSLY_DM_MESSAGE_SYNC_EXCLUDED_REASON_PARTNER_MISSING_FROM_AGGREGATION_ACCOUNTS;

const page: PageErrorState = {
  holdKind: null,
  holdUntil: null,
  holdSince: null,
  holdStep: 0,
  holdDetail: {},
  networkFailureStreak: 0,
  resourceHolds: {},
  credentialsGeneration: "a".repeat(64),
};

function answer(status: number, body: unknown): FanslyWireOutcome {
  const bodyText = typeof body === "string" ? body : JSON.stringify(body);
  return { kind: "response", status, headers: {}, bodyText, bodyBytes: bodyText.length, sendMark: "request_start" };
}

/** The class the commit gives a probe's answer, with the entry's declarations. */
function classify(outcome: FanslyWireOutcome) {
  const spec = fanslyResourceSpec(EXCLUDED_CHAT_PROBE_KEY)!;
  return classifyWireOutcome(outcome, fanslyWireSpec("messages.page"), { groupId: CHAT, before: null }, {
    now: NOW,
    ...(spec.terminalStatuses === undefined ? {} : { terminalStatuses: spec.terminalStatuses }),
    ...(spec.subjectScopedAuthStatuses === undefined ? {} : { subjectScopedAuthStatuses: spec.subjectScopedAuthStatuses }),
  });
}

/** What the commit writes for an answer: `onOutcome`, then the probe's hook. */
function decide(outcome: FanslyWireOutcome): OutcomeDecision {
  const classified = classify(outcome);
  const decided = onOutcome({
    errorClass: classified.errorClass,
    now: NOW,
    resource: EXCLUDED_CHAT_PROBE_KEY,
    subject: CHAT,
    httpStatus: classified.httpStatus,
    retryAfterMs: classified.retryAfterMs,
    page,
    route: { route: "messages.page", entry: null, attemptId: 1, jitter: () => 0 },
    subjectState: { failureCount: 0, breakerUntil: null, blockedByVendorAt: null },
    subjectQueue: false,
    recentFailedSubjects: 6,
  });
  return excludedChatProbeOutcome(decided, {
    request: { spec: "messages.page", params: { groupId: CHAT, before: null } },
    httpStatus: classified.httpStatus,
    outcome: "response",
  });
}

describe("probe.excluded-chat", () => {
  it("is planned and subject-scoped on 403 only", () => {
    const spec = fanslyResourceSpec(EXCLUDED_CHAT_PROBE_KEY)!;
    expect(spec).toMatchObject({
      subject: "thread",
      kind: "trigger",
      class: "planned",
      triggers: ["owner"],
      evidence: false,
      fence: "none",
      subjectScopedAuthStatuses: [403],
      operations: ["messages.page"],
    });
  });

  it("plans one head read of the chat, never a `before` page", async () => {
    const work = { subject: CHAT } as SyncWorkRow;
    const ctx = { now: NOW } as unknown as PlanContext;
    await expect(probeExcludedChatModule.plan(work, ctx)).resolves.toEqual({
      kind: "request",
      request: { spec: "messages.page", params: { groupId: CHAT, before: null } },
    });
    await expect(probeExcludedChatModule.plan({ subject: "" } as SyncWorkRow, ctx)).resolves.toEqual({ kind: "quarantine", reason: "probe_without_chat" });
  });

  it("stamps a served answer above every canonicalizer family's version, so no sweep or bump replays it", () => {
    // `parse_version` is an integer column: the stamp is its maximum.
    expect(NEVER_CANONICALIZED_PARSE_VERSION).toBe(2 ** 31 - 1);
    for (const family of CANONICALIZER_FAMILIES) {
      expect(family.version, `${family.source}/${family.lane}`).toBeLessThan(NEVER_CANONICALIZED_PARSE_VERSION);
      expect(family.minimumParseVersion ?? 0, `${family.source}/${family.lane}`).toBeLessThan(NEVER_CANONICALIZED_PARSE_VERSION);
    }
  });

  it("a 403 is the chat's answer: closed `served: false`, no page hold, no breaker, no alert", () => {
    expect(classify(answer(403, { success: false })).errorClass).toBe("subject_terminal");
    const decided = decide(answer(403, { success: false }));
    expect(decided.pageHold).toEqual({ action: "keep" });
    expect(decided.work).toEqual({
      action: "close",
      closeReason: "not_served:403",
      result: { served: false, httpStatus: 403, errorClass: "subject_terminal" },
    });
    expect(decided.subjectBreaker).toMatchObject({ failureCount: 0, terminal: true });
    expect(decided.resourceHold).toEqual({ action: "keep" });
    expect(decided.alerts).toEqual([]);
  });

  it("a declared client status, a `success: false` envelope and a refused body close `served: false` too", () => {
    for (const status of [400, 404, 410, 422]) {
      expect(decide(answer(status, { success: false })).work, String(status))
        .toMatchObject({ action: "close", result: { served: false, httpStatus: status, errorClass: "subject_terminal" } });
    }
    const envelope = decide(answer(200, { success: false, error: { code: 1 } }));
    expect(envelope.work).toMatchObject({ action: "close", result: { served: false, httpStatus: 200, errorClass: "envelope_unsuccessful" } });
    expect(envelope.resourceHold).toEqual({ action: "keep" });
    expect(envelope.subjectBreaker).toMatchObject({ failureCount: 0, terminal: true });
    const refused = decide(answer(200, { success: true, response: { notMessages: [] } }));
    expect(refused).toMatchObject({
      quarantineAttempt: false,
      alerts: [],
      work: { action: "close", result: { served: false, httpStatus: 200, errorClass: "contract" } },
    });
  });

  it("a 401 stays the page's, a 429 its route's (never the probe's verdict); a 5xx is retried on the subject's ladder", () => {
    const auth = decide(answer(401, ""));
    expect(auth.pageHold).toMatchObject({ action: "set", kind: "auth" });
    expect(auth.work).toMatchObject({ action: "reopen", waitingReason: "page_hold" });
    expect(auth.alerts).toEqual([{ subKey: "page_stopped", detail: "auth" }]);
    const limited = decide(answer(429, ""));
    expect(limited.pageHold).toEqual({ action: "keep" });
    expect(limited.routeHold).toMatchObject({ action: "set", route: "messages.page" });
    expect(limited.work).toEqual({ action: "reopen", dueAt: null, waitingReason: null, waitingUntil: null });
    const failed = decide(answer(502, "bad gateway"));
    expect(failed.work).toMatchObject({ action: "reopen", waitingReason: "subject_breaker" });
    expect(decide(answer(200, { success: true, response: { messages: [] } })).work).toEqual({ action: "apply" });
  });
});

function work(overrides: Partial<SyncWorkRow>): SyncWorkRow {
  return {
    id: 1,
    pageId: 4,
    resource: EXCLUDED_CHAT_PROBE_KEY,
    subject: CHAT,
    kind: "trigger",
    class: "planned",
    state: "open",
    result: {},
    closeReason: null,
    ...overrides,
  } as SyncWorkRow;
}

function attempt(overrides: Partial<SyncAttemptRow>): SyncAttemptRow {
  return { id: 10, workId: 1, httpStatus: 200, errorClass: null, observationId: null, ...overrides } as SyncAttemptRow;
}

describe("a probe batch's verdict (E2)", () => {
  it("judges each probe by its row and attempts, with the evidence ids", () => {
    const served = judgeExcludedProbe(
      work({ id: 1, state: "done", closeReason: "served", result: { served: true, messages: 25, newestCreatedAt: "2026-10-02T11:00:00.000Z", liveIdsSeen: 2, observationId: 77 } }),
      [attempt({ id: 11, workId: 1, observationId: 77 })],
    );
    expect(served).toMatchObject({ verdict: "served", messages: 25, liveIdsSeen: 2, observationId: 77, attemptIds: [11], pageErrors: 0 });
    const refused = judgeExcludedProbe(
      work({ id: 2, state: "done", result: { served: false, httpStatus: 403, errorClass: "subject_terminal" } }),
      [attempt({ id: 12, workId: 2, httpStatus: 403, errorClass: "subject_terminal" })],
    );
    expect(refused).toMatchObject({ verdict: "not_served", httpStatus: 403, errorClass: "subject_terminal", pageErrors: 0 });
    // A 401 held the page: the probe waits, and the attempt is a page-level error.
    const held = judgeExcludedProbe(work({ id: 3, state: "open" }), [attempt({ id: 13, workId: 3, httpStatus: 401, errorClass: "auth" })]);
    expect(held).toMatchObject({ verdict: "pending", pageErrors: 1, httpStatus: 401 });
    expect(judgeExcludedProbe(work({ id: 4, state: "cancelled", closeReason: "rolled_back" }), []).verdict).toBe("no_answer");
    expect(judgeExcludedProbe(work({ id: 5, state: "quarantined" }), []).verdict).toBe("no_answer");

    expect(summarizeExcludedProbes(REASON, [served, refused, held])).toEqual({
      reason: REASON,
      probed: 3,
      served: 1,
      notServed: 1,
      pending: 1,
      unanswered: 0,
      pageErrors: 1,
      workIds: [1, 2, 3],
    });
  });

  it("lifts only with ≥ 10 probed chats, ≥ 80 % served and no page-level error", () => {
    expect(liftRefusalOf({ probed: 10, served: 8, pageErrors: 0 })).toBeNull();
    expect(liftRefusalOf({ probed: 20, served: 16, pageErrors: 0 })).toBeNull();
    expect(liftRefusalOf({ probed: 9, served: 9, pageErrors: 0 })).toMatch(/at least 10/);
    expect(liftRefusalOf({ probed: 20, served: 15, pageErrors: 0 })).toMatch(/15 of 20 .* 80 %/);
    expect(liftRefusalOf({ probed: 20, served: 20, pageErrors: 1 })).toMatch(/page-level/);
  });
});

class Opened extends Error {}

async function parse(argv: string[]) {
  let opened = 0;
  const deps: SyncExcludedCliDeps = {
    openContext: async () => {
      opened += 1;
      throw new Opened("opened");
    },
    print: () => undefined,
  };
  const error = await buildSyncExcludedCommandGroup(deps).parseAsync(argv, { from: "user" }).then(() => null, (failure: unknown) => failure);
  return { error, opened };
}

describe("sync excluded CLI", () => {
  it.each([
    [["excluded", "probe", "--page", "lilly-1"]],
    [["excluded", "probe", "--page", "lilly-1", "--sample", "20", "--reason", "partner_missing_from_aggregation_accounts"]],
    [["excluded", "report", "--page", "lilly-1"]],
    [["excluded", "report", "--page", "lilly-1", "--record"]],
    [["excluded", "lift", "--page", "ari-1", "--reason", "partner_missing_from_aggregation_accounts", "--evidence-page", "lilly-1"]],
    [["excluded", "unlift", "--page", "ari-1", "--reason", "partner_unresolvable_from_account_lookup"]],
  ])("parses %j and opens its context", async (argv) => {
    const { error, opened } = await parse(argv);
    expect(error).toBeInstanceOf(Opened);
    expect(opened).toBe(1);
  });

  it.each([
    [["excluded", "probe"], /--page/],
    [["excluded", "probe", "--page", "lilly-1", "--sample", "0"], /sample between 1 and 200/],
    [["excluded", "probe", "--page", "lilly-1", "--sample", "201"], /sample between 1 and 200/],
    [["excluded", "probe", "--page", "lilly-1", "--reason", "deleted"], /not a DM exclusion reason/],
    [["excluded", "lift", "--page", "ari-1", "--reason", "partner_missing_from_aggregation_accounts"], /--evidence-page/],
    [["excluded", "lift", "--page", "ari-1", "--evidence-page", "lilly-1"], /--reason/],
  ])("refuses %j before opening anything", async (argv, message) => {
    const { error, opened } = await parse(argv);
    expect(error).not.toBeInstanceOf(Opened);
    expect(String((error as Error).message)).toMatch(message);
    expect(opened).toBe(0);
  });
});
