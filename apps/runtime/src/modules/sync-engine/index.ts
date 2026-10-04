import {
  routeSchemas,
  type SyncHistoryRequestCancelResponse,
  type SyncHistoryRequestCreateResponse,
  type SyncHistoryRequestGetResponse,
  type SyncHistoryRequestsResponse,
  type SyncPageRefreshResponse,
  type SyncPagesResponse,
  type SyncPageWorkGetResponse,
  type SyncPageWorkResponse,
} from "@agency_hub_core/contracts";
import { findPageByLabel, listSyncPages, type Database, type SyncPageRow } from "@agency_hub_core/db";

import { auditCtx } from "../../api/request-auth.ts";
import { recordAudit, requireOwner } from "../../services/auth.ts";
import { AppError, NotFoundError } from "../../services/errors.ts";
import {
  findSyncPageByLabel,
  getSyncPageWork,
  listSyncPageWork,
  readSyncPageStatuses,
  refreshSyncPage,
  SyncPageNotFoundError,
  SyncPageOffError,
} from "../../sync/inspect.ts";
import {
  cancelHistoryRequest,
  getHistoryRequest,
  HistoryRequestError,
  listHistoryRequestViews,
  submitHistoryRequest,
  type HistoryServiceContext,
} from "../../sync/requests/history.ts";
import {
  toHistoryItemWire,
  toHistoryRequestWire,
  toSyncPageStatusWire,
  toSyncWorkWire,
} from "../../sync/requests/wire.ts";
import type { ApiModuleContext, ApiServer } from "../context.ts";

/** The owner's "sync now" in the audit log. */
export const SYNC_PAGE_REFRESH_AUDIT_EVENT = "admin.sync_page_refresh";

/**
 * The Fansly Sync Engine's owner routes under `/api/v1/sync/` (design §7.4):
 * the page status, the work rows with why they wait, "sync now", and the
 * owner's half of history requests. Owner session only, no agent envelope.
 *
 * One implementation per question: these routes, the agent routes and the
 * owner CLI (`pnpm cli sync …`) call the same functions (`sync/inspect.ts`,
 * `sync/requests/history.ts`), so the status, "why waiting", intake,
 * idempotency, the per-page 409 gate and cancel cannot drift apart. Nothing
 * here talks to a platform: "sync now" only makes the page's polls due.
 */
export function registerSyncEngineRoutes(server: ApiServer, ctx: ApiModuleContext) {
  const { appContext } = ctx;
  const { requirePrincipal } = ctx.auth;

  const history = (): HistoryServiceContext => ({ db: appContext.db, rawConfig: appContext.config });

  /** The service's refusals keep their status and code on this surface. */
  async function service<T>(body: () => Promise<T>): Promise<T> {
    try {
      return await body();
    } catch (error) {
      if (error instanceof HistoryRequestError) {
        throw new AppError(error.message, error.status, error.code);
      }
      throw error;
    }
  }

  /** The engine row of a page; an unknown label is a 404. */
  async function syncPageOf(label: string): Promise<SyncPageRow> {
    try {
      return await findSyncPageByLabel(appContext.db, label);
    } catch (error) {
      if (error instanceof SyncPageNotFoundError) {
        throw new AppError(`No Fansly Sync Engine page ${label}`, 404, "sync_page_not_found");
      }
      throw error;
    }
  }

  server.get("/api/v1/sync/pages", {
    schema: routeSchemas.syncPages,
  }, async (request): Promise<SyncPagesResponse> => {
    const principal = await requirePrincipal(request);
    requireOwner(principal);
    const statuses = await readSyncPageStatuses(appContext.db, appContext.config, await listSyncPages(appContext.db));
    return { pages: statuses.map(toSyncPageStatusWire) };
  });

  server.get("/api/v1/sync/pages/:pageLabel/work", {
    schema: routeSchemas.syncPageWork,
  }, async (request): Promise<SyncPageWorkResponse> => {
    const principal = await requirePrincipal(request);
    requireOwner(principal);
    const page = await syncPageOf(request.params.pageLabel);
    const query = request.query;
    const work = await listSyncPageWork(appContext.db, appContext.config, page, {
      ...(query.resource === undefined ? {} : { resource: query.resource }),
      ...(query.subject === undefined ? {} : { subject: query.subject }),
      ...(query.state === undefined ? {} : { state: query.state }),
      limit: query.limit,
      offset: query.offset,
    });
    return { work: work.map(toSyncWorkWire) };
  });

  server.get("/api/v1/sync/pages/:pageLabel/work/:workId", {
    schema: routeSchemas.syncPageWorkGet,
  }, async (request): Promise<SyncPageWorkGetResponse> => {
    const principal = await requirePrincipal(request);
    requireOwner(principal);
    const page = await syncPageOf(request.params.pageLabel);
    const work = await getSyncPageWork(appContext.db, appContext.config, page, request.params.workId);
    if (work === null) {
      throw new AppError(`No work ${request.params.workId} on ${request.params.pageLabel}`, 404, "sync_work_not_found");
    }
    return { work: toSyncWorkWire(work) };
  });

  server.post("/api/v1/sync/pages/:pageLabel/refresh", {
    schema: routeSchemas.syncPageRefresh,
  }, async (request, reply): Promise<SyncPageRefreshResponse> => {
    const principal = await requirePrincipal(request);
    requireOwner(principal);
    const pageLabel = request.params.pageLabel;
    const page = await syncPageOf(pageLabel);
    const files = request.body.resources;
    // The bump and its audit row commit together (the actor's NOTIFY with them).
    let refreshed: Awaited<ReturnType<typeof refreshSyncPage>>;
    try {
      refreshed = await appContext.db.transaction(async (tx) => {
        const txDb = tx as unknown as Database;
        const result = await refreshSyncPage(txDb, page, files);
        await recordAudit({ db: txDb }, {
          ...auditCtx(principal),
          eventType: SYNC_PAGE_REFRESH_AUDIT_EVENT,
          platformAccountId: page.pageId,
          metadata: { pageLabel, resources: files ?? null, bumped: result.bumped },
        });
        return result;
      });
    } catch (error) {
      if (error instanceof SyncPageOffError) throw new AppError(error.message, 409, "sync_page_off");
      throw error;
    }
    reply.code(202);
    // `shadow` is a wire-only constant since step 4 (S4-23).
    return { bumped: refreshed.bumped, shadow: false };
  });

  async function pageIdOf(label: string): Promise<number> {
    const found = await findPageByLabel(appContext.db, label);
    if (found === null) {
      throw new NotFoundError(`No active page ${label}`);
    }
    return found.page.id;
  }

  server.get("/api/v1/sync/history-requests", {
    schema: routeSchemas.syncHistoryRequests,
  }, async (request): Promise<SyncHistoryRequestsResponse> => {
    const principal = await requirePrincipal(request);
    requireOwner(principal);
    const query = request.query;
    const pageId = query.pageLabel === undefined ? undefined : await pageIdOf(query.pageLabel);
    const views = await listHistoryRequestViews(history(), {
      ...(pageId === undefined ? {} : { pageId }),
      ...(query.state === undefined ? {} : { state: query.state }),
      limit: query.limit,
      offset: query.offset,
    });
    return { requests: views.map(toHistoryRequestWire) };
  });

  server.post("/api/v1/sync/pages/:pageLabel/history-requests", {
    schema: routeSchemas.syncHistoryRequestCreate,
  }, async (request): Promise<SyncHistoryRequestCreateResponse> => {
    const principal = await requirePrincipal(request);
    requireOwner(principal);
    const pageId = await pageIdOf(request.params.pageLabel);
    const body = request.body;
    const result = await service(() => submitHistoryRequest(history(), {
      pageId,
      requester: { kind: "owner_session", userId: principal.user.id },
      fans: body.fans,
      depth: body.depth,
      reason: body.reason,
      idempotencyKey: body.idempotencyKey,
    }, { audit: auditCtx(principal) }));
    return {
      disposition: result.disposition,
      request: toHistoryRequestWire(result.request),
      items: result.items.map(toHistoryItemWire),
      nextAfterOrdinal: result.nextAfterOrdinal,
    };
  });

  server.get("/api/v1/sync/history-requests/:requestRef", {
    schema: routeSchemas.syncHistoryRequestGet,
  }, async (request): Promise<SyncHistoryRequestGetResponse> => {
    const principal = await requirePrincipal(request);
    requireOwner(principal);
    const query = request.query;
    const document = await service(() => getHistoryRequest(history(), request.params.requestRef, {
      limit: query.limit,
      afterOrdinal: query.afterOrdinal ?? null,
      ...(query.state === undefined ? {} : { states: [query.state] }),
    }));
    return {
      request: toHistoryRequestWire(document.request),
      items: document.items.map(toHistoryItemWire),
      nextAfterOrdinal: document.nextAfterOrdinal,
    };
  });

  server.post("/api/v1/sync/history-requests/:requestRef/cancel", {
    schema: routeSchemas.syncHistoryRequestCancel,
  }, async (request): Promise<SyncHistoryRequestCancelResponse> => {
    const principal = await requirePrincipal(request);
    requireOwner(principal);
    const result = await service(() => cancelHistoryRequest(history(), request.params.requestRef, {
      reason: request.body.reason ?? null,
      audit: auditCtx(principal),
    }));
    return { disposition: result.disposition, request: toHistoryRequestWire(result.request) };
  });
}
