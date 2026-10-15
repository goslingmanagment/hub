import { isIP } from "node:net";

import { sql } from "drizzle-orm";

import type { Database } from "../client.ts";

// Project Browser (plan §3.1, §3.4, §4.11; 0275): one row per browser
// profile — its container on pb-control, the page it serves (null until it
// is bound), the operator's last `state`, and the page's secrets of it (the
// engine's and the API's RPC tokens, the KasmVNC password), each an
// encrypted JSON envelope as `egress_endpoints.encrypted_auth` keeps a
// proxy's auth. The ciphertexts are opened only by the runtime
// (`services/page-browser-secrets.ts`).

export interface PageBrowserRow {
  profileId: string;
  pageId: number | null;
  container: string;
  step: string | null;
  stopReason: string | null;
  mode: "automation" | "manual_login";
  exitOpen: boolean;
  sessionFingerprint: string | null;
  accountId: string | null;
  exitIp: string | null;
  chromeVersion: string | null;
  operatorVersion: string | null;
  selftestOk: boolean | null;
  selftestAt: Date | null;
  selftestFailed: string | null;
  bufferBytes: number | null;
  bufferOldestAgeMs: number | null;
  lastStateAt: Date | null;
  linkError: string | null;
  encryptedEngineToken: string;
  encryptedApiToken: string;
  encryptedVncPassword: string;
  keyVersion: number;
  /** The exit IP the owner pinned for the page (0277; `hello.pinnedExitIp`)
   *  and when; null until pinned. */
  pinnedExitIp: string | null;
  pinnedExitIpAt: Date | null;
  /** The browser's environment (0277; `hello.env`), as stored; read through
   *  `pageBrowserEnvOf`. Null until set. */
  env: Record<string, unknown> | null;
  /** The newest owner generation of the page whose hello the operator
   *  answered with `quiesced` (0277; plan §4.7): the earlier owners' requests
   *  are over. Null: none yet. */
  handoverGeneration: bigint | null;
  /** When the engine heard that `quiesced`. */
  handoverQuiescedAt: Date | null;
  /** The browser's last send as it named it (null: it knows of none). */
  handoverLastSendAt: Date | null;
  /** The owner said the container stopped before the operator's buffer was
   *  drained (0278): what it kept waits there. Null: drained. */
  bufferUndrainedSince: Date | null;
  /** The operator's next start after a failure (0281; `state.retryAtWall`). */
  retryAt: Date | null;
  /** Since when the operator has not said `ready` (0281): its browser is not
   *  up. Null while it is ready (or before its first state). */
  downSince: Date | null;
  /** Since when the operator has said its current stop reason (0281). */
  stopSince: Date | null;
  /** The delivery of the operator's events to the engine's commit over the
   *  last minutes (0281), as the engine measured it, and when it said so. */
  deliveryP50Ms: number | null;
  deliveryP95Ms: number | null;
  deliveryAt: Date | null;
  /** The operator's last alarm (0281; spec §6.1 `alarm`, scalar details). */
  alarmKind: string | null;
  alarmAt: Date | null;
  alarmDetail: Record<string, string | number | boolean> | null;
  /** The owner's `sync browser stop` (0281): when and by whom (null: not
   *  stopped by the owner). Whether it put the page's pause is the page's
   *  (`sync_pages.browser_stop_paused`). */
  ownerStopAt: Date | null;
  ownerStopBy: string | null;
  /** A mirror of the halt the operator holds for the owner's decision on
   *  its volume (0281; `state.halt`): its reason, since when, its id. The
   *  operator enforces it, never this mirror. Null: none said. */
  haltReason: string | null;
  haltAt: Date | null;
  haltId: string | null;
}

type SqlRow = Omit<
  PageBrowserRow,
  "pageId" | "selftestAt" | "lastStateAt" | "bufferBytes" | "bufferOldestAgeMs" | "handoverGeneration" | "handoverQuiescedAt" | "handoverLastSendAt"
  | "pinnedExitIpAt" | "bufferUndrainedSince" | "retryAt" | "downSince" | "stopSince" | "deliveryP50Ms" | "deliveryP95Ms" | "deliveryAt"
  | "alarmAt" | "alarmDetail" | "ownerStopAt" | "haltAt"
> & {
  haltAt: Date | string | null;
  retryAt: Date | string | null;
  downSince: Date | string | null;
  stopSince: Date | string | null;
  deliveryP50Ms: string | null;
  deliveryP95Ms: string | null;
  deliveryAt: Date | string | null;
  alarmAt: Date | string | null;
  alarmDetail: unknown;
  ownerStopAt: Date | string | null;
  bufferUndrainedSince: Date | string | null;
  pinnedExitIpAt: Date | string | null;
  pageId: string | null;
  selftestAt: Date | string | null;
  lastStateAt: Date | string | null;
  bufferBytes: string | null;
  bufferOldestAgeMs: string | null;
  handoverGeneration: string | null;
  handoverQuiescedAt: Date | string | null;
  handoverLastSendAt: Date | string | null;
};

/** Every column but the three secrets: what a status read needs, and all
 *  the read role may see. */
const publicColumns = sql`
  b.profile_id::text as "profileId",
  b.page_id::text as "pageId",
  b.container,
  b.step,
  b.stop_reason as "stopReason",
  b.mode,
  b.exit_open as "exitOpen",
  b.session_fingerprint as "sessionFingerprint",
  b.account_id as "accountId",
  b.exit_ip as "exitIp",
  b.chrome_version as "chromeVersion",
  b.operator_version as "operatorVersion",
  b.selftest_ok as "selftestOk",
  b.selftest_at as "selftestAt",
  b.selftest_failed as "selftestFailed",
  b.buffer_bytes::text as "bufferBytes",
  b.buffer_oldest_age_ms::text as "bufferOldestAgeMs",
  b.last_state_at as "lastStateAt",
  b.link_error as "linkError",
  b.key_version as "keyVersion",
  b.pinned_exit_ip as "pinnedExitIp",
  b.pinned_exit_ip_at as "pinnedExitIpAt",
  b.env,
  b.handover_generation::text as "handoverGeneration",
  b.handover_quiesced_at as "handoverQuiescedAt",
  b.handover_last_send_at as "handoverLastSendAt",
  b.buffer_undrained_since as "bufferUndrainedSince",
  b.retry_at as "retryAt",
  b.down_since as "downSince",
  b.stop_since as "stopSince",
  b.delivery_p50_ms::text as "deliveryP50Ms",
  b.delivery_p95_ms::text as "deliveryP95Ms",
  b.delivery_at as "deliveryAt",
  b.alarm_kind as "alarmKind",
  b.alarm_at as "alarmAt",
  b.alarm_detail as "alarmDetail",
  b.owner_stop_at as "ownerStopAt",
  b.owner_stop_by as "ownerStopBy",
  b.halt_reason as "haltReason",
  b.halt_at as "haltAt",
  b.halt_id as "haltId"
`;

const columns = sql`
  ${publicColumns},
  b.encrypted_engine_token as "encryptedEngineToken",
  b.encrypted_api_token as "encryptedApiToken",
  b.encrypted_vnc_password as "encryptedVncPassword"
`;

function dateOf(value: Date | string | null): Date | null {
  return value === null ? null : value instanceof Date ? value : new Date(value);
}

function numberOf(value: string | null): number | null {
  return value === null ? null : Number(value);
}

function rowOf(row: SqlRow): PageBrowserRow {
  return {
    ...row,
    pageId: numberOf(row.pageId),
    selftestAt: dateOf(row.selftestAt),
    lastStateAt: dateOf(row.lastStateAt),
    bufferBytes: numberOf(row.bufferBytes),
    bufferOldestAgeMs: numberOf(row.bufferOldestAgeMs),
    pinnedExitIpAt: dateOf(row.pinnedExitIpAt),
    env: row.env !== null && typeof row.env === "object" && !Array.isArray(row.env) ? row.env : null,
    handoverGeneration: row.handoverGeneration === null ? null : BigInt(row.handoverGeneration),
    handoverQuiescedAt: dateOf(row.handoverQuiescedAt),
    handoverLastSendAt: dateOf(row.handoverLastSendAt),
    bufferUndrainedSince: dateOf(row.bufferUndrainedSince),
    retryAt: dateOf(row.retryAt),
    downSince: dateOf(row.downSince),
    stopSince: dateOf(row.stopSince),
    deliveryP50Ms: numberOf(row.deliveryP50Ms),
    deliveryP95Ms: numberOf(row.deliveryP95Ms),
    deliveryAt: dateOf(row.deliveryAt),
    alarmAt: dateOf(row.alarmAt),
    alarmDetail: scalarDetailOf(row.alarmDetail),
    ownerStopAt: dateOf(row.ownerStopAt),
    haltAt: dateOf(row.haltAt),
  };
}

/** An alarm's details as kept: its scalar entries only (spec §6.1 says the
 *  operator sends no secrets; nothing nested is kept or shown). */
export function scalarDetailOf(value: unknown): Record<string, string | number | boolean> | null {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return null;
  const out: Record<string, string | number | boolean> = {};
  for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
    if (typeof item === "string" || typeof item === "boolean" || (typeof item === "number" && Number.isFinite(item))) out[key] = item;
  }
  return out;
}

export interface InsertPageBrowserInput {
  profileId: string;
  container: string;
  /** Each an encrypted JSON envelope (serialized), sealed with `keyVersion`. */
  encryptedEngineToken: string;
  encryptedApiToken: string;
  encryptedVncPassword: string;
  keyVersion: number;
  /** The page it serves already (null: bound later). */
  pageId?: number | null;
}

/** A new profile's row. A profile that exists already is left as it is
 *  (its secrets are never replaced here): returns false then. */
export async function insertPageBrowser(db: Database, input: InsertPageBrowserInput): Promise<boolean> {
  const result = await db.execute(sql`
    insert into page_browsers (profile_id, page_id, container, encrypted_engine_token, encrypted_api_token,
                               encrypted_vnc_password, key_version)
    values (${input.profileId}::uuid, ${input.pageId ?? null}::bigint, ${input.container}, ${input.encryptedEngineToken},
            ${input.encryptedApiToken}, ${input.encryptedVncPassword}, ${input.keyVersion}::integer)
    on conflict (profile_id) do nothing
    returning profile_id
  `);
  return result.rows.length === 1;
}

/** Bind a profile to a page (plan §3.2, step 4 of a new page). A page has one
 *  profile at most (the unique key refuses a second). */
export async function bindPageBrowser(db: Database, input: { profileId: string; pageId: number }): Promise<boolean> {
  const result = await db.execute(sql`
    update page_browsers set page_id = ${input.pageId}::bigint, updated_at = clock_timestamp()
     where profile_id = ${input.profileId}::uuid
    returning profile_id
  `);
  return result.rows.length === 1;
}

export async function findPageBrowserByPage(db: Database, pageId: number): Promise<PageBrowserRow | null> {
  const result = await db.execute<SqlRow>(sql`select ${columns} from page_browsers b where b.page_id = ${pageId}::bigint`);
  const row = result.rows[0];
  return row === undefined ? null : rowOf(row);
}

export async function findPageBrowser(db: Database, profileId: string): Promise<PageBrowserRow | null> {
  const result = await db.execute<SqlRow>(sql`select ${columns} from page_browsers b where b.profile_id = ${profileId}::uuid`);
  const row = result.rows[0];
  return row === undefined ? null : rowOf(row);
}

/** What the operator said of itself (`state`, spec §6.1), as Hub keeps it. */
export interface PageBrowserStateInput {
  profileId: string;
  step: string;
  stopReason: string | null;
  mode: "automation" | "manual_login";
  exitOpen: boolean;
  sessionFingerprint: string | null;
  accountId: string | null;
  exitIp: string | null;
  chromeVersion: string;
  operatorVersion: string;
  selfTest: { ok: boolean; at: Date; failed: string | null } | null;
  buffer: { bytes: number; oldestAgeMs: number };
  /** The operator's next start after a failure (`state.retryAtWall`; 0281).
   *  Absent: not said (kept as it is). */
  retryAt?: Date | null;
  /** The halt the operator holds for the owner's decision (`state.halt`,
   *  minor 1): mirrored. Null or absent: none said. */
  halt?: { id: string; reason: string; at: Date } | null;
  /** The id of the last halt the operator cleared (`state.lastClearedHaltId`):
   *  the mirror lets a halt go only on it (Astra round 4). */
  lastClearedHaltId?: string | null;
}

/** The operator's last `state`, at the database's clock. The link works:
 *  the engine's link error is cleared with it. Since when the browser is not
 *  up (`down_since`: any step but `ready`) and since when it says its stop
 *  reason (`stop_since`) are kept across states (0281). */
export async function recordPageBrowserState(db: Database, input: PageBrowserStateInput): Promise<boolean> {
  const retry = input.retryAt === undefined ? sql`retry_at` : sql`${input.retryAt === null ? null : input.retryAt.toISOString()}::timestamptz`;
  const saidId = input.halt?.id ?? null;
  const saidReason = input.halt?.reason ?? null;
  const cleared = input.lastClearedHaltId ?? null;
  // Whether the halt said (or none) replaces the one the mirror holds.
  const takes = sql`when halt_reason is null
                      or (halt_id is not null and halt_id = ${cleared}::text)
                      or (${saidId}::text is not null and halt_reason = 'login_required' and ${saidReason}::text <> 'login_required')`;
  const result = await db.execute(sql`
    update page_browsers
       set down_since = case when ${input.step} = 'ready' then null else coalesce(down_since, clock_timestamp()) end,
           stop_since = case when ${input.stopReason}::text is null then null
                             when stop_reason is not distinct from ${input.stopReason}::text then coalesce(stop_since, clock_timestamp())
                             else clock_timestamp() end,
           retry_at = ${retry},
           step = ${input.step},
           stop_reason = ${input.stopReason},
           mode = ${input.mode},
           exit_open = ${input.exitOpen},
           session_fingerprint = ${input.sessionFingerprint},
           account_id = ${input.accountId},
           exit_ip = ${input.exitIp},
           chrome_version = ${input.chromeVersion},
           operator_version = ${input.operatorVersion},
           selftest_ok = ${input.selfTest?.ok ?? null}::boolean,
           selftest_at = ${input.selfTest === null ? null : input.selfTest.at.toISOString()}::timestamptz,
           selftest_failed = ${input.selfTest?.failed ?? null},
           buffer_bytes = ${Math.max(0, Math.round(input.buffer.bytes))}::bigint,
           buffer_oldest_age_ms = ${Math.max(0, Math.round(input.buffer.oldestAgeMs))}::bigint,
           -- The mirror (Astra rounds 4 and 5): the stricter of the halt it
           -- holds and the one said — any halt but login_required outranks
           -- it; else the one held stands — until the operator says it cleared
           -- the one held (lastClearedHaltId) or the owner's decision clears it
           -- (clearPageBrowserHaltMirror). A halt no longer said (lost by a
           -- restart) stays; an older login_required said never replaces a
           -- stricter one held.
           halt_reason = case ${takes} then ${input.halt?.reason ?? null}::text else halt_reason end,
           halt_at = case ${takes} then ${input.halt === undefined || input.halt === null ? null : input.halt.at.toISOString()}::timestamptz else halt_at end,
           halt_id = case ${takes} then ${input.halt?.id ?? null}::text else halt_id end,
           last_state_at = clock_timestamp(),
           link_error = null,
           updated_at = clock_timestamp()
     where profile_id = ${input.profileId}::uuid
    returning profile_id
  `);
  return result.rows.length === 1;
}

/** The engine's own word on its link (spec §6.3 rule 6: `protocol_version`,
 *  `token`); null when it works again. */
export async function recordPageBrowserLinkError(db: Database, input: { profileId: string; linkError: string | null }): Promise<boolean> {
  const result = await db.execute(sql`
    update page_browsers set link_error = ${input.linkError}, updated_at = clock_timestamp()
     where profile_id = ${input.profileId}::uuid
    returning profile_id
  `);
  return result.rows.length === 1;
}

/**
 * The operator answered the hello of owner `generation` with `quiesced`
 * (plan §4.7, §4.13; 0277): the earlier owners' requests are over and nothing
 * of them is in flight. Kept on the profile's row for the deploy's
 * `sync ownership confirm-stopped`, which waits for it, and for the status.
 * Never moves back: an earlier owner's word written late changes nothing.
 * True: recorded (or already there for this generation).
 */
export async function recordPageBrowserHandover(
  db: Database,
  input: { profileId: string; generation: bigint; lastSendAt: Date | null },
): Promise<boolean> {
  const result = await db.execute(sql`
    update page_browsers
       set handover_generation = ${input.generation.toString()}::bigint,
           handover_quiesced_at = clock_timestamp(),
           handover_last_send_at = ${input.lastSendAt === null ? null : input.lastSendAt.toISOString()}::timestamptz,
           updated_at = clock_timestamp()
     where profile_id = ${input.profileId}::uuid
       and (handover_generation is null or handover_generation < ${input.generation.toString()}::bigint)
    returning profile_id
  `);
  if (result.rows.length === 1) return true;
  const current = await db.execute<{ generation: string | null }>(sql`
    select handover_generation::text as generation from page_browsers where profile_id = ${input.profileId}::uuid
  `);
  return current.rows[0]?.generation === input.generation.toString();
}

/** A browser's environment (spec §6.1 `hello.env`; plan §4.1 step 2). */
export interface PageBrowserEnv {
  timeZone: string;
  languages: string[];
  geolocation: { latitude: number; longitude: number; accuracyM: number };
}

/** The stored environment, whole and well-formed, or null. */
export function pageBrowserEnvOf(stored: Record<string, unknown> | null): PageBrowserEnv | null {
  if (stored === null) return null;
  const { timeZone, languages, geolocation } = stored as { timeZone?: unknown; languages?: unknown; geolocation?: unknown };
  if (typeof timeZone !== "string" || timeZone.length === 0) return null;
  if (!Array.isArray(languages) || languages.length === 0 || !languages.every((tag) => typeof tag === "string" && tag.length > 0)) return null;
  const geo = geolocation as { latitude?: unknown; longitude?: unknown; accuracyM?: unknown } | null | undefined;
  if (geo === null || typeof geo !== "object") return null;
  const { latitude, longitude, accuracyM } = geo;
  if (typeof latitude !== "number" || !Number.isFinite(latitude) || latitude < -90 || latitude > 90) return null;
  if (typeof longitude !== "number" || !Number.isFinite(longitude) || longitude < -180 || longitude > 180) return null;
  if (typeof accuracyM !== "number" || !Number.isFinite(accuracyM) || accuracyM <= 0) return null;
  return { timeZone, languages: [...(languages as string[])], geolocation: { latitude, longitude, accuracyM } };
}

/**
 * What the engine's hello tells the page's operator besides its proxy
 * (0277): the pinned exit IP and the environment. Fields left undefined keep
 * their value; a pin stamps its instant. False: no such profile.
 */
export async function setPageBrowserSettings(
  db: Database,
  input: { profileId: string; pinnedExitIp?: string | null; env?: PageBrowserEnv | null },
): Promise<boolean> {
  if (input.pinnedExitIp !== undefined && input.pinnedExitIp !== null && isIP(input.pinnedExitIp) === 0) {
    throw new Error(`Not an IP address: ${input.pinnedExitIp}`);
  }
  if (input.env !== undefined && input.env !== null && pageBrowserEnvOf(input.env as unknown as Record<string, unknown>) === null) {
    throw new Error("Not a browser environment: timeZone, languages and geolocation {latitude, longitude, accuracyM}");
  }
  const pin = input.pinnedExitIp !== undefined;
  const env = input.env !== undefined;
  const result = await db.execute(sql`
    update page_browsers
       set pinned_exit_ip = case when ${pin} then ${input.pinnedExitIp ?? null}::text else pinned_exit_ip end,
           pinned_exit_ip_at = case when ${pin} then (case when ${input.pinnedExitIp ?? null}::text is null then null else clock_timestamp() end)
                                    else pinned_exit_ip_at end,
           env = case when ${env} then ${input.env === undefined || input.env === null ? null : JSON.stringify(input.env)}::jsonb else env end,
           updated_at = clock_timestamp()
     where profile_id = ${input.profileId}::uuid
    returning profile_id
  `);
  return result.rows.length === 1;
}

/** A live page on its browser, and whether its operator answered its current
 *  owner's hello with `quiesced` (0277). */
export interface BrowserPageHandover {
  pageId: number;
  pageLabel: string | null;
  ownerGeneration: bigint;
  handoverGeneration: bigint | null;
  /** The current owner's hand-over is confirmed by the operator. */
  quiesced: boolean;
}

/** Every live page whose transport is its browser (of `pageIds`, when
 *  given), with its hand-over (`sync ownership confirm-stopped` waits for
 *  them, plan §4.7). */
export async function listBrowserPageHandovers(db: Database, input: { pageIds?: readonly number[] } = {}): Promise<BrowserPageHandover[]> {
  const filter = input.pageIds === undefined ? sql`` : sql`and sp.page_id = any(${sql.param(input.pageIds.map(String))}::bigint[])`;
  const result = await db.execute<{ pageId: string; pageLabel: string | null; ownerGeneration: string; handoverGeneration: string | null }>(sql`
    select sp.page_id::text as "pageId", p.label as "pageLabel", sp.owner_generation::text as "ownerGeneration",
           b.handover_generation::text as "handoverGeneration"
      from sync_pages sp
      left join pages p on p.id = sp.page_id
      left join page_browsers b on b.page_id = sp.page_id
     where sp.transport = 'browser' and sp.mode = 'live'
       ${filter}
     order by sp.page_id
  `);
  return result.rows.map((row) => {
    const ownerGeneration = BigInt(row.ownerGeneration);
    const handoverGeneration = row.handoverGeneration === null ? null : BigInt(row.handoverGeneration);
    return {
      pageId: Number(row.pageId),
      pageLabel: row.pageLabel,
      ownerGeneration,
      handoverGeneration,
      quiesced: ownerGeneration > 0n && handoverGeneration === ownerGeneration,
    };
  });
}

/** The owner said the page's browser container is stopped before its
 *  operator's buffer was drained (0278): the mark stays until the operator
 *  says it keeps nothing. Its first instant is kept. False: no profile. */
export async function markPageBrowserUndrained(db: Database, input: { pageId: number }): Promise<boolean> {
  const result = await db.execute(sql`
    update page_browsers
       set buffer_undrained_since = coalesce(buffer_undrained_since, clock_timestamp()), updated_at = clock_timestamp()
     where page_id = ${input.pageId}::bigint
    returning profile_id
  `);
  return result.rows.length === 1;
}

/** The operator keeps nothing any more: the buffer is drained. True: a mark
 *  was cleared. */
export async function clearPageBrowserUndrained(db: Database, input: { profileId: string }): Promise<boolean> {
  const result = await db.execute(sql`
    update page_browsers set buffer_undrained_since = null, updated_at = clock_timestamp()
     where profile_id = ${input.profileId}::uuid and buffer_undrained_since is not null
    returning profile_id
  `);
  return result.rows.length === 1;
}

/** The delivery of the operator's events to the engine's commit over the
 *  last minutes, as the engine measured it (0281). */
export async function recordPageBrowserDelivery(
  db: Database,
  input: { profileId: string; p50Ms: number | null; p95Ms: number | null },
): Promise<boolean> {
  const ms = (value: number | null) => (value === null ? null : Math.max(0, Math.round(value)));
  const result = await db.execute(sql`
    update page_browsers
       set delivery_p50_ms = ${ms(input.p50Ms)}::bigint, delivery_p95_ms = ${ms(input.p95Ms)}::bigint,
           delivery_at = clock_timestamp(), updated_at = clock_timestamp()
     where profile_id = ${input.profileId}::uuid
    returning profile_id
  `);
  return result.rows.length === 1;
}

/** The operator's alarm (spec §6.1 `alarm`; 0281): its kind, its instant
 *  (never later than the database's clock) and its scalar details. The newest
 *  alarm wins; an older one written late changes nothing. */
export async function recordPageBrowserAlarm(
  db: Database,
  input: { profileId: string; kind: string; at: Date; detail: Record<string, unknown> },
): Promise<boolean> {
  const detail = scalarDetailOf(input.detail) ?? {};
  const result = await db.execute(sql`
    update page_browsers
       set alarm_kind = ${input.kind},
           alarm_at = least(${input.at.toISOString()}::timestamptz, clock_timestamp()),
           alarm_detail = ${JSON.stringify(detail)}::jsonb,
           updated_at = clock_timestamp()
     where profile_id = ${input.profileId}::uuid
       and (alarm_at is null or alarm_at <= least(${input.at.toISOString()}::timestamptz, clock_timestamp()))
    returning profile_id
  `);
  return result.rows.length === 1;
}

/**
 * The page row lock (`sync_pages`, FOR NO KEY UPDATE) every writer of the
 * page's pause, its login's pause and the owner's stop takes first, in its
 * transaction — one row, one order (PR 17, Astra round 2): the page row, then
 * its browser's row. The same lock as the owner's pause, the login's
 * transitions and the engine's fenced writes (`lockOwnedPage`).
 */
async function lockPageRow(tx: Database, input: { pageId: number }): Promise<void> {
  await tx.execute(sql`select page_id from sync_pages where page_id = ${input.pageId}::bigint for no key update`);
}

/** In a transaction of its own, or as a savepoint of the caller's. */
function inTransaction<T>(db: Database, body: (tx: Database) => Promise<T>): Promise<T> {
  return db.transaction(async (raw) => body(raw as unknown as Database));
}

/**
 * The owner stops the page's browser (`sync browser stop`, plan §4.11; 0281):
 * the mark the engine keeps the browser stopped by, and its author. A page
 * already stopped by the owner keeps its first mark. Under the page row
 * lock, then the browser's row. Null: no profile bound to the page.
 */
export async function setPageBrowserOwnerStop(
  db: Database,
  input: { pageId: number; by: string },
): Promise<{ profileId: string; stoppedAt: Date; already: boolean } | null> {
  return inTransaction(db, async (tx) => {
    await lockPageRow(tx, { pageId: input.pageId });
    const result = await tx.execute<{ profileId: string; stoppedAt: Date | string; already: boolean }>(sql`
      update page_browsers b
         set owner_stop_at = coalesce(b.owner_stop_at, clock_timestamp()),
             owner_stop_by = coalesce(b.owner_stop_by, ${input.by}),
             updated_at = clock_timestamp()
        from (select profile_id, owner_stop_at is not null as already from page_browsers where page_id = ${input.pageId}::bigint for update) old
       where b.profile_id = old.profile_id
      returning b.profile_id::text as "profileId", b.owner_stop_at as "stoppedAt", old.already
    `);
    const row = result.rows[0];
    return row === undefined ? null : { profileId: row.profileId, stoppedAt: dateOf(row.stoppedAt)!, already: row.already === true };
  });
}

/** The owner starts the page's browser again (`sync browser start`, his
 *  decision): the stop's mark is lifted, under the page row lock, then the
 *  browser's row. Returns whether it stood, and the halt the operator holds
 *  as Hub mirrors it — the one his start clears (`clearHalt` with its id;
 *  the operator lifts it, never Hub). Null: no profile bound. */
export async function clearPageBrowserOwnerStop(
  db: Database,
  input: { pageId: number },
): Promise<{ profileId: string; wasStopped: boolean; halt: { id: string | null; reason: string; at: Date } | null } | null> {
  return inTransaction(db, async (tx) => {
    await lockPageRow(tx, { pageId: input.pageId });
    const result = await tx.execute<{ profileId: string; wasStopped: boolean; haltReason: string | null; haltAt: Date | string | null; haltId: string | null }>(sql`
      update page_browsers b
         set owner_stop_at = null, owner_stop_by = null, updated_at = clock_timestamp()
        from (select profile_id, owner_stop_at is not null as was_stopped
                from page_browsers where page_id = ${input.pageId}::bigint for update) old
       where b.profile_id = old.profile_id
      returning b.profile_id::text as "profileId", old.was_stopped as "wasStopped", b.halt_reason as "haltReason", b.halt_at as "haltAt", b.halt_id as "haltId"
    `);
    const row = result.rows[0];
    if (row === undefined) return null;
    return {
      profileId: row.profileId,
      wasStopped: row.wasStopped === true,
      halt: row.haltReason === null ? null : { id: row.haltId, reason: row.haltReason, at: dateOf(row.haltAt)! },
    };
  });
}

/**
 * The owner's decision on a halt (his audited `sync browser start`, or `sync
 * browser-profile clear-halt` for a profile no page has), once its
 * `clearHalt` was taken by the operator: Hub's mirror of that very halt goes
 * with it (Astra round 4: the mirror refuses starts until then). True: it
 * held that halt.
 */
export async function clearPageBrowserHaltMirror(db: Database, input: { profileId: string; haltId: string }): Promise<boolean> {
  const result = await db.execute(sql`
    update page_browsers
       set halt_reason = null, halt_at = null, halt_id = null, updated_at = clock_timestamp()
     where profile_id = ${input.profileId}::uuid and halt_id = ${input.haltId}
    returning profile_id
  `);
  return result.rows.length === 1;
}

/** The operator's stop reasons that are no halt for the owner's decision:
 *  the owner's own stop, and a buffer that does not open (the operator
 *  stands again by itself once it opens). */
const NOT_THE_OWNERS_DECISION: ReadonlySet<string> = new Set(["owner_stop", "buffer_unavailable"]);

/** A state of the operator that stands for the owner's decision: a stop
 *  reason it does not retry by itself (no next retry), but the owner's own
 *  stop and an unopenable buffer. A reason this build does not know counts
 *  (fail closed). */
export function isOwnerDecisionHalt(state: { stopReason: string | null; retryAtWall: number | null }): boolean {
  return state.stopReason !== null && state.retryAtWall === null && !NOT_THE_OWNERS_DECISION.has(state.stopReason);
}

/** A profile bound to a page, with the page's label and transport and where
 *  the engine's intake of its buffer stands (the owner's view of every page's
 *  browser). */
export interface PageBrowserOfPage {
  browser: PageBrowserRow;
  pageId: number;
  pageLabel: string | null;
  transport: "node" | "browser";
  /** The page's pending leave of its browser (0278): since when. */
  leaveSince: Date | null;
  /** The page's whole pause is the owner's browser stop's (0281). */
  browserStopPaused: boolean;
  /** The intake (0276): the operator's instant of the last socket open or
   *  message committed (its loss boundary, #614), the last commit, and a
   *  halted buffer (null: none). */
  intake: {
    lastEventAt: Date | null;
    lastCommitAt: Date | null;
    halted: { reason: string; at: Date | null } | null;
  };
}

/** Every profile bound to a page (of `pageIds`, when given), by page. */
export async function listPageBrowsersOfPages(db: Database, input: { pageIds?: readonly number[] } = {}): Promise<PageBrowserOfPage[]> {
  const filter = input.pageIds === undefined ? sql`` : sql`and b.page_id = any(${sql.param(input.pageIds.map(String))}::bigint[])`;
  const result = await db.execute<SqlRow & {
    label: string | null;
    transport: string | null;
    leaveSince: Date | string | null;
    browserStopPaused: boolean | null;
    eventsLastWall: Date | string | null;
    eventsUpdatedAt: Date | string | null;
    haltedReason: string | null;
    haltedAt: Date | string | null;
  }>(sql`
    select ${publicColumns}, ''::text as "encryptedEngineToken", ''::text as "encryptedApiToken", ''::text as "encryptedVncPassword",
           p.label, sp.transport, sp.browser_leave_requested_at as "leaveSince", sp.browser_stop_paused as "browserStopPaused",
           b.events_last_wall as "eventsLastWall", b.events_updated_at as "eventsUpdatedAt",
           b.events_halted_reason as "haltedReason", b.events_halted_at as "haltedAt"
      from page_browsers b
      join pages p on p.id = b.page_id
      left join sync_pages sp on sp.page_id = b.page_id
     where b.page_id is not null ${filter}
     order by p.label, b.page_id
  `);
  return result.rows.map((row) => {
    const { label, transport, leaveSince, browserStopPaused, eventsLastWall, eventsUpdatedAt, haltedReason, haltedAt, ...rest } = row;
    const browser = rowOf(rest as SqlRow);
    return {
      browser,
      pageId: browser.pageId!,
      pageLabel: label,
      transport: transport === "browser" ? "browser" : "node",
      leaveSince: dateOf(leaveSince),
      browserStopPaused: browserStopPaused === true,
      intake: {
        lastEventAt: dateOf(eventsLastWall),
        lastCommitAt: dateOf(eventsUpdatedAt),
        halted: haltedReason === null ? null : { reason: haltedReason, at: dateOf(haltedAt) },
      },
    };
  });
}

/** What a page's browser may be told, read fresh by the page's owner right
 *  before it commands it (0281): the page's transport, its pending leave and
 *  its owner generation, its pause, the owner's login of the browser and the
 *  owner's stop. (A halt for the owner's decision is the operator's: it
 *  refuses a start itself.) */
export interface PageBrowserControlRead {
  pageId: number;
  transport: "node" | "browser" | null;
  /** The pending leave of the page's browser (0278): its generation. */
  leaveGeneration: bigint | null;
  ownerGeneration: bigint | null;
  pausedAll: boolean;
  /** The whole pause is the one the owner's browser stop put (0281). */
  browserStopPaused: boolean;
  /** The owner's login of the page's browser (0279; null: no engine row). */
  manualLogin: "off" | "wanted" | "ending" | null;
  ownerStopAt: Date | null;
  /** Hub's mirror of the halt the operator holds (Astra round 4): kept until
   *  the operator says it cleared it, it refuses starts besides the
   *  operator's own refusal. */
  haltReason: string | null;
  haltId: string | null;
}

/** The control read of a profile (null: no such profile, or it serves no
 *  page). */
export async function readPageBrowserControl(db: Database, input: { profileId: string }): Promise<PageBrowserControlRead | null> {
  const result = await db.execute<{
    pageId: string; transport: string | null; leaveGeneration: string | null; ownerGeneration: string | null;
    pausedAll: boolean | null; browserStopPaused: boolean | null; manualLogin: string | null; ownerStopAt: Date | string | null;
    haltReason: string | null; haltId: string | null;
  }>(sql`
    select b.page_id::text as "pageId", sp.transport, sp.browser_leave_generation::text as "leaveGeneration",
           sp.owner_generation::text as "ownerGeneration", sp.paused_all as "pausedAll", sp.browser_stop_paused as "browserStopPaused",
           sp.manual_login as "manualLogin", b.owner_stop_at as "ownerStopAt", b.halt_reason as "haltReason", b.halt_id as "haltId"
      from page_browsers b
      left join sync_pages sp on sp.page_id = b.page_id
     where b.profile_id = ${input.profileId}::uuid and b.page_id is not null
  `);
  const row = result.rows[0];
  if (row === undefined) return null;
  return {
    pageId: Number(row.pageId),
    transport: row.transport === "browser" ? "browser" : row.transport === "node" ? "node" : null,
    leaveGeneration: row.leaveGeneration === null ? null : BigInt(row.leaveGeneration),
    ownerGeneration: row.ownerGeneration === null ? null : BigInt(row.ownerGeneration),
    pausedAll: row.pausedAll === true,
    browserStopPaused: row.browserStopPaused === true,
    manualLogin: row.manualLogin === "off" || row.manualLogin === "wanted" || row.manualLogin === "ending" ? row.manualLogin : null,
    ownerStopAt: dateOf(row.ownerStopAt),
    haltReason: row.haltReason,
    haltId: row.haltId,
  };
}

/** Whether the owner's stop stands on the page's browser now, and the page's
 *  latest stop command (`sync browser stop|snapshot`): the stop in force is
 *  that command's. Read under the browser row's lock, in the caller's
 *  transaction — `sync browser start --if-stop` (the Chrome update, PR 18)
 *  lifts only the stop its own command made. Null: no profile bound. */
export async function readPageBrowserOwnerStop(
  db: Database,
  input: { pageId: number },
): Promise<{ stopped: boolean; lastStopCommandId: number | null } | null> {
  const result = await db.execute<{ stopped: boolean; lastStop: string | null }>(sql`
    select pb.owner_stop_at is not null as stopped,
           (select max(c.id) from page_browser_commands c where c.page_id = pb.page_id and c.kind = 'stopPage')::text as "lastStop"
      from page_browsers pb
     where pb.page_id = ${input.pageId}::bigint
       for update of pb
  `);
  const row = result.rows[0];
  if (row === undefined) return null;
  return { stopped: row.stopped === true, lastStopCommandId: row.lastStop === null ? null : Number(row.lastStop) };
}
