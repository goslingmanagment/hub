import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import {
  appendProjectionOnlyDomainEvents,
  ensureDomainEventPartitions,
  ensurePollRows,
  getSyncPage,
  listMediaStatsRefreshChunk,
  upsertDemand,
  type Database,
} from "@agency_hub_core/db";
import type { FanslyWireOutcome, FanslyWireRequest } from "@agency_hub_core/fansly";

import { emptyAlbumWalk } from "../apps/runtime/src/sync/fansly/lib/catalog-rules.ts";
import { emptyFanslyMediaStatsCursorState } from "../apps/runtime/src/sync/fansly/lib/media-stats-rules.ts";
import { SyncCrashFault } from "../apps/runtime/src/sync/engine/commit.ts";
import { createEngineRegistry, pollsFor, type EngineRegistry } from "../apps/runtime/src/sync/engine/resource.ts";
import { fanslyCaptureCodec } from "../apps/runtime/src/sync/fansly/capture.ts";
import { projectionBehind } from "../apps/runtime/src/sync/fansly/lib/projection-lag.ts";
import { createFanslyRegistry, FANSLY_RESOURCE_SPECS, fanslyResourceSpec } from "../apps/runtime/src/sync/fansly/registry.ts";
import { mediaStatsOwnerTiers, runMediaVisit, startMediaVisit } from "../apps/runtime/src/sync/fansly/resources/media-stats.ts";
import { changeSyncRegistryOverride, requestSyncProbe, SyncOwnerLeverError } from "../apps/runtime/src/sync/inspect.ts";
import { allZeroBody, statsBody } from "./helpers/fansly-media-stats-fixtures.ts";
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
  waitFor,
} from "./helpers/sync-engine-host.ts";

// The S2-09b resources of the Fansly Sync Engine (design §5.17–§5.19, §5.22)
// through the real actor and commits against a real database, journaled by
// the production capture codec: a scripted live transport answers each wire
// route; shadow runs the same registry with no transport at all. What is
// pinned: the catalog's fixed reads, album walk and hydration with the legacy
// coverage claims and walk proof; a media visit spread over steps — one window
// each — ending in the item's queue row as the legacy visit ends, a failing
// item breaking only its queue row, and a crash between capture and apply
// re-applied from the journal; the stats sweep, the hourly capture with its
// gap record and the history walk to the account's creation; the owner's
// probe; and a shadow pass that writes nothing but its own work and attempts.

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

async function seedPage(mode: "live" | "shadow" | "off", externalId: string | null = OWN_ID) {
  const { pageId, label } = await seedSyncPage({ db: db(), pool: testDb!.pool }, {
    mode,
    guard: mode === "live" ? "fansly_sync_engine" : null,
  });
  await testDb!.pool.query(
    "update pages set external_page_id = $2, last_verified_at = clock_timestamp() - interval '1 minute' where id = $1",
    [pageId, externalId],
  );
  return { pageId, label };
}

type Responder = (req: FanslyWireRequest) => FanslyWireOutcome;

async function drive(
  pageId: number,
  mode: "live" | "shadow",
  registry: EngineRegistry,
  respond: Responder | null,
  until: () => Promise<boolean>,
  options: { onHit?: (req: FanslyWireRequest) => Promise<void>; metrics?: RecordingMetrics } = {},
) {
  const transport = respond === null ? undefined : new ScriptedLiveTransport();
  if (transport !== undefined && respond !== null) transport.respond = (req) => respond(req);
  const requests: FanslyWireRequest[] = [];
  if (transport !== undefined) {
    transport.onHit = async (req) => {
      requests.push(req);
      await options.onHit?.(req);
    };
  }
  const metrics = options.metrics ?? new RecordingMetrics();
  const { actor, stop, abort } = await makeTestActor({
    db: db(),
    pageId,
    mode,
    registry,
    alerts: new RecordingAlerts(),
    metrics,
    ownRef: OWN_ID,
    capture: fanslyCaptureCodec,
    ...(transport === undefined ? {} : { transport }),
  });
  const run = actor.run({ stop: stop.signal, abort: abort.signal });
  try {
    await waitFor(async () => ((await until()) ? true : null), 30_000, "the work to settle");
  } finally {
    stop.abort();
    await run;
  }
  return { hits: requests.map((req) => req.spec), requests, metrics };
}

function query(req: FanslyWireRequest, name: string): string | null {
  return new URL(req.url).searchParams.get(name);
}

interface WorkRowView {
  state: string;
  cursor: Record<string, unknown>;
  result: Record<string, unknown> | null;
  waiting_reason: string | null;
  due_at: Date;
  close_reason: string | null;
  demand: { reasons: string[] };
}

async function workRow(pageId: number, resource: string, shadow = false): Promise<WorkRowView | null> {
  const result = await testDb!.pool.query<WorkRowView>(
    `select state, cursor, result, waiting_reason, due_at, close_reason, demand from sync_work
      where page_id = $1 and resource = $2 and shadow = $3 order by id desc limit 1`,
    [pageId, resource, shadow],
  );
  return result.rows[0] ?? null;
}

async function attempts(pageId: number, resource: string, where = "apply_state = 'applied'"): Promise<number> {
  return countRows(testDb!.pool, `select count(*)::int as n from sync_attempts where page_id = $1 and resource = $2 and ${where}`, [pageId, resource]);
}

async function observations(pageId: number) {
  const result = await testDb!.pool.query<{ id: number; kind: string; producer: string; payload: Record<string, unknown> }>(
    "select id::int as id, kind, producer, payload from observations where account_id = $1 order by id",
    [pageId],
  );
  return result.rows;
}

async function coverage(pageId: number, plane: string, scopeRef = "") {
  const result = await testDb!.pool.query<{
    status: string; proof: string; reason_code: string | null; proof_observation_id: number | null;
    expected_count: number | null; observed_unique_count: number | null; cursor: Record<string, unknown>;
  }>(
    `select status, proof, reason_code, proof_observation_id::int as proof_observation_id,
            expected_count::int as expected_count, observed_unique_count::int as observed_unique_count, cursor
       from capture_coverage where page_id = $1 and plane = $2 and scope_ref = $3`,
    [pageId, plane, scopeRef],
  );
  return result.rows[0] ?? null;
}

async function coverageScopes(pageId: number, plane: string): Promise<string[]> {
  const result = await testDb!.pool.query<{ scope_ref: string }>(
    "select scope_ref from capture_coverage where page_id = $1 and plane = $2 order by scope_ref",
    [pageId, plane],
  );
  return result.rows.map((row) => row.scope_ref);
}

// ── catalog ─────────────────────────────────────────────────────────────────

function catalogAnswer(req: FanslyWireRequest): FanslyWireOutcome {
  switch (req.spec) {
    case "vault.albums":
    case "uservault.albums":
      return okResponse({ albums: [] });
    default:
      return okResponse([]);
  }
}

async function seedAlbum(pageId: number, albumRef: string, itemCount: number, lastItemRef: string) {
  await testDb!.pool.query(
    `insert into creator_vault_albums (page_id, platform, vault_kind, album_ref, item_count, last_item_ref, pos,
            first_observed_at, last_observed_at, content_hash, source_event_id, source_observation_id, source_account_seq)
     values ($1, 'fansly', 'creator', $2, $3, $4, 0, clock_timestamp(), clock_timestamp(), $5, 1, 1, 1)`,
    [pageId, albumRef, itemCount, lastItemRef, "c".repeat(64)],
  );
}

async function seedMember(pageId: number, albumRef: string, mediaOfferRef: string) {
  await testDb!.pool.query(
    `insert into creator_vault_album_members (page_id, platform, album_ref, media_offer_ref, media_ref, vault_kind,
            first_observed_at, last_observed_at, content_hash, source_event_id, source_observation_id, source_account_seq)
     values ($1, 'fansly', $2, $3, $4, 'creator', clock_timestamp(), clock_timestamp(), $5, 1, 1, 1)`,
    [pageId, albumRef, mediaOfferRef, `raw-${mediaOfferRef}`, "d".repeat(64)],
  );
}

async function seedCreatorMedia(pageId: number, ref: string, createdAt: Date | null, firstOrigin = "post") {
  await testDb!.pool.query(
    `insert into creator_media (page_id, platform, media_offer_ref, first_origin, created_at_platform,
            first_observed_at, last_observed_at, content_hash, source_event_id, source_observation_id, source_account_seq)
     values ($1, 'fansly', $2, $3, $4, $5, $5, $6, 1, 1, 1)`,
    [pageId, ref, firstOrigin, createdAt, createdAt ?? new Date(), "f".repeat(64)],
  );
}

describe("catalog.fixed", () => {
  it("reads the six listings one a step, claims each full listing, and makes the album walk and the hydration due", async (context) => {
    if (!testDb) return context.skip();
    const { pageId } = await seedPage("live");
    const registry = await quietRegistry(pageId, false);
    await makeDue(pageId, false, "catalog.fixed");
    // Until the album walk has looked too: it runs in the slot after the
    // hydration's (an actor lap later), so stopping at the hydration races it.
    const { hits, requests } = await drive(pageId, "live", registry, catalogAnswer, async () =>
      (await attempts(pageId, "catalog.fixed")) === 6 && (await workRow(pageId, "catalog.hydrate"))?.state === "done"
        && (await workRow(pageId, "catalog.vault"))?.waiting_reason === "not_due");

    expect(hits).toEqual(["vault.albums", "uservault.albums", "subscriptions.tiers", "subscriptions.giftcodes", "message.automated", "account.walls"]);
    expect(query(requests[1]!, "accountId")).toBe(OWN_ID);
    expect((await observations(pageId)).map((row) => [row.kind, row.producer])).toEqual([
      ["vault_albums", "fansly-sync:catalog.fixed"],
      ["uservault_albums", "fansly-sync:catalog.fixed"],
      ["subscription_tiers", "fansly-sync:catalog.fixed"],
      ["gift_codes", "fansly-sync:catalog.fixed"],
      ["automated_messages", "fansly-sync:catalog.fixed"],
      ["account_walls", "fansly-sync:catalog.fixed"],
    ]);
    expect(await coverageScopes(pageId, "catalog")).toEqual([
      "account_walls", "automated_messages", "gift_codes", "subscription_tiers", "uservault_albums", "vault_albums",
    ]);
    expect(await coverage(pageId, "catalog", "vault_albums")).toMatchObject({ status: "provider_exhausted", proof: "terminal_response", reason_code: "full_listing" });
    const poll = await workRow(pageId, "catalog.fixed");
    expect(poll).toMatchObject({ state: "open", cursor: { index: 0 } });
    expect(poll!.due_at.getTime() - Date.now()).toBeGreaterThan(20 * HOUR_MS);
    // The walk looked at the albums just listed (none) and rests a day; the
    // hydration found nothing to ask.
    const vault = await workRow(pageId, "catalog.vault");
    expect(vault).toMatchObject({ state: "open", waiting_reason: "not_due" });
    expect(vault!.demand.reasons).toContain("albums_listed");
    expect(await workRow(pageId, "catalog.hydrate")).toMatchObject({ state: "done", close_reason: "hydrated" });
  });

  it("without the page's own account id the user-vault read is skipped and the coverage says why", async (context) => {
    if (!testDb) return context.skip();
    const { pageId } = await seedPage("live", null);
    const registry = await quietRegistry(pageId, false);
    await makeDue(pageId, false, "catalog.fixed");
    const { hits } = await drive(pageId, "live", registry, catalogAnswer, async () => (await attempts(pageId, "catalog.fixed")) === 5);
    expect(hits).not.toContain("uservault.albums");
    expect(hits).toHaveLength(5);
    expect(await coverage(pageId, "catalog", "uservault_albums")).toMatchObject({ status: "partial_provider_surface", proof: "none", reason_code: "own_account_ref_unknown" });
  });
});

describe("catalog.vault", () => {
  const vaultRows = (albumRef: string, members: Array<[string, string]>) => ({
    albumMedia: members.map(([id, mediaId]) => ({ id, albumId: albumRef, mediaId })),
    media: [],
  });

  it("walks an album page by page to an empty page, proves the inventory and journals the walk's completion", async (context) => {
    if (!testDb) return context.skip();
    const { pageId } = await seedPage("live");
    await seedAlbum(pageId, "A1", 2, "M2");
    const registry = await quietRegistry(pageId, false);
    await makeDue(pageId, false, "catalog.vault");
    const { hits, requests } = await drive(pageId, "live", registry, (req) => okResponse(query(req, "before") === "0"
      ? vaultRows("A1", [["AM2", "M2"], ["AM1", "M1"]])
      : vaultRows("A1", [])), async () => (await workRow(pageId, "catalog.vault"))?.waiting_reason === "not_due");

    expect(hits).toEqual(["vault.media", "vault.media"]);
    expect(requests.map((req) => [query(req, "albumId"), query(req, "before"), query(req, "after"), query(req, "mediaType")])).toEqual([
      ["A1", "0", "0", ""],
      ["A1", "AM1", "0", ""],
    ]);
    const journal = await observations(pageId);
    expect(journal.map((row) => [row.kind, row.producer])).toEqual([
      ["vault_media", "fansly-sync:catalog.vault"],
      ["vault_media", "fansly-sync:catalog.vault"],
      ["vault_album_walk_completed", "fansly-sync:catalog"],
    ]);
    expect(journal[2]!.payload).toMatchObject({
      albumRef: "A1",
      vaultKind: "creator",
      valid: true,
      expectedCount: 2,
      headRef: "M2",
      pages: 2,
      seenMediaRefs: ["M2", "M1"],
      observationRefs: [journal[0]!.id, journal[1]!.id],
    });
    expect(await coverage(pageId, "catalog_vault_media", "A1")).toMatchObject({
      status: "provider_exhausted", proof: "empty_window", reason_code: "walk_exhausted", expected_count: 2, observed_unique_count: 2, proof_observation_id: journal[1]!.id,
    });
    const walk = (await workRow(pageId, "catalog.vault"))!;
    expect(walk.cursor).toMatchObject({ afterAlbumRef: "A1", vaultWalk: { A1: { done: true, completedAtLastItemRef: "M2", pages: 2 } } });
    expect((walk.cursor.vaultWalk as Record<string, { lastCompleteWalkAt?: string }>).A1!.lastCompleteWalkAt).toBeDefined();
    expect(walk.due_at.getTime() - Date.now()).toBeGreaterThan(20 * HOUR_MS);
    // The walk named members: the hydration was asked to look.
    expect((await workRow(pageId, "catalog.hydrate"))!.demand.reasons).toContain("album_walked");
  });

  it("parks an album whose first page comes back empty although it holds items, and walks the next", async (context) => {
    if (!testDb) return context.skip();
    const { pageId } = await seedPage("live");
    await seedAlbum(pageId, "A1", 5, "M5");
    const registry = await quietRegistry(pageId, false);
    await makeDue(pageId, false, "catalog.vault");
    const { hits } = await drive(pageId, "live", registry, () => okResponse(vaultRows("A1", [])),
      async () => (await workRow(pageId, "catalog.vault"))?.waiting_reason === "not_due");
    expect(hits).toEqual(["vault.media"]);
    expect(await coverage(pageId, "catalog_vault_media", "A1")).toMatchObject({
      status: "partial_provider_surface", proof: "terminal_response", reason_code: "empty_first_page_on_non_empty_album", observed_unique_count: 0,
    });
    expect((await observations(pageId)).map((row) => row.kind)).toEqual(["vault_media"]);
  });

  it("a new walk waits while album events of the page are not projected yet", async (context) => {
    if (!testDb) return context.skip();
    const { pageId } = await seedPage("live");
    await seedAlbum(pageId, "A1", 0, "M0");
    await ensureDomainEventPartitions(db());
    await appendProjectionOnlyDomainEvents(db(), pageId, [{
      type: "vault.album_observed", schemaVersion: 1, occurredAt: new Date(), observationId: 1, dedupKey: "test:album:A1", data: { albumRef: "A1" },
    }], { occurredAt: new Date(), observationId: 1, dedupKey: "test:checkpoint:1" });
    expect(await projectionBehind(db(), { pageId, projection: "fansly_catalog", eventTypes: ["vault.album_observed"] })).toBe(true);
    const registry = await quietRegistry(pageId, false);
    await makeDue(pageId, false, "catalog.vault");
    const waited = await drive(pageId, "live", registry, () => okResponse(vaultRows("A1", [])),
      async () => (await workRow(pageId, "catalog.vault"))?.waiting_reason === "dependency");
    expect(waited.hits).toEqual([]);

    await testDb.pool.query(
      `insert into projection_seq_watermarks (projection, account_id, high_seq) values ('fansly_catalog', $1, 1000)
       on conflict (projection, account_id) do update set high_seq = excluded.high_seq`,
      [pageId],
    );
    expect(await projectionBehind(db(), { pageId, projection: "fansly_catalog", eventTypes: ["vault.album_observed"] })).toBe(false);
    await makeDue(pageId, false, "catalog.vault");
    const walked = await drive(pageId, "live", registry, () => okResponse(vaultRows("A1", [])),
      async () => (await workRow(pageId, "catalog.vault"))?.waiting_reason === "not_due");
    // An album that claims no items is proved empty by its empty page.
    expect(walked.hits).toEqual(["vault.media"]);
    expect(await coverage(pageId, "catalog_vault_media", "A1")).toMatchObject({ status: "provider_exhausted", reason_code: "album_empty" });
  });

  it("a look that finds nothing to walk waits while the album events are not projected yet, then walks the album that moved", async (context) => {
    if (!testDb) return context.skip();
    const { pageId } = await seedPage("live");
    // A1 walked today at its head M0 (one item), proved and current.
    await seedAlbum(pageId, "A1", 1, "M0");
    const registry = await quietRegistry(pageId, false);
    const today = new Date().toISOString().slice(0, 10);
    await makeDue(pageId, false, "catalog.vault");
    await setCursor(pageId, "catalog.vault", {
      afterAlbumRef: "A1",
      vaultWalk: {
        A1: {
          ...emptyAlbumWalk(),
          done: true,
          completedAtLastItemRef: "M0",
          completedOnUtcDay: today,
          lastCompleteWalkAt: `${today}T00:00:01.000Z`,
          proof: { walkRef: "w", startedAt: `${today}T00:00:00.000Z`, expectedCount: 1, headRef: "M0", seenMediaRefs: ["M0"], observationRefs: [1], valid: true },
        },
      },
    });
    // The fixed sweep journaled a listing in which A1 moved: its event sits
    // above the projection's watermark, the album row still shows M0.
    await ensureDomainEventPartitions(db());
    await appendProjectionOnlyDomainEvents(db(), pageId, [{
      type: "vault.album_observed", schemaVersion: 1, occurredAt: new Date(), observationId: 1, dedupKey: "test:album:A1:M1", data: { albumRef: "A1" },
    }], { occurredAt: new Date(), observationId: 1, dedupKey: "test:checkpoint:A1:M1" });
    const answer = (req: FanslyWireRequest) => okResponse(query(req, "before") === "0"
      ? { albumMedia: [{ id: "AM1", albumId: "A1", mediaId: "M1" }, { id: "AM0", albumId: "A1", mediaId: "M0" }], media: [] }
      : { albumMedia: [], media: [] });
    const waited = await drive(pageId, "live", registry, answer, async () => (await workRow(pageId, "catalog.vault"))?.waiting_reason === "dependency");
    // Not a day's rest on the previous list: a re-check within the minute.
    expect(waited.hits).toEqual([]);
    expect((await workRow(pageId, "catalog.vault"))!.due_at.getTime() - Date.now()).toBeLessThan(2 * 60_000);

    // Projected: the album row moved to its new head; the walk takes it.
    await testDb.pool.query(
      `insert into projection_seq_watermarks (projection, account_id, high_seq) values ('fansly_catalog', $1, 1000)
       on conflict (projection, account_id) do update set high_seq = excluded.high_seq`,
      [pageId],
    );
    await testDb.pool.query("update creator_vault_albums set last_item_ref = 'M1', item_count = 2 where page_id = $1 and album_ref = 'A1'", [pageId]);
    await makeDue(pageId, false, "catalog.vault");
    const walked = await drive(pageId, "live", registry, answer,
      async () => (await workRow(pageId, "catalog.vault"))?.waiting_reason === "not_due" && (await attempts(pageId, "catalog.vault")) === 2);
    expect(walked.hits).toEqual(["vault.media", "vault.media"]);
    expect((await workRow(pageId, "catalog.vault"))!.cursor).toMatchObject({ vaultWalk: { A1: { done: true, completedAtLastItemRef: "M1" } } });
  });

  it("the page's full-sweep override (owner decision №6) re-walks an album the registry's weekly sweep leaves, without a deploy", async (context) => {
    if (!testDb) return context.skip();
    const { pageId, label } = await seedPage("live");
    await seedAlbum(pageId, "A1", 2, "M2");
    const registry = await quietRegistry(pageId, false);
    await makeDue(pageId, false, "catalog.vault");
    const walkedOn = new Date(Date.now() - 3 * DAY_MS).toISOString().slice(0, 10);
    await setCursor(pageId, "catalog.vault", {
      afterAlbumRef: "A1",
      seeded: true,
      vaultWalk: {
        A1: {
          ...emptyAlbumWalk(),
          done: true,
          completedAtLastItemRef: "M2",
          completedOnUtcDay: walkedOn,
          lastCompleteWalkAt: `${walkedOn}T01:00:00.000Z`,
          proof: { walkRef: "w", startedAt: `${walkedOn}T00:00:00.000Z`, expectedCount: 2, headRef: "M2", seenMediaRefs: ["M2", "M1"], observationRefs: [1], valid: true },
        },
      },
    });
    const answer = (req: FanslyWireRequest) => okResponse(query(req, "before") === "0"
      ? { albumMedia: [{ id: "AM2", albumId: "A1", mediaId: "M2" }, { id: "AM1", albumId: "A1", mediaId: "M1" }], media: [] }
      : { albumMedia: [], media: [] });
    const weekly = await drive(pageId, "live", registry, answer, async () => (await workRow(pageId, "catalog.vault"))?.waiting_reason === "not_due");
    expect(weekly.hits).toEqual([]);

    const fanslyRegistry = createFanslyRegistry();
    await expect(changeSyncRegistryOverride(db(), fanslyRegistry, {
      pageLabel: label, resource: "catalog.vault", override: { fullEveryMs: 2 * DAY_MS }, ownerApproved: false,
    })).rejects.toThrow(/owner-approved/);
    expect(await changeSyncRegistryOverride(db(), fanslyRegistry, {
      pageLabel: label, resource: "catalog.vault", override: { fullEveryMs: 2 * DAY_MS }, ownerApproved: true,
    })).toBe(true);
    await makeDue(pageId, false, "catalog.vault");
    const rewalked = await drive(pageId, "live", registry, answer,
      async () => (await workRow(pageId, "catalog.vault"))?.waiting_reason === "not_due" && (await attempts(pageId, "catalog.vault")) === 2);
    expect(rewalked.hits).toEqual(["vault.media", "vault.media"]);
    const walk = (await workRow(pageId, "catalog.vault"))!;
    expect(walk.cursor).toMatchObject({ vaultWalk: { A1: { done: true, completedOnUtcDay: new Date().toISOString().slice(0, 10) } } });
    // Nothing left to walk: it rests for the incremental period (24 h).
    expect(walk.due_at.getTime() - Date.now()).toBeGreaterThan(20 * HOUR_MS);
  });
});

describe("catalog.hydrate", () => {
  it("asks ≤ 100 unhydrated refs a step, remembers the ones the batch left out, and closes when none is left", async (context) => {
    if (!testDb) return context.skip();
    const { pageId } = await seedPage("live");
    await seedMember(pageId, "A1", "O1");
    await seedMember(pageId, "A1", "O2");
    const registry = await quietRegistry(pageId, false);
    await makeDue(pageId, false, "catalog.hydrate");
    const { hits, requests } = await drive(pageId, "live", registry, () => okResponse([{ id: "O1", previewId: null }]),
      async () => (await workRow(pageId, "catalog.hydrate"))?.state === "done",
      // The media-plane projection's part: the served card becomes a row.
      { onHit: async () => seedCreatorMedia(pageId, "O1", new Date(), "account_media_batch") });
    expect(hits).toEqual(["account.media_by_ids"]);
    expect(query(requests[0]!, "ids")).toBe("O1,O2");
    const goal = (await workRow(pageId, "catalog.hydrate"))!;
    expect(goal).toMatchObject({ close_reason: "hydrated", cursor: { hydratedMedia: 2 } });
    expect(Object.keys(goal.cursor.unserved as Record<string, number>)).toEqual(["O2"]);
    expect((await observations(pageId)).map((row) => row.kind)).toEqual(["account_media_batch"]);
    expect(await coverage(pageId, "catalog_media_hydration")).toMatchObject({ status: "in_progress", reason_code: "batch_hydration" });

    // The next trigger (tomorrow's fixed sweep) opens a new row: it starts
    // from the memory of the one before, so the left-out ref is not asked.
    await makeDue(pageId, false, "catalog.hydrate");
    const again = await drive(pageId, "live", registry, () => okResponse([]),
      async () => (await countRows(testDb!.pool, "select count(*)::int as n from sync_work where page_id = $1 and resource = 'catalog.hydrate' and state = 'done'", [pageId])) === 2);
    expect(again.hits).toEqual([]);
    expect(Object.keys((await workRow(pageId, "catalog.hydrate"))!.cursor.unserved as Record<string, number>)).toEqual(["O2"]);
  });
});

// ── media-stats ─────────────────────────────────────────────────────────────

const ITEM_FRESH = "777000000000000010";
const ITEM_MID = "777000000000000020";
const ITEM_GONE = "777000000000000030";
const ITEM_LONG = "777000000000000040";
const ITEM_LONG_OLDER = "777000000000000050";
const BACKFILL_DONE = {
  version: 1, nextBeforeMs: 0, emptyStreak: 2, done: true, floorAt: null, stopReason: "created_at_floor", floorBasis: "created_at",
  guard: { spanDays: 31, narrowed: false, lastAfterMs: null, lastBeforeMs: null, lastObservationId: null },
};

async function seedQueueItem(pageId: number, ref: string, input: { ageDays: number; lastVisitedDaysAgo?: number; backfillCursor?: unknown }) {
  await seedCreatorMedia(pageId, ref, daysAgo(input.ageDays));
  await testDb!.pool.query(
    `insert into subject_refresh_state (page_id, plane, subject_ref, refresh_class, next_due_at, last_visited_at, backfill_cursor)
     values ($1, 'media_stats', $2, 'fresh', clock_timestamp(), $3, $4::jsonb)
     on conflict (page_id, plane, subject_ref) do update set last_visited_at = excluded.last_visited_at, backfill_cursor = excluded.backfill_cursor`,
    [pageId, ref, input.lastVisitedDaysAgo === undefined ? null : daysAgo(input.lastVisitedDaysAgo), JSON.stringify(input.backfillCursor ?? {})],
  );
}

async function mediaRow(pageId: number, ref: string) {
  const result = await testDb!.pool.query<{
    last_visited_at: Date | null; next_due_at: Date | null; consecutive_failures: number; known_count: number | null;
    backfill_cursor: Record<string, unknown>; refresh_class: string; dirty_reason: string | null;
  }>(
    `select last_visited_at, next_due_at, consecutive_failures, known_count::int as known_count, backfill_cursor, refresh_class, dirty_reason
       from subject_refresh_state where page_id = $1 and plane = 'media_stats' and subject_ref = $2`,
    [pageId, ref],
  );
  return result.rows[0] ?? null;
}

async function mediaQueueSnapshot(pageId: number) {
  const result = await testDb!.pool.query(
    "select * from subject_refresh_state where page_id = $1 and plane = 'media_stats' order by subject_ref",
    [pageId],
  );
  return result.rows;
}

/** A served window exactly as asked, with buckets; the window below the
 *  first one of `zeroBelowFirst` all-zero. */
function mediaAnswer(options: { zeroAfterFirstOf?: string; fail?: string } = {}): Responder {
  const seen = new Set<string>();
  return (req) => {
    const ref = query(req, "mediaOfferId")!;
    if (ref === options.fail) return statusResponse(500, { success: false, error: { code: 500, details: "error getting media offer" } });
    const window = { mediaOfferRef: ref, afterMs: Number(query(req, "afterDate")), beforeMs: Number(query(req, "beforeDate")), periodMs: Number(query(req, "period")) };
    const first = !seen.has(ref);
    seen.add(ref);
    return okResponse(ref === options.zeroAfterFirstOf && !first ? allZeroBody(window) : statsBody(window));
  };
}

function windowsOf(requests: FanslyWireRequest[], ref: string) {
  return requests.filter((req) => query(req, "mediaOfferId") === ref)
    .map((req) => ({ afterMs: Number(query(req, "afterDate")), beforeMs: Number(query(req, "beforeDate")), periodMs: Number(query(req, "period")) }));
}

/** The page's latest top-media window names `ref` (what the daily mark reads). */
async function seedTopMedia(pageId: number, ref: string) {
  await testDb!.pool.query(
    `insert into stats_top_media (page_id, platform, plane, period_ms, requested_start, requested_end, media_offer_ref, rank,
                                  content_hash, observed_at, source_event_id, source_observation_id, source_account_seq)
     values ($1, 'fansly', 'top_media', 86400000, now() - interval '30 days', now() - interval '1 hour', $2, 0, $3, now(), 1, 1, 1)`,
    [pageId, ref, "e".repeat(64)],
  );
}

function utcDay(at: Date): string {
  return at.toISOString().slice(0, 10);
}

describe("media-stats.walk", () => {
  it("visits each due item, one window a step: a first visit walks to the item's creation, a visited item reads its refresh", async (context) => {
    if (!testDb) return context.skip();
    const { pageId } = await seedPage("live");
    await seedQueueItem(pageId, ITEM_FRESH, { ageDays: 10 });
    await seedQueueItem(pageId, ITEM_MID, { ageDays: 60, lastVisitedDaysAgo: 10, backfillCursor: BACKFILL_DONE });
    const registry = await quietRegistry(pageId, false);
    await makeDue(pageId, false, "media-stats.walk");
    const { hits, requests } = await drive(pageId, "live", registry, mediaAnswer({ zeroAfterFirstOf: ITEM_FRESH }),
      async () => (await workRow(pageId, "media-stats.walk"))?.waiting_reason === "not_due");

    expect(hits).toEqual(["media.offer_stats", "media.offer_stats", "media.offer_stats"]);
    // The fresh item first (tier), then the mid one.
    expect(requests.map((req) => query(req, "mediaOfferId"))).toEqual([ITEM_FRESH, ITEM_FRESH, ITEM_MID]);
    const [first, second] = windowsOf(requests, ITEM_FRESH);
    expect(first!.beforeMs - first!.afterMs).toBe(31 * DAY_MS);
    expect(second).toEqual({ beforeMs: first!.afterMs + DAY_MS, afterMs: first!.afterMs + DAY_MS - 31 * DAY_MS, periodMs: DAY_MS });
    const [refresh] = windowsOf(requests, ITEM_MID);
    expect(refresh!.beforeMs - refresh!.afterMs).toBe(30 * DAY_MS);

    const fresh = (await mediaRow(pageId, ITEM_FRESH))!;
    expect(fresh).toMatchObject({ known_count: 3, consecutive_failures: 0, refresh_class: "fresh", dirty_reason: null });
    expect(fresh.backfill_cursor).toMatchObject({ done: true, floorBasis: "created_at", refreshedThroughMs: first!.beforeMs });
    expect(fresh.next_due_at!.getTime() - fresh.last_visited_at!.getTime()).toBe(DAY_MS);
    const mid = (await mediaRow(pageId, ITEM_MID))!;
    expect(mid).toMatchObject({ known_count: 2, refresh_class: "mid" });
    // Owner decision №6: a 31–90-day item is due weekly.
    expect(mid.next_due_at!.getTime() - mid.last_visited_at!.getTime()).toBe(7 * DAY_MS);

    const journal = await observations(pageId);
    expect(journal.map((row) => row.kind)).toEqual(["media_offer_stats", "media_offer_stats", "media_offer_stats"]);
    const walk = (await workRow(pageId, "media-stats.walk"))!;
    expect(walk.cursor).toMatchObject({ visit: null, longTailWindowMode: "unproven", last: { subjectRef: ITEM_MID, outcome: "visited" } });
    expect(walk.cursor.topMarkedDay).toBe(new Date().toISOString().slice(0, 10));
    expect(walk.due_at.getTime() - Date.now()).toBeGreaterThan(5 * HOUR_MS);
    expect(await coverage(pageId, "media_stats", String(pageId))).toMatchObject({ status: "window_captured", expected_count: 2, observed_unique_count: 2 });
    // Every step's visit is stored with its attempt.
    const steps = await testDb.pool.query<{ subject: string; outcomes: number }>(
      `select request -> 'step' -> 'visit' -> 'snapshot' ->> 'subjectRef' as subject,
              jsonb_array_length(request -> 'step' -> 'visit' -> 'outcomes') as outcomes
         from sync_attempts where page_id = $1 and resource = 'media-stats.walk' order by id`,
      [pageId],
    );
    expect(steps.rows).toEqual([{ subject: ITEM_FRESH, outcomes: 0 }, { subject: ITEM_FRESH, outcomes: 1 }, { subject: ITEM_MID, outcomes: 0 }]);
  });

  it("today's top 50 jump the queue once a UTC day, marked before the pick — also on a day nothing else is due", async (context) => {
    if (!testDb) return context.skip();
    const { pageId } = await seedPage("live");
    // A 60-day item read two days ago: not due again for five days by its tier.
    await seedQueueItem(pageId, ITEM_MID, { ageDays: 60, lastVisitedDaysAgo: 2, backfillCursor: BACKFILL_DONE });
    // The page's latest top-media window names it.
    await seedTopMedia(pageId, ITEM_MID);
    const registry = await quietRegistry(pageId, false);
    await makeDue(pageId, false, "media-stats.walk");
    await setCursor(pageId, "media-stats.walk", { topMarkedDay: new Date(Date.now() - DAY_MS).toISOString().slice(0, 10) });
    const { hits, requests } = await drive(pageId, "live", registry, mediaAnswer(),
      async () => (await workRow(pageId, "media-stats.walk"))?.waiting_reason === "not_due");
    // Marked (a local step, no request), then picked as dirty and read.
    expect(hits).toEqual(["media.offer_stats"]);
    expect(requests.map((req) => query(req, "mediaOfferId"))).toEqual([ITEM_MID]);
    expect(await mediaRow(pageId, ITEM_MID)).toMatchObject({ dirty_reason: null });
    expect((await workRow(pageId, "media-stats.walk"))!.cursor.topMarkedDay).toBe(new Date().toISOString().slice(0, 10));
    // The same UTC day: no second mark, nothing due, no read.
    await makeDue(pageId, false, "media-stats.walk");
    const again = await drive(pageId, "live", registry, mediaAnswer(),
      async () => (await workRow(pageId, "media-stats.walk"))?.waiting_reason === "not_due" && (await attempts(pageId, "media-stats.walk", "true")) === 1);
    expect(again.hits).toEqual([]);
  });

  it("the daily top-50 mark is a local step: nothing admitted or sent, an item read within the day left to its tier", async (context) => {
    if (!testDb) return context.skip();
    const { pageId } = await seedPage("live");
    // A 60-day item read two hours ago: not due by its weekly tier, and the
    // mark leaves an item visited within the day alone.
    await seedQueueItem(pageId, ITEM_MID, { ageDays: 60, lastVisitedDaysAgo: 2 / 24, backfillCursor: BACKFILL_DONE });
    await seedTopMedia(pageId, ITEM_MID);
    const before = await mediaRow(pageId, ITEM_MID);
    const registry = await quietRegistry(pageId, false);
    await makeDue(pageId, false, "media-stats.walk");
    await setCursor(pageId, "media-stats.walk", { topMarkedDay: new Date(Date.now() - DAY_MS).toISOString().slice(0, 10) });
    const today = new Date().toISOString().slice(0, 10);
    const { hits } = await drive(pageId, "live", registry, mediaAnswer(), async () => {
      const row = await workRow(pageId, "media-stats.walk");
      return row?.cursor.topMarkedDay === today && row.waiting_reason === "not_due";
    });
    expect(hits).toEqual([]);
    expect(await attempts(pageId, "media-stats.walk", "true")).toBe(0);
    expect(await mediaRow(pageId, ITEM_MID)).toEqual(before);
  });

  // The plan's `top_media_mark` is the walk's only mark (step 4, S4-07). The
  // two tests above are the day with nothing (else) due: the guard precedes
  // the pick. The next two are the days a step's apply used to mark instead —
  // a visit in flight at midnight, a failed step — on which the mark lands
  // with the walk's next plan between two visits.
  it("a visit in flight at midnight is never interrupted by the mark: the plan after its last step marks today's top 50", async (context) => {
    if (!testDb) return context.skip();
    const { pageId } = await seedPage("live");
    // A long-tail item on a page whose route splits the 90-day window: its
    // visit asks three 31-day windows.
    await seedQueueItem(pageId, ITEM_LONG, { ageDays: 400, lastVisitedDaysAgo: 35, backfillCursor: BACKFILL_DONE });
    // Today's top item, read two days ago: due only once marked.
    await seedQueueItem(pageId, ITEM_MID, { ageDays: 60, lastVisitedDaysAgo: 2, backfillCursor: BACKFILL_DONE });
    await seedTopMedia(pageId, ITEM_MID);
    const page = { longTailWindowMode: "split_31", longTailWindowAnnounced: true, longTailProbeFailedDay: null } as const;
    // The visit began before midnight, after that day's mark, and has its
    // first answer.
    const candidates = await listMediaStatsRefreshChunk(db(), {
      pageId, limit: 10, now: new Date(), tiers: mediaStatsOwnerTiers({ registryOverrides: {} }),
    });
    const begun = startMediaVisit(candidates.find((candidate) => candidate.subjectRef === ITEM_LONG)!, page, new Date(Date.now() - 10 * 60_000));
    const first = runMediaVisit(begun);
    if (first.kind !== "need") throw new Error("the long-tail visit asks for no window");
    const answered = { servedAfterMs: first.window.afterMs, servedBeforeMs: first.window.beforeMs, empty: false, buckets: 2, observationId: null };
    const registry = await quietRegistry(pageId, false);
    await makeDue(pageId, false, "media-stats.walk");
    await setCursor(pageId, "media-stats.walk", {
      ...page,
      topMarkedDay: utcDay(new Date(Date.now() - DAY_MS)),
      visit: { ...begun, outcomes: [{ key: first.window.key, ok: answered }] },
    });
    // The top item's mark as each remaining window of the visit is asked.
    const markWhenAsked: Array<string | null> = [];
    const { requests } = await drive(pageId, "live", registry, mediaAnswer(),
      async () => ((await mediaRow(pageId, ITEM_MID))?.known_count ?? null) !== null,
      { onHit: async (req) => {
        if (query(req, "mediaOfferId") === ITEM_LONG) markWhenAsked.push((await mediaRow(pageId, ITEM_MID))!.dirty_reason);
      } });

    // The visit's two remaining windows with nothing marked between them;
    // then the mark (a local step, no request) and the top item read.
    expect(requests.map((req) => query(req, "mediaOfferId"))).toEqual([ITEM_LONG, ITEM_LONG, ITEM_MID]);
    expect(markWhenAsked).toEqual([null, null]);
    expect(await mediaRow(pageId, ITEM_LONG)).toMatchObject({ refresh_class: "long_tail", consecutive_failures: 0 });
    expect(await mediaRow(pageId, ITEM_MID)).toMatchObject({ dirty_reason: null, consecutive_failures: 0 });
    expect((await workRow(pageId, "media-stats.walk"))!.cursor).toMatchObject({ topMarkedDay: utcDay(new Date()), visit: null });
  });

  it("after a failed step the failure's plan comes first: the mark lands with the first plan after an applied step", async (context) => {
    if (!testDb) return context.skip();
    const { pageId } = await seedPage("live");
    await seedQueueItem(pageId, ITEM_GONE, { ageDays: 5 });
    // Today's top item, read two days ago: due only once marked.
    await seedQueueItem(pageId, ITEM_MID, { ageDays: 60, lastVisitedDaysAgo: 2, backfillCursor: BACKFILL_DONE });
    await seedTopMedia(pageId, ITEM_MID);
    const registry = await quietRegistry(pageId, false);
    await makeDue(pageId, false, "media-stats.walk");
    const lastErrorClass = async () => (await testDb!.pool.query<{ last_error_class: string | null }>(
      "select last_error_class from sync_work where page_id = $1 and resource = 'media-stats.walk' and not shadow and state = 'open'",
      [pageId],
    )).rows[0]!.last_error_class;
    // The day's mark is done; the one due item fails and the walk rests on
    // the failed step until its re-check.
    await setCursor(pageId, "media-stats.walk", { topMarkedDay: utcDay(new Date()) });
    const respond = mediaAnswer({ fail: ITEM_GONE });
    const failed = await drive(pageId, "live", registry, respond, async () => {
      const row = await workRow(pageId, "media-stats.walk");
      return row?.waiting_reason === "not_due" && row.due_at.getTime() - Date.now() > HOUR_MS;
    });
    expect(failed.requests.map((req) => query(req, "mediaOfferId"))).toEqual([ITEM_GONE]);
    expect(await lastErrorClass()).not.toBeNull();

    // Midnight passes, and another item comes due.
    await setCursor(pageId, "media-stats.walk", { topMarkedDay: utcDay(new Date(Date.now() - DAY_MS)) });
    await seedQueueItem(pageId, ITEM_FRESH, { ageDays: 10, lastVisitedDaysAgo: 2, backfillCursor: BACKFILL_DONE });
    await makeDue(pageId, false, "media-stats.walk");
    const markWhenAsked: Array<string | null> = [];
    const { requests } = await drive(pageId, "live", registry, respond,
      async () => ((await mediaRow(pageId, ITEM_MID))?.known_count ?? null) !== null,
      { onHit: async (req) => {
        if (query(req, "mediaOfferId") === ITEM_FRESH) markWhenAsked.push((await mediaRow(pageId, ITEM_MID))!.dirty_reason);
      } });

    // The plan that read the failure picked the next item without marking;
    // its applied step cleared the error, and the next plan marked.
    expect(requests.map((req) => query(req, "mediaOfferId"))).toEqual([ITEM_FRESH, ITEM_MID]);
    expect(markWhenAsked).toEqual([null]);
    expect(await lastErrorClass()).toBeNull();
    expect(await mediaRow(pageId, ITEM_MID)).toMatchObject({ dirty_reason: null, consecutive_failures: 0 });
    expect((await workRow(pageId, "media-stats.walk"))!.cursor.topMarkedDay).toBe(utcDay(new Date()));
  });

  it("a failing item breaks only its queue row and the walk moves on", async (context) => {
    if (!testDb) return context.skip();
    const { pageId } = await seedPage("live");
    await seedQueueItem(pageId, ITEM_GONE, { ageDays: 5 });
    await seedQueueItem(pageId, ITEM_MID, { ageDays: 60, lastVisitedDaysAgo: 10, backfillCursor: BACKFILL_DONE });
    const registry = await quietRegistry(pageId, false);
    await makeDue(pageId, false, "media-stats.walk");
    const { requests } = await drive(pageId, "live", registry, mediaAnswer({ fail: ITEM_GONE }),
      async () => (await mediaRow(pageId, ITEM_MID))?.known_count === 2);
    expect(requests.map((req) => query(req, "mediaOfferId"))).toEqual([ITEM_GONE, ITEM_MID]);
    const gone = (await mediaRow(pageId, ITEM_GONE))!;
    expect(gone).toMatchObject({ consecutive_failures: 1, last_visited_at: null, backfill_cursor: {} });
    // The engine's subject ladder: a minute first.
    expect(gone.next_due_at!.getTime() - Date.now()).toBeGreaterThan(30_000);
    expect(gone.next_due_at!.getTime() - Date.now()).toBeLessThan(2 * 60_000);
    const failed = await observations(pageId);
    expect(failed[0]!.kind).toBe("media_offer_stats:failed");
  });

  it("a long-tail 90-day window refused with an HTTP 500 falls back to the split plan in the next steps of the same visit", async (context) => {
    if (!testDb) return context.skip();
    const { pageId } = await seedPage("live");
    await seedQueueItem(pageId, ITEM_MID, { ageDays: 400, lastVisitedDaysAgo: 35, backfillCursor: BACKFILL_DONE });
    const registry = await quietRegistry(pageId, false);
    await makeDue(pageId, false, "media-stats.walk");
    await setCursor(pageId, "media-stats.walk", { longTailWindowMode: "ninety", longTailWindowAnnounced: true });
    const answer = mediaAnswer();
    const { requests } = await drive(pageId, "live", registry, (req) => {
      const spanDays = (Number(query(req, "beforeDate")) - Number(query(req, "afterDate"))) / DAY_MS;
      return spanDays === 90
        ? statusResponse(500, { success: false, error: { code: 500, details: "error getting graph" } })
        : answer(req);
    }, async () => (await mediaRow(pageId, ITEM_MID))?.known_count !== null);
    const windows = windowsOf(requests, ITEM_MID);
    const top = windows[0]!.beforeMs;
    expect(windows.map((window) => [(top - window.afterMs) / DAY_MS, (top - window.beforeMs) / DAY_MS])).toEqual([[90, 0], [31, 0], [62, 31], [93, 62]]);
    // The failure opened the item's breaker; the visit's end closed it again.
    expect(await mediaRow(pageId, ITEM_MID)).toMatchObject({ consecutive_failures: 0, known_count: 6, refresh_class: "long_tail" });
    expect((await workRow(pageId, "media-stats.walk"))!.cursor).toMatchObject({ longTailWindowMode: "split_31", visit: null });
    expect((await observations(pageId)).map((row) => row.kind)).toEqual([
      "media_offer_stats:failed", "media_offer_stats", "media_offer_stats", "media_offer_stats",
    ]);
  });

  it("a crash between capture and apply is re-applied from the journal without asking again", async (context) => {
    if (!testDb) return context.skip();
    const { pageId } = await seedPage("live");
    await seedQueueItem(pageId, ITEM_FRESH, { ageDays: 10 });
    const registry = await quietRegistry(pageId, false);
    await makeDue(pageId, false, "media-stats.walk");
    const respond = mediaAnswer({ zeroAfterFirstOf: ITEM_FRESH });
    const transport = new ScriptedLiveTransport();
    transport.respond = (req) => respond(req);
    let hitsBeforeCrash = 0;
    transport.onHit = async () => {
      hitsBeforeCrash += 1;
    };
    const dying = await makeTestActor({
      db: db(), pageId, mode: "live", registry, ownRef: OWN_ID, capture: fanslyCaptureCodec, transport,
      // The second window is journaled, then the process dies.
      faults: (at) => {
        if (at === "after_capture" && hitsBeforeCrash === 2) throw new SyncCrashFault(at);
      },
    });
    await expect(dying.actor.run({ stop: dying.stop.signal, abort: dying.abort.signal })).rejects.toBeInstanceOf(SyncCrashFault);
    expect(await mediaRow(pageId, ITEM_FRESH)).toMatchObject({ last_visited_at: null });
    const restarted = await drive(pageId, "live", registry, respond, async () => (await mediaRow(pageId, ITEM_FRESH))?.known_count === 3);
    expect(restarted.hits).toEqual([]);
    expect((await mediaRow(pageId, ITEM_FRESH))!.backfill_cursor).toMatchObject({ done: true, floorBasis: "created_at" });
    expect(await attempts(pageId, "media-stats.walk")).toBe(2);
  });

  it("a stored visit that no longer replays (a deploy changed a visit rule) is abandoned: the walk starts afresh and keeps running", async (context) => {
    if (!testDb) return context.skip();
    const { pageId } = await seedPage("live");
    await seedQueueItem(pageId, ITEM_FRESH, { ageDays: 10 });
    const registry = await quietRegistry(pageId, false);
    await makeDue(pageId, false, "media-stats.walk");
    // The visit in flight began under other rules: the window it recorded is
    // not one today's code asks for.
    const [candidate] = await listMediaStatsRefreshChunk(db(), {
      pageId, limit: 1, now: new Date(), tiers: mediaStatsOwnerTiers({ registryOverrides: {} }),
    });
    const begun = startMediaVisit(candidate!, { longTailWindowMode: "unproven", longTailWindowAnnounced: false, longTailProbeFailedDay: null }, new Date());
    await setCursor(pageId, "media-stats.walk", {
      visit: { ...begun, outcomes: [{ key: "86400000:1:2", ok: { servedAfterMs: 1, servedBeforeMs: 2, empty: false, buckets: 1, observationId: 1 } }] },
    });
    const metrics = new RecordingMetrics();
    const { requests } = await drive(pageId, "live", registry, mediaAnswer({ zeroAfterFirstOf: ITEM_FRESH }),
      async () => (await workRow(pageId, "media-stats.walk"))?.waiting_reason === "not_due", { metrics });

    // A fresh first visit (the walk from today down to the item's creation),
    // the plan never failing on the stale one.
    expect(metrics.get("sync_plan_errors")).toBe(0);
    expect(windowsOf(requests, ITEM_FRESH)).toHaveLength(2);
    expect(await mediaRow(pageId, ITEM_FRESH)).toMatchObject({ known_count: 3, consecutive_failures: 0 });
    const walk = (await workRow(pageId, "media-stats.walk"))!;
    expect(walk.state).toBe("open");
    expect(walk.cursor).toMatchObject({ visit: null, last: { subjectRef: ITEM_FRESH, outcome: "visited" } });
    // The step that replaced it says which visit it abandoned.
    const steps = await testDb.pool.query<{ abandoned: string | null; outcomes: number }>(
      `select request -> 'step' ->> 'abandoned' as abandoned, jsonb_array_length(request -> 'step' -> 'visit' -> 'outcomes') as outcomes
         from sync_attempts where page_id = $1 and resource = 'media-stats.walk' order by id`,
      [pageId],
    );
    expect(steps.rows).toEqual([{ abandoned: ITEM_FRESH, outcomes: 0 }, { abandoned: null, outcomes: 1 }]);
  });

  it("a captured step whose visit no longer replays is applied without a look: the item backs off, the walk is never quarantined", async (context) => {
    if (!testDb) return context.skip();
    const { pageId } = await seedPage("live");
    await seedQueueItem(pageId, ITEM_FRESH, { ageDays: 10 });
    const registry = await quietRegistry(pageId, false);
    await makeDue(pageId, false, "media-stats.walk");
    const respond = mediaAnswer({ zeroAfterFirstOf: ITEM_FRESH });
    const transport = new ScriptedLiveTransport();
    transport.respond = (req) => respond(req);
    const dying = await makeTestActor({
      db: db(), pageId, mode: "live", registry, ownRef: OWN_ID, capture: fanslyCaptureCodec, transport,
      faults: (at) => {
        if (at === "after_capture") throw new SyncCrashFault(at);
      },
    });
    await expect(dying.actor.run({ stop: dying.stop.signal, abort: dying.abort.signal })).rejects.toBeInstanceOf(SyncCrashFault);
    // A deploy between the capture and the apply moved a visit rule: the
    // stored visit now asks for another window than the one journaled.
    await testDb.pool.query(
      `update sync_attempts
          set request = jsonb_set(request, '{step,visit,snapshot,nowMs}', to_jsonb((request #>> '{step,visit,snapshot,nowMs}')::bigint - 86400000))
        where page_id = $1 and resource = 'media-stats.walk'`,
      [pageId],
    );
    const restarted = await drive(pageId, "live", registry, respond,
      async () => ((await workRow(pageId, "media-stats.walk"))?.result as { outcome?: string } | null)?.outcome === "abandoned");
    expect(restarted.hits).toEqual([]);
    expect(await attempts(pageId, "media-stats.walk")).toBe(1);
    const walk = (await workRow(pageId, "media-stats.walk"))!;
    expect(walk.state).toBe("open");
    expect(walk.cursor).toMatchObject({ visit: null, last: { subjectRef: ITEM_FRESH, outcome: "abandoned", reason: "window_changed" } });
    // The item backs off on its own ladder; the answer stays in the journal.
    expect(await mediaRow(pageId, ITEM_FRESH)).toMatchObject({ consecutive_failures: 1, last_visited_at: null });
    expect((await observations(pageId)).map((row) => row.kind)).toEqual(["media_offer_stats"]);
  });

  it("a page's tiers override (owner decision №6) changes which items are due and when again, without a deploy", async (context) => {
    if (!testDb) return context.skip();
    const { pageId, label } = await seedPage("live");
    // A 60-day item visited 3 days ago: weekly by the registry's tiers.
    await seedQueueItem(pageId, ITEM_MID, { ageDays: 60, lastVisitedDaysAgo: 3, backfillCursor: BACKFILL_DONE });
    const registry = await quietRegistry(pageId, false);
    await makeDue(pageId, false, "media-stats.walk");
    const weekly = await drive(pageId, "live", registry, mediaAnswer(), async () => (await workRow(pageId, "media-stats.walk"))?.waiting_reason === "not_due");
    expect(weekly.hits).toEqual([]);

    const tiers = [{ maxAgeDays: 30, everyMs: DAY_MS }, { maxAgeDays: 90, everyMs: 2 * DAY_MS }, { maxAgeDays: null, everyMs: 30 * DAY_MS }];
    const fanslyRegistry = createFanslyRegistry();
    await expect(changeSyncRegistryOverride(db(), fanslyRegistry, { pageLabel: label, resource: "media-stats.walk", override: { tiers }, ownerApproved: false }))
      .rejects.toThrow(/owner-approved/);
    await expect(changeSyncRegistryOverride(db(), fanslyRegistry, { pageLabel: label, resource: "media-stats.walk", override: { everyMs: DAY_MS }, ownerApproved: true }))
      .rejects.toThrow(/not a poll/);
    expect(await changeSyncRegistryOverride(db(), fanslyRegistry, { pageLabel: label, resource: "media-stats.walk", override: { tiers }, ownerApproved: true }))
      .toBe(true);
    expect((await getSyncPage(db(), pageId))!.registryOverrides).toEqual({ "media-stats.walk": { tiers } });
    await makeDue(pageId, false, "media-stats.walk");
    const { requests } = await drive(pageId, "live", registry, mediaAnswer(), async () => (await mediaRow(pageId, ITEM_MID))?.known_count !== null);
    expect(requests.map((req) => query(req, "mediaOfferId"))).toEqual([ITEM_MID]);
    const mid = (await mediaRow(pageId, ITEM_MID))!;
    expect(mid.next_due_at!.getTime() - mid.last_visited_at!.getTime()).toBe(2 * DAY_MS);
  });

  it("shadow walks every due item once with its estimated windows and writes nothing but its own attempts", async (context) => {
    if (!testDb) return context.skip();
    const { pageId } = await seedPage("shadow");
    await seedQueueItem(pageId, ITEM_FRESH, { ageDays: 10 });
    await seedQueueItem(pageId, ITEM_MID, { ageDays: 60, lastVisitedDaysAgo: 10, backfillCursor: BACKFILL_DONE });
    const registry = await quietRegistry(pageId, true);
    await makeDue(pageId, true, "media-stats.walk");
    const queueBefore = await mediaQueueSnapshot(pageId);
    const before = await tableCounts(testDb.pool);
    await drive(pageId, "shadow", registry, null, async () => (await workRow(pageId, "media-stats.walk", true))?.waiting_reason === "not_due");
    const rows = await testDb.pool.query<{ subject: string; n: number }>(
      `select request -> 'params' ->> 'mediaOfferId' as subject, count(*)::int as n from sync_attempts
        where page_id = $1 and shadow and resource = 'media-stats.walk' and outcome = 'shadow' group by 1 order by 1`,
      [pageId],
    );
    // A first visit of a fresh item: its walk's two windows; a visited mid
    // item: its refresh.
    expect(rows.rows).toEqual([{ subject: ITEM_FRESH, n: 2 }, { subject: ITEM_MID, n: 1 }]);
    expect(await mediaQueueSnapshot(pageId)).toEqual(queueBefore);
    expect(changedTables(before, await tableCounts(testDb.pool))).toEqual(["sync_attempts"]);
    const walk = (await workRow(pageId, "media-stats.walk", true))!;
    expect(walk.due_at.getTime() - Date.now()).toBeGreaterThan(5 * HOUR_MS);

    // Each window's bounds are cut at its step's clock; the step names its
    // place instead (step 3b ruling 12): the pass, the item's queue position,
    // the window's number in the visit.
    const positions = async () => (await testDb!.pool.query<{ position: { pass: number; item: string; window: number } }>(
      "select request -> 'position' as position from sync_attempts where page_id = $1 and shadow and resource = 'media-stats.walk' order by id",
      [pageId],
    )).rows.map((row) => row.position);
    const firstPass = await positions();
    expect(firstPass).toEqual([
      { pass: 1, item: expect.stringContaining(ITEM_FRESH), window: 0 },
      { pass: 1, item: firstPass[0]!.item, window: 1 },
      { pass: 1, item: expect.stringContaining(ITEM_MID), window: 0 },
    ]);
    // A re-check period later the next pass reads both items again (shadow
    // records no visit): the same items and windows, another pass.
    await testDb.pool.query(
      `update sync_work set cursor = jsonb_set(cursor, '{shadow,startedAt}', to_jsonb($2::text))
        where page_id = $1 and shadow and resource = 'media-stats.walk'`,
      [pageId, new Date(Date.now() - 7 * HOUR_MS).toISOString()],
    );
    await makeDue(pageId, true, "media-stats.walk");
    await drive(pageId, "shadow", registry, null, async () =>
      (await countRows(testDb!.pool, "select count(*)::int as n from sync_attempts where page_id = $1 and shadow and resource = 'media-stats.walk' and outcome = 'shadow'", [pageId])) === 6
      && (await workRow(pageId, "media-stats.walk", true))?.waiting_reason === "not_due");
    expect((await positions()).slice(3)).toEqual(firstPass.map((position) => ({ ...position, pass: 2 })));
  });

  it("shadow models the long tail as live (step 3b ruling 12): on an unproven route the first visit asks the 90-day window and the split, every later one the split", async (context) => {
    if (!testDb) return context.skip();
    const { pageId } = await seedPage("shadow");
    // Two long-tail items, both refreshed within their month; the one read
    // longer ago goes first. Neither the shadow walk nor the legacy lane has
    // learned the page's 90-day window.
    await seedQueueItem(pageId, ITEM_LONG_OLDER, { ageDays: 500, lastVisitedDaysAgo: 40, backfillCursor: BACKFILL_DONE });
    await seedQueueItem(pageId, ITEM_LONG, { ageDays: 400, lastVisitedDaysAgo: 35, backfillCursor: BACKFILL_DONE });
    const registry = await quietRegistry(pageId, true);
    await makeDue(pageId, true, "media-stats.walk");
    await drive(pageId, "shadow", registry, null, async () => (await workRow(pageId, "media-stats.walk", true))?.waiting_reason === "not_due");
    const rows = await testDb.pool.query<{ subject: string; n: number }>(
      `select request -> 'params' ->> 'mediaOfferId' as subject, count(*)::int as n from sync_attempts
        where page_id = $1 and shadow and resource = 'media-stats.walk' and outcome = 'shadow' group by 1 order by min(id)`,
      [pageId],
    );
    // Live's first long-tail visit: the refused 90-day window, then three
    // 31-day windows; the route's answer known, the next asks the three.
    expect(rows.rows).toEqual([{ subject: ITEM_LONG_OLDER, n: 1 + 3 }, { subject: ITEM_LONG, n: 3 }]);
    const walk = (await workRow(pageId, "media-stats.walk", true))!;
    expect(walk.cursor).toMatchObject({ longTailWindowMode: "split_31", longTailWindowAnnounced: true, shadowVisit: null });
  });

  it("shadow asks what the legacy lane learned of the 90-day window: the switch imports it (step 3b ruling 12)", async (context) => {
    if (!testDb) return context.skip();
    const { pageId } = await seedPage("shadow");
    await seedQueueItem(pageId, ITEM_LONG, { ageDays: 400, lastVisitedDaysAgo: 35, backfillCursor: BACKFILL_DONE });
    await testDb.pool.query(
      `insert into page_sync_cursors (page_id, stream, state) values ($1, 'media_stats', $2::jsonb)`,
      [pageId, JSON.stringify({ ...emptyFanslyMediaStatsCursorState(new Date()), longTailWindowMode: "split_31", longTailWindowAnnounced: true })],
    );
    const registry = await quietRegistry(pageId, true);
    await makeDue(pageId, true, "media-stats.walk");
    await drive(pageId, "shadow", registry, null, async () => (await workRow(pageId, "media-stats.walk", true))?.waiting_reason === "not_due");
    expect(await countRows(testDb.pool, "select count(*)::int as n from sync_attempts where page_id = $1 and shadow and resource = 'media-stats.walk'", [pageId]))
      .toBe(3);
    // The shadow's own mode stays unlearned: the legacy lane's stands in.
    expect((await workRow(pageId, "media-stats.walk", true))!.cursor).toMatchObject({ longTailWindowMode: "unproven" });
  });
});

// ── shadow ──────────────────────────────────────────────────────────────────

describe("shadow", () => {
  it("plans and paces the catalog and stats resources and writes nothing but its own work and attempts", async (context) => {
    if (!testDb) return context.skip();
    const { pageId } = await seedPage("shadow");
    await seedAlbum(pageId, "A1", 120, "M120");
    await seedMember(pageId, "A1", "O1");
    const registry = await quietRegistry(pageId, true);
    for (const key of ["catalog.fixed", "catalog.vault", "stats.daily", "stats.hourly"]) await makeDue(pageId, true, key);
    const before = await tableCounts(testDb.pool);
    await drive(pageId, "shadow", registry, null, async () =>
      (await workRow(pageId, "catalog.vault", true))?.waiting_reason === "not_due"
      && (await workRow(pageId, "catalog.hydrate", true))?.state === "done"
      && (await workRow(pageId, "stats.daily", true))?.cursor.last !== undefined
      && (await attempts(pageId, "stats.hourly", "outcome = 'shadow'")) === 1);
    const rows = await testDb.pool.query<{ resource: string; n: number }>(
      `select resource, count(*)::int as n from sync_attempts where page_id = $1 and shadow and outcome = 'shadow'
        group by 1 order by 1`,
      [pageId],
    );
    // Six fixed reads; 120 items at 50 a page ⇒ three pages and the empty
    // one; one hydration batch; the sweep — its two broadcast lists, not yet
    // read to their floors (no legacy walk to start from), three pages each;
    // one hourly capture.
    // The hydration is asked by the fixed sweep and by the finished album:
    // one batch each time it runs.
    const counts = Object.fromEntries(rows.rows.map((row) => [row.resource, row.n]));
    expect(counts).toMatchObject({ "catalog.fixed": 6, "catalog.vault": 4, "stats.daily": 15, "stats.hourly": 1 });
    expect(counts["catalog.hydrate"]).toBeGreaterThanOrEqual(1);
    expect(Object.keys(counts).sort()).toEqual(["catalog.fixed", "catalog.hydrate", "catalog.vault", "stats.daily", "stats.hourly"]);
    expect(await countRows(testDb.pool, "select count(*)::int as n from sync_attempts where page_id = $1 and not shadow", [pageId])).toBe(0);
    // Only the engine's own rows: the attempts, and the hydration the walk
    // asked for (a new shadow work row).
    expect(changedTables(before, await tableCounts(testDb.pool))).toEqual(["sync_attempts", "sync_work"]);
    expect(await observations(pageId)).toEqual([]);
    const vault = (await workRow(pageId, "catalog.vault", true))!;
    expect(vault.cursor).toMatchObject({ seeded: true, vaultWalk: { A1: { done: true, pages: 4 } } });
  });
});

// ── stats ───────────────────────────────────────────────────────────────────

function accountStats(afterMs: number, beforeMs: number, views = 3) {
  return { dataset: { dateAfter: afterMs, dateBefore: beforeMs, datapoints: [{ timestamp: afterMs, stats: [{ type: 0, views }] }], profileDatapoints: [] } };
}

function statsAnswer(req: FanslyWireRequest): FanslyWireOutcome {
  switch (req.spec) {
    case "account.stats": {
      const year = Number(query(req, "year") ?? 0);
      const month = Number(query(req, "month") ?? 0);
      if (year > 0) return okResponse(accountStats(Date.UTC(year, month - 1, 1), Date.UTC(year, month, 1) - DAY_MS));
      return okResponse(accountStats(Number(query(req, "afterDate")), Number(query(req, "beforeDate"))));
    }
    case "broadcast.stats":
    case "broadcast.stats_deleted":
      return okResponse({ messages: [], accountMedia: [] });
    case "trackinglinks":
      return okResponse({ trackingLinks: [] });
    case "discovery.suggestions":
      return okResponse({ mediaOffers: [] });
    default:
      return okResponse([]);
  }
}

describe("stats.daily", () => {
  it("runs the legacy sweep one read a step and claims the daily and earnings planes", async (context) => {
    if (!testDb) return context.skip();
    const { pageId } = await seedPage("live");
    const registry = await quietRegistry(pageId, false);
    await makeDue(pageId, false, "stats.daily");
    const { hits, requests } = await drive(pageId, "live", registry, statsAnswer,
      async () => (await attempts(pageId, "stats.daily")) === 11);
    expect(hits).toEqual([
      "account.stats", "earnings.stats_window", "earnings.monthly", "trackinglinks", "discovery.suggestions",
      "discovery.suggestions", "broadcast.stats", "broadcast.stats_deleted", "broadcast.scheduled", "polls", "recapstats",
    ]);
    expect(Number(query(requests[0]!, "period"))).toBe(DAY_MS);
    expect(Number(query(requests[0]!, "beforeDate")) - Number(query(requests[0]!, "afterDate"))).toBe(30 * DAY_MS);
    expect(requests.filter((req) => req.spec === "discovery.suggestions").map((req) => query(req, "offset"))).toEqual(["0", "10"]);
    expect((await observations(pageId)).map((row) => row.kind)).toEqual([
      "account_stats", "earnings_stats_snapshot", "earnings_monthlystats_snapshot", "tracking_links", "discovery_feed",
      "discovery_feed", "broadcast_stats", "broadcast_stats_deleted", "broadcast_scheduled", "polls", "recapstats",
    ]);
    expect(await coverage(pageId, "stats_account_daily", "steady")).toMatchObject({ status: "window_captured" });
    expect(await coverage(pageId, "stats_earnings", "steady")).toMatchObject({ status: "window_captured", reason_code: "trailing_window_captured" });
    const poll = (await workRow(pageId, "stats.daily"))!;
    expect(poll).toMatchObject({ state: "open", cursor: { stepIndex: 0, broadcasts: { live: { floorReached: true, stop: "empty_page" }, deleted: { floorReached: true } } } });
    expect(poll.due_at.getTime() - Date.now()).toBeGreaterThan(20 * HOUR_MS);
  });
});

describe("stats.hourly", () => {
  it("captures the trailing 25 hours, records a hole since the last capture for good, and is never planned past 23 h", async (context) => {
    if (!testDb) return context.skip();
    const { pageId } = await seedPage("live");
    const registry = await quietRegistry(pageId, false);
    await makeDue(pageId, false, "stats.hourly");
    await setCursor(pageId, "stats.hourly", {
      lastCapturedAt: new Date(Date.now() - 30 * HOUR_MS).toISOString(),
      lastServedBefore: new Date(Date.now() - 29 * HOUR_MS).toISOString(),
    });
    const { requests } = await drive(pageId, "live", registry, statsAnswer, async () => (await attempts(pageId, "stats.hourly")) === 1);
    expect(Number(query(requests[0]!, "period"))).toBe(HOUR_MS);
    expect(Number(query(requests[0]!, "beforeDate")) - Number(query(requests[0]!, "afterDate"))).toBe(25 * HOUR_MS);
    expect(await coverage(pageId, "stats_account_hourly", "steady")).toMatchObject({ status: "window_captured" });
    const scopes = await coverageScopes(pageId, "stats_account_hourly");
    expect(scopes).toHaveLength(2);
    const gap = await coverage(pageId, "stats_account_hourly", scopes.find((scope) => scope.startsWith("gap:"))!);
    expect(gap).toMatchObject({ status: "partial_provider_surface", reason_code: "hourly_capture_gap", cursor: { basis: "served", missingHours: 3 } });
    const poll = (await workRow(pageId, "stats.hourly"))!;
    expect(poll.due_at.getTime() - Date.now()).toBeLessThanOrEqual(23 * HOUR_MS);
    expect(poll.due_at.getTime() - Date.now()).toBeGreaterThan(19 * HOUR_MS);
  });
});

describe("stats.backfill", () => {
  it("walks the trailing window, the months down to the account's creation and the earnings to the same floor", async (context) => {
    if (!testDb) return context.skip();
    const { pageId } = await seedPage("live");
    const created = daysAgo(40);
    await testDb.pool.query("update pages set metadata = metadata || jsonb_build_object('accountCreatedAt', $2::text) where id = $1", [pageId, created.toISOString()]);
    const registry = await quietRegistry(pageId, false);
    await makeDue(pageId, false, "stats.backfill");
    const { requests } = await drive(pageId, "live", registry, statsAnswer, async () => (await workRow(pageId, "stats.backfill"))?.state === "done");
    const months = requests.filter((req) => query(req, "year") !== null).map((req) => `${query(req, "year")}-${query(req, "month")}`);
    const createdMonth = `${created.getUTCFullYear()}-${created.getUTCMonth() + 1}`;
    expect(months.at(-1)).toBe(createdMonth);
    expect(requests[0]!.spec).toBe("account.stats");
    expect(query(requests[0]!, "year")).toBe("0");
    expect(requests.filter((req) => req.spec === "earnings.stats_window").length).toBeGreaterThanOrEqual(1);
    expect(await coverage(pageId, "stats_account_daily")).toMatchObject({ status: "provider_exhausted", reason_code: "account_creation_floor" });
    expect(await coverage(pageId, "stats_account_hourly")).toMatchObject({ status: "partial_provider_surface", reason_code: "hourly_trailing_window_only" });
    expect(await coverage(pageId, "stats_earnings")).toMatchObject({ status: "provider_exhausted", reason_code: "account_creation_floor" });
    expect((await workRow(pageId, "stats.backfill"))!.close_reason).toBe("backfill_complete");
  });
});

// ── probe ───────────────────────────────────────────────────────────────────

describe("probe.manual", () => {
  it("the owner's probe on a shadow page is simulated: one shadow step, nothing sent or journaled", async (context) => {
    if (!testDb) return context.skip();
    const { pageId, label } = await seedPage("shadow");
    const registry = await quietRegistry(pageId, true);
    const queued = await requestSyncProbe(db(), registry, { pageLabel: label, operation: "polls", params: {}, requestedBy: "test" });
    expect(queued.shadow).toBe(true);
    await expect(requestSyncProbe(db(), registry, { pageLabel: label, operation: "polls", params: {}, requestedBy: "test" }))
      .rejects.toThrow(/already has a probe queued/);
    await drive(pageId, "shadow", registry, null, async () => (await workRow(pageId, "probe.manual", true))?.state === "done");
    expect((await workRow(pageId, "probe.manual", true))!.result).toMatchObject({ operation: "polls", shadow: true });
    expect(await observations(pageId)).toEqual([]);
  });

  it("on a switched page it is one admitted read journaled under the route's kind; a bad request is refused up front", async (context) => {
    if (!testDb) return context.skip();
    const { pageId, label } = await seedPage("live");
    const registry = await quietRegistry(pageId, false);
    await expect(requestSyncProbe(db(), registry, { pageLabel: label, operation: "media.offer_stats", params: { mediaOfferId: "1" }, requestedBy: "test" }))
      .rejects.toBeInstanceOf(SyncOwnerLeverError);
    const queued = await requestSyncProbe(db(), registry, { pageLabel: label, operation: "polls", params: {}, requestedBy: "test" });
    expect(queued.shadow).toBe(false);
    const { hits } = await drive(pageId, "live", registry, () => okResponse({ polls: [] }), async () => (await workRow(pageId, "probe.manual"))?.state === "done");
    expect(hits).toEqual(["polls"]);
    const journal = await observations(pageId);
    expect(journal.map((row) => [row.kind, row.producer])).toEqual([["polls", "fansly-sync:probe.manual"]]);
    expect((await workRow(pageId, "probe.manual"))!.result).toMatchObject({ operation: "polls", kind: "polls", observationId: journal[0]!.id });

    const off = await seedPage("off", "300000000000000009");
    await expect(requestSyncProbe(db(), registry, { pageLabel: off.label, operation: "polls", params: {}, requestedBy: "test" }))
      .rejects.toThrow(/is off/);
  });
});
