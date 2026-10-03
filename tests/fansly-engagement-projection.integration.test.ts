// WP-F2 end to end: journaled `/notifications` responses become the engagement
// core, and stay reproducible from the ledger alone.
//
// The claims here are database claims, and the two that matter most are the
// ones no other projector in this tree has to make:
//
//  - HEAD PRECEDENCE IS THE PROVIDER'S `occurred_at`, NEVER `account_seq`. The
//    deep backfill walks BACKWARDS, so it appends OLDER facts at HIGHER seq: a
//    projector that ordered by ledger position would let a year-old fact
//    overwrite today's. The blocking test is "a higher-seq, older-occurred_at
//    event cannot regress the head".
//  - `post_likes` STAYS EMPTY. Nothing this family emits can write a liker, and
//    a 2007 purchase — the code the shipped spec called "PostLikeUndo" — must
//    prove it by landing as a purchase signal and touching nothing else.
//
// Plus the ordinary ones: replay is a no-op, ids dedupe across overlapping
// pages, and a truncate-and-replay reproduces every row while
// `subject_refresh_state` — capture-plane operational state (§3.4) — is not
// touched at all.

import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";

import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import {
  createFanslyPage,
  createModel,
  ensureDomainEventPartitions,
  insertObservation,
  listMediaStatsRefreshChunk,
  markSubjectRefreshDirty,
  upsertCreatorMedia,
} from "@agency_hub_core/db";

import {
  resetCanonicalizeSweepRuntime,
  runCanonicalization,
} from "../apps/runtime/src/services/canonicalize-driver.ts";
import { runNotificationReadStateReplay } from "../apps/runtime/src/services/fansly-notification-read-state-replay.ts";
import {
  FANSLY_ENGAGEMENT_PROJECTION,
  FANSLY_ENGAGEMENT_PROJECTION_TABLES,
  rebuildFanslyEngagementProjection,
  runFanslyEngagementProjection,
} from "../apps/runtime/src/services/projections/fansly-engagement.ts";
import { mediaStatsOwnerTiers } from "../apps/runtime/src/sync/fansly/resources/media-stats.ts";
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
  resetCanonicalizeSweepRuntime();
});

const FIXTURES = path.resolve("tests/fixtures/fansly-engagement");

function fixture(name: string): Record<string, unknown> {
  return JSON.parse(readFileSync(path.join(FIXTURES, name), "utf8")) as Record<string, unknown>;
}

function sha256(value: unknown): Buffer {
  return createHash("sha256").update(JSON.stringify(value)).digest();
}

function appStub() {
  return {
    db: testDb!.db,
    logger: { info: () => {}, warn: () => {}, error: () => {} },
  } as never;
}

async function seedPage() {
  const model = await createModel(testDb!.db, { slug: "engagement", name: "Engagement" });
  if (!model) throw new Error("Expected the engagement test model to be created");
  const page = await createFanslyPage(testDb!.db, { modelId: model.id, label: "engagement-page" });
  if (!page) throw new Error("Expected the engagement test page to be created");
  await testDb!.pool.query("update pages set external_page_id = $1 where id = $2", [
    "acct-engagement",
    page.id,
  ]);
  await ensureDomainEventPartitions(testDb!.db);
  return page;
}

async function seedObservation(pageId: number, key: string, payload: unknown, receivedAt?: Date) {
  return insertObservation(testDb!.db, {
    source: "pull",
    producer: "sync:fansly:notifications",
    platform: "fansly",
    accountId: pageId,
    kind: "notifications",
    payload,
    payloadHash: sha256(key),
    idempotencyKey: `notifications:${key}`,
    ...(receivedAt === undefined ? {} : { receivedAt }),
  });
}

/** Received two days after the census fixture's newest purchase (2026-08-19),
 *  so its purchases stay inside the purchase-signal horizon whatever the wall
 *  clock says: that horizon is measured from RECEIPT. */
const CENSUS_RECEIVED_AT = new Date("2026-08-21T12:00:00.000Z");

/** One page carrying ONE 2007 purchase, built from the census template. */
function purchasePage(options: { id: string; correlationId: string; createdAt: Date }) {
  const census = fixture("notifications-census.json");
  const template = (census.notifications as Record<string, unknown>[])
    .find((row) => row.type === 2007)!;
  const seconds = Math.floor(options.createdAt.getTime() / 1000);
  return {
    ...census,
    notifications: [{
      ...template,
      id: options.id,
      idString: options.id,
      correlationId: options.correlationId,
      createdAt: seconds,
      acknowledgedAt: seconds + 60,
    }],
  };
}

async function mediaStatsRow(pageId: number, subjectRef: string) {
  const [row] = await rows<{
    dirty_reason: string | null;
    refresh_class: string | null;
    next_due_at: Date | null;
  }>(
    `select dirty_reason, refresh_class, next_due_at from subject_refresh_state
      where page_id = $1 and plane = 'media_stats' and subject_ref = $2`,
    [pageId, subjectRef],
  );
  return row ?? null;
}

/** A media_stats row the lane has ANSWERED: visited, clean, due in a week. */
async function seedVisitedRow(pageId: number, subjectRef: string, visitedAt: Date) {
  await testDb!.pool.query(
    `insert into subject_refresh_state (
       page_id, plane, subject_ref, refresh_class, next_due_at, last_visited_at
     ) values ($1, 'media_stats', $2, 'mid', $3::timestamptz + interval '7 days', $3)`,
    [pageId, subjectRef, visitedAt],
  );
}

/** A never-visited media_stats row — the queue as the enqueue leaves it. */
async function seedQueuedRow(pageId: number, subjectRef: string) {
  await testDb!.pool.query(
    `insert into subject_refresh_state (page_id, plane, subject_ref, refresh_class, next_due_at)
     values ($1, 'media_stats', $2, 'fresh', $3)`,
    [pageId, subjectRef, CENSUS_RECEIVED_AT],
  );
}

/** Queue every media the census's 2007 purchases bought, never visited — the
 *  queue the purchase mark updates (it never adds to it). */
async function queueCensusPurchases(pageId: number, census: Record<string, unknown>) {
  const bought = new Set(
    (census.notifications as Record<string, unknown>[])
      .filter((row) => row.type === 2007)
      .map((row) => String(row.correlationId)),
  );
  for (const subjectRef of bought) {
    await seedQueuedRow(pageId, subjectRef);
  }
  return bought;
}

async function dirtyMediaStatsRows(pageId: number): Promise<number> {
  const [found] = await rows<{ n: string }>(
    `select count(*)::text as n from subject_refresh_state
      where page_id = $1 and plane = 'media_stats' and dirty_reason is not null`,
    [pageId],
  );
  return Number(found!.n);
}

/** A `creator_media` head written the way the media-plane projector writes it,
 *  queue hook included, from an observation of `firstOrigin`. */
async function seedMediaHead(
  pageId: number,
  mediaOfferRef: string,
  firstOrigin: "dm_sidecar" | "post",
  createdAtPlatform: Date,
) {
  await upsertCreatorMedia(testDb!.db, {
    pageId,
    platform: "fansly",
    mediaOfferRef,
    mediaRef: null,
    previewRef: null,
    bundleRefs: [],
    mediaType: null,
    mimeType: null,
    width: null,
    height: null,
    durationMs: null,
    priceMills: null,
    permissionEntries: [],
    permissionFlags: null,
    likeCount: null,
    salesCount: null,
    salesNetMills: null,
    salesPendingMills: null,
    createdAtPlatform,
    deletedAtPlatform: null,
    firstOrigin,
    observedAt: createdAtPlatform,
    contentHash: "c".repeat(64),
    sourceEventId: 1,
    sourceObservationId: 1,
    sourceAccountSeq: 1,
    ownerAccountRef: "acct-engagement",
  });
}

async function project(pageId: number) {
  await runCanonicalization(appStub(), { kinds: ["notifications"] });
  return runFanslyEngagementProjection(appStub(), { accountId: pageId });
}

async function rows<T = Record<string, unknown>>(sql: string, params: unknown[] = []): Promise<T[]> {
  const result = await testDb!.pool.query(sql, params);
  return result.rows as T[];
}

async function count(table: string, pageId: number): Promise<number> {
  const [found] = await rows<{ n: string }>(
    `select count(*)::text as n from ${table} where page_id = $1`,
    [pageId],
  );
  return Number(found!.n);
}

/** A stable content checksum of every projected table, ordered so a rebuild's
 *  row ORDER cannot make an identical projection look different. */
async function checksum(pageId: number): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  for (const table of FANSLY_ENGAGEMENT_PROJECTION_TABLES) {
    const tableRows = await rows(`select * from ${table} where page_id = $1`, [pageId]);
    const normalized = tableRows
      .map((row) => {
        const source = row as Record<string, unknown>;
        const copy: Record<string, unknown> = {};
        for (const key of Object.keys(source).sort()) {
          copy[key] = source[key];
        }
        // Lineage moves on a rebuild (new event ids); the FACT does not.
        delete copy.source_event_id;
        delete copy.source_observation_id;
        delete copy.source_account_seq;
        delete copy.created_at;
        delete copy.updated_at;
        delete copy.first_observed_at;
        delete copy.last_observed_at;
        return JSON.stringify(
          copy,
          (_key, value) => (typeof value === "bigint" ? value.toString() : value),
        );
      })
      .sort();
    out[table] = createHash("sha256").update(JSON.stringify(normalized)).digest("hex");
  }
  return out;
}

const CENSUS_ROWS = 200;

describe("[sync-critical] WP-F2 engagement projections", () => {
  it("projects EVERY row and EVERY code, including the ones it cannot name", async (context) => {
    if (!testDb) {
      context.skip();
      return;
    }
    const page = await seedPage();
    await seedObservation(page.id, "census", fixture("notifications-census.json"));
    await seedObservation(page.id, "edges", fixture("notifications-edge-cases.json"));
    const result = await project(page.id);
    expect(result.applied).toBeGreaterThan(0);

    // 200 census rows + 8 edge rows (the ninth carries no id and is not a
    // notification). The unknown code and the unlabelled 1003 are AMONG them:
    // layer 1 writes every row, which is what makes an unknown code reachable
    // by replay the day somebody names it.
    expect(await count("platform_notifications", page.id)).toBe(CENSUS_ROWS + 8);
    const codes = await rows<{ type_code: number; n: string }>(
      `select type_code, count(*)::text as n from platform_notifications
        where page_id = $1 group by type_code order by type_code`,
      [page.id],
    );
    const byCode = Object.fromEntries(codes.map((row) => [row.type_code, Number(row.n)]));
    expect(byCode[3003]).toBe(98); // 97 census + 1 pre-2024 edge row
    expect(byCode[2007]).toBe(30);
    expect(byCode[99999], "an unnameable code still gets its row").toBe(1);
    expect(byCode[1003], "declared-but-unlabelled is still stored").toBe(1);

    // THE RAW CODE IS WHAT IS STORED (A22-2). Nothing here is a label, and
    // nothing was filtered against a known set.
    const labels = await rows(
      `select 1 from information_schema.columns
        where table_name = 'platform_notifications' and column_name like '%label%'`,
    );
    expect(labels).toHaveLength(0);

    // Rows are dated from the PROVIDER's instant, never from the event's.
    const [historical] = await rows<{ occurred_at: Date }>(
      `select occurred_at from platform_notifications
        where page_id = $1 and notification_ref = '000990000000000008'`,
      [page.id],
    );
    expect(historical!.occurred_at.toISOString()).toBe("2022-08-08T23:06:40.000Z");

    // `metadata` survives both shapes: parsed when it is JSON, {"raw": …} when
    // the platform's own string is not.
    const [notJson] = await rows<{ metadata: Record<string, unknown> }>(
      `select metadata from platform_notifications
        where page_id = $1 and notification_ref = '000990000000000003'`,
      [page.id],
    );
    expect(notJson!.metadata).toEqual({ raw: "not json at all" });
  });

  it("lands a 2007 as a purchase SIGNAL and writes NOTHING to post_likes [E4]", async (context) => {
    if (!testDb) {
      context.skip();
      return;
    }
    const page = await seedPage();
    const census = fixture("notifications-census.json");
    // The mark updates the queue; it never adds to it. The bought media are
    // queued already, the way the media plane queues a post's media.
    const bought = await queueCensusPurchases(page.id, census);
    await seedObservation(page.id, "census", census, CENSUS_RECEIVED_AT);
    const result = await project(page.id);

    // The verbatim row is there…
    const purchases = await rows<{ notification_ref: string; correlation_ref: string }>(
      `select notification_ref, correlation_ref from platform_notifications
        where page_id = $1 and type_code = 2007`,
      [page.id],
    );
    expect(purchases).toHaveLength(30);

    // …the commerce signal marked the bought media DIRTY, and NOTHING fetched
    // anything: WP-F4 is the consumer, this is the note.
    const dirty = await rows<{
      plane: string;
      subject_ref: string;
      refresh_class: string;
      dirty_reason: string;
      next_due_at: Date;
    }>(
      `select plane, subject_ref, refresh_class, dirty_reason, next_due_at
         from subject_refresh_state where page_id = $1 order by subject_ref`,
      [page.id],
    );
    expect(dirty.map((row) => row.subject_ref).sort()).toEqual([...bought].sort());
    expect(result.purchaseSignals).toBeGreaterThan(0);
    for (const row of dirty) {
      expect(row.plane).toBe("media_stats");
      expect(row.refresh_class).toBe("dirty");
      expect(row.dirty_reason).toBe("purchase_notification");
      expect(row.next_due_at).not.toBeNull();
      // The subject is the media the purchase correlated to, never the page.
      expect(purchases.some((purchase) => purchase.correlation_ref === row.subject_ref))
        .toBe(true);
    }

    // AND THE POINT: the code the shipped spec called "PostLikeUndo" wrote
    // nothing to the like table. Not one row.
    expect(await count("post_likes", page.id)).toBe(0);
  });

  it("marks nothing for a purchase older than the horizon at RECEIPT", async (context) => {
    if (!testDb) {
      context.skip();
      return;
    }
    const page = await seedPage();
    await seedQueuedRow(page.id, "000920000000009001");
    await seedQueuedRow(page.id, "000920000000009002");
    // The deep backfill delivers year-old purchases every week. No refresh the
    // mark triggers reaches back that far, so it would buy a call for nothing.
    await seedObservation(page.id, "stale", purchasePage({
      id: "000989999999990001",
      correlationId: "000920000000009001",
      createdAt: new Date("2026-05-20T00:00:00.000Z"),
    }), CENSUS_RECEIVED_AT);
    await seedObservation(page.id, "recent", purchasePage({
      id: "000989999999990002",
      correlationId: "000920000000009002",
      createdAt: new Date("2026-08-20T00:00:00.000Z"),
    }), CENSUS_RECEIVED_AT);
    const result = await project(page.id);

    // The notification row is stored either way: only the SIGNAL is dropped.
    expect(await count("platform_notifications", page.id)).toBe(2);
    expect(result.purchaseSignals).toBe(1);
    expect(await mediaStatsRow(page.id, "000920000000009001")).toMatchObject({
      dirty_reason: null,
      refresh_class: "fresh",
    });
    expect(await mediaStatsRow(page.id, "000920000000009002")).toMatchObject({
      dirty_reason: "purchase_notification",
      refresh_class: "dirty",
    });
  });

  it("does not re-mark an item VISITED after the purchase, and does re-mark one visited before", async (
    context,
  ) => {
    if (!testDb) {
      context.skip();
      return;
    }
    const page = await seedPage();
    const answered = "000920000000009011";
    const stale = "000920000000009012";
    await seedVisitedRow(page.id, answered, new Date("2026-08-20T06:00:00.000Z"));
    await seedVisitedRow(page.id, stale, new Date("2026-08-18T06:00:00.000Z"));
    const purchasedAt = new Date("2026-08-19T06:00:00.000Z");
    await seedObservation(page.id, "answered", purchasePage({
      id: "000989999999990011",
      correlationId: answered,
      createdAt: purchasedAt,
    }), CENSUS_RECEIVED_AT);
    await seedObservation(page.id, "stale", purchasePage({
      id: "000989999999990012",
      correlationId: stale,
      createdAt: purchasedAt,
    }), CENSUS_RECEIVED_AT);
    await project(page.id);

    // Its numbers already include the purchase: a re-read would spend a call on
    // numbers we have.
    expect(await mediaStatsRow(page.id, answered)).toMatchObject({
      dirty_reason: null,
      refresh_class: "mid",
    });
    const remarked = await mediaStatsRow(page.id, stale);
    expect(remarked).toMatchObject({ dirty_reason: "purchase_notification", refresh_class: "dirty" });
    expect(remarked?.next_due_at?.toISOString()).toBe(purchasedAt.toISOString());

    // A REBUILD replays every purchase. It must not re-dirty what the lane has
    // answered since — a repair that should cost zero platform calls.
    await testDb.pool.query(
      `update subject_refresh_state
          set last_visited_at = $3, dirty_reason = null, refresh_class = 'mid'
        where page_id = $1 and plane = 'media_stats' and subject_ref = $2`,
      [page.id, stale, new Date("2026-08-21T06:00:00.000Z")],
    );
    await rebuildFanslyEngagementProjection(appStub(), { accountId: page.id });
    for (const subjectRef of [answered, stale]) {
      expect(await mediaStatsRow(page.id, subjectRef)).toMatchObject({ dirty_reason: null });
    }
  });

  it("queues no media_stats row for a purchase against a known BUNDLE", async (context) => {
    if (!testDb) {
      context.skip();
      return;
    }
    const page = await seedPage();
    const bundleRef = "000920000000009021";
    await testDb.pool.query(
      `insert into creator_media_bundles (
         page_id, platform, bundle_ref, member_refs, first_observed_at, last_observed_at,
         content_hash, source_event_id, source_observation_id, source_account_seq
       ) values ($1, 'fansly', $2, $3::text[], $4, $4, $5, 1, 1, 1)`,
      [page.id, bundleRef, ["000920000000009022"], CENSUS_RECEIVED_AT, "e".repeat(64)],
    );
    await seedObservation(page.id, "bundle", purchasePage({
      id: "000989999999990021",
      correlationId: bundleRef,
      createdAt: new Date("2026-08-20T00:00:00.000Z"),
    }), CENSUS_RECEIVED_AT);
    await project(page.id);

    // The route reads media offers: a bundle ref is never a subject it can
    // answer. Its members are not marked either — that is not this signal.
    expect(await count("platform_notifications", page.id)).toBe(1);
    expect(await mediaStatsRow(page.id, bundleRef)).toBeNull();
    expect(await mediaStatsRow(page.id, "000920000000009022")).toBeNull();
  });

  it("queues and marks nothing for a purchase of media the page showed only in a DM", async (context) => {
    if (!testDb) {
      context.skip();
      return;
    }
    const page = await seedPage();
    // A DM PPV: its head comes from the DM sidecar and nothing else. Owner
    // decision 2026-09-29 — its per-media views are not wanted.
    const dmOnly = "000920000000009031";
    await seedMediaHead(page.id, dmOnly, "dm_sidecar", new Date("2026-08-15T00:00:00.000Z"));
    await seedObservation(page.id, "dm-only", purchasePage({
      id: "000989999999990031",
      correlationId: dmOnly,
      createdAt: new Date("2026-08-20T00:00:00.000Z"),
    }), CENSUS_RECEIVED_AT);
    const result = await project(page.id);

    expect(await count("platform_notifications", page.id)).toBe(1);
    expect(result.purchaseSignals).toBe(0);
    expect(await mediaStatsRow(page.id, dmOnly)).toBeNull();
  });

  it("still marks the queued row of a post's media", async (context) => {
    if (!testDb) {
      context.skip();
      return;
    }
    const page = await seedPage();
    const posted = "000920000000009041";
    await seedMediaHead(page.id, posted, "post", new Date("2026-08-15T00:00:00.000Z"));
    expect(await mediaStatsRow(page.id, posted)).toMatchObject({ dirty_reason: null });
    const purchasedAt = new Date("2026-08-20T00:00:00.000Z");
    await seedObservation(page.id, "posted", purchasePage({
      id: "000989999999990041",
      correlationId: posted,
      createdAt: purchasedAt,
    }), CENSUS_RECEIVED_AT);
    const result = await project(page.id);

    expect(result.purchaseSignals).toBe(1);
    const row = await mediaStatsRow(page.id, posted);
    expect(row).toMatchObject({ dirty_reason: "purchase_notification", refresh_class: "dirty" });
    // Due no later than the purchase: the mark only ever moves it earlier.
    expect(row!.next_due_at!.getTime()).toBeLessThanOrEqual(purchasedAt.getTime());
  });

  it("queues nothing for a purchase projected AHEAD of its media head; the post then queues it unmarked", async (
    context,
  ) => {
    if (!testDb) {
      context.skip();
      return;
    }
    const page = await seedPage();
    const posted = "000920000000009051";
    await seedObservation(page.id, "ahead", purchasePage({
      id: "000989999999990051",
      correlationId: posted,
      createdAt: new Date("2026-08-20T00:00:00.000Z"),
    }), CENSUS_RECEIVED_AT);
    const result = await project(page.id);

    // The ref is unknown to the queue, so the mark has nothing to update. It
    // no longer inserts one: it cannot tell a post's media from a DM PPV.
    expect(result.purchaseSignals).toBe(0);
    expect(await mediaStatsRow(page.id, posted)).toBeNull();

    // The post's media head arrives and queues it the ordinary way. The
    // purchase mark is lost — it is picked as a NEVER-VISITED FRESH item,
    // which is the first thing after the dirty rows anyway.
    await seedMediaHead(page.id, posted, "post", new Date("2026-08-19T00:00:00.000Z"));
    const chunk = await listMediaStatsRefreshChunk(testDb.db, {
      pageId: page.id,
      limit: 10,
      now: CENSUS_RECEIVED_AT,
      tiers: mediaStatsOwnerTiers({ registryOverrides: {} }),
    });
    expect(chunk).toHaveLength(1);
    expect(chunk[0]).toMatchObject({
      subjectRef: posted,
      tier: "fresh",
      dirtyReason: null,
      lastVisitedAt: null,
      priorityBand: 1,
    });
  });

  it("dedupes by id across OVERLAPPING pages", async (context) => {
    if (!testDb) {
      context.skip();
      return;
    }
    const page = await seedPage();
    const census = fixture("notifications-census.json");
    const all = census.notifications as Record<string, unknown>[];
    // Two pages that share 20 rows — exactly what the forward poll's overlap
    // walk produces every time it takes a second page.
    await seedObservation(page.id, "p1", { ...census, notifications: all.slice(0, 50) });
    await seedObservation(page.id, "p2", { ...census, notifications: all.slice(30, 80) });
    await project(page.id);

    // 80 distinct ids in, 80 rows out — not 100.
    expect(await count("platform_notifications", page.id)).toBe(80);
  });

  it("keeps every engagement event out of the deliverable stream, and is a no-op on replay", async (context) => {
    if (!testDb) {
      context.skip();
      return;
    }
    const page = await seedPage();
    await seedObservation(page.id, "census", fixture("notifications-census.json"));
    await project(page.id);

    // The deliverable-stream claim reads the state the first projection left,
    // so it shares this census setup instead of building its own.
    const visible = await rows<{ type: string }>(
      `select distinct type from domain_events where account_id = $1
        and type like any (array['notification.%','engagement.%','media.purchase%'])`,
      [page.id],
    );
    expect(visible.length).toBeGreaterThan(0);
    // The family's checkpoint covers the hidden seq range — which is what the
    // SSE v2 replay validator requires of a gap.
    const [checkpoints] = await rows<{ n: number }>(
      `select count(*)::int as n from domain_events
        where account_id = $1 and type = 'stream.projection_checkpoint'`,
      [page.id],
    );
    expect(Number(checkpoints!.n)).toBeGreaterThan(0);

    const before = await checksum(page.id);
    const beforeEvents = await rows<{ n: string }>(
      `select count(*)::text as n from domain_events where account_id = $1`,
      [page.id],
    );

    resetCanonicalizeSweepRuntime();
    const second = await project(page.id);
    // The same bodies mint the same dedup keys, so nothing is appended and no
    // head moves.
    expect(second.applied).toBe(0);
    expect(await checksum(page.id)).toEqual(before);
    const afterEvents = await rows<{ n: string }>(
      `select count(*)::text as n from domain_events where account_id = $1`,
      [page.id],
    );
    expect(afterEvents[0]!.n).toBe(beforeEvents[0]!.n);
  });

  it("a HIGHER-SEQ, OLDER-occurred_at event cannot regress the head", async (context) => {
    if (!testDb) {
      context.skip();
      return;
    }
    // THE BLOCKING RULE (WP-F2). This is not hypothetical: the deep backfill
    // walks backwards, so it appends OLDER facts at HIGHER account_seq. A
    // projector ordering by ledger position would let a year-old restatement
    // overwrite today's head, permanently and silently.
    const page = await seedPage();
    const base = fixture("notifications-edge-cases.json");
    const rowsIn = base.notifications as Record<string, unknown>[];
    const target = { ...rowsIn[0]! };

    // Capture 1: the CURRENT fact.
    await seedObservation(page.id, "fresh", {
      ...base,
      notifications: [{ ...target, createdAt: 1787100000, acknowledgedAt: 1787100200 }],
    });
    await project(page.id);
    const [head] = await rows<{ occurred_at: Date; acknowledged_at: Date }>(
      `select occurred_at, acknowledged_at from platform_notifications
        where page_id = $1 and notification_ref = $2`,
      [page.id, target.idString],
    );
    expect(head!.occurred_at.toISOString()).toBe("2026-08-19T00:40:00.000Z");

    // Capture 2, appended LATER (higher account_seq) and dated EARLIER — a
    // backfill page restating the same notification with an older instant.
    resetCanonicalizeSweepRuntime();
    await seedObservation(page.id, "backfilled", {
      ...base,
      notifications: [{ ...target, createdAt: 1660000000, acknowledgedAt: 1660000200 }],
    });
    await project(page.id);

    const seqs = await rows<{ account_seq: string; occurred_at: Date }>(
      `select account_seq, occurred_at from domain_events
        where account_id = $1 and type = 'notification.observed' order by account_seq`,
      [page.id],
    );
    // Both events exist, and the OLDER fact really is at the HIGHER seq — the
    // test would be vacuous otherwise.
    expect(seqs.length).toBeGreaterThanOrEqual(2);

    const [after] = await rows<{ occurred_at: Date }>(
      `select occurred_at from platform_notifications
        where page_id = $1 and notification_ref = $2`,
      [page.id, target.idString],
    );
    // THE HEAD DID NOT MOVE.
    expect(after!.occurred_at.toISOString()).toBe("2026-08-19T00:40:00.000Z");
  });

  it("a LATER look at the same createdAt lands the read state; an older look replayed later does not revert it (J7)", async (context) => {
    if (!testDb) {
      context.skip();
      return;
    }
    // The platform serves one notification unread, then read. Same createdAt,
    // so the provider-instant guard alone froze the head at the first look
    // and acknowledged_at stayed NULL although the ledger held the ack.
    const page = await seedPage();
    const base = fixture("notifications-edge-cases.json");
    const target = { ...(base.notifications as Record<string, unknown>[])[5]! };
    const ref = target.idString as string;
    const unread = { ...base, notifications: [{ ...target, acknowledgedAt: null }] };
    const readAt = 1787050500;
    const read = { ...base, notifications: [{ ...target, acknowledgedAt: readAt }] };
    const head = async () => (await rows<{
      acknowledged_at: Date | null;
      source_observation_id: string;
      content_hash: string;
      last_observed_at: Date;
    }>(
      `select acknowledged_at, source_observation_id::text, content_hash, last_observed_at
         from platform_notifications where page_id = $1 and notification_ref = $2`,
      [page.id, ref],
    ))[0]!;

    await seedObservation(page.id, "look-1", unread, new Date("2026-08-19T10:00:00.000Z"));
    await project(page.id);
    expect((await head()).acknowledged_at).toBeNull();

    resetCanonicalizeSweepRuntime();
    const second = await seedObservation(page.id, "look-2", read, new Date("2026-08-19T11:00:00.000Z"));
    await project(page.id);
    const acked = await head();
    expect(acked.acknowledged_at?.toISOString()).toBe(new Date(readAt * 1000).toISOString());
    // One guard for every column: the ack and its lineage move together.
    expect(acked.source_observation_id).toBe(String(second.observationId));
    const [ackEvent] = await rows<{ hash: string }>(
      `select data->>'contentHash' as hash from domain_events
        where account_id = $1 and type = 'notification.observed' and observation_id = $2`,
      [page.id, second.observationId],
    );
    expect(acked.content_hash).toBe(ackEvent!.hash);

    // An OLDER unread look (earlier receipt) appended at a HIGHER seq — a
    // late-journaled capture — must not reset the ack. Its body differs
    // (metadata), or the dedup key would drop it before the projector.
    resetCanonicalizeSweepRuntime();
    const older = await seedObservation(page.id, "look-0", {
      ...base,
      notifications: [{ ...target, acknowledgedAt: null, metadata: "{\"older\":true}" }],
    }, new Date("2026-08-19T09:00:00.000Z"));
    await project(page.id);
    const [olderEvent] = await rows<{ account_seq: string }>(
      `select account_seq::text from domain_events
        where account_id = $1 and type = 'notification.observed' and observation_id = $2`,
      [page.id, older.observationId],
    );
    expect(olderEvent).toBeDefined(); // it reached the ledger, at a higher seq
    const after = await head();
    expect(after.acknowledged_at?.toISOString()).toBe(new Date(readAt * 1000).toISOString());
    expect(after.source_observation_id).toBe(String(second.observationId));
    expect(after.last_observed_at.toISOString()).toBe("2026-08-19T11:00:00.000Z");

    // Replaying the head's own event is idempotent, and a rebuild agrees.
    const before = await checksum(page.id);
    resetCanonicalizeSweepRuntime();
    expect((await project(page.id)).applied).toBe(0);
    await rebuildFanslyEngagementProjection(appStub(), { accountId: page.id });
    expect(await checksum(page.id)).toEqual(before);
  });

  it("replays the read looks the pre-J7 guard discarded, and touches nothing else (fansly:notifications-replay-read-state)", async (context) => {
    if (!testDb) {
      context.skip();
      return;
    }
    const page = await seedPage();
    const base = fixture("notifications-edge-cases.json");
    const all = base.notifications as Record<string, unknown>[];
    const stale = { ...all[5]! };
    const pending = { ...all[1]! };
    const staleRef = stale.idString as string;
    const pendingRef = pending.idString as string;
    const readAt = 1787050500;
    const look = (notifications: Record<string, unknown>[]) => ({ ...base, notifications });
    type Head = {
      acknowledged_at: Date | null;
      content_hash: string;
      source_event_id: string;
      source_observation_id: string;
      source_account_seq: string;
      last_observed_at: Date;
    };
    const headOf = async (ref: string) => (await rows<Head>(
      `select acknowledged_at, content_hash, source_event_id::text, source_observation_id::text,
              source_account_seq::text, last_observed_at
         from platform_notifications where page_id = $1 and notification_ref = $2`,
      [page.id, ref],
    ))[0]!;
    const table = () => rows(
      "select * from platform_notifications where page_id = $1 order by notification_ref",
      [page.id],
    );
    const watermark = async () => (await rows<{ high_seq: string }>(
      "select high_seq::text from projection_seq_watermarks where projection = $1 and account_id = $2",
      [FANSLY_ENGAGEMENT_PROJECTION, page.id],
    ))[0]!.high_seq;

    // Purchases in the ledger — what a projection rebuild would re-apply — and
    // the queued media they mark.
    const census = fixture("notifications-census.json");
    await queueCensusPurchases(page.id, census);
    await seedObservation(page.id, "census", census, CENSUS_RECEIVED_AT);
    // First looks: both notifications unread.
    await seedObservation(page.id, "look-1", look([
      { ...stale, acknowledgedAt: null },
      { ...pending, acknowledgedAt: null },
    ]), new Date("2026-08-19T10:00:00.000Z"));
    await project(page.id);
    const firstLook = await headOf(staleRef);
    expect(firstLook.acknowledged_at).toBeNull();

    // The read look of `stale`, consumed the way the PRE-J7 guard consumed it:
    // it lost the createdAt tie, and only last_observed_at moved.
    resetCanonicalizeSweepRuntime();
    const readLook = await seedObservation(page.id, "look-2", look([
      { ...stale, acknowledgedAt: readAt },
    ]), new Date("2026-08-19T11:00:00.000Z"));
    await project(page.id);
    await testDb.pool.query(
      `update platform_notifications
          set acknowledged_at = null, content_hash = $3, source_event_id = $4,
              source_observation_id = $5, source_account_seq = $6
        where page_id = $1 and notification_ref = $2`,
      [page.id, staleRef, firstLook.content_hash, firstLook.source_event_id,
        firstLook.source_observation_id, firstLook.source_account_seq],
    );
    expect((await headOf(staleRef)).last_observed_at.toISOString()).toBe("2026-08-19T11:00:00.000Z");

    // `pending`'s read look is in the ledger ABOVE the watermark: the live
    // projector's to apply, not the repair's.
    resetCanonicalizeSweepRuntime();
    await seedObservation(page.id, "look-2b", look([
      { ...pending, acknowledgedAt: readAt },
    ]), new Date("2026-08-19T12:00:00.000Z"));
    await runCanonicalization(appStub(), { kinds: ["notifications"] });

    // The purchase signals were applied once; clear them so any re-application
    // is visible.
    expect(await dirtyMediaStatsRows(page.id)).toBeGreaterThan(0);
    await testDb.pool.query(
      `update subject_refresh_state set dirty_reason = null, refresh_class = 'fresh'
        where page_id = $1`,
      [page.id],
    );
    const before = await table();
    const watermarkBefore = await watermark();

    // ── dry-run (the default): the count, and not one write ─────────────────
    const expected = {
      events: 1,
      heads: 1,
      acknowledged: 1,
      unacknowledged: 0,
      deferred: 0,
      erasureFenced: 0,
      pages: [{ pageId: page.id, events: 1, heads: 1, acknowledged: 1, unacknowledged: 0 }],
    };
    expect(await runNotificationReadStateReplay(appStub())).toEqual({ dryRun: true, ...expected });
    expect(await table()).toEqual(before);

    // ── execute ─────────────────────────────────────────────────────────────
    expect(await runNotificationReadStateReplay(appStub(), { dryRun: false }))
      .toEqual({ dryRun: false, ...expected });
    const healed = await headOf(staleRef);
    expect(healed.acknowledged_at?.toISOString()).toBe(new Date(readAt * 1000).toISOString());
    expect(healed.source_observation_id).toBe(String(readLook.observationId));
    // Nothing else moved: not the look above the watermark, not the watermark,
    // not any other row, and no purchase was re-applied.
    expect((await headOf(pendingRef)).acknowledged_at).toBeNull();
    expect(await watermark()).toBe(watermarkBefore);
    const others = (list: Record<string, unknown>[]) =>
      list.filter((row) => row.notification_ref !== staleRef);
    expect(others(await table())).toEqual(others(before));
    expect(await dirtyMediaStatsRows(page.id)).toBe(0);

    // ── a re-run finds nothing ──────────────────────────────────────────────
    const zero = {
      events: 0, heads: 0, acknowledged: 0, unacknowledged: 0, deferred: 0, erasureFenced: 0, pages: [],
    };
    expect(await runNotificationReadStateReplay(appStub(), { dryRun: false }))
      .toEqual({ dryRun: false, ...zero });
    expect(await runNotificationReadStateReplay(appStub())).toEqual({ dryRun: true, ...zero });

    // The projector lands the rest, and the repaired table is what a
    // truncate-and-replay produces — which, unlike the repair, re-marks the
    // purchased media due.
    await project(page.id);
    expect((await headOf(pendingRef)).acknowledged_at).not.toBeNull();
    const repaired = await checksum(page.id);
    await rebuildFanslyEngagementProjection(appStub(), { accountId: page.id });
    expect(await checksum(page.id)).toEqual(repaired);
    expect(await dirtyMediaStatsRows(page.id)).toBeGreaterThan(0);
  });

  it("a replayed look that ties the head at the same instant settles in one run (J7 repair)", async (context) => {
    if (!testDb) {
      context.skip();
      return;
    }
    // Two looks journaled at the SAME instant: unread, then read. The pre-J7
    // guard kept the first; the fixed guard (>=) gives the head to the later
    // one in ledger order. Once it has it, the earlier look — which ties it
    // exactly — must not be replayed back over it on the next run.
    const page = await seedPage();
    const base = fixture("notifications-edge-cases.json");
    const target = { ...(base.notifications as Record<string, unknown>[])[5]! };
    const ref = target.idString as string;
    const at = new Date("2026-08-19T10:00:00.000Z");
    const readAt = 1787050500;
    const unread = await seedObservation(page.id, "same-1", {
      ...base, notifications: [{ ...target, acknowledgedAt: null }],
    }, at);
    const read = await seedObservation(page.id, "same-2", {
      ...base, notifications: [{ ...target, acknowledgedAt: readAt }],
    }, at);
    await project(page.id);
    const head = async () => (await rows<{ acknowledged_at: Date | null; source_observation_id: string }>(
      `select acknowledged_at, source_observation_id::text
         from platform_notifications where page_id = $1 and notification_ref = $2`,
      [page.id, ref],
    ))[0]!;
    expect((await head()).source_observation_id).toBe(String(read.observationId));

    // The pre-J7 state: the first look kept the head.
    const [first] = await rows<{ id: string; account_seq: string; hash: string }>(
      `select id::text, account_seq::text, data->>'contentHash' as hash from domain_events
        where account_id = $1 and type = 'notification.observed' and observation_id = $2`,
      [page.id, unread.observationId],
    );
    await testDb.pool.query(
      `update platform_notifications
          set acknowledged_at = null, content_hash = $3, source_event_id = $4,
              source_observation_id = $5, source_account_seq = $6
        where page_id = $1 and notification_ref = $2`,
      [page.id, ref, first!.hash, first!.id, unread.observationId, first!.account_seq],
    );

    const done = await runNotificationReadStateReplay(appStub(), { dryRun: false });
    expect(done).toMatchObject({ events: 1, heads: 1, acknowledged: 1 });
    expect(await head()).toEqual({
      acknowledged_at: new Date(readAt * 1000),
      source_observation_id: String(read.observationId),
    });

    const again = await runNotificationReadStateReplay(appStub(), { dryRun: false });
    expect(again).toMatchObject({ events: 0, heads: 0, pages: [] });
    expect((await head()).source_observation_id).toBe(String(read.observationId));
  });

  it("reproduces every row from a truncate-and-replay, leaving subject_refresh_state alone", async (context) => {
    if (!testDb) {
      context.skip();
      return;
    }
    const page = await seedPage();
    await seedObservation(page.id, "census", fixture("notifications-census.json"));
    await seedObservation(page.id, "edges", fixture("notifications-edge-cases.json"));
    await project(page.id);
    const before = await checksum(page.id);

    // A row NO event can reproduce: a walk cursor the capture plane wrote for a
    // different plane entirely. If the rebuild truncated operational state,
    // this is what would vanish — and with it every pending refresh the capture
    // plane paid egress to learn about.
    await markSubjectRefreshDirty(testDb.db, {
      pageId: page.id,
      plane: "post_replies",
      subjectRef: "post-with-a-walk-cursor",
      dirtyReason: "reply_walk",
      nextDueAt: new Date("2026-08-19T09:00:00.000Z"),
    });
    const stateBefore = await rows(
      `select plane, subject_ref, dirty_reason from subject_refresh_state
        where page_id = $1 order by plane, subject_ref`,
      [page.id],
    );

    const rebuilt = await rebuildFanslyEngagementProjection(appStub(), { accountId: page.id });
    expect(rebuilt.applied).toBeGreaterThan(0);
    // Reproduced from the EVENT LEDGER alone — the projector never reads an
    // observation body.
    expect(await checksum(page.id)).toEqual(before);

    // …and the operational state is byte-for-byte what it was. Not restored:
    // never touched.
    expect(
      await rows(
        `select plane, subject_ref, dirty_reason from subject_refresh_state
          where page_id = $1 order by plane, subject_ref`,
        [page.id],
      ),
    ).toEqual(stateBefore);
  });
});
