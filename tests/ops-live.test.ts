import { describe, expect, it } from "vitest";

import { opsLiveQuerySchema, opsLiveResponseSchema, routeSchemas } from "@agency_hub_core/contracts";
import { INSTANCE_STALE_TTL_MS, type OpsLiveAttemptRow, type SyncHoldRow } from "@agency_hub_core/db";
import { INDEFINITE_UNTIL } from "@agency_hub_core/shared";

import { buildRoutePolicyIndex, computeAuthPolicyVerdict } from "../apps/runtime/src/api/auth-policy.ts";
import type { AgentAuthPrincipal, AuthPrincipal, HumanAuthPrincipal } from "../apps/runtime/src/services/auth.ts";
import {
  OPS_LIVE_CURSOR_OVERLAP_MS,
  OPS_LIVE_FEED_WINDOW_MS,
  OPS_LIVE_MAX_ATTEMPTS,
  OPS_LIVE_OPEN_WINDOW_MS,
  cachedRead,
  decodeOpsLiveCursor,
  encodeOpsLiveCursor,
  opsLiveAttemptsOf,
  opsLiveFeedWindow,
  opsLiveHoldsOf,
  opsLiveProcessesOf,
  opsLiveRevision,
  opsLiveSummaryOf,
  opsLiveWaitingOf,
} from "../apps/runtime/src/services/ops-live.ts";
import { WAITING_REASONS, type QueueStatus } from "../apps/runtime/src/sync/engine/status.ts";
import { routeBudget } from "../apps/runtime/src/sync/fansly/routes.ts";
import { pageHoldRow, resourceBreakerRow, routeHoldRows } from "./helpers/sync-holds.ts";

/**
 * `GET /api/v1/ops/live` without a database: the cursor and the window it
 * opens, the feed's order and cap, what a page's holds and queue become on
 * the wire, the two caches' clock, and who the declaration admits.
 */

const NOW = new Date("2026-10-11T03:12:45.123Z");

function ago(ms: number): Date {
  return new Date(NOW.getTime() - ms);
}

describe("cursor", () => {
  it("round-trips the instant it was issued, in the contract's alphabet", () => {
    const cursor = encodeOpsLiveCursor(NOW);
    expect(cursor).toMatch(/^[A-Za-z0-9_-]{1,200}$/);
    expect(decodeOpsLiveCursor(cursor)).toEqual({ issuedAt: NOW, openSince: null });
  });

  it("carries the send instant of the oldest request that was unanswered when it was issued", () => {
    const cursor = encodeOpsLiveCursor(NOW, ago(40 * 60_000));
    expect(cursor).toMatch(/^[A-Za-z0-9_-]{1,200}$/);
    expect(decodeOpsLiveCursor(cursor)).toEqual({ issuedAt: NOW, openSince: ago(40 * 60_000) });
  });

  it("reads nothing it did not issue: such a cursor is as good as absent", () => {
    for (const unreadable of [
      undefined, null, 42, ["t2-abc"], "", "garbage", "t3-abc", "t2-", "t2-ABC", "t2-abc def",
      `t2-${"z".repeat(11)}`, `t2-${"a".repeat(200)}`, "../../etc/passwd", "t2--1", "t2-abc-", "t2-abc-ABC", "t2-abc-def-ghi",
      // The first form of the cursor, from the build before this one.
      "t1-abc", encodeOpsLiveCursor(NOW).replace("t2-", "t1-"),
    ]) {
      expect(decodeOpsLiveCursor(unreadable), String(unreadable)).toBeNull();
    }
  });
});

describe("feed window", () => {
  const cursor = (issuedAgoMs: number, openSinceAgoMs: number | null = null) => ({
    issuedAt: ago(issuedAgoMs),
    openSince: openSinceAgoMs === null ? null : ago(openSinceAgoMs),
  });

  it("without a cursor: the requests sent in the last ten minutes", () => {
    const window = opsLiveFeedWindow(null, NOW);
    expect(window).toEqual({ sentAfter: ago(OPS_LIVE_FEED_WINDOW_MS), changedAfter: ago(OPS_LIVE_FEED_WINDOW_MS) });
  });

  it("with a cursor: sent or completed since 30 seconds before it was issued", () => {
    const window = opsLiveFeedWindow(cursor(2_000), NOW);
    expect(window.changedAfter).toEqual(ago(2_000 + OPS_LIVE_CURSOR_OVERLAP_MS));
    // A request sent up to ten minutes before that still comes when it completes.
    expect(window.sentAfter).toEqual(ago(2_000 + OPS_LIVE_CURSOR_OVERLAP_MS + OPS_LIVE_FEED_WINDOW_MS));
  });

  it("reaches back to a request that was unanswered when the cursor was issued, itself included", () => {
    // Sent 40 minutes ago and unanswered two seconds ago: answered now, by a
    // sync that came back and closed what it had left open.
    const window = opsLiveFeedWindow(cursor(2_000, 40 * 60_000), NOW);
    expect(window.changedAfter).toEqual(ago(2_000 + OPS_LIVE_CURSOR_OVERLAP_MS));
    // The feed reads what was sent strictly after its floor.
    expect(window.sentAfter).toEqual(ago(40 * 60_000 + 1));
    // An unanswered request younger than the ordinary reach changes nothing.
    expect(opsLiveFeedWindow(cursor(2_000, 60_000), NOW)).toEqual(opsLiveFeedWindow(cursor(2_000), NOW));
  });

  it("never reaches further back than an hour, whatever the cursor says", () => {
    expect(opsLiveFeedWindow(cursor(2_000, 5 * 3_600_000), NOW).sentAfter).toEqual(ago(OPS_LIVE_OPEN_WINDOW_MS));
    // A caller that was away for 55 minutes: its cursor still counts, and
    // ten minutes before it is already past the hour.
    const away = opsLiveFeedWindow(cursor(55 * 60_000), NOW);
    expect(away.changedAfter).toEqual(ago(55 * 60_000 + OPS_LIVE_CURSOR_OVERLAP_MS));
    expect(away.sentAfter).toEqual(ago(OPS_LIVE_OPEN_WINDOW_MS));
  });

  it("a caller that was away for a quarter of an hour is told what completed meanwhile", () => {
    const window = opsLiveFeedWindow(cursor(15 * 60_000), NOW);
    expect(window.changedAfter).toEqual(ago(15 * 60_000 + OPS_LIVE_CURSOR_OVERLAP_MS));
    expect(window.sentAfter).toEqual(ago(15 * 60_000 + OPS_LIVE_CURSOR_OVERLAP_MS + OPS_LIVE_FEED_WINDOW_MS));
  });

  it("a cursor from the future counts as issued now", () => {
    expect(opsLiveFeedWindow({ issuedAt: new Date(NOW.getTime() + 3_600_000), openSince: null }, NOW).changedAfter).toEqual(ago(OPS_LIVE_CURSOR_OVERLAP_MS));
  });

  it("a cursor older than an hour is answered as if it were absent", () => {
    expect(opsLiveFeedWindow(cursor(OPS_LIVE_OPEN_WINDOW_MS + 1), NOW)).toEqual(opsLiveFeedWindow(null, NOW));
    expect(opsLiveFeedWindow(cursor(24 * 3_600_000, 25 * 3_600_000), NOW)).toEqual(opsLiveFeedWindow(null, NOW));
    // At the hour exactly it is still a cursor.
    expect(opsLiveFeedWindow(cursor(OPS_LIVE_OPEN_WINDOW_MS), NOW).changedAfter).toEqual(ago(OPS_LIVE_OPEN_WINDOW_MS + OPS_LIVE_CURSOR_OVERLAP_MS));
  });
});

describe("processes", () => {
  const instance = (role: string, lastSeenAgoMs: number, startedAgoMs = 3_600_000) => ({
    role,
    startedAt: ago(startedAgoMs),
    lastSeenAt: ago(lastSeenAgoMs),
  });

  it("is one row per role Hub runs, in its order, and a role without a single instance is missing", () => {
    expect(opsLiveProcessesOf([], NOW)).toEqual(
      ["api", "worker", "scheduler", "sync"].map((role) => ({ role, state: "missing", startedAt: null, lastSeenAt: null })),
    );
    const rows = opsLiveProcessesOf([instance("sync", 20_000), instance("api", 30_000)], NOW);
    expect(rows.map((row) => [row.role, row.state])).toEqual([
      ["api", "active"], ["worker", "missing"], ["scheduler", "missing"], ["sync", "active"],
    ]);
    expect(rows[0]).toEqual({ role: "api", state: "active", startedAt: ago(3_600_000).toISOString(), lastSeenAt: ago(30_000).toISOString() });
  });

  it("takes a role's freshest instance: the row a killed process left behind does not make its successor silent", () => {
    // Killed twenty minutes ago; its successor beats. The table keeps both
    // rows for half an hour.
    const rows = opsLiveProcessesOf([instance("api", 20 * 60_000, 5 * 3_600_000), instance("api", 15_000, 19 * 60_000)], NOW);
    expect(rows.filter((row) => row.role === "api")).toEqual([
      { role: "api", state: "active", startedAt: ago(19 * 60_000).toISOString(), lastSeenAt: ago(15_000).toISOString() },
    ]);
  });

  it("says stale when the freshest has not beaten within the stale window", () => {
    const state = (lastSeenAgoMs: number) => opsLiveProcessesOf([instance("worker", lastSeenAgoMs)], NOW)[1]!.state;
    expect(state(INSTANCE_STALE_TTL_MS)).toBe("active");
    expect(state(INSTANCE_STALE_TTL_MS + 1)).toBe("stale");
  });

  it("lists a role Hub does not know after its own, by name", () => {
    const rows = opsLiveProcessesOf([instance("zeta", 1_000), instance("board", 1_000), instance("api", 1_000)], NOW);
    expect(rows.map((row) => row.role)).toEqual(["api", "worker", "scheduler", "sync", "board", "zeta"]);
  });
});

function attemptRow(overrides: Partial<OpsLiveAttemptRow> = {}): OpsLiveAttemptRow {
  return {
    journal: "engine",
    id: 1,
    pageLabel: "lora-1",
    resource: "subscribers.poll",
    operation: "subscribers.page",
    class: "planned",
    sentAt: ago(60_000),
    completedAt: ago(59_900),
    failed: false,
    httpStatus: 200,
    durationMs: 100,
    responseBytes: 3158,
    ...overrides,
  };
}

describe("attempts", () => {
  it("merges both journals by send time, oldest first, with ids that cannot collide", () => {
    const attempts = opsLiveAttemptsOf([
      attemptRow({ id: 7, sentAt: ago(10_000) }),
      attemptRow({ journal: "legacy", id: 7, sentAt: ago(20_000), class: null, resource: "transactions", operation: "list" }),
      attemptRow({ id: 8, sentAt: ago(5_000), completedAt: null, httpStatus: null, durationMs: null, responseBytes: null }),
    ]);
    expect(attempts.map((attempt) => attempt.id)).toEqual(["l7", "e7", "e8"]);
    expect(attempts[0]).toEqual({
      id: "l7",
      page: "lora-1",
      resource: "transactions",
      operation: "list",
      class: null,
      sentAt: ago(20_000).toISOString(),
      completedAt: ago(59_900).toISOString(),
      failed: false,
      httpStatus: 200,
      durationMs: 100,
      responseBytes: 3158,
    });
    expect(attempts[2]).toMatchObject({ completedAt: null, httpStatus: null, durationMs: null, responseBytes: null });
  });

  it("keeps the newest 2000 and drops the oldest first", () => {
    const rows = Array.from({ length: OPS_LIVE_MAX_ATTEMPTS + 50 }, (_, index) =>
      attemptRow({ id: index + 1, sentAt: ago((OPS_LIVE_MAX_ATTEMPTS + 50 - index) * 100) }));
    const attempts = opsLiveAttemptsOf(rows);
    expect(attempts).toHaveLength(OPS_LIVE_MAX_ATTEMPTS);
    expect(attempts[0]!.id).toBe("e51");
    expect(attempts.at(-1)!.id).toBe(`e${OPS_LIVE_MAX_ATTEMPTS + 50}`);
  });
});

describe("holds", () => {
  const until = new Date(NOW.getTime() + 60_000);

  it("lists what is in force now by scope and kind — never the hold's key", () => {
    const holds = opsLiveHoldsOf([
      pageHoldRow("network", until),
      pageHoldRow("auth", INDEFINITE_UNTIL),
      resourceBreakerRow("dm-messages", until),
      // Ended: not in force.
      resourceBreakerRow("followers", ago(1_000)),
      ...routeHoldRows("messages.page", { holdUntil: until.toISOString(), ladderStep: 2, effectivePerMin: 0.5 }),
    ], NOW);
    expect(holds).toEqual([
      { scope: "page", kind: "network", until: until.toISOString() },
      // A credentials hold has no end: only an identity proof lifts it.
      { scope: "page", kind: "auth", until: null },
      { scope: "resource", kind: "resource_breaker", until: until.toISOString() },
      // The route's slowdown after its 429s has no end either.
      { scope: "route", kind: "route_budget", until: null },
      { scope: "route", kind: "route_hold", until: until.toISOString() },
    ]);
    expect(JSON.stringify(holds)).not.toMatch(/messages\.page|dm-messages|followers/);
  });

  it("a route's state row is a hold only while it slows the route below its budget", () => {
    const budget = routeBudget("messages.page").currentPerMin;
    const kinds = (rows: SyncHoldRow[]) => opsLiveHoldsOf(rows, NOW).map((hold) => hold.kind);
    // Kept for the ladder's sake after a 429 whose hold has ended: nothing holds the route.
    expect(kinds(routeHoldRows("messages.page", { ladderStep: 3, holdUntil: ago(1_000).toISOString() }))).toEqual([]);
    expect(kinds(routeHoldRows("messages.page", { ladderStep: 3, effectivePerMin: budget }))).toEqual([]);
    expect(kinds(routeHoldRows("messages.page", { ladderStep: 3, effectivePerMin: budget / 2 }))).toEqual(["route_budget"]);
    // Rows this build cannot read as a route's state are listed as stored.
    expect(kinds(routeHoldRows("a.route-of-a-later-build", { ladderStep: 1 }))).toEqual(["route_budget"]);
    expect(kinds([
      ...routeHoldRows("messages.page", { ladderStep: 1 }),
      { ...routeHoldRows("messages.page")[0]!, kind: "route_kind_of_a_later_build", until },
    ])).toEqual(["route_budget", "route_kind_of_a_later_build"]);
  });
});

describe("waiting", () => {
  it("sums the engine's queue status over the classes, in the dictionary's order", () => {
    const queue: QueueStatus = {
      urgent: { runnable: 1, waitingByReason: { class_share: 1, running: 1 } },
      requests: { runnable: 0, waitingByReason: { paused: 3 } },
      planned: { runnable: 2, waitingByReason: { not_due: 5, class_share: 2, route_hold: 1 } },
    };
    const waiting = opsLiveWaitingOf(queue);
    expect(waiting).toEqual([
      { reason: "not_due", count: 5 },
      { reason: "class_share", count: 3 },
      { reason: "route_hold", count: 1 },
      { reason: "paused", count: 3 },
      { reason: "running", count: 1 },
    ]);
    const order = waiting.map((entry) => WAITING_REASONS.indexOf(entry.reason));
    expect(order).toEqual([...order].sort((left, right) => left - right));
  });

  it("is empty for a page without open work", () => {
    const empty = { runnable: 0, waitingByReason: {} };
    expect(opsLiveWaitingOf({ urgent: empty, requests: empty, planned: empty })).toEqual([]);
  });
});

describe("incident summary", () => {
  it("is at most 160 characters and never half of a surrogate pair", () => {
    expect(opsLiveSummaryOf(null)).toBe("");
    expect(opsLiveSummaryOf("short")).toBe("short");
    expect(opsLiveSummaryOf("x".repeat(500))).toBe("x".repeat(160));
    const split = `${"x".repeat(159)}😀tail`;
    expect(opsLiveSummaryOf(split)).toBe("x".repeat(159));
    expect(opsLiveSummaryOf(`${"x".repeat(158)}😀tail`)).toBe(`${"x".repeat(158)}😀`);
  });
});

describe("revision", () => {
  it("is the source revision the image was built from, or null when the build does not say", () => {
    expect(opsLiveRevision({ GIT_SHA: "2260ef739aa0" })).toBe("2260ef739aa0");
    expect(opsLiveRevision({ GIT_SHA: "unknown" })).toBeNull();
    expect(opsLiveRevision({ GIT_SHA: "" })).toBeNull();
    expect(opsLiveRevision({})).toBeNull();
  });
});

describe("cachedRead", () => {
  it("reads once per interval and again when it has passed", async () => {
    let clock = 1_000;
    let reads = 0;
    const read = cachedRead(async () => ++reads, 2_000, () => clock);
    expect(await read()).toBe(1);
    clock += 1_999;
    expect(await read()).toBe(1);
    clock += 1;
    expect(await read()).toBe(2);
    expect(reads).toBe(2);
  });

  it("lets concurrent callers share one read", async () => {
    let reads = 0;
    let release: (value: number) => void = () => undefined;
    const read = cachedRead(() => {
      reads += 1;
      return new Promise<number>((resolve) => { release = resolve; });
    }, 2_000, () => 0);
    const both = Promise.all([read(), read(), read()]);
    release(7);
    expect(await both).toEqual([7, 7, 7]);
    expect(reads).toBe(1);
  });

  it("does not keep a failed read", async () => {
    let reads = 0;
    const read = cachedRead(async () => {
      reads += 1;
      if (reads === 1) throw new Error("database is away");
      return "ok";
    }, 2_000, () => 0);
    await expect(read()).rejects.toThrow("database is away");
    expect(await read()).toBe("ok");
  });
});

function human(authMethod: HumanAuthPrincipal["authMethod"], role: HumanAuthPrincipal["user"]["role"]): HumanAuthPrincipal {
  return {
    authMethod,
    user: { id: 1, username: "grid", role, mustChangePassword: false, assignedPages: [] },
    assignedPageIds: [],
  };
}

const agentKey: AgentAuthPrincipal = {
  kind: "agent",
  authMethod: "agent_key",
  agentKeyId: 9,
  keyName: "reader",
  capabilities: ["read:datasets"],
  pageIds: [1],
};

describe("declaration", () => {
  // The declaration as the server binds it to the route.
  const auth = buildRoutePolicyIndex().get(routeSchemas.opsLive)!.auth!;

  function verdict(input: { principal?: AuthPrincipal | null; monitoringToken?: boolean }) {
    return computeAuthPolicyVerdict({
      auth,
      resolvePrincipal: async () => {
        if (input.principal === undefined) throw new Error("the monitoring token must answer before any principal");
        return input.principal;
      },
      resolvePendingDeviceToken: async () => false,
      hasMonitoringToken: () => input.monitoringToken ?? false,
      resolvePageAccess: async () => { throw new Error("no page scope on this route"); },
      pageLabelParam: undefined,
    });
  }

  it("is the monitoring kind narrowed to the owner", () => {
    expect(auth).toEqual({ kind: "monitoring", roles: ["owner"] });
  });

  it("admits the monitoring token without resolving a principal, and the owner's dashboard session", async () => {
    await expect(verdict({ monitoringToken: true })).resolves.toEqual({ allow: true });
    await expect(verdict({ principal: human("session", "owner") })).resolves.toEqual({ allow: true });
  });

  it("refuses every other caller: the other dashboard roles, bearers, an agent key, nobody", async () => {
    await expect(verdict({ principal: human("session", "team_lead") }))
      .resolves.toEqual({ allow: false, statusCode: 403, reason: "role_not_allowed" });
    await expect(verdict({ principal: human("session", "chatter") })).resolves.toMatchObject({ allow: false, statusCode: 403 });
    await expect(verdict({ principal: { ...human("device_token", "owner"), deviceTokenId: 3 } }))
      .resolves.toMatchObject({ allow: false, statusCode: 403 });
    await expect(verdict({ principal: agentKey })).resolves.toMatchObject({ allow: false, statusCode: 403 });
    await expect(verdict({ principal: null })).resolves.toEqual({ allow: false, statusCode: 401, reason: "no_principal" });
  });
});

describe("wire schema", () => {
  const answer = {
    generatedAt: NOW.toISOString(),
    revision: null,
    processes: [],
    pages: [],
    attempts: [],
    queue: { waiting: 0, active: 0, failedLastHour: 0, deadLetters: 0, oldestWaitingAgeMs: null },
    incidents: [],
    nextCursor: encodeOpsLiveCursor(NOW),
  };

  it("accepts an empty answer", () => {
    expect(opsLiveResponseSchema.parse(answer)).toEqual(answer);
  });

  it("takes a role in one of three states, without instants when it is missing", () => {
    const processes = opsLiveProcessesOf([{ role: "api", startedAt: ago(60_000), lastSeenAt: ago(1_000) }], NOW);
    expect(opsLiveResponseSchema.parse({ ...answer, processes }).processes).toEqual(processes);
    expect(opsLiveResponseSchema.safeParse({ ...answer, processes: [{ ...processes[0], state: "quiet" }] }).success).toBe(false);
    expect(opsLiveResponseSchema.safeParse({ ...answer, processes: [{ ...processes[0], instanceId: "api-1" }] }).success).toBe(false);
  });

  it("takes an unknown count of active jobs as null, never as a number it is not", () => {
    expect(opsLiveResponseSchema.parse({ ...answer, queue: { ...answer.queue, active: null } }).queue.active).toBeNull();
    expect(opsLiveResponseSchema.safeParse({ ...answer, queue: { ...answer.queue, waiting: null } }).success).toBe(false);
  });

  it("refuses a field the contract does not name, at every level", () => {
    const attempt = opsLiveAttemptsOf([attemptRow()])[0]!;
    expect(opsLiveResponseSchema.safeParse({ ...answer, attempts: [attempt] }).success).toBe(true);
    for (const leak of [{ subject: "810272281019305984" }, { request: { groupId: "1" } }, { errorMessage: "boom" }]) {
      expect(opsLiveResponseSchema.safeParse({ ...answer, attempts: [{ ...attempt, ...leak }] }).success, JSON.stringify(leak)).toBe(false);
    }
    const page = {
      label: "lora-1", platform: "fansly", engine: true, pausedAll: false, pausedRequests: false, pausedResources: [],
      holds: [{ scope: "route", kind: "route_hold", until: null }], openWork: 0, dueNow: 0, nextDueAt: null, waiting: [], lastSentAt: null,
    };
    expect(opsLiveResponseSchema.safeParse({ ...answer, pages: [page] }).success).toBe(true);
    expect(opsLiveResponseSchema.safeParse({
      ...answer, pages: [{ ...page, holds: [{ scope: "route", kind: "route_hold", until: null, key: "messages.list" }] }],
    }).success).toBe(false);
    expect(opsLiveResponseSchema.safeParse({ ...answer, debug: true }).success).toBe(false);
  });

  it("names a waiting reason only from the engine's dictionary", () => {
    const page = {
      label: "lora-1", platform: "fansly", engine: true, pausedAll: false, pausedRequests: false, pausedResources: [],
      holds: [], openWork: 1, dueNow: 0, nextDueAt: null, lastSentAt: null,
    };
    for (const reason of WAITING_REASONS) {
      expect(opsLiveResponseSchema.safeParse({ ...answer, pages: [{ ...page, waiting: [{ reason, count: 1 }] }] }).success, reason).toBe(true);
    }
    expect(opsLiveResponseSchema.safeParse({ ...answer, pages: [{ ...page, waiting: [{ reason: "", count: 1 }] }] }).success).toBe(false);
    expect(opsLiveResponseSchema.safeParse({ ...answer, pages: [{ ...page, waiting: [{ reason: "rate_limit", count: 1 }] }] }).success).toBe(false);
  });

  it("takes any cursor text, and nothing a caller sends there is an error", () => {
    expect(opsLiveQuerySchema.parse({})).toEqual({});
    expect(opsLiveQuerySchema.parse({ cursor: "t2-abc" })).toEqual({ cursor: "t2-abc" });
    expect(opsLiveQuerySchema.parse({ cursor: "%%% not a cursor" }).cursor).toBe("%%% not a cursor");
    // A repeated parameter arrives as a list: read as no cursor.
    expect(opsLiveQuerySchema.parse({ cursor: ["a", "b"] }).cursor).toBeUndefined();
  });
});
