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
}

type SqlRow = Omit<
  PageBrowserRow,
  "pageId" | "selftestAt" | "lastStateAt" | "bufferBytes" | "bufferOldestAgeMs" | "handoverGeneration" | "handoverQuiescedAt" | "handoverLastSendAt"
  | "pinnedExitIpAt" | "bufferUndrainedSince"
> & {
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

const columns = sql`
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
  b.encrypted_engine_token as "encryptedEngineToken",
  b.encrypted_api_token as "encryptedApiToken",
  b.encrypted_vnc_password as "encryptedVncPassword",
  b.key_version as "keyVersion",
  b.pinned_exit_ip as "pinnedExitIp",
  b.pinned_exit_ip_at as "pinnedExitIpAt",
  b.env,
  b.handover_generation::text as "handoverGeneration",
  b.handover_quiesced_at as "handoverQuiescedAt",
  b.handover_last_send_at as "handoverLastSendAt",
  b.buffer_undrained_since as "bufferUndrainedSince"
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
  };
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
}

/** The operator's last `state`, at the database's clock. The link works:
 *  the engine's link error is cleared with it. */
export async function recordPageBrowserState(db: Database, input: PageBrowserStateInput): Promise<boolean> {
  const result = await db.execute(sql`
    update page_browsers
       set step = ${input.step},
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
