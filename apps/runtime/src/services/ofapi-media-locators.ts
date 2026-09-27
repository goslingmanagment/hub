import { createHash } from "node:crypto";

import {
  capturePayloadRefFromColumns,
  clearExpiredOfapiMediaLocatorUrls,
  markOfapiMediaMessageDeleted,
  purgeExpiredOfapiMediaFlights,
  upsertOfapiMediaLocators,
  type OfapiMediaLocatorInput,
  type OfapiMediaLocatorSource,
  type OfapiMediaSigKind,
  type OfapiMediaVariant,
} from "@agency_hub_core/db";
import { sql } from "drizzle-orm";

import type { AppContext } from "../bootstrap.ts";
import { capturePayloadResponse, parseOfapiJsonBytes } from "./ofapi-capture-contract.ts";
import { asRecord, idToString } from "./ofapi-payloads.ts";
import { isCapturePayloadUnavailable, resolveCapturePayloadRow } from "./payload-reader.ts";

// Locators for ChatGoose Desktop media images (docs/runbooks/ofapi-media.md).
// A locator is a known file URL for (OFAPI account, media id, variant). The
// hub collects them synchronously where OFAPI hands them out — webhook
// processing before the frame fan-out, and every gateway read of messages,
// the chat gallery and the vault before the response is returned — and can
// rebuild them from the journal (webhook payloads, gateway observations).

/** CloudFront-signed OnlyFans CDN hosts (cdn2.onlyfans.com, cdn3.onlyfans.com, …). */
const ONLYFANS_CDN_HOST = /^cdn\d*\.onlyfans\.com$/;
/** OFAPI's own CDN cache: S3-presigned, not bound to an address. */
export const OFAPI_CACHE_CDN_HOST = "cdn.fansapi.com";
/** OFAPI's metered streaming host: a hand-out here is paid. */
export const OFAPI_STREAM_CDN_HOST = "dl.fansapi.com";

const MEDIA_TYPES = new Set(["photo", "video", "gif", "audio"]);
/** `full` is served for photos in these formats only (owner decision). */
export const OFAPI_MEDIA_FULL_EXTENSIONS: ReadonlySet<string> = new Set(["jpg", "jpeg", "png", "webp"]);

/** Gateway reads whose bodies carry media file URLs. */
export const OFAPI_MEDIA_LOCATOR_OPERATIONS: ReadonlySet<string> = new Set([
  "ofapi_gateway_chat_messages",
  "ofapi_gateway_chat_message",
  "ofapi_gateway_chat_media",
  "ofapi_gateway_vault_media",
  "ofapi_gateway_vault_media_item",
]);

export interface ParsedOfapiMediaUrl {
  url: string;
  host: "onlyfans" | "fansapi";
  /** sha256 of the file path (the OFAPI cache and the desktop cache key on it). */
  pathSha256: string;
  sigKind: OfapiMediaSigKind;
  expiresAt: Date | null;
  /** A CloudFront policy with an IpAddress condition (the OFAPI proxy). */
  ipBound: boolean;
  fileExt: string | null;
}

function sha256(value: string) {
  return createHash("sha256").update(value).digest("hex");
}

/**
 * Decodes a CloudFront custom policy (URL-safe base64: `-`→`+`, `_`→`=`,
 * `~`→`/`). Returns its expiry and whether it binds the requester's address.
 */
export function decodeCloudFrontPolicy(value: string): { expiresAt: Date | null; ipBound: boolean } | null {
  if (value.length === 0 || value.length > 4096) return null;
  let parsed: unknown;
  try {
    const base64 = value.replaceAll("-", "+").replaceAll("_", "=").replaceAll("~", "/");
    parsed = JSON.parse(Buffer.from(base64, "base64").toString("utf8"));
  } catch {
    return null;
  }
  const root = asRecord(parsed);
  const statement = Array.isArray(root?.Statement) ? asRecord(root.Statement[0]) : root;
  const condition = asRecord(statement?.Condition);
  if (!condition) return null;
  const epoch = asRecord(condition.DateLessThan)?.["AWS:EpochTime"];
  const seconds = typeof epoch === "number" ? epoch : typeof epoch === "string" ? Number(epoch) : NaN;
  const ip = asRecord(condition.IpAddress)?.["AWS:SourceIp"];
  return {
    expiresAt: Number.isSafeInteger(seconds) && seconds > 0 ? new Date(seconds * 1000) : null,
    ipBound: typeof ip === "string" && ip.length > 0,
  };
}

/** `20260927T140300Z` + seconds → expiry of an S3-presigned URL. */
function amzExpiry(date: string | null, seconds: string | null): Date | null {
  const match = date ? /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z$/.exec(date) : null;
  const ttl = seconds !== null && /^\d{1,7}$/.test(seconds) ? Number(seconds) : NaN;
  if (!match || !Number.isFinite(ttl)) return null;
  const start = Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3]),
    Number(match[4]), Number(match[5]), Number(match[6]));
  return Number.isFinite(start) ? new Date(start + ttl * 1000) : null;
}

/**
 * Classifies one media URL. Only https URLs on the OnlyFans CDN or OFAPI's
 * cache CDN are locators; anything else (avatars, other hosts, credentials,
 * ports) is ignored. The URL itself stays in the locator table only; the
 * decision log never sees it.
 */
export function parseOfapiMediaUrl(raw: unknown): ParsedOfapiMediaUrl | null {
  if (typeof raw !== "string" || raw.length === 0 || raw.length > 8192) return null;
  let url: URL;
  try { url = new URL(raw); } catch { return null; }
  if (url.protocol !== "https:" || url.username !== "" || url.password !== "" || url.port !== "") return null;
  const hostname = url.hostname.toLowerCase();
  const host = ONLYFANS_CDN_HOST.test(hostname) ? "onlyfans" as const
    : hostname === OFAPI_CACHE_CDN_HOST ? "fansapi" as const : null;
  if (!host) return null;
  let path = url.pathname;
  if (host === "fansapi") {
    // cdn.fansapi.com/of/cdn2/files/… mirrors cdn2.onlyfans.com/files/…
    const mirrored = /^\/of\/[a-z0-9]+(\/files\/.+)$/i.exec(path);
    if (mirrored) path = mirrored[1]!;
  }
  if (!path.startsWith("/files/")) return null;
  const ext = /\.([a-z0-9]{2,5})$/i.exec(path)?.[1]?.toLowerCase() ?? null;
  const query = url.searchParams;
  let sigKind: OfapiMediaSigKind = "unknown";
  let expiresAt: Date | null = null;
  let ipBound = false;
  if (host === "fansapi") {
    expiresAt = amzExpiry(query.get("X-Amz-Date"), query.get("X-Amz-Expires"));
    sigKind = expiresAt ? "fansapi" : "unknown";
  } else if (query.has("Policy")) {
    const policy = decodeCloudFrontPolicy(query.get("Policy") ?? "");
    sigKind = "policy";
    expiresAt = policy?.expiresAt ?? null;
    // An unreadable policy is treated as address-bound: never handed out directly.
    ipBound = policy?.ipBound ?? true;
  } else if (query.has("Expires") && query.has("Signature")) {
    const seconds = Number(query.get("Expires"));
    sigKind = "expires";
    expiresAt = Number.isSafeInteger(seconds) && seconds > 0 ? new Date(seconds * 1000) : null;
  }
  return { url: url.toString(), host, pathSha256: sha256(path), sigKind, expiresAt, ipBound, fileExt: ext };
}

function fileUrl(value: unknown): string | null {
  if (typeof value === "string") return value.length > 0 ? value : null;
  const url = asRecord(value)?.url;
  return typeof url === "string" && url.length > 0 ? url : null;
}

/**
 * The variant rule shared with the desktop: `thumb` is thumb → squarePreview →
 * preview (never the full file), `full` is the full file only.
 */
export function selectOfapiMediaVariantUrls(media: Record<string, unknown>) {
  const files = asRecord(media.files);
  return {
    thumb: fileUrl(files?.thumb) ?? fileUrl(files?.squarePreview) ?? fileUrl(files?.preview)
      ?? fileUrl(media.thumb) ?? fileUrl(media.squarePreview) ?? fileUrl(media.preview),
    full: fileUrl(files?.full) ?? fileUrl(media.full) ?? fileUrl(media.src),
  };
}

export interface OfapiMediaProvenance {
  ofapiAccountId: string;
  pageId: number | null;
  source: OfapiMediaLocatorSource;
  observedAt: Date;
  chatId: string | null;
  messageId: string | null;
  vaultMedia: boolean;
}

/** One media object → up to two locator rows (thumb, and full for photos). */
export function ofapiMediaLocatorsFromItem(item: unknown, provenance: OfapiMediaProvenance): OfapiMediaLocatorInput[] {
  const media = asRecord(item);
  const mediaId = idToString(media?.id);
  if (!media || !mediaId || !/^\d{1,30}$/.test(mediaId)) return [];
  const rawType = typeof media.type === "string" ? media.type : "";
  const mediaType = MEDIA_TYPES.has(rawType) ? rawType : "other";
  const urls = selectOfapiMediaVariantUrls(media);
  const canView = typeof media.canView === "boolean" ? media.canView : null;
  const isReady = typeof media.isReady === "boolean"
    ? media.isReady && media.hasError !== true
    : media.hasError === true ? false : null;
  const variants: Array<[OfapiMediaVariant, string | null]> = [["thumb", urls.thumb]];
  // Only photos have a servable full variant; the others are never minted.
  if (mediaType === "photo") variants.push(["full", urls.full]);
  const rows: OfapiMediaLocatorInput[] = [];
  for (const [variant, raw] of variants) {
    const parsed = raw === null ? null : parseOfapiMediaUrl(raw);
    // A present-but-foreign URL is not a locator; an absent one still records
    // the access flags (locked, processing) for the resolve decision.
    if (raw !== null && parsed === null) continue;
    rows.push({
      ofapiAccountId: provenance.ofapiAccountId, mediaId, variant, source: provenance.source,
      pageId: provenance.pageId, url: parsed?.url ?? null, pathSha256: parsed?.pathSha256 ?? null,
      sigKind: parsed?.sigKind ?? null, expiresAt: parsed?.expiresAt ?? null, mediaType,
      fileExt: parsed?.fileExt ?? null, chatId: provenance.chatId, messageId: provenance.messageId,
      vaultMedia: provenance.vaultMedia, canView, isReady, observedAt: provenance.observedAt,
    });
  }
  return rows;
}

function messageMedia(message: unknown, provenance: Omit<OfapiMediaProvenance, "messageId">) {
  const record = asRecord(message);
  const media = Array.isArray(record?.media) ? record.media : [];
  const messageId = idToString(record?.id);
  return media.flatMap((item) => ofapiMediaLocatorsFromItem(item, { ...provenance, messageId }));
}

/** messages.received / messages.sent → locators (free Expires-signed URLs). */
export function ofapiMediaLocatorsFromWebhook(envelope: { event: string; account_id?: string | null | undefined; payload: unknown }, input: {
  pageId: number; observedAt: Date;
}): OfapiMediaLocatorInput[] {
  if (!envelope.account_id || (envelope.event !== "messages.received" && envelope.event !== "messages.sent")) return [];
  const payload = asRecord(envelope.payload);
  if (!payload) return [];
  const chatId = idToString(asRecord(envelope.event === "messages.received" ? payload.fromUser : payload.toUser)?.id);
  return messageMedia(payload, {
    ofapiAccountId: envelope.account_id, pageId: input.pageId, source: "webhook",
    observedAt: input.observedAt, chatId, vaultMedia: false,
  });
}

function unwrapData(body: unknown): unknown {
  const record = asRecord(body);
  return record && "data" in record ? record.data : body;
}

function listItems(data: unknown): unknown[] {
  if (Array.isArray(data)) return data;
  const record = asRecord(data);
  if (Array.isArray(record?.list)) return record.list;
  return record ? [record] : [];
}

function chatIdFromPath(pathname: string): string | null {
  const segments = pathname.split("/");
  if (segments[2] !== "chats" || !segments[3]) return null;
  try { return decodeURIComponent(segments[3]); } catch { return null; }
}

/** A successful gateway body of a media-bearing read → locators. */
export function ofapiMediaLocatorsFromGatewayBody(input: {
  operation: string; ofapiAccountId: string; pageId: number; pathname: string; body: unknown; observedAt: Date;
}): OfapiMediaLocatorInput[] {
  if (!OFAPI_MEDIA_LOCATOR_OPERATIONS.has(input.operation)) return [];
  const items = listItems(unwrapData(input.body));
  const base = { ofapiAccountId: input.ofapiAccountId, pageId: input.pageId, source: "gateway" as const, observedAt: input.observedAt };
  if (input.operation === "ofapi_gateway_vault_media" || input.operation === "ofapi_gateway_vault_media_item") {
    return items.flatMap((item) => ofapiMediaLocatorsFromItem(item, { ...base, chatId: null, messageId: null, vaultMedia: true }));
  }
  const chatId = chatIdFromPath(input.pathname);
  return items.flatMap((message) => messageMedia(message, { ...base, chatId, vaultMedia: false }));
}

/** Fail-open: a locator write never fails the webhook settle or the read. */
async function recordLocators(app: Pick<AppContext, "db" | "logger">, rows: OfapiMediaLocatorInput[], context: Record<string, unknown>) {
  if (rows.length === 0) return 0;
  try {
    return await upsertOfapiMediaLocators(app.db, rows);
  } catch (error) {
    app.logger.warn({ err: error, ...context, rows: rows.length }, "OFAPI media locator upsert failed; continuing");
    return 0;
  }
}

/** Webhook processing (before the frame fan-out): collects locators and applies deletions. */
export async function recordOfapiWebhookMediaLocators(app: Pick<AppContext, "db" | "logger">, input: {
  envelope: { event: string; account_id?: string | null | undefined; payload: unknown }; pageId: number; observedAt: Date; eventId: number;
}) {
  if (input.envelope.event === "messages.deleted") {
    const messageId = idToString(asRecord(input.envelope.payload)?.id);
    if (!messageId || !input.envelope.account_id) return 0;
    try {
      return await markOfapiMediaMessageDeleted(app.db, { ofapiAccountId: input.envelope.account_id, messageId });
    } catch (error) {
      app.logger.warn({ err: error, eventId: input.eventId }, "OFAPI media locator deletion mark failed; continuing");
      return 0;
    }
  }
  return recordLocators(app, ofapiMediaLocatorsFromWebhook(input.envelope, input), { eventId: input.eventId });
}

/** The read gateway, on both the capture-first and proxy paths, before the response is returned. */
export async function recordOfapiGatewayMediaLocators(app: Pick<AppContext, "db" | "logger">, input: {
  operation: string; ofapiAccountId: string; pageId: number; pathname: string; body: unknown; observedAt?: Date;
}) {
  if (!OFAPI_MEDIA_LOCATOR_OPERATIONS.has(input.operation)) return 0;
  return recordLocators(app, ofapiMediaLocatorsFromGatewayBody({ ...input, observedAt: input.observedAt ?? new Date() }),
    { operation: input.operation, pageId: input.pageId });
}

const RECOVERY_OBSERVATION_KINDS = ["ofapi.interactive_response.v1", "ofapi.collection_read_response.v1"];

/** Maps a captured gateway request path back to its media-bearing operation. */
function operationFromPath(pathname: string): string | null {
  const segments = pathname.split("/").slice(2);
  if (segments[0] === "chats" && segments.length === 3 && segments[2] === "messages") return "ofapi_gateway_chat_messages";
  if (segments[0] === "chats" && segments.length === 4 && segments[2] === "messages" && /^\d+$/.test(segments[3]!)) return "ofapi_gateway_chat_message";
  if (segments[0] === "chats" && segments.length === 3 && segments[2] === "media") return "ofapi_gateway_chat_media";
  if (segments[0] === "media" && segments[1] === "vault" && segments.length === 2) return "ofapi_gateway_vault_media";
  if (segments[0] === "media" && segments[1] === "vault" && segments.length === 3 && /^\d+$/.test(segments[2]!)) return "ofapi_gateway_vault_media_item";
  return null;
}

/**
 * Rebuilds locators from the journal: webhook payloads and captured gateway
 * responses of the last `hours`. Older observations never regress newer
 * locators (the upsert compares observed_at). Local only: no vendor request.
 */
export async function recoverOfapiMediaLocators(app: AppContext, input: { hours: number; limit?: number }) {
  const since = new Date(Date.now() - Math.max(1, input.hours) * 3_600_000);
  const limit = Math.max(1, Math.min(input.limit ?? 20_000, 200_000));
  const result = { webhookEvents: 0, observations: 0, locators: 0, unavailable: 0 };

  const events = await app.db.execute<{ id: string | number; payload: unknown; received_at: Date | string; page_id: string | number | null }>(sql`
    select e.id, e.payload, e.received_at, p.id as page_id
    from ofapi_webhook_events e
    join pages p on p.ofapi_account_id = e.ofapi_account_id and p.platform = 'onlyfans' and p.deleted_at is null
    where e.event_type in ('messages.received', 'messages.sent') and e.received_at >= ${since}::timestamptz
    order by e.received_at
    limit ${limit}
  `);
  for (const event of events.rows) {
    const envelope = asRecord(event.payload);
    if (!envelope || typeof envelope.event !== "string" || event.page_id === null) continue;
    result.webhookEvents += 1;
    result.locators += await recordLocators(app, ofapiMediaLocatorsFromWebhook(
      { event: envelope.event, account_id: typeof envelope.account_id === "string" ? envelope.account_id : null, payload: envelope.payload },
      { pageId: Number(event.page_id), observedAt: new Date(event.received_at) },
    ), { eventId: Number(event.id) });
  }

  const observations = await app.db.execute<{
    id: string | number; received_at: Date | string; account_id: string | number | null;
    native_account_ref: string | null; payload: unknown; payload_bucket_month: string | null; payload_object_id: string | null;
  }>(sql`
    select id, received_at, account_id, native_account_ref, payload,
           to_char(payload_bucket_month, 'YYYY-MM-DD') as payload_bucket_month,
           payload_object_id::text as payload_object_id
    from observations
    where source = 'ofapi_capture' and kind in (${sql.join(RECOVERY_OBSERVATION_KINDS.map((kind) => sql`${kind}`), sql`, `)})
      and received_at >= ${since}::timestamptz
    order by received_at
    limit ${limit}
  `);
  for (const row of observations.rows) {
    if (row.account_id === null || !row.native_account_ref) continue;
    let payload: unknown;
    try {
      payload = (await resolveCapturePayloadRow(app, "observation", Number(row.id), {
        payload: row.payload,
        payloadRef: capturePayloadRefFromColumns(row.payload_bucket_month, row.payload_object_id),
      })).payload;
    } catch (error) {
      if (!isCapturePayloadUnavailable(error)) throw error;
      result.unavailable += 1;
      continue;
    }
    const request = asRecord(asRecord(payload)?.request);
    const pathname = typeof request?.pathname === "string" ? request.pathname : null;
    const operation = pathname ? operationFromPath(pathname) : null;
    const response = capturePayloadResponse(payload);
    if (!operation || !pathname || !response || response.status < 200 || response.status >= 300) continue;
    const parsed = parseOfapiJsonBytes(response.bodyBytes, response.headers);
    if (!parsed.validJson) continue;
    result.observations += 1;
    result.locators += await recordLocators(app, ofapiMediaLocatorsFromGatewayBody({
      operation, ofapiAccountId: row.native_account_ref, pageId: Number(row.account_id), pathname,
      body: parsed.body, observedAt: new Date(row.received_at),
    }), { observationId: Number(row.id) });
  }
  return result;
}

/** Daily: expired signatures older than 7 days lose their URL (the linkage stays); stale flights go. */
export async function cleanupOfapiMediaLocators(app: Pick<AppContext, "db" | "logger">, now = new Date()) {
  try {
    const cleared = await clearExpiredOfapiMediaLocatorUrls(app.db, { expiredBefore: new Date(now.getTime() - 7 * 86_400_000) });
    const flights = await purgeExpiredOfapiMediaFlights(app.db, { before: new Date(now.getTime() - 3_600_000) });
    if (cleared > 0 || flights > 0) app.logger.info({ cleared, flights }, "OFAPI media locator cleanup complete");
  } catch (error) {
    app.logger.warn({ err: error }, "OFAPI media locator cleanup failed; continuing");
  }
}
