import { routeSchemas } from "@agency_hub_core/contracts";
import { searchArchiveMessages } from "@agency_hub_core/db";

import { pageScopeFor } from "../../api/request-auth.ts";
import { getPageConversationPreviewReport } from "../../services/conversations.ts";
import {
  getPageConversationProfile,
  getPageFanProfile,
  getPageFanProfileVersion,
  listPageFanProfileVersions,
} from "../../services/fan-profiles.ts";
import { asFanReader } from "../../services/fan-reads.ts";
import type { ApiModuleContext, ApiServer } from "../context.ts";

// Conversations module (target §6.1): threads, messages, archive search, fan
// profiles/summaries — serves the desktop app + the extension. Handlers
// relocated verbatim from server.ts.

export function registerConversationsRoutes(server: ApiServer, ctx: ApiModuleContext) {
  const { appContext } = ctx;
  const { requirePrincipal } = ctx.auth;

  server.get("/api/v1/pages/:pageLabel/fans/:platformUserId/profile", {
    schema: routeSchemas.pageFanProfile,
  }, async (request) => {
    const principal = await asFanReader(appContext, await requirePrincipal(request));
    return getPageFanProfile(
      appContext,
      principal,
      request.params.pageLabel,
      request.params.platformUserId,
    );
  });

  server.get("/api/v1/pages/:pageLabel/fans/:platformUserId/profile/versions", {
    schema: routeSchemas.pageFanProfileVersions,
  }, async (request) => {
    const principal = await asFanReader(appContext, await requirePrincipal(request));
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
    const principal = await asFanReader(appContext, await requirePrincipal(request));
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
    const principal = await asFanReader(appContext, await requirePrincipal(request));
    return getPageConversationPreviewReport(appContext, principal, request.params, request.query);
  });

  // === Archive reads — dashboard-grade, owner/team_lead only ===
  const serializeArchiveMessage = (row: Awaited<ReturnType<typeof searchArchiveMessages>>[number]) => ({
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

  server.get("/api/v1/archive/search", {
    schema: routeSchemas.archiveSearch,
  }, async (request) => {
    const principal = await requirePrincipal(request);
    const accountIds = pageScopeFor(principal);
    const rows = await searchArchiveMessages(appContext.db, {
      ...(accountIds === undefined ? {} : { accountIds }),
      query: request.query.q,
      fanNativeId: request.query.fan ?? null,
      ...(request.query.limit !== undefined ? { limit: request.query.limit } : {}),
    });
    return rows.map(serializeArchiveMessage);
  });
}
