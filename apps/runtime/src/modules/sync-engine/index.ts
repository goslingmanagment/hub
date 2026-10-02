import {
  routeSchemas,
  type SyncHistoryRequestCancelResponse,
  type SyncHistoryRequestCreateResponse,
  type SyncHistoryRequestGetResponse,
  type SyncHistoryRequestsResponse,
} from "@agency_hub_core/contracts";
import { findPageByLabel } from "@agency_hub_core/db";

import { auditCtx } from "../../api/request-auth.ts";
import { requireOwner } from "../../services/auth.ts";
import { AppError, NotFoundError } from "../../services/errors.ts";
import {
  cancelHistoryRequest,
  getHistoryRequest,
  HistoryRequestError,
  listHistoryRequestViews,
  submitHistoryRequest,
  type HistoryServiceContext,
} from "../../sync/requests/history.ts";
import { toHistoryItemWire, toHistoryRequestWire } from "../../sync/requests/wire.ts";
import type { ApiModuleContext, ApiServer } from "../context.ts";

/**
 * The Fansly Sync Engine's owner routes under `/api/v1/sync/` (design §7.4):
 * the owner's half of history requests. Owner session only, no agent envelope.
 *
 * Two clients, one implementation: these routes, the agent routes and the
 * owner CLI (`pnpm cli sync history …`) call the same service functions
 * (`sync/requests/history.ts`), so intake, idempotency, the per-page 409 gate
 * and cancel cannot drift apart. Nothing here talks to a platform.
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
