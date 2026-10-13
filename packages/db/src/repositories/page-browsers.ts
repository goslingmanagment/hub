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
}

type SqlRow = Omit<PageBrowserRow, "pageId" | "selftestAt" | "lastStateAt" | "bufferBytes" | "bufferOldestAgeMs"> & {
  pageId: string | null;
  selftestAt: Date | string | null;
  lastStateAt: Date | string | null;
  bufferBytes: string | null;
  bufferOldestAgeMs: string | null;
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
  b.key_version as "keyVersion"
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
