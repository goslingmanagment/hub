import { createHash } from "node:crypto";
import { drizzle } from "drizzle-orm/node-postgres";
import { sql } from "drizzle-orm";
import { Client } from "pg";
import { decodeFanslyWsCapture, FANSLY_WS_CAPTURE_KIND, type FanslyWsDecodeNode } from "@agency_hub_core/shared";
import type { Database } from "../client.ts";
import * as schema from "../schema.ts";
import { insertObservation } from "./observations.ts";
import { tryAcquireDmArchiveWriterFenceLock } from "./erasure-fence.ts";

export const FANSLY_WS_LOCK_NS = 58213;

/** A dedicated session, never a pool checkout. All capture and status writes
 * use the session holding this page's lock; a dead owner cannot write through
 * a replacement pool connection. The caller serializes its operations. */
export async function acquireFanslyWsOwnership(connectionString: string, pageId: number, onLost: () => void) {
  const client = new Client({ connectionString, connectionTimeoutMillis: 5_000,
    query_timeout: 5_000, statement_timeout: 5_000, application_name: "fansly-b0" });
  let alive = true;
  function lose() { if (alive) { alive = false; onLost(); } }
  client.on("error", lose);
  client.on("end", lose);
  try {
    await client.connect();
    const result = await client.query<{ locked: boolean }>(
      "select pg_try_advisory_lock($1, $2) as locked", [FANSLY_WS_LOCK_NS, pageId],
    );
    if (!result.rows[0]?.locked) { await client.end(); return null; }
  } catch { lose(); await client.end().catch(() => undefined); throw new Error("fansly_ws_ownership_unavailable"); }
  const db: Database = drizzle(client, { schema });
  return {
    db,
    get alive() { return alive; },
    async close() { lose(); await client.end().catch(() => undefined); },
  };
}

/** Lock the exact rows that define W0's digest through commit. Token, page
 * identity/status and route updates cannot race a successful capture fence. */
export async function lockFanslyWsGeneration(db: Database, pageId: number) {
  await db.execute(sql`select p.id from pages p where p.id=${pageId} for share`);
  await db.execute(sql`select c.platform_account_id from page_credentials c where c.platform_account_id=${pageId} for share`);
  await db.execute(sql`select e.id from egress_endpoints e where e.platform_account_id=${pageId} for share`);
}

/** Precondition: `db` is the session holding this page's advisory lock. That
 * lock is never unlocked explicitly, so any other open row of the page belongs
 * to a session that has already ended and can no longer write. Close it as
 * `abandoned` at its last proof of liveness, never at the current time. One
 * statement: the gap boundary reads the pre-update snapshot, so gap_since is
 * unchanged by the sweep. */
export async function beginFanslyWsConnection(db: Database, input: { id: string; pageId: number; generation: string }) {
  await db.execute(sql`with abandoned as (update fansly_ws_connections
      set closed_at=greatest(last_guard_at,last_capture_at),stop_reason='abandoned'
      where page_id=${input.pageId} and closed_at is null)
    insert into fansly_ws_connections(id,page_id,generation,gap_since)
    values (${input.id}::uuid,${input.pageId},${input.generation},coalesce(
      (select coalesce(c.closed_at,c.last_guard_at) from fansly_ws_connections c
        where c.page_id=${input.pageId} order by c.started_at desc limit 1),clock_timestamp()))`);
}

export async function captureFanslyWsFrame(db: Database, input: {
  connectionId: string; pageId: number; generation: string; accountRef: string;
  ordinal: number; frame: string; receivedAt: Date;
  validate: (tx: Database) => Promise<void>;
}) {
  return db.transaction(async (tx) => {
    const owned = tx as unknown as Database;
    await lockFanslyWsGeneration(owned, input.pageId);
    await input.validate(owned);
    if (!await tryAcquireDmArchiveWriterFenceLock(owned, input.pageId)) throw new Error("fansly_ws_erasure_busy");
    const erased = await tx.execute(sql`select e.id from erasure_log e where e.dry_run=false
      and e.started_at >= ${input.receivedAt} and (
        (e.scope_type in ('page','model') and e.plan->'resolvedPageIds' @> to_jsonb(${input.pageId}::bigint))
        or (e.scope_type='fan' and e.scope_ref like 'fan:fansly:%'
          and (fansly_ws_json_contains(to_jsonb(${input.frame}::text),substring(e.scope_ref from 12))
            or exists(select 1 from jsonb_array_elements_text(coalesce(e.plan->'resolvedFanGroupIds','[]'::jsonb)) as g(ref)
              where fansly_ws_json_contains(to_jsonb(${input.frame}::text),g.ref))))
      ) limit 1`);
    if (erased.rows.length) throw new Error("fansly_ws_material_erased");
    const connection = await tx.execute(sql`select c.id from fansly_ws_connections c
      where c.id=${input.connectionId}::uuid and c.page_id=${input.pageId}
        and c.generation=${input.generation} and c.closed_at is null for update`);
    if (connection.rows.length !== 1) throw new Error("fansly_ws_connection_fenced");
    const inserted = await insertObservation(owned, {
      source: "fansly_ws", producer: "fansly:b0", platform: "fansly", accountId: input.pageId,
      nativeAccountRef: input.accountRef, kind: FANSLY_WS_CAPTURE_KIND,
      payload: { codec: FANSLY_WS_CAPTURE_KIND, frame: input.frame, generation: input.generation },
      payloadHash: createHash("sha256").update(input.frame).digest(),
      idempotencyKey: `${input.connectionId}:${input.ordinal}`, receivedAt: input.receivedAt,
    });
    await tx.execute(sql`insert into fansly_ws_decode_receipts(observation_id,page_id,received_at)
      values(${inserted.observationId},${input.pageId},${inserted.receivedAt}) on conflict do nothing`);
    await tx.execute(sql`update fansly_ws_connections set last_ordinal=greatest(last_ordinal,${input.ordinal}),
      last_capture_at=${input.receivedAt} where id=${input.connectionId}::uuid`);
    return inserted.observationId;
  });
}

export async function settleFanslyWsDecode(db: Database, observationId: number, nodes: FanslyWsDecodeNode[]) {
  const state = nodes.some((n) => n.state !== "retained") ? "debt" : "retained";
  await db.execute(sql`update fansly_ws_decode_receipts set nodes=${JSON.stringify(nodes)}::jsonb,
    state=${state},decoded_at=clock_timestamp() where observation_id=${observationId} and state='pending'`);
}

export async function guardFanslyWsConnection(db: Database, id: string, verified: boolean) {
  await db.execute(sql`update fansly_ws_connections set last_guard_at=clock_timestamp(),
    verified_at=case when ${verified} then coalesce(verified_at,clock_timestamp()) else verified_at end
    where id=${id}::uuid and closed_at is null`);
}

export async function finishFanslyWsConnection(db: Database, id: string, reason: string) {
  await db.execute(sql`update fansly_ws_connections set closed_at=clock_timestamp(),stop_reason=${reason}
    where id=${id}::uuid and closed_at is null`);
}

export async function isFanslyWsGenerationBlocked(db: Database, pageId: number, generation: string) {
  const result = await db.execute(sql`select c.id from fansly_ws_connections c where c.page_id=${pageId}
    and c.generation=${generation} and c.stop_reason='auth_refused' limit 1`);
  return result.rows.length > 0;
}

/** Revisit a bounded batch of already durable inline B0 facts. Missing/tiered
 * observations remain pending; they never become a successful decode receipt. */
export async function replayFanslyWsDecode(db: Database, pageId: number) {
  const result = await db.execute<{ id: string; frame: string }>(sql`
    select r.observation_id::text as id,o.payload->>'frame' as frame
    from fansly_ws_decode_receipts r join observations o
      on o.id=r.observation_id and o.received_at=r.received_at
    where r.page_id=${pageId} and r.state='pending' and o.payload->>'codec'=${FANSLY_WS_CAPTURE_KIND}
    order by r.observation_id limit 20`);
  for (const row of result.rows) await settleFanslyWsDecode(db, Number(row.id), decodeFanslyWsCapture(row.frame));
  return result.rows.length;
}
