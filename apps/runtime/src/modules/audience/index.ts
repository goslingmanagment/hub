import { routeSchemas } from "@agency_hub_core/contracts";
import {
  createFanNote,
  findPlatformFan,
  getFanEarningsSnapshotMeta,
  listFanPageContexts,
  listTopFanEarnings,
  setFanFlags,
} from "@agency_hub_core/db";

import { pageScopeFor, platformRollupScopeFor } from "../../api/request-auth.ts";
import {
  canAccessPage,
  requireDashboardUser,
  requireOwner,
} from "../../services/auth.ts";
import { ForbiddenError, NotFoundError } from "../../services/errors.ts";
import {
  getCrossPageFanDetailReport,
  getOverviewGrowthReport,
  getPageDeletedFansReport,
  getPageFanDetailReport,
  getPageFansReport,
  getPageFollowersDailyReport,
  getPageFollowersReport,
  getPageSubscribersDailyReport,
  getPageSubscribersReport,
  getPageSummary,
} from "../../services/reporting.ts";
import { searchVisibleFans } from "../../services/spenders.ts";
import { loadEffectiveConfig } from "../../services/effective-config.ts";
import { engineStreamState, readEngineStatusFacts } from "../../services/sync-status-engine.ts";
import type { ApiModuleContext, ApiServer } from "../context.ts";

// Audience module (target §6.1): fans, subscriptions, follows, growth, fan
// enrichment (notes/flags). Handlers relocated verbatim from server.ts
// (Stage 19 Task 3).

export function registerAudienceRoutes(server: ApiServer, ctx: ApiModuleContext) {
  const { appContext } = ctx;
  const { requirePrincipal } = ctx.auth;

  /**
   * W8.1 (A12/A20, decision #133): why the fan-earnings projection is (or is
   * not) being fed, so `builtAt: null / entries: []` is not read as "no
   * spenders". The Fansly Sync Engine feeds it (`fan-earnings.roster`, the
   * `fan_earnings` stream's key), so the answer is that key's live work:
   * `ramped` while the engine owns the page and the owner has not paused it,
   * `flag_off` otherwise; the last applied read and the largest failure count of
   * its active work. OnlyFans has no such stream.
   */
  async function topSpendersSource(page: { id: number; platform: string }) {
    if (page.platform !== "fansly") {
      return { streamState: "unsupported_platform" as const, lastSyncedAt: null, consecutiveFailures: null };
    }
    const effective = await loadEffectiveConfig(appContext.db, appContext.config);
    const facts = (await readEngineStatusFacts(appContext.db, {
      pageIds: [page.id],
      settingMs: effective.fanslyDefaultDelayMs,
    })).get(page.id);
    if (facts === undefined) {
      return { streamState: "flag_off" as const, lastSyncedAt: null, consecutiveFailures: null };
    }
    const state = engineStreamState("fan_earnings", facts);
    return {
      streamState: state.paused ? "flag_off" as const : "ramped" as const,
      lastSyncedAt: state.succeededAt?.toISOString() ?? null,
      consecutiveFailures: state.consecutiveFailures,
    };
  }

  server.get("/api/v1/overview/growth", {
    schema: routeSchemas.overviewGrowth,
  }, async (request) => {
    const principal = await requirePrincipal(request);
    requireDashboardUser(principal);
    const query = request.query;
    return getOverviewGrowthReport(appContext, {
      period: query.period,
      custom: query.period === "custom" ? { from: query.from, to: query.to } : undefined,
      pageIds: pageScopeFor(principal),
    });
  });

  server.get("/api/v1/pages/:pageLabel/subscribers", {
    schema: routeSchemas.pageSubscribers,
  }, async (request) => {
    const principal = await requirePrincipal(request);
    const page = await getPageSummary(appContext, request.params.pageLabel);
    if (!canAccessPage(principal, page.id)) {
      throw new ForbiddenError("Page access denied");
    }
    return getPageSubscribersReport(appContext, request.params.pageLabel, request.query);
  });

  server.get("/api/v1/pages/:pageLabel/subscribers/daily", {
    schema: routeSchemas.pageSubscribersDaily,
  }, async (request) => {
    const principal = await requirePrincipal(request);
    const query = request.query;
    const page = await getPageSummary(appContext, request.params.pageLabel);
    if (!canAccessPage(principal, page.id)) {
      throw new ForbiddenError("Page access denied");
    }
    return getPageSubscribersDailyReport(appContext, request.params.pageLabel, {
      period: query.period,
      custom: query.period === "custom" ? { from: query.from, to: query.to } : undefined,
    });
  });

  server.get("/api/v1/pages/:pageLabel/followers", {
    schema: routeSchemas.pageFollowers,
  }, async (request) => {
    const principal = await requirePrincipal(request);
    const page = await getPageSummary(appContext, request.params.pageLabel);
    if (!canAccessPage(principal, page.id)) {
      throw new ForbiddenError("Page access denied");
    }
    return getPageFollowersReport(appContext, request.params.pageLabel, request.query);
  });

  server.get("/api/v1/pages/:pageLabel/followers/daily", {
    schema: routeSchemas.pageFollowersDaily,
  }, async (request) => {
    const principal = await requirePrincipal(request);
    const query = request.query;
    const page = await getPageSummary(appContext, request.params.pageLabel);
    if (!canAccessPage(principal, page.id)) {
      throw new ForbiddenError("Page access denied");
    }
    return getPageFollowersDailyReport(appContext, request.params.pageLabel, {
      period: query.period,
      custom: query.period === "custom" ? { from: query.from, to: query.to } : undefined,
    });
  });

  server.get("/api/v1/pages/:pageLabel/fans", {
    schema: routeSchemas.pageFans,
  }, async (request) => {
    const principal = await requirePrincipal(request);
    const query = request.query;
    const page = await getPageSummary(appContext, request.params.pageLabel);
    if (!canAccessPage(principal, page.id)) {
      throw new ForbiddenError("Page access denied");
    }
    return getPageFansReport(appContext, request.params.pageLabel, query);
  });

  // Stage 32: the extension's spenders board reads the Stage 16 projection
  // instead of rebuilding rankings from ~150 Fansly calls. Page-scoped
  // per-fan spend for an ASSIGNED page — deliberately not the dashboard's
  // cross-page revenue aggregates behind the Stage 2 chatter gate.
  server.get("/api/v1/pages/:pageLabel/top-spenders", {
    schema: routeSchemas.pageTopSpenders,
  }, async (request) => {
    const principal = await requirePrincipal(request);
    const page = await getPageSummary(appContext, request.params.pageLabel);
    if (!canAccessPage(principal, page.id)) {
      throw new ForbiddenError("Page access denied");
    }
    const { window, limit } = request.query;
    const [meta, entries, source] = await Promise.all([
      getFanEarningsSnapshotMeta(appContext.db, { accountId: page.id, window }),
      listTopFanEarnings(appContext.db, { accountId: page.id, window, limit }),
      topSpendersSource(page),
    ]);
    return {
      window,
      builtAt: meta.builtAt === null ? null : meta.builtAt.toISOString(),
      fanCount: meta.fanCount,
      source,
      entries: entries.map((entry) => ({
        platformUserId: entry.platformUserId,
        username: entry.username,
        displayName: entry.displayName,
        grossMills: entry.grossMills,
        netMills: entry.netMills,
        currency: entry.currency,
        observedAt: entry.observedAt.toISOString(),
        deletedAt: entry.deletedAt === null ? null : entry.deletedAt.toISOString(),
      })),
    };
  });

  server.get("/api/v1/pages/:pageLabel/deleted-fans", {
    schema: routeSchemas.pageDeletedFans,
  }, async (request) => {
    const principal = await requirePrincipal(request);
    const page = await getPageSummary(appContext, request.params.pageLabel);
    if (!canAccessPage(principal, page.id)) {
      throw new ForbiddenError("Page access denied");
    }
    return getPageDeletedFansReport(appContext, request.params.pageLabel, request.query);
  });

  server.get("/api/v1/pages/:pageLabel/fans/:platformUserId", {
    schema: routeSchemas.pageFanDetail,
  }, async (request) => {
    const principal = await requirePrincipal(request);
    const page = await getPageSummary(appContext, request.params.pageLabel);
    if (!canAccessPage(principal, page.id)) {
      throw new ForbiddenError("Page access denied");
    }
    return getPageFanDetailReport(
      appContext,
      request.params.pageLabel,
      request.params.platformUserId,
      // Bearer principals get the platform lifetime total for THIS page only —
      // `pageScopeFor` returns `undefined` for an owner, which made an
      // owner-role device token read cross-page money off a page-scoped route.
      platformRollupScopeFor(principal, [page.id]),
    );
  });

  server.get("/api/v1/fans/:platform/:platformUserId", {
    schema: routeSchemas.crossPageFanDetail,
  }, async (request) => {
    const principal = await requirePrincipal(request);
    requireDashboardUser(principal);
    return getCrossPageFanDetailReport(appContext, {
      platform: request.params.platform,
      platformUserId: request.params.platformUserId,
      pageIds: pageScopeFor(principal),
    });
  });

  server.get("/api/v2/fans/search", {
    schema: routeSchemas.fansSearch,
  }, async (request) => {
    const principal = await requirePrincipal(request);
    return searchVisibleFans(appContext, principal, request.query);
  });

  // Create fan note
  server.post("/api/v1/pages/:pageLabel/fans/:platformUserId/notes", {
    schema: routeSchemas.createFanNote,
  }, async (request) => {
    const principal = await requirePrincipal(request);
    const page = await getPageSummary(appContext, request.params.pageLabel);
    if (!canAccessPage(principal, page.id)) {
      throw new ForbiddenError("Page access denied");
    }
    const fan = await findPlatformFan(appContext.db, page.platform, request.params.platformUserId);
    if (!fan) {
      throw new NotFoundError(`Fan "${request.params.platformUserId}" not found`);
    }
    const fanPageContexts = await listFanPageContexts(appContext.db, fan.id, [page.id]);
    if (fanPageContexts.length === 0) {
      throw new NotFoundError(`Fan "${request.params.platformUserId}" not found on page "${request.params.pageLabel}"`);
    }
    const note = await createFanNote(appContext.db, {
      fanId: fan.id,
      platformAccountId: page.id,
      authorUserId: principal.user.id,
      body: request.body.body,
    });
    return {
      id: note.id,
      fanId: note.fanId,
      platformAccountId: note.platformAccountId,
      authorUserId: note.authorUserId!,
      body: note.body,
      createdAt: new Date(note.createdAt).toISOString(),
    };
  });

  // Set fan flags
  server.patch("/api/v1/fans/:platform/:platformUserId/flags", {
    schema: routeSchemas.setFanFlags,
  }, async (request) => {
    const principal = await requirePrincipal(request);
    requireOwner(principal);
    const fan = await findPlatformFan(appContext.db, request.params.platform, request.params.platformUserId);
    if (!fan) {
      throw new NotFoundError(`Fan "${request.params.platformUserId}" not found`);
    }
    const fanPages = await listFanPageContexts(appContext.db, fan.id, pageScopeFor(principal));
    if (fanPages.length === 0) {
      throw new NotFoundError(`Fan "${request.params.platformUserId}" not found`);
    }
    const flagRows = await setFanFlags(appContext.db, {
      fanId: fan.id,
      flags: request.body.flags,
      createdByUserId: principal.user.id,
    });
    return {
      flags: flagRows.map((row) => ({
        flag: row.flag,
        createdAt: new Date(row.createdAt).toISOString(),
        createdByUserId: row.createdByUserId,
      })),
    };
  });
}
