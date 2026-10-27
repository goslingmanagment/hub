import { createHash } from "node:crypto";

import { routeSchemas } from "@agency_hub_core/contracts";
import { getAgentKeyById, getPublication, listPublicationPages, requestPublicationQueueRefresh } from "@agency_hub_core/db";

import { auditCtx } from "../../api/request-auth.ts";
import { loadEffectiveConfig } from "../../services/effective-config.ts";
import { recordAudit } from "../../services/auth.ts";
import { resolvePublishingStoppedIncident } from "../../services/notification-incidents.ts";
import { ConflictError, NotFoundError } from "../../services/errors.ts";
import {
  approvePublications,
  cancelPublication,
  createPublicationDraft,
  getPublicationDetail,
  listPublicationSettings,
  listPublicationsWire,
  replaceWithdrawnPublication,
  resolveUnknownPublication,
  updatePublicationDraft,
  updatePublicationSettings,
} from "../../services/publications.ts";
import { listPublicationPageMediaWire } from "../../services/publication-media.ts";
import { listFanslyQueueWire } from "../../services/publications-fansly-checks.ts";
import { deleteFanslyPublication } from "../../services/publications-fansly-delete.ts";
import { withdrawAllFanslyPublications, withdrawFanslyPublications } from "../../services/publications-fansly-withdraw.ts";
import {
  listOnlyfansQueueWire,
  withdrawAllOnlyfansPublications,
  withdrawOnlyfansPublications,
} from "../../services/publications-onlyfans-queue.ts";
import {
  AGENT_TIMEOUT_MS,
  beginAgentRequest,
  decodeAgentCursor,
  encodeAgentCursor,
  staticNotFound,
  withAgentTimeout,
  writeAgentAudit,
} from "../agent-read/index.ts";
import type { ApiModuleContext, ApiServer } from "../context.ts";

/** The agent operation listing a page's media for drafts (plan PR 10). */
const MEDIA_OPERATION = "agentPublicationMedia";

/** The owner's change of a page's publishing settings in the audit log. */
export const PUBLICATION_SETTINGS_AUDIT_EVENT = "admin.publication_settings";
/** The owner's withdrawal of Hub posts from a platform's schedule in the audit log (plan PR 5b). */
export const PUBLICATION_WITHDRAW_AUDIT_EVENT = "admin.publication_withdraw";
/** The owner's deletion of a published Fansly post from the wall in the audit log (0305). */
export const PUBLICATION_DELETE_POST_AUDIT_EVENT = "admin.publication_delete_post";

/**
 * Publications (docs/plans/2026-10-23-wall-posts, spec §9). The owner drafts,
 * approves, cancels, answers "unknown" and sets each page's publishing under
 * `/api/v1/admin/publications`; an agent key with write:publication_drafts
 * drafts on its granted pages, reads their statuses under
 * `/api/v1/agent/…/publications` and picks files from the page's media under
 * `/api/v1/agent/pages/:pageLabel/publication-media`. Both call the same service, so the checks,
 * the version compare-and-set and the transitions cannot drift apart. Nothing
 * here talks to a platform.
 */
export function registerPublicationRoutes(server: ApiServer, ctx: ApiModuleContext) {
  const { appContext } = ctx;
  const { requirePrincipal, requireAgentKeyPrincipal } = ctx.auth;
  const db = appContext.db;

  async function pageByLabel(label: string) {
    const page = (await listPublicationPages(db)).find((candidate) => candidate.label === label);
    if (!page) throw new NotFoundError("Page not found");
    return page;
  }

  // --- The owner ---------------------------------------------------------

  server.get("/api/v1/admin/publications", { schema: routeSchemas.adminPublicationList }, async (request) => {
    await requirePrincipal(request);
    const { pageLabel, status, from, to, limit } = request.query;
    const pageIds = pageLabel === undefined ? null : [(await pageByLabel(pageLabel)).id];
    return { publications: await listPublicationsWire(db, { pageIds, status, from, to, limit }) };
  });

  server.post("/api/v1/admin/publications", { schema: routeSchemas.adminPublicationCreate }, async (request) => {
    const principal = await requirePrincipal(request);
    const { pageLabel, ...body } = request.body;
    const page = await pageByLabel(pageLabel);
    return createPublicationDraft(db, {
      pageId: page.id, body, author: { kind: "human", userId: principal.user.id }, idempotencyKey: null,
    });
  });

  // Static paths before `:id`, so "settings" and "approve" are never ids.
  server.get("/api/v1/admin/publications/settings", { schema: routeSchemas.adminPublicationSettingsList }, async (request) => {
    await requirePrincipal(request);
    const effective = await loadEffectiveConfig(db, appContext.config);
    return {
      globalEnabled: effective.publishingEnabled === true,
      pages: await listPublicationSettings(db, await listPublicationPages(db)),
    };
  });

  server.put("/api/v1/admin/publications/settings/:pageLabel", { schema: routeSchemas.adminPublicationSettingsUpdate }, async (request) => {
    const principal = await requirePrincipal(request);
    const page = await pageByLabel(request.params.pageLabel);
    const settings = await updatePublicationSettings(db, { page, body: request.body, userId: principal.user.id });
    // Turning publishing on is the owner's answer to an autostop (spec §8.3):
    // its incident is over.
    if (request.body.enabled && (page.platform === "fansly" || page.platform === "onlyfans")) {
      await resolvePublishingStoppedIncident(appContext, { pageId: page.id, pageLabel: page.label, platform: page.platform, recoveredAt: new Date() });
    }
    await recordAudit({ db }, {
      ...auditCtx(principal),
      eventType: PUBLICATION_SETTINGS_AUDIT_EVENT,
      platformAccountId: page.id,
      metadata: { pageLabel: page.label, ...request.body },
    });
    return settings;
  });

  // The platforms' own schedules (OnlyFans plan PR 5b, Fansly PR 9) and
  // withdrawal. Static paths before `:id`.
  server.get("/api/v1/admin/publications/queue", { schema: routeSchemas.adminPublicationQueueList }, async (request) => {
    await requirePrincipal(request);
    return { pages: [...await listOnlyfansQueueWire(appContext), ...await listFanslyQueueWire(appContext)] };
  });

  server.post("/api/v1/admin/publications/queue/refresh", { schema: routeSchemas.adminPublicationQueueRefresh }, async (request) => {
    const principal = await requirePrincipal(request);
    const page = await pageByLabel(request.body.pageLabel);
    if (page.platform !== "onlyfans" && page.platform !== "fansly") throw new NotFoundError("Not a page with a schedule");
    // The minutely jobs read it: OnlyFans by an owner action, Fansly by the page's engine.
    await requestPublicationQueueRefresh(db, { pageId: page.id, userId: principal.user.id });
    return { requestedAt: new Date().toISOString() };
  });

  async function auditWithdraw(principal: Awaited<ReturnType<typeof requirePrincipal>>, page: { id: number; label: string }, results: Array<{ id: number; outcome: string; reason: string | null }>) {
    await recordAudit({ db }, {
      ...auditCtx(principal),
      eventType: PUBLICATION_WITHDRAW_AUDIT_EVENT,
      platformAccountId: page.id,
      metadata: { pageLabel: page.label, results: results.map(({ id, outcome, reason }) => ({ id, outcome, reason })) },
    });
    // The screen's schedule follows within a minute.
    if (results.some((result) => result.outcome !== "refused")) {
      await requestPublicationQueueRefresh(db, { pageId: page.id, userId: principal.user.id });
    }
  }

  server.post("/api/v1/admin/publications/withdraw-page", { schema: routeSchemas.adminPublicationWithdrawPage }, async (request) => {
    const principal = await requirePrincipal(request);
    const page = await pageByLabel(request.body.pageLabel);
    // Fansly: through the page's engine, the result as each post's status (plan PR 9).
    const results = page.platform === "fansly"
      ? await withdrawAllFanslyPublications(appContext, { pageId: page.id, userId: principal.user.id })
      : await withdrawAllOnlyfansPublications(appContext, { pageId: page.id, userId: principal.user.id });
    await auditWithdraw(principal, page, results);
    return { results };
  });

  server.post("/api/v1/admin/publications/approve", { schema: routeSchemas.adminPublicationApprove }, async (request) => {
    const principal = await requirePrincipal(request);
    return { results: await approvePublications(db, { items: request.body.items, userId: principal.user.id }) };
  });

  server.get("/api/v1/admin/publications/:id", { schema: routeSchemas.adminPublicationGet }, async (request) => {
    await requirePrincipal(request);
    return getPublicationDetail(db, request.params.id);
  });

  server.put("/api/v1/admin/publications/:id", { schema: routeSchemas.adminPublicationUpdate }, async (request) => {
    const principal = await requirePrincipal(request);
    const { version, ...body } = request.body;
    return updatePublicationDraft(db, {
      id: request.params.id, version, body, actor: { kind: "human", userId: principal.user.id },
    });
  });

  server.post("/api/v1/admin/publications/:id/cancel", { schema: routeSchemas.adminPublicationCancel }, async (request) => {
    const principal = await requirePrincipal(request);
    return cancelPublication(db, { id: request.params.id, userId: principal.user.id });
  });

  server.post("/api/v1/admin/publications/:id/withdraw", { schema: routeSchemas.adminPublicationWithdraw }, async (request) => {
    const principal = await requirePrincipal(request);
    const target = await getPublication(db, request.params.id);
    const results = target?.platform === "fansly"
      ? await withdrawFanslyPublications(appContext, { ids: [request.params.id], userId: principal.user.id })
      : await withdrawOnlyfansPublications(appContext, { ids: [request.params.id], userId: principal.user.id });
    const publication = results[0]?.publication;
    if (publication) await auditWithdraw(principal, await pageByLabel(publication.pageLabel), results);
    return { results };
  });

  // «Удалить с площадки» (owner, 2026-10-24): a published Fansly post off the
  // wall, through the page's engine; the outcome comes as the status.
  server.post("/api/v1/admin/publications/:id/delete-post", { schema: routeSchemas.adminPublicationDeletePost }, async (request) => {
    const principal = await requirePrincipal(request);
    const result = await deleteFanslyPublication(appContext, { id: request.params.id, userId: principal.user.id });
    const publication = result.publication;
    if (publication !== null) {
      const page = await pageByLabel(publication.pageLabel);
      await recordAudit({ db }, {
        ...auditCtx(principal),
        eventType: PUBLICATION_DELETE_POST_AUDIT_EVENT,
        platformAccountId: page.id,
        metadata: { pageLabel: page.label, publicationId: result.id, postRef: publication.platformPostRef, outcome: result.outcome, reason: result.reason },
      });
    }
    return { results: [result] };
  });

  server.post("/api/v1/admin/publications/:id/replace", { schema: routeSchemas.adminPublicationReplace }, async (request) => {
    const principal = await requirePrincipal(request);
    return replaceWithdrawnPublication(db, { id: request.params.id, userId: principal.user.id });
  });

  server.post("/api/v1/admin/publications/:id/resolve", { schema: routeSchemas.adminPublicationResolve }, async (request) => {
    const principal = await requirePrincipal(request);
    return resolveUnknownPublication(db, { id: request.params.id, userId: principal.user.id, answer: request.body });
  });

  // --- Agent keys ----------------------------------------------------------
  //
  // write:publication_drafts on the key's own pages: draft, edit what it
  // drafted, read statuses and the page's media; approve:publications also
  // approves them, on the owner's word in the chat (owner 2026-10-27).
  // Cancelling and the settings are the owner's. A page or publication
  // outside the grant is the plane's one static 404.

  async function agentScope(
    request: Parameters<typeof requireAgentKeyPrincipal>[0],
    operation: string,
    requiredCapabilities: Array<"write:publication_drafts" | "approve:publications"> = ["write:publication_drafts"],
  ) {
    const principal = await requireAgentKeyPrincipal(request);
    const scope = await beginAgentRequest(appContext, principal, { operation, requiredCapabilities });
    return { principal, scope };
  }

  async function settled<T>(scope: { finish(rows: number): Promise<void> }, body: () => Promise<T>, rows: (result: T) => number) {
    let delivered = 0;
    try {
      const result = await body();
      delivered = rows(result);
      return result;
    } finally {
      await scope.finish(delivered);
    }
  }

  server.post("/api/v1/agent/pages/:pageLabel/publications", { schema: routeSchemas.agentPublicationCreate }, async (request) => {
    const { principal, scope } = await agentScope(request, "agentPublicationCreate");
    return settled(scope, async () => {
      const page = scope.pages.find((candidate) => candidate.pageLabel === request.params.pageLabel);
      if (!page) throw staticNotFound();
      const { idempotencyKey, ...body } = request.body;
      const publication = await createPublicationDraft(db, {
        pageId: page.id, body, author: { kind: "agent", agentKeyId: principal.agentKeyId }, idempotencyKey,
      });
      await writeAgentAudit(db, {
        agentKeyId: principal.agentKeyId,
        operation: "agentPublicationCreate",
        pageIds: [page.id],
        verbatimText: false,
        requestSummary: {
          publicationId: publication.id,
          publicationKind: body.kind,
          mediaCount: body.media.length,
          textSha256: createHash("sha256").update(body.text).digest("hex"),
          textLength: body.text.length,
        },
      });
      return publication;
    }, () => 1);
  });

  server.get("/api/v1/agent/pages/:pageLabel/publications", { schema: routeSchemas.agentPublicationList }, async (request) => {
    const { scope } = await agentScope(request, "agentPublicationList");
    return settled(scope, async () => {
      const page = scope.pages.find((candidate) => candidate.pageLabel === request.params.pageLabel);
      if (!page) throw staticNotFound();
      const { status, from, to, limit } = request.query;
      return { publications: await listPublicationsWire(db, { pageIds: [page.id], status, from, to, limit }) };
    }, (result) => result.publications.length);
  });

  // The page's media for a draft: newest first, each file's last post on the
  // page and nearest live publication. The cursor carries the listing (type,
  // publish time, limit) and is pinned to the key, its grant and the page.
  server.get("/api/v1/agent/pages/:pageLabel/publication-media", { schema: routeSchemas.agentPublicationMedia }, async (request) => {
    const { principal, scope } = await agentScope(request, MEDIA_OPERATION);
    return settled(scope, async () => {
      const page = scope.pages.find((candidate) => candidate.pageLabel === request.params.pageLabel);
      if (!page) throw staticNotFound();
      const resource = `publication_media:${page.id}`;
      const cursor = request.query.cursor === undefined
        ? null
        : decodeAgentCursor(request.query.cursor, {
          operation: MEDIA_OPERATION,
          resource,
          keyId: principal.agentKeyId,
          pageIds: scope.pageIds,
          archiveGeneration: scope.archiveGeneration,
        }, scope.signing);
      const stored = cursor?.params as { type?: "image" | "video" | "audio"; publishAt?: string; limit?: number } | undefined;
      const type = (cursor === null ? request.query.type : stored?.type) ?? null;
      const publishAt = new Date(stored?.publishAt ?? request.query.publishAt ?? Date.now());
      const limit = stored?.limit ?? request.query.limit;
      const afterMediaRef = cursor === null ? null : String(cursor.keyset.afterMediaRef);
      const listed = await withAgentTimeout(db, AGENT_TIMEOUT_MS.long, (tx) => listPublicationPageMediaWire(tx, {
        page, publishAt, type, afterMediaRef, limit,
      }), "agent_publication_media");
      const last = listed.media.at(-1);
      const nextCursor = listed.media.length === limit && last !== undefined
        ? encodeAgentCursor({
          operation: MEDIA_OPERATION,
          resource,
          keyId: principal.agentKeyId,
          pageIds: scope.pageIds,
          params: { ...(type === null ? {} : { type }), publishAt: publishAt.toISOString(), limit },
          archiveGeneration: scope.archiveGeneration,
          sourceHighWaters: {},
          seqHighWater: {},
          keyset: { afterMediaRef: last.mediaRef },
        }, scope.signing)
        : null;
      await writeAgentAudit(db, {
        agentKeyId: principal.agentKeyId,
        operation: MEDIA_OPERATION,
        pageIds: [page.id],
        verbatimText: false,
        requestSummary: { limit, returned: listed.media.length, cursorConsumed: cursor !== null },
      });
      return {
        pageLabel: page.pageLabel,
        platform: page.platform as "fansly" | "onlyfans",
        publishAt: publishAt.toISOString(),
        repostThresholdDays: listed.repostThresholdDays,
        media: listed.media,
        nextCursor,
      };
    }, (result) => result.media.length);
  });

  server.get("/api/v1/agent/publications/:id", { schema: routeSchemas.agentPublicationGet }, async (request) => {
    const { scope } = await agentScope(request, "agentPublicationGet");
    return settled(scope, async () => {
      try {
        return await getPublicationDetail(db, request.params.id, { allowedPageIds: scope.pages.map((page) => page.id) });
      } catch (error) {
        if (error instanceof NotFoundError) throw staticNotFound();
        throw error;
      }
    }, () => 1);
  });

  // The agent approves on the owner's word in the chat: the revision names
  // the key's owner (who gave the key this right) and the key itself.
  server.post("/api/v1/agent/publications/approve", { schema: routeSchemas.agentPublicationApprove }, async (request) => {
    const { principal, scope } = await agentScope(request, "agentPublicationApprove", ["write:publication_drafts", "approve:publications"]);
    return settled(scope, async () => {
      const key = await getAgentKeyById(db, principal.agentKeyId);
      if (key?.createdBy == null) throw new ConflictError("this key names no owner to approve for: issue a new key");
      const pageIds = scope.pages.map((page) => page.id);
      const results = await approvePublications(db, {
        items: request.body.items,
        approver: { kind: "agent", agentKeyId: principal.agentKeyId, ownerUserId: key.createdBy, allowedPageIds: pageIds },
      });
      await writeAgentAudit(db, {
        agentKeyId: principal.agentKeyId,
        operation: "agentPublicationApprove",
        pageIds: [...new Set(results.flatMap((result) => result.publication === null ? [] : [scope.pages.find((page) => page.pageLabel === result.publication?.pageLabel)?.id ?? 0]))].filter((id) => id > 0),
        verbatimText: false,
        requestSummary: { asked: request.body.items.length, approved: results.filter((result) => result.outcome === "approved").length },
      });
      return { results };
    }, (result) => result.results.length);
  });

  server.put("/api/v1/agent/publications/:id", { schema: routeSchemas.agentPublicationUpdate }, async (request) => {
    const { principal, scope } = await agentScope(request, "agentPublicationUpdate");
    return settled(scope, async () => {
      const { version, ...body } = request.body;
      try {
        return await updatePublicationDraft(db, {
          id: request.params.id,
          version,
          body,
          actor: { kind: "agent", agentKeyId: principal.agentKeyId },
          onlyAuthorAgentKeyId: principal.agentKeyId,
          allowedPageIds: scope.pages.map((page) => page.id),
        });
      } catch (error) {
        if (error instanceof NotFoundError) throw staticNotFound();
        throw error;
      }
    }, () => 1);
  });
}
