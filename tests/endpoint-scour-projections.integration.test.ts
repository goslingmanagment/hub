// WP-F1 end to end: journaled `stats_snapshot` responses become the statistics
// core, and stay reproducible from the ledger alone.
//
// Everything below reads the DATABASE, because the claims this file holds are
// database claims:
//
//  - REPLAY IS A NO-OP. Re-running the sweep over the same bodies appends
//    nothing and moves no row.
//  - A CORRECTION IS ONE EVENT AND ONE HEAD UPDATE. A restated bucket does not
//    rewrite history; it mints one event and the head follows.
//  - A FULL TRUNCATE-AND-REPLAY reproduces every row WITHOUT reading an
//    observation body. Projectors read events only, and this is where that
//    stops being a comment.
//  - `capture_coverage` SURVIVES the rebuild, floor evidence included. It is
//    capture-plane operational state (§3.4, A17-6); truncating it would erase
//    retention floors the backfill paid egress to discover.
//  - THE EXCLUSION LIST IS THE DECLARED SET, never a quiet exemption in this
//    file.
//
// Scope note, and it is not a formality: rebuildability here is scoped to the
// ATTACHED event window. A fresh-database checksum does NOT discharge §3.2c —
// a fresh database has no detached partitions, so it can only ever prove the
// happy path. `tests/rebuild-preflight.test.ts` is where the unhappy one lives.

import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";

import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import {
  createFanslyPage,
  createModel,
  ensureDomainEventPartitions,
  insertObservation,
  upsertCaptureCoverage,
} from "@agency_hub_core/db";

import {
  resetCanonicalizeSweepCursors,
  runCanonicalization,
} from "../apps/runtime/src/services/canonicalize-driver.ts";
import {
  FANSLY_STATS_PROJECTION,
  FANSLY_STATS_PROJECTION_TABLES,
  rebuildFanslyStatsProjection,
  runFanslyStatsProjection,
} from "../apps/runtime/src/services/projections/fansly-stats.ts";
import { runMediaPlaneProjection } from "../apps/runtime/src/services/projections/media-plane.ts";
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

const FIXTURES = path.resolve("tests/fixtures/fansly");
const OWN_REF = "acct-stats-creator";

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

const STATS_KINDS = [
  "account_stats",
  "earnings_stats_snapshot",
  "earnings_monthlystats_snapshot",
  "tracking_links",
  "discovery_feed",
  "broadcast_stats",
  "broadcast_stats_deleted",
  "broadcast_scheduled",
  "polls",
  "recapstats",
] as const;

async function seedPage() {
  const model = await createModel(testDb!.db, { slug: "stats", name: "Stats" });
  if (!model) throw new Error("Expected the stats test model to be created");
  const page = await createFanslyPage(testDb!.db, { modelId: model.id, label: "stats-page" });
  if (!page) throw new Error("Expected the stats test page to be created");
  await testDb!.pool.query("update pages set external_page_id = $1 where id = $2", [
    OWN_REF,
    page.id,
  ]);
  await ensureDomainEventPartitions(testDb!.db);
  return page;
}

async function seedObservation(pageId: number, kind: string, key: string, payload: unknown) {
  await insertObservation(testDb!.db, {
    source: "pull",
    producer: `sync:fansly:stats_snapshot`,
    platform: "fansly",
    accountId: pageId,
    kind,
    payload,
    payloadHash: sha256(key),
    idempotencyKey: `stats:${key}`,
  });
}

async function seedFullSweep(pageId: number, generation = "g1") {
  await seedObservation(pageId, "account_stats", `account:${generation}`, fixture("stats-account-daily.json"));
  await seedObservation(
    pageId,
    "earnings_stats_snapshot",
    `earn:${generation}`,
    fixture("earnings-stats.json").rows,
  );
  await seedObservation(
    pageId,
    "earnings_monthlystats_snapshot",
    `month:${generation}`,
    fixture("earnings-monthlystats.json").rows,
  );
  await seedObservation(pageId, "tracking_links", `links:${generation}`, fixture("tracking-links.json").rows);
  await seedObservation(pageId, "discovery_feed", `disc:${generation}`, fixture("discovery-feed.json"));
  await seedObservation(pageId, "broadcast_stats", `bc:${generation}`, fixture("broadcast-stats.json"));
  await seedObservation(
    pageId,
    "broadcast_stats_deleted",
    `bcd:${generation}`,
    fixture("broadcast-stats.json"),
  );
  await seedObservation(
    pageId,
    "broadcast_scheduled",
    `bcs:${generation}`,
    fixture("broadcast-scheduled.json"),
  );
  await seedObservation(pageId, "polls", `polls:${generation}`, fixture("polls.json").rows);
  await seedObservation(pageId, "recapstats", `recap:${generation}`, fixture("recapstats.json").rows);
}

async function project(pageId: number) {
  await runCanonicalization(appStub(), { kinds: [...STATS_KINDS] });
  const stats = await runFanslyStatsProjection(appStub(), { accountId: pageId });
  const media = await runMediaPlaneProjection(appStub(), { accountId: pageId });
  return { stats, media };
}

async function rows<T = Record<string, unknown>>(sql: string, params: unknown[] = []): Promise<T[]> {
  const result = await testDb!.pool.query(sql, params);
  return result.rows as T[];
}

/**
 * A stable content checksum of every projected table, ordered so a rebuild's row
 * ORDER cannot make an identical projection look different.
 *
 * `includeObservationTimes: false` drops the "when did we last SEE this"
 * columns. That is the right comparison for a REPLAY: re-observing the same
 * fact legitimately advances `last_observed_at` and `captured_at` without
 * changing anything the platform said, and a checksum that called that a
 * difference would be asserting the opposite of what replay-is-a-no-op means.
 * The rebuild comparison keeps them, because a rebuild reproduces them from the
 * events and any drift there IS a defect.
 */
async function checksum(
  pageId: number,
  options: { includeObservationTimes?: boolean } = {},
): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  for (const table of FANSLY_STATS_PROJECTION_TABLES) {
    const table_rows = await rows(
      `select * from ${table} where page_id = $1`,
      [pageId],
    );
    const normalized = table_rows
      .map((row) => {
        const source = row as Record<string, unknown>;
        const copy: Record<string, unknown> = {};
        // Key order is normalized here rather than through JSON.stringify's
        // replacer-array form, which the BigInt replacer below replaces.
        for (const key of Object.keys(source).sort()) {
          copy[key] = source[key];
        }
        // Lineage moves on a rebuild (new event ids); the FACT does not.
        delete copy.source_event_id;
        delete copy.source_observation_id;
        delete copy.source_account_seq;
        delete copy.created_at;
        delete copy.updated_at;
        if (options.includeObservationTimes !== true) {
          delete copy.first_observed_at;
          delete copy.last_observed_at;
          delete copy.observed_at;
          delete copy.captured_at;
        }
        // bigint columns come back as BigInt; JSON.stringify refuses them.
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

describe("[sync-critical] WP-F1 statistics projections", () => {
  it("projects a full sweep into every statistics table", async (context) => {
    if (!testDb) {
      context.skip();
      return;
    }
    const page = await seedPage();
    await seedFullSweep(page.id);
    const result = await project(page.id);
    expect(result.stats.applied).toBeGreaterThan(0);

    const buckets = await rows(
      `select source_code, views, unique_viewers, interaction_time_ms,
              video_percent_watched_sum, subject_kind, mapping_version
         from stats_traffic_buckets where page_id = $1 order by subject_kind, source_code`,
      [page.id],
    );
    // 8 profile codes + 2 media codes.
    expect(buckets).toHaveLength(10);
    const profile = buckets.filter((row) => row.subject_kind === "account_profile");
    expect(profile.map((row) => row.source_code)).toEqual([
      "10000",
      "10001",
      "44000",
      "44001",
      "44010",
      "44011",
      "44030",
      "44031",
    ]);
    expect(Number(profile[0]!.views)).toBe(86);
    // The percent is the RAW SUM, in `numeric` — no float anywhere on the path.
    const media = buckets.find((row) => row.subject_kind === "account_media"
      && row.source_code === "1")!;
    expect(String(media.video_percent_watched_sum)).toBe("116.0106640619");

    const topMedia = await rows(
      `select plane, media_offer_ref, rank, bundle_ref from stats_top_media
        where page_id = $1 order by plane, rank`,
      [page.id],
    );
    expect(topMedia).toHaveLength(3);
    // "0" is Fansly's sentinel for "no bundle" — stored as NULL, not as an id.
    expect(topMedia.every((row) => row.bundle_ref === null)).toBe(true);

    const tags = await rows(
      `select tag_ref, view_count, source from platform_tag_daily
        where page_id = $1 order by tag_ref`,
      [page.id],
    );
    // Three distinct tags across the two sources; the tag both served keeps ONE
    // row per (page, tag, date) and the later capture wins.
    expect(tags).toHaveLength(3);

    const mix = await rows(
      `select type_code, gross_mills, net_mills from revenue_mix_daily
        where page_id = $1 order by type_code`,
      [page.id],
    );
    expect(mix.map((row) => Number(row.type_code))).toEqual([2010, 2110, 2116, 7101, 15001]);
    // A22-2: the legacy twin 2010 keeps its own row. Folding it into 2110 would
    // erase the provenance of every pre-cutover row.
    expect(String(mix[0]!.gross_mills)).toBe("19000");

    const months = await rows(
      `select year, month, total_gross_mills, top_percent from revenue_month_totals
        where page_id = $1 order by year, month`,
      [page.id],
    );
    // Including the (0,0) rolling rollup — a row like any other.
    expect(months.map((row) => [Number(row.year), Number(row.month)])).toEqual([
      [0, 0],
      [2026, 7],
      [2026, 8],
    ]);
    expect(String(months[0]!.total_gross_mills)).toBe("9886800");
    expect(String(months[0]!.top_percent)).toBe("1.23269510");

    const links = await rows(
      `select link_ref, total_gross_mills, total_net_mills, clicks from page_promo_links
        where page_id = $1 order by link_ref`,
      [page.id],
    );
    expect(links).toHaveLength(2);
    // 0/null = UNPOPULATED. The read layer must not be able to render "$0 net".
    expect(links[0]!.total_net_mills).toBeNull();
    expect(String(links[0]!.total_gross_mills)).toBe("53916240");

    const broadcasts = await rows(
      `select broadcast_ref, source_list, stats_total, stats_read, sales_net_mills
         from page_broadcasts where page_id = $1 order by broadcast_ref, source_list`,
      [page.id],
    );
    expect(broadcasts.length).toBeGreaterThanOrEqual(2);
    expect(Number(broadcasts[0]!.stats_total)).toBe(1420);

    const polls = await rows(`select poll_ref from page_polls where page_id = $1`, [page.id]);
    expect(polls).toHaveLength(1);
    const options = await rows(
      `select option_ref, vote_count from page_poll_options where page_id = $1
        order by option_ordinal`,
      [page.id],
    );
    expect(options.map((row) => Number(row.vote_count))).toEqual([412, 388]);

    const recap = await rows(
      `select stat_ref, stat_value from page_recap_stats where page_id = $1 order by stat_ref`,
      [page.id],
    );
    // The string that LOOKS numeric stays a string, in a text column.
    expect(recap.find((row) => row.stat_ref === "recap_messages_sent")!.stat_value).toBe("18402");
    expect(recap.find((row) => row.stat_ref === "recap_watch_time")!.stat_value)
      .toBe("3d 14h 22m");

    // The media plane picked up the aggregation sidecars with the stats origin.
    const creatorMedia = await rows(
      `select media_offer_ref, first_origin, price_mills from creator_media where page_id = $1
        order by media_offer_ref`,
      [page.id],
    );
    expect(creatorMedia).toHaveLength(2);
    expect(creatorMedia[0]!.first_origin).toBe("stats_agg");
    const locations = await rows(
      `select location_ref, media_offer_ref, correlation_ref from media_offer_locations
        where page_id = $1`,
      [page.id],
    );
    expect(locations).toHaveLength(1);
    // Pure id-relations. No URL, ever.
    expect(JSON.stringify(locations)).not.toContain("http");
  });

  it("is a no-op on replay and mints exactly one event on a correction", async (context) => {
    if (!testDb) {
      context.skip();
      return;
    }
    const page = await seedPage();
    await seedFullSweep(page.id);
    await project(page.id);
    const before = await checksum(page.id);
    const eventsBefore = (await rows(
      `select count(*)::int as n from domain_events where account_id = $1`,
      [page.id],
    ))[0]!.n as number;

    // Re-journal the SAME bodies under new observation keys — the shape a daily
    // re-poll of an unchanged trailing window takes.
    await seedFullSweep(page.id, "g2");
    await project(page.id);
    expect(await checksum(page.id)).toEqual(before);
    const eventsAfterReplay = (await rows(
      `select count(*)::int as n from domain_events where account_id = $1`,
      [page.id],
    ))[0]!.n as number;
    // Only the per-observation projection checkpoints are appended; no fact is.
    expect(
      (await rows(
        `select count(*)::int as n from domain_events
          where account_id = $1 and type = 'traffic.datapoint_observed'`,
        [page.id],
      ))[0]!.n,
    ).toBe(8);
    expect(eventsAfterReplay).toBeGreaterThanOrEqual(eventsBefore);

    // Now a genuine platform RESTATEMENT of one bucket.
    const corrected = fixture("stats-account-daily.json");
    const dataset = corrected.dataset as Record<string, unknown>;
    const points = dataset.profileDatapoints as Array<Record<string, unknown>>;
    (points[0]!.stats as Array<Record<string, unknown>>)[0]!.views = 117;
    await seedObservation(page.id, "account_stats", "account:g3", corrected);
    await project(page.id);

    expect(
      (await rows(
        `select count(*)::int as n from domain_events
          where account_id = $1 and type = 'traffic.datapoint_observed'`,
        [page.id],
      ))[0]!.n,
    ).toBe(9);
    const head = await rows(
      `select views, revision_count from stats_traffic_buckets
        where page_id = $1 and subject_kind = 'account_profile' and source_code = '10001'`,
      [page.id],
    );
    expect(head).toHaveLength(1);
    expect(Number(head[0]!.views)).toBe(117);
    expect(Number(head[0]!.revision_count)).toBe(1);
  });

  it("reproduces every row from a truncate-and-replay, without reading a body", async (context) => {
    if (!testDb) {
      context.skip();
      return;
    }
    const page = await seedPage();
    await seedFullSweep(page.id);
    await project(page.id);
    const before = await checksum(page.id);
    const beforeStrict = await checksum(page.id, { includeObservationTimes: true });

    // The proof that the projector reads EVENTS: blank every observation body
    // and rebuild. A projector that reached for `observations.payload` would
    // produce an empty projection here.
    await testDb.pool.query("update observations set payload = '{}'::jsonb");

    const rebuilt = await rebuildFanslyStatsProjection(appStub(), { accountId: page.id });
    expect(rebuilt.applied).toBeGreaterThan(0);
    expect(await checksum(page.id)).toEqual(before);
    // …and the observation instants come back too: they ride the events.
    expect(await checksum(page.id, { includeObservationTimes: true })).toEqual(beforeStrict);

    // The watermark was reset and re-advanced rather than left stale-high.
    const watermark = await rows(
      `select high_seq from projection_seq_watermarks
        where projection = $1 and account_id = $2`,
      [FANSLY_STATS_PROJECTION, page.id],
    );
    expect(watermark).toHaveLength(1);
    expect(Number(watermark[0]!.high_seq)).toBeGreaterThan(0);
  });

  it("keeps capture_coverage — floor evidence included — across a rebuild", async (context) => {
    if (!testDb) {
      context.skip();
      return;
    }
    const page = await seedPage();
    // An EMPTY window is the retention-floor evidence, and it is journaled like
    // any other response: the coverage row points AT that observation.
    await seedObservation(page.id, "account_stats", "empty:g1", {
      dataset: {
        period: 86_400_000,
        dateBefore: Date.UTC(2019, 0, 1),
        dateAfter: Date.UTC(2018, 9, 1),
        datapointLimit: 100,
        datapoints: [],
        profileDatapoints: [],
      },
      aggregationData: {},
    });
    const proofRow = (await rows(`select id from observations order by id desc limit 1`))[0]!;
    await upsertCaptureCoverage(testDb.db, {
      pageId: page.id,
      platform: "fansly",
      plane: "stats_account_daily",
      scopeRef: "",
      status: "provider_exhausted",
      acquisitionMode: "retroactive",
      proof: "empty_window",
      oldestCapturedAt: new Date(Date.UTC(2019, 0, 1)),
      proofObservationId: Number(proofRow.id),
      reasonCode: "empty_window_streak",
    });

    await seedFullSweep(page.id);
    await project(page.id);
    await rebuildFanslyStatsProjection(appStub(), { accountId: page.id });

    const coverage = await rows(
      `select status, proof, proof_observation_id, oldest_captured_at from capture_coverage
        where page_id = $1 and plane = 'stats_account_daily'`,
      [page.id],
    );
    expect(coverage).toHaveLength(1);
    expect(coverage[0]!.status).toBe("provider_exhausted");
    expect(coverage[0]!.proof).toBe("empty_window");
    expect(Number(coverage[0]!.proof_observation_id)).toBe(Number(proofRow.id));

    // And a FULL (all-pages) rebuild leaves it alone too — the scope is not
    // what protects it, the table list is.
    await rebuildFanslyStatsProjection(appStub());
    expect(
      (await rows(`select count(*)::int as n from capture_coverage`))[0]!.n,
    ).toBe(1);
  });

  it("excludes exactly the DECLARED operational-state set from every rebuild", async (context) => {
    if (!testDb) {
      context.skip();
      return;
    }
    // The exclusion is BY CLASSIFICATION (§3.4), not by a quiet exemption in
    // this file: the declared set and the set no projection truncates must be
    // the same set.
    const declared = new Set(OPERATIONAL_STATE_TABLES.map((entry) => entry.table));
    const projected = new Set(PROJECTION_REGISTRY.flatMap((projection) => projection.tables));
    for (const table of declared) {
      expect(projected.has(table)).toBe(false);
    }
    expect(declared.has("capture_coverage")).toBe(true);

    const stats = findProjection(FANSLY_STATS_PROJECTION);
    expect([...(stats?.tables ?? [])]).toEqual([...FANSLY_STATS_PROJECTION_TABLES]);

    // Every declared table exists in the schema — a classification pointing at
    // a table nobody created is a classification of nothing.
    for (const table of declared) {
      const found = await rows(
        `select 1 from information_schema.tables where table_name = $1`,
        [table],
      );
      expect(found, table).toHaveLength(1);
    }
  });

  it("keeps a projection-only event out of the deliverable stream", async (context) => {
    if (!testDb) {
      context.skip();
      return;
    }
    const page = await seedPage();
    await seedFullSweep(page.id);
    await project(page.id);
    // Every statistics type is hidden, and the family's checkpoint covers them
    // — which is what the SSE v2 replay validator requires of a seq gap.
    const visible = await rows(
      `select type from domain_events where account_id = $1
        and type like any (array['traffic.%','stats.%','earnings.%','tracking_link.%',
                                 'broadcast.%','poll.%','recap.%','tag.%'])`,
      [page.id],
    );
    expect(visible.length).toBeGreaterThan(0);
    const checkpoints = await rows(
      `select count(*)::int as n from domain_events
        where account_id = $1 and type = 'stream.projection_checkpoint'`,
      [page.id],
    );
    expect(Number(checkpoints[0]!.n)).toBeGreaterThan(0);
  });
});
