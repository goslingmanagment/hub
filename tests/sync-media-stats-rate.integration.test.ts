import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { upsertDemand, type Database } from "@agency_hub_core/db";
import type { FanslyWireOutcome, FanslyWireRequest } from "@agency_hub_core/fansly";

import { MEDIA_STATS_SPACING_MS } from "../apps/runtime/src/sync/engine/errors.ts";
import { createEngineRegistry, type EngineRegistry, type ResourceModule } from "../apps/runtime/src/sync/engine/resource.ts";
import { fanslyCaptureCodec } from "../apps/runtime/src/sync/fansly/capture.ts";
import { fanslyResourceSpec } from "../apps/runtime/src/sync/fansly/registry.ts";
import { statsBody } from "./helpers/fansly-media-stats-fixtures.ts";
import { resetIntegrationDatabase, startIntegrationTestDatabase, type StartedTestDatabase } from "./helpers/db.ts";
import {
  makeTestActor,
  okResponse,
  RecordingAlerts,
  RecordingMetrics,
  ScriptedLiveTransport,
  seedSyncPage,
  testSpec,
  waitFor,
} from "./helpers/sync-engine-host.ts";

// Owner decision №20 (2026-10-02; lilly-1's 429 at 21:12:04 UTC after its
// media-stats walk read `/it/moie/statsnew` at the page pace): the media
// statistics are read like the conversation list (№14), through the real
// actor and commits against a real database. Pinned: two requests on the
// media-stats route of one page are never admitted closer than 5 s — a demand
// that pulls the walk forward and a restarted actor included — while other
// work keeps the page pace in between; a 429 there holds only the media-stats
// walk (`Retry-After`, else the list's ladder), never the page, and the chat
// and money reads still go out; a shadow page paces its simulated walk the
// same way, so the shadow report counts what the live walk will send.

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
const WALK = "media-stats.walk";
const BACKFILL_DONE = {
  version: 1, nextBeforeMs: 0, emptyStreak: 2, done: true, floorAt: null, stopReason: "created_at_floor", floorBasis: "created_at",
  guard: { spanDays: 31, narrowed: false, lastAfterMs: null, lastBeforeMs: null, lastObservationId: null },
};

const itemOf = (n: number) => `7770000000000000${String(n).padStart(2, "0")}`;

async function seedPage(mode: "live" | "shadow"): Promise<number> {
  const { pageId } = await seedSyncPage({ db: db(), pool: testDb!.pool }, { mode, guard: mode === "live" ? "fansly_sync_engine" : null });
  await testDb!.pool.query(
    "update pages set external_page_id = $2, last_verified_at = clock_timestamp() - interval '1 minute' where id = $1",
    [pageId, OWN_ID],
  );
  return pageId;
}

/** A 60-day item visited 10 days ago, its backfill done: one refresh window. */
async function seedItem(pageId: number, ref: string): Promise<void> {
  const createdAt = new Date(Date.now() - 60 * DAY_MS);
  await testDb!.pool.query(
    `insert into creator_media (page_id, platform, media_offer_ref, first_origin, created_at_platform,
            first_observed_at, last_observed_at, content_hash, source_event_id, source_observation_id, source_account_seq)
     values ($1, 'fansly', $2, 'post', $3, $3, $3, $4, 1, 1, 1)`,
    [pageId, ref, createdAt, "f".repeat(64)],
  );
  await testDb!.pool.query(
    `insert into subject_refresh_state (page_id, plane, subject_ref, refresh_class, next_due_at, last_visited_at, backfill_cursor)
     values ($1, 'media_stats', $2, 'fresh', clock_timestamp(), $3, $4::jsonb)`,
    [pageId, ref, new Date(Date.now() - 10 * DAY_MS), JSON.stringify(BACKFILL_DONE)],
  );
}

async function demand(pageId: number, resource: string, shadow = false, subject = ""): Promise<void> {
  const spec = fanslyResourceSpec(resource)!;
  await upsertDemand(db(), { pageId, shadow, resource, subject, kind: spec.kind, class: spec.class, demand: { reasons: ["test"] } });
}

/** A stand-in that reads `/polls` once, then is done. */
function oneRead(): ResourceModule {
  return {
    async plan() {
      return { kind: "request", request: { spec: "polls", params: {} } };
    },
    async apply() {
      return { work: { satisfiesRevision: true, close: "done", closeReason: "stand_in" }, followups: [] };
    },
    async shadow() {
      return { work: { satisfiesRevision: true, close: "done" }, followups: [] };
    },
  };
}

/** A stand-in that keeps reading `/polls` as fast as the page pace lets it. */
function busy(): ResourceModule {
  return {
    async plan() {
      return { kind: "request", request: { spec: "polls", params: {} } };
    },
    async apply(_tx, input) {
      return { work: { satisfiesRevision: false, nextDueAt: input.now }, followups: [] };
    },
    async shadow(_work, _request, ctx) {
      return { work: { satisfiesRevision: false, nextDueAt: ctx.now }, followups: [] };
    },
  };
}

function registry(options: { busy?: boolean } = {}): EngineRegistry {
  return createEngineRegistry([
    fanslyResourceSpec(WALK)!,
    testSpec("dm-messages.head", oneRead(), { fence: "dm_archive" }),
    testSpec("transactions.head", options.busy === true ? busy() : oneRead(), options.busy === true
      ? { kind: "goal", fence: "dm_archive" }
      : { fence: "dm_archive" }),
  ]);
}

function query(req: FanslyWireRequest, name: string): string | null {
  return new URL(req.url).searchParams.get(name);
}

function mediaAnswer(req: FanslyWireRequest): FanslyWireOutcome {
  return okResponse(statsBody({
    mediaOfferRef: query(req, "mediaOfferId")!,
    afterMs: Number(query(req, "afterDate")),
    beforeMs: Number(query(req, "beforeDate")),
    periodMs: Number(query(req, "period")),
  }));
}

function tooMany(retryAfter: string | null): FanslyWireOutcome {
  const bodyText = JSON.stringify({ success: false, error: { code: 429 } });
  return {
    kind: "response",
    status: 429,
    headers: retryAfter === null ? {} : { "retry-after": retryAfter },
    bodyText,
    bodyBytes: bodyText.length,
    sendMark: "request_start",
  };
}

interface Attempt {
  id: number;
  resource: string;
  operation: string;
  admitted_at: Date;
  sent_at: Date | null;
  completed_at: Date | null;
  http_status: number | null;
  error_class: string | null;
  shadow: boolean;
}

async function attemptsOf(pageId: number): Promise<Attempt[]> {
  const result = await testDb!.pool.query<Attempt>(
    `select id::int as id, resource, operation, admitted_at, sent_at, completed_at, http_status, error_class, shadow
       from sync_attempts where page_id = $1 order by id`,
    [pageId],
  );
  return result.rows;
}

async function visited(pageId: number): Promise<number> {
  const result = await testDb!.pool.query<{ n: number }>(
    "select count(*)::int as n from subject_refresh_state where page_id = $1 and plane = 'media_stats' and last_visited_at > clock_timestamp() - interval '1 hour'",
    [pageId],
  );
  return result.rows[0]!.n;
}

async function walkRow(pageId: number, shadow = false) {
  const result = await testDb!.pool.query<{ waiting_reason: string | null; due_at: Date; state: string }>(
    "select waiting_reason, due_at, state from sync_work where page_id = $1 and resource = $2 and shadow = $3 order by id desc limit 1",
    [pageId, WALK, shadow],
  );
  return result.rows[0] ?? null;
}

/** Run a live actor until `done`, then stop it. */
async function runLive(
  pageId: number,
  reg: EngineRegistry,
  transport: ScriptedLiveTransport,
  done: () => Promise<boolean>,
  alerts = new RecordingAlerts(),
  metrics = new RecordingMetrics(),
  timeoutMs = 40_000,
): Promise<void> {
  const { actor, stop, abort } = await makeTestActor({
    db: db(), pageId, mode: "live", registry: reg, transport, ownRef: OWN_ID, capture: fanslyCaptureCodec, alerts, metrics,
  });
  const running = actor.run({ stop: stop.signal, abort: abort.signal });
  try {
    await waitFor(async () => ((await done()) ? true : null), timeoutMs, "the walk to settle");
  } finally {
    stop.abort();
    await running;
  }
}

/** Every pair of consecutive media-stats attempts is ≥ the spacing apart:
 *  the next admission after the previous one's last instant (database
 *  clock), and the sends (the engine's clock). */
function expectSpaced(media: readonly Attempt[]): void {
  for (let i = 1; i < media.length; i += 1) {
    const previous = media[i - 1]!;
    const previousLast = Math.max(previous.admitted_at.getTime(), previous.completed_at?.getTime() ?? 0);
    expect(media[i]!.admitted_at.getTime() - previousLast, `admission ${i}`).toBeGreaterThanOrEqual(MEDIA_STATS_SPACING_MS);
    if (media[i]!.sent_at !== null && previous.sent_at !== null) {
      expect(media[i]!.sent_at!.getTime() - previous.sent_at.getTime(), `send ${i}`).toBeGreaterThanOrEqual(MEDIA_STATS_SPACING_MS);
    }
  }
}

describe("media-stats spacing (owner decision №20)", () => {
  it("admits two media-stats steps ≥ 5 s apart through demand bumps and a restarted actor, other work at the page pace between", async (context) => {
    if (!testDb) return context.skip();
    const pageId = await seedPage("live");
    for (const n of [1, 2, 3, 4]) await seedItem(pageId, itemOf(n));
    const reg = registry({ busy: true });
    await demand(pageId, WALK);
    await demand(pageId, "transactions.head");
    const transport = new ScriptedLiveTransport();
    transport.respond = (req) => (req.spec === "media.offer_stats" ? mediaAnswer(req) : okResponse());
    // Every media request is followed by new demand on the walk: its row's
    // due time is pulled to now each time.
    transport.onHit = async (req) => {
      if (req.spec === "media.offer_stats") await demand(pageId, WALK);
    };
    const metrics = new RecordingMetrics();
    await runLive(pageId, reg, transport, async () => (await visited(pageId)) >= 2, new RecordingAlerts(), metrics);
    // The process restarts between two steps: the new actor reads the spacing
    // from the journal, not from memory.
    const restarted = new ScriptedLiveTransport();
    restarted.respond = transport.respond;
    restarted.onHit = transport.onHit;
    await demand(pageId, WALK);
    await runLive(pageId, reg, restarted, async () => (await visited(pageId)) >= 4, new RecordingAlerts(), metrics);

    const all = await attemptsOf(pageId);
    const media = all.filter((attempt) => attempt.operation === "media.offer_stats");
    expect(media).toHaveLength(4);
    expect(media.every((attempt) => attempt.http_status === 200)).toBe(true);
    expectSpaced(media);
    // Other work went out between every two media-stats steps, at the page
    // pace (the test pause is 30 ms): never a 5 s stall of the page.
    for (let i = 1; i < media.length; i += 1) {
      const between = all.filter((attempt) => attempt.id > media[i - 1]!.id && attempt.id < media[i]!.id);
      expect(between.length, `other reads between media steps ${i - 1} and ${i}`).toBeGreaterThanOrEqual(5);
      expect(between.every((attempt) => attempt.resource === "transactions.head"), `between ${i}`).toBe(true);
    }
    const firstRun = transport.hits.filter((hit) => hit.spec === "polls");
    const gaps = firstRun.slice(1).map((hit, i) => hit.mono - firstRun[i]!.mono);
    expect(Math.max(...gaps)).toBeLessThan(MEDIA_STATS_SPACING_MS / 2);
    // The demand bumps met the spacing: the walk was put off, nothing sent.
    expect(metrics.get("sync_endpoint_spaced")).toBeGreaterThan(0);
  }, 90_000);
});

describe("a 429 on the media statistics (owner decision №20)", () => {
  async function run429(retryAfter: string | null) {
    const pageId = await seedPage("live");
    for (const n of [1, 2]) await seedItem(pageId, itemOf(n));
    const reg = registry();
    await demand(pageId, WALK);
    let media = 0;
    const transport = new ScriptedLiveTransport();
    transport.respond = (req) => {
      if (req.spec !== "media.offer_stats") return okResponse();
      media += 1;
      if (media === 1) {
        // While the walk is held, a chat and the money head are asked for.
        void demand(pageId, "dm-messages.head", false, "g1");
        void demand(pageId, "transactions.head");
        return tooMany(retryAfter);
      }
      return mediaAnswer(req);
    };
    const alerts = new RecordingAlerts();
    let heldSeen: { hold_kind: string | null; kind: string | null; until: Date | null } | null = null;
    await runLive(pageId, reg, transport, async () => {
      if (heldSeen === null) {
        const page = await testDb!.pool.query<{ hold_kind: string | null; kind: string | null; until: Date | null }>(
          `select hold_kind, resource_holds -> 'media-stats' ->> 'kind' as kind,
                  (resource_holds -> 'media-stats' ->> 'until')::timestamptz as until
             from sync_pages where page_id = $1`, [pageId]);
        if (page.rows[0]?.kind !== null && page.rows[0]?.kind !== undefined) heldSeen = page.rows[0];
      }
      return (await visited(pageId)) >= 2;
    }, alerts);
    return { pageId, transport, alerts, heldSeen: heldSeen as { hold_kind: string | null; kind: string | null; until: Date | null } | null };
  }

  for (const [retryAfter, holdMs] of [[null, 5_000], ["7", 7_000]] as const) {
    it(`holds only the walk (${retryAfter === null ? "the ladder's 5 s" : `Retry-After ${retryAfter} s`}), never the page; chat and money still go out`, async (context) => {
      if (!testDb) return context.skip();
      const { pageId, transport, alerts, heldSeen } = await run429(retryAfter);
      const all = await attemptsOf(pageId);
      const media = all.filter((attempt) => attempt.operation === "media.offer_stats");
      expect(media.map((attempt) => [attempt.http_status, attempt.error_class])).toEqual([
        [429, "rate_limit_media_stats"], [200, null], [200, null],
      ]);
      // The hold was the walk's own, the page never held.
      expect(heldSeen).toMatchObject({ hold_kind: null, kind: "rate_limit_media_stats" });
      const holdMsSet = heldSeen!.until!.getTime() - media[0]!.completed_at!.getTime();
      expect(holdMsSet).toBeGreaterThan(holdMs - 1_000);
      expect(holdMsSet).toBeLessThanOrEqual(holdMs + 1_000);
      const page = await testDb.pool.query<{ hold_kind: string | null; hold_step: number }>(
        "select hold_kind, hold_step from sync_pages where page_id = $1", [pageId]);
      expect(page.rows).toEqual([{ hold_kind: null, hold_step: 0 }]);
      // The chat and the money head went out inside the walk's hold.
      const order = transport.hits.map((hit) => hit.spec);
      const first = order.indexOf("media.offer_stats");
      const second = order.indexOf("media.offer_stats", first + 1);
      expect(order.slice(first + 1, second).filter((spec) => spec === "polls").length).toBe(2);
      const between = all.filter((attempt) => attempt.id > media[0]!.id && attempt.id < media[1]!.id).map((attempt) => attempt.resource).sort();
      expect(between).toEqual(["dm-messages.head", "transactions.head"]);
      // The next media request waited for the hold (and the spacing).
      expect(media[1]!.admitted_at.getTime() - media[0]!.completed_at!.getTime()).toBeGreaterThanOrEqual(Math.min(holdMs, heldSeen!.until!.getTime() - media[0]!.completed_at!.getTime()) - 50);
      expectSpaced(media);
      // A single 429 of the walk pages nobody (only the ladder's top does).
      expect(alerts.opened.filter((alert) => alert.subKey === "page_stopped")).toEqual([]);
    }, 60_000);
  }
});

describe("shadow paces the media-stats walk the same way (owner decision №20)", () => {
  it("simulated media-stats steps are admitted ≥ 5 s apart; the walk visits every item and rests", async (context) => {
    if (!testDb) return context.skip();
    const pageId = await seedPage("shadow");
    for (const n of [1, 2, 3]) await seedItem(pageId, itemOf(n));
    const reg = registry({ busy: true });
    await demand(pageId, WALK, true);
    await demand(pageId, "transactions.head", true);
    const { actor, stop, abort } = await makeTestActor({ db: db(), pageId, mode: "shadow", registry: reg, ownRef: OWN_ID });
    const running = actor.run({ stop: stop.signal, abort: abort.signal });
    try {
      await waitFor(async () => ((await walkRow(pageId, true))?.waiting_reason === "not_due" ? true : null), 40_000, "the shadow walk to rest");
    } finally {
      stop.abort();
      await running;
    }
    const all = await attemptsOf(pageId);
    expect(all.every((attempt) => attempt.shadow)).toBe(true);
    const media = all.filter((attempt) => attempt.operation === "media.offer_stats");
    // One shadow step per item (each a one-window refresh): the demand the
    // shadow report counts is the live walk's.
    expect(media).toHaveLength(3);
    expectSpaced(media);
    for (let i = 1; i < media.length; i += 1) {
      expect(all.filter((attempt) => attempt.id > media[i - 1]!.id && attempt.id < media[i]!.id).length).toBeGreaterThanOrEqual(5);
    }
  }, 60_000);
});
