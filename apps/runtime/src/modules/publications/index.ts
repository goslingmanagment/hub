import { createHash } from "node:crypto";

import { routeSchemas } from "@agency_hub_core/contracts";
import {
  getAgentKeyById,
  getPublication,
  listPublicationPages,
  listPublicationPageTargets,
  requestPublicationQueueRefresh,
} from "@agency_hub_core/db";

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
  listPublicationChangesWire,
  listPublicationSettings,
  listPublicationsWire,
  replaceWithdrawnPublication,
  resolveUnknownPublication,
  updatePublicationDraft,
  updatePublicationSettings,
  type PublicationWithdrawer,
} from "../../services/publications.ts";
import { listPublicationPageMediaWire } from "../../services/publication-media.ts";
import { vaultLinkMaxBytes } from "../../services/publications-onlyfans-vault.ts";
import { quoteVaultAlbum, withOnlyfansAlbumRuns } from "../../services/publications-onlyfans-vault-quote.ts";
import { listFanslyQueueWire } from "../../services/publications-fansly-checks.ts";
import { deleteFanslyPublication } from "../../services/publications-fansly-delete.ts";
import { deletePagePost, withdrawPagePost, type PostCommandPage, type PostCommandResult } from "../../services/post-commands.ts";
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
/** The agent operation listing its own publications changed since a time. */
const CHANGES_OPERATION = "agentPublicationChanges";
/** The agent operation taking a Hub post off the platform's schedule (withdraw:publications). */
const WITHDRAW_OPERATION = "agentPublicationWithdraw";
/** The agent operation asking for a fresh read of a page's schedule. */
const QUEUE_REFRESH_OPERATION = "agentPublicationQueueRefresh";
/** The agent operations on any post of a page by the platform's id (owner 2026-11-11). */
const POST_WITHDRAW_OPERATION = "agentPostWithdraw";
const POST_DELETE_OPERATION = "agentPostDelete";

/** The owner's change of a page's publishing settings in the audit log. */
export const PUBLICATION_SETTINGS_AUDIT_EVENT = "admin.publication_settings";
/** The owner's withdrawal of Hub posts from a platform's schedule in the audit log (plan PR 5b). */
export const PUBLICATION_WITHDRAW_AUDIT_EVENT = "admin.publication_withdraw";
/** The owner's deletion of a published Fansly post from the wall in the audit log (0305). */
export const PUBLICATION_DELETE_POST_AUDIT_EVENT = "admin.publication_delete_post";
/** An agent key's withdrawal or deletion of a page's post by the platform's id (0369): the key, the page, the post,
 *  the outcome and, for a deletion, the agent's reason in its words. */
export const PAGE_POST_WITHDRAW_AUDIT_EVENT = "admin.page_post_withdraw";
export const PAGE_POST_DELETE_AUDIT_EVENT = "admin.page_post_delete";

/**
 * Publications (docs/plans/2026-10-23-wall-posts, spec §9). The owner drafts,
 * approves, cancels, answers "unknown" and sets each page's publishing under
 * `/api/v1/admin/publications`; an agent key with write:publication_drafts
 * drafts on its granted pages, reads their statuses under
 * `/api/v1/agent/…/publications` and picks files from the page's media under
 * `/api/v1/agent/pages/:pageLabel/publication-media`. Both call the same service, so the checks,
 * the version compare-and-set and the transitions cannot drift apart. Only a
 * withdrawal talks to a platform, through its services (the owner's and a key's
 * with withdraw:publications alike).
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
    return { publications: await withOnlyfansAlbumRuns(appContext, await listPublicationsWire(db, { pageIds, status, from, to, limit })) };
  });

  server.post("/api/v1/admin/publications", { schema: routeSchemas.adminPublicationCreate }, async (request) => {
    const principal = await requirePrincipal(request);
    const { pageLabel, ...body } = request.body;
    const page = await pageByLabel(pageLabel);
    return createPublicationDraft(db, {
      pageId: page.id, body, author: { kind: "human", userId: principal.user.id }, idempotencyKey: null, vaultLinkMaxBytes: await vaultLinkMaxBytes(appContext),
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

  /** The owner's audit row of a withdrawal and the schedule's refresh after it.
   *  An agent key's row is its own (`auditCtx`: source agent_key, the key's id
   *  in the metadata), so the owner's log says which key took which post off;
   *  the refresh is asked as `refreshUserId` (the key's owner for a key). */
  async function auditWithdraw(
    actor: { audit: ReturnType<typeof auditCtx>; refreshUserId: number },
    page: { id: number; label: string },
    results: Array<{ id: number; outcome: string; reason: string | null }>,
  ) {
    await recordAudit({ db }, {
      ...actor.audit,
      eventType: PUBLICATION_WITHDRAW_AUDIT_EVENT,
      platformAccountId: page.id,
      metadata: { pageLabel: page.label, results: results.map(({ id, outcome, reason }) => ({ id, outcome, reason })) },
    });
    // The screen's schedule follows within a minute.
    if (results.some((result) => result.outcome !== "refused")) {
      await requestPublicationQueueRefresh(db, { pageId: page.id, userId: actor.refreshUserId });
    }
  }

  server.post("/api/v1/admin/publications/withdraw-page", { schema: routeSchemas.adminPublicationWithdrawPage }, async (request) => {
    const principal = await requirePrincipal(request);
    const page = await pageByLabel(request.body.pageLabel);
    // Fansly: through the page's engine, the result as each post's status (plan PR 9).
    const results = page.platform === "fansly"
      ? await withdrawAllFanslyPublications(appContext, { pageId: page.id, userId: principal.user.id })
      : await withdrawAllOnlyfansPublications(appContext, { pageId: page.id, userId: principal.user.id });
    await auditWithdraw({ audit: auditCtx(principal), refreshUserId: principal.user.id }, page, results);
    return { results };
  });

  server.post("/api/v1/admin/publications/approve", { schema: routeSchemas.adminPublicationApprove }, async (request) => {
    const principal = await requirePrincipal(request);
    return { results: await approvePublications(db, { items: request.body.items, userId: principal.user.id, vaultLinkMaxBytes: await vaultLinkMaxBytes(appContext) }) };
  });

  server.get("/api/v1/admin/publications/:id", { schema: routeSchemas.adminPublicationGet }, async (request) => {
    await requirePrincipal(request);
    const [detail] = await withOnlyfansAlbumRuns(appContext, [await getPublicationDetail(db, request.params.id, { vaultLinkMaxBytes: await vaultLinkMaxBytes(appContext) })]);
    return detail!;
  });

  server.put("/api/v1/admin/publications/:id", { schema: routeSchemas.adminPublicationUpdate }, async (request) => {
    const principal = await requirePrincipal(request);
    const { version, ...body } = request.body;
    return updatePublicationDraft(db, {
      id: request.params.id, version, body, actor: { kind: "human", userId: principal.user.id }, vaultLinkMaxBytes: await vaultLinkMaxBytes(appContext),
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
    if (publication) {
      await auditWithdraw({ audit: auditCtx(principal), refreshUserId: principal.user.id }, await pageByLabel(publication.pageLabel), results);
    }
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
  // write:publication_drafts on the key's own pages: draft, edit and cancel
  // what it drafted (cancel only before Hub hands it to the platform, owner
  // 2026-10-29), read statuses and the page's media; approve:publications also
  // approves them, on the owner's word in the chat (owner 2026-10-27).
  // withdraw:publications takes any Hub post of the key's pages off the
  // platform's schedule, as the owner's «Снять» does, and reads the page's
  // schedule (owner 2026-11-11). delete:posts deletes a published post of its
  // pages, on the owner's «да» for that post (below). «Снять всё» on a page and
  // the settings are the owner's. A page or publication outside the grant is
  // the plane's one static 404.

  async function agentScope(
    request: Parameters<typeof requireAgentKeyPrincipal>[0],
    operation: string,
    requiredCapabilities: Array<"write:publication_drafts" | "approve:publications" | "approve:vault_albums" | "withdraw:publications" | "delete:posts"> = ["write:publication_drafts"],
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
        pageId: page.id, body, author: { kind: "agent", agentKeyId: principal.agentKeyId }, idempotencyKey, vaultLinkMaxBytes: await vaultLinkMaxBytes(appContext),
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
      return { publications: await withOnlyfansAlbumRuns(appContext, await listPublicationsWire(db, { pageIds: [page.id], status, from, to, limit })) };
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

  // Where the page's drafts can go and who sees them: walls and tiers by name,
  // never their prices, so a key without read:money names the audience.
  server.get("/api/v1/agent/pages/:pageLabel/publication-targets", { schema: routeSchemas.agentPublicationTargets }, async (request) => {
    const { scope } = await agentScope(request, "agentPublicationTargets");
    return settled(scope, async () => {
      const page = scope.pages.find((candidate) => candidate.pageLabel === request.params.pageLabel);
      if (!page) throw staticNotFound();
      const targets = await withAgentTimeout(db, AGENT_TIMEOUT_MS.short, (tx) => listPublicationPageTargets(tx, page.id), "agent_publication_targets");
      return { pageLabel: page.pageLabel, platform: page.platform as "fansly" | "onlyfans", ...targets };
    }, (result) => result.walls.length + result.tiers.length);
  });

  // The key's own publications changed since a time, oldest change first (a
  // client polls its statuses). Static path before `:id`. The cursor carries
  // `since` and `limit` and is pinned to the key and its grant.
  server.get("/api/v1/agent/publications/changes", { schema: routeSchemas.agentPublicationChanges }, async (request) => {
    const { principal, scope } = await agentScope(request, CHANGES_OPERATION);
    return settled(scope, async () => {
      const resource = "publication_changes";
      const cursor = request.query.cursor === undefined
        ? null
        : decodeAgentCursor(request.query.cursor, {
          operation: CHANGES_OPERATION,
          resource,
          keyId: principal.agentKeyId,
          pageIds: scope.pageIds,
          archiveGeneration: scope.archiveGeneration,
        }, scope.signing);
      const stored = cursor?.params as { since?: string; limit?: number } | undefined;
      const since = cursor === null ? request.query.since : stored?.since;
      const limit = stored?.limit ?? request.query.limit;
      const after = cursor === null
        ? null
        : { updatedAt: String(cursor.keyset.afterUpdatedAt), id: Number(cursor.keyset.afterId) };
      const listed = await withAgentTimeout(db, AGENT_TIMEOUT_MS.long, (tx) => listPublicationChangesWire(tx, {
        authorAgentKeyId: principal.agentKeyId,
        pageIds: scope.pages.map((page) => page.id),
        since: since === undefined ? null : new Date(since),
        after,
        limit,
      }), "agent_publication_changes");
      const nextCursor = listed.publications.length === limit && listed.last !== null
        ? encodeAgentCursor({
          operation: CHANGES_OPERATION,
          resource,
          keyId: principal.agentKeyId,
          pageIds: scope.pageIds,
          params: { ...(since === undefined ? {} : { since }), limit },
          archiveGeneration: scope.archiveGeneration,
          sourceHighWaters: {},
          seqHighWater: {},
          keyset: { afterUpdatedAt: listed.last.updatedAt, afterId: listed.last.id },
        }, scope.signing)
        : null;
      return { publications: await withOnlyfansAlbumRuns(appContext, listed.publications), nextCursor };
    }, (result) => result.publications.length);
  });

  server.post("/api/v1/agent/publications/:id/cancel", { schema: routeSchemas.agentPublicationCancel }, async (request) => {
    const { principal, scope } = await agentScope(request, "agentPublicationCancel");
    return settled(scope, async () => {
      let publication;
      try {
        publication = await cancelPublication(db, {
          id: request.params.id, agentKeyId: principal.agentKeyId, allowedPageIds: scope.pages.map((page) => page.id),
        });
      } catch (error) {
        if (error instanceof NotFoundError) throw staticNotFound();
        throw error;
      }
      const pageId = scope.pages.find((page) => page.pageLabel === publication.pageLabel)?.id;
      await writeAgentAudit(db, {
        agentKeyId: principal.agentKeyId,
        operation: "agentPublicationCancel",
        pageIds: pageId === undefined ? [] : [pageId],
        verbatimText: false,
        requestSummary: { publicationId: publication.id, publicationKind: publication.kind },
      });
      return publication;
    }, () => 1);
  });

  // «Снять» by a key (withdraw:publications ALONE, owner 2026-11-11): any Hub
  // post of its pages, through the owner's own services, so every refusal is
  // the owner's. The platform's commands go as the key's owner; the owner's
  // audit row names the key (source agent_key), the agent audit the post.
  server.post("/api/v1/agent/publications/:id/withdraw", { schema: routeSchemas.agentPublicationWithdraw }, async (request) => {
    const { principal, scope } = await agentScope(request, WITHDRAW_OPERATION, ["withdraw:publications"]);
    return settled(scope, async () => {
      const key = await getAgentKeyById(db, principal.agentKeyId);
      if (key?.createdBy == null) throw new ConflictError("this key names no owner to withdraw for: issue a new key");
      const withdrawer: PublicationWithdrawer = {
        kind: "agent", agentKeyId: principal.agentKeyId, ownerUserId: key.createdBy, allowedPageIds: scope.pages.map((page) => page.id),
      };
      const id = request.params.id;
      const target = await getPublication(db, id);
      const results = target?.platform === "fansly"
        ? await withdrawFanslyPublications(appContext, { ids: [id], withdrawer })
        : await withdrawOnlyfansPublications(appContext, { ids: [id], withdrawer });
      const result = results[0];
      // None, or on a page outside the grant (the service answers both alike): the one static 404.
      const page = result?.publication == null ? undefined : scope.pages.find((candidate) => candidate.pageLabel === result.publication?.pageLabel);
      if (result === undefined || page === undefined) throw staticNotFound();
      await writeAgentAudit(db, {
        agentKeyId: principal.agentKeyId,
        operation: WITHDRAW_OPERATION,
        pageIds: [page.id],
        verbatimText: false,
        // The reason's leading code only: some reasons carry an error's text after it.
        requestSummary: { publicationId: id, outcome: result.outcome, reasonCode: /^[a-z0-9_]{1,64}/.exec(result.reason ?? "")?.[0] ?? null },
      });
      await auditWithdraw({ audit: auditCtx(principal), refreshUserId: key.createdBy }, { id: page.id, label: page.pageLabel }, results);
      return { results };
    }, (response) => response.results.length);
  });

  // Any post of a page by the platform's id (owner 2026-11-11): withdraw (any
  // post Hub's fresh read of the schedule shows, one put there by hand too —
  // withdraw:publications) and delete (a published post among the page's own,
  // on the owner's «да» for that post — delete:posts). The platform's commands
  // go as the key's owner; the owner's audit row names the key, the post, the
  // outcome and a deletion's reason; the agent audit closed identifiers only.

  /** The key's page with posts, or the plane's static 404; and the key's owner. */
  async function postScope(
    principal: Awaited<ReturnType<typeof requireAgentKeyPrincipal>>,
    scope: Awaited<ReturnType<typeof beginAgentRequest>>,
    pageLabel: string,
  ) {
    const granted = scope.pages.find((candidate) => candidate.pageLabel === pageLabel);
    if (!granted || (granted.platform !== "fansly" && granted.platform !== "onlyfans")) throw staticNotFound();
    const key = await getAgentKeyById(db, principal.agentKeyId);
    if (key?.createdBy == null) throw new ConflictError("this key names no owner to act for: issue a new key");
    const page: PostCommandPage = { id: granted.id, pageLabel: granted.pageLabel, platform: granted.platform };
    return { page, actor: { agentKeyId: principal.agentKeyId, ownerUserId: key.createdBy, allowedPageIds: scope.pages.map((candidate) => candidate.id) } };
  }

  async function auditPostCommand(
    principal: Awaited<ReturnType<typeof requireAgentKeyPrincipal>>,
    operation: string,
    page: PostCommandPage,
    result: PostCommandResult,
    deleteReason: string | null,
  ) {
    await recordAudit({ db }, {
      ...auditCtx(principal),
      eventType: deleteReason === null ? PAGE_POST_WITHDRAW_AUDIT_EVENT : PAGE_POST_DELETE_AUDIT_EVENT,
      platformAccountId: page.id,
      metadata: {
        pageLabel: page.pageLabel,
        platform: page.platform,
        postRef: result.postRef,
        outcome: result.outcome,
        reason: result.reason,
        repeat: result.repeat,
        publicationId: result.publicationId,
        ...(deleteReason === null ? {} : { deleteReason, dailyLimit: result.dailyLimit }),
      },
    });
    await writeAgentAudit(db, {
      agentKeyId: principal.agentKeyId,
      operation,
      pageIds: [page.id],
      verbatimText: false,
      requestSummary: {
        postRef: result.postRef,
        outcome: result.outcome,
        // The reason's leading code only: some reasons carry an error's text after it.
        reasonCode: /^[a-z0-9_]{1,64}/.exec(result.reason ?? "")?.[0] ?? null,
        repeat: result.repeat,
        publicationId: result.publicationId,
        ...(deleteReason === null ? {} : {
          reasonSha256: createHash("sha256").update(deleteReason).digest("hex"),
          reasonLength: deleteReason.length,
          dailyUsed: result.dailyLimit?.used ?? null,
        }),
      },
    });
  }

  server.post("/api/v1/agent/pages/:pageLabel/posts/:postRef/withdraw", { schema: routeSchemas.agentPostWithdraw }, async (request) => {
    const { principal, scope } = await agentScope(request, POST_WITHDRAW_OPERATION, ["withdraw:publications"]);
    return settled(scope, async () => {
      const { page, actor } = await postScope(principal, scope, request.params.pageLabel);
      const result = await withdrawPagePost(appContext, { page, postRef: request.params.postRef, actor });
      await auditPostCommand(principal, POST_WITHDRAW_OPERATION, page, result, null);
      // The screen's schedule follows within a minute, once something was sent now.
      if (!result.repeat && result.outcome !== "refused") await requestPublicationQueueRefresh(db, { pageId: page.id, userId: actor.ownerUserId });
      return result;
    }, () => 1);
  });

  server.post("/api/v1/agent/pages/:pageLabel/posts/:postRef/delete", { schema: routeSchemas.agentPostDelete }, async (request) => {
    const { principal, scope } = await agentScope(request, POST_DELETE_OPERATION, ["delete:posts"]);
    return settled(scope, async () => {
      const { page, actor } = await postScope(principal, scope, request.params.pageLabel);
      const result = await deletePagePost(appContext, { page, postRef: request.params.postRef, actor });
      await auditPostCommand(principal, POST_DELETE_OPERATION, page, result, request.body.reason);
      return result;
    }, () => 1);
  });

  // The page's own schedule on the platform (the owner's «Очередь площадки»
  // for one page): write:publication_drafts reads it, and so does a key that
  // only withdraws, which must see what it takes off.
  async function queueScope(request: Parameters<typeof requireAgentKeyPrincipal>[0], operation: string) {
    const caller = await requireAgentKeyPrincipal(request);
    const withdrawOnly = !caller.capabilities.includes("write:publication_drafts") && caller.capabilities.includes("withdraw:publications");
    return agentScope(request, operation, [withdrawOnly ? "withdraw:publications" : "write:publication_drafts"]);
  }

  server.get("/api/v1/agent/pages/:pageLabel/publication-queue", { schema: routeSchemas.agentPublicationQueue }, async (request) => {
    const { scope } = await queueScope(request, "agentPublicationQueue");
    return settled(scope, async () => {
      const page = scope.pages.find((candidate) => candidate.pageLabel === request.params.pageLabel);
      if (!page) throw staticNotFound();
      // The owner's own listing of the page's platform, this page's entry.
      const listed = page.platform === "fansly"
        ? await listFanslyQueueWire(appContext)
        : page.platform === "onlyfans" ? await listOnlyfansQueueWire(appContext) : [];
      const snapshot = listed.find((candidate) => candidate.pageLabel === page.pageLabel);
      // A page Hub reads no schedule of (no engine, no OnlyFansAPI account).
      if (snapshot === undefined) throw staticNotFound();
      return snapshot;
    }, (snapshot) => snapshot.entries.length);
  });

  server.post("/api/v1/agent/pages/:pageLabel/publication-queue/refresh", { schema: routeSchemas.agentPublicationQueueRefresh }, async (request) => {
    const { principal, scope } = await queueScope(request, QUEUE_REFRESH_OPERATION);
    return settled(scope, async () => {
      const page = scope.pages.find((candidate) => candidate.pageLabel === request.params.pageLabel);
      if (!page || (page.platform !== "onlyfans" && page.platform !== "fansly")) throw staticNotFound();
      const key = await getAgentKeyById(db, principal.agentKeyId);
      if (key?.createdBy == null) throw new ConflictError("this key names no owner to read the schedule as: issue a new key");
      // As the owner's «Обновить»: the minutely jobs read it, as the key's owner.
      await requestPublicationQueueRefresh(db, { pageId: page.id, userId: key.createdBy });
      await writeAgentAudit(db, {
        agentKeyId: principal.agentKeyId,
        operation: QUEUE_REFRESH_OPERATION,
        pageIds: [page.id],
        verbatimText: false,
        requestSummary: { platform: page.platform },
      });
      return { requestedAt: new Date().toISOString() };
    }, () => 1);
  });

  // The price of a vault album before «да» (8-docs 2026-11-12-of-vault-album): nothing goes to the
  // platform; an old list of the page's albums asks the minutely job for a walk, as the key's owner.
  server.post("/api/v1/agent/pages/:pageLabel/vault-album-quote", { schema: routeSchemas.agentVaultAlbumQuote }, async (request) => {
    const { principal, scope } = await agentScope(request, "agentVaultAlbumQuote");
    return settled(scope, async () => {
      const page = scope.pages.find((candidate) => candidate.pageLabel === request.params.pageLabel);
      if (!page) throw staticNotFound();
      const key = await getAgentKeyById(db, principal.agentKeyId);
      if (key?.createdBy == null) throw new ConflictError("this key names no owner to read the page's albums as: issue a new key");
      const quote = await quoteVaultAlbum(appContext, { page: { id: page.id, platform: page.platform }, body: request.body, actorUserId: key.createdBy });
      await writeAgentAudit(db, {
        agentKeyId: principal.agentKeyId,
        operation: "agentVaultAlbumQuote",
        pageIds: [page.id],
        verbatimText: false,
        requestSummary: { files: request.body.files.length, credits: quote.credits, album: quote.album.kind, walkRequested: quote.album.walkRequested },
      });
      return quote;
    }, () => 1);
  });

  server.get("/api/v1/agent/publications/:id", { schema: routeSchemas.agentPublicationGet }, async (request) => {
    const { scope } = await agentScope(request, "agentPublicationGet");
    return settled(scope, async () => {
      try {
        const [detail] = await withOnlyfansAlbumRuns(appContext, [await getPublicationDetail(db, request.params.id, { allowedPageIds: scope.pages.map((page) => page.id), vaultLinkMaxBytes: await vaultLinkMaxBytes(appContext) })]);
        return detail!;
      } catch (error) {
        if (error instanceof NotFoundError) throw staticNotFound();
        throw error;
      }
    }, () => 1);
  });

  // The agent approves on the owner's word in the chat: the revision names
  // the key's owner (who gave the key this right) and the key itself.
  // approve:vault_albums alone approves albums and refuses every other kind.
  server.post("/api/v1/agent/publications/approve", { schema: routeSchemas.agentPublicationApprove }, async (request) => {
    const caller = await requireAgentKeyPrincipal(request);
    const vaultAlbumsOnly = !caller.capabilities.includes("approve:publications") && caller.capabilities.includes("approve:vault_albums");
    const { principal, scope } = await agentScope(request, "agentPublicationApprove", [
      "write:publication_drafts",
      vaultAlbumsOnly ? "approve:vault_albums" : "approve:publications",
    ]);
    return settled(scope, async () => {
      const key = await getAgentKeyById(db, principal.agentKeyId);
      if (key?.createdBy == null) throw new ConflictError("this key names no owner to approve for: issue a new key");
      const pageIds = scope.pages.map((page) => page.id);
      const results = await approvePublications(db, {
        items: request.body.items,
        approver: { kind: "agent", agentKeyId: principal.agentKeyId, ownerUserId: key.createdBy, allowedPageIds: pageIds, vaultAlbumsOnly },
        vaultLinkMaxBytes: await vaultLinkMaxBytes(appContext),
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
          vaultLinkMaxBytes: await vaultLinkMaxBytes(appContext),
        });
      } catch (error) {
        if (error instanceof NotFoundError) throw staticNotFound();
        throw error;
      }
    }, () => 1);
  });
}
