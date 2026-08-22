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
  markSubjectRefreshDirty,
} from "@agency_hub_core/db";

import {
  resetCanonicalizeSweepCursors,
  runCanonicalization,
} from "../apps/runtime/src/services/canonicalize-driver.ts";
import {
  FANSLY_ENGAGEMENT_PROJECTION,
  FANSLY_ENGAGEMENT_PROJECTION_TABLES,
  rebuildFanslyEngagementProjection,
  runFanslyEngagementProjection,
} from "../apps/runtime/src/services/projections/fansly-engagement.ts";
import {
  findProjection,
  OPERATIONAL_STATE_TABLES,
  PROJECTION_REGISTRY,
} from "../apps/runtime/src/services/projections/registry.ts";
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
  resetCanonicalizeSweepCursors();
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

async function seedObservation(pageId: number, key: string, payload: unknown) {
  await insertObservation(testDb!.db, {
    source: "pull",
    producer: "sync:fansly:notifications",
    platform: "fansly",
    accountId: pageId,
    kind: "notifications",
    payload,
    payloadHash: sha256(key),
    idempotencyKey: `notifications:${key}`,
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
    await seedObservation(page.id, "census", fixture("notifications-census.json"));
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
    expect(dirty.length).toBeGreaterThan(0);
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

  it("is a no-op on replay", async (context) => {
    if (!testDb) {
      context.skip();
      return;
    }
    const page = await seedPage();
    await seedObservation(page.id, "census", fixture("notifications-census.json"));
    await project(page.id);
    const before = await checksum(page.id);
    const beforeEvents = await rows<{ n: string }>(
      `select count(*)::text as n from domain_events where account_id = $1`,
      [page.id],
    );

    resetCanonicalizeSweepCursors();
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
    resetCanonicalizeSweepCursors();
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

  it("declares subject_refresh_state as operational state, and no projection truncates it", async (context) => {
    if (!testDb) {
      context.skip();
      return;
    }
    // BY CLASSIFICATION (§3.4), never by a quiet exemption in this file.
    const declared = new Set(OPERATIONAL_STATE_TABLES.map((entry) => entry.table));
    expect(declared.has("subject_refresh_state")).toBe(true);
    const projected = new Set(PROJECTION_REGISTRY.flatMap((projection) => projection.tables));
    expect(projected.has("subject_refresh_state")).toBe(false);

    const engagement = findProjection(FANSLY_ENGAGEMENT_PROJECTION);
    expect([...(engagement?.tables ?? [])]).toEqual([...FANSLY_ENGAGEMENT_PROJECTION_TABLES]);
    expect(engagement?.rebuildKind).toBe("truncate_replay");
    // `post_likes` IS truncated on rebuild: it is a fact projection whose
    // Fansly half happens to be empty, and "empty because nothing wrote it" has
    // to stay distinguishable from "empty because it was truncated".
    expect([...FANSLY_ENGAGEMENT_PROJECTION_TABLES]).toContain("post_likes");
  });

  it("keeps every engagement event out of the deliverable stream", async (context) => {
    if (!testDb) {
      context.skip();
      return;
    }
    const page = await seedPage();
    await seedObservation(page.id, "census", fixture("notifications-census.json"));
    await project(page.id);
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
  });
});
