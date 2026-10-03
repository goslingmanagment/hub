import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import {
  ensurePollRows,
  getSyncPage,
  upsertCreatorPost,
  upsertDemand,
  type Database,
} from "@agency_hub_core/db";
import type { FanslyWireOutcome, FanslyWireRequest } from "@agency_hub_core/fansly";
import { FANSLY_NOTIFICATION_DECLARED_TYPE_CODES } from "@agency_hub_core/shared";

import { SyncCrashFault } from "../apps/runtime/src/sync/engine/commit.ts";
import type { SettingsSource } from "../apps/runtime/src/sync/engine/ports.ts";
import { createEngineRegistry, pollsFor, type EngineRegistry } from "../apps/runtime/src/sync/engine/resource.ts";
import { FANSLY_POST_TIPS_SCOPE_QUARANTINE, fanslyCaptureCodec } from "../apps/runtime/src/sync/fansly/capture.ts";
import { FANSLY_RESOURCE_SPECS, fanslyResourceSpec } from "../apps/runtime/src/sync/fansly/registry.ts";
import {
  resetIntegrationDatabase,
  startIntegrationTestDatabase,
  type StartedTestDatabase,
} from "./helpers/db.ts";
import {
  changedTables,
  countRows,
  makeTestActor,
  okResponse,
  RecordingAlerts,
  RecordingMetrics,
  ScriptedLiveTransport,
  seedSyncPage,
  statusResponse,
  tableCounts,
  testConfig,
  waitFor,
} from "./helpers/sync-engine-host.ts";

// The content resources of the Fansly Sync Engine (design §5.14–§5.16, §4.3)
// through the real actor and commits against a real database, journaled by
// the production capture codec: a scripted live transport answers each wire
// route; shadow runs the same registry with no transport at all. What is
// pinned: each walk keeps its position in its work row and stops where the
// legacy lane stops; the journal carries the legacy envelopes, and an answer
// applied from the journal (after a crash) does what it does in memory; the
// coverage claims the legacy lanes write; the subject-queue walks stand open over the
// projector-fed queues, write each subject's visit or breaker on its queue row,
// and move on past a failing subject; a shadow pass walks every due subject
// once and writes nothing but its own work and attempts.

let testDb: StartedTestDatabase | null = null;

beforeAll(async () => {
  testDb = await startIntegrationTestDatabase();
}, 120_000);

afterAll(async () => {
  await testDb?.stop();
});

beforeEach(async () => {
  if (testDb) await resetIntegrationDatabase(testDb.pool);
});

function db(): Database {
  return testDb!.db as unknown as Database;
}

const OWN_ID = "300000000000000001";
const DAY_MS = 86_400_000;
const HOUR_MS = 3_600_000;

function epochSeconds(at: Date): number {
  return Math.floor(at.getTime() / 1000);
}

function daysAgo(days: number): Date {
  return new Date(Date.now() - days * DAY_MS);
}

/** A registry of every Fansly entry whose standing rows are parked far ahead,
 *  so only the work a test makes due runs. */
async function quietRegistry(pageId: number, shadow: boolean): Promise<EngineRegistry> {
  const registry = createEngineRegistry(FANSLY_RESOURCE_SPECS);
  const page = await getSyncPage(db(), pageId);
  await ensurePollRows(db(), {
    pageId,
    shadow,
    polls: pollsFor(registry, page!, shadow).map((poll) => ({ ...poll, phase: 0.999 })),
  });
  return registry;
}

async function makeDue(pageId: number, shadow: boolean, resource: string) {
  const spec = fanslyResourceSpec(resource)!;
  await upsertDemand(db(), { pageId, shadow, resource, kind: spec.kind, class: spec.class, demand: { reasons: ["test"] } });
}

async function setCursor(pageId: number, resource: string, cursor: unknown, shadow = false) {
  await testDb!.pool.query(
    "update sync_work set cursor = $4::jsonb where page_id = $1 and resource = $2 and shadow = $3 and state = 'open'",
    [pageId, resource, shadow, JSON.stringify(cursor)],
  );
}

async function seedPage(mode: "live" | "shadow", externalId: string | null = OWN_ID) {
  const { pageId } = await seedSyncPage({ db: db(), pool: testDb!.pool }, {
    mode,
    guard: mode === "live" ? "fansly_sync_engine" : null,
  });
  await testDb!.pool.query(
    "update pages set external_page_id = $2, last_verified_at = clock_timestamp() - interval '1 minute' where id = $1",
    [pageId, externalId],
  );
  return pageId;
}

/** A Fansly post the creator-posts projector stored; it seeds both queue
 *  planes (`post_replies`, `post_engagement`) due now, as in production. */
async function seedPost(pageId: number, postRef: string, publishedAt: Date) {
  await upsertCreatorPost(db(), {
    accountId: pageId,
    platform: "fansly",
    platformPostId: postRef,
    textPlain: "a post",
    publishedAt,
    observedAt: new Date(),
    contentHash: "a".repeat(64),
    attachmentCount: 0,
    tipAmountMills: null,
    attachmentTipAmountMills: null,
    postTipTotalMills: null,
    tipGoalLinked: null,
    tipGoalRef: null,
    tipGoalLabel: null,
    tipGoalTargetMills: null,
    tipGoalCurrentMills: null,
    tipGoalAmountsHidden: null,
    likeCount: null,
    mediaLikeCount: null,
    replyCount: null,
    fypFlags: null,
    expiresAt: null,
    inReplyToRef: null,
    inReplyToRootRef: null,
    wallRefs: null,
    accountMentionRefs: null,
    hashtags: null,
    hashtagsNormalized: null,
    hashtagParserVersion: null,
    attachmentRefs: null,
    engagementObservedAt: null,
    sourceEventId: 1,
    sourceObservationId: 1,
    sourceAccountSeq: 1,
  });
}

/** A stored comment whose author no `fans` row names yet. */
async function seedUnnamedComment(pageId: number, postRef: string, commentRef: string, authorRef: string) {
  await testDb!.pool.query(
    `insert into post_comments (page_id, platform, comment_ref, parent_post_ref, author_ref, occurred_at, changed_at,
            discovered_via, first_observed_at, last_observed_at, content_hash, source_event_id, source_observation_id,
            source_account_seq)
     values ($1, 'fansly', $2, $3, $4, clock_timestamp(), clock_timestamp(), 'replies_walk', clock_timestamp(),
             clock_timestamp(), $5, 1, 1, 1)`,
    [pageId, commentRef, postRef, authorRef, "b".repeat(64)],
  );
}

function query(req: FanslyWireRequest, name: string): string | null {
  return new URL(req.url).searchParams.get(name);
}

/** The post a `/post/{id}/replies` request names. */
function repliesPostId(req: FanslyWireRequest): string {
  return new URL(req.url).pathname.split("/").at(-2)!;
}

function settingsWith(overrides: { fanslyRepliesRewalkCycleDays: number }): SettingsSource {
  return { read: async () => ({ ...testConfig(testDb!.connectionString), ...overrides }) };
}

type Responder = (req: FanslyWireRequest) => FanslyWireOutcome;

async function drive(
  pageId: number,
  mode: "live" | "shadow",
  registry: EngineRegistry,
  respond: Responder | null,
  until: () => Promise<boolean>,
  options: { alerts?: RecordingAlerts; metrics?: RecordingMetrics; settings?: SettingsSource } = {},
) {
  const transport = respond === null ? undefined : new ScriptedLiveTransport();
  if (transport !== undefined && respond !== null) transport.respond = (req) => respond(req);
  const requests: FanslyWireRequest[] = [];
  if (transport !== undefined) transport.onHit = async (req) => void requests.push(req);
  const alerts = options.alerts ?? new RecordingAlerts();
  const metrics = options.metrics ?? new RecordingMetrics();
  const { actor, stop, abort } = await makeTestActor({
    db: db(),
    pageId,
    mode,
    registry,
    alerts,
    metrics,
    ownRef: OWN_ID,
    capture: fanslyCaptureCodec,
    ...(options.settings === undefined ? {} : { settings: options.settings }),
    ...(transport === undefined ? {} : { transport }),
  });
  const run = actor.run({ stop: stop.signal, abort: abort.signal });
  try {
    await waitFor(async () => ((await until()) ? true : null), 30_000, "the work to settle");
  } finally {
    stop.abort();
    await run;
  }
  return { hits: requests.map((req) => req.spec), requests, alerts, metrics };
}

async function runLive(
  pageId: number,
  respond: Responder,
  until: () => Promise<boolean>,
  options: { alerts?: RecordingAlerts; metrics?: RecordingMetrics; settings?: SettingsSource; prepare?: (registry: EngineRegistry) => Promise<void> } = {},
) {
  const registry = await quietRegistry(pageId, false);
  await options.prepare?.(registry);
  return drive(pageId, "live", registry, respond, until, options);
}

/**
 * A live run whose process dies right after the capture of the first answer
 * `crashOn` picks (journaled, not applied); the restarted owner applies that
 * answer from the journal without asking again (I8), then runs on.
 */
async function runLiveCrashingAfterCapture(
  pageId: number,
  respond: Responder,
  crashOn: (req: FanslyWireRequest) => boolean,
  until: () => Promise<boolean>,
  options: { alerts?: RecordingAlerts } = {},
) {
  const registry = await quietRegistry(pageId, false);
  const transport = new ScriptedLiveTransport();
  transport.respond = (req) => respond(req);
  const firstRequests: FanslyWireRequest[] = [];
  let crashArmed = false;
  transport.onHit = async (req) => {
    firstRequests.push(req);
    if (crashOn(req)) crashArmed = true;
  };
  const dying = await makeTestActor({
    db: db(),
    pageId,
    mode: "live",
    registry,
    ownRef: OWN_ID,
    capture: fanslyCaptureCodec,
    transport,
    faults: (at) => {
      if (at === "after_capture" && crashArmed) throw new SyncCrashFault(at);
    },
  });
  await expect(dying.actor.run({ stop: dying.stop.signal, abort: dying.abort.signal })).rejects.toBeInstanceOf(SyncCrashFault);
  const restarted = await drive(pageId, "live", registry, respond, until, options);
  return { firstHits: firstRequests.map((req) => req.spec), firstRequests, ...restarted };
}

/** Each attempt of a resource: who made it, what it read, how it applied. */
async function attemptLog(pageId: number, resource: string) {
  const result = await testDb!.pool.query<{ owner_generation: string; operation: string; apply_state: string }>(
    `select owner_generation::text, operation, apply_state from sync_attempts
      where page_id = $1 and resource = $2 and not shadow order by id`,
    [pageId, resource],
  );
  return result.rows;
}

interface WorkRowView {
  state: string;
  cursor: Record<string, unknown>;
  proof: Record<string, unknown> | null;
  result: Record<string, unknown> | null;
  waiting_reason: string | null;
  due_at: Date;
  params: Record<string, unknown>;
  close_reason: string | null;
  failure_count: number;
}

async function workRow(pageId: number, resource: string, shadow = false): Promise<WorkRowView | null> {
  const result = await testDb!.pool.query<WorkRowView>(
    `select state, cursor, proof, result, waiting_reason, due_at, params, close_reason, failure_count from sync_work
      where page_id = $1 and resource = $2 and shadow = $3 order by id desc limit 1`,
    [pageId, resource, shadow],
  );
  return result.rows[0] ?? null;
}

async function attempts(pageId: number, resource: string, where = "apply_state = 'applied'"): Promise<number> {
  return countRows(testDb!.pool, `select count(*)::int as n from sync_attempts where page_id = $1 and resource = $2 and ${where}`, [pageId, resource]);
}

async function observations(pageId: number) {
  const result = await testDb!.pool.query<{ id: number; kind: string; producer: string; payload: unknown }>(
    "select id::int as id, kind, producer, payload from observations where account_id = $1 order by id",
    [pageId],
  );
  return result.rows;
}

async function coverage(pageId: number, plane: string) {
  const result = await testDb!.pool.query<{
    status: string; proof: string; reason_code: string | null; proof_observation_id: number | null;
    oldest_captured_at: Date | null; expected_count: number | null; observed_unique_count: number | null;
    cursor: Record<string, unknown>;
  }>(
    `select status, proof, reason_code, proof_observation_id::int as proof_observation_id, oldest_captured_at,
            expected_count::int as expected_count, observed_unique_count::int as observed_unique_count, cursor
       from capture_coverage where page_id = $1 and plane = $2`,
    [pageId, plane],
  );
  return result.rows[0] ?? null;
}

async function queueRow(pageId: number, plane: string, subjectRef: string) {
  const result = await testDb!.pool.query<{
    last_visited_at: Date | null; next_due_at: Date | null; consecutive_failures: number; known_count: number | null;
    last_refresh_outcome: string | null;
  }>(
    `select last_visited_at, next_due_at, consecutive_failures, known_count::int as known_count, last_refresh_outcome
       from subject_refresh_state where page_id = $1 and plane = $2 and subject_ref = $3`,
    [pageId, plane, subjectRef],
  );
  return result.rows[0] ?? null;
}

async function queueSnapshot(pageId: number): Promise<unknown[]> {
  const result = await testDb!.pool.query(
    `select plane, subject_ref, last_visited_at, next_due_at, consecutive_failures, dirty_reason, known_count,
            last_refresh_outcome, updated_at
       from subject_refresh_state where page_id = $1 order by plane, subject_ref`,
    [pageId],
  );
  return result.rows;
}

function expectNear(actual: Date | null | undefined, expectedMs: number, toleranceMs = 60_000) {
  expect(actual).toBeInstanceOf(Date);
  expect(Math.abs(actual!.getTime() - expectedMs)).toBeLessThan(toleranceMs);
}

// ── notifications ───────────────────────────────────────────────────────────

const N = (suffix: number) => `4000000000000000${String(suffix).padStart(3, "0")}`;

function notification(id: string, createdAt: Date, type = 3101) {
  return { id, type, createdAt: epochSeconds(createdAt), correlationId: id };
}

describe("notifications.forward", () => {
  it("the first poll reads one page, commits its head, and writes the plane's coverage and the liker plane's standing claim", async (context) => {
    if (!testDb) return context.skip();
    const pageId = await seedPage("live");
    await makeDue(pageId, false, "notifications.forward");
    const served = {
      notifications: [notification(N(300), daysAgo(0.1)), notification(N(250), daysAgo(0.2))],
      accounts: [{ id: "500000000000000001", username: "fan", lastSeenAt: 1_700_000_000 }],
    };
    const { hits, requests } = await runLive(pageId, () => okResponse(served),
      async () => (await attempts(pageId, "notifications.forward")) === 1);

    expect(hits).toEqual(["notifications.page"]);
    // The unfiltered form: no `type` at all, `before=0&after=0`.
    expect(query(requests[0]!, "before")).toBe("0");
    expect(query(requests[0]!, "type")).toBeNull();
    const poll = await workRow(pageId, "notifications.forward");
    expect(poll!.state).toBe("open");
    expect(poll!.cursor).toMatchObject({
      newestSeenNotificationId: N(300),
      form: { mode: "unfiltered" },
      postLikesCoverageWritten: true,
      walk: null,
      last: { stopReason: "first_poll", pages: 1 },
    });
    // A hard 30-minute poll.
    expect(poll!.due_at.getTime() - Date.now()).toBeGreaterThan(25 * 60_000);
    // Journaled as the legacy lane journals: the [A20] sidecar trim.
    const journal = await observations(pageId);
    expect(journal.map((row) => [row.kind, row.producer])).toEqual([["notifications", "fansly-sync:notifications.forward"]]);
    expect(JSON.stringify(journal[0]!.payload)).not.toContain("lastSeenAt");
    expect(await coverage(pageId, "notifications")).toMatchObject({ status: "window_captured", proof: "none", reason_code: "first_poll" });
    expect(await coverage(pageId, "post_likes")).toMatchObject({ status: "not_started", reason_code: "no_like_code_confirmed" });
  });

  it("walks down from the head until a page reaches the newest id the last poll saw", async (context) => {
    if (!testDb) return context.skip();
    const pageId = await seedPage("live");
    await makeDue(pageId, false, "notifications.forward");
    const { hits, requests } = await runLive(pageId, (req) => okResponse({
      notifications: query(req, "before") === "0"
        ? [notification(N(300), daysAgo(0.1)), notification(N(250), daysAgo(0.2))]
        : [notification(N(200), daysAgo(0.3)), notification(N(90), daysAgo(0.4))],
    }), async () => (await attempts(pageId, "notifications.forward")) === 2, {
      prepare: async () => setCursor(pageId, "notifications.forward", { newestSeenNotificationId: N(100), postLikesCoverageWritten: true }),
    });

    expect(hits).toEqual(["notifications.page", "notifications.page"]);
    expect(requests.map((req) => query(req, "before"))).toEqual(["0", N(250)]);
    const poll = await workRow(pageId, "notifications.forward");
    expect(poll!.cursor).toMatchObject({ newestSeenNotificationId: N(300), walk: null, last: { stopReason: "overlap", pages: 2 } });
    // The liker plane's claim was written once, by an earlier poll.
    expect(await coverage(pageId, "post_likes")).toBeNull();
  });

  it("an empty unfiltered page is probed once with the declared CSV; rows there mean the unfiltered form filters", async (context) => {
    if (!testDb) return context.skip();
    const pageId = await seedPage("live");
    await makeDue(pageId, false, "notifications.forward");
    const metrics = new RecordingMetrics();
    const { requests } = await runLive(pageId, (req) => okResponse({
      notifications: query(req, "type") === null ? [] : [notification(N(300), daysAgo(0.1))],
    }), async () => (await attempts(pageId, "notifications.forward")) === 2, {
      metrics,
      prepare: async () => setCursor(pageId, "notifications.forward", { newestSeenNotificationId: N(100), postLikesCoverageWritten: true }),
    });

    expect(requests.map((req) => [query(req, "before"), query(req, "type")])).toEqual([
      ["0", null],
      ["0", FANSLY_NOTIFICATION_DECLARED_TYPE_CODES.join(",")],
    ]);
    const poll = await workRow(pageId, "notifications.forward");
    expect(poll!.cursor).toMatchObject({ form: { mode: "declared_csv" }, unfilteredProbeSpent: true, walk: null, last: { stopReason: "empty_page" } });
    // Through a narrowed form a claim is never stronger than a partial surface.
    expect(await coverage(pageId, "notifications")).toMatchObject({ status: "partial_provider_surface", reason_code: "type_filter_narrowed" });
  });
});

describe("notifications.backfill", () => {
  it("walks `before = oldest id` down to an empty page, the retention floor, proved by that page's observation", async (context) => {
    if (!testDb) return context.skip();
    const pageId = await seedPage("live");
    await makeDue(pageId, false, "notifications.backfill");
    const oldest = daysAgo(80);
    const { requests } = await runLive(pageId, (req) => okResponse({
      notifications: query(req, "before") === "0" ? [notification(N(300), daysAgo(1)), notification(N(250), oldest)] : [],
    }), async () => (await workRow(pageId, "notifications.backfill"))?.state === "done");

    expect(requests.map((req) => query(req, "before"))).toEqual(["0", N(250)]);
    const goal = await workRow(pageId, "notifications.backfill");
    expect(goal).toMatchObject({ close_reason: "backfill_floor", cursor: { nextBeforeRef: N(250), lastRequestedBefore: N(250) } });
    const journal = await observations(pageId);
    expect(journal).toHaveLength(2);
    const claim = await coverage(pageId, "notifications");
    expect(claim).toMatchObject({ status: "provider_exhausted", proof: "empty_window", reason_code: "empty_window", proof_observation_id: journal[1]!.id });
    expectNear(claim!.oldest_captured_at, new Date(epochSeconds(oldest) * 1000).getTime(), 1_000);
  });
});

// ── posts ───────────────────────────────────────────────────────────────────

const P = (suffix: number) => `7000000000000000${String(suffix).padStart(3, "0")}`;

function timelinePost(id: string, createdAt: Date) {
  return { id, accountId: OWN_ID, content: `post ${id}`, createdAt: epochSeconds(createdAt), attachments: [] };
}

describe("posts.refresh", () => {
  it("alternates timeline page and its tips down to a page wholly older than 14 days; an out-of-scope tips answer keeps the legacy envelope", async (context) => {
    if (!testDb) return context.skip();
    const pageId = await seedPage("live");
    await makeDue(pageId, false, "posts.refresh");
    const { hits, requests } = await runLive(pageId, (req) => {
      if (req.spec === "posts.timeline") {
        return okResponse({
          posts: query(req, "before") === "0"
            ? [timelinePost(P(4), daysAgo(1)), timelinePost(P(3), daysAgo(2))]
            : [timelinePost(P(2), daysAgo(20)), timelinePost(P(1), daysAgo(30))],
        });
      }
      if (req.spec === "posts.tips") {
        const first = query(req, "targetIds")!.split(",")[0];
        return okResponse(first === P(4)
          ? [{ id: "900000000000000001", receiverId: OWN_ID, targetId: P(4), amount: 5000 }]
          : [{ id: "900000000000000002", receiverId: "399999999999999999", targetId: P(2), amount: 5000 }]);
      }
      throw new Error(`unexpected ${req.spec}`);
    }, async () => (await attempts(pageId, "posts.refresh")) === 4);

    expect(hits).toEqual(["posts.timeline", "posts.tips", "posts.timeline", "posts.tips"]);
    expect(new URL(requests[0]!.url).pathname).toBe(`/api/v1/timelinenew/${OWN_ID}`);
    expect(requests.map((req) => query(req, "before") ?? query(req, "targetIds"))).toEqual([
      "0", `${P(4)},${P(3)}`, P(3), `${P(2)},${P(1)}`,
    ]);
    const poll = await workRow(pageId, "posts.refresh");
    expect(poll!.state).toBe("open");
    expect(poll!.cursor).toMatchObject({
      headPostId: P(4),
      // A bounded walk never claims the full tips backfill.
      tipsBackfilledAt: null,
      walk: null,
      last: { end: "cutoff_reached", pages: 2, captured: 4, tipsScopeDrifts: 1, headPostId: P(4) },
    });
    expect(poll!.due_at.getTime() - Date.now()).toBeGreaterThan(5 * HOUR_MS);
    const journal = await observations(pageId);
    expect(journal.map((row) => row.kind)).toEqual(["posts", "post_tips", "posts", "post_tips"]);
    expect(journal[1]!.payload).toEqual([{ id: "900000000000000001", receiverId: OWN_ID, targetId: P(4), amount: 5000 }]);
    expect(journal[3]!.payload).toMatchObject({ quarantine: FANSLY_POST_TIPS_SCOPE_QUARANTINE, requestedTargetIds: [P(2), P(1)] });
  });

  it("a tips answer outside its scope, applied from the journal after a crash, is counted as in memory and the walk goes on", async (context) => {
    if (!testDb) return context.skip();
    const pageId = await seedPage("live");
    await makeDue(pageId, false, "posts.refresh");
    const alerts = new RecordingAlerts();
    const { firstHits, hits } = await runLiveCrashingAfterCapture(pageId, (req) => {
      if (req.spec === "posts.timeline") {
        return okResponse({
          posts: query(req, "before") === "0"
            ? [timelinePost(P(4), daysAgo(1)), timelinePost(P(3), daysAgo(2))]
            : [timelinePost(P(2), daysAgo(20)), timelinePost(P(1), daysAgo(30))],
        });
      }
      if (req.spec === "posts.tips") return okResponse([{ id: "900000000000000002", receiverId: "399999999999999999", targetId: P(9), amount: 5000 }]);
      throw new Error(`unexpected ${req.spec}`);
    }, (req) => req.spec === "posts.tips", async () => (await attempts(pageId, "posts.refresh")) === 4, { alerts });

    // The dead owner's tips answer is applied from the journal, never asked again.
    expect(firstHits).toEqual(["posts.timeline", "posts.tips"]);
    expect(hits).toEqual(["posts.timeline", "posts.tips"]);
    expect(await attemptLog(pageId, "posts.refresh")).toEqual([
      { owner_generation: "1", operation: "posts.timeline", apply_state: "applied" },
      { owner_generation: "1", operation: "posts.tips", apply_state: "applied" },
      { owner_generation: "2", operation: "posts.timeline", apply_state: "applied" },
      { owner_generation: "2", operation: "posts.tips", apply_state: "applied" },
    ]);
    const poll = await workRow(pageId, "posts.refresh");
    expect(poll!.state).toBe("open");
    expect(poll!.cursor).toMatchObject({ walk: null, last: { end: "cutoff_reached", pages: 2, captured: 4, tipsScopeDrifts: 2 } });
    expect(alerts.opened.filter((alert) => alert.detail === "quarantined")).toEqual([]);
    const journal = await observations(pageId);
    expect(journal[1]!.payload).toMatchObject({ quarantine: FANSLY_POST_TIPS_SCOPE_QUARANTINE, requestedTargetIds: [P(4), P(3)] });
  });

  it("a tips answer that is not an array is journaled raw and counted, and the walk reaches the next timeline page", async (context) => {
    if (!testDb) return context.skip();
    const pageId = await seedPage("live");
    await makeDue(pageId, false, "posts.refresh");
    const alerts = new RecordingAlerts();
    const drifted = { tips: [{ id: "900000000000000001" }], cursor: "x" };
    const { hits, requests } = await runLive(pageId, (req) => {
      if (req.spec === "posts.timeline") {
        return okResponse({
          posts: query(req, "before") === "0"
            ? [timelinePost(P(4), daysAgo(1)), timelinePost(P(3), daysAgo(2))]
            : [timelinePost(P(2), daysAgo(20)), timelinePost(P(1), daysAgo(30))],
        });
      }
      if (req.spec === "posts.tips") return okResponse(query(req, "targetIds")!.startsWith(P(4)) ? drifted : []);
      throw new Error(`unexpected ${req.spec}`);
    }, async () => (await attempts(pageId, "posts.refresh")) === 4, { alerts });

    // Legacy: "do not wedge the whole posts lane because one optional
    // companion contract changed".
    expect(hits).toEqual(["posts.timeline", "posts.tips", "posts.timeline", "posts.tips"]);
    expect(query(requests[2]!, "before")).toBe(P(3));
    const poll = await workRow(pageId, "posts.refresh");
    expect(poll!.state).toBe("open");
    expect(poll!.cursor).toMatchObject({
      walk: null,
      last: { end: "cutoff_reached", pages: 2, captured: 4, tipsContractDrifts: 1, tipsScopeDrifts: 0 },
    });
    expect(await attempts(pageId, "posts.refresh", "apply_state = 'quarantined'")).toBe(0);
    expect(alerts.opened.filter((alert) => alert.detail === "quarantined")).toEqual([]);
    const journal = await observations(pageId);
    expect(journal.map((row) => row.kind)).toEqual(["posts", "post_tips", "posts", "post_tips"]);
    expect(journal[1]!.payload).toEqual(drifted);
  });

  it("the full backfill walks to an empty page and records the tips backfill", async (context) => {
    if (!testDb) return context.skip();
    const pageId = await seedPage("live");
    await makeDue(pageId, false, "posts.backfill");
    const { hits } = await runLive(pageId, (req) => {
      if (req.spec === "posts.timeline") {
        return okResponse({ posts: query(req, "before") === "0" ? [timelinePost(P(2), daysAgo(400)), timelinePost(P(1), daysAgo(500))] : [] });
      }
      return okResponse([]);
    }, async () => (await workRow(pageId, "posts.backfill"))?.state === "done");

    expect(hits).toEqual(["posts.timeline", "posts.tips", "posts.timeline"]);
    const goal = await workRow(pageId, "posts.backfill");
    expect(goal).toMatchObject({ close_reason: "walk_timeline_exhausted", cursor: { headPostId: P(2), walk: null } });
    expect(typeof goal!.cursor.tipsBackfilledAt).toBe("string");
  });

  it("a page without its native id waits for the account poll and makes it due", async (context) => {
    if (!testDb) return context.skip();
    const pageId = await seedPage("live", null);
    await makeDue(pageId, false, "posts.refresh");
    const { hits } = await runLive(pageId, (req) => {
      if (req.spec === "account.me") {
        return okResponse({ account: { id: OWN_ID, username: "model", displayName: "Model", createdAt: Date.UTC(2024, 0, 1), followCount: 0, subscriberCount: 0, walls: [], subscriptionTiers: [] } });
      }
      throw new Error(`unexpected ${req.spec}`);
    }, async () => (await attempts(pageId, "account.poll")) === 1);

    expect(hits).toEqual(["account.me"]);
    expect(await attempts(pageId, "posts.refresh", "true")).toBe(0);
  });
});

describe("posts.engagement", () => {
  it("re-reads the due posts in one batch: the served ones re-dated by tier, an omitted one a day out; then the walk rests", async (context) => {
    if (!testDb) return context.skip();
    const pageId = await seedPage("live");
    await seedPost(pageId, P(1), daysAgo(1));
    await seedPost(pageId, P(2), daysAgo(40));
    await seedPost(pageId, P(3), daysAgo(200));
    await makeDue(pageId, false, "posts.engagement");
    const metrics = new RecordingMetrics();
    const { requests } = await runLive(pageId, () => okResponse({ posts: [timelinePost(P(1), daysAgo(1)), timelinePost(P(2), daysAgo(40))] }),
      async () => (await workRow(pageId, "posts.engagement"))?.waiting_reason === "not_due", {
        metrics,
        // A breaker count the walk row carries (inherited, say): the answer
        // resets it as an `ok`, never as one more failure of the batch.
        prepare: async () => {
          await testDb!.pool.query("update sync_work set failure_count = 2 where page_id = $1 and resource = 'posts.engagement'", [pageId]);
        },
      });

    // Never refreshed, by tier: fresh, mid, long tail.
    expect(requests.map((req) => query(req, "ids"))).toEqual([`${P(1)},${P(2)},${P(3)}`]);
    const now = Date.now();
    const fresh = await queueRow(pageId, "post_engagement", P(1));
    expect(fresh!.consecutive_failures).toBe(0);
    expectNear(fresh!.last_visited_at, now);
    expectNear(fresh!.next_due_at, now + DAY_MS);
    expectNear((await queueRow(pageId, "post_engagement", P(2)))!.next_due_at, now + 7 * DAY_MS);
    const omitted = await queueRow(pageId, "post_engagement", P(3));
    expect(omitted).toMatchObject({ last_visited_at: null, consecutive_failures: 1 });
    expectNear(omitted!.next_due_at, now + DAY_MS);
    // The standing walk stays open, re-checking its queue in 6 h.
    const walk = await workRow(pageId, "posts.engagement");
    expect(walk).toMatchObject({ state: "open", waiting_reason: "not_due" });
    expectNear(walk!.due_at, now + 6 * HOUR_MS);
    expect(walk!.cursor).toMatchObject({ last: { requested: 3, refreshed: 2, unserved: 1, byTier: { fresh: 1, mid: 1 } } });
    // The reply queue of the same posts is untouched.
    expect((await queueRow(pageId, "post_replies", P(1)))!.last_visited_at).toBeNull();
  });

  it("a refused batch opens each subject's breaker on its queue row; the walk row keeps none and moves on", async (context) => {
    if (!testDb) return context.skip();
    const pageId = await seedPage("live");
    await seedPost(pageId, P(1), daysAgo(1));
    await seedPost(pageId, P(2), daysAgo(2));
    await makeDue(pageId, false, "posts.engagement");
    const { hits } = await runLive(pageId, () => statusResponse(404),
      async () => (await workRow(pageId, "posts.engagement"))?.waiting_reason === "not_due");

    expect(hits).toEqual(["posts.by_ids"]);
    const now = Date.now();
    for (const ref of [P(1), P(2)]) {
      const row = await queueRow(pageId, "post_engagement", ref);
      expect(row).toMatchObject({ last_visited_at: null, consecutive_failures: 1, last_refresh_outcome: null });
      expectNear(row!.next_due_at, now + 60_000, 30_000);
    }
    const walk = await workRow(pageId, "posts.engagement");
    expect(walk).toMatchObject({ state: "open", failure_count: 0 });
  });
});

// ── post-replies ────────────────────────────────────────────────────────────

function reply(id: string, postId: string, authorId: string) {
  return { id, accountId: authorId, inReplyTo: postId, inReplyToRoot: postId, content: `reply ${id}`, createdAt: epochSeconds(daysAgo(1)) };
}

/** `count` replies with descending ids from `top`. */
function replies(postId: string, top: number, count: number) {
  return Array.from({ length: count }, (_, index) => reply(`8000000000000000${String(top - index).padStart(3, "0")}`, postId, "500000000000000777"));
}

describe("post-replies.walk", () => {
  it("pages a full post with `before`, learns the route pages, visits it on the live re-walk cycle and asks for unnamed authors", async (context) => {
    if (!testDb) return context.skip();
    const pageId = await seedPage("live");
    await seedPost(pageId, P(1), daysAgo(1));
    await seedUnnamedComment(pageId, P(1), "800000000000000001", "500000000000000777");
    await makeDue(pageId, false, "post-replies.walk");
    const { hits, requests } = await runLive(pageId, (req) => {
      if (req.spec === "post.replies") {
        return okResponse({ posts: query(req, "before") === null ? replies(repliesPostId(req), 120, 20) : replies(repliesPostId(req), 100, 3), accounts: [] });
      }
      if (req.spec === "accounts.by_ids") return okResponse([]);
      throw new Error(`unexpected ${req.spec}`);
    }, async () => (await workRow(pageId, "post-replies.authors"))?.state === "done" &&
      (await workRow(pageId, "post-replies.walk"))?.waiting_reason === "not_due", {
      settings: settingsWith({ fanslyRepliesRewalkCycleDays: 30 }),
    });

    expect(hits).toEqual(["post.replies", "post.replies", "accounts.by_ids"]);
    expect(requests.slice(0, 2).map((req) => [repliesPostId(req), query(req, "before")])).toEqual([
      [P(1), null],
      [P(1), "8000000000000000101"],
    ]);
    expect(query(requests[2]!, "ids")).toBe("500000000000000777");
    const now = Date.now();
    const visited = await queueRow(pageId, "post_replies", P(1));
    expect(visited).toMatchObject({ consecutive_failures: 0, known_count: 23 });
    expectNear(visited!.next_due_at, now + 30 * DAY_MS);
    const walk = await workRow(pageId, "post-replies.walk");
    expect(walk).toMatchObject({ state: "open", waiting_reason: "not_due" });
    expect(walk!.cursor).toMatchObject({
      paginationMode: "before",
      paginationAnnounced: true,
      hydratedAuthorRefs: ["500000000000000777"],
      walk: null,
      last: { postId: P(1), pages: 2, replies: 23, rootsKnown: 1, rootsWalked: 1 },
    });
    // The journal carries the legacy envelope: the post and the cursor of each page.
    const journal = await observations(pageId);
    expect(journal.map((row) => row.kind)).toEqual(["post_replies", "post_replies", "account_lookup"]);
    expect(journal[0]!.payload).toMatchObject({ walk: { postId: P(1), before: null }, response: { posts: expect.any(Array) } });
    expect(journal[1]!.payload).toMatchObject({ walk: { postId: P(1), before: "8000000000000000101" } });
    expect(await coverage(pageId, "post_replies")).toMatchObject({ status: "provider_exhausted", expected_count: 1, observed_unique_count: 1 });
  });

  it("a full page applied from the journal after a crash pages on exactly as the in-memory apply does", async (context) => {
    if (!testDb) return context.skip();
    const pageId = await seedPage("live");
    await seedPost(pageId, P(1), daysAgo(1));
    await makeDue(pageId, false, "post-replies.walk");
    const { firstRequests, requests } = await runLiveCrashingAfterCapture(pageId, (req) => okResponse({
      posts: query(req, "before") === null ? replies(repliesPostId(req), 120, 20) : replies(repliesPostId(req), 100, 3),
      accounts: [],
    }), () => true, async () => (await workRow(pageId, "post-replies.walk"))?.waiting_reason === "not_due");

    expect(firstRequests.map((req) => [repliesPostId(req), query(req, "before")])).toEqual([[P(1), null]]);
    // The restarted owner reads the journaled first page (no second bare
    // call) and goes on with its cursor.
    expect(requests.map((req) => [repliesPostId(req), query(req, "before")])).toEqual([[P(1), "8000000000000000101"]]);
    expect(await attemptLog(pageId, "post-replies.walk")).toEqual([
      { owner_generation: "1", operation: "post.replies", apply_state: "applied" },
      { owner_generation: "2", operation: "post.replies", apply_state: "applied" },
    ]);
    expect(await queueRow(pageId, "post_replies", P(1))).toMatchObject({ consecutive_failures: 0, known_count: 23 });
    const walk = await workRow(pageId, "post-replies.walk");
    expect(walk).toMatchObject({ state: "open", waiting_reason: "not_due", failure_count: 0 });
    expect(walk!.cursor).toMatchObject({ paginationMode: "before", walk: null, last: { postId: P(1), pages: 2, replies: 23 } });
    expect(await coverage(pageId, "post_replies")).toMatchObject({ status: "provider_exhausted", expected_count: 1, observed_unique_count: 1 });
  });

  it("a route that serves the same page again is single-page: the walk stops and never pages again", async (context) => {
    if (!testDb) return context.skip();
    const pageId = await seedPage("live");
    await seedPost(pageId, P(1), daysAgo(1));
    await seedPost(pageId, P(2), daysAgo(2));
    await makeDue(pageId, false, "post-replies.walk");
    const { requests } = await runLive(pageId, (req) => okResponse({ posts: replies(repliesPostId(req), 120, 20) }),
      async () => (await workRow(pageId, "post-replies.walk"))?.waiting_reason === "not_due");

    // P(1) (newest) is paged once and proves the route single-page; P(2) is
    // read bare only.
    expect(requests.map((req) => [repliesPostId(req), query(req, "before")])).toEqual([
      [P(1), null],
      [P(1), "8000000000000000101"],
      [P(2), null],
    ]);
    const walk = await workRow(pageId, "post-replies.walk");
    expect(walk!.cursor).toMatchObject({ paginationMode: "single_page" });
    for (const ref of [P(1), P(2)]) expect((await queueRow(pageId, "post_replies", ref))!.last_visited_at).toBeInstanceOf(Date);
    // Every root walked and no stored comment marked possibly truncated (the
    // canonicalizer marks those; none is stored here): the archive reads complete.
    expect(await coverage(pageId, "post_replies")).toMatchObject({ status: "provider_exhausted", expected_count: 2, observed_unique_count: 2 });
  });

  it("a failing post opens its queue row's breaker and the walk moves on to the next due post", async (context) => {
    if (!testDb) return context.skip();
    const pageId = await seedPage("live");
    await seedPost(pageId, P(1), daysAgo(1));
    await seedPost(pageId, P(2), daysAgo(2));
    await makeDue(pageId, false, "post-replies.walk");
    const { requests } = await runLive(pageId, (req) => (repliesPostId(req) === P(1) ? statusResponse(404) : okResponse({ posts: [] })),
      async () => (await workRow(pageId, "post-replies.walk"))?.waiting_reason === "not_due");

    expect(requests.map((req) => repliesPostId(req))).toEqual([P(1), P(2)]);
    const now = Date.now();
    const failed = await queueRow(pageId, "post_replies", P(1));
    expect(failed).toMatchObject({ last_visited_at: null, consecutive_failures: 1 });
    expectNear(failed!.next_due_at, now + 60_000, 30_000);
    expect(await queueRow(pageId, "post_replies", P(2))).toMatchObject({ consecutive_failures: 0, known_count: 0 });
    expect((await workRow(pageId, "post-replies.walk"))!.failure_count).toBe(0);
  });
});

// ── shadow ──────────────────────────────────────────────────────────────────

describe("shadow", () => {
  it("plans and paces the content resources, walks every due subject once, and writes nothing but its own work and attempts", async (context) => {
    if (!testDb) return context.skip();
    const pageId = await seedPage("shadow");
    for (const [index, age] of [1, 2, 3, 40, 200].entries()) await seedPost(pageId, P(index + 1), daysAgo(age));
    const registry = await quietRegistry(pageId, true);
    for (const key of ["notifications.forward", "posts.refresh", "posts.engagement", "post-replies.walk"]) await makeDue(pageId, true, key);
    const queueBefore = await queueSnapshot(pageId);
    const before = await tableCounts(testDb.pool);
    await drive(pageId, "shadow", registry, null, async () => {
      const replies = await workRow(pageId, "post-replies.walk", true);
      const engagement = await workRow(pageId, "posts.engagement", true);
      return (await attempts(pageId, "post-replies.walk", "true")) === 5 && replies?.waiting_reason === "not_due" &&
        engagement?.cursor.shadow !== undefined && (engagement.cursor.shadow as { ended?: boolean }).ended === true &&
        (await attempts(pageId, "posts.refresh", "true")) === 4 && (await attempts(pageId, "notifications.forward", "true")) === 1;
    });

    const rows = await testDb.pool.query<{ resource: string; operation: string; n: number }>(
      `select resource, operation, count(*)::int as n from sync_attempts
        where page_id = $1 and shadow and outcome = 'shadow' and apply_state = 'skipped'
        group by 1, 2 order by 1, 2`,
      [pageId],
    );
    // Three posts within 14 days ⇒ two estimated timeline pages, each followed
    // by its tips read; five due posts ⇒ one engagement batch and one reply
    // read per post.
    expect(rows.rows).toEqual([
      { resource: "notifications.forward", operation: "notifications.page", n: 1 },
      { resource: "post-replies.walk", operation: "post.replies", n: 5 },
      { resource: "posts.engagement", operation: "posts.by_ids", n: 1 },
      { resource: "posts.refresh", operation: "posts.timeline", n: 2 },
      { resource: "posts.refresh", operation: "posts.tips", n: 2 },
    ]);
    // Each due post exactly once, in walk order (newest never-walked first).
    const replyRequests = await testDb.pool.query<{ path: string }>(
      "select request ->> 'path' as path from sync_attempts where page_id = $1 and resource = 'post-replies.walk' order by id",
      [pageId],
    );
    expect(replyRequests.rows.map((row) => row.path)).toEqual([1, 2, 3, 4, 5].map((index) => `/post/${P(index)}/replies`));
    // Each step names its pass besides its subjects (the next pass asks them
    // again: the shadow report's endless-walk check tells the two apart).
    const positions = await testDb.pool.query<{ resource: string; position: unknown; ids: string[] | null }>(
      `select resource, request -> 'position' as position, request -> 'params' -> 'ids' as ids from sync_attempts
        where page_id = $1 and resource in ('posts.engagement', 'post-replies.walk') order by resource, id`,
      [pageId],
    );
    const batch = positions.rows.at(-1)!.ids!;
    expect(batch).toHaveLength(5);
    expect(positions.rows.map(({ resource, position }) => ({ resource, position }))).toEqual([
      ...[1, 2, 3, 4, 5].map((index) => ({ resource: "post-replies.walk", position: { pass: 1, postId: P(index) } })),
      { resource: "posts.engagement", position: { pass: 1, ids: batch } },
    ]);
    expect(await countRows(testDb.pool, "select count(*)::int as n from sync_attempts where page_id = $1 and not shadow", [pageId])).toBe(0);
    const after = await tableCounts(testDb.pool);
    // Every work row it moved already stood there (polls and standing walks;
    // no reply author is unnamed, so no follow-up): only attempts were added.
    expect(changedTables(before, after)).toEqual(["sync_attempts"]);
    expect(await queueSnapshot(pageId)).toEqual(queueBefore);
    // The walks rest until their next pass: no live write, no new attempt.
    const replies = await workRow(pageId, "post-replies.walk", true);
    expect(replies!.due_at.getTime() - Date.now()).toBeGreaterThan(5 * HOUR_MS);
  });
});

// ── replay (shadow report B5) ───────────────────────────────────────────────

describe("replay of legacy observations", () => {
  it("a journaled page matches when every draft's dedup key is stored, and names the missing ones otherwise", async (context) => {
    if (!testDb) return context.skip();
    const pageId = await seedPage("live");
    const registry = createEngineRegistry(FANSLY_RESOURCE_SPECS);
    const ctx = { db: db(), pageId };
    const observation = (kind: string, payload: unknown) => ({ id: 1, receivedAt: new Date(), kind, pageId, payload });

    const notifications = await registry.module("notifications.forward");
    expect(await notifications.replay!(observation("notifications", { notifications: [] }), ctx)).toEqual({ kind: "match", detail: { drafts: 0 } });
    const posts = await registry.module("posts.refresh");
    const verdict = await posts.replay!(observation("posts", { posts: [timelinePost(P(1), daysAgo(1))] }), ctx);
    expect(verdict).toMatchObject({ kind: "mismatch", reason: "events_missing" });
    expect(verdict.kind === "mismatch" ? verdict.detail?.missing : null).toBeGreaterThan(0);
    expect(await posts.replay!(observation("posts", { posts: "not a list" }), ctx)).toMatchObject({ kind: "mismatch", reason: "family_rejected" });
  });
});
