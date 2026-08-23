// WP-F2 — the `notifications` capture lane, against a real database.
//
// This is the lane whose downtime costs FACTS rather than freshness, so the
// things pinned here are the ones that decide whether a fact survives:
//
//  - the forward poll stops at OVERLAP (one call in steady state) and never
//    commits its head until it has;
//  - the deep backfill walks `before=<id>` — an ID, not a timestamp — to the
//    floor, journals the empty page BECAUSE the empty page is the floor
//    evidence, and records `notificationFloorAt`;
//  - the repeat-request guard stops a walk that would otherwise spend a day's
//    cap re-asking one question (WP-F1 did exactly that on production
//    2026-08-22, five chunks deep, and nothing said a word);
//  - the 96-attempt cap DEFERS to the next UTC day and NEVER drops;
//  - the type fork falls back to the client's FULL declared CSV, records the
//    mode durably, and says so in `capture_coverage`;
//  - and `accounts[]` is allowlisted BEFORE the body reaches the journal — the
//    [A20] hazard, checked on the row that actually lands in `observations`.

import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { randomUUID } from "node:crypto";

import {
  createFanslyPage,
  createModel,
  getCheckpoint,
  setConfigOverride,
  startSyncRun,
} from "@agency_hub_core/db";
import { FanslyApiError } from "@agency_hub_core/fansly";
import { FANSLY_NOTIFICATION_DECLARED_TYPE_CSV } from "@agency_hub_core/shared";

import { SyncChunkBudget } from "../apps/runtime/src/services/sync/chunk-budget.ts";
import {
  backfillContinuationAt,
  compareNotificationRefs,
  fanslyNotificationsChunk,
  forwardPollDue,
  parseFanslyNotificationsCursorState,
  typesForFilterMode,
} from "../apps/runtime/src/services/sync/fansly-notifications.ts";
import {
  resetIntegrationDatabase,
  startIntegrationTestDatabase,
  type StartedTestDatabase,
} from "./helpers/db.ts";

let testDb: StartedTestDatabase | null = null;

beforeAll(async () => {
  testDb = await startIntegrationTestDatabase();
}, 120_000);

afterAll(async () => {
  await testDb?.stop();
});

beforeEach(async () => {
  if (testDb) {
    await resetIntegrationDatabase(testDb.pool);
  }
});

const NOW = new Date("2026-08-19T09:00:00.000Z");

/** Synthetic snowflakes, newest first. Length-then-lexicographic ordering is
 *  what the walk compares on, and every id here is the same length. */
function ref(n: number): string {
  return `0009${String(90000000000000 - n * 100).padStart(14, "0")}`;
}

function row(n: number, type = 3003, extra: Record<string, unknown> = {}) {
  return {
    id: ref(n),
    idString: ref(n),
    accountId: "000910000000000001",
    type,
    correlationId: "000920000000000001",
    correlationGroupId: "000930000000000001",
    acknowledgedAt: 1787000000 - n * 60,
    createdAt: 1787000000 - n * 3600,
    metadata: null,
    ...extra,
  };
}

/** The [A20] hazard: the sidecar the platform serves is a FULL account record. */
function fullAccountSidecar() {
  return [{
    id: "000920000000000001",
    username: "fixture_fan",
    displayName: "Fixture Fan",
    createdAt: 1690000000,
    followsYou: true,
    notes: "fixture note",
    // The eight [A20]-rejected fields. `lastSeenAt` moves every minute and is
    // the one that destroys the dedup collapse.
    lastSeenAt: 1787000123,
    followCount: 41,
    subscriberCount: 7,
    postLikes: 19,
    accountMediaLikes: 4,
    timelineStats: { imageCount: 12 },
    streaming: { lastFetchedAt: 0 },
    version: 3,
  }];
}

function envelope(rows: ReturnType<typeof row>[]) {
  return {
    notifications: rows,
    tips: [],
    accountMedia: [],
    accountMediaBundles: [],
    subscriptions: [],
    subscriptionHistory: [],
    accounts: fullAccountSidecar(),
  };
}

interface AdapterCall {
  before: string;
  types: readonly number[] | null;
}

/**
 * An adapter stub that reports ATTEMPTS through the observer, exactly as the
 * real one does: `attemptsPerCall` above 1 is what a retried request looks like
 * to everything downstream of `executeObservedRequest`.
 */
function adapterStub(options: {
  attemptsPerCall?: number;
  pages?: (call: AdapterCall, index: number) => unknown;
  fail?: (call: AdapterCall, index: number) => Error | null;
} = {}) {
  const attemptsPerCall = options.attemptsPerCall ?? 1;
  const calls: AdapterCall[] = [];
  return {
    calls,
    getNotificationsPage: vi.fn(async (
      context: {
        requestObserver?: { onRequestEvent: (event: unknown) => Promise<void> } | null;
      },
      params: { before?: string | null; types?: readonly number[] | null },
    ) => {
      const call: AdapterCall = { before: params.before ?? "0", types: params.types ?? null };
      const index = calls.length;
      calls.push(call);
      for (let attempt = 0; attempt < attemptsPerCall; attempt += 1) {
        await context.requestObserver?.onRequestEvent({
          requestId: `notifications:${index}:${attempt}`,
          state: "started",
          operation: "notifications_page",
          endpointTemplate: "/notifications",
          method: "GET",
          attemptNumber: attempt + 1,
        });
      }
      const failure = options.fail?.(call, index) ?? null;
      if (failure !== null) {
        throw failure;
      }
      const body = options.pages?.(call, index) ?? envelope([]);
      return { items: body, raw: body };
    }),
  };
}

function telemetryStub() {
  const anomalies: Array<Record<string, unknown>> = [];
  return {
    anomalies,
    recordPhaseStarted: vi.fn(async () => {}),
    recordCheckpointLoaded: vi.fn(async () => {}),
    recordCheckpointAdvanced: vi.fn(async () => {}),
    addNote: vi.fn(async () => {}),
    addAnomaly: vi.fn(async (input: Record<string, unknown>) => {
      anomalies.push(input);
    }),
    getRequestObserver: vi.fn(() => null),
  };
}

function appStub(
  adapter: ReturnType<typeof adapterStub>,
  configOverrides: Record<string, unknown> = {},
) {
  return {
    db: testDb!.db,
    adapter,
    logger: { info: () => {}, warn: () => {}, error: () => {} },
    config: {
      fanslyNotificationsSyncEnabled: true,
      fanslyNotificationsPageAllowlist: "notif-lane",
      fanslyNotificationsDailyCallBudget: 96,
      fanslyBackfillContinuationDelayMs: 20_000,
      ...configOverrides,
    },
  } as never;
}

let syncRunId = 0;

async function seedPage() {
  const model = await createModel(testDb!.db, { slug: "notif", name: "Notif" });
  if (!model) throw new Error("Expected the notifications test model to be created");
  const page = await createFanslyPage(testDb!.db, { modelId: model.id, label: "notif-lane" });
  if (!page) throw new Error("Expected the notifications test page to be created");
  await testDb!.pool.query("update pages set external_page_id = $1 where id = $2", [
    "acct-notif",
    page.id,
  ]);
  const run = await startSyncRun(testDb!.db, {
    platformAccountId: page.id,
    stream: "notifications",
    trigger: "scheduled",
  });
  if (!run) throw new Error("Expected the notifications test sync run to be created");
  syncRunId = run.id;
  return page;
}

function input(
  pageId: number,
  telemetry: ReturnType<typeof telemetryStub>,
  budget = new SyncChunkBudget(),
  now = NOW,
) {
  return {
    budget,
    pageContext: {
      platform: "fansly",
      page: { id: pageId, label: "notif-lane", platformAccountId: "acct-notif", metadata: {} },
      session: { authorization: "token" },
      proxy: { url: "socks5://proxy.example:1080" },
      egressKey: "fansly:notif",
    },
    telemetry,
    streamState: { requestSeq: 1 },
    syncRunId,
    now,
  } as never;
}

async function cursor(pageId: number) {
  const checkpoint = await getCheckpoint(testDb!.db, pageId, "notifications");
  return parseFanslyNotificationsCursorState(checkpoint?.state);
}

async function observations(pageId: number) {
  const result = await testDb!.pool.query(
    `select kind, payload from observations where account_id = $1 order by id`,
    [pageId],
  );
  return result.rows as Array<{ kind: string; payload: Record<string, unknown> }>;
}

async function coverageRows(pageId: number) {
  const result = await testDb!.pool.query(
    `select plane, status, acquisition_mode, proof, reason_code, cursor,
            oldest_captured_at, proof_observation_id
       from capture_coverage where page_id = $1 order by plane`,
    [pageId],
  );
  return result.rows as Array<Record<string, unknown>>;
}

/** Run chunks until the lane says the slot is satisfied, or the guard trips. */
async function drain(
  pageId: number,
  adapter: ReturnType<typeof adapterStub>,
  telemetry: ReturnType<typeof telemetryStub>,
  maxChunks = 20,
) {
  let result: Awaited<ReturnType<typeof fanslyNotificationsChunk>> | null = null;
  for (let chunk = 0; chunk < maxChunks; chunk += 1) {
    result = await fanslyNotificationsChunk(
      appStub(adapter),
      input(pageId, telemetry, new SyncChunkBudget()),
    );
    if (result.satisfied) {
      break;
    }
  }
  return result;
}

describe("[sync-critical] WP-F2 notifications lane", () => {
  it("polls the head first, then walks the backfill to the floor and records it", async (context) => {
    if (!testDb) {
      context.skip();
      return;
    }
    const seeded = await seedPage();
    // Three pages of history, then the empty page that IS the floor evidence.
    const bodies = [
      historyPage1(),
      historyPage2(),
      historyPage3(),
      envelope([]),
    ];
    let served = 0;
    const adapter = adapterStub({
      pages: () => bodies[Math.min(served++, bodies.length - 1)],
    });
    const telemetry = telemetryStub();

    const result = await drain(seeded.id, adapter, telemetry);
    expect(result?.satisfied).toBe(true);

    // FOUR calls: the head poll (which also SEEDS the backfill cursor, rather
    // than spending a second identical `before=0`), then two backfill pages,
    // then the empty one.
    expect(adapter.calls.map((call) => call.before)).toEqual([
      "0",
      ref(4),
      ref(8),
      ref(12),
    ]);
    // The cursor is a NOTIFICATION ID, not a timestamp.
    for (const call of adapter.calls.slice(1)) {
      expect(call.before).toMatch(/^\d{18}$/u);
    }

    // Every page is journaled, INCLUDING the empty one — it is the evidence.
    const journaled = await observations(seeded.id);
    expect(journaled).toHaveLength(4);
    expect(journaled.every((entry) => entry.kind === "notifications")).toBe(true);
    expect(
      (journaled[3]!.payload.notifications as unknown[]),
      "the terminal empty page must be journaled, not skipped",
    ).toEqual([]);

    const state = await cursor(seeded.id);
    // The one-off walk is OVER, and `backfill: null` is what that looks like
    // durably — not a flag a later parse could misread.
    expect(state!.backfill).toBeNull();
    expect(state!.newestSeenNotificationId).toBe(ref(1));

    const coverage = await coverageRows(seeded.id);
    const archive = coverage.find((entry) => entry.plane === "notifications")!;
    expect(archive.status).toBe("provider_exhausted");
    expect(archive.proof).toBe("empty_window");
    // The empty response IS the proof, and the row points at it rather than
    // restating it.
    expect(archive.proof_observation_id).not.toBeNull();
    // `notificationFloorAt` — the oldest instant the provider ever served.
    // 13.65 days is where the 2026-08-19 capture STOPPED, not a platform floor;
    // this number is what the walk measures instead of assuming.
    expect((archive.cursor as Record<string, unknown>).notificationFloorAt)
      .toBe("2026-08-17T08:53:20.000Z");
    expect(archive.oldest_captured_at).not.toBeNull();
  });

  it("[A20] allowlists accounts[] BEFORE journaling, and narrows nothing else", async (context) => {
    if (!testDb) {
      context.skip();
      return;
    }
    const seeded = await seedPage();
    const adapter = adapterStub({ pages: () => envelope([row(1, 2007)]) });
    await fanslyNotificationsChunk(
      appStub(adapter),
      input(seeded.id, telemetryStub(), new SyncChunkBudget()),
    );

    const [journaled] = await observations(seeded.id);
    const accounts = journaled!.payload.accounts as Record<string, unknown>[];
    expect(accounts).toHaveLength(1);
    // The eight rejected fields never reach the journal. `lastSeenAt` is the
    // decisive one: it moves every minute, so keeping it would make every
    // notification body unique and destroy the dedup collapse.
    for (const field of [
      "lastSeenAt",
      "followCount",
      "subscriberCount",
      "postLikes",
      "accountMediaLikes",
      "timelineStats",
      "streaming",
      "version",
    ]) {
      expect(Object.hasOwn(accounts[0]!, field), field).toBe(false);
    }
    expect(accounts[0]).toMatchObject({ id: "000920000000000001", followsYou: true });
    // …and the ROWS — the fact this lane exists for — are untouched.
    expect((journaled!.payload.notifications as Record<string, unknown>[])[0])
      .toMatchObject({ id: ref(1), type: 2007 });
  });

  it("writes the post_likes coverage row as not_started / forward_only [E4]", async (context) => {
    if (!testDb) {
      context.skip();
      return;
    }
    const seeded = await seedPage();
    const adapter = adapterStub({ pages: () => envelope([row(1)]) });
    await fanslyNotificationsChunk(
      appStub(adapter),
      input(seeded.id, telemetryStub(), new SyncChunkBudget()),
    );

    const likes = (await coverageRows(seeded.id)).find((entry) => entry.plane === "post_likes")!;
    // A NEGATIVE claim the serving layer needs: nothing is here, and nothing
    // retroactively can be. Without it an empty list reads as "nobody liked it".
    expect(likes.status).toBe("not_started");
    expect(likes.acquisition_mode).toBe("forward_only");
    expect(likes.reason_code).toBe("no_like_code_confirmed");
  });

  it("stops at OVERLAP on the second poll — one call in steady state", async (context) => {
    if (!testDb) {
      context.skip();
      return;
    }
    const seeded = await seedPage();
    const first = adapterStub({ pages: () => envelope([row(1), row(2), row(3), row(4)]) });
    await drain(seeded.id, first, telemetryStub());
    const afterFirst = await cursor(seeded.id);
    expect(afterFirst!.newestSeenNotificationId).toBe(ref(1));

    // A quiet interval: one new row on top of rows we already have.
    const second = adapterStub({
      pages: () => envelope([row(0), row(1), row(2), row(3)]),
    });
    const telemetry = telemetryStub();
    const later = new Date(NOW.getTime() + 1_800_000);
    const result = await fanslyNotificationsChunk(
      appStub(second),
      input(seeded.id, telemetry, new SyncChunkBudget(), later),
    );
    expect(result.satisfied).toBe(true);
    // ONE call: the page overlaps the last id we saw, so there is nothing
    // between them to fetch.
    expect(second.calls).toHaveLength(1);
    expect(second.calls[0]?.before).toBe("0");
    const state = await cursor(seeded.id);
    expect(state!.newestSeenNotificationId).toBe(ref(0));
  });

  it("stops a walk that re-asks the same question, and says so", async (context) => {
    if (!testDb) {
      context.skip();
      return;
    }
    const seeded = await seedPage();
    // A provider that ignores `before` and serves the SAME page forever. This
    // is the shape that cost WP-F1 a full day's cap on production before the
    // guard existed.
    const stuck = adapterStub({ pages: () => envelope([row(5), row(6), row(7)]) });
    const telemetry = telemetryStub();
    await drain(seeded.id, stuck, telemetry, 6);

    const repeat = telemetry.anomalies.find((anomaly) =>
      anomaly.code === "fansly_notifications_cursor_repeat"
    );
    expect(repeat, "a walk that does not advance must raise the guard").toBeDefined();
    expect((repeat!.details as Record<string, unknown>).phase).toBe("backfill");

    const state = await cursor(seeded.id);
    // Stopped, not looping: the lane is done rather than spending tomorrow's
    // cap on the same page.
    expect(state!.backfill).toBeNull();

    const archive = (await coverageRows(seeded.id))
      .find((entry) => entry.plane === "notifications")!;
    // Bounded by the PROVIDER's behaviour — an unwalked span is a hole we can
    // name, and naming it beats a loop that proves nothing.
    expect(archive.status).toBe("partial_provider_surface");
    expect(archive.reason_code).toBe("repeat_request");
    // Fewer calls than the day's cap, by a wide margin: that IS the fix.
    expect(stuck.calls.length).toBeLessThan(10);
  });

  it("counts ATTEMPTS, defers at the cap, and still journals what it fetched", async (context) => {
    if (!testDb) {
      context.skip();
      return;
    }
    const seeded = await seedPage();
    // A deliberately small cap, so the lane hits it with work still to do —
    // the only state in which "defers, never drops" means anything.
    await setConfigOverride(testDb.db, {
      key: "fanslyNotificationsDailyCallBudget",
      value: 4,
      userId: null,
      groupId: randomUUID(),
    });
    // Two attempts per call: a cap counted in LOGICAL calls would let a retry
    // storm multiply real egress.
    let served = 0;
    const adapter = adapterStub({
      attemptsPerCall: 2,
      pages: () => envelope([row(served * 4 + 1), row(served * 4 + 2), row(++served * 4)]),
    });
    const telemetry = telemetryStub();

    let result: Awaited<ReturnType<typeof fanslyNotificationsChunk>> | null = null;
    for (let chunk = 0; chunk < 6; chunk += 1) {
      result = await fanslyNotificationsChunk(
        appStub(adapter),
        input(seeded.id, telemetry, new SyncChunkBudget()),
      );
      if (result.stats?.deferred === "daily_call_budget") {
        break;
      }
    }

    expect(result?.stats?.deferred).toBe("daily_call_budget");
    expect(result?.satisfied).toBe(false);
    // "Come back after the UTC roll", not a failure.
    expect(result?.continuationRetryAt?.toISOString()).toBe("2026-08-20T00:05:00.000Z");

    const state = await cursor(seeded.id);
    // AT the number, never past it: the check runs BEFORE the call, so two
    // calls at two attempts each is exactly the cap.
    expect(state!.callsToday).toBe(4);
    expect(adapter.calls).toHaveLength(2);
    // NEVER DROPS: every attempt spent produced a journaled body.
    expect(await observations(seeded.id)).toHaveLength(2);
    // …and the walk is still open, which is what makes the deferral real.
    expect(state!.backfill).not.toBeNull();
  });

  it("falls back to the FULL declared CSV when the unfiltered form is refused", async (context) => {
    if (!testDb) {
      context.skip();
      return;
    }
    const seeded = await seedPage();
    let served = 0;
    const adapter = adapterStub({
      // The unfiltered form is refused; every filtered form is served.
      fail: (call) => call.types === null ? new FanslyApiError("bad type", 400) : null,
      // One page of history, then the empty page that ends the walk.
      pages: () => served++ === 0 ? envelope([row(1)]) : envelope([]),
    });
    const telemetry = telemetryStub();
    await drain(seeded.id, adapter, telemetry);

    // Call 1 unfiltered (refused), call 2 with the client's FULL declared set.
    expect(adapter.calls[0]?.types).toBeNull();
    expect(adapter.calls[1]?.types?.join(",")).toBe(FANSLY_NOTIFICATION_DECLARED_TYPE_CSV);
    // NEVER the eight-code UI CSV: it drops 32007 and 45012, both money.
    expect(adapter.calls[1]?.types).toContain(32007);
    expect(adapter.calls[1]?.types).toContain(45012);

    // The mode is DURABLE — a provider that refuses the wide form refuses it on
    // every chunk, and re-discovering that every chunk costs one wasted call each time.
    const state = await cursor(seeded.id);
    expect(state!.filterMode).toBe("declared_csv");

    const anomaly = telemetry.anomalies.find((entry) =>
      entry.code === "fansly_notifications_type_filter_refused"
    );
    expect(anomaly).toBeDefined();
    // A poll made through a NARROWED type form captured part of the provider's
    // surface, so it never claims a clean capture — and the claim survives the
    // successful calls that follow it. Including the terminal one: an empty
    // page through a narrowed filter means "no rows of THESE types", not "the
    // end of history", and calling it `provider_exhausted` would tell the
    // serving layer we reached a floor we never saw.
    const archive = (await coverageRows(seeded.id))
      .find((entry) => entry.plane === "notifications")!;
    expect(archive.status).toBe("partial_provider_surface");
    expect(archive.reason_code).toBe("type_filter_narrowed");
    // The evidence is still real and still pointed at.
    expect(archive.proof).toBe("empty_window");
    expect(archive.proof_observation_id).not.toBeNull();
  });

  it("gives up on the type fork instead of widening forever", async (context) => {
    if (!testDb) {
      context.skip();
      return;
    }
    const seeded = await seedPage();
    // NOTHING is served. Without a terminal the lane would widen, retry, be
    // refused, widen … until the day's cap was gone — the WP-F1 failure in a
    // different costume.
    const adapter = adapterStub({ fail: () => new FanslyApiError("nope", 400) });
    const telemetry = telemetryStub();
    await drain(seeded.id, adapter, telemetry, 3);

    // Bounded: the declared CSV, then one call per filter group, then stop.
    // The counter is DURABLE — a limit that lived inside one chunk would let a
    // re-dispatched lane start counting from zero every time, which is exactly
    // how WP-F1's loop spanned five chunks unnoticed.
    expect(adapter.calls.length).toBeLessThanOrEqual(10);
    const refusals = telemetry.anomalies.filter((entry) =>
      entry.code === "fansly_notifications_type_filter_refused"
    );
    expect(refusals.length).toBe(adapter.calls.length);
    expect(refusals.at(-1)?.details).toMatchObject({ exhausted: true });
  });

  it("re-raises 401/403 rather than treating a dead session as a filter problem", async (context) => {
    if (!testDb) {
      context.skip();
      return;
    }
    const seeded = await seedPage();
    const adapter = adapterStub({ fail: () => new FanslyApiError("unauthorized", 401) });
    const telemetry = telemetryStub();
    await expect(fanslyNotificationsChunk(
      appStub(adapter),
      input(seeded.id, telemetry, new SyncChunkBudget()),
    )).rejects.toThrow("unauthorized");
    // ONE attempt, and no widening: an auth failure belongs to the executor's
    // pause path, not to the type fork.
    expect(adapter.calls).toHaveLength(1);
    expect(telemetry.anomalies).toHaveLength(0);
  });

  it("refuses to run when the flag is off or the page is not allowlisted", async (context) => {
    if (!testDb) {
      context.skip();
      return;
    }
    const seeded = await seedPage();
    const adapter = adapterStub();
    const off = await fanslyNotificationsChunk(
      appStub(adapter, { fanslyNotificationsSyncEnabled: false }),
      input(seeded.id, telemetryStub(), new SyncChunkBudget()),
    );
    expect(off.gatedSkip).toBe("flag_off");
    // FAIL-CLOSED (S4): an EMPTY allowlist is NO pages, the opposite of the
    // shared new-stream key. Using that one here would open the lane
    // fleet-wide on the deploy that ships it.
    const closed = await fanslyNotificationsChunk(
      appStub(adapter, { fanslyNotificationsPageAllowlist: "" }),
      input(seeded.id, telemetryStub(), new SyncChunkBudget()),
    );
    expect(closed.gatedSkip).toBe("not_allowlisted");
    expect(adapter.calls).toHaveLength(0);
  });
});

describe("WP-F2 walk helpers", () => {
  it("orders snowflake refs by length first, then lexicographically", () => {
    expect(compareNotificationRefs("100", "99")).toBeGreaterThan(0);
    expect(compareNotificationRefs("100", "101")).toBeLessThan(0);
    expect(compareNotificationRefs("100", "100")).toBe(0);
  });

  it("spaces backfill continuations with ±30% jitter", () => {
    // Burst shape, not daily volume, is the real ban-risk surface.
    expect(backfillContinuationAt(NOW, 20_000, () => 0).getTime() - NOW.getTime()).toBe(14_000);
    expect(backfillContinuationAt(NOW, 20_000, () => 1).getTime() - NOW.getTime()).toBe(26_000);
  });

  it("makes a head poll due again after the stream's cadence", () => {
    const base = { lastForwardPollAt: NOW.toISOString() } as never;
    expect(forwardPollDue(base, new Date(NOW.getTime() + 1_000))).toBe(false);
    expect(forwardPollDue(base, new Date(NOW.getTime() + 1_800_000))).toBe(true);
    // A lane that has never polled is always due.
    expect(forwardPollDue({ lastForwardPollAt: null } as never, NOW)).toBe(true);
  });

  it("maps each filter mode to the form it issues", () => {
    expect(typesForFilterMode("unfiltered", 0)).toBeNull();
    expect(typesForFilterMode("declared_csv", 0)?.join(","))
      .toBe(FANSLY_NOTIFICATION_DECLARED_TYPE_CSV);
    // The purchase group leads the iteration: money first on the degraded path.
    expect(typesForFilterMode("type_groups", 0)).toEqual([2007, 2008, 32007, 45012]);
  });
});

// Four consecutive pages of history, newest first, with no gap between them.
function historyPage1() {
  return envelope([row(1), row(2), row(3), row(4)]);
}
function historyPage2() {
  return envelope([row(5), row(6), row(7), row(8)]);
}
function historyPage3() {
  return envelope([row(9), row(10), row(11), row(12)]);
}
