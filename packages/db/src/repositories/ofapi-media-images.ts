import { sql } from "drizzle-orm";

import type { Database } from "../client.ts";

// OnlyFans media locators (migration 0210, docs/runbooks/ofapi-media.md): known
// file URLs and where each media appears (links); the AI media describer reads
// them. The hub never stores or relays file bytes. The retired desktop resolve's
// decision log, daily budget and single-flight tables stay in the schema; the
// daily cleanup still purges expired flight markers.

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

// ---- Single flight ---------------------------------------------------------

export async function purgeExpiredOfapiMediaFlights(db: Database, input: { before: Date }) {
  const result = await db.execute(sql`delete from ofapi_media_flights where held_until < ${input.before}::timestamptz`);
  return result.rowCount ?? 0;
}
