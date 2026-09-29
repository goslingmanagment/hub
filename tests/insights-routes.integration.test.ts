import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import {
  createFanslyPage,
  createModel,
  ensurePageSyncStates,
  upsertCaptureCoverage,
  upsertCreatorMedia,
  upsertCreatorVaultAlbum,
  upsertCreatorVaultAlbumMember,
  upsertPageAutomatedMessage,
  upsertPagePayoutMethod,
  upsertPagePayoutRequest,
  upsertPageSubscriptionTier,
  upsertPageSubscriptionTierPlan,
  upsertPageWall,
  upsertPlatformTagDaily,
  upsertPostComment,
  upsertRevenueMixDaily,
  upsertRevenueMonthTotal,
  upsertStatsTopMedia,
  upsertStatsTopTag,
  upsertStatsTrafficBucket,
} from "@agency_hub_core/db";

import { AGENT_DATASET_SQL } from "@agency_hub_core/db";
import { CAPTURE_COVERAGE_PLANES } from "@agency_hub_core/shared";

import { buildApiServer } from "../apps/runtime/src/api/server.ts";
import { createUserAccount } from "../apps/runtime/src/services/auth.ts";
import { startIntegrationTestDatabase, type StartedTestDatabase } from "./helpers/db.ts";
import { createTestAppContext } from "./helpers/runtime.ts";

// Fixture passwords hash at minimum cost; sign-in still runs the real argon2
// verify (tests/helpers/cheap-argon2.ts).
vi.mock("argon2", () => import("./helpers/cheap-argon2.ts"));

/**
 * WP-S1's eight serving routes against seeded projections.
 *
 * What these assertions are actually protecting, in the order the DoD names it:
 *
 *  * **Bounded.** Every list route caps at 500 and takes no offset. A request
 *    for more is a 400 at the schema, before a handler runs.
 *  * **NULL is not zero.** A metric the platform never served comes back
 *    `null`. `coalesce(views, 0)` on the read side would turn "we never
 *    measured this" into "nobody watched", and nothing downstream could tell.
 *  * **Raw code + label + mapping version.** The integer is the fact; the label
 *    is this build's reading of it (`fansly-notification-types.ts` documents a
 *    version that was wrong on eight of sixteen codes).
 *  * **NET is stored, GROSS is derived.** A12. The derived figure travels
 *    inside an envelope carrying `derived: true` and its basis, so it can never
 *    be mistaken for a served number or summed with one.
 *  * **No delivery address, anywhere.** The serialized body is grepped for
 *    `http` and `cdn`. Media are identified by REF, which is an id.
 *  * **Money is gated.** `/money/*` refuses a team lead and a chatter key.
 *
 * Docker (Testcontainers) — run serially:
 *   DOCKER_HOST=$HOME/.docker/run/docker.sock TESTCONTAINERS_RYUK_DISABLED=true
 */

let testDb: StartedTestDatabase | null = null;
let server: Awaited<ReturnType<typeof buildApiServer>> | null = null;
let ownerCookie = "";
let leadCookie = "";
let pageId = 0;

const PAGE = "lora-1";
const WINDOW_FROM = "2026-08-01T00:00:00Z";
const WINDOW_TO = "2026-09-01T00:00:00Z";
const OBSERVED_AT = new Date("2026-08-20T12:00:00.000Z");

function lineage(seq: number, observedAt = OBSERVED_AT) {
  return {
    observedAt,
    // 64 lowercase hex — the migrations CHECK the shape, so a readable
    // placeholder like `h000…` fails at the INSERT rather than in a review.
    contentHash: seq.toString(16).padStart(64, "0"),
    sourceEventId: seq,
    sourceObservationId: seq,
    sourceAccountSeq: seq,
  };
}

function sessionCookieFrom(response: {
  headers: Record<string, string | string[] | number | undefined>;
}) {
  const header = response.headers["set-cookie"];
  const value = Array.isArray(header) ? header[0] : header;
  if (!value || typeof value !== "string") {
    throw new Error("Expected set-cookie header");
  }
  return value.split(";")[0]!;
}

async function login(username: string, password: string) {
  const response = await server!.inject({
    method: "POST",
    url: "/api/v1/auth/login",
    payload: { username, password },
  });
  expect(response.statusCode).toBe(200);
  return sessionCookieFrom(response);
}

function get(url: string, cookie = ownerCookie) {
  return server!.inject({ method: "GET", url, headers: { cookie } });
}

beforeAll(async () => {
  testDb = await startIntegrationTestDatabase();
  if (!testDb) {
    return;
  }
  const context = createTestAppContext(testDb);

  await createUserAccount(context, {
    username: "owner",
    role: "owner",
    password: "owner-secret",
  }, { source: "cli" });
  await createUserAccount(context, {
    username: "lead",
    role: "team_lead",
    password: "lead-secret",
  }, { source: "cli" });

  const model = await createModel(testDb.db, { slug: "lora", name: "Lora" });
  const page = await createFanslyPage(testDb.db, { modelId: model!.id, label: PAGE });
  pageId = page!.id;
  const db = testDb.db;
  // Production reality: every active page carries a `page_sync_states` row per
  // stream, seeded by the planner. The coverage panel reads those rows for the
  // per-lane gate and budget state, so the test seeds them the same way.
  await ensurePageSyncStates(db, { pageId });

  // ── traffic: the four profile families, both members, plus an unknown code ──
  // 44011 carries views with interactionTime 0 (member 1 is the UI counter);
  // 44010 is its dwell twin. `uniqueViewers` is deliberately NULL on one row so
  // the "null is not zero" assertion has something to fail on.
  const trafficRows = [
    { code: "10001", views: 3647, interaction: 0, unique: 120 },
    { code: "10000", views: 2485, interaction: 59_564_731, unique: null },
    { code: "44011", views: 42, interaction: 0, unique: 12 },
    { code: "44010", views: 34, interaction: 1_385_136, unique: 9 },
    // A member of a KNOWN family that this label version has never seen. It must
    // read `unknown:10002`, not be absorbed into `direct_timeline`.
    { code: "10002", views: 7, interaction: 5, unique: null },
  ];
  let seq = 1;
  for (const row of trafficRows) {
    await upsertStatsTrafficBucket(db, {
      pageId,
      platform: "fansly",
      subjectKind: "account_profile",
      subjectRef: "",
      periodMs: 86_400_000,
      bucketStart: new Date("2026-08-10T00:00:00.000Z"),
      sourceCode: row.code,
      mappingVersion: 2,
      views: row.views,
      previewViews: null,
      uniqueViewers: row.unique,
      previewUniqueViewers: null,
      videoViews: null,
      previewVideoViews: null,
      interactionTimeMs: row.interaction,
      previewInteractionTimeMs: null,
      videoPercentWatchedSum: null,
      previewVideoPercentWatchedSum: null,
      requestedStart: null,
      requestedEnd: null,
      ...lineage(seq++),
    });
  }

  // ── one media, its per-media buckets, and A12's exact arithmetic ────────────
  // 16 792 net × 1.25 = 20 990 = 1 × $20.99. The derived gross must land on it.
  await upsertCreatorMedia(db, {
    pageId,
    platform: "fansly",
    mediaOfferRef: "media-1",
    mediaRef: "raw-1",
    previewRef: null,
    bundleRefs: [],
    mediaType: 2,
    mimeType: "video/mp4",
    width: 1080,
    height: 1920,
    durationMs: 30_000,
    priceMills: 20_990n,
    permissionEntries: [],
    permissionFlags: null,
    likeCount: 4,
    salesCount: 1,
    salesNetMills: 16_792n,
    salesPendingMills: null,
    createdAtPlatform: new Date("2026-08-05T00:00:00.000Z"),
    deletedAtPlatform: null,
    firstOrigin: "stats_agg",
    ...lineage(seq++, new Date("2026-08-19T12:00:00.000Z")),
  });
  // A second media with NO sale stats at all: `saleStats` was null on 83 of 85
  // live rows, so the null path is the common one and must not become zero.
  await upsertCreatorMedia(db, {
    pageId,
    platform: "fansly",
    mediaOfferRef: "media-2",
    mediaRef: null,
    previewRef: null,
    bundleRefs: [],
    mediaType: 1,
    mimeType: "image/jpeg",
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
    createdAtPlatform: null,
    deletedAtPlatform: null,
    firstOrigin: "stats_agg",
    ...lineage(seq++, new Date("2026-08-21T12:00:00.000Z")),
  });
  for (const code of ["0", "1"]) {
    await upsertStatsTrafficBucket(db, {
      pageId,
      platform: "fansly",
      subjectKind: "media_offer",
      subjectRef: "media-1",
      periodMs: 86_400_000,
      bucketStart: new Date("2026-08-10T00:00:00.000Z"),
      sourceCode: code,
      mappingVersion: 2,
      views: code === "0" ? 500 : 120,
      previewViews: 40,
      uniqueViewers: null,
      previewUniqueViewers: null,
      // [E5]: the per-media route serves NO video fields, for a video asset.
      videoViews: null,
      previewVideoViews: null,
      interactionTimeMs: 12_000,
      previewInteractionTimeMs: null,
      videoPercentWatchedSum: null,
      previewVideoPercentWatchedSum: null,
      requestedStart: null,
      requestedEnd: null,
      ...lineage(seq++),
    });
  }

  await upsertStatsTrafficBucket(db, {
    pageId,
    platform: "fansly",
    subjectKind: "media_offer",
    subjectRef: "media-2",
    periodMs: 86_400_000,
    bucketStart: new Date("2026-08-11T00:00:00.000Z"),
    sourceCode: "0",
    mappingVersion: 2,
    views: 80,
    previewViews: null,
    uniqueViewers: null,
    previewUniqueViewers: null,
    videoViews: null,
    previewVideoViews: null,
    interactionTimeMs: null,
    previewInteractionTimeMs: null,
    videoPercentWatchedSum: null,
    previewVideoPercentWatchedSum: null,
    requestedStart: null,
    requestedEnd: null,
    ...lineage(seq++),
  });

  // An older ranking window must not be mixed into the current one. Its media
  // is intentionally the newest catalogue head, so ordering and window
  // selection are independently observable in the route tests below.
  await upsertStatsTopMedia(db, {
    pageId,
    platform: "fansly",
    plane: "top_fyp_media",
    periodMs: 86_400_000,
    requestedStart: new Date("2026-07-20T00:00:00.000Z"),
    requestedEnd: new Date("2026-08-15T00:00:00.000Z"),
    mediaOfferRef: "media-2",
    bundleRef: null,
    rank: 1,
    views: 80,
    previewViews: null,
    interactionTimeMs: null,
    previewInteractionTimeMs: null,
    ...lineage(seq++),
  });

  await upsertStatsTopMedia(db, {
    pageId,
    platform: "fansly",
    plane: "top_fyp_media",
    periodMs: 86_400_000,
    requestedStart: new Date("2026-08-01T00:00:00.000Z"),
    requestedEnd: new Date("2026-08-20T00:00:00.000Z"),
    mediaOfferRef: "media-1",
    bundleRef: null,
    rank: 1,
    views: 500,
    previewViews: 40,
    interactionTimeMs: 12_000,
    previewInteractionTimeMs: null,
    ...lineage(seq++),
  });

  await upsertStatsTopTag(db, {
    pageId,
    platform: "fansly",
    plane: "top_fyp_tags",
    periodMs: 86_400_000,
    requestedStart: new Date("2026-08-01T00:00:00.000Z"),
    requestedEnd: new Date("2026-08-20T00:00:00.000Z"),
    tagRef: "tag-1",
    tagName: "cosplay",
    rank: 1,
    views: 900,
    previewViews: null,
    interactionTimeMs: null,
    previewInteractionTimeMs: null,
    ...lineage(seq++),
  });
  // The tag whose `tags[]` join MISSED. `tagName` must stay null on the wire —
  // fabricating it from the id is the failure this row exists to catch.
  await upsertStatsTopTag(db, {
    pageId,
    platform: "fansly",
    plane: "top_fyp_tags",
    periodMs: 86_400_000,
    requestedStart: new Date("2026-08-01T00:00:00.000Z"),
    requestedEnd: new Date("2026-08-20T00:00:00.000Z"),
    tagRef: "tag-2",
    tagName: null,
    rank: 2,
    views: 100,
    previewViews: null,
    interactionTimeMs: null,
    previewInteractionTimeMs: null,
    ...lineage(seq++),
  });
  await upsertPlatformTagDaily(db, {
    pageId,
    platform: "fansly",
    tagRef: "tag-1",
    businessDate: "2026-08-10",
    tagName: "cosplay",
    viewCount: 1_000_000,
    postCount: 4_000,
    tagCreatedAt: null,
    source: "stats_agg",
    capturedAt: OBSERVED_AT,
    ...lineage(seq++),
  });

  // ── coverage, one plane per lane ───────────────────────────────────────────
  await upsertCaptureCoverage(db, {
    pageId,
    platform: "fansly",
    plane: CAPTURE_COVERAGE_PLANES.statsAccountDaily,
    scopeRef: "account_profile",
    status: "window_captured",
    acquisitionMode: "retroactive",
    proof: "terminal_response",
    // A proof that is not `none` must NAME the journaled response that proves
    // it — the migration's CHECK, not a convention.
    proofObservationId: 1,
    oldestCapturedAt: new Date("2026-07-20T00:00:00.000Z"),
    newestCapturedAt: OBSERVED_AT,
  });
  await upsertCaptureCoverage(db, {
    pageId,
    platform: "fansly",
    plane: "post_replies",
    scopeRef: "page",
    status: "in_progress",
    acquisitionMode: "forward_only",
    proof: "none",
    expectedCount: 100,
    observedUniqueCount: 40,
  });

  // ── comments: one ordinary, one flagged possibly-truncated ─────────────────
  await upsertPostComment(db, {
    pageId,
    platform: "fansly",
    commentRef: "c-1",
    parentPostRef: "post-1",
    rootPostRef: "post-1",
    authorRef: "fan-1",
    authorUsername: "fanone",
    authorDisplayName: "Fan One",
    textPlain: "love this",
    likeCount: 2,
    mediaLikeCount: null,
    tipTotalMills: 5_000n,
    attachmentTipMills: null,
    attachmentCount: 0,
    pinned: false,
    occurredAt: new Date("2026-08-11T10:00:00.000Z"),
    discoveredVia: "replies_walk",
    possiblyTruncated: false,
    ...lineage(seq++),
  });
  // An EMPTY reply. A fan who replied with only an attachment still replied,
  // and `''` must survive to the wire as a comment rather than as a null.
  await upsertPostComment(db, {
    pageId,
    platform: "fansly",
    commentRef: "c-2",
    parentPostRef: "post-1",
    rootPostRef: "post-1",
    authorRef: "fan-2",
    authorUsername: null,
    authorDisplayName: null,
    textPlain: "",
    likeCount: null,
    mediaLikeCount: null,
    tipTotalMills: null,
    attachmentTipMills: null,
    attachmentCount: 1,
    pinned: null,
    occurredAt: new Date("2026-08-12T10:00:00.000Z"),
    discoveredVia: "replies_walk",
    possiblyTruncated: true,
    ...lineage(seq++),
  });

  // ── money: a legacy code, its current twin, and the (0,0) rollup row ────────
  await upsertRevenueMixDaily(db, {
    pageId,
    platform: "fansly",
    businessDate: "2026-08-10",
    typeCode: 2010,
    grossMills: 10_000n,
    netMills: 8_000n,
    correlationAccountRef: null,
    ...lineage(seq++),
  });
  await upsertRevenueMixDaily(db, {
    pageId,
    platform: "fansly",
    businessDate: "2026-08-10",
    typeCode: 2110,
    grossMills: 20_000n,
    netMills: 16_000n,
    correlationAccountRef: null,
    ...lineage(seq++),
  });
  // A code no label version names. It must read `unmapped:99999` and still be
  // served — dropping it would understate the month.
  await upsertRevenueMixDaily(db, {
    pageId,
    platform: "fansly",
    businessDate: "2026-08-11",
    typeCode: 99_999,
    grossMills: null,
    netMills: 500n,
    correlationAccountRef: null,
    ...lineage(seq++),
  });
  await upsertRevenueMonthTotal(db, {
    pageId,
    platform: "fansly",
    year: 2026,
    month: 8,
    totalGrossMills: 30_000n,
    totalNetMills: 24_000n,
    topPercent: null,
    maxTopPercent: null,
    windowStart: null,
    windowEnd: null,
    servedExtras: {},
    ...lineage(seq++),
  });
  await upsertRevenueMonthTotal(db, {
    pageId,
    platform: "fansly",
    year: 0,
    month: 0,
    totalGrossMills: 900_000n,
    totalNetMills: 720_000n,
    topPercent: null,
    maxTopPercent: null,
    windowStart: null,
    windowEnd: null,
    servedExtras: {},
    ...lineage(seq++),
  });

  await upsertPagePayoutMethod(db, {
    pageId,
    platform: "fansly",
    methodRef: "method-1",
    providerId: 2,
    providerLabel: "paxum",
    type: 1,
    flags: 0,
    status: 1,
    maskedLabel: "l***@example.com",
    metadataParseOk: true,
    ...lineage(seq++),
  });
  await upsertPagePayoutRequest(db, {
    pageId,
    platform: "fansly",
    payoutRef: "payout-1",
    amountMills: 1_234_000n,
    methodRef: "method-1",
    statusCode: 8,
    statusLabel: "Processed",
    statusConfidence: "mapped",
    requestedAt: new Date("2026-08-15T00:00:00.000Z"),
    updatedAtPlatform: null,
    version: 1,
    ...lineage(seq++),
  });

  // ── catalogue sidecars ─────────────────────────────────────────────────────
  await upsertCreatorVaultAlbum(db, {
    pageId,
    platform: "fansly",
    vaultKind: "creator",
    albumRef: "album-1",
    ownerAccountRef: null,
    title: "All",
    description: null,
    albumType: 38_000,
    status: 1,
    pos: 0,
    itemCount: 2,
    lastItemRef: null,
    thumbnailRef: null,
    public: 0,
    version: 1,
    createdAtPlatform: null,
    ...lineage(seq++),
  });
  for (const ref of ["media-1", "media-2"]) {
    await upsertCreatorVaultAlbumMember(db, {
      pageId,
      platform: "fansly",
      albumRef: "album-1",
      mediaOfferRef: ref,
      memberRef: `member-${ref}`,
      mediaOfferType: 1,
      bundleRef: null,
      mediaRef: `raw-${ref}`,
      mediaType: 1,
      previewRef: null,
      vaultKind: "creator",
      createdAtPlatform: null,
      ...lineage(seq++),
    });
  }
  await upsertPageSubscriptionTier(db, {
    pageId,
    platform: "fansly",
    tierRef: "tier-1",
    name: "VIP",
    color: "#fff",
    pos: 0,
    basePriceMills: 5_000n,
    maxSubscribers: null,
    subscriptionBenefits: [],
    includedTierRefs: [],
    plans: [],
    ...lineage(seq++),
  });
  await upsertPageSubscriptionTierPlan(db, {
    pageId,
    platform: "fansly",
    tierRef: "tier-1",
    planRef: "plan-1",
    status: 1,
    durationDays: 30,
    priceMills: 14_990n,
    useAmounts: null,
    promos: [],
    ...lineage(seq++),
  });
  await upsertPageWall(db, {
    pageId,
    platform: "fansly",
    wallRef: "wall-1",
    name: "Main",
    description: null,
    pos: 0,
    mainWall: true,
    defaultWall: true,
    private: 0,
    metadata: {},
    ...lineage(seq++),
  });
  await upsertPageAutomatedMessage(db, {
    pageId,
    platform: "fansly",
    automationRef: "auto-1",
    triggerType: 3,
    triggerMetadata: {},
    delaySeconds: 60,
    cooldownSeconds: null,
    templateType: 1,
    senderRef: null,
    messageText: "welcome",
    attachmentRefs: [{ contentType: 1, contentId: "media-1" }],
    parseOk: true,
    ...lineage(seq),
  });

  server = await buildApiServer(createTestAppContext(testDb, {
    authPolicyEnforcement: "enforce",
  }));
  ownerCookie = await login("owner", "owner-secret");
  leadCookie = await login("lead", "lead-secret");
}, 180_000);

afterAll(async () => {
  await server?.close();
  await testDb?.stop();
});

function requireServer(context: { skip: () => void }) {
  if (!server || !testDb) {
    context.skip();
    return false;
  }
  return true;
}

describe("WP-S1 serving routes: traffic", () => {
  it("serves RAW code + label + mapping version, and never coalesces a null", async (context) => {
    if (!requireServer(context)) return;
    const response = await get(
      `/api/v1/pages/${PAGE}/stats/traffic?from=${WINDOW_FROM}&to=${WINDOW_TO}`,
    );
    expect(response.statusCode).toBe(200);
    const body = response.json();
    const byCode = new Map<string, Record<string, unknown>>(
      body.rows.map((row: Record<string, unknown>) => [String(row.sourceCode), row]),
    );

    const suggestionsVisits = byCode.get("44011")!;
    expect(suggestionsVisits.sourceCode).toBe("44011");
    expect(suggestionsVisits.sourceLabel).toBe("suggestions_visits");
    expect(suggestionsVisits.familyLabel).toBe("suggestions");
    expect(suggestionsVisits.family).toBe("44010");
    expect(suggestionsVisits.measure).toBe("visits");
    expect(suggestionsVisits.mappingVersion).toBe(2);

    // Member 0 is the DWELL series with its own, differing view count. Its
    // meaning beyond "dwell" is unproven and the label says nothing more.
    expect(byCode.get("44010")!.measure).toBe("dwell");
    expect(byCode.get("44010")!.sourceLabel).toBe("suggestions_dwell");

    // The guard order is the point: a new member of a KNOWN family must not be
    // absorbed into that family's label.
    const unknown = byCode.get("10002")!;
    expect(unknown.sourceLabel).toBe("unknown:10002");
    expect(unknown.familyLabel).toBeNull();
    expect(unknown.measure).toBeNull();

    // NULL IS NOT ZERO.
    expect(byCode.get("10000")!.uniqueViewers).toBeNull();
    expect(byCode.get("10001")!.uniqueViewers).toBe(120);
    // Member 1's interaction time really is 0 on the wire — a served zero, and
    // a different fact from the null above.
    expect(byCode.get("10001")!.interactionTimeMs).toBe(0);
  });

  it("bounds the limit at 500 and mints a spendable cursor", async (context) => {
    if (!requireServer(context)) return;
    const overLimit = await get(
      `/api/v1/pages/${PAGE}/stats/traffic?from=${WINDOW_FROM}&to=${WINDOW_TO}&limit=501`,
    );
    expect(overLimit.statusCode).toBe(400);

    const firstPage = await get(
      `/api/v1/pages/${PAGE}/stats/traffic?from=${WINDOW_FROM}&to=${WINDOW_TO}&limit=2`,
    );
    expect(firstPage.statusCode).toBe(200);
    const first = firstPage.json();
    expect(first.rows).toHaveLength(2);
    expect(first.nextCursor).toBeTypeOf("string");

    const secondPage = await get(
      `/api/v1/pages/${PAGE}/stats/traffic?from=${WINDOW_FROM}&to=${WINDOW_TO}`
      + `&limit=2&cursor=${encodeURIComponent(first.nextCursor)}`,
    );
    expect(secondPage.statusCode).toBe(200);
    const second = secondPage.json();
    const firstKeys = first.rows.map((row: { sourceCode: string }) => row.sourceCode);
    const secondKeys = second.rows.map((row: { sourceCode: string }) => row.sourceCode);
    // A keyset cursor never repeats a row it already delivered.
    expect(secondKeys.some((key: string) => firstKeys.includes(key))).toBe(false);
  });

  it("refuses an inverted window instead of answering empty", async (context) => {
    if (!requireServer(context)) return;
    const response = await get(
      `/api/v1/pages/${PAGE}/stats/traffic?from=${WINDOW_TO}&to=${WINDOW_FROM}`,
    );
    // An empty answer to a nonsense window is indistinguishable from an empty
    // answer to a real one, and that is the original incident.
    expect(response.statusCode).toBe(400);
  });
});

describe("WP-S1 serving routes: media, tags and coverage", () => {
  it("derives gross from NET and labels it, leaving an unserved sale null", async (context) => {
    if (!requireServer(context)) return;
    const response = await get(
      `/api/v1/pages/${PAGE}/stats/media?from=${WINDOW_FROM}&to=${WINDOW_TO}`,
    );
    expect(response.statusCode).toBe(200);
    const body = response.json();
    const media = new Map<string, Record<string, never>>(
      body.media.map((row: { mediaOfferRef: string }) => [row.mediaOfferRef, row]),
    );

    const sold = media.get("media-1")! as unknown as {
      sales: {
        count: number | null;
        netMills: number | null;
        grossMills: { value: number; derived: boolean; basis: string } | null;
      };
      buckets: { sourceCode: string; sourceLabel: string; videoViews: number | null }[];
    };
    // A12's own arithmetic: 16 792 × 1.25 = 20 990 = 1 × $20.99, exactly.
    expect(sold.sales.netMills).toBe(16_792);
    expect(sold.sales.grossMills?.value).toBe(20_990);
    expect(sold.sales.grossMills?.derived).toBe(true);
    expect(sold.sales.grossMills?.basis).toContain("A12");

    // 83 of 85 live media carried no `saleStats` at all. Null in, null out.
    const unsold = media.get("media-2")! as unknown as {
      sales: { count: number | null; netMills: number | null; grossMills: unknown };
    };
    expect(unsold.sales.netMills).toBeNull();
    expect(unsold.sales.count).toBeNull();
    expect(unsold.sales.grossMills).toBeNull();

    // The 0/1 media codes get the MEDIA vocabulary, not the profile one.
    const labels = sold.buckets.map((bucket) => bucket.sourceLabel).sort();
    expect(labels).toEqual(["direct", "fyp"]);
    // [E5]: no per-media watch metric is claimed, and the response says so
    // rather than leaving a reader to infer it from nulls.
    expect(body.watchMetrics).toEqual({
      perMediaAvailable: false,
      reason: "not_served_per_media_e5",
    });
    for (const bucket of sold.buckets) {
      expect(bucket.videoViews).toBeNull();
    }
    expect(body.bucketsTruncated).toBe(false);
  });

  it("reports bucket truncation instead of silently trimming", async (context) => {
    if (!requireServer(context)) return;
    const response = await get(
      `/api/v1/pages/${PAGE}/stats/media?from=${WINDOW_FROM}&to=${WINDOW_TO}&bucketLimit=1`,
    );
    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.bucketsTruncated).toBe(true);
  });

  it("starts from the newest catalogue heads and still unions the ranked media", async (context) => {
    if (!requireServer(context)) return;
    const response = await get(
      `/api/v1/pages/${PAGE}/stats/media?from=${WINDOW_FROM}&to=${WINDOW_TO}&limit=1`,
    );
    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.media.map((row: { mediaOfferRef: string }) => row.mediaOfferRef)).toEqual([
      "media-2",
      "media-1",
    ]);
    expect(body.top.map((row: { mediaOfferRef: string }) => row.mediaOfferRef)).toEqual([
      "media-1",
    ]);
  });

  it("shares a tight bucket budget fairly between displayed media", async (context) => {
    if (!requireServer(context)) return;
    const response = await get(
      `/api/v1/pages/${PAGE}/stats/media?from=${WINDOW_FROM}&to=${WINDOW_TO}`
      + "&limit=2&bucketLimit=2",
    );
    expect(response.statusCode).toBe(200);
    const body = response.json();
    const bucketCounts = new Map<string, number>(body.media.map((row: {
      mediaOfferRef: string;
      buckets: unknown[];
    }) => [row.mediaOfferRef, row.buckets.length]));
    expect(bucketCounts.get("media-1")).toBe(1);
    expect(bucketCounts.get("media-2")).toBe(1);
    expect(body.bucketsTruncated).toBe(true);
  });

  it("never fabricates a tag name the join missed", async (context) => {
    if (!requireServer(context)) return;
    const response = await get(
      `/api/v1/pages/${PAGE}/stats/tags?from=${WINDOW_FROM}&to=${WINDOW_TO}`,
    );
    expect(response.statusCode).toBe(200);
    const body = response.json();
    const tags = new Map<string, { tagName: string | null }>(
      body.topTags.map((row: { tagRef: string }) => [row.tagRef, row]),
    );
    expect(tags.get("tag-1")!.tagName).toBe("cosplay");
    expect(tags.get("tag-2")!.tagName).toBeNull();
    expect(body.platformTags).toHaveLength(1);
    expect(body.platformTags[0].viewCount).toBe(1_000_000);
  });

  it("the honesty panel's data: floors, lane gates and the live cycle field", async (context) => {
    if (!requireServer(context)) return;
    const response = await get(`/api/v1/pages/${PAGE}/stats/coverage`);
    expect(response.statusCode).toBe(200);
    const body = response.json();

    const planes = new Map<string, { status: string; proof: string }>(
      body.planes.map((row: { plane: string }) => [row.plane, row]),
    );
    expect(planes.get(CAPTURE_COVERAGE_PLANES.statsAccountDaily)!.status).toBe("window_captured");
    expect(planes.get("post_replies")!.proof).toBe("none");

    // Every Fansly lane reports its gate. The flags default OFF, so this page
    // reads `flagEnabled: false` — which is the fact the panel must show
    // instead of an empty chart with no explanation.
    const streams = new Map<string, { flagEnabled: boolean | null; allowlisted: boolean | null }>(
      body.streams.map((row: { stream: string }) => [row.stream, row]),
    );
    expect(streams.get("media_stats")!.flagEnabled).toBe(false);
    // FAIL-CLOSED: an empty allowlist means NO pages on these lanes.
    expect(streams.get("media_stats")!.allowlisted).toBe(false);
    // A lane with no ramp gate of its own reports null rather than "enabled".
    expect(streams.get("light")!.flagEnabled).toBeNull();
    // The shared Stage 16 gate does not become a new coverage-panel field.
    for (const legacy of ["fan_earnings", "purchase_history"]) {
      expect(streams.get(legacy)).toMatchObject({ flagEnabled: null, allowlisted: null });
    }
    // The A16 item 3 field exists on the wire even before the lane has run: a
    // missing field and an unrun lane would look the same to the panel.
    expect(streams.get("media_stats")!).toHaveProperty("progress");

    const holdings = new Map<string, { rowCount: number }>(
      body.holdings.map((row: { projection: string }) => [row.projection, row]),
    );
    expect(holdings.get("stats_traffic_buckets")!.rowCount).toBe(8);
    // The liker table is EMPTY on Fansly ([E4]) and the honest report of that is
    // a zero count, not a missing row.
    expect(holdings.get("post_likes")!.rowCount).toBe(0);
  });
});

describe("WP-S1 serving routes: content", () => {
  it("serves the catalogue with M and the number M is not", async (context) => {
    if (!requireServer(context)) return;
    const response = await get(`/api/v1/pages/${PAGE}/content/media`);
    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.media).toHaveLength(2);
    expect(body.vaultAlbums).toHaveLength(1);
    expect(body.tiers[0].plans[0].priceMills).toBe(14_990);
    // The tier head's price is a BASE, never the price a subscriber pays.
    expect(body.tiers[0].basePriceMills).toBe(5_000);
    expect(body.walls).toHaveLength(1);
    expect(body.automations[0].attachmentCount).toBe(1);
    expect(body.inventory.uniqueMediaCount).toBe(2);
    // Σ item_count DOUBLE-COUNTS (the system albums are views over the same
    // media), so it travels as a derived figure carrying that warning.
    expect(body.inventory.albumMembershipSum.derived).toBe(true);
    expect(body.inventory.albumMembershipSum.basis).toContain("NON-UNIQUE");
  });

  it("keeps the empty reply, the truncation doubt, and the empty liker panel", async (context) => {
    if (!requireServer(context)) return;
    const response = await get(
      `/api/v1/pages/${PAGE}/content/comments?from=${WINDOW_FROM}&to=${WINDOW_TO}`,
    );
    expect(response.statusCode).toBe(200);
    const body = response.json();
    const comments = new Map<string, { textPlain: string; possiblyTruncated: boolean }>(
      body.comments.map((row: { commentRef: string }) => [row.commentRef, row]),
    );
    // A fan who replied with only an attachment still replied.
    expect(comments.get("c-2")!.textPlain).toBe("");
    expect(comments.get("c-2")!.possiblyTruncated).toBe(true);
    expect(comments.get("c-1")!.possiblyTruncated).toBe(false);

    const perPost = body.perPost.find((row: { postRef: string }) => row.postRef === "post-1");
    expect(perPost.commentCount).toBe(2);
    expect(perPost.possiblyTruncatedCount).toBe(1);

    // Declared, not omitted: an omitted panel and an empty one are the same
    // thing to a reader, which is the confusion this plane exists to remove.
    expect(body.likers.state).toBe("not_started");
    expect(body.likers.reason).toBe("no_confirmed_like_code_e4");
    expect(body.likers.rows).toEqual([]);
  });
});

describe("WP-S1 serving routes: money", () => {
  it("serves raw type codes with labels and flags the rollup row", async (context) => {
    if (!requireServer(context)) return;
    const response = await get(
      `/api/v1/pages/${PAGE}/money/revenue-mix?from=2026-08-01&to=2026-08-31`,
    );
    expect(response.statusCode).toBe(200);
    const body = response.json();
    const daily = new Map<number, { typeLabel: string; typeEra: string | null; netMills: number | null; grossMills: number | null }>(
      body.daily.map((row: { typeCode: number }) => [row.typeCode, row]),
    );
    // ONE visible label, TWO live codes. Grouping by label merges legacy into
    // current; grouping by code keeps them apart. Both are on the wire.
    expect(daily.get(2010)!.typeLabel).toBe("media");
    expect(daily.get(2010)!.typeEra).toBe("legacy");
    expect(daily.get(2110)!.typeLabel).toBe("media");
    expect(daily.get(2110)!.typeEra).toBe("current");
    // An unnamed code is SERVED, not dropped — dropping it understates the month.
    expect(daily.get(99_999)!.typeLabel).toBe("unmapped:99999");
    expect(daily.get(99_999)!.typeEra).toBeNull();
    expect(daily.get(99_999)!.grossMills).toBeNull();
    expect(body.daily[0].mappingVersion).toBe(1);

    const months = body.months as { year: number; month: number; rollup: boolean }[];
    expect(months.find((row) => row.year === 0 && row.month === 0)!.rollup).toBe(true);
    expect(months.find((row) => row.year === 2026 && row.month === 8)!.rollup).toBe(false);
  });

  it("serves masked payout methods and never the processor payload", async (context) => {
    if (!requireServer(context)) return;
    const response = await get(`/api/v1/pages/${PAGE}/money/payouts`);
    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.requests[0].amountMills).toBe(1_234_000);
    expect(body.requests[0].statusCode).toBe(8);
    expect(body.requests[0].statusConfidence).toBe("mapped");
    expect(body.methods[0].maskedLabel).toBe("l***@example.com");
    // The full address never leaves the journal: the `metadata` COLUMN is not
    // selected at all, and `masked_label` is the only value derived from it
    // that a projection ever holds. (`metadataParseOk` is a boolean about the
    // parse, not the payload — hence the key check rather than a substring.)
    expect(Object.keys(body.methods[0])).not.toContain("metadata");
  });

  it("money is gated: a team lead is refused on BOTH money routes", async (context) => {
    if (!requireServer(context)) return;
    // `owner-session` IS the money scope on the REST surface. A team lead can
    // read the existing revenue routes and must not read these.
    for (const url of [
      `/api/v1/pages/${PAGE}/money/revenue-mix?from=2026-08-01&to=2026-08-31`,
      `/api/v1/pages/${PAGE}/money/payouts`,
    ]) {
      const asLead = await get(url, leadCookie);
      expect(asLead.statusCode, url).toBe(403);
      const anonymous = await server!.inject({ method: "GET", url });
      expect(anonymous.statusCode, url).toBe(401);
    }
  });

  it("every route refuses a team lead — the whole surface is owner-only today", async (context) => {
    if (!requireServer(context)) return;
    for (const url of [
      `/api/v1/pages/${PAGE}/stats/traffic?from=${WINDOW_FROM}&to=${WINDOW_TO}`,
      `/api/v1/pages/${PAGE}/stats/media?from=${WINDOW_FROM}&to=${WINDOW_TO}`,
      `/api/v1/pages/${PAGE}/stats/tags?from=${WINDOW_FROM}&to=${WINDOW_TO}`,
      `/api/v1/pages/${PAGE}/stats/coverage`,
      `/api/v1/pages/${PAGE}/content/media`,
      `/api/v1/pages/${PAGE}/content/comments?from=${WINDOW_FROM}&to=${WINDOW_TO}`,
    ]) {
      const response = await get(url, leadCookie);
      expect(response.statusCode, url).toBe(403);
    }
  });
});

describe("WP-S1 serving routes: no delivery address leaves the kernel", () => {
  it("no response body contains an http or cdn string", async (context) => {
    if (!requireServer(context)) return;
    // A grep rather than a field-by-field check, on purpose: the rule is about
    // the WHOLE body, and a new field added a year from now is exactly what a
    // per-field assertion would miss. Media travel as REFS, which are ids.
    for (const url of [
      `/api/v1/pages/${PAGE}/stats/traffic?from=${WINDOW_FROM}&to=${WINDOW_TO}`,
      `/api/v1/pages/${PAGE}/stats/media?from=${WINDOW_FROM}&to=${WINDOW_TO}`,
      `/api/v1/pages/${PAGE}/stats/tags?from=${WINDOW_FROM}&to=${WINDOW_TO}`,
      `/api/v1/pages/${PAGE}/stats/coverage`,
      `/api/v1/pages/${PAGE}/content/media`,
      `/api/v1/pages/${PAGE}/content/comments?from=${WINDOW_FROM}&to=${WINDOW_TO}`,
      `/api/v1/pages/${PAGE}/money/revenue-mix?from=2026-08-01&to=2026-08-31`,
      `/api/v1/pages/${PAGE}/money/payouts`,
    ]) {
      const response = await get(url);
      expect(response.statusCode, url).toBe(200);
      const serialized = JSON.stringify(response.json()).toLowerCase();
      expect(serialized.includes("http"), url).toBe(false);
      expect(serialized.includes("cdn"), url).toBe(false);
      // And no raw provider JSON: the permission arrays, promo arrays and
      // trigger metadata stay behind on the governed journal surface.
      expect(serialized.includes("permissionentries"), url).toBe(false);
      expect(serialized.includes("triggermetadata"), url).toBe(false);
    }
  });
});

describe("WP-S1 agent datasets: the generated SQL runs and labels what it reads", () => {
  const s1Datasets = [
    "traffic_daily",
    "media_stats",
    "top_media",
    "top_tags",
    "revenue_mix",
    "message_media_sales",
    "comments",
    "likes",
    "vault_media",
    "notifications",
    "subscription_tiers",
    "payouts",
    "capture_coverage",
  ] as const;

  it("every source projection executes and exposes its whole internal vocabulary", async (context) => {
    if (!requireServer(context)) return;
    // The two-way registry test proves the field maps AGREE; only a database can
    // prove the SQL PARSES. The label expressions here are generated from the
    // shared code tables, and a generated `case` with one wrong cast is invisible
    // until a statement runs.
    for (const dataset of s1Datasets) {
      const mapping = AGENT_DATASET_SQL[dataset]!;
      const result = await testDb!.pool.query(
        `with src as (${mapping.source}) select * from src where src.k_page_id = $1 limit 5`,
        [pageId],
      );
      const columns = new Set(result.fields.map((field) => field.name));
      for (const internal of ["k_page_id", "k_platform", "k_key", "k_occurred_at", "k_fan"]) {
        expect(columns.has(internal), `${dataset}.${internal}`).toBe(true);
      }
      for (const column of Object.values(mapping.fields)) {
        expect(columns.has(column), `${dataset}.${column}`).toBe(true);
      }
    }
  });

  it("labels the traffic codes exactly as the REST layer does", async (context) => {
    if (!requireServer(context)) return;
    // ONE label table, TWO readers (the dataset SQL and the REST mapper). They
    // must agree, or an agent and the dashboard would disagree about what a code
    // means — which is the drift the shared module exists to prevent.
    const result = await testDb!.pool.query<{
      f_source_code: string;
      f_source_label: string;
      f_family: string | null;
      f_measure: string | null;
    }>(
      `with src as (${AGENT_DATASET_SQL.traffic_daily!.source})
       select src.f_source_code, src.f_source_label, src.f_family, src.f_measure
       from src where src.k_page_id = $1`,
      [pageId],
    );
    const byCode = new Map(result.rows.map((row) => [row.f_source_code, row]));
    expect(byCode.get("44011")!.f_source_label).toBe("suggestions_visits");
    expect(byCode.get("44011")!.f_measure).toBe("visits");
    expect(byCode.get("44010")!.f_source_label).toBe("suggestions_dwell");
    expect(byCode.get("44010")!.f_measure).toBe("dwell");
    expect(byCode.get("10001")!.f_source_label).toBe("direct_timeline_visits");
    // The guard order again, on the SQL side: a new member of a known family
    // must NOT be absorbed by the family lookup.
    expect(byCode.get("10002")!.f_source_label).toBe("unknown:10002");
    expect(byCode.get("10002")!.f_measure).toBeNull();
    expect(byCode.get("10002")!.f_family).toBe("10000");
  });

  it("derives the media gross in SQL to the same mill as the REST layer", async (context) => {
    if (!requireServer(context)) return;
    const result = await testDb!.pool.query<{
      f_sales_net_mills: bigint | null;
      f_sales_gross_mills_derived: bigint | null;
      f_source_label: string;
    }>(
      `with src as (${AGENT_DATASET_SQL.media_stats!.source})
       select src.f_sales_net_mills, src.f_sales_gross_mills_derived, src.f_source_label
       from src where src.k_page_id = $1 limit 1`,
      [pageId],
    );
    expect(Number(result.rows[0]!.f_sales_net_mills)).toBe(16_792);
    expect(Number(result.rows[0]!.f_sales_gross_mills_derived)).toBe(20_990);
    expect(["fyp", "direct"]).toContain(result.rows[0]!.f_source_label);
  });

  it("labels revenue codes with their era, and names an unmapped one", async (context) => {
    if (!requireServer(context)) return;
    const result = await testDb!.pool.query<{
      f_type_code: number;
      f_type_label: string;
      f_type_era: string | null;
      f_mapping_version: number;
    }>(
      `with src as (${AGENT_DATASET_SQL.revenue_mix!.source})
       select src.f_type_code, src.f_type_label, src.f_type_era, src.f_mapping_version
       from src where src.k_page_id = $1`,
      [pageId],
    );
    const byCode = new Map(result.rows.map((row) => [Number(row.f_type_code), row]));
    // The legacy/current pair the ledger actually contains.
    expect(byCode.get(2010)!.f_type_label).toBe("media");
    expect(byCode.get(2010)!.f_type_era).toBe("legacy");
    expect(byCode.get(2110)!.f_type_era).toBe("current");
    expect(byCode.get(99_999)!.f_type_label).toBe("unmapped:99999");
    expect(byCode.get(99_999)!.f_type_era).toBeNull();
    expect(Number(byCode.get(2010)!.f_mapping_version)).toBe(1);
  });
});
