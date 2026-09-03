// WP-F3 end to end: journaled catalog responses become the content catalog, and
// stay reproducible from the ledger alone.
//
// The claims here are database claims, and three of them are specific to this
// family:
//
//  - `missing_since` IS A REPLAYED FACT. It is written by the roster event
//    (`catalog.listing_observed`), never by a sweep, so a truncate-and-replay
//    reproduces it exactly. The hardest case is the one with no row events at
//    all: a listing that comes back EMPTY.
//  - THE PLAN PRICE IS THE TRUTH. `page_subscription_tier_plans.price_mills`
//    reaches 499 990 while every tier head sits at 5 000, and a rebuild must
//    reproduce both.
//  - VAULT MEMBERSHIP IS OVERLAP-AWARE. Σ `item_count` over-counts because the
//    system albums are views over the same media; the distinct raw-file union
//    does not. It remains separate from the offer census because one file can
//    back several offers.
//
// Plus the ordinary ones: replay is a no-op, nothing is ever deleted, the media
// plane stays the single writer of `creator_media`, and no delivery URL reaches
// any serving table.

import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";

import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import {
  createFanslyPage,
  createModel,
  ensureDomainEventPartitions,
  insertObservation,
} from "@agency_hub_core/db";

import {
  resetCanonicalizeSweepCursors,
  runCanonicalization,
} from "../apps/runtime/src/services/canonicalize-driver.ts";
import {
  FANSLY_CATALOG_PROJECTION,
  FANSLY_CATALOG_PROJECTION_TABLES,
  measureFanslyCatalogMedia,
  rebuildFanslyCatalogProjection,
  runFanslyCatalogProjection,
} from "../apps/runtime/src/services/projections/fansly-catalog.ts";
import {
  rebuildMediaPlaneProjection,
  runMediaPlaneProjection,
} from "../apps/runtime/src/services/projections/media-plane.ts";
import { findProjection } from "../apps/runtime/src/services/projections/registry.ts";
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

const FIXTURES = path.resolve("tests/fixtures/fansly-catalog");

const CATALOG_KINDS = [
  "vault_albums",
  "uservault_albums",
  "subscription_tiers",
  "gift_codes",
  "automated_messages",
  "account_walls",
  "vault_media",
  "account_media_batch",
  "account_media_bundle_batch",
];

function fixture(name: string): Record<string, unknown> {
  return JSON.parse(readFileSync(path.join(FIXTURES, `${name}.json`), "utf8")) as Record<
    string,
    unknown
  >;
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
  const model = await createModel(testDb!.db, { slug: "catalog", name: "Catalog" });
  if (!model) throw new Error("Expected the catalog test model to be created");
  const page = await createFanslyPage(testDb!.db, { modelId: model.id, label: "catalog-page" });
  if (!page) throw new Error("Expected the catalog test page to be created");
  await testDb!.pool.query("update pages set external_page_id = $1 where id = $2", [
    "acct-catalog",
    page.id,
  ]);
  await ensureDomainEventPartitions(testDb!.db);
  return page;
}

async function seedObservation(pageId: number, kind: string, key: string, payload: unknown) {
  await insertObservation(testDb!.db, {
    source: "pull",
    producer: "sync:fansly:catalog",
    platform: "fansly",
    accountId: pageId,
    kind,
    payload,
    payloadHash: sha256(key),
    idempotencyKey: `${kind}:${key}`,
  });
}

async function project(pageId: number) {
  await runCanonicalization(appStub(), { kinds: CATALOG_KINDS });
  const catalog = await runFanslyCatalogProjection(appStub(), { accountId: pageId });
  // The media plane is the SINGLE writer of `creator_media`; this family only
  // mints the events it reads.
  const media = await runMediaPlaneProjection(appStub(), { accountId: pageId });
  return { catalog, media };
}

async function rows<T = Record<string, unknown>>(sql: string, params: unknown[]): Promise<T[]> {
  const result = await testDb!.pool.query(sql, params);
  return result.rows as T[];
}

/**
 * Every table this projection owns, checksummed the way the §9.1 matrix does:
 * CONTENT, not row count, so a replay that loses a column still fails.
 *
 * `created_at` and `updated_at` are stripped, and only those two. They are
 * row-bookkeeping written by `now()`, so a rebuild moves them by construction
 * and comparing them would make this assertion fail for the one reason that
 * proves nothing. `first_observed_at`, `last_observed_at` and `missing_since`
 * all stay IN — they are derived from the ledger and a rebuild that moved one
 * of them is exactly the defect this test exists for.
 */
async function checksums(pageId: number): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  for (const table of FANSLY_CATALOG_PROJECTION_TABLES) {
    const result = await testDb!.pool.query(
      `select md5(string_agg(row_text, '|' order by row_text)) as digest,
              count(*)::int as rows
         from (
           select (to_jsonb(t) - 'created_at' - 'updated_at')::text as row_text
             from ${table} t where page_id = $1
         ) stripped`,
      [pageId],
    );
    const record = result.rows[0] as { digest: string | null; rows: number };
    out[table] = `${record.rows}:${record.digest ?? "empty"}`;
  }
  return out;
}

/** Seed everything the fixtures describe, once. */
async function seedAll(pageId: number) {
  await seedObservation(pageId, "vault_albums", "v1", fixture("vault-albums"));
  await seedObservation(pageId, "uservault_albums", "u1", fixture("uservault-albums"));
  await seedObservation(pageId, "subscription_tiers", "t1", fixture("subscription-tiers"));
  await seedObservation(pageId, "gift_codes", "g1", fixture("gift-codes"));
  await seedObservation(pageId, "automated_messages", "a1", fixture("automated-messages"));
  await seedObservation(pageId, "account_walls", "w1", fixture("account-walls"));
  await seedObservation(pageId, "vault_media", "m1", fixture("vault-media-page"));
  // Production rows were already stamped by catalog v1. The v2 bump must make
  // the ordinary sweep revisit them; no manual payload rewrite or vendor call.
  await testDb!.pool.query(
    `update observations set parse_version = 1
      where account_id = $1 and kind = 'vault_media'`,
    [pageId],
  );
  await seedObservation(pageId, "account_media_batch", "b1", fixture("account-media-batch"));
  await seedObservation(
    pageId,
    "account_media_bundle_batch",
    "bb1",
    fixture("account-media-bundle-batch"),
  );
}

describe("[sync-critical] WP-F3 catalog projection", () => {
  it("projects every catalog surface, and replaying appends nothing", async (context) => {
    if (!testDb) {
      context.skip();
      return;
    }
    const page = await seedPage();
    await seedAll(page.id);
    const first = await project(page.id);

    expect(first.catalog.albums).toBe(8);
    expect(first.catalog.tiers).toBe(2);
    expect(first.catalog.tierPlans).toBe(4);
    expect(first.catalog.giftCodes).toBe(2);
    expect(first.catalog.automations).toBe(2);
    expect(first.catalog.walls).toBe(3);
    // Two from the uservault sidecar + the vault walk page's two rows… minus
    // the one the uservault contributes, which belongs to the user shelf.
    expect(first.catalog.albumMembers).toBe(3);
    // The media plane wrote the batch-hydrated cards, not this projector.
    expect(first.media.media).toBe(2);
    expect(first.media.rawMedia).toBe(5);
    expect(first.media.bundles).toBe(1);

    const before = await checksums(page.id);
    const second = await project(page.id);
    // A REPLAY IS A NO-OP: the dedup keys are content-addressed, so nothing new
    // is appended and nothing new is applied.
    expect(second.catalog.applied).toBe(0);
    expect(await checksums(page.id)).toEqual(before);
  });

  it("serves the PLAN price as the truth, with the tier head as a mere base", async (context) => {
    if (!testDb) {
      context.skip();
      return;
    }
    const page = await seedPage();
    await seedAll(page.id);
    await project(page.id);

    const tiers = await rows<{ tier_ref: string; base_price_mills: bigint }>(
      `select tier_ref, base_price_mills from page_subscription_tiers
        where page_id = $1 order by tier_ref`,
      [page.id],
    );
    // Every observed tier head carried 5 000 while its plans ran to 499 990.
    // node-postgres hands bigint back as a JS BigInt; the column is BIGINT
    // mills and the assertion says so rather than stringifying the difference
    // away.
    expect(tiers.map((tier) => tier.base_price_mills)).toEqual([5000n, 5000n]);

    const plans = await rows<{ plan_ref: string; price_mills: bigint; duration_days: number }>(
      `select plan_ref, price_mills, duration_days from page_subscription_tier_plans
        where page_id = $1 order by price_mills::bigint`,
      [page.id],
    );
    expect(plans.map((plan) => plan.price_mills))
      .toEqual([10000n, 16500n, 40000n, 499990n]);
    // `billingCycle`, not the promo's `duration`.
    expect(plans.map((plan) => plan.duration_days)).toEqual([30, 90, 60, 30]);

    // FEAT-002's read: what does this page charge for a month?
    const monthly = await rows<{ price_mills: bigint }>(
      `select price_mills from page_subscription_tier_plans
        where page_id = $1 and duration_days = 30 order by price_mills::bigint desc`,
      [page.id],
    );
    expect(monthly[0]?.price_mills).toBe(499990n);
  });

  it("keeps promos and the verbatim plans array beside the normalized rows", async (context) => {
    if (!testDb) {
      context.skip();
      return;
    }
    const page = await seedPage();
    await seedAll(page.id);
    await project(page.id);

    const [tier] = await rows<{ plans: unknown[] }>(
      `select plans from page_subscription_tiers where page_id = $1 and tier_ref = $2`,
      [page.id, "000900000000000301"],
    );
    expect(Array.isArray(tier?.plans)).toBe(true);
    expect(tier?.plans).toHaveLength(2);

    const [plan] = await rows<{ promos: Record<string, unknown>[] }>(
      `select promos from page_subscription_tier_plans
        where page_id = $1 and plan_ref = $2`,
      [page.id, "000900000000000401"],
    );
    expect(plan?.promos).toHaveLength(1);
    // Promo money is kept as the platform served it, inside the jsonb, and is
    // never summed with the plan price it discounts.
    expect(plan?.promos[0]?.price).toBe(7770);
  });

  it("writes gift codes into page_promo_links without touching the tracking half", async (context) => {
    if (!testDb) {
      context.skip();
      return;
    }
    const page = await seedPage();
    await seedAll(page.id);
    await project(page.id);

    const codes = await rows<{
      link_ref: string;
      link_kind: string;
      price_mills: bigint;
      original_price_mills: bigint;
      uses: bigint;
      max_uses: bigint;
    }>(
      `select link_ref, link_kind, price_mills, original_price_mills, uses, max_uses
         from page_promo_links where page_id = $1 order by link_ref`,
      [page.id],
    );
    expect(codes).toHaveLength(2);
    for (const code of codes) {
      expect(code.link_kind).toBe("gift_code");
    }
    // `original_price` read by its SNAKE_CASE name; a full-comp code's 0 is a
    // real price, not an unpopulated field.
    expect(codes[0]?.price_mills).toBe(0n);
    expect(codes[0]?.original_price_mills).toBe(50000n);
    expect(codes[0]?.uses).toBe(0n);
    expect(codes[0]?.max_uses).toBe(100n);
  });

  it("marks an entity missing when a later FULL listing stops naming it, and never deletes", async (context) => {
    if (!testDb) {
      context.skip();
      return;
    }
    const page = await seedPage();
    await seedAll(page.id);
    await project(page.id);
    expect(await rows(`select 1 from page_subscription_tiers where page_id = $1`, [page.id]))
      .toHaveLength(2);

    // The SECOND capture serves only the first tier.
    const shrunk = fixture("subscription-tiers") as { rows: unknown[] };
    await seedObservation(page.id, "subscription_tiers", "t2", { rows: [shrunk.rows[0]] });
    await project(page.id);

    const tiers = await rows<{ tier_ref: string; missing_since: Date | null }>(
      `select tier_ref, missing_since from page_subscription_tiers
        where page_id = $1 order by tier_ref`,
      [page.id],
    );
    // NOT DELETED. Both rows are still here (DP 7); one is marked.
    expect(tiers).toHaveLength(2);
    expect(tiers[0]?.missing_since).toBeNull();
    expect(tiers[1]?.missing_since).not.toBeNull();

    // Its PLANS go with it — a separate roster, because a tier can survive
    // while one of its plans is retired.
    const plans = await rows<{ plan_ref: string; missing_since: Date | null }>(
      `select plan_ref, missing_since from page_subscription_tier_plans
        where page_id = $1 order by plan_ref`,
      [page.id],
    );
    expect(plans.filter((plan) => plan.missing_since !== null)).toHaveLength(2);
  });

  it("marks EVERYTHING missing on an EMPTY listing — the case with no row events", async (context) => {
    if (!testDb) {
      context.skip();
      return;
    }
    const page = await seedPage();
    await seedAll(page.id);
    await project(page.id);

    // Every gift code revoked. The response carries no rows at all, so without
    // the roster event nothing downstream would ever learn it.
    await seedObservation(page.id, "gift_codes", "g2", { rows: [] });
    await project(page.id);

    const codes = await rows<{ link_ref: string; missing_since: Date | null }>(
      `select link_ref, missing_since from page_promo_links
        where page_id = $1 and link_kind = 'gift_code' order by link_ref`,
      [page.id],
    );
    expect(codes).toHaveLength(2);
    for (const code of codes) {
      expect(code.missing_since).not.toBeNull();
    }
  });

  it("clears missing_since when the entity comes back — gone is a state, not a tombstone", async (context) => {
    if (!testDb) {
      context.skip();
      return;
    }
    const page = await seedPage();
    await seedAll(page.id);
    await project(page.id);
    await seedObservation(page.id, "account_walls", "w2", { rows: [] });
    await project(page.id);
    expect(
      await rows(
        `select 1 from page_walls where page_id = $1 and missing_since is not null`,
        [page.id],
      ),
    ).toHaveLength(3);

    await seedObservation(page.id, "account_walls", "w3", fixture("account-walls"));
    await project(page.id);
    expect(
      await rows(
        `select 1 from page_walls where page_id = $1 and missing_since is not null`,
        [page.id],
      ),
    ).toHaveLength(0);
  });

  it("counts raw vault membership across albums without conflating offers", async (context) => {
    if (!testDb) {
      context.skip();
      return;
    }
    const page = await seedPage();
    await seedAll(page.id);
    await project(page.id);

    const census = await measureFanslyCatalogMedia(testDb!.db, page.id);

    // Σ item_count over the CREATOR vault, exactly as served. It double-counts:
    // the system albums 38000 and 5000 share a lastItemId because they are
    // views over the same media.
    expect(census.albumMembershipSum).toBe(760);
    // The overlap-aware count from the walk's own membership. The vault page
    // named two distinct raw files; the uservault's member is on the USER shelf
    // and is deliberately not counted.
    expect(census.vaultMemberUniqueCount).toBe(2);
    // The offer census happens to also be two in this fixture, but it is a
    // separate metric. Production proves one raw file can back several offers,
    // so equality is not an invariant and must not be asserted.
    expect(census.uniqueMediaCount).toBe(2);
    expect(census.albumMembershipSum).toBeGreaterThan(census.uniqueMediaCount);

    const creatorMembers = await rows<{
      media_ref: string;
      media_offer_ref: string | null;
    }>(
      `select media_ref, media_offer_ref from creator_vault_album_members
        where page_id = $1 and vault_kind = 'creator' order by media_ref`,
      [page.id],
    );
    expect(creatorMembers).toEqual([
      { media_ref: "000900000000000612", media_offer_ref: null },
      { media_ref: "000900000000000614", media_offer_ref: null },
    ]);

    // And the user shelf's purchases are NOT in the creator vault's count.
    const userMembers = await rows(
      `select 1 from creator_vault_album_members where page_id = $1 and vault_kind = 'user'`,
      [page.id],
    );
    expect(userMembers).toHaveLength(1);
  });

  it("routes vault and batch media through the media plane, with the new origin", async (context) => {
    if (!testDb) {
      context.skip();
      return;
    }
    const page = await seedPage();
    await seedAll(page.id);
    await project(page.id);

    const media = await rows<{
      media_offer_ref: string;
      first_origin: string;
      price_mills: bigint;
    }>(
      `select media_offer_ref, first_origin, price_mills from creator_media
        where page_id = $1 order by media_offer_ref`,
      [page.id],
    );
    expect(media).toHaveLength(2);
    for (const row of media) {
      // 0136 widened 0130's CHECK for exactly this value.
      expect(row.first_origin).toBe("account_media_batch");
    }
    // The price came from permissions.permissionFlags[], not the top-level 0.
    expect(media[0]?.price_mills).toBe(79000n);
  });

  it("puts NO delivery URL, location or variant into any serving table", async (context) => {
    if (!testDb) {
      context.skip();
      return;
    }
    const page = await seedPage();
    await seedAll(page.id);
    await project(page.id);

    for (const table of [...FANSLY_CATALOG_PROJECTION_TABLES, "creator_media"]) {
      const columns = await rows<{ column_name: string }>(
        `select column_name from information_schema.columns where table_name = $1`,
        [table],
      );
      for (const column of columns) {
        expect(
          /^(location|locations|variants|variant_hash|url|filename)$/.test(column.column_name),
          `${table}.${column.column_name}`,
        ).toBe(false);
      }
      // …and no VALUE smuggled one in through a jsonb column either. The
      // fixtures carry a "SIGNED-…" placeholder exactly so this can fail.
      const smuggled = await rows(
        `select 1 from ${table} t where t.page_id = $1 and t::text like '%SIGNED-%'`,
        [page.id],
      );
      expect(smuggled, `${table} leaked a signed location`).toHaveLength(0);
    }
  });

  it("reproduces every row and every missing_since from a truncate-and-replay", async (context) => {
    if (!testDb) {
      context.skip();
      return;
    }
    const page = await seedPage();
    await seedAll(page.id);
    await project(page.id);
    // Retire a wall, so the rebuild has a `missing_since` to reproduce — the
    // one piece of state that is NOT in a row event.
    await seedObservation(page.id, "account_walls", "w2", { rows: [] });
    await project(page.id);

    const before = await checksums(page.id);
    expect(before["page_walls"]).not.toContain("empty");

    const rebuilt = await rebuildFanslyCatalogProjection(appStub(), { accountId: page.id });
    await rebuildMediaPlaneProjection(appStub(), { accountId: page.id });
    expect(rebuilt.applied).toBeGreaterThan(0);

    // Byte-for-byte, INCLUDING the marks. If `missing_since` were a sweep-time
    // side effect rather than a replayed fact, this is the assertion that would
    // catch it.
    expect(await checksums(page.id)).toEqual(before);
    expect(
      await rows(
        `select 1 from page_walls where page_id = $1 and missing_since is not null`,
        [page.id],
      ),
    ).toHaveLength(3);
  });

  it("scopes its rebuild to the gift-code half of page_promo_links", async (context) => {
    if (!testDb) {
      context.skip();
      return;
    }
    const page = await seedPage();
    await seedAll(page.id);
    await project(page.id);

    // A TRACKING row, as WP-F1's projector writes them. It belongs to the
    // statistics ledger and this rebuild must not touch it — an unscoped
    // delete would remove a row only the OTHER rebuild could restore.
    await testDb!.pool.query(
      `insert into page_promo_links (
         page_id, platform, link_kind, link_ref, business_date, captured_at, content_hash,
         first_observed_at, last_observed_at, source_event_id, source_observation_id,
         source_account_seq
       ) values ($1, 'fansly', 'tracking', 'track-1', current_date, now(), repeat('a', 64),
                 now(), now(), 1, 1, 1)`,
      [page.id],
    );

    await rebuildFanslyCatalogProjection(appStub(), { accountId: page.id });

    const tracking = await rows(
      `select 1 from page_promo_links where page_id = $1 and link_kind = 'tracking'`,
      [page.id],
    );
    expect(tracking).toHaveLength(1);
    const gift = await rows(
      `select 1 from page_promo_links where page_id = $1 and link_kind = 'gift_code'`,
      [page.id],
    );
    expect(gift).toHaveLength(2);
  });

  it("is registered with a rebuild, and declares creator_media on nobody but the media plane", async (context) => {
    if (!testDb) {
      context.skip();
      return;
    }
    const projection = findProjection(FANSLY_CATALOG_PROJECTION);
    expect(projection).not.toBeNull();
    expect(projection?.rebuildKind).toBe("truncate_replay");
    expect(projection?.rebuild).not.toBeNull();
    expect(projection?.tables).not.toContain("creator_media");
    expect(projection?.tables).not.toContain("creator_media_bundles");
    // The single-writer rule, stated as an ownership claim rather than a hope.
    expect(projection?.eventTypes).not.toContain("media.observed");
  });
});
