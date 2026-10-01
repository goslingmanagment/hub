import { findPageById, getSyncPage, type Database } from "@agency_hub_core/db";
import { buildFanslyWireRequest, sendFanslyWireRequest, type FanslyWireRequest } from "@agency_hub_core/fansly";
import type { AppConfig } from "@agency_hub_core/shared";

import { readFanslyPageGeneration } from "../../services/egress/fansly-probe-context.ts";
import { resolveEgress, type AppEgressContext } from "../../services/egress/resolver.ts";
import { BadRequestError } from "../../services/errors.ts";
import { decodeStoredFanslySession } from "../../services/page-context.ts";
import { REQUEST_TIMEOUT_MS } from "../engine/pacer.ts";
import type { SendHooks, TransportOutcome } from "../engine/ports.ts";
import type { RequestPlan } from "../engine/resource.ts";
import type { PageTransport } from "../engine/shadow.ts";

// The live page transport (design §3.10): the ONE way a Fansly request of a
// page leaves the `sync` process. Built only by the host's live loop — which
// no step-2 build runs (`LIVE_LOOP_ENABLED = false`, I17) — over the page's
// own egress (the page proxy is required: a proxyless Fansly page is refused,
// fail closed) and the wire layer's single-request send. It neither paces nor
// retries: the pacer admitted the request and its send check runs at undici's
// `onRequestStart`; a retry is a new admission.

/** The page's stored credentials changed since the engine last verified the
 *  account behind them (`sync_pages.credentials_generation`): no request goes
 *  out until the identity check has run on the new generation (§5.1). */
export class CredentialsGenerationChangedError extends Error {
  constructor(readonly pageId: number) {
    super(`Fansly sync page ${pageId}: the stored credentials changed since the last identity check`);
    this.name = "CredentialsGenerationChangedError";
  }
}

export interface PageTransportContext {
  db: Database;
  config: AppConfig;
}

/**
 * The live transport of one page. The session is read per request inside a
 * read-only snapshot together with its generation (the same 64-hex digest the
 * WS receiver uses), and refused when it differs from the generation the
 * engine verified. One dispatcher per page, closed with the transport.
 */
export async function createPageTransport(
  ctx: PageTransportContext,
  page: { pageId: number; pageLabel: string },
): Promise<PageTransport> {
  const egress: AppEgressContext = await resolveEgress(ctx, { kind: "page", pageId: page.pageId });
  const dispatcher = egress.dispatcher;
  if (dispatcher === null) {
    await egress.close();
    throw new BadRequestError(`Page "${page.pageLabel}" has no page egress; Fansly requests are refused`);
  }
  return {
    async prepare(request: RequestPlan): Promise<FanslyWireRequest> {
      const snapshot = await ctx.db.transaction(async (raw) => {
        const tx = raw as unknown as Database;
        const generation = await readFanslyPageGeneration(tx, page.pageLabel);
        const stored = await findPageById(tx, page.pageId);
        if (stored?.credentials == null) {
          throw new BadRequestError(`Page "${page.pageLabel}" has no stored platform credentials`);
        }
        const verified = (await getSyncPage(tx, page.pageId))?.credentialsGeneration ?? null;
        return { generation, verified, encryptedSession: stored.credentials.encryptedSession };
      }, { isolationLevel: "repeatable read", accessMode: "read only" });
      if (snapshot.verified !== null && snapshot.verified !== snapshot.generation) {
        throw new CredentialsGenerationChangedError(page.pageId);
      }
      const session = decodeStoredFanslySession(ctx, snapshot.encryptedSession, page.pageLabel);
      return buildFanslyWireRequest(request.spec, request.params as never, {
        baseUrl: ctx.config.fanslyBaseUrl,
        session,
        timeoutMs: REQUEST_TIMEOUT_MS,
      });
    },
    send(req: FanslyWireRequest, hooks: SendHooks, signal: AbortSignal): Promise<TransportOutcome> {
      return sendFanslyWireRequest(dispatcher, req, hooks, signal);
    },
    async close() {
      await egress.close().catch(() => undefined);
    },
  };
}
