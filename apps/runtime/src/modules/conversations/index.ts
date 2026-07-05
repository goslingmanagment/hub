import { routeSchemas } from "@agency_hub_core/contracts";
import {
  listArchiveConversationMessages,
  searchArchiveMessages,
} from "@agency_hub_core/db";

import { pageScopeFor } from "../../api/request-auth.ts";
import { requireDashboardUser } from "../../services/auth.ts";
import {
  getPageConversationMessagesReport,
  getPageConversationPreviewReport,
} from "../../services/conversations.ts";
import {
  getPageConversationProfile,
  getPageFanProfile,
  getPageFanProfileVersion,
  listPageFanProfileVersions,
  upsertPageFanProfile,
} from "../../services/fan-profiles.ts";
import type { ApiModuleContext, ApiServer } from "../context.ts";

// Conversations module (target §6.1): threads, messages, archive search, fan
// profiles/summaries — serves desktop + extension + workboard. Handlers
// relocated verbatim from server.ts (Stage 19 Task 3).

export function registerConversationsRoutes(server: ApiServer, ctx: ApiModuleContext) {
  const { appContext } = ctx;
  const { requirePrincipal } = ctx.auth;

  server.get("/api/v1/pages/:pageLabel/fans/:platformUserId/profile", {
    schema: routeSchemas.pageFanProfile,
  }, async (request) => {
    const principal = await requirePrincipal(request);
    return getPageFanProfile(
      appContext,
      principal,
      request.params.pageLabel,
      request.params.platformUserId,
    );
  });

  server.put("/api/v1/pages/:pageLabel/fans/:platformUserId/profile", {
    schema: routeSchemas.upsertFanProfile,
  }, async (request) => {
    const principal = await requirePrincipal(request);
    return upsertPageFanProfile(
      appContext,
      principal,
      request.params.pageLabel,
      request.params.platformUserId,
      request.body.body,
    );
  });

  server.get("/api/v1/pages/:pageLabel/fans/:platformUserId/profile/versions", {
    schema: routeSchemas.pageFanProfileVersions,
  }, async (request) => {
    const principal = await requirePrincipal(request);
    return listPageFanProfileVersions(
      appContext,
      principal,
      request.params.pageLabel,
      request.params.platformUserId,
    );
  });

  server.get("/api/v1/pages/:pageLabel/fans/:platformUserId/profile/versions/:version", {
    schema: routeSchemas.pageFanProfileVersion,
  }, async (request) => {
    const principal = await requirePrincipal(request);
    return getPageFanProfileVersion(
      appContext,
      principal,
      request.params.pageLabel,
      request.params.platformUserId,
      request.params.version,
    );
  });

  server.get("/api/v1/pages/:pageLabel/conversations/:conversationId/profile", {
    schema: routeSchemas.pageConversationProfile,
  }, async (request) => {
    const principal = await requirePrincipal(request);
    return getPageConversationProfile(
      appContext,
      principal,
      request.params.pageLabel,
      request.params.conversationId,
    );
  });

  server.get("/api/v1/pages/:pageLabel/conversations/:platformConversationId/preview", {
    schema: routeSchemas.pageConversationPreview,
  }, async (request) => {
    const principal = await requirePrincipal(request);
    return getPageConversationPreviewReport(appContext, principal, request.params, request.query);
  });

  server.get("/api/v1/pages/:pageLabel/conversations/:conversationId/messages", {
    schema: routeSchemas.pageConversationMessages,
  }, async (request) => {
    const principal = await requirePrincipal(request);
    return getPageConversationMessagesReport(appContext, principal, request.params, request.query);
  });

  // === Archive reads (Stage 10) — dashboard-grade, owner/team_lead only ===
  const serializeArchiveMessage = (row: Awaited<ReturnType<typeof listArchiveConversationMessages>>[number]) => ({
    id: row.id,
    accountId: row.accountId,
    platform: row.platform,
    conversationRef: row.conversationRef,
    messageRef: row.messageRef,
    fanNativeId: row.fanNativeId,
    senderRole: row.senderRole,
    isSentByMe: row.isSentByMe,
    occurredAt: row.occurredAt?.toISOString() ?? null,
    textPlain: row.textPlain,
    priceMills: row.priceMills,
    isTip: row.isTip,
    tipAmountMills: row.tipAmountMills,
    deletedAt: row.deletedAt?.toISOString() ?? null,
  });

  server.get("/api/v1/archive/conversations/:ref/messages", {
    schema: routeSchemas.archiveConversationMessages,
  }, async (request) => {
    const principal = await requirePrincipal(request);
    requireDashboardUser(principal);
    const rows = await listArchiveConversationMessages(appContext.db, {
      ...(pageScopeFor(principal) !== undefined ? { accountIds: pageScopeFor(principal) } : {}),
      conversationRef: request.params.ref,
      beforeId: request.query.before ?? null,
      ...(request.query.limit !== undefined ? { limit: request.query.limit } : {}),
    });
    return rows.map(serializeArchiveMessage);
  });

  server.get("/api/v1/archive/search", {
    schema: routeSchemas.archiveSearch,
  }, async (request) => {
    const principal = await requirePrincipal(request);
    requireDashboardUser(principal);
    const rows = await searchArchiveMessages(appContext.db, {
      ...(pageScopeFor(principal) !== undefined ? { accountIds: pageScopeFor(principal) } : {}),
      query: request.query.q,
      fanNativeId: request.query.fan ?? null,
      ...(request.query.limit !== undefined ? { limit: request.query.limit } : {}),
    });
    return rows.map(serializeArchiveMessage);
  });
}
