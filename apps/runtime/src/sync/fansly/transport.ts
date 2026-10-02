import { findPageById, getSyncPage, readSyncWorkSecretParams, type Database, type SyncWorkRow } from "@agency_hub_core/db";
import {
  buildFanslyWireRequest,
  fanslyWireSpec,
  sendFanslyCdnRequest,
  sendFanslyWireRequest,
  type FanslyWireRequest,
} from "@agency_hub_core/fansly";
import type { AppConfig } from "@agency_hub_core/shared";

import { readFanslyPageGeneration } from "../../services/egress/fansly-probe-context.ts";
import { isFanslyCdnUrl, MEDIA_DOWNLOAD_MAX_BYTES, MEDIA_DOWNLOAD_TIMEOUT_MS } from "../../services/egress/media-download.ts";
import { resolveEgress, type AppEgressContext } from "../../services/egress/resolver.ts";
import { BadRequestError } from "../../services/errors.ts";
import { decodeStoredFanslySession } from "../../services/page-context.ts";
import { REQUEST_TIMEOUT_MS } from "../engine/pacer.ts";
import { UnsendableRequestError, type LivePageSocketRef, type SendHooks, type TransportOutcome } from "../engine/ports.ts";
import type { RequestPlan } from "../engine/resource.ts";
import type { PageTransport } from "../engine/shadow.ts";
import { decryptSyncWorkSecret } from "../requests/secret-params.ts";

// The live page transport (design §3.10, S3-04 item 2): the ONE way a Fansly
// request of a page leaves the `sync` process. Built only by the host's live
// loop — which no step-2 build runs (`LIVE_LOOP_ENABLED = false`, I17) — over
// the page's own egress (the page proxy is required: a proxyless Fansly page
// is refused, fail closed). It neither paces nor retries: the pacer admitted
// the request and its send check runs at undici's `onRequestStart`; a retry is
// a new admission. Three hosts, one dispatcher, one check per request:
//
// - api: the wire layer's single-request send with the page's session;
// - cdn: one hop of a chat file's download (`media-download.fetch`): the URL
//   is the work's secret (`sync_work.secret_params`, decrypted here and
//   nowhere else, design J7), its host must be a Fansly media CDN, no session
//   headers, the body capped at the describer's 5 MiB;
// - ws: the socket's Upgrade, sent by the page's socket owner (S3-03's
//   `FanslyWsSource`) through its handshake with this admission's check.

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

export interface PageTransportOptions {
  /** The page's socket owner (the host's slot): `ws.upgrade` goes through it. */
  socket?: LivePageSocketRef;
  /** Which CDN URLs a hop may request. Default: a Fansly media CDN host
   *  (`isFanslyCdnUrl`). TESTS ONLY pass another (a loopback origin). */
  cdnUrlAllowed?: (url: URL) => boolean;
}

/** The `url` of a prepared `ws.upgrade`: the page's socket owner opens the
 *  socket's own URL; nothing here sends to this one. */
const SOCKET_OWNER_URL = "socket-owner:ws.upgrade";

/** What a `cdn.media` work's secret holds. */
export interface MediaDownloadSecret {
  url: string;
}

/**
 * The live transport of one page. The session is read per API request inside
 * a read-only snapshot together with its generation (the same 64-hex digest
 * the WS receiver uses), and refused when it differs from the generation the
 * engine verified. One dispatcher per page, closed with the transport.
 */
export async function createPageTransport(
  ctx: PageTransportContext,
  page: { pageId: number; pageLabel: string },
  options: PageTransportOptions = {},
): Promise<PageTransport> {
  const egress: AppEgressContext = await resolveEgress(ctx, { kind: "page", pageId: page.pageId });
  const dispatcher = egress.dispatcher;
  if (dispatcher === null) {
    await egress.close();
    throw new BadRequestError(`Page "${page.pageLabel}" has no page egress; Fansly requests are refused`);
  }
  const cdnUrlAllowed = options.cdnUrlAllowed ?? isFanslyCdnUrl;

  async function prepareApi(request: RequestPlan): Promise<FanslyWireRequest> {
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
  }

  /** One CDN hop: the URL the work's secret holds now (the signed URL, or the
   *  redirect the previous hop's apply stored). A work without a readable
   *  secret, or a URL off the Fansly media CDN, can never be sent. */
  async function prepareCdn(request: RequestPlan, work: SyncWorkRow | undefined): Promise<FanslyWireRequest> {
    if (work === undefined) throw new Error(`${request.spec} is prepared for a work: its URL is the work's secret`);
    const ciphertext = await readSyncWorkSecretParams(ctx.db, work.id);
    if (ciphertext === null) throw new UnsendableRequestError("secret_missing", { failure: "secret_missing", httpStatus: null });
    let url: URL;
    try {
      url = new URL(String(decryptSyncWorkSecret<Partial<MediaDownloadSecret>>(ctx.config, ciphertext).url));
    } catch {
      throw new UnsendableRequestError("secret_unreadable", { failure: "secret_unreadable", httpStatus: null });
    }
    if (!cdnUrlAllowed(url)) {
      throw new UnsendableRequestError("host_not_allowed", { failure: "host_not_allowed", httpStatus: null });
    }
    return { spec: request.spec, url: url.toString(), headers: {}, timeoutMs: MEDIA_DOWNLOAD_TIMEOUT_MS };
  }

  return {
    async prepare(request: RequestPlan, context?: { work: SyncWorkRow }): Promise<FanslyWireRequest> {
      switch (fanslyWireSpec(request.spec).host) {
        case "api":
          return prepareApi(request);
        case "cdn":
          return prepareCdn(request, context?.work);
        case "ws":
          // A marker: the socket owner builds and sends the Upgrade itself.
          return { spec: request.spec, url: SOCKET_OWNER_URL, headers: {}, timeoutMs: REQUEST_TIMEOUT_MS };
      }
    },
    async send(req: FanslyWireRequest, hooks: SendHooks, signal: AbortSignal): Promise<TransportOutcome> {
      switch (fanslyWireSpec(req.spec).host) {
        case "api":
          return sendFanslyWireRequest(dispatcher, req, hooks, signal);
        case "cdn":
          return absoluteLocation(await sendFanslyCdnRequest(
            dispatcher,
            { url: req.url, timeoutMs: req.timeoutMs, maxBytes: MEDIA_DOWNLOAD_MAX_BYTES },
            hooks,
            signal,
          ), req.url);
        case "ws": {
          // Without a socket owner nothing is sent (its plan waits for one).
          const socket = options.socket?.() ?? null;
          if (socket === null) return { kind: "aborted_before_send", refusal: "lease_inactive" };
          return socket.handshake(hooks, signal);
        }
      }
    },
    async close() {
      await egress.close().catch(() => undefined);
    },
  };
}

/** A CDN redirect's `Location` resolved against the hop's own URL (only this
 *  transport knows it): the next hop's URL as the resource checks and seals
 *  it. A `Location` that does not resolve is dropped (the hop then failed). */
function absoluteLocation(outcome: TransportOutcome, base: string): TransportOutcome {
  if (outcome.kind !== "response" || outcome.status < 300 || outcome.status > 399) return outcome;
  const { location, ...rest } = outcome.headers;
  if (location === undefined) return outcome;
  try {
    return { ...outcome, headers: { ...rest, location: new URL(location, base).toString() } };
  } catch {
    return { ...outcome, headers: rest };
  }
}
