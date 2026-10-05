import {
  type ContentCommentsResponse,
  type ContentMediaResponse,
  type MoneyPayoutsResponse,
  type MoneyRevenueMixResponse,
  type StatsCoverageResponse,
  type StatsMediaResponse,
  type StatsTagsResponse,
  type StatsTrafficResponse,
  routeSchemas,
} from "@agency_hub_core/contracts";
import {
  type InsightsCoverageRow,
  type InsightsMediaHeadRow,
  type InsightsTrafficBucketRow,
  listInsightsAutomations,
  listInsightsComments,
  listInsightsCommentsPerPost,
  listInsightsCoverage,
  listInsightsHoldings,
  listInsightsMediaHeads,
  listInsightsMediaHeadsByRefs,
  listInsightsMediaTrafficBuckets,
  listInsightsPayoutMethods,
  listInsightsPayoutRequests,
  listInsightsPlatformTags,
  listInsightsPostLikes,
  listInsightsRevenueMix,
  listInsightsRevenueMonths,
  listInsightsTierPlans,
  listInsightsTiers,
  listInsightsTopMedia,
  listInsightsTopTags,
  listInsightsTrafficBuckets,
  listInsightsRecentMediaHeads,
  listInsightsVaultAlbums,
  listInsightsWalls,
  countCreatorVaultUniqueMembers,
  countPageUniqueCreatorMedia,
  sumCreatorVaultAlbumItemCounts,
} from "@agency_hub_core/db";
import {
  CAPTURE_COVERAGE_PLANES,
  FANSLY_MEDIA_STAT_TYPES,
  FANSLY_PROFILE_STAT_FAMILIES,
  FANSLY_REVENUE_LABEL_VERSION,
  fanslyRevenueTypeEra,
  fanslyRevenueTypeLabel,
  mediaStatLabel,
  millsToNumber,
  profileStatFamily,
  profileStatLabel,
  profileStatMeasure,
} from "@agency_hub_core/shared";

import { canAccessPage, requireOwner } from "../../services/auth.ts";
import { loadEffectiveConfig } from "../../services/effective-config.ts";
import { BadRequestError, ForbiddenError } from "../../services/errors.ts";
import { getPageSummary } from "../../services/reporting.ts";
import {
  engineOwnerRunning,
  engineStopToWire,
  engineStreamState,
  readEngineStatusFacts,
} from "../../services/sync-status-engine.ts";
import { fanslyLeverStreams } from "../../sync/fansly/registry.ts";
import type { ApiModuleContext, ApiServer } from "../context.ts";

/**
 * WP-S1 — the endpoints-cover SERVING module (Fansly only, A28-2).
 *
 * **SERVING NEVER AUTHORIZES CAPTURE.** Every handler below is a pure read of
 * projections the Fansly Sync Engine already filled. Nothing here enqueues a
 * sync, opens a window, marks a subject dirty or flips a flag; a page whose
 * data nobody reads answers with what it holds (usually nothing) and SAYS so,
 * which is the entire point of the coverage route.
 *
 * Every route is `owner-session` + page scope. On the REST surface that IS the
 * money gate for `/money/*`: there is no separate money capability for cookie
 * sessions, and `owner-session` is strictly narrower than the `session` kind the
 * existing revenue routes use. The agent plane's `read:money` capability guards
 * the same data on its own surface; the two are different principals, not two
 * halves of one check.
 *
 * Three shape rules the mappers below never break:
 *   * a NULL metric stays null — no coalescing, ever;
 *   * a labelled platform enum travels as RAW CODE + LABEL + MAPPING VERSION;
 *   * NET money is served verbatim and GROSS is derived, labelled, and never
 *     summed with a net figure (A12).
 */

/** Fansly's platform cut is 20 %, so gross = net / 0.8. A12 settled that
 *  `saleStats.total` is the creator's NET share; the factor is the platform's
 *  and could change, which is why net is what is STORED and gross is what is
 *  computed here — with its basis carried on the wire beside the number. */
const SALES_GROSS_BASIS =
  "net / 0.8 — Fansly's 20% platform cut (A12); rounded to whole mills";

const INVENTORY_ALBUM_SUM_BASIS =
  "sum of creator_vault_albums.item_count — NON-UNIQUE: the system albums are "
  + "views over the same media, so this double-counts. M is uniqueMediaCount.";

/** Catalogue sidecars are small and page-scoped; they are still bounded, so a
 *  pathological page cannot produce an unbounded body. */
const CATALOG_SIDECAR_LIMIT = 500;
const TOP_WINDOW_LIMIT = 500;
const PER_POST_ROLLUP_LIMIT = 500;
const LIKERS_LIMIT = 200;
const MONTH_TOTALS_LIMIT = 500;
const COVERAGE_PLANE_ORDER = new Map<string, number>(
  Object.values(CAPTURE_COVERAGE_PLANES).map((plane, index) => [plane, index]),
);

// ── shared mappers ───────────────────────────────────────────────────────────

function iso(value: Date): string {
  return value.toISOString();
}

function isoOrNull(value: Date | null): string | null {
  return value === null ? null : value.toISOString();
}

/** `bigint`-as-text → integer mills. Null stays null: a price nobody served is
 *  not a free item. */
function millsOrNull(value: string | null): number | null {
  return value === null ? null : millsToNumber(value);
}

/** Rounded half-up so the derived gross is a whole mill. The residue is at most
 *  one mill ($0.001) and the basis string says the number is derived. */
function deriveGrossFromNet(netMills: string | null) {
  if (netMills === null) {
    return null;
  }
  const net = BigInt(netMills);
  const gross = (net * 5n + 2n) / 4n;
  return {
    value: millsToNumber(gross),
    derived: true as const,
    basis: SALES_GROSS_BASIS,
  };
}

/**
 * The label half of a traffic row.
 *
 * `sourceCode` on the wire is the RAW integer as text and it is what a caller
 * should key on. Everything else here is THIS BUILD'S reading of that integer
 * and can be wrong — `fansly-notification-types.ts` documents a version that
 * was wrong on eight of sixteen codes.
 *
 * The 0/1 media codes are not a family/member structure at all, so `family`,
 * `familyLabel` and `measure` are null for them rather than being forced into a
 * shape that does not exist.
 */
function labelTrafficRow(row: InsightsTrafficBucketRow) {
  const code = Number(row.sourceCode);
  const isMedia = row.subjectKind === "media_offer" || row.subjectKind === "account_media";
  if (isMedia) {
    return {
      sourceLabel: mediaStatLabel(code),
      family: null,
      familyLabel: null,
      measure: null,
    };
  }
  const family = Number.isSafeInteger(code) ? profileStatFamily(code) : null;
  const known = family !== null
    && FANSLY_PROFILE_STAT_FAMILIES[family] !== undefined
    && (code % 10 === 0 || code % 10 === 1);
  return {
    sourceLabel: profileStatLabel(code),
    family: family === null ? null : String(family),
    familyLabel: known ? FANSLY_PROFILE_STAT_FAMILIES[family] ?? null : null,
    measure: known ? profileStatMeasure(code) : null,
  };
}

function trafficRowToWire(row: InsightsTrafficBucketRow): StatsTrafficResponse["rows"][number] {
  return {
    subjectKind: row.subjectKind,
    subjectRef: row.subjectRef,
    periodMs: row.periodMs,
    bucketStart: iso(row.bucketStart),
    sourceCode: row.sourceCode,
    mappingVersion: row.mappingVersion,
    ...labelTrafficRow(row),
    views: row.views,
    previewViews: row.previewViews,
    uniqueViewers: row.uniqueViewers,
    previewUniqueViewers: row.previewUniqueViewers,
    videoViews: row.videoViews,
    previewVideoViews: row.previewVideoViews,
    interactionTimeMs: row.interactionTimeMs,
    previewInteractionTimeMs: row.previewInteractionTimeMs,
    videoPercentWatchedSum: row.videoPercentWatchedSum,
    previewVideoPercentWatchedSum: row.previewVideoPercentWatchedSum,
    revisionCount: row.revisionCount,
    lastObservedAt: iso(row.lastObservedAt),
  };
}

function coverageRowToWire(row: InsightsCoverageRow): StatsTrafficResponse["coverage"][number] {
  return {
    plane: row.plane,
    scopeRef: row.scopeRef,
    status: row.status,
    acquisitionMode: row.acquisitionMode,
    proof: row.proof,
    oldestCapturedAt: isoOrNull(row.oldestCapturedAt),
    newestCapturedAt: isoOrNull(row.newestCapturedAt),
    expectedCount: row.expectedCount,
    observedUniqueCount: row.observedUniqueCount,
    reasonCode: row.reasonCode,
    nextProbeAt: isoOrNull(row.nextProbeAt),
    updatedAt: iso(row.updatedAt),
  };
}

function mediaHeadToWire(row: InsightsMediaHeadRow) {
  return {
    mediaOfferRef: row.mediaOfferRef,
    mediaRef: row.mediaRef,
    bundleRefs: row.bundleRefs,
    mediaType: row.mediaType,
    mimeType: row.mimeType,
    width: row.width,
    height: row.height,
    durationMs: row.durationMs,
    priceMills: millsOrNull(row.priceMills),
    likeCount: row.likeCount,
    sales: {
      count: row.salesCount,
      netMills: millsOrNull(row.salesNetMills),
      pendingMills: millsOrNull(row.salesPendingMills),
      grossMills: deriveGrossFromNet(row.salesNetMills),
    },
    createdAtPlatform: isoOrNull(row.createdAtPlatform),
    deletedAtPlatform: isoOrNull(row.deletedAtPlatform),
    firstObservedAt: iso(row.firstObservedAt),
    lastObservedAt: iso(row.lastObservedAt),
  };
}

// ── cursors ──────────────────────────────────────────────────────────────────

/**
 * An opaque keyset position, base64url over a JSON array of strings.
 *
 * It is NOT signed and does not need to be: it carries a POSITION only, inside
 * the same page's same query, on a route that already required an owner session
 * and page access. A tampered cursor can move a caller's position within data
 * that caller may already read, and nothing else — it can never widen scope,
 * because the scope comes from the path and the principal, never from here.
 */
function encodeCursor(parts: readonly string[]): string {
  return Buffer.from(JSON.stringify(parts), "utf8").toString("base64url");
}

function decodeCursor(cursor: string, arity: number): string[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8"));
  } catch {
    throw new BadRequestError("cursor is not readable");
  }
  if (!Array.isArray(parsed) || parsed.length !== arity
    || !parsed.every((entry) => typeof entry === "string")) {
    throw new BadRequestError("cursor does not belong to this route");
  }
  return parsed as string[];
}

function parseInstant(value: string, field: string): Date {
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) {
    throw new BadRequestError(`${field} is not a valid instant`);
  }
  return parsed;
}

/** `[from, to)` with both bounds required and no silent default anywhere. An
 *  inverted window is a 400, not an empty answer that reads like evidence. */
function parseWindow(from: string, to: string): { from: Date; to: Date } {
  const start = parseInstant(from, "from");
  const end = parseInstant(to, "to");
  if (start >= end) {
    throw new BadRequestError("from must be strictly before to");
  }
  return { from: start, to: end };
}

function parseDateWindow(from: string, to: string): { from: string; to: string } {
  if (from > to) {
    throw new BadRequestError("from must not be after to");
  }
  return { from, to };
}

export function registerInsightsRoutes(server: ApiServer, ctx: ApiModuleContext) {
  const { appContext } = ctx;
  const { requirePrincipal } = ctx.auth;

  /**
   * Owner + page access, resolved the same way on every route here.
   *
   * The declarative middleware already enforces `owner-session` + page scope
   * when `AUTH_POLICY_ENFORCEMENT=enforce`; this is the in-handler layer every
   * other module still carries, so the two modes deny identically.
   */
  async function resolveOwnerPage(request: { params: { pageLabel: string } }) {
    const principal = await requirePrincipal(request as never);
    requireOwner(principal);
    const page = await getPageSummary(appContext, request.params.pageLabel);
    if (!canAccessPage(principal, page.id)) {
      throw new ForbiddenError("Page access denied");
    }
    return page;
  }

  server.get("/api/v1/pages/:pageLabel/stats/traffic", {
    schema: routeSchemas.statsTraffic,
  }, async (request): Promise<StatsTrafficResponse> => {
    const page = await resolveOwnerPage(request);
    const window = parseWindow(request.query.from, request.query.to);
    const after = request.query.cursor === undefined
      ? undefined
      : (() => {
        const [bucketStart, sourceCode] = decodeCursor(request.query.cursor as string, 2);
        return {
          bucketStart: parseInstant(bucketStart as string, "cursor"),
          sourceCode: sourceCode as string,
        };
      })();

    const limit = request.query.limit;
    const rows = await listInsightsTrafficBuckets(appContext.db, {
      pageId: page.id,
      subjectKind: request.query.subjectKind,
      subjectRef: request.query.subjectRef,
      periodMs: request.query.periodMs,
      from: window.from,
      to: window.to,
      limit,
      after,
    });
    const coverage = await listInsightsCoverage(appContext.db, { pageId: page.id });
    const last = rows.length === limit ? rows[rows.length - 1] : undefined;

    return {
      page: { label: page.label, platform: page.platform },
      window: {
        from: iso(window.from),
        to: iso(window.to),
        periodMs: request.query.periodMs,
        subjectKind: request.query.subjectKind,
        subjectRef: request.query.subjectRef ?? null,
      },
      rows: rows.map(trafficRowToWire),
      coverage: coverage.map(coverageRowToWire),
      nextCursor: last === undefined
        ? null
        : encodeCursor([iso(last.bucketStart), last.sourceCode]),
    };
  });

  server.get("/api/v1/pages/:pageLabel/stats/media", {
    schema: routeSchemas.statsMedia,
  }, async (request): Promise<StatsMediaResponse> => {
    const page = await resolveOwnerPage(request);
    const window = parseWindow(request.query.from, request.query.to);
    const after = request.query.cursor === undefined
      ? undefined
      : (() => {
        const [lastObservedAt, mediaOfferRef] = decodeCursor(request.query.cursor as string, 2);
        return {
          lastObservedAt: parseInstant(lastObservedAt as string, "cursor"),
          mediaOfferRef: mediaOfferRef as string,
        };
      })();

    const limit = request.query.limit;
    const [landingHeads, top, coverage] = await Promise.all([
      listInsightsRecentMediaHeads(appContext.db, {
        pageId: page.id,
        mediaOfferRef: request.query.mediaOfferRef,
        limit,
        after,
      }),
      listInsightsTopMedia(appContext.db, {
        pageId: page.id,
        from: window.from,
        to: window.to,
        limit: TOP_WINDOW_LIMIT,
      }),
      listInsightsCoverage(appContext.db, { pageId: page.id }),
    ]);
    const landingRefs = new Set(landingHeads.map((head) => head.mediaOfferRef));
    const rankedMissingRefs = request.query.mediaOfferRef === undefined
      ? [...new Set(top.map((row) => row.mediaOfferRef))].filter((ref) => !landingRefs.has(ref))
      : [];
    const rankedHeads = await listInsightsMediaHeadsByRefs(appContext.db, {
      pageId: page.id,
      mediaOfferRefs: rankedMissingRefs,
    });
    const heads = [...landingHeads, ...rankedHeads];
    const bucketLimit = request.query.bucketLimit;
    const buckets = await listInsightsMediaTrafficBuckets(appContext.db, {
      pageId: page.id,
      mediaOfferRefs: heads.map((head) => head.mediaOfferRef),
      periodMs: request.query.periodMs,
      from: window.from,
      to: window.to,
      // One row over the budget is how truncation is DETECTED rather than
      // guessed: a full page could always be exactly full by coincidence.
      limit: bucketLimit + 1,
    });
    const bucketsTruncated = buckets.length > bucketLimit;
    const servedBuckets = bucketsTruncated ? buckets.slice(0, bucketLimit) : buckets;
    const bucketsByMedia = new Map<string, InsightsTrafficBucketRow[]>();
    for (const bucket of servedBuckets) {
      const list = bucketsByMedia.get(bucket.subjectRef);
      if (list) {
        list.push(bucket);
      } else {
        bucketsByMedia.set(bucket.subjectRef, [bucket]);
      }
    }

    const last = landingHeads.length === limit
      ? landingHeads[landingHeads.length - 1]
      : undefined;

    return {
      page: { label: page.label, platform: page.platform },
      window: {
        from: iso(window.from),
        to: iso(window.to),
        periodMs: request.query.periodMs,
      },
      media: heads.map((head) => ({
        ...mediaHeadToWire(head),
        buckets: (bucketsByMedia.get(head.mediaOfferRef) ?? []).map(trafficRowToWire),
      })),
      top: top.map((row) => ({
        plane: row.plane,
        rank: row.rank,
        mediaOfferRef: row.mediaOfferRef,
        bundleRef: row.bundleRef,
        periodMs: row.periodMs,
        requestedStart: iso(row.requestedStart),
        requestedEnd: iso(row.requestedEnd),
        views: row.views,
        previewViews: row.previewViews,
        interactionTimeMs: row.interactionTimeMs,
        previewInteractionTimeMs: row.previewInteractionTimeMs,
        observedAt: iso(row.observedAt),
      })),
      watchMetrics: {
        perMediaAvailable: false,
        reason: "not_served_per_media_e5",
      },
      coverage: coverage.map(coverageRowToWire),
      bucketsTruncated,
      nextCursor: last === undefined
        ? null
        : encodeCursor([iso(last.lastObservedAt), last.mediaOfferRef]),
    };
  });

  server.get("/api/v1/pages/:pageLabel/stats/tags", {
    schema: routeSchemas.statsTags,
  }, async (request): Promise<StatsTagsResponse> => {
    const page = await resolveOwnerPage(request);
    const window = parseWindow(request.query.from, request.query.to);
    const after = request.query.cursor === undefined
      ? undefined
      : (() => {
        const [requestedEnd, plane, rank] = decodeCursor(request.query.cursor as string, 3);
        return {
          requestedEnd: parseInstant(requestedEnd as string, "cursor"),
          plane: plane as string,
          rank: Number(rank),
        };
      })();

    const limit = request.query.limit;
    const [topTags, platformTags, coverage] = await Promise.all([
      listInsightsTopTags(appContext.db, {
        pageId: page.id,
        from: window.from,
        to: window.to,
        limit,
        after,
      }),
      listInsightsPlatformTags(appContext.db, {
        platform: page.platform,
        from: iso(window.from).slice(0, 10),
        to: iso(window.to).slice(0, 10),
        limit: TOP_WINDOW_LIMIT,
      }),
      listInsightsCoverage(appContext.db, { pageId: page.id }),
    ]);
    const last = topTags.length === limit ? topTags[topTags.length - 1] : undefined;

    return {
      page: { label: page.label, platform: page.platform },
      window: { from: iso(window.from), to: iso(window.to) },
      topTags: topTags.map((row) => ({
        plane: row.plane,
        rank: row.rank,
        tagRef: row.tagRef,
        tagName: row.tagName,
        periodMs: row.periodMs,
        requestedStart: iso(row.requestedStart),
        requestedEnd: iso(row.requestedEnd),
        views: row.views,
        previewViews: row.previewViews,
        interactionTimeMs: row.interactionTimeMs,
        previewInteractionTimeMs: row.previewInteractionTimeMs,
        observedAt: iso(row.observedAt),
      })),
      platformTags: platformTags.map((row) => ({
        tagRef: row.tagRef,
        tagName: row.tagName,
        businessDate: row.businessDate,
        viewCount: row.viewCount,
        postCount: row.postCount,
        source: row.source,
        capturedAt: iso(row.capturedAt),
      })),
      coverage: coverage.map(coverageRowToWire),
      nextCursor: last === undefined
        ? null
        : encodeCursor([iso(last.requestedEnd), last.plane, String(last.rank)]),
    };
  });

  server.get("/api/v1/pages/:pageLabel/stats/coverage", {
    schema: routeSchemas.statsCoverage,
  }, async (request): Promise<StatsCoverageResponse> => {
    const page = await resolveOwnerPage(request);
    const effective = await loadEffectiveConfig(appContext.db, appContext.config);
    const [planes, engineFacts, holdings] = await Promise.all([
      listInsightsCoverage(appContext.db, { pageId: page.id }),
      readEngineStatusFacts(appContext.db, { pageIds: [page.id], settingMs: effective.fanslyDefaultDelayMs }),
      listInsightsHoldings(appContext.db, { pageId: page.id }),
    ]);
    const facts = engineFacts.get(page.id);

    return {
      page: { label: page.label, platform: page.platform },
      generatedAt: new Date().toISOString(),
      planes: [...planes]
        .sort((left, right) => {
          const leftOrder = COVERAGE_PLANE_ORDER.get(left.plane) ?? Number.MAX_SAFE_INTEGER;
          const rightOrder = COVERAGE_PLANE_ORDER.get(right.plane) ?? Number.MAX_SAFE_INTEGER;
          return leftOrder - rightOrder
            || left.plane.localeCompare(right.plane)
            || left.scopeRef.localeCompare(right.scopeRef);
        })
        .map(coverageRowToWire),
      // The Fansly Sync Engine reads this page's data; each lever stream is
      // described by the live work of the keys that answer to it, as the
      // Settings sync blocks describe it.
      engine: facts === undefined
        ? null
        : {
          mode: facts.page.mode,
          ownerRunning: engineOwnerRunning(facts),
          streams: fanslyLeverStreams().map((stream) => {
            const state = engineStreamState(stream, facts);
            return {
              stream,
              resources: state.keys,
              succeededAt: isoOrNull(state.succeededAt),
              nextDueAt: isoOrNull(state.nextDueAt),
              activeWork: state.activeWork,
              paused: state.paused,
              stopped: state.stopped,
              stops: state.stops.map(engineStopToWire),
              needsAttention: state.needsAttention,
              reason: state.statusReason?.summary ?? null,
              waiting: state.waiting === null
                ? null
                : {
                  resource: state.waiting.resource,
                  reason: state.waiting.reason,
                  until: isoOrNull(state.waiting.until),
                },
              consecutiveFailures: state.consecutiveFailures,
            };
          }),
        },
      holdings: holdings.map((row) => ({
        projection: row.projection,
        rowCount: row.rowCount,
        oldestAt: isoOrNull(row.oldestAt),
        newestAt: isoOrNull(row.newestAt),
      })),
    };
  });

  server.get("/api/v1/pages/:pageLabel/content/media", {
    schema: routeSchemas.contentMedia,
  }, async (request): Promise<ContentMediaResponse> => {
    const page = await resolveOwnerPage(request);
    const afterRef = request.query.cursor === undefined
      ? undefined
      : decodeCursor(request.query.cursor as string, 1)[0];
    const limit = request.query.limit;

    const [heads, albums, tiers, plans, walls, automations, coverage] = await Promise.all([
      listInsightsMediaHeads(appContext.db, { pageId: page.id, limit, afterRef }),
      listInsightsVaultAlbums(appContext.db, { pageId: page.id, limit: CATALOG_SIDECAR_LIMIT }),
      listInsightsTiers(appContext.db, { pageId: page.id, limit: CATALOG_SIDECAR_LIMIT }),
      listInsightsTierPlans(appContext.db, { pageId: page.id, limit: CATALOG_SIDECAR_LIMIT }),
      listInsightsWalls(appContext.db, { pageId: page.id, limit: CATALOG_SIDECAR_LIMIT }),
      listInsightsAutomations(appContext.db, { pageId: page.id, limit: CATALOG_SIDECAR_LIMIT }),
      listInsightsCoverage(appContext.db, { pageId: page.id }),
    ]);
    const [uniqueMediaCount, vaultMemberUniqueCount, albumMembershipSum] = await Promise.all([
      countPageUniqueCreatorMedia(appContext.db, page.id),
      countCreatorVaultUniqueMembers(appContext.db, page.id),
      sumCreatorVaultAlbumItemCounts(appContext.db, page.id),
    ]);

    const plansByTier = new Map<string, typeof plans>();
    for (const plan of plans) {
      const list = plansByTier.get(plan.tierRef);
      if (list) {
        list.push(plan);
      } else {
        plansByTier.set(plan.tierRef, [plan]);
      }
    }
    const last = heads.length === limit ? heads[heads.length - 1] : undefined;

    return {
      page: { label: page.label, platform: page.platform },
      generatedAt: new Date().toISOString(),
      media: heads.map(mediaHeadToWire),
      vaultAlbums: albums.map((album) => ({
        vaultKind: album.vaultKind,
        albumRef: album.albumRef,
        title: album.title,
        albumType: album.albumType,
        status: album.status,
        pos: album.pos,
        itemCount: album.itemCount,
        missingSince: isoOrNull(album.missingSince),
        lastObservedAt: iso(album.lastObservedAt),
      })),
      tiers: tiers.map((tier) => ({
        tierRef: tier.tierRef,
        name: tier.name,
        color: tier.color,
        pos: tier.pos,
        basePriceMills: millsOrNull(tier.basePriceMills),
        maxSubscribers: tier.maxSubscribers,
        missingSince: isoOrNull(tier.missingSince),
        plans: (plansByTier.get(tier.tierRef) ?? []).map((plan) => ({
          planRef: plan.planRef,
          status: plan.status,
          durationDays: plan.durationDays,
          priceMills: millsOrNull(plan.priceMills),
          useAmounts: plan.useAmounts,
          promoCount: plan.promoCount,
          missingSince: isoOrNull(plan.missingSince),
        })),
      })),
      walls: walls.map((wall) => ({
        wallRef: wall.wallRef,
        name: wall.name,
        description: wall.description,
        pos: wall.pos,
        mainWall: wall.mainWall,
        defaultWall: wall.defaultWall,
        private: wall.private,
        missingSince: isoOrNull(wall.missingSince),
      })),
      automations: automations.map((automation) => ({
        automationRef: automation.automationRef,
        triggerType: automation.triggerType,
        delaySeconds: automation.delaySeconds,
        cooldownSeconds: automation.cooldownSeconds,
        templateType: automation.templateType,
        senderRef: automation.senderRef,
        messageText: automation.messageText,
        attachmentCount: automation.attachmentCount,
        parseOk: automation.parseOk,
        missingSince: isoOrNull(automation.missingSince),
      })),
      inventory: {
        uniqueMediaCount,
        vaultMemberUniqueCount,
        albumMembershipSum: {
          value: albumMembershipSum,
          derived: true,
          basis: INVENTORY_ALBUM_SUM_BASIS,
        },
      },
      coverage: coverage.map(coverageRowToWire),
      nextCursor: last === undefined ? null : encodeCursor([last.mediaOfferRef]),
    };
  });

  server.get("/api/v1/pages/:pageLabel/content/comments", {
    schema: routeSchemas.contentComments,
  }, async (request): Promise<ContentCommentsResponse> => {
    const page = await resolveOwnerPage(request);
    const window = parseWindow(request.query.from, request.query.to);
    const after = request.query.cursor === undefined
      ? undefined
      : (() => {
        const [occurredAt, commentRef] = decodeCursor(request.query.cursor as string, 2);
        return {
          occurredAt: parseInstant(occurredAt as string, "cursor"),
          commentRef: commentRef as string,
        };
      })();
    const limit = request.query.limit;

    const [comments, perPost, likers, coverage] = await Promise.all([
      listInsightsComments(appContext.db, {
        pageId: page.id,
        postRef: request.query.postRef,
        from: window.from,
        to: window.to,
        limit,
        after,
      }),
      listInsightsCommentsPerPost(appContext.db, {
        pageId: page.id,
        postRef: request.query.postRef,
        from: window.from,
        to: window.to,
        limit: PER_POST_ROLLUP_LIMIT,
      }),
      listInsightsPostLikes(appContext.db, {
        pageId: page.id,
        subjectRef: request.query.postRef,
        from: window.from,
        to: window.to,
        limit: LIKERS_LIMIT,
      }),
      listInsightsCoverage(appContext.db, { pageId: page.id }),
    ]);
    const last = comments.length === limit ? comments[comments.length - 1] : undefined;

    return {
      page: { label: page.label, platform: page.platform },
      window: { from: iso(window.from), to: iso(window.to) },
      comments: comments.map((comment) => ({
        commentRef: comment.commentRef,
        parentPostRef: comment.parentPostRef,
        rootPostRef: comment.rootPostRef,
        authorRef: comment.authorRef,
        authorUsername: comment.authorUsername,
        authorDisplayName: comment.authorDisplayName,
        textPlain: comment.textPlain,
        likeCount: comment.likeCount,
        mediaLikeCount: comment.mediaLikeCount,
        tipTotalMills: millsOrNull(comment.tipTotalMills),
        attachmentTipMills: millsOrNull(comment.attachmentTipMills),
        attachmentCount: comment.attachmentCount,
        pinned: comment.pinned,
        occurredAt: iso(comment.occurredAt),
        changedAt: iso(comment.changedAt),
        discoveredVia: comment.discoveredVia,
        possiblyTruncated: comment.possiblyTruncated,
        missingSince: isoOrNull(comment.missingSince),
      })),
      perPost: perPost.map((row) => ({
        postRef: row.postRef,
        commentCount: row.commentCount,
        possiblyTruncatedCount: row.possiblyTruncatedCount,
        missingCount: row.missingCount,
        oldestAt: isoOrNull(row.oldestAt),
        newestAt: isoOrNull(row.newestAt),
      })),
      // Declared rather than omitted: WP-F2's liker lane writes nothing on
      // Fansly because no like code is live-confirmed ([E4]). The rows array is
      // still served — an OnlyFans webhook populates the same table — so the
      // panel fills the day a code is confirmed without a serving change.
      likers: {
        state: "not_started",
        reason: "no_confirmed_like_code_e4",
        rows: likers.map((like) => ({
          subjectKind: like.subjectKind,
          subjectRef: like.subjectRef,
          likerPlatformUserId: like.likerPlatformUserId,
          state: like.state,
          occurredAt: iso(like.occurredAt),
          discoveredVia: like.discoveredVia,
        })),
      },
      coverage: coverage.map(coverageRowToWire),
      nextCursor: last === undefined
        ? null
        : encodeCursor([iso(last.occurredAt), last.commentRef]),
    };
  });

  server.get("/api/v1/pages/:pageLabel/money/revenue-mix", {
    schema: routeSchemas.moneyRevenueMix,
  }, async (request): Promise<MoneyRevenueMixResponse> => {
    const page = await resolveOwnerPage(request);
    const window = parseDateWindow(request.query.from, request.query.to);
    const after = request.query.cursor === undefined
      ? undefined
      : (() => {
        const [businessDate, typeCode] = decodeCursor(request.query.cursor as string, 2);
        return { businessDate: businessDate as string, typeCode: Number(typeCode) };
      })();
    const limit = request.query.limit;

    const [daily, months, coverage] = await Promise.all([
      listInsightsRevenueMix(appContext.db, {
        pageId: page.id,
        from: window.from,
        to: window.to,
        limit,
        after,
      }),
      listInsightsRevenueMonths(appContext.db, {
        pageId: page.id,
        limit: MONTH_TOTALS_LIMIT,
      }),
      listInsightsCoverage(appContext.db, { pageId: page.id }),
    ]);
    const last = daily.length === limit ? daily[daily.length - 1] : undefined;

    return {
      page: { label: page.label, platform: page.platform },
      window: { from: window.from, to: window.to },
      daily: daily.map((row) => ({
        businessDate: row.businessDate,
        typeCode: row.typeCode,
        typeLabel: fanslyRevenueTypeLabel(row.typeCode),
        typeEra: fanslyRevenueTypeEra(row.typeCode),
        mappingVersion: FANSLY_REVENUE_LABEL_VERSION,
        grossMills: millsOrNull(row.grossMills),
        netMills: millsOrNull(row.netMills),
        lastObservedAt: iso(row.lastObservedAt),
      })),
      months: months.map((row) => ({
        year: row.year,
        month: row.month,
        // The `(0, 0)` row is the creator's Statements header — a ROLLING
        // rollup. Flagged rather than dropped: summed with the real months it
        // double-counts, and hidden it makes the totals look wrong for no
        // visible reason.
        rollup: row.year === 0 && row.month === 0,
        totalGrossMills: millsOrNull(row.totalGrossMills),
        totalNetMills: millsOrNull(row.totalNetMills),
        topPercent: row.topPercent,
        maxTopPercent: row.maxTopPercent,
        windowStart: isoOrNull(row.windowStart),
        windowEnd: isoOrNull(row.windowEnd),
        lastObservedAt: iso(row.lastObservedAt),
      })),
      coverage: coverage.map(coverageRowToWire),
      nextCursor: last === undefined
        ? null
        : encodeCursor([last.businessDate, String(last.typeCode)]),
    };
  });

  server.get("/api/v1/pages/:pageLabel/money/payouts", {
    schema: routeSchemas.moneyPayouts,
  }, async (request): Promise<MoneyPayoutsResponse> => {
    const page = await resolveOwnerPage(request);
    const after = request.query.cursor === undefined
      ? undefined
      : (() => {
        const [requestedAt, payoutRef] = decodeCursor(request.query.cursor as string, 2);
        return {
          requestedAt: requestedAt === "" ? null : parseInstant(requestedAt as string, "cursor"),
          payoutRef: payoutRef as string,
        };
      })();
    const limit = request.query.limit;

    const [requests, methods, coverage] = await Promise.all([
      listInsightsPayoutRequests(appContext.db, { pageId: page.id, limit, after }),
      listInsightsPayoutMethods(appContext.db, {
        pageId: page.id,
        limit: CATALOG_SIDECAR_LIMIT,
      }),
      listInsightsCoverage(appContext.db, { pageId: page.id }),
    ]);
    const last = requests.length === limit ? requests[requests.length - 1] : undefined;

    return {
      page: { label: page.label, platform: page.platform },
      generatedAt: new Date().toISOString(),
      requests: requests.map((row) => ({
        payoutRef: row.payoutRef,
        amountMills: millsOrNull(row.amountMills),
        statusCode: row.statusCode,
        statusLabel: row.statusLabel,
        statusConfidence: row.statusConfidence,
        methodRef: row.methodRef,
        requestedAt: isoOrNull(row.requestedAt),
        updatedAtPlatform: isoOrNull(row.updatedAtPlatform),
        version: row.version,
      })),
      methods: methods.map((row) => ({
        methodRef: row.methodRef,
        providerId: row.providerId,
        providerLabel: row.providerLabel,
        type: row.type,
        flags: row.flags,
        status: row.status,
        maskedLabel: row.maskedLabel,
        metadataParseOk: row.metadataParseOk,
        missingSince: isoOrNull(row.missingSince),
      })),
      coverage: coverage.map(coverageRowToWire),
      nextCursor: last === undefined
        ? null
        : encodeCursor([last.requestedAt === null ? "" : iso(last.requestedAt), last.payoutRef]),
    };
  });
}

/** Re-exported for the media-stat label census test: the two label tables this
 *  module reads are the shared ones, not private copies. */
export const INSIGHTS_LABEL_TABLES = {
  profileFamilies: FANSLY_PROFILE_STAT_FAMILIES,
  mediaTypes: FANSLY_MEDIA_STAT_TYPES,
} as const;
