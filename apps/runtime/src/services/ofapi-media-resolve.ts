import { randomUUID } from "node:crypto";

import {
  admitOfapiMediaBudget,
  applyOfapiMediaFetchReports,
  claimOfapiMediaFlight,
  findOfapiMediaFetchByRequest,
  holdOfapiMediaFlight,
  listOfapiMappedPages,
  listOfapiMediaLocators,
  OfapiCollectionPolicyError,
  recordOfapiMediaFetch,
  refundOfapiMediaBudget,
  releaseOfapiMediaFlight,
  type OfapiMediaFetchLogRow,
  type OfapiMediaFetchReport,
  type OfapiMediaLocatorRow,
  type OfapiMediaOutcome,
  type OfapiMediaVariant,
  type RecordOfapiCreditSpendInput,
} from "@agency_hub_core/db";
import { createRequestDispatcher } from "@agency_hub_core/shared";

import type { AppContext } from "../bootstrap.ts";
import type { HumanAuthPrincipal } from "./auth.ts";
import { fetchWithEgress } from "./egress/fetch.ts";
import { NotFoundError, ServiceUnavailableError } from "./errors.ts";
import { resolveOfapiEgressContext, type OfapiEgressContext } from "./ofapi-egress.ts";
import {
  OFAPI_CACHE_CDN_HOST,
  OFAPI_MEDIA_FULL_EXTENSIONS,
  OFAPI_STREAM_CDN_HOST,
  parseOfapiMediaUrl,
} from "./ofapi-media-locators.ts";
import { OfapiApiError, OfapiCreditAccountingUnavailableError, type OfapiRawResponse } from "./ofapi.ts";
import { OfapiKeyPermissionDeniedError } from "./ofapi-vendor-usage.ts";

// Desktop media images: the hub decides, per file, how ChatGoose Desktop may
// fetch it (docs/runbooks/ofapi-media.md). Bytes never pass through the hub;
// the desktop downloads from the URL handed out here and reports the result.
//
// Decision order for one (account, media id, variant):
//   access    deleted / locked / processing / non-photo full → refused
//   free_url  an Expires-signed OnlyFans URL (webhooks) with >120 s left
//   cache     a cdn.fansapi.com URL already known with >120 s left
//   OFAPI     the freshest live OnlyFans URL through /media/download:
//             HEAD (manual redirect) → Location host decides:
//               cdn.fansapi.com → GET (manual) for a GET-presigned URL, free
//               dl.fansapi.com  → HEAD there for Content-Length → price →
//                 agency budget → GET (manual) → hand out what it returns
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
/** A click on a file of unknown size is capped here (memory guard, not a price). */
export const OFAPI_MEDIA_UNKNOWN_SIZE_GUARD_BYTES = 5_000_000;
const HOP_TIMEOUT_MS = 15_000;
const CDN_HEAD_TIMEOUT_MS = 10_000;
/** Replays within this window get the same URL back (process memory only). */
const HANDOUT_REPLAY_TTL_MS = 10 * 60_000;
const HANDOUT_REPLAY_MAX = 5_000;

/** OFAPI tariff: 3 credits per decimal MB, minimum 1 per non-empty transfer. */
export function ofapiMediaDownloadPrice(contentLength: number) {
  return Math.max(1, Math.ceil((3 * contentLength) / 1_000_000));
}

function utcDay(at: Date) {
  return at.toISOString().slice(0, 10);
}

function nextUtcMidnight(at: Date) {
  return new Date(Date.UTC(at.getUTCFullYear(), at.getUTCMonth(), at.getUTCDate() + 1));
}

// ---- CDN hop ---------------------------------------------------------------

export type OfapiMediaCdnHead = (url: URL) => Promise<{ status: number; contentLength: number | null }>;

/** HEAD on the dl.fansapi.com Location for its size. No Authorization ever
 * travels to a CDN host; the vendor-direct route (egress resolver policy for
 * OFAPI) through the mandatory-dispatcher seam. */
const defaultCdnHead: OfapiMediaCdnHead = async (url) => {
  const dispatcher = createRequestDispatcher();
  try {
    const response = await fetchWithEgress(fetch, dispatcher, url, {
      method: "HEAD",
      redirect: "manual",
      signal: AbortSignal.timeout(CDN_HEAD_TIMEOUT_MS),
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
  accrualDay?: string;
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
  locators: OfapiMediaLocatorRow[];
  cdnHead: OfapiMediaCdnHead;
}

type HopResult =
  | { kind: "redirect"; status: number; target: "cdn" | "dl"; location: string; expiresAt: Date | null }
  | { kind: "decided"; decision: Decision };

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

async function hop(ctx: ResolveContext, egress: OfapiEgressContext, cdnUrl: string, method: "HEAD" | "GET",
  operation: "ofapi_media_probe" | "ofapi_media_download", reservedCredits: number): Promise<HopResult> {
  const { app, input } = ctx;
  try {
    const response = await app.ofapi!.proxyRead!({
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
      timeoutMs: HOP_TIMEOUT_MS,
      media: { method },
    });
    return classifyHop(response);
  } catch (error) {
    if (error instanceof OfapiCollectionPolicyError) {
      // The owner's category policy (off, page ceiling, …): shown as unavailable, a click does not bypass it.
      return { kind: "decided", decision: { outcome: "refused", reason: error.reason,
        retryAfterMs: error.retryAt ? Math.max(0, error.retryAt.getTime() - Date.now()) : null } };
    }
    if (error instanceof OfapiKeyPermissionDeniedError) return { kind: "decided", decision: { outcome: "unavailable", reason: "key_scope" } };
    if (error instanceof OfapiCreditAccountingUnavailableError) return { kind: "decided", decision: { outcome: "error", reason: "accounting_unavailable" } };
    if (error instanceof OfapiApiError && error.status === 409) return { kind: "decided", decision: { outcome: "unavailable", reason: "binding_unavailable" } };
    if (error instanceof OfapiApiError && error.status === null) return { kind: "decided", decision: { outcome: "error", reason: "transport" } };
    app.logger.warn({ resolveId: ctx.resolveId, operation, errorName: error instanceof Error ? error.name : typeof error },
      "OFAPI media hop failed");
    return { kind: "decided", decision: { outcome: "error", reason: "internal" } };
  }
}

function newestRow(rows: OfapiMediaLocatorRow[]) {
  return rows.reduce<OfapiMediaLocatorRow | null>((newest, row) =>
    newest === null || row.observedAt.getTime() > newest.observedAt.getTime() ? row : newest, null);
}

function rereadHint(rows: OfapiMediaLocatorRow[], mediaId: string): OfapiMediaReread | null {
  const inMessage = rows.find((row) => row.chatId && row.messageId);
  if (inMessage) return { kind: "message", chatId: inMessage.chatId!, messageId: inMessage.messageId! };
  return rows.some((row) => row.vaultMedia) ? { kind: "vault", mediaId } : null;
}

function remainingMs(row: OfapiMediaLocatorRow, now: Date) {
  return row.expiresAt ? row.expiresAt.getTime() - now.getTime() : -Infinity;
}

function freshest(rows: OfapiMediaLocatorRow[], predicate: (row: OfapiMediaLocatorRow) => boolean) {
  return rows.filter(predicate).sort((a, b) => (b.expiresAt?.getTime() ?? 0) - (a.expiresAt?.getTime() ?? 0))[0] ?? null;
}

async function paidPath(ctx: ResolveContext, egress: OfapiEgressContext, sourceUrl: string, priceLocation: string): Promise<Decision> {
  const { app, input } = ctx;
  let head: { status: number; contentLength: number | null };
  try {
    head = await ctx.cdnHead(new URL(priceLocation));
  } catch {
    head = { status: 0, contentLength: null };
  }
  const contentLength = head.contentLength;
  if (contentLength === null && input.trigger === "auto") {
    // Unknown size: never an automatic payment, only an explicit click.
    return { outcome: "cap_blocked", reason: "size_unknown" };
  }
  const price = contentLength === null ? 1 : ofapiMediaDownloadPrice(contentLength);
  const day = utcDay(new Date());
  const cap = Math.max(0, app.config.ofapiMediaDailyCapCredits ?? 100);
  const admission = await admitOfapiMediaBudget(app.db, { day, price, cap, trigger: input.trigger });
  if (!admission.admitted) {
    return { outcome: "cap_blocked", reason: "daily_cap", contentLength, retryAt: nextUtcMidnight(new Date()) };
  }
  let handedOut = false;
  try {
    const get = await hop(ctx, egress, sourceUrl, "GET", "ofapi_media_download", price);
    if (get.kind === "decided") return { ...get.decision, contentLength };
    if (get.target === "cdn") {
      // Cached meanwhile: free, the admission is returned below.
      return { outcome: "ofapi_cache", reason: null, url: get.location, urlExpiresAt: get.expiresAt, contentLength };
    }
    handedOut = true;
    return {
      outcome: "paid", reason: null, url: get.location, urlExpiresAt: null, contentLength,
      maxBytes: contentLength ?? OFAPI_MEDIA_UNKNOWN_SIZE_GUARD_BYTES, credits: price, overCap: admission.overCap,
      certainty: "estimated", accrualDay: day, budget: { day, price },
      ledger: {
        operation: "ofapi_media_download", pageId: ctx.pageId, httpStatus: get.status, credits: price,
        estimated: true, requestId: `ofapi_media_download:${ctx.resolveId}`, actorUserId: ctx.principal.user.id,
        details: { resolveId: ctx.resolveId, surface: input.surface, trigger: input.trigger, variant: input.variant,
          contentLength, overCap: admission.overCap },
      },
    };
  } finally {
    if (!handedOut) {
      // Nothing was handed out: the admission is returned. A hand-out keeps
      // its charge until reconciliation, whatever the desktop reports.
      await refundOfapiMediaBudget(app.db, { day, price }).catch((error) => {
        app.logger.warn({ err: error, resolveId: ctx.resolveId }, "OFAPI media budget refund failed");
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

async function decide(ctx: ResolveContext): Promise<Decision & { hadFreeUrlExpired: boolean; reread: OfapiMediaReread | null }> {
  const { app, input, locators, now } = ctx;
  const newest = newestRow(locators);
  const rows = locators.filter((row) => row.variant === input.variant);
  const reread = rereadHint(locators, input.mediaId);
  const hadFreeUrlExpired = rows.some((row) => row.hadFreeUrl);
  const done = (decision: Decision) => ({ ...decision, hadFreeUrlExpired: false, reread: null });
  if (!newest) return { outcome: "source_expired", reason: "unknown_media", hadFreeUrlExpired: false, reread: null };
  if (newest.deleted) return done({ outcome: "refused", reason: "deleted" });
  if (newest.canView === false) return done({ outcome: "refused", reason: "locked" });
  if (newest.isReady === false) return done({ outcome: "refused", reason: "not_ready" });
  if (input.variant === "full") {
    const ext = rows.find((row) => row.fileExt)?.fileExt ?? null;
    if (newest.mediaType !== "photo" || (ext !== null && !OFAPI_MEDIA_FULL_EXTENSIONS.has(ext))) {
      return done({ outcome: "refused", reason: "variant_not_allowed" });
    }
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
    return { outcome: "source_expired", reason: rows.length > 0 ? "expired" : "no_variant_url", hadFreeUrlExpired, reread };
  }
  if (!app.ofapi?.proxyRead || app.config.ofapiCreditLedgerEnabled !== true) {
    return { outcome: "unavailable", reason: "ofapi_unavailable", hadFreeUrlExpired, reread: null };
  }
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
    return { ...decision, hadFreeUrlExpired, reread: decision.outcome === "source_expired" ? reread : null };
  } finally {
    if (keep) {
      await holdOfapiMediaFlight(app.db, { resolveId: ctx.resolveId, holdMs: OFAPI_MEDIA_FLIGHT_HOLD_MS }).catch(() => undefined);
    } else {
      await releaseOfapiMediaFlight(app.db, [ctx.resolveId]).catch(() => undefined);
    }
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

/**
 * Resolves one media file for the calling chatter. Idempotent by the client's
 * requestId: a repeat returns the recorded answer without a second charge. A
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

  const recorded = await findOfapiMediaFetchByRequest(app.db, { actorUserId: principal.user.id, clientRequestId: input.requestId });
  if (recorded) return replayResponse(recorded);

  const ctx: ResolveContext = {
    app, principal, pageId: page.id, input, resolveId: randomUUID(), now: new Date(),
    locators: await listOfapiMediaLocators(app.db, { ofapiAccountId: input.accountId, mediaId: input.mediaId }),
    cdnHead: cdnHeadOverride ?? defaultCdnHead,
  };
  const decision = await decide(ctx);
  const occurredAt = new Date();
  const variantRows = ctx.locators.filter((row) => row.variant === input.variant);
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
        accrualDay: decision.accrualDay ?? utcDay(occurredAt), pageId: page.id, ofapiAccountId: input.accountId,
        actorUserId: principal.user.id, surface: input.surface, trigger: input.trigger, mediaId: input.mediaId,
        mediaType: newestRow(ctx.locators)?.mediaType ?? null, variant: input.variant,
        pathSha256: variantRows.find((row) => row.pathSha256)?.pathSha256 ?? null,
        outcome: decision.outcome, reason: decision.reason, contentLength: decision.contentLength ?? null,
        creditsEstimated: credits, overCap: decision.overCap ?? false,
        hadFreeUrlExpired: decision.hadFreeUrlExpired, afterReread: input.afterReread === true,
        certainty: decision.certainty ?? "confirmed",
      },
      ledger: decision.outcome === "paid" ? decision.ledger ?? null : null,
    });
  } catch (error) {
    // Nothing reaches the desktop, so nothing may stay charged.
    await giveBack();
    throw error;
  }
  if (written === null) {
    // A concurrent resolve with the same requestId answered first.
    await giveBack();
    const winner = await findOfapiMediaFetchByRequest(app.db, { actorUserId: principal.user.id, clientRequestId: input.requestId });
    if (winner) return replayResponse(winner);
    throw new ServiceUnavailableError("OFAPI media resolve could not be recorded");
  }
  const urlExpiresAt = decision.urlExpiresAt ? decision.urlExpiresAt.toISOString() : null;
  if (decision.url) rememberHandout(ctx.resolveId, decision.url, urlExpiresAt);
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
    mediaType: newestRow(ctx.locators)?.mediaType ?? null,
    reread: decision.reread,
    replayed: false,
  };
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
