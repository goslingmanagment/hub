import { randomUUID } from "node:crypto";

import {
  admitOfapiMediaBudget,
  applyOfapiMediaFetchReports,
  assertOfapiCollectionHeadroom,
  claimOfapiMediaFlight,
  findOfapiMediaFetchByRequest,
  getOfapiMediaBudgetUsed,
  holdOfapiMediaFlight,
  listOfapiMappedPages,
  listOfapiMediaLinks,
  listOfapiMediaLocators,
  OFAPI_MEDIA_UNKNOWN_SIZE_GUARD_BYTES,
  OFAPI_MEDIA_UNKNOWN_SIZE_GUARD_CREDITS,
  OfapiCollectionPolicyError,
  ofapiMediaTransferCredits,
  recordOfapiMediaFetch,
  refundOfapiMediaBudget,
  releaseOfapiCollectionRequest,
  upsertOfapiMediaLocators,
  releaseOfapiMediaFlight,
  settleOfapiCollectionRequest,
  type OfapiMediaFetchLogRow,
  type OfapiMediaFetchReport,
  type OfapiMediaLinkRow,
  type OfapiMediaLocatorRow,
  type OfapiMediaOutcome,
  type OfapiMediaVariant,
  type RecordOfapiCreditSpendInput,
} from "@agency_hub_core/db";
import { OFAPI_MEDIA_MAX_TRANSFER_BYTES } from "@agency_hub_core/contracts";
import { createRequestDispatcher } from "@agency_hub_core/shared";

import type { AppContext } from "../bootstrap.ts";
import type { HumanAuthPrincipal } from "./auth.ts";
import { fetchWithEgress } from "./egress/fetch.ts";
import { ConflictError, NotFoundError, ServiceUnavailableError } from "./errors.ts";
import { resolveOfapiEgressContext, type OfapiEgressContext } from "./ofapi-egress.ts";
import {
  OFAPI_CACHE_CDN_HOST,
  OFAPI_MEDIA_FULL_EXTENSIONS,
  OFAPI_STREAM_CDN_HOST,
  ofapiMediaLocatorErrorFields,
  parseOfapiMediaUrl,
} from "./ofapi-media-locators.ts";
import { OfapiApiError, OfapiCreditAccountingUnavailableError, type OfapiRawResponse } from "./ofapi.ts";
import { OfapiKeyPermissionDeniedError } from "./ofapi-vendor-usage.ts";

// Desktop media images: the hub decides, per file, how ChatGoose Desktop may
// fetch it (docs/runbooks/ofapi-media.md). Bytes never pass through the hub;
// the desktop downloads from the URL handed out here and reports the result.
//
// Decision order for one (account, media id, variant):
//   access    every link deleted / locked / never seen ready (with a re-read
//             hint for an explicit click) / non-photo full → refused
//   click     an automatic request for `full` → cap_blocked (click_only)
//   free_url  an Expires-signed OnlyFans URL (webhooks) with >120 s left
//   cache     a cdn.fansapi.com URL already known with >120 s left
//   budget    an automatic request once the day's budget is spent, or the
//             category off / at its ceiling → nothing reaches OFAPI
//   OFAPI     the freshest live OnlyFans URL through /media/download, on the
//             service's own bounded transport limiter:
//             HEAD (manual redirect) → Location host decides:
//               cdn.fansapi.com → GET (manual) for a GET-presigned URL, free
//               dl.fansapi.com  → budget and category checks → HEAD there
//                 for Content-Length → price (unknown size: a click only, at
//                 the guard price) → agency budget → GET (manual) → hand out
//                 what it returns (cdn → free, the reservation released)
//   none      source_expired (the desktop may re-read on an explicit click)

export const OFAPI_MEDIA_OUTCOMES = [
  "free_url", "ofapi_cache", "paid", "cap_blocked", "source_expired",
  "unavailable", "refused", "pending", "error",
] as const satisfies readonly OfapiMediaOutcome[];

export type OfapiMediaSurface = "thread" | "gallery" | "vault" | "lightbox";
export type OfapiMediaTrigger = "auto" | "click";

export interface OfapiMediaResolveRequest {
  requestId: string;
  accountId: string;
  mediaId: string;
  variant: OfapiMediaVariant;
  surface: OfapiMediaSurface;
  trigger: OfapiMediaTrigger;
  afterReread?: boolean | undefined;
}

export type OfapiMediaReread =
  | { kind: "message"; chatId: string; messageId: string }
  | { kind: "vault"; mediaId: string };

export interface OfapiMediaResolveResponse {
  resolveId: string;
  outcome: OfapiMediaOutcome;
  url: string | null;
  urlExpiresAt: string | null;
  contentLength: number | null;
  maxBytes: number | null;
  credits: number;
  overCap: boolean;
  reason: string | null;
  retryAfterMs: number | null;
  retryAt: string | null;
  mediaType: string | null;
  reread: OfapiMediaReread | null;
  replayed: boolean;
}

/** A free URL is handed out only with this much life left. */
const FREE_URL_MIN_REMAINING_MS = 120_000;
/** OFAPI must still be able to fetch the source right away. */
const OFAPI_SOURCE_MIN_REMAINING_MS = 30_000;
/** Single flight: held while resolving and after a paid hand-out until its report. */
export const OFAPI_MEDIA_FLIGHT_HOLD_MS = 120_000;
// A click on a file of unknown size is capped at OFAPI_MEDIA_UNKNOWN_SIZE_GUARD_BYTES
// (the desktop's memory guard) and reserved at what that can cost
// (OFAPI_MEDIA_UNKNOWN_SIZE_GUARD_CREDITS), then settled down on its report.
export { OFAPI_MEDIA_UNKNOWN_SIZE_GUARD_BYTES, OFAPI_MEDIA_UNKNOWN_SIZE_GUARD_CREDITS };
/** One resolve's network part (transport queueing included) never takes longer; the desktop waits 45 s. */
export const OFAPI_MEDIA_RESOLVE_DEADLINE_MS = 35_000;
const HOP_TIMEOUT_MS = 12_000;
const CDN_HEAD_TIMEOUT_MS = 8_000;
/** Media transport limiter: its own slots, never the OFAPI client's chat-read slot. */
const TRANSPORT_CONCURRENCY = 4;
/** At most ten transport starts a second (OFAPI's lowest plan allows 1,000 requests a minute). */
const TRANSPORT_START_SPACING_MS = 100;
const TRANSPORT_MAX_QUEUE_WAIT_MS = 8_000;
const BUSY_RETRY_AFTER_MS = 2_000;
/** Replays within this window get the same URL back (process memory only). */
const HANDOUT_REPLAY_TTL_MS = 10 * 60_000;
const HANDOUT_REPLAY_MAX = 5_000;

/** OFAPI tariff: 3 credits per decimal MB, minimum 1 per non-empty transfer. */
export function ofapiMediaDownloadPrice(contentLength: number) {
  return ofapiMediaTransferCredits(contentLength);
}

function utcDay(at: Date) {
  return at.toISOString().slice(0, 10);
}

function nextUtcMidnight(at: Date) {
  return new Date(Date.UTC(at.getUTCFullYear(), at.getUTCMonth(), at.getUTCDate() + 1));
}

function dailyCap(app: AppContext) {
  return Math.max(0, app.config.ofapiMediaDailyCapCredits ?? 100);
}

// ---- Transport limiter -----------------------------------------------------

type Release = () => void;

/**
 * A small FIFO limiter for the media transport: at most `concurrency` hops at
 * once, starts spaced by `spacingMs`, and a bounded wait — a caller that gets
 * no slot in time answers `pending` (busy) instead of queueing further.
 */
export function createOfapiMediaTransportLimiter(options: { concurrency: number; spacingMs: number }) {
  let active = 0;
  let nextStartAt = 0;
  let pump: ReturnType<typeof setTimeout> | null = null;
  let queue: Array<{ grant: () => void; settled: boolean }> = [];

  function drain() {
    if (pump !== null) return;
    queue = queue.filter((waiter) => !waiter.settled);
    if (queue.length === 0 || active >= options.concurrency) return;
    const wait = nextStartAt - Date.now();
    if (wait > 0) {
      pump = setTimeout(() => {
        pump = null;
        drain();
      }, wait);
      return;
    }
    const waiter = queue.shift()!;
    waiter.settled = true;
    active += 1;
    nextStartAt = Date.now() + options.spacingMs;
    waiter.grant();
    drain();
  }

  function acquire(waitMs: number): Promise<Release | null> {
    return new Promise((resolve) => {
      let released = false;
      const release: Release = () => {
        if (released) return;
        released = true;
        active -= 1;
        drain();
      };
      const waiter = { settled: false, grant: () => resolve(release) };
      const timer = setTimeout(() => {
        if (waiter.settled) return;
        waiter.settled = true;
        resolve(null);
      }, Math.max(0, waitMs));
      const grant = waiter.grant;
      waiter.grant = () => {
        clearTimeout(timer);
        grant();
      };
      queue.push(waiter);
      drain();
    });
  }

  return { acquire, active: () => active };
}

let transport = createOfapiMediaTransportLimiter({ concurrency: TRANSPORT_CONCURRENCY, spacingMs: TRANSPORT_START_SPACING_MS });

/** Tests shape the transport limiter (a fresh one each call); production keeps the defaults. */
export function configureOfapiMediaTransportForTests(options: { concurrency?: number; spacingMs?: number } | null) {
  transport = createOfapiMediaTransportLimiter({
    concurrency: options?.concurrency ?? TRANSPORT_CONCURRENCY,
    spacingMs: options?.spacingMs ?? TRANSPORT_START_SPACING_MS,
  });
}

// ---- CDN hop ---------------------------------------------------------------

export type OfapiMediaCdnHead = (url: URL, timeoutMs: number) => Promise<{ status: number; contentLength: number | null }>;

/** HEAD on the dl.fansapi.com Location for its size. No Authorization ever
 * travels to a CDN host; the vendor-direct route (egress resolver policy for
 * OFAPI) through the mandatory-dispatcher seam. */
const defaultCdnHead: OfapiMediaCdnHead = async (url, timeoutMs) => {
  const dispatcher = createRequestDispatcher();
  try {
    const response = await fetchWithEgress(fetch, dispatcher, url, {
      method: "HEAD",
      redirect: "manual",
      signal: AbortSignal.timeout(timeoutMs),
    });
    await response.body?.cancel().catch(() => undefined);
    const raw = response.headers.get("content-length");
    const length = raw !== null && /^\d{1,12}$/.test(raw) ? Number(raw) : null;
    return { status: response.status, contentLength: response.ok && length !== null && length > 0 ? length : null };
  } finally {
    await dispatcher.close().catch(() => undefined);
  }
};

let cdnHeadOverride: OfapiMediaCdnHead | null = null;

/** Tests replace the CDN hop; production always uses the egress seam. */
export function configureOfapiMediaCdnHeadForTests(head: OfapiMediaCdnHead | null) {
  cdnHeadOverride = head;
}

// ---- Replay memory ---------------------------------------------------------

type Handout = { url: string; urlExpiresAt: string | null; until: number };
// Process memory only: the decision log never holds a URL.
let handouts = new Map<string, Handout>();

function retainHandouts(keep: (resolveId: string, handout: Handout) => boolean) {
  handouts = new Map([...handouts].filter(([resolveId, handout]) => keep(resolveId, handout)));
}

function rememberHandout(resolveId: string, url: string, urlExpiresAt: string | null) {
  const now = Date.now();
  if (handouts.size >= HANDOUT_REPLAY_MAX) retainHandouts((_, handout) => handout.until > now);
  if (handouts.size >= HANDOUT_REPLAY_MAX) handouts = new Map([...handouts].slice(-Math.floor(HANDOUT_REPLAY_MAX / 2)));
  handouts.set(resolveId, { url, urlExpiresAt, until: now + HANDOUT_REPLAY_TTL_MS });
}

function recalledHandout(resolveId: string) {
  const value = handouts.get(resolveId);
  return value && value.until > Date.now() ? value : null;
}

// ---- Decision --------------------------------------------------------------

interface Decision {
  outcome: OfapiMediaOutcome;
  reason: string | null;
  url?: string | null;
  urlExpiresAt?: Date | null;
  contentLength?: number | null;
  maxBytes?: number | null;
  credits?: number;
  overCap?: boolean;
  retryAfterMs?: number | null;
  retryAt?: Date | null;
  certainty?: "estimated" | "confirmed" | "unknown";
  /** A paid hand-out's issuance: its budget day, its log day and its ledger time. */
  issuedAt?: Date;
  collectionRequestId?: string | null;
  ledger?: Omit<RecordOfapiCreditSpendInput, "occurredAt">;
  budget?: { day: string; price: number };
}

interface ResolveContext {
  app: AppContext;
  principal: HumanAuthPrincipal;
  pageId: number;
  input: OfapiMediaResolveRequest;
  resolveId: string;
  now: Date;
  deadline: number;
  locators: OfapiMediaLocatorRow[];
  links: OfapiMediaLinkRow[];
  cdnHead: OfapiMediaCdnHead;
}

type HopResult = (
  | { kind: "redirect"; status: number; target: "cdn" | "dl"; location: string; expiresAt: Date | null }
  | { kind: "decided"; decision: Decision }
) & { collectionRequestId?: string | null };

const busy = (): Decision => ({ outcome: "pending", reason: "busy", retryAfterMs: BUSY_RETRY_AFTER_MS });
const late = (): Decision => ({ outcome: "error", reason: "timeout" });

/** Runs one media transport step on the limiter, inside the resolve's deadline. */
async function onTransport<T>(ctx: ResolveContext, maxTimeoutMs: number, work: (timeoutMs: number) => Promise<T>):
  Promise<{ kind: "done"; value: T } | { kind: "busy" } | { kind: "late" }> {
  const left = ctx.deadline - Date.now();
  if (left <= 0) return { kind: "late" };
  const release = await transport.acquire(Math.min(TRANSPORT_MAX_QUEUE_WAIT_MS, left));
  if (!release) return ctx.deadline - Date.now() <= 0 ? { kind: "late" } : { kind: "busy" };
  try {
    const timeoutMs = Math.min(maxTimeoutMs, ctx.deadline - Date.now());
    if (timeoutMs <= 0) return { kind: "late" };
    return { kind: "done", value: await work(timeoutMs) };
  } finally {
    release();
  }
}

function classifyLocation(raw: string | undefined) {
  if (!raw) return null;
  let url: URL;
  try { url = new URL(raw); } catch { return null; }
  if (url.protocol !== "https:" || url.username !== "" || url.password !== "" || url.port !== "") return null;
  const host = url.hostname.toLowerCase();
  if (host === OFAPI_CACHE_CDN_HOST) {
    const parsed = parseOfapiMediaUrl(url.toString());
    return { target: "cdn" as const, location: url.toString(), expiresAt: parsed?.expiresAt ?? null };
  }
  if (host === OFAPI_STREAM_CDN_HOST) return { target: "dl" as const, location: url.toString(), expiresAt: null };
  return null;
}

function retryAfterMs(value: string | undefined) {
  if (!value) return null;
  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds >= 0) return Math.round(seconds * 1000);
  const at = Date.parse(value);
  return Number.isFinite(at) ? Math.max(0, at - Date.now()) : null;
}

function classifyHop(response: OfapiRawResponse): HopResult {
  const status = response.status;
  if (status >= 300 && status < 400) {
    const location = classifyLocation(response.headers.location);
    return location
      ? { kind: "redirect", status, ...location }
      : { kind: "decided", decision: { outcome: "error", reason: "unexpected_redirect" } };
  }
  const decided = (outcome: OfapiMediaOutcome, reason: string, extra: Partial<Decision> = {}): HopResult =>
    ({ kind: "decided", decision: { outcome, reason, ...extra } });
  if (status === 404 || status === 410) return decided("unavailable", "not_found");
  if (status === 401 || status === 403) return decided("unavailable", "forbidden");
  if (status === 422) return decided("unavailable", "rejected");
  if (status === 402) return decided("error", "insufficient_credits");
  if (status === 429) return decided("error", "rate_limited", { retryAfterMs: retryAfterMs(response.headers["retry-after"]) });
  if (status >= 200 && status < 300) return decided("error", "unexpected_body");
  return decided("error", "upstream_error");
}

function policyRefusal(error: OfapiCollectionPolicyError): Decision {
  // The owner's category policy (off, page ceiling, …): shown as unavailable, a click does not bypass it.
  return {
    outcome: "refused", reason: error.reason,
    retryAfterMs: error.retryAt ? Math.max(0, error.retryAt.getTime() - Date.now()) : null,
  };
}

async function hop(ctx: ResolveContext, egress: OfapiEgressContext, cdnUrl: string, method: "HEAD" | "GET",
  operation: "ofapi_media_probe" | "ofapi_media_download", reservedCredits: number): Promise<HopResult> {
  const { app, input } = ctx;
  try {
    const step = await onTransport(ctx, HOP_TIMEOUT_MS, (timeoutMs) => app.ofapi!.proxyRead!({
      pageId: ctx.pageId,
      dispatcher: egress.dispatcher,
      egressKey: egress.egressKey,
      actorUserId: ctx.principal.user.id,
      collectionContext: { category: "media_previews", purpose: "interactive", reservedCredits },
    }, {
      operation,
      // OFAPI takes the CDN URL verbatim after /media/download/ (no encoding).
      pathname: `/${encodeURIComponent(input.accountId)}/media/download/${cdnUrl}`,
      query: {},
      fallbackCredits: reservedCredits,
      fallbackEstimated: true,
      timeoutMs,
      // The download's reservation is settled here, once the Location is known.
      media: { method, settlement: operation === "ofapi_media_download" ? "caller" : "response" },
    }));
    if (step.kind === "busy") return { kind: "decided", decision: busy() };
    if (step.kind === "late") return { kind: "decided", decision: late() };
    return { ...classifyHop(step.value), collectionRequestId: step.value.collectionRequestId ?? null };
  } catch (error) {
    if (error instanceof OfapiCollectionPolicyError) return { kind: "decided", decision: policyRefusal(error) };
    if (error instanceof OfapiKeyPermissionDeniedError) return { kind: "decided", decision: { outcome: "unavailable", reason: "key_scope" } };
    if (error instanceof OfapiCreditAccountingUnavailableError) return { kind: "decided", decision: { outcome: "error", reason: "accounting_unavailable" } };
    if (error instanceof OfapiApiError && error.status === 409) return { kind: "decided", decision: { outcome: "unavailable", reason: "binding_unavailable" } };
    if (error instanceof OfapiApiError && error.status === null) return { kind: "decided", decision: { outcome: "error", reason: "transport" } };
    app.logger.warn({ resolveId: ctx.resolveId, operation, errorName: error instanceof Error ? error.name : typeof error },
      "OFAPI media hop failed");
    return { kind: "decided", decision: { outcome: "error", reason: "internal" } };
  }
}

/** Settles or releases a paid download's collection reservation; never fails the resolve. */
async function closeReservation(ctx: ResolveContext, requestId: string | null | undefined, how: "release" | { credits: number | null }) {
  if (!requestId) return;
  try {
    if (how === "release") await releaseOfapiCollectionRequest(ctx.app.db, requestId);
    else await settleOfapiCollectionRequest(ctx.app.db, requestId, how.credits);
  } catch (error) {
    ctx.app.logger.warn({ resolveId: ctx.resolveId, errorName: error instanceof Error ? error.name : typeof error },
      "OFAPI media collection settlement failed");
  }
}

/**
 * The checks that must pass before a network call that can lead to a charge:
 * an automatic request once the day's budget cannot take even 1 credit, and
 * the category off or without room for `credits`.
 */
async function preflight(ctx: ResolveContext, credits: number): Promise<Decision | null> {
  const { app, input } = ctx;
  if (input.trigger === "auto") {
    const now = new Date();
    const used = await getOfapiMediaBudgetUsed(app.db, utcDay(now));
    if (used + 1 > dailyCap(app)) return { outcome: "cap_blocked", reason: "daily_cap", retryAt: nextUtcMidnight(now) };
  }
  try {
    await assertOfapiCollectionHeadroom(app.db, { pageId: ctx.pageId, category: "media_previews", credits });
  } catch (error) {
    if (error instanceof OfapiCollectionPolicyError) return policyRefusal(error);
    throw error;
  }
  return null;
}

function rereadHint(ctx: ResolveContext): OfapiMediaReread | null {
  const live = ctx.links.filter((link) => !link.deleted);
  const message = live.find((link) => link.messageId && link.chatId);
  if (message) return { kind: "message", chatId: message.chatId!, messageId: message.messageId! };
  if (live.some((link) => link.linkKey === "vault")) return { kind: "vault", mediaId: ctx.input.mediaId };
  // Locators recorded before links existed.
  const row = ctx.locators.find((locator) => locator.chatId && locator.messageId);
  if (row) return { kind: "message", chatId: row.chatId!, messageId: row.messageId! };
  return ctx.locators.some((locator) => locator.vaultMedia) ? { kind: "vault", mediaId: ctx.input.mediaId } : null;
}

function remainingMs(row: OfapiMediaLocatorRow, now: Date) {
  return row.expiresAt ? row.expiresAt.getTime() - now.getTime() : -Infinity;
}

function freshest(rows: OfapiMediaLocatorRow[], predicate: (row: OfapiMediaLocatorRow) => boolean) {
  return rows.filter(predicate).sort((a, b) => (b.expiresAt?.getTime() ?? 0) - (a.expiresAt?.getTime() ?? 0))[0] ?? null;
}

async function paidPath(ctx: ResolveContext, egress: OfapiEgressContext, sourceUrl: string, priceLocation: string): Promise<Decision> {
  const { app, input } = ctx;
  // Before the CDN hop: nothing more once the automatic budget or the
  // category cannot take a download at all.
  const blocked = await preflight(ctx, 1);
  if (blocked) return blocked;
  const size = await onTransport(ctx, CDN_HEAD_TIMEOUT_MS, (timeoutMs) => ctx.cdnHead(new URL(priceLocation), timeoutMs)
    .catch(() => ({ status: 0, contentLength: null })));
  if (size.kind === "busy") return busy();
  if (size.kind === "late") return late();
  const contentLength = size.value.contentLength;
  if (contentLength === null && input.trigger === "auto") {
    // Unknown size: never an automatic payment, only an explicit click.
    return { outcome: "cap_blocked", reason: "size_unknown" };
  }
  if (contentLength !== null && contentLength > OFAPI_MEDIA_MAX_TRANSFER_BYTES) {
    // Larger than any file the desktop takes: never bought, click or not.
    return { outcome: "refused", reason: "too_large", contentLength };
  }
  // A click of unknown size is reserved at what the guard lets through and
  // settled to its reported bytes: the budget and the category never
  // under-count what can be spent.
  const price = contentLength === null ? OFAPI_MEDIA_UNKNOWN_SIZE_GUARD_CREDITS : ofapiMediaDownloadPrice(contentLength);
  const issuedAt = new Date();
  const day = utcDay(issuedAt);
  const admission = await admitOfapiMediaBudget(app.db, { day, price, cap: dailyCap(app), trigger: input.trigger });
  if (!admission.admitted) {
    return { outcome: "cap_blocked", reason: "daily_cap", contentLength, retryAt: nextUtcMidnight(issuedAt) };
  }
  let handedOut = false;
  try {
    const get = await hop(ctx, egress, sourceUrl, "GET", "ofapi_media_download", price);
    if (get.kind === "decided") {
      // A failed download handed nothing out: like the admission (returned
      // below), its category reservation is released, so a later real
      // download is not refused by a false daily_limit.
      await closeReservation(ctx, get.collectionRequestId, "release");
      return { ...get.decision, contentLength };
    }
    if (get.target === "cdn") {
      // Cached meanwhile: free. The admission is returned below, the category reservation here.
      await closeReservation(ctx, get.collectionRequestId, "release");
      return { outcome: "ofapi_cache", reason: null, url: get.location, urlExpiresAt: get.expiresAt, contentLength };
    }
    handedOut = true;
    await closeReservation(ctx, get.collectionRequestId, { credits: price });
    const maxBytes = contentLength ?? OFAPI_MEDIA_UNKNOWN_SIZE_GUARD_BYTES;
    return {
      outcome: "paid", reason: null, url: get.location, urlExpiresAt: null, contentLength, maxBytes,
      credits: price, overCap: admission.overCap, certainty: "estimated", issuedAt,
      collectionRequestId: get.collectionRequestId ?? null, budget: { day, price },
      ledger: {
        operation: "ofapi_media_download", pageId: ctx.pageId, httpStatus: get.status, credits: price,
        estimated: true, requestId: `ofapi_media_download:${ctx.resolveId}`, actorUserId: ctx.principal.user.id,
        details: {
          resolveId: ctx.resolveId, surface: input.surface, trigger: input.trigger, variant: input.variant,
          contentLength, overCap: admission.overCap,
          ...(contentLength === null ? { sizeUnknown: true, guardBytes: maxBytes, settledOnReport: true } : {}),
        },
      },
    };
  } finally {
    if (!handedOut) {
      // Nothing was handed out: the admission is returned. A hand-out keeps
      // its charge until its report (an unknown-size click is settled then).
      await refundOfapiMediaBudget(app.db, { day, price }).catch((error: unknown) => {
        app.logger.warn({ resolveId: ctx.resolveId, errorName: error instanceof Error ? error.name : typeof error },
          "OFAPI media budget refund failed");
      });
    }
  }
}

async function viaOfapi(ctx: ResolveContext, sourceUrl: string): Promise<Decision> {
  const { app, input, pageId } = ctx;
  const egress = await resolveOfapiEgressContext(app, { pageId, ofapiAccountId: input.accountId });
  try {
    const probe = await hop(ctx, egress, sourceUrl, "HEAD", "ofapi_media_probe", 0);
    if (probe.kind === "decided") return probe.decision;
    if (probe.target === "dl") return await paidPath(ctx, egress, sourceUrl, probe.location);
    // Cached at OFAPI: the HEAD's Location is presigned for HEAD; a GET
    // returns one presigned for GET. Still free.
    const get = await hop(ctx, egress, sourceUrl, "GET", "ofapi_media_probe", 0);
    if (get.kind === "decided") return get.decision;
    if (get.target === "cdn") {
      return { outcome: "ofapi_cache", reason: null, url: get.location, urlExpiresAt: get.expiresAt };
    }
    // The cache moved on between the two lookups: price it like any dl.
    return await paidPath(ctx, egress, sourceUrl, get.location);
  } finally {
    await egress.close().catch(() => undefined);
  }
}

type DecisionResult = Decision & { hadFreeUrlExpired: boolean; reread: OfapiMediaReread | null };

async function decide(ctx: ResolveContext): Promise<DecisionResult> {
  const { app, input, locators, links, now } = ctx;
  const rows = locators.filter((row) => row.variant === input.variant);
  const hadFreeUrlExpired = rows.some((row) => row.hadFreeUrl);
  const done = (decision: Decision, reread: OfapiMediaReread | null = null) => ({ ...decision, hadFreeUrlExpired: false, reread });
  if (locators.length === 0) return { outcome: "source_expired", reason: "unknown_media", hadFreeUrlExpired: false, reread: null };
  // A media is deleted once every place it appeared is deleted (shared media
  // keep their other messages and the vault).
  if (links.length > 0 && links.every((link) => link.deleted)) return done({ outcome: "refused", reason: "deleted" });
  const access = locators.find((row) => row.canView !== null);
  if (access?.canView === false) return done({ outcome: "refused", reason: "locked" });
  // Readiness is monotonic: any ready observation wins over a late or old
  // "processing" one. Not ready yet: an explicit click may re-read the named
  // message or vault item (media-context) and ask again; never automatically.
  if (!locators.some((row) => row.isReady === true) && locators.some((row) => row.isReady === false)) {
    return done({ outcome: "refused", reason: "not_ready" }, rereadHint(ctx));
  }
  const mediaType = locators.find((row) => row.mediaType)?.mediaType ?? null;
  if (input.variant === "full") {
    const ext = rows.find((row) => row.fileExt)?.fileExt ?? null;
    if (mediaType !== "photo" || (ext !== null && !OFAPI_MEDIA_FULL_EXTENSIONS.has(ext))) {
      return done({ outcome: "refused", reason: "variant_not_allowed" });
    }
    // The full file is loaded on an explicit click only (server-side rule).
    if (input.trigger !== "click") return done({ outcome: "cap_blocked", reason: "click_only" });
  }
  const live = rows.filter((row) => row.url !== null);
  const free = freshest(live, (row) => row.sigKind === "expires" && remainingMs(row, now) > FREE_URL_MIN_REMAINING_MS
    && parseOfapiMediaUrl(row.url)?.host === "onlyfans");
  if (free) return done({ outcome: "free_url", reason: null, url: free.url, urlExpiresAt: free.expiresAt });
  const cached = freshest(live, (row) => row.sigKind === "fansapi" && remainingMs(row, now) > FREE_URL_MIN_REMAINING_MS);
  if (cached) return done({ outcome: "ofapi_cache", reason: null, url: cached.url, urlExpiresAt: cached.expiresAt });
  const source = freshest(live, (row) => (row.sigKind === "expires" || row.sigKind === "policy")
    && remainingMs(row, now) > OFAPI_SOURCE_MIN_REMAINING_MS && parseOfapiMediaUrl(row.url)?.host === "onlyfans");
  if (!source) {
    return { outcome: "source_expired", reason: rows.length > 0 ? "expired" : "no_variant_url", hadFreeUrlExpired, reread: rereadHint(ctx) };
  }
  if (!app.ofapi?.proxyRead || app.config.ofapiCreditLedgerEnabled !== true) {
    return { outcome: "unavailable", reason: "ofapi_unavailable", hadFreeUrlExpired, reread: null };
  }
  // Before any network call: an automatic request once the budget is spent,
  // and the category off, never reach OFAPI.
  const blocked = await preflight(ctx, 0);
  if (blocked) return { ...blocked, hadFreeUrlExpired, reread: null };
  const flightKey = `${input.accountId}|${input.mediaId}|${input.variant}`;
  const claim = await claimOfapiMediaFlight(app.db, { flightKey, resolveId: ctx.resolveId, holdMs: OFAPI_MEDIA_FLIGHT_HOLD_MS });
  if (!claim.claimed) {
    const wait = Math.min(OFAPI_MEDIA_FLIGHT_HOLD_MS, Math.max(1_000, claim.heldUntil.getTime() - Date.now()));
    return { outcome: "pending", reason: "in_flight", retryAfterMs: wait, hadFreeUrlExpired, reread: null };
  }
  let keep = false;
  try {
    const decision = await viaOfapi(ctx, source.url!);
    keep = decision.outcome === "paid";
    return { ...decision, hadFreeUrlExpired, reread: decision.outcome === "source_expired" ? rereadHint(ctx) : null };
  } finally {
    if (keep) {
      await holdOfapiMediaFlight(app.db, { resolveId: ctx.resolveId, holdMs: OFAPI_MEDIA_FLIGHT_HOLD_MS }).catch(() => undefined);
    } else {
      await releaseOfapiMediaFlight(app.db, [ctx.resolveId]).catch(() => undefined);
    }
  }
}

async function persistFansapiHandout(app: AppContext, ctx: ResolveContext, url: string) {
  const parsed = parseOfapiMediaUrl(url);
  if (!parsed || parsed.host !== "fansapi" || parsed.sigKind !== "fansapi") return;
  const known = ctx.locators.find((row) => row.variant === ctx.input.variant) ?? ctx.locators[0];
  try {
    await upsertOfapiMediaLocators(app.db, [{
      ofapiAccountId: ctx.input.accountId, mediaId: ctx.input.mediaId, variant: ctx.input.variant,
      source: "resolve", pageId: ctx.pageId, url: parsed.url, pathSha256: parsed.pathSha256,
      sigKind: parsed.sigKind, expiresAt: parsed.expiresAt, mediaType: known?.mediaType ?? null,
      fileExt: parsed.fileExt, chatId: known?.chatId ?? null, messageId: known?.messageId ?? null,
      vaultMedia: known?.vaultMedia ?? false, canView: known?.canView ?? null, isReady: known?.isReady ?? null,
      observedAt: new Date(),
    }]);
  } catch (error) {
    app.logger.warn({ ...ofapiMediaLocatorErrorFields(error), resolveId: ctx.resolveId },
      "OFAPI cache hand-out locator upsert failed; continuing");
  }
}

function replayResponse(row: OfapiMediaFetchLogRow): OfapiMediaResolveResponse {
  const handout = ["free_url", "ofapi_cache", "paid"].includes(row.outcome) ? recalledHandout(row.resolveId) : null;
  return {
    resolveId: row.resolveId,
    outcome: row.outcome,
    url: handout?.url ?? null,
    urlExpiresAt: handout?.urlExpiresAt ?? null,
    contentLength: row.contentLength,
    maxBytes: row.outcome === "paid" ? row.contentLength ?? OFAPI_MEDIA_UNKNOWN_SIZE_GUARD_BYTES : null,
    credits: row.creditsEstimated,
    overCap: row.overCap,
    reason: row.reason,
    retryAfterMs: row.outcome === "pending" ? 1_000 : null,
    retryAt: row.outcome === "cap_blocked" && row.reason === "daily_cap" ? nextUtcMidnight(row.occurredAt).toISOString() : null,
    mediaType: row.mediaType,
    reread: null,
    replayed: true,
  };
}

/** A requestId names one file: a repeat for another file is refused, never answered. */
function assertSameFile(recorded: { accountId: string; mediaId: string; variant: OfapiMediaVariant }, input: OfapiMediaResolveRequest) {
  if (recorded.accountId !== input.accountId || recorded.mediaId !== input.mediaId || recorded.variant !== input.variant) {
    throw new ConflictError("This requestId was already used for another file", { reason: "request_id_reused" });
  }
}

// Concurrent requests with the same requestId (the desktop retrying a lost
// response) join the one in flight instead of racing it.
type InFlight = { file: { accountId: string; mediaId: string; variant: OfapiMediaVariant }; answer: Promise<OfapiMediaResolveResponse> };
let inFlight = new Map<string, InFlight>();

/**
 * Resolves one media file for the calling chatter. Idempotent by the client's
 * requestId: a repeat (or a concurrent twin) returns the recorded answer
 * without a second charge; a requestId reused for another file is a 409. A
 * `pending` answer is final for its requestId; retry with a new one.
 */
export async function resolveOfapiMedia(
  app: AppContext,
  principal: HumanAuthPrincipal,
  input: OfapiMediaResolveRequest,
): Promise<OfapiMediaResolveResponse> {
  if (app.config.ofapiDesktopReadGatewayEnabled !== true) {
    throw new ServiceUnavailableError("OFAPI desktop read gateway is disabled");
  }
  // The same account grant as the read gateway.
  const pages = await listOfapiMappedPages(app.db);
  const page = pages.find((candidate) => principal.assignedPageIds.includes(candidate.id)
    && candidate.ofapiAccountId === input.accountId);
  if (!page) throw new NotFoundError("OFAPI account is not assigned to this chatter");

  const key = `${principal.user.id}|${input.requestId}`;
  const join = async (twin: InFlight) => {
    assertSameFile(twin.file, input);
    return { ...(await twin.answer), replayed: true };
  };
  const running = inFlight.get(key);
  if (running) return join(running);
  const recorded = await findOfapiMediaFetchByRequest(app.db, { actorUserId: principal.user.id, clientRequestId: input.requestId });
  if (recorded) {
    assertSameFile({ accountId: recorded.ofapiAccountId, mediaId: recorded.mediaId, variant: recorded.variant }, input);
    return replayResponse(recorded);
  }
  const twin = inFlight.get(key);
  if (twin) return join(twin);
  const answer = resolveFresh(app, principal, page.id, input);
  inFlight.set(key, { file: { accountId: input.accountId, mediaId: input.mediaId, variant: input.variant }, answer });
  try {
    return await answer;
  } finally {
    inFlight = new Map([...inFlight].filter(([entry]) => entry !== key));
  }
}

async function resolveFresh(app: AppContext, principal: HumanAuthPrincipal, pageId: number, input: OfapiMediaResolveRequest) {
  const now = new Date();
  const ctx: ResolveContext = {
    app, principal, pageId, input, resolveId: randomUUID(), now, deadline: now.getTime() + OFAPI_MEDIA_RESOLVE_DEADLINE_MS,
    locators: await listOfapiMediaLocators(app.db, { ofapiAccountId: input.accountId, mediaId: input.mediaId }),
    links: await listOfapiMediaLinks(app.db, { ofapiAccountId: input.accountId, mediaId: input.mediaId }),
    cdnHead: cdnHeadOverride ?? defaultCdnHead,
  };
  const decision = await decide(ctx);
  // One timestamp per hand-out: a paid one is logged, ledgered and budgeted on its issuance day.
  const occurredAt = decision.outcome === "paid" && decision.issuedAt ? decision.issuedAt : new Date();
  const variantRows = ctx.locators.filter((row) => row.variant === input.variant);
  const mediaType = ctx.locators.find((row) => row.mediaType)?.mediaType ?? null;
  const credits = decision.outcome === "paid" ? decision.credits ?? 0 : 0;
  const giveBack = async () => {
    if (decision.budget) await refundOfapiMediaBudget(app.db, decision.budget).catch(() => undefined);
    await releaseOfapiMediaFlight(app.db, [ctx.resolveId]).catch(() => undefined);
  };
  let written: Awaited<ReturnType<typeof recordOfapiMediaFetch>>;
  try {
    written = await recordOfapiMediaFetch(app.db, {
      log: {
        resolveId: ctx.resolveId, clientRequestId: input.requestId, occurredAt,
        accrualDay: utcDay(occurredAt), pageId, ofapiAccountId: input.accountId,
        actorUserId: principal.user.id, surface: input.surface, trigger: input.trigger, mediaId: input.mediaId,
        mediaType, variant: input.variant,
        pathSha256: variantRows.find((row) => row.pathSha256)?.pathSha256 ?? null,
        outcome: decision.outcome, reason: decision.reason, contentLength: decision.contentLength ?? null,
        creditsEstimated: credits, overCap: decision.overCap ?? false,
        hadFreeUrlExpired: decision.hadFreeUrlExpired, afterReread: input.afterReread === true,
        certainty: decision.certainty ?? "confirmed",
        collectionRequestId: decision.outcome === "paid" ? decision.collectionRequestId ?? null : null,
      },
      ledger: decision.outcome === "paid" ? decision.ledger ?? null : null,
    });
  } catch (error) {
    // Nothing reaches the desktop, so nothing may stay charged.
    await giveBack();
    throw error;
  }
  if (written === null) {
    // Another process answered this requestId first.
    await giveBack();
    const winner = await findOfapiMediaFetchByRequest(app.db, { actorUserId: principal.user.id, clientRequestId: input.requestId });
    if (winner) {
      assertSameFile({ accountId: winner.ofapiAccountId, mediaId: winner.mediaId, variant: winner.variant }, input);
      return replayResponse(winner);
    }
    throw new ServiceUnavailableError("OFAPI media resolve could not be recorded");
  }
  const urlExpiresAt = decision.urlExpiresAt ? decision.urlExpiresAt.toISOString() : null;
  if (decision.url) rememberHandout(ctx.resolveId, decision.url, urlExpiresAt);
  if (decision.outcome === "ofapi_cache" && decision.url) {
    // AI media describer (0216): an OFAPI cache URL is free and readable from
    // any address; keep it as a locator so the describer (which never calls
    // OFAPI) can reuse it. Fail-open: never affects the desktop answer.
    await persistFansapiHandout(app, ctx, decision.url);
  }
  return {
    resolveId: ctx.resolveId,
    outcome: decision.outcome,
    url: decision.url ?? null,
    urlExpiresAt,
    contentLength: decision.contentLength ?? null,
    maxBytes: decision.maxBytes ?? null,
    credits,
    overCap: decision.overCap ?? false,
    reason: decision.reason,
    retryAfterMs: decision.retryAfterMs ?? null,
    retryAt: decision.retryAt ? decision.retryAt.toISOString() : null,
    mediaType,
    reread: decision.reread,
    replayed: false,
  } satisfies OfapiMediaResolveResponse;
}

/** Batched desktop transfer reports; idempotent by resolveId. */
export async function reportOfapiMediaFetches(
  app: AppContext,
  principal: HumanAuthPrincipal,
  reports: readonly OfapiMediaFetchReport[],
) {
  const result = await applyOfapiMediaFetchReports(app.db, { actorUserId: principal.user.id, reports });
  const reported = new Set(reports.map((report) => report.resolveId));
  retainHandouts((resolveId) => !reported.has(resolveId));
  return result;
}
