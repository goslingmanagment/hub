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

/** A site socket's connection on a browser page (Project Browser, plan §3.2
 * «Кадры сокета», 0273): the row opens on the operator's `ws.open`, marked
 * `origin = 'browser'` with the operator's connection id. Idempotent by that
 * id within the page: a `ws.open` delivered again opens nothing twice (false).
 * As for the engine's own socket, another open row of the page is closed
 * `abandoned` at its last proof of liveness (one socket of a page at a time),
 * and gap_since is taken from the previous row of the page. `startedAt` is
 * when the operator saw the socket open (never later than the database's
 * clock). */
export async function beginBrowserWsConnection(db: Database, input: {
  id: string; pageId: number; generation: string; browserConnectionId: string; startedAt: Date;
  /** A loss the operator marked before this connection (its `gap`, PR 13):
   * the gap starts no later than this, whatever the previous row says. */
  gapSince?: Date | null;
}): Promise<boolean> {
  const marked = input.gapSince ?? null;
  return db.transaction(async (raw) => {
    const tx = raw as unknown as Database;
    const known = await tx.execute(sql`select c.id from fansly_ws_connections c
      where c.page_id=${input.pageId} and c.browser_connection_id=${input.browserConnectionId}::uuid`);
    if (known.rows.length > 0) return false;
    await tx.execute(sql`with abandoned as (update fansly_ws_connections
        set closed_at=greatest(last_guard_at,last_capture_at),stop_reason='abandoned'
        where page_id=${input.pageId} and closed_at is null)
      insert into fansly_ws_connections(id,page_id,generation,origin,browser_connection_id,started_at,last_guard_at,gap_since)
      select ${input.id}::uuid,${input.pageId},${input.generation},'browser',${input.browserConnectionId}::uuid,
        s.at,s.at,least(coalesce(
          (select coalesce(c.closed_at,c.last_guard_at) from fansly_ws_connections c
            where c.page_id=${input.pageId} order by c.started_at desc limit 1),s.at),
          ${marked === null ? null : marked.toISOString()}::timestamptz)
      from (select least(clock_timestamp(),${input.startedAt.toISOString()}::timestamptz) as at) s
      on conflict (page_id, browser_connection_id) where browser_connection_id is not null do nothing`);
    return true;
  });
}

/** How one frame of a site socket was taken (`captureBrowserWsFrame`). */
export type BrowserWsFrameCapture =
  | { kind: "captured"; observationId: number; receivedAt: Date; inserted: boolean }
  /** Kept as a fact that nothing applies: its connection is unknown to the
   *  page (its `ws.open` was lost) or of a session the page did not verify. */
  | { kind: "kept"; why: "unattributed" | "unverified_session" }
  /** An erasure that started after the frame arrived covers it. */
  | { kind: "erased" };

/** The observation key of a frame from a page's operator buffer: its event
 * id (plan §3.2 «Кадры сокета»). */
export function browserWsFrameKey(bufferId: string, seq: number): string {
  return `browser:${bufferId}:${seq}`;
}

/**
 * One business frame of a site socket from the operator's buffer (Project
 * Browser, plan §3.2 «Кадры сокета», §4.4; PR 13), in the caller's
 * transaction (the intake's batch, after its generation fence). Taken by its
 * event id — `browser:<buffer id>:<number>`, so a frame delivered again is
 * no duplicate — and fenced by the page and the session it came under: the
 * connection row of the page the operator's `ws.open` opened (its generation
 * is that session's), open or not, since a frame from the buffer may outlive
 * its connection. Then as the engine's own socket: the observation with the
 * B0 codec, the decode receipt the live overlay applies, the row's last
 * capture. A frame of a connection the page has no row of (its `ws.open`
 * lost), or whose session is not the one the engine trusts
 * (`trustedGeneration`: `sync_pages.credentials_generation`), is kept as a
 * fact under `fansly.ws.frame.v1:<why>` with no receipt: nothing applies it
 * and no family parses it (the erasure finds it by its codec). Throws
 * `fansly_ws_erasure_busy` while an erasure holds the page.
 */
export async function captureBrowserWsFrame(tx: Database, input: {
  pageId: number; browserConnectionId: string; bufferId: string; seq: number;
  accountRef: string | null; frame: string; receivedAt: Date; trustedGeneration: string | null;
}): Promise<BrowserWsFrameCapture> {
  if (!await tryAcquireDmArchiveWriterFenceLock(tx, input.pageId)) throw new Error("fansly_ws_erasure_busy");
  const connection = await tx.execute<{ id: string; generation: string }>(sql`select c.id::text as id, c.generation
    from fansly_ws_connections c
    where c.page_id=${input.pageId} and c.browser_connection_id=${input.browserConnectionId}::uuid`);
  const row = connection.rows[0];
  if (await fanslyWsFrameErased(tx, input)) return { kind: "erased" };
  const doubtful = row === undefined ? "unattributed" as const
    : row.generation !== input.trustedGeneration ? "unverified_session" as const : null;
  if (doubtful !== null) {
    await insertObservation(tx, {
      source: "fansly_ws", producer: "fansly:browser", platform: "fansly", accountId: input.pageId,
      nativeAccountRef: input.accountRef, kind: `${FANSLY_WS_CAPTURE_KIND}:${doubtful}`,
      payload: { codec: FANSLY_WS_CAPTURE_KIND, frame: input.frame, generation: row?.generation ?? null, disposition: "kept_not_applied" },
      payloadHash: createHash("sha256").update(input.frame).digest(),
      idempotencyKey: browserWsFrameKey(input.bufferId, input.seq), receivedAt: input.receivedAt,
    });
    return { kind: "kept", why: doubtful };
  }
  if (row === undefined) return { kind: "kept", why: "unattributed" };
  const inserted = await insertObservation(tx, {
    source: "fansly_ws", producer: "fansly:browser", platform: "fansly", accountId: input.pageId,
    nativeAccountRef: input.accountRef, kind: FANSLY_WS_CAPTURE_KIND,
    payload: { codec: FANSLY_WS_CAPTURE_KIND, frame: input.frame, generation: row.generation },
    payloadHash: createHash("sha256").update(input.frame).digest(),
    idempotencyKey: browserWsFrameKey(input.bufferId, input.seq), receivedAt: input.receivedAt,
  });
  await tx.execute(sql`insert into fansly_ws_decode_receipts(observation_id,page_id,received_at)
    values(${inserted.observationId},${input.pageId},${inserted.receivedAt}) on conflict do nothing`);
  await tx.execute(sql`update fansly_ws_connections set last_ordinal=greatest(last_ordinal,${input.seq}),
    last_capture_at=greatest(coalesce(last_capture_at,'-infinity'::timestamptz),${inserted.receivedAt}::timestamptz)
    where id=${row.id}::uuid`);
  return { kind: "captured", observationId: inserted.observationId, receivedAt: inserted.receivedAt, inserted: inserted.inserted };
}

/**
 * A loss on a site socket's connection the engine knows of (PR 13): a frame
 * the engine could not keep (one the business traversal refuses), events the
 * operator no longer has. The connection — `browserConnectionId`, or the
 * page's newest browser row still open — has its gap start no later than
 * `since` and is unreconciled again, so the socket's repair (`repair.ws-gap`,
 * `readFanslyWsGapPass`) reads it back. Null: no such connection (the next
 * one's gap takes it); `verified`: the repair can run now.
 */
export async function markBrowserWsLoss(tx: Database, input: {
  pageId: number; browserConnectionId: string | null; since: Date;
}): Promise<{ verified: boolean } | null> {
  const target = input.browserConnectionId === null
    ? sql`(select c.id from fansly_ws_connections c where c.page_id=${input.pageId} and c.origin='browser'
        and c.closed_at is null order by c.started_at desc limit 1)`
    : sql`(select c.id from fansly_ws_connections c where c.page_id=${input.pageId}
        and c.browser_connection_id=${input.browserConnectionId}::uuid)`;
  const result = await tx.execute<{ verified: boolean }>(sql`update fansly_ws_connections
      set gap_since=least(gap_since, ${input.since.toISOString()}::timestamptz), state_reconciled_at=null
    where id=${target}
    returning verified_at is not null as verified`);
  const row = result.rows[0];
  return row === undefined ? null : { verified: row.verified === true };
}

/**
 * The last proof of life of a site socket's connection: the operator's
 * instant of its latest event (a frame of any kind, the session's
 * confirmation, a pong) — what the engine's own socket's guard proves every
 * few seconds. The next connection's gap starts there when this one was
 * never seen to close, and an abandoned row closes there. Never moves back,
 * never past its close.
 */
export async function touchBrowserWsConnection(tx: Database, input: {
  pageId: number; browserConnectionId: string; at: Date;
}): Promise<void> {
  await tx.execute(sql`update fansly_ws_connections
      set last_guard_at=greatest(last_guard_at, least(coalesce(closed_at, 'infinity'::timestamptz), clock_timestamp(),
        ${input.at.toISOString()}::timestamptz))
    where page_id=${input.pageId} and browser_connection_id=${input.browserConnectionId}::uuid`);
}

/**
 * The site's socket confirmed the session (its auth answer, `t:1`) on a
 * connection of the page: verified at the operator's instant, once. True
 * when this call verified it — the socket is up, and its gap gets its
 * repair (`repair.ws-gap`), as the engine's own socket's.
 */
export async function verifyBrowserWsConnection(tx: Database, input: {
  pageId: number; browserConnectionId: string; at: Date;
}): Promise<boolean> {
  const result = await tx.execute(sql`update fansly_ws_connections
      set verified_at=greatest(started_at, least(clock_timestamp(), ${input.at.toISOString()}::timestamptz))
    where page_id=${input.pageId} and browser_connection_id=${input.browserConnectionId}::uuid and verified_at is null
    returning id`);
  return result.rows.length === 1;
}

/** The operator's `ws.close` of a site socket (0273): the row closes at the
 * instant the operator saw it close (never before it opened, never after the
 * database's clock), once. False: no open row of that connection. */
export async function finishBrowserWsConnection(db: Database, input: {
  pageId: number; browserConnectionId: string; closedAt: Date; reason: string;
}): Promise<boolean> {
  const result = await db.execute(sql`update fansly_ws_connections
      set closed_at=greatest(started_at, least(clock_timestamp(), ${input.closedAt.toISOString()}::timestamptz)),
        stop_reason=${input.reason}
    where page_id=${input.pageId} and browser_connection_id=${input.browserConnectionId}::uuid and closed_at is null
    returning id`);
  return result.rows.length === 1;
}

/** An erasure that started after the frame arrived and covers it (its page,
 * or a fan it names): the frame must not be written back. */
async function fanslyWsFrameErased(db: Database, input: { pageId: number; frame: string; receivedAt: Date }) {
  const erased = await db.execute(sql`select e.id from erasure_log e where e.dry_run=false
    and e.started_at >= ${input.receivedAt} and (
      (e.scope_type in ('page','model') and e.plan->'resolvedPageIds' @> to_jsonb(${input.pageId}::bigint))
      or (e.scope_type='fan' and e.scope_ref like 'fan:fansly:%'
        and (fansly_ws_json_contains(to_jsonb(${input.frame}::text),substring(e.scope_ref from 12))
          or exists(select 1 from jsonb_array_elements_text(coalesce(e.plan->'resolvedFanGroupIds','[]'::jsonb)) as g(ref)
            where fansly_ws_json_contains(to_jsonb(${input.frame}::text),g.ref))))
    ) limit 1`);
  return erased.rows.length > 0;
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
    if (await fanslyWsFrameErased(owned, input)) throw new Error("fansly_ws_material_erased");
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

/** `intakeStoppedAt` is when the receiver stopped reading the socket. A
 * graceful stop drains already received frames after that instant, and the
 * close must not move the next attempt's gap boundary past the last frame the
 * socket could deliver. Never later than the database clock. */
export async function finishFanslyWsConnection(db: Database, id: string, reason: string, intakeStoppedAt?: Date) {
  const closedAt = intakeStoppedAt === undefined ? sql`clock_timestamp()`
    : sql`greatest(started_at, least(clock_timestamp(), ${intakeStoppedAt}::timestamptz))`;
  await db.execute(sql`update fansly_ws_connections set closed_at=${closedAt},stop_reason=${reason}
    where id=${id}::uuid and closed_at is null`);
}

export async function isFanslyWsGenerationBlocked(db: Database, pageId: number, generation: string) {
  const result = await db.execute(sql`select c.id from fansly_ws_connections c where c.page_id=${pageId}
    and c.generation=${generation} and c.stop_reason='auth_refused' limit 1`);
  return result.rows.length > 0;
}

/** Revisit a bounded batch of already durable inline B0 facts. Missing/tiered
 * observations remain pending; they never become a successful decode receipt.
 * Only receipts captured before the live overlay (`live_state='legacy'`): the
 * live apply settles every newer receipt's metadata in its own transaction,
 * and this writer never waits on a receipt that apply holds. */
export async function replayFanslyWsDecode(db: Database, pageId: number) {
  const result = await db.execute<{ id: string; frame: string }>(sql`
    select r.observation_id::text as id,o.payload->>'frame' as frame
    from fansly_ws_decode_receipts r join observations o
      on o.id=r.observation_id and o.received_at=r.received_at
    where r.page_id=${pageId} and r.state='pending' and r.live_state='legacy'
      and o.payload->>'codec'=${FANSLY_WS_CAPTURE_KIND}
    order by r.observation_id limit 20`);
  for (const row of result.rows) await settleFanslyWsDecode(db, Number(row.id), decodeFanslyWsCapture(row.frame));
  return result.rows.length;
}
