import { sql } from "drizzle-orm";

import type { Database } from "../client.ts";
import { resettleOfapiCollectionRequest } from "./ofapi-collection.ts";
import {
  insertOfapiCreditLedgerEntry,
  recordOfapiCreditSpend,
  type RecordOfapiCreditSpendInput,
} from "./ofapi.ts";

// ChatGoose Desktop media images (migration 0210, docs/runbooks/ofapi-media.md).
// The hub keeps locators (known file URLs), where each media appears (links),
// one decision-log row per resolve, the agency's paid-download budget per UTC
// day and a short single-flight marker per file. It never stores or relays
// file bytes.

/** `preview` (0216) is the AI describer's variant; the desktop resolves thumb/full. */
export type OfapiMediaVariant = "thumb" | "full" | "preview";
/** `resolve` (0216): a cdn.fansapi.com URL the desktop resolve handed out. */
export type OfapiMediaLocatorSource = "webhook" | "gateway" | "resolve";
export type OfapiMediaSigKind = "expires" | "policy" | "fansapi" | "unknown";

export interface OfapiMediaLocatorInput {
  ofapiAccountId: string;
  mediaId: string;
  variant: OfapiMediaVariant;
  source: OfapiMediaLocatorSource;
  pageId: number | null;
  url: string | null;
  pathSha256: string | null;
  sigKind: OfapiMediaSigKind | null;
  expiresAt: Date | null;
  mediaType: string | null;
  fileExt: string | null;
  /** The OnlyFans chat id, which is the fan's user id (column fan_platform_user_id). */
  chatId: string | null;
  messageId: string | null;
  vaultMedia: boolean;
  canView: boolean | null;
  isReady: boolean | null;
  observedAt: Date;
}

export interface OfapiMediaLocatorRow {
  ofapiAccountId: string;
  mediaId: string;
  variant: OfapiMediaVariant;
  source: OfapiMediaLocatorSource;
  pageId: number | null;
  url: string | null;
  pathSha256: string | null;
  sigKind: OfapiMediaSigKind | null;
  expiresAt: Date | null;
  mediaType: string | null;
  fileExt: string | null;
  chatId: string | null;
  messageId: string | null;
  vaultMedia: boolean;
  canView: boolean | null;
  isReady: boolean | null;
  hadFreeUrl: boolean;
  observedAt: Date;
}

/** Where one media appears: a message (chat = fan) or the vault. */
export interface OfapiMediaLinkRow {
  ofapiAccountId: string;
  mediaId: string;
  linkKey: string;
  pageId: number | null;
  chatId: string | null;
  messageId: string | null;
  deleted: boolean;
  observedAt: Date;
}

function locatorKey(row: Pick<OfapiMediaLocatorInput, "ofapiAccountId" | "mediaId" | "variant" | "source">) {
  return `${row.ofapiAccountId}|${row.mediaId}|${row.variant}|${row.source}`;
}

/** One statement cannot touch a conflict key twice: keep the newest observation,
 * and within one observation the row that carries a URL. Sorted by key, so two
 * concurrent upserts always lock rows in the same order (no deadlock). */
export function dedupeOfapiMediaLocators(rows: readonly OfapiMediaLocatorInput[]) {
  const byKey = new Map<string, OfapiMediaLocatorInput>();
  for (const row of rows) {
    const key = locatorKey(row);
    const current = byKey.get(key);
    if (!current
      || row.observedAt.getTime() > current.observedAt.getTime()
      || (row.observedAt.getTime() === current.observedAt.getTime() && current.url === null && row.url !== null)) {
      byKey.set(key, row);
    }
  }
  return [...byKey.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)).map(([, row]) => row);
}

interface LinkInput {
  ofapiAccountId: string; mediaId: string; linkKey: string; pageId: number | null;
  chatId: string | null; messageId: string | null; observedAt: Date;
}

/** The links a batch of locators proves: its message (if any) and the vault. Newest wins, sorted by key. */
export function ofapiMediaLinksFromLocators(rows: readonly OfapiMediaLocatorInput[]): LinkInput[] {
  const byKey = new Map<string, LinkInput>();
  const add = (link: LinkInput) => {
    const key = `${link.ofapiAccountId}|${link.mediaId}|${link.linkKey}`;
    const current = byKey.get(key);
    if (!current || link.observedAt.getTime() > current.observedAt.getTime()) byKey.set(key, link);
  };
  for (const row of rows) {
    const base = { ofapiAccountId: row.ofapiAccountId, mediaId: row.mediaId, pageId: row.pageId, observedAt: row.observedAt };
    if (row.messageId) add({ ...base, linkKey: `message:${row.messageId}`, chatId: row.chatId, messageId: row.messageId });
    if (row.vaultMedia) add({ ...base, linkKey: "vault", chatId: null, messageId: null });
  }
  return [...byKey.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)).map(([, link]) => link);
}

/**
 * Upserts locators and the links they prove. An older observation (a recovery
 * replay) never regresses a newer one; a newer observation without a URL keeps
 * the last known URL but updates the access flags. Readiness is monotonic: a
 * media once seen ready stays ready, whatever a late webhook says. The fact
 * that a free URL was ever seen is sticky. A deleted link stays deleted.
 */
export async function upsertOfapiMediaLocators(db: Database, input: readonly OfapiMediaLocatorInput[]) {
  const rows = dedupeOfapiMediaLocators(input);
  if (rows.length === 0) return 0;
  const values = rows.map((row) => sql`(
    ${row.ofapiAccountId}, ${row.mediaId}, ${row.variant}, ${row.source}, ${row.pageId},
    ${row.url}, ${row.pathSha256}, ${row.sigKind}, ${row.expiresAt}::timestamptz,
    ${row.mediaType}, ${row.fileExt}, ${row.chatId}, ${row.messageId}, ${row.vaultMedia},
    ${row.canView}, ${row.isReady}, ${row.sigKind === "expires"}, ${row.observedAt}::timestamptz
  )`);
  const links = ofapiMediaLinksFromLocators(rows);
  return db.transaction(async (tx) => {
    const database = tx as unknown as Database;
    const result = await database.execute(sql`
      insert into ofapi_media_locators (
        ofapi_account_id, media_id, variant, source, page_id,
        url, path_sha256, sig_kind, expires_at,
        media_type, file_ext, fan_platform_user_id, message_id, vault_media,
        can_view, is_ready, had_free_url, observed_at
      ) values ${sql.join(values, sql`, `)}
      on conflict (ofapi_account_id, media_id, variant, source) do update set
        page_id = coalesce(excluded.page_id, ofapi_media_locators.page_id),
        url = case when excluded.url is not null then excluded.url else ofapi_media_locators.url end,
        path_sha256 = case when excluded.url is not null then excluded.path_sha256 else ofapi_media_locators.path_sha256 end,
        sig_kind = case when excluded.url is not null then excluded.sig_kind else ofapi_media_locators.sig_kind end,
        expires_at = case when excluded.url is not null then excluded.expires_at else ofapi_media_locators.expires_at end,
        media_type = coalesce(excluded.media_type, ofapi_media_locators.media_type),
        file_ext = coalesce(excluded.file_ext, ofapi_media_locators.file_ext),
        fan_platform_user_id = coalesce(excluded.fan_platform_user_id, ofapi_media_locators.fan_platform_user_id),
        message_id = coalesce(excluded.message_id, ofapi_media_locators.message_id),
        vault_media = ofapi_media_locators.vault_media or excluded.vault_media,
        can_view = excluded.can_view,
        is_ready = case when ofapi_media_locators.is_ready is true then true else excluded.is_ready end,
        had_free_url = ofapi_media_locators.had_free_url or excluded.had_free_url,
        observed_at = excluded.observed_at,
        updated_at = now()
      where excluded.observed_at >= ofapi_media_locators.observed_at
    `);
    if (links.length > 0) {
      await database.execute(sql`
        insert into ofapi_media_links (
          ofapi_account_id, media_id, link_key, page_id, fan_platform_user_id, message_id, observed_at
        ) values ${sql.join(links.map((link) => sql`(
          ${link.ofapiAccountId}, ${link.mediaId}, ${link.linkKey}, ${link.pageId}, ${link.chatId},
          ${link.messageId}, ${link.observedAt}::timestamptz
        )`), sql`, `)}
        on conflict (ofapi_account_id, media_id, link_key) do update set
          page_id = coalesce(excluded.page_id, ofapi_media_links.page_id),
          fan_platform_user_id = coalesce(excluded.fan_platform_user_id, ofapi_media_links.fan_platform_user_id),
          observed_at = greatest(excluded.observed_at, ofapi_media_links.observed_at),
          updated_at = now()
      `);
    }
    // AI media describer: a file that was waiting for a free source becomes
    // due the moment one is recorded (webhook Expires URL, OFAPI cache URL),
    // instead of at its next retry. The source adapter still re-checks it.
    // Only a URL with usable life left (the source adapter wants ≥120 s), and a
    // fresh start of the retry budget: the waiting checks were not failures.
    const usableUntil = Date.now() + 5 * 60_000;
    const freeIds = [...new Set(rows
      .filter((row) => row.url !== null && (row.sigKind === "expires" || row.sigKind === "fansapi")
        && (row.expiresAt === null || row.expiresAt.getTime() > usableUntil))
      .map((row) => `${row.ofapiAccountId}:${row.mediaId}`))];
    if (freeIds.length > 0) {
      await database.execute(sql`
        update ai_media_descriptions d set status = 'pending', attempts = 0, next_attempt_at = now(), updated_at = now()
        from pages p
        where d.page_id = p.id and d.platform = 'onlyfans' and d.status = 'awaiting_source'
          and (p.ofapi_account_id || ':' || d.media_ref) in (${sql.join(freeIds.map((id) => sql`${id}`), sql`, `)})
      `);
    }
    return result.rowCount ?? 0;
  });
}

interface LocatorDbRow extends Record<string, unknown> {
  ofapi_account_id: string; media_id: string; variant: OfapiMediaVariant; source: OfapiMediaLocatorSource;
  page_id: string | number | null; url: string | null; path_sha256: string | null; sig_kind: OfapiMediaSigKind | null;
  expires_at: Date | string | null; media_type: string | null; file_ext: string | null; fan_platform_user_id: string | null;
  message_id: string | null; vault_media: boolean; can_view: boolean | null; is_ready: boolean | null;
  had_free_url: boolean; observed_at: Date | string;
}

function toLocatorRow(row: LocatorDbRow): OfapiMediaLocatorRow {
  return {
    ofapiAccountId: row.ofapi_account_id, mediaId: row.media_id, variant: row.variant, source: row.source,
    pageId: row.page_id === null ? null : Number(row.page_id), url: row.url, pathSha256: row.path_sha256,
    sigKind: row.sig_kind, expiresAt: row.expires_at === null ? null : new Date(row.expires_at),
    mediaType: row.media_type, fileExt: row.file_ext, chatId: row.fan_platform_user_id, messageId: row.message_id,
    vaultMedia: row.vault_media, canView: row.can_view, isReady: row.is_ready,
    hadFreeUrl: row.had_free_url, observedAt: new Date(row.observed_at),
  };
}

/** Every locator of one media (both variants, both sources), newest first. */
export async function listOfapiMediaLocators(db: Database, input: { ofapiAccountId: string; mediaId: string }) {
  const result = await db.execute<LocatorDbRow>(sql`
    select ofapi_account_id, media_id, variant, source, page_id, url, path_sha256, sig_kind,
           expires_at, media_type, file_ext, fan_platform_user_id, message_id, vault_media, can_view,
           is_ready, had_free_url, observed_at
    from ofapi_media_locators
    where ofapi_account_id = ${input.ofapiAccountId} and media_id = ${input.mediaId}
    order by observed_at desc
  `);
  return result.rows.map(toLocatorRow);
}

/** Every place one media appears, newest first. */
export async function listOfapiMediaLinks(db: Database, input: { ofapiAccountId: string; mediaId: string }) {
  const result = await db.execute<{
    ofapi_account_id: string; media_id: string; link_key: string; page_id: string | number | null;
    fan_platform_user_id: string | null; message_id: string | null; deleted: boolean; observed_at: Date | string;
  }>(sql`
    select ofapi_account_id, media_id, link_key, page_id, fan_platform_user_id, message_id, deleted, observed_at
    from ofapi_media_links
    where ofapi_account_id = ${input.ofapiAccountId} and media_id = ${input.mediaId}
    order by observed_at desc, link_key
  `);
  return result.rows.map((row): OfapiMediaLinkRow => ({
    ofapiAccountId: row.ofapi_account_id, mediaId: row.media_id, linkKey: row.link_key,
    pageId: row.page_id === null ? null : Number(row.page_id), chatId: row.fan_platform_user_id,
    messageId: row.message_id, deleted: row.deleted, observedAt: new Date(row.observed_at),
  }));
}

/**
 * messages.deleted: only that message's links are marked. A media stops being
 * served once it has links and none of them is live (shared vault and
 * mass-PPV media keep their other messages and the vault).
 */
export async function markOfapiMediaMessageDeleted(db: Database, input: { ofapiAccountId: string; messageId: string }) {
  const result = await db.execute(sql`
    update ofapi_media_links set deleted = true, updated_at = now()
    where ofapi_account_id = ${input.ofapiAccountId} and message_id = ${input.messageId} and not deleted
  `);
  return result.rowCount ?? 0;
}

/**
 * Daily: expired signatures older than the grace lose their URL, and so does a
 * URL whose expiry could not be read once it was observed longer ago than the
 * same grace. The row (durable linkage) stays.
 */
export async function clearExpiredOfapiMediaLocatorUrls(db: Database, input: { expiredBefore: Date }) {
  const result = await db.execute(sql`
    update ofapi_media_locators set url = null, updated_at = now()
    where url is not null
      and (expires_at < ${input.expiredBefore}::timestamptz
        or (expires_at is null and observed_at < ${input.expiredBefore}::timestamptz))
  `);
  return result.rowCount ?? 0;
}

// ---- Agency budget ---------------------------------------------------------

export interface OfapiMediaBudgetAdmission {
  admitted: boolean;
  /** credits_used after this admission (or the current value when refused). */
  usedAfter: number;
  overCap: boolean;
}

/**
 * Atomic admission against the agency's UTC-day budget. `auto` passes only
 * while used + price <= cap (a conditional update, so two concurrent requests
 * at the edge cannot both pass); `click` always passes and reports over_cap.
 */
export async function admitOfapiMediaBudget(db: Database, input: {
  day: string; price: number; cap: number; trigger: "auto" | "click";
}): Promise<OfapiMediaBudgetAdmission> {
  const price = Math.max(0, Math.trunc(input.price));
  await db.execute(sql`insert into ofapi_media_daily_budget (day) values (${input.day}::date) on conflict (day) do nothing`);
  if (input.trigger === "auto") {
    const updated = await db.execute<{ credits_used: number }>(sql`
      update ofapi_media_daily_budget set credits_used = credits_used + ${price}, updated_at = now()
      where day = ${input.day}::date and credits_used + ${price} <= ${input.cap}
      returning credits_used
    `);
    const row = updated.rows[0];
    if (row) return { admitted: true, usedAfter: Number(row.credits_used), overCap: false };
    const current = await db.execute<{ credits_used: number }>(sql`
      select credits_used from ofapi_media_daily_budget where day = ${input.day}::date`);
    return { admitted: false, usedAfter: Number(current.rows[0]?.credits_used ?? 0), overCap: false };
  }
  const updated = await db.execute<{ credits_used: number }>(sql`
    update ofapi_media_daily_budget set credits_used = credits_used + ${price}, updated_at = now()
    where day = ${input.day}::date
    returning credits_used
  `);
  const usedAfter = Number(updated.rows[0]?.credits_used ?? price);
  return { admitted: true, usedAfter, overCap: usedAfter > input.cap };
}

/** Returns an admission when nothing was handed out. Never below zero. */
export async function refundOfapiMediaBudget(db: Database, input: { day: string; price: number }) {
  await adjustOfapiMediaBudget(db, { day: input.day, delta: -Math.max(0, Math.trunc(input.price)) });
}

/** A signed correction of one day's use (a settled unknown-size click). Never below zero. */
export async function adjustOfapiMediaBudget(db: Database, input: { day: string; delta: number }) {
  const delta = Math.trunc(input.delta);
  if (delta === 0) return;
  await db.execute(sql`insert into ofapi_media_daily_budget (day) values (${input.day}::date) on conflict (day) do nothing`);
  await db.execute(sql`
    update ofapi_media_daily_budget
    set credits_used = greatest(0, credits_used + ${delta}), updated_at = now()
    where day = ${input.day}::date
  `);
}

export async function getOfapiMediaBudgetUsed(db: Database, day: string) {
  const result = await db.execute<{ credits_used: number }>(sql`
    select credits_used from ofapi_media_daily_budget where day = ${day}::date`);
  return Number(result.rows[0]?.credits_used ?? 0);
}

// ---- Single flight ---------------------------------------------------------

/** Claims the per-file flight, or reports who holds it until when. An expired
 * holder is replaced in the same statement. */
export async function claimOfapiMediaFlight(db: Database, input: {
  flightKey: string; resolveId: string; holdMs: number; now?: Date;
}): Promise<{ claimed: true } | { claimed: false; heldUntil: Date }> {
  const now = input.now ?? new Date();
  const until = new Date(now.getTime() + input.holdMs);
  const claimed = await db.execute<{ resolve_id: string }>(sql`
    insert into ofapi_media_flights (flight_key, resolve_id, held_until)
    values (${input.flightKey}, ${input.resolveId}::uuid, ${until}::timestamptz)
    on conflict (flight_key) do update set resolve_id = excluded.resolve_id, held_until = excluded.held_until
      where ofapi_media_flights.held_until <= ${now}::timestamptz
    returning resolve_id::text
  `);
  if (claimed.rows[0]?.resolve_id === input.resolveId) return { claimed: true };
  const holder = await db.execute<{ held_until: Date | string }>(sql`
    select held_until from ofapi_media_flights where flight_key = ${input.flightKey}`);
  const heldUntil = holder.rows[0]?.held_until;
  return { claimed: false, heldUntil: heldUntil ? new Date(heldUntil) : until };
}

/** Keeps a paid hand-out's flight until its report or the hold elapses. */
export async function holdOfapiMediaFlight(db: Database, input: { resolveId: string; holdMs: number }) {
  await db.execute(sql`
    update ofapi_media_flights set held_until = now() + ${`${Math.max(0, input.holdMs)} milliseconds`}::interval
    where resolve_id = ${input.resolveId}::uuid
  `);
}

export async function releaseOfapiMediaFlight(db: Database, resolveIds: readonly string[]) {
  if (resolveIds.length === 0) return;
  await db.execute(sql`
    delete from ofapi_media_flights
    where resolve_id in (${sql.join(resolveIds.map((id) => sql`${id}::uuid`), sql`, `)})
  `);
}

export async function purgeExpiredOfapiMediaFlights(db: Database, input: { before: Date }) {
  const result = await db.execute(sql`delete from ofapi_media_flights where held_until < ${input.before}::timestamptz`);
  return result.rowCount ?? 0;
}

// ---- Decision log ----------------------------------------------------------

export type OfapiMediaOutcome =
  | "free_url" | "ofapi_cache" | "paid" | "cap_blocked" | "source_expired"
  | "unavailable" | "refused" | "pending" | "error";

export interface OfapiMediaFetchLogInput {
  resolveId: string;
  clientRequestId: string;
  occurredAt: Date;
  accrualDay: string;
  pageId: number | null;
  ofapiAccountId: string;
  actorUserId: number;
  surface: "thread" | "gallery" | "vault" | "lightbox";
  trigger: "auto" | "click";
  mediaId: string;
  mediaType: string | null;
  variant: OfapiMediaVariant;
  pathSha256: string | null;
  outcome: OfapiMediaOutcome;
  reason: string | null;
  contentLength: number | null;
  creditsEstimated: number;
  overCap: boolean;
  hadFreeUrlExpired: boolean;
  afterReread: boolean;
  certainty: "estimated" | "confirmed" | "unknown";
  /** A paid download's collection reservation (settled again on the report of an unknown-size click). */
  collectionRequestId?: string | null;
}

export interface OfapiMediaFetchLogRow extends OfapiMediaFetchLogInput {
  id: number;
  ledgerEntryId: number | null;
  clientResult: string | null;
  bytesReceived: number | null;
  httpStatus: number | null;
  reportedAt: Date | null;
}

interface FetchLogDbRow extends Record<string, unknown> {
  id: string | number; resolve_id: string; client_request_id: string; occurred_at: Date | string;
  accrual_day: string; page_id: string | number | null; ofapi_account_id: string; actor_user_id: string | number;
  surface: OfapiMediaFetchLogInput["surface"]; trigger: OfapiMediaFetchLogInput["trigger"]; media_id: string;
  media_type: string | null; variant: OfapiMediaVariant; path_sha256: string | null; outcome: OfapiMediaOutcome;
  reason: string | null; content_length: string | number | null; credits_estimated: number; over_cap: boolean;
  had_free_url_expired: boolean; after_reread: boolean; certainty: OfapiMediaFetchLogInput["certainty"];
  ledger_entry_id: string | number | null; collection_request_id: string | null; client_result: string | null;
  bytes_received: string | number | null; http_status: number | null; reported_at: Date | string | null;
}

function toFetchLogRow(row: FetchLogDbRow): OfapiMediaFetchLogRow {
  const nullableNumber = (value: string | number | null) => value === null ? null : Number(value);
  return {
    id: Number(row.id), resolveId: row.resolve_id, clientRequestId: row.client_request_id,
    occurredAt: new Date(row.occurred_at), accrualDay: row.accrual_day, pageId: nullableNumber(row.page_id),
    ofapiAccountId: row.ofapi_account_id, actorUserId: Number(row.actor_user_id), surface: row.surface,
    trigger: row.trigger, mediaId: row.media_id, mediaType: row.media_type, variant: row.variant,
    pathSha256: row.path_sha256, outcome: row.outcome, reason: row.reason,
    contentLength: nullableNumber(row.content_length), creditsEstimated: Number(row.credits_estimated),
    overCap: row.over_cap, hadFreeUrlExpired: row.had_free_url_expired, afterReread: row.after_reread,
    certainty: row.certainty, ledgerEntryId: nullableNumber(row.ledger_entry_id),
    collectionRequestId: row.collection_request_id, clientResult: row.client_result,
    bytesReceived: nullableNumber(row.bytes_received), httpStatus: row.http_status,
    reportedAt: row.reported_at === null ? null : new Date(row.reported_at),
  };
}

const FETCH_LOG_COLUMNS = sql`id, resolve_id::text, client_request_id::text, occurred_at,
  to_char(accrual_day, 'YYYY-MM-DD') as accrual_day, page_id, ofapi_account_id, actor_user_id, surface, trigger,
  media_id, media_type, variant, path_sha256, outcome, reason, content_length, credits_estimated, over_cap,
  had_free_url_expired, after_reread, certainty, ledger_entry_id, collection_request_id, client_result,
  bytes_received, http_status, reported_at`;

export async function findOfapiMediaFetchByRequest(db: Database, input: { actorUserId: number; clientRequestId: string }) {
  const result = await db.execute<FetchLogDbRow>(sql`
    select ${FETCH_LOG_COLUMNS} from ofapi_media_fetch_log
    where actor_user_id = ${input.actorUserId} and client_request_id = ${input.clientRequestId}::uuid`);
  return result.rows[0] ? toFetchLogRow(result.rows[0]) : null;
}

/**
 * Writes the decision row, and for a paid hand-out its estimated ledger row, in
 * one transaction. Returns null when the client's requestId was already logged
 * by a concurrent resolve: that one owns the answer and nothing is written.
 */
export async function recordOfapiMediaFetch(db: Database, input: {
  log: OfapiMediaFetchLogInput;
  ledger?: Omit<RecordOfapiCreditSpendInput, "occurredAt"> | null;
}): Promise<{ id: number; ledgerEntryId: number | null } | null> {
  return db.transaction(async (tx) => {
    const database = tx as unknown as Database;
    const row = input.log;
    const inserted = await database.execute<{ id: string | number }>(sql`
      insert into ofapi_media_fetch_log (
        resolve_id, client_request_id, occurred_at, accrual_day, page_id, ofapi_account_id,
        actor_user_id, surface, trigger, media_id, media_type, variant, path_sha256, outcome,
        reason, content_length, credits_estimated, over_cap, had_free_url_expired, after_reread,
        certainty, collection_request_id
      ) values (
        ${row.resolveId}::uuid, ${row.clientRequestId}::uuid, ${row.occurredAt}::timestamptz,
        ${row.accrualDay}::date, ${row.pageId}, ${row.ofapiAccountId}, ${row.actorUserId},
        ${row.surface}, ${row.trigger}, ${row.mediaId}, ${row.mediaType}, ${row.variant},
        ${row.pathSha256}, ${row.outcome}, ${row.reason}, ${row.contentLength},
        ${row.creditsEstimated}, ${row.overCap}, ${row.hadFreeUrlExpired}, ${row.afterReread},
        ${row.certainty}, ${row.collectionRequestId ?? null}
      )
      on conflict (actor_user_id, client_request_id) do nothing
      returning id
    `);
    const logId = inserted.rows[0]?.id;
    if (logId === undefined) return null;
    let ledgerEntryId: number | null = null;
    if (input.ledger) {
      ledgerEntryId = await recordOfapiCreditSpend(database, { ...input.ledger, occurredAt: row.occurredAt });
      await database.execute(sql`update ofapi_media_fetch_log set ledger_entry_id = ${ledgerEntryId} where id = ${logId}`);
    }
    return { id: Number(logId), ledgerEntryId };
  });
}

export interface OfapiMediaFetchReport {
  resolveId: string;
  result: "ok" | "failed" | "aborted_size" | "timeout" | "http_error";
  bytesReceived: number | null;
  httpStatus: number | null;
}

/** OFAPI tariff: 3 credits per decimal MB, at least 1 per download. */
export function ofapiMediaTransferCredits(bytes: number) {
  return Math.max(1, Math.ceil((3 * Math.max(0, bytes)) / 1_000_000));
}

/** A click on a file of unknown size may take this much (the desktop's memory guard)… */
export const OFAPI_MEDIA_UNKNOWN_SIZE_GUARD_BYTES = 5_000_000;
/** …and is reserved at what that can cost, then settled down on its report. */
export const OFAPI_MEDIA_UNKNOWN_SIZE_GUARD_CREDITS = ofapiMediaTransferCredits(OFAPI_MEDIA_UNKNOWN_SIZE_GUARD_BYTES);

interface ReportedRow extends Record<string, unknown> {
  resolve_id: string; outcome: OfapiMediaOutcome; content_length: string | number | null; credits_estimated: number;
  accrual_day: string; occurred_at: Date | string; collection_request_id: string | null; page_id: string | number | null;
}

/**
 * A paid click of unknown size was admitted, reserved and ledgered at the
 * guard price; its report settles all three DOWN to what the reported bytes
 * cost (never below 1 credit, never above the reservation — a client report
 * can lower or keep a debit, never raise it). The ledger keeps its
 * convention: the original `rest` row stays and a signed `adjustment` row
 * (≤ 0) carries the difference, on the issuance day. The shared daily spend
 * counter keeps its conservative figure. A report without a byte count leaves
 * the guard charge.
 */
async function settleUnknownSizeClick(db: Database, row: ReportedRow, report: OfapiMediaFetchReport, actorUserId: number) {
  if (row.outcome !== "paid" || row.content_length !== null || report.bytesReceived === null) return;
  const reserved = Number(row.credits_estimated);
  const settled = Math.min(reserved,
    ofapiMediaTransferCredits(Math.min(report.bytesReceived, OFAPI_MEDIA_UNKNOWN_SIZE_GUARD_BYTES)));
  const delta = settled - reserved;
  if (delta >= 0) return;
  await db.execute(sql`update ofapi_media_fetch_log set credits_estimated = ${settled} where resolve_id = ${row.resolve_id}::uuid`);
  await adjustOfapiMediaBudget(db, { day: row.accrual_day, delta });
  if (row.collection_request_id) await resettleOfapiCollectionRequest(db, row.collection_request_id, settled);
  await insertOfapiCreditLedgerEntry(db, {
    occurredAt: new Date(row.occurred_at), source: "adjustment", operation: "ofapi_media_download",
    pageId: row.page_id === null ? null : Number(row.page_id), credits: delta, estimated: true,
    requestId: `ofapi_media_download:${row.resolve_id}:settle`, actorUserId,
    details: { certainty: "client_report", resolveId: row.resolve_id, reservedCredits: reserved, settledCredits: settled,
      bytesReceived: report.bytesReceived },
  });
}

/**
 * Applies desktop transfer reports, idempotent by resolveId: a report is
 * accepted once, a repeat is a duplicate, anything else (unknown id, another
 * actor's resolve) is ignored. A paid report of more bytes than its hand-out
 * allowed (the priced size, or the guard of an unknown-size click) is
 * rejected: nothing is applied and the charge stays as issued. A paid
 * transfer becomes `confirmed` only on a reported success; any other result
 * leaves its charge `unknown`, never zero. An unknown-size click is settled
 * down to its reported bytes (above).
 */
export async function applyOfapiMediaFetchReports(db: Database, input: {
  actorUserId: number; reports: readonly OfapiMediaFetchReport[];
}) {
  let accepted = 0;
  let duplicate = 0;
  let unknown = 0;
  let rejected = 0;
  const settled: string[] = [];
  for (const report of input.reports) {
    const updated = await db.transaction(async (tx) => {
      const database = tx as unknown as Database;
      const result = await database.execute<ReportedRow>(sql`
        update ofapi_media_fetch_log set
          client_result = ${report.result},
          bytes_received = ${report.bytesReceived},
          http_status = ${report.httpStatus},
          reported_at = now(),
          certainty = case
            when outcome = 'paid' and ${report.result} = 'ok' then 'confirmed'
            when outcome = 'paid' then 'unknown'
            else certainty end
        where resolve_id = ${report.resolveId}::uuid and actor_user_id = ${input.actorUserId}
          and reported_at is null
          and (outcome <> 'paid' or ${report.bytesReceived}::bigint is null
            or ${report.bytesReceived}::bigint <= coalesce(content_length, ${OFAPI_MEDIA_UNKNOWN_SIZE_GUARD_BYTES}))
        returning resolve_id::text, outcome, content_length, credits_estimated,
          to_char(accrual_day, 'YYYY-MM-DD') as accrual_day, occurred_at, collection_request_id, page_id
      `);
      const row = result.rows[0];
      if (row) await settleUnknownSizeClick(database, row, report, input.actorUserId);
      return row ?? null;
    });
    if (updated) {
      accepted += 1;
      settled.push(report.resolveId);
      continue;
    }
    const existing = await db.execute<{ reported: boolean }>(sql`
      select reported_at is not null as reported from ofapi_media_fetch_log
      where resolve_id = ${report.resolveId}::uuid and actor_user_id = ${input.actorUserId}`);
    const row = existing.rows[0];
    if (row?.reported) {
      duplicate += 1;
      settled.push(report.resolveId);
    } else if (row) {
      rejected += 1;
    } else {
      unknown += 1;
    }
  }
  await releaseOfapiMediaFlight(db, settled);
  return { accepted, duplicate, unknown, rejected };
}
