import { findPageById, getSyncPage, readSyncWorkSecretParams, type Database, type SyncWorkRow } from "@agency_hub_core/db";
import {
  buildFanslyWireRequest,
  fanslyWireSpec,
  sendFanslyCdnRequest,
  sendFanslyWireRequest,
  type FanslyWireRequest,
} from "@agency_hub_core/fansly";
import { type AppConfig, type FanslySessionBundle, type ProxyConfig } from "@agency_hub_core/shared";
import type { Dispatcher } from "undici";

import { readFanslyPageGeneration } from "../../services/egress/fansly-probe-context.ts";
import { isFanslyCdnUrl, MEDIA_DOWNLOAD_MAX_BYTES, MEDIA_DOWNLOAD_TIMEOUT_MS } from "../../services/egress/media-download.ts";
import { resolveEgress, type AppEgressContext } from "../../services/egress/resolver.ts";
import { BadRequestError } from "../../services/errors.ts";
import { decodeStoredFanslySession } from "../../services/page-context.ts";
import { CREDENTIALS_CHECK_KEYS, IDENTITY_CHECK_KEY, identityCandidateOf } from "../engine/errors.ts";
import { REQUEST_TIMEOUT_MS } from "../engine/pacer.ts";
import {
  CredentialsGenerationChangedError,
  UnsendableRequestError,
  type LivePageSocketRef,
  type PageTransport,
  type SendHooks,
  type TransportOutcome,
} from "../engine/ports.ts";
import type { RequestPlan } from "../engine/resource.ts";
import { decryptSyncWorkSecret } from "../requests/secret-params.ts";

// The live page transport (design §3.10, S3-04 item 2, step-3 §3.5 items 3–4):
// the ONE way a Fansly request of a page leaves the `sync` process. Built only
// by the host's live loop (`fansly/transport.ts` and `engine/host.ts` are the
// two builders, pinned) over the page's own egress (the page proxy is
// required: a proxyless Fansly page is refused, fail closed). It neither paces
// nor retries: the pacer admitted the request and its send check runs at
// undici's `onRequestStart`; a retry is a new admission. Three hosts, one
// check per request:
//
// - api: the wire layer's single-request send with the page's session — or,
//   for an identity check (`account.identity`), the candidate session/proxy of
//   the work's secret over the stored base the work names (step 3b ruling 5:
//   the caller's save is a CAS on that exact pair), a candidate proxy through
//   the egress resolver's one-shot candidate scope (still this page's
//   admission, owner decision №4);
// - cdn: one hop of a chat file's download (`media-download.fetch`): the URL
//   is the work's secret (`sync_work.secret_params`, decrypted here and
//   nowhere else, design J7), its host must be a Fansly media CDN, no session
//   headers, the body capped at the describer's 5 MiB;
// - ws: the socket's Upgrade, sent by the page's socket owner (the slot's
//   `FanslyWsSource`) through its handshake with this admission's check —
//   only with the verified stored credentials, like an API request.
//
// Credentials (G1, G2, G18): every API request is built from a read-only
// snapshot of the stored session and its digest (`readFanslyPageGeneration`,
// the session AND the proxy). Unless the digest is the one the engine
// trusts (`sync_pages.credentials_generation`, written by an applied
// `/account/me` proof or the CAS save of a checked candidate) the request is
// refused before its admission with
// `CredentialsGenerationChangedError` — a null verified digest counts as
// changed, so a live page sends nothing but `account.verify` /
// `account.identity` (the checks themselves) before its first verify. The
// egress follows the digest: a changed proxy closes the dispatcher and
// resolves the page egress again before the request is built.

export { CredentialsGenerationChangedError };

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

/** What an `account.identity` work's secret holds: the candidate the caller
 *  wants to store, checked against the page before it is stored (step-3
 *  §3.5 item 6). A missing half is the page's stored one. */
export interface IdentityCandidateSecret {
  session?: FanslySessionBundle;
  proxy?: ProxyConfig;
}

/** The page egress and the credentials digest it was resolved under. */
interface ResolvedEgress {
  egress: AppEgressContext;
  dispatcher: Dispatcher;
  /** Null: the page has no stored credentials (no API request can be built). */
  generation: string | null;
}

/** One read-only snapshot: the stored digest and the egress it belongs to. */
async function resolvePageEgress(ctx: PageTransportContext, page: { pageId: number; pageLabel: string }): Promise<ResolvedEgress> {
  const resolved = await ctx.db.transaction(async (raw) => {
    const tx = raw as unknown as Database;
    const generation = await readFanslyPageGeneration(tx, page.pageLabel).catch(() => null);
    const egress = await resolveEgress({ db: tx, config: ctx.config }, { kind: "page", pageId: page.pageId });
    return { generation, egress };
  }, { isolationLevel: "repeatable read", accessMode: "read only" });
  const dispatcher = resolved.egress.dispatcher;
  if (dispatcher === null) {
    await resolved.egress.close();
    throw new BadRequestError(`Page "${page.pageLabel}" has no page egress; Fansly requests are refused`);
  }
  return { egress: resolved.egress, dispatcher, generation: resolved.generation };
}

/**
 * The live transport of one page. The session is read per API request inside
 * a read-only snapshot together with its digest (the same 64-hex digest the
 * WS receiver uses) and refused unless that is the digest the engine
 * verified. One page dispatcher, replaced when the digest changes, closed
 * with the transport.
 */
export async function createPageTransport(
  ctx: PageTransportContext,
  page: { pageId: number; pageLabel: string },
  options: PageTransportOptions = {},
): Promise<PageTransport> {
  let current = await resolvePageEgress(ctx, page);
  const cdnUrlAllowed = options.cdnUrlAllowed ?? isFanslyCdnUrl;
  /** The one-shot egress of the identity check prepared last (a candidate
   *  proxy): used by its send, closed after it or when another is prepared. */
  let candidate: { request: FanslyWireRequest; egress: AppEgressContext; dispatcher: Dispatcher } | null = null;
  let closed = false;

  async function dropCandidate(): Promise<void> {
    const pending = candidate;
    candidate = null;
    await pending?.egress.close().catch(() => undefined);
  }

  /** The proxy changed since the egress was resolved: resolve it again. */
  async function followGeneration(generation: string | null): Promise<void> {
    if (generation === null || generation === current.generation) return;
    const next = await resolvePageEgress(ctx, page);
    const previous = current;
    current = next;
    await previous.egress.close().catch(() => undefined);
  }

  async function prepareApi(request: RequestPlan, work: SyncWorkRow | undefined): Promise<FanslyWireRequest> {
    const identity = work?.resource === IDENTITY_CHECK_KEY;
    const snapshot = await ctx.db.transaction(async (raw) => {
      const tx = raw as unknown as Database;
      const generation = await readFanslyPageGeneration(tx, page.pageLabel);
      const stored = await findPageById(tx, page.pageId);
      if (stored?.credentials == null) {
        throw new BadRequestError(`Page "${page.pageLabel}" has no stored platform credentials`);
      }
      const verified = (await getSyncPage(tx, page.pageId))?.credentialsGeneration ?? null;
      const secret = identity && work !== undefined ? await readSyncWorkSecretParams(tx, work.id) : null;
      return { generation, verified, encryptedSession: stored.credentials.encryptedSession, secret };
    }, { isolationLevel: "repeatable read", accessMode: "read only" });
    if (!CREDENTIALS_CHECK_KEYS.has(work?.resource ?? "") && snapshot.verified !== snapshot.generation) {
      throw new CredentialsGenerationChangedError(page.pageId, snapshot.generation, snapshot.verified);
    }
    await followGeneration(snapshot.generation);
    if (!identity || work === undefined) {
      const session = decodeStoredFanslySession(ctx, snapshot.encryptedSession, page.pageLabel);
      return {
        ...buildFanslyWireRequest(request.spec, request.params as never, {
          baseUrl: ctx.config.fanslyBaseUrl,
          session,
          timeoutMs: REQUEST_TIMEOUT_MS,
        }),
        credentialsGeneration: snapshot.generation,
      };
    }
    // The identity check: the candidate of the work's secret, never stored,
    // over the stored base its caller read — the half the candidate does not
    // replace is exactly that one's (the page egress followed the snapshot's
    // digest above), or the check would prove a pair nobody saves.
    const named = identityCandidateOf(work);
    if (snapshot.secret === null || named === null) {
      throw new UnsendableRequestError("identity_candidate_missing", { failure: "identity_candidate_missing", matches: null });
    }
    if (named.base !== snapshot.generation || current.generation !== snapshot.generation) {
      throw new UnsendableRequestError("identity_base_changed", { failure: "identity_base_changed", matches: null });
    }
    let secret: IdentityCandidateSecret;
    try {
      secret = decryptSyncWorkSecret<IdentityCandidateSecret>(ctx.config, snapshot.secret);
    } catch {
      throw new UnsendableRequestError("secret_unreadable", { failure: "secret_unreadable", matches: null });
    }
    const session = secret.session ?? decodeStoredFanslySession(ctx, snapshot.encryptedSession, page.pageLabel);
    const built: FanslyWireRequest = {
      ...buildFanslyWireRequest(request.spec, request.params as never, {
        baseUrl: ctx.config.fanslyBaseUrl,
        session,
        timeoutMs: REQUEST_TIMEOUT_MS,
      }),
      credentialsGeneration: named.generation,
    };
    await dropCandidate();
    if (secret.proxy !== undefined) {
      const egress = await resolveEgress(ctx, { kind: "page_candidate", pageId: page.pageId, proxy: secret.proxy });
      if (egress.dispatcher === null) {
        await egress.close();
        throw new UnsendableRequestError("candidate_egress_missing", { failure: "candidate_egress_missing", matches: null });
      }
      candidate = { request: built, egress, dispatcher: egress.dispatcher };
    }
    return built;
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
    // A hop carries no session, but it leaves through the page's proxy: a
    // changed proxy is followed here too.
    await followGeneration(await storedGeneration());
    return { spec: request.spec, url: url.toString(), headers: {}, timeoutMs: MEDIA_DOWNLOAD_TIMEOUT_MS };
  }

  /**
   * The socket's Upgrade (`ws.connect`): a marker — the socket owner builds
   * and sends it with the page's stored session — under the same
   * verified-credentials check as every API request (G2): unless the stored
   * digest is the one the engine verified, nothing is admitted and the actor
   * raises the verify. The marker names the digest it checked: the owner's
   * handshake refuses to open the socket with any other stored credentials
   * (they changed after this check), and an auth hold of the Upgrade is keyed
   * on it.
   */
  async function prepareWs(request: RequestPlan): Promise<FanslyWireRequest> {
    const snapshot = await ctx.db.transaction(async (raw) => {
      const tx = raw as unknown as Database;
      const generation = await readFanslyPageGeneration(tx, page.pageLabel);
      const verified = (await getSyncPage(tx, page.pageId))?.credentialsGeneration ?? null;
      return { generation, verified };
    }, { isolationLevel: "repeatable read", accessMode: "read only" });
    if (snapshot.verified !== snapshot.generation) {
      throw new CredentialsGenerationChangedError(page.pageId, snapshot.generation, snapshot.verified);
    }
    return {
      spec: request.spec,
      url: SOCKET_OWNER_URL,
      headers: {},
      timeoutMs: REQUEST_TIMEOUT_MS,
      credentialsGeneration: snapshot.generation,
    };
  }

  async function storedGeneration(): Promise<string | null> {
    try {
      return await ctx.db.transaction(
        async (raw) => readFanslyPageGeneration(raw as unknown as Database, page.pageLabel),
        { isolationLevel: "repeatable read", accessMode: "read only" },
      );
    } catch {
      return null;
    }
  }

  return {
    async prepare(request: RequestPlan, context?: { work: SyncWorkRow }): Promise<FanslyWireRequest> {
      if (closed) throw new Error(`The live transport of page ${page.pageId} is closed`);
      switch (fanslyWireSpec(request.spec).host) {
        case "api":
          return prepareApi(request, context?.work);
        case "cdn":
          return prepareCdn(request, context?.work);
        case "ws":
          return prepareWs(request);
      }
    },
    async send(req: FanslyWireRequest, hooks: SendHooks, signal: AbortSignal): Promise<TransportOutcome> {
      switch (fanslyWireSpec(req.spec).host) {
        case "api": {
          const oneShot = candidate !== null && candidate.request === req ? candidate.dispatcher : null;
          try {
            return await sendFanslyWireRequest(oneShot ?? current.dispatcher, req, hooks, signal);
          } finally {
            if (oneShot !== null) await dropCandidate();
          }
        }
        case "cdn":
          return absoluteLocation(await sendFanslyCdnRequest(
            current.dispatcher,
            { url: req.url, timeoutMs: req.timeoutMs, maxBytes: MEDIA_DOWNLOAD_MAX_BYTES },
            hooks,
            signal,
          ), req.url);
        case "ws": {
          // Without a socket owner nothing is sent (its plan waits for one).
          const socket = options.socket?.() ?? null;
          if (socket === null) return { kind: "aborted_before_send", refusal: "lease_inactive" };
          return socket.handshake(hooks, signal, { credentialsGeneration: req.credentialsGeneration ?? null });
        }
      }
    },
    storedCredentialsGeneration: storedGeneration,
    async close() {
      closed = true;
      await dropCandidate();
      await current.egress.close().catch(() => undefined);
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
