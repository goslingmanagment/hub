import { sql } from "drizzle-orm";

import type { Database } from "../client.ts";

// The session-less public account reader's own proxy (arena "vanished chat"
// R5, plan §7, owner decision Р1): `fansly_public_egress`, one row at most
// (`*_fansly_public_lookup_egress.sql`). Stored the way a page's proxy is
// (`egress_endpoints`): the proxy URL, and its username and password as one
// encrypted JSON (`encrypted_auth`, with the key version that encrypted it).
// No page owns it and no page may use it; the owner sets and removes it
// (`pnpm cli sync public-lookup proxy set | remove`). No row: the egress
// resolver's `fansly_public` scope has no transport, and the reader sends
// nothing.

export interface FanslyPublicEgressRow {
  url: string;
  encryptedAuth: string | null;
  keyVersion: number | null;
  updatedAt: Date;
}

type EgressSqlRow = {
  url: string;
  encryptedAuth: string | null;
  keyVersion: number | null;
  updatedAt: Date | string;
};

/** The stored proxy, or null when the owner has not configured one. */
export async function readFanslyPublicEgress(db: Database): Promise<FanslyPublicEgressRow | null> {
  const result = await db.execute<EgressSqlRow>(sql`
    select url,
           encrypted_auth as "encryptedAuth",
           key_version as "keyVersion",
           updated_at as "updatedAt"
      from fansly_public_egress
     where id = 1
  `);
  const row = result.rows[0];
  return row
    ? {
      url: row.url,
      encryptedAuth: row.encryptedAuth,
      keyVersion: row.keyVersion === null ? null : Number(row.keyVersion),
      updatedAt: new Date(row.updatedAt),
    }
    : null;
}

/** Store (or replace) the proxy. The caller has validated and encrypted it. */
export async function storeFanslyPublicEgress(
  db: Database,
  input: { url: string; encryptedAuth: string | null; keyVersion: number | null },
): Promise<void> {
  await db.execute(sql`
    insert into fansly_public_egress (id, url, encrypted_auth, key_version, updated_at)
    values (1, ${input.url}, ${input.encryptedAuth}, ${input.keyVersion}, clock_timestamp())
    on conflict (id) do update
       set url = excluded.url,
           encrypted_auth = excluded.encrypted_auth,
           key_version = excluded.key_version,
           updated_at = excluded.updated_at
  `);
}

/** Remove the proxy: the reader has no transport from its next pass. True
 *  when a row was there. */
export async function deleteFanslyPublicEgress(db: Database): Promise<boolean> {
  const result = await db.execute(sql`delete from fansly_public_egress where id = 1`);
  return (result.rowCount ?? 0) > 0;
}

/** Every page's stored proxy (URL and encrypted auth), to tell whether a
 *  candidate for the public egress is one of them. */
export async function listPageEgressEndpoints(db: Database): Promise<Array<{
  pageId: number;
  pageLabel: string;
  url: string;
  encryptedAuth: string | null;
}>> {
  const result = await db.execute<{ pageId: string; pageLabel: string; url: string; encryptedAuth: string | null }>(sql`
    select e.platform_account_id::text as "pageId",
           p.label as "pageLabel",
           e.url,
           e.encrypted_auth as "encryptedAuth"
      from egress_endpoints e
      join pages p on p.id = e.platform_account_id
     order by e.platform_account_id
  `);
  return result.rows.map((row) => ({
    pageId: Number(row.pageId),
    pageLabel: row.pageLabel,
    url: row.url,
    encryptedAuth: row.encryptedAuth,
  }));
}
