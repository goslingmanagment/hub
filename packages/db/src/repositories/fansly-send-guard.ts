import { sql } from "drizzle-orm";

import type { Database } from "../client.ts";

// Plan §2.5 step 1: the per-page Fansly send guard of the legacy engine. One
// row per page, shared by every process (api, worker, CLI); every statement
// here is a single conditional statement on that row, timed by the DATABASE
// clock (`clock_timestamp()`, never `now()`: a statement that waited for the
// row lock must not stamp the time its transaction began).
//
// The rules the statements implement:
//   - capture only when nobody holds the page and
//     clock_timestamp() >= last_completed_at + S × (1 + next_u);
//   - the capture holds the page until its holder writes a completion, which
//     stamps last_completed_at and draws the next u;
//   - an expired lease does NOT open the page: only the holder's completion or
//     a confirmation that the holder's process is gone (`confirm…`, with
//     next_u = 0.2, i.e. another 1.2 × S) does;
//   - each capture and its journal row are one statement, so no capture exists
//     without its journal row;
//   - only a row the legacy engine owns (`owner_engine = 'legacy'`, 0229) can
//     be captured: once the step-3 switch gave the page to the Fansly Sync
//     Engine, every legacy capture is refused (`engine_owned`), in every
//     process and from every source.

/** u after seeding and after a confirmed termination: the next capture waits
 *  1.2 × S. Mirrors the 0225 seed. */
export const FANSLY_SEND_GUARD_RESTART_U = 0.2;

/** Who may capture a page's guard row (0229 `owner_engine`, its CHECK). Every
 *  row is `legacy` until the step-3 switch flips it; only the switch and its
 *  rollback change it. */
export const FANSLY_SEND_GUARD_OWNER_ENGINES = ["legacy", "fansly_sync_engine"] as const;
export type FanslySendGuardOwnerEngine = (typeof FANSLY_SEND_GUARD_OWNER_ENGINES)[number];
/** The owner whose processes this module's capture serves. */
export const FANSLY_SEND_GUARD_LEGACY_OWNER = "legacy" satisfies FanslySendGuardOwnerEngine;

export interface FanslySendHolderIdentity {
  host: string;
  pid: number;
  pidStart: string | null;
  pidNs: string | null;
  bootId: string | null;
  instance: string;
  role: string;
}

export interface CaptureFanslyPageSendGuardInput {
  pageId: number;
  token: string;
  source: string;
  operation: string;
  holder: FanslySendHolderIdentity;
  settingMs: number;
  leaseMs: number;
  captureWaitMs: number;
  captureRefusals: number;
}

export interface FanslySendGuardHolderSummary {
  token: string;
  source: string | null;
  operation: string | null;
  host: string | null;
  pid: number | null;
  role: string | null;
  instance: string | null;
  leaseUntil: Date | null;
}

export type CaptureFanslyPageSendGuardResult =
  | { kind: "captured"; journalId: string; jitterU: number; pauseMs: number }
  /** Free, but the pause since the previous completion has not elapsed. */
  | { kind: "pause"; waitMs: number }
  /** Held. `leaseExpired`: the holder overran its lease and the page is
   *  closed until it completes or its death is confirmed. */
  | { kind: "busy"; leaseExpired: boolean; holder: FanslySendGuardHolderSummary }
  /** The page belongs to the Fansly Sync Engine (0229): no legacy capture,
   *  whatever the holder or the pause. Reported before `busy` and `pause`. */
  | { kind: "engine_owned"; ownerEngine: string; engineSwitchedAt: Date | null };

type HolderRow = {
  holderToken: string | null;
  holderSource: string | null;
  holderOperation: string | null;
  holderHost: string | null;
  holderPid: number | null;
  holderRole: string | null;
  holderInstance: string | null;
  leaseUntil: Date | string | null;
};

function toDate(value: Date | string | null | undefined): Date | null {
  if (value === null || value === undefined) return null;
  return value instanceof Date ? value : new Date(value);
}

function holderSummary(row: HolderRow & { holderToken: string }): FanslySendGuardHolderSummary {
  return {
    token: row.holderToken,
    source: row.holderSource,
    operation: row.holderOperation,
    host: row.holderHost,
    pid: row.holderPid,
    role: row.holderRole,
    instance: row.holderInstance,
    leaseUntil: toDate(row.leaseUntil),
  };
}

/** Create the page's guard row if it has none, seeded like 0225: as if its
 *  previous request had just completed, with u = 0.2. Never touches a row
 *  that exists. */
export async function ensureFanslyPageSendGuard(db: Database, pageId: number): Promise<void> {
  await db.execute(sql`
    insert into fansly_page_send_guards (page_id, last_completed_at, next_u, updated_at)
    values (${pageId}, clock_timestamp(), ${FANSLY_SEND_GUARD_RESTART_U}, clock_timestamp())
    on conflict (page_id) do nothing
  `);
}

/**
 * Try to capture the page. On success the capture and its journal row are
 * written by ONE statement. Otherwise the row is read back to say why: owned
 * by the Fansly Sync Engine, held (and whether the holder overran its lease)
 * or the time left of the pause, computed by the database clock. A page
 * without a row gets one (seeded closed for 1.2 × S, owned by the legacy
 * engine) and reports that pause. A refusal writes nothing.
 */
export async function captureFanslyPageSendGuard(
  db: Database,
  input: CaptureFanslyPageSendGuardInput,
): Promise<CaptureFanslyPageSendGuardResult> {
  const { holder } = input;
  const captured = await db.execute<{ journalId: string; jitterU: number; pauseMs: number }>(sql`
    with captured as (
      update fansly_page_send_guards g
         set holder_token = ${input.token}::uuid,
             holder_source = ${input.source},
             holder_operation = ${input.operation},
             holder_host = ${holder.host},
             holder_pid = ${holder.pid},
             holder_pid_start = ${holder.pidStart},
             holder_pid_ns = ${holder.pidNs},
             holder_boot_id = ${holder.bootId},
             holder_instance = ${holder.instance}::uuid,
             holder_role = ${holder.role},
             captured_at = clock_timestamp(),
             lease_until = clock_timestamp() + ${input.leaseMs}::double precision * interval '1 millisecond',
             closed_reason = null,
             closed_at = null,
             updated_at = clock_timestamp()
       where g.page_id = ${input.pageId}
         and g.owner_engine = 'legacy'
         and g.holder_token is null
         and clock_timestamp() >= g.last_completed_at
           + (${input.settingMs}::double precision * (1 + g.next_u)) * interval '1 millisecond'
      returning g.page_id, g.captured_at, g.lease_until, g.last_completed_at, g.next_u
    ), journal as (
      insert into fansly_send_log (
        page_id, guard_token, source, operation, holder_host, holder_pid, holder_role,
        holder_instance, setting_ms, jitter_u, pause_ms, previous_completed_at,
        capture_wait_ms, capture_refusals, captured_at, lease_until
      )
      select page_id, ${input.token}::uuid, ${input.source}, ${input.operation},
             ${holder.host}, ${holder.pid}, ${holder.role}, ${holder.instance}::uuid,
             ${input.settingMs}, next_u,
             ceil(${input.settingMs}::double precision * (1 + next_u))::integer,
             last_completed_at, ${input.captureWaitMs}, ${input.captureRefusals}, captured_at, lease_until
        from captured
      returning id, jitter_u, pause_ms
    )
    select id::text as "journalId", jitter_u as "jitterU", pause_ms as "pauseMs" from journal
  `);
  const row = captured.rows[0];
  if (row) {
    return { kind: "captured", journalId: row.journalId, jitterU: Number(row.jitterU), pauseMs: Number(row.pauseMs) };
  }

  const state = await db.execute<HolderRow & {
    ownerEngine: string;
    engineSwitchedAt: Date | string | null;
    leaseExpired: boolean;
    remainingMs: number;
  }>(sql`
    select owner_engine as "ownerEngine",
           engine_switched_at as "engineSwitchedAt",
           holder_token as "holderToken",
           holder_source as "holderSource",
           holder_operation as "holderOperation",
           holder_host as "holderHost",
           holder_pid as "holderPid",
           holder_role as "holderRole",
           holder_instance::text as "holderInstance",
           lease_until as "leaseUntil",
           coalesce(lease_until <= clock_timestamp(), false) as "leaseExpired",
           greatest(0, extract(epoch from (
             last_completed_at
               + (${input.settingMs}::double precision * (1 + next_u)) * interval '1 millisecond'
               - clock_timestamp()
           )) * 1000)::double precision as "remainingMs"
      from fansly_page_send_guards
     where page_id = ${input.pageId}
  `);
  const current = state.rows[0];
  if (!current) {
    await ensureFanslyPageSendGuard(db, input.pageId);
    return { kind: "pause", waitMs: 0 };
  }
  if (current.ownerEngine !== FANSLY_SEND_GUARD_LEGACY_OWNER) {
    return {
      kind: "engine_owned",
      ownerEngine: current.ownerEngine,
      engineSwitchedAt: toDate(current.engineSwitchedAt),
    };
  }
  if (current.holderToken !== null) {
    return {
      kind: "busy",
      leaseExpired: current.leaseExpired === true,
      holder: holderSummary({ ...current, holderToken: current.holderToken }),
    };
  }
  return { kind: "pause", waitMs: Math.max(0, Number(current.remainingMs)) };
}

/** Journal an attempt that is paced against no page: the check of a session
 *  whose account is not known yet (plan §2.4, owner decision №4). */
export async function journalUnpacedFanslySend(
  db: Database,
  input: {
    token: string;
    source: string;
    operation: string;
    holder: FanslySendHolderIdentity;
  },
): Promise<{ journalId: string }> {
  const result = await db.execute<{ journalId: string }>(sql`
    insert into fansly_send_log (
      page_id, guard_token, source, operation, holder_host, holder_pid, holder_role,
      holder_instance, captured_at
    ) values (
      null, ${input.token}::uuid, ${input.source}, ${input.operation}, ${input.holder.host},
      ${input.holder.pid}, ${input.holder.role}, ${input.holder.instance}::uuid, clock_timestamp()
    )
    returning id::text as "journalId"
  `);
  const row = result.rows[0];
  if (!row) throw new Error("fansly_send_log insert returned no row");
  return { journalId: row.journalId };
}

/** The send moment, written as soon as the transport is about to write the
 *  headers (best effort: the completion writes it too), so an attempt whose
 *  holder dies before completing still shows when it was sent. */
export async function markFanslySendAttemptSent(
  db: Database,
  input: { token: string; sentAt: Date; sendOffsetMs: number },
): Promise<void> {
  await db.execute(sql`
    update fansly_send_log
       set sent_at = ${input.sentAt},
           send_offset_ms = ${input.sendOffsetMs}
     where guard_token = ${input.token}::uuid
       and sent_at is null
  `);
}

export interface CompleteFanslySendAttemptInput {
  /** Null for an unpaced attempt: only its journal row is completed. */
  pageId: number | null;
  /** The capture's token; it also names the attempt's journal row. */
  token: string;
  /** u for the next pause, drawn by the caller; ignored without a page. */
  nextU: number;
  outcome: "response" | "transport_error" | "timeout" | "aborted_before_send";
  outcomeDetail: string | null;
  httpStatus: number | null;
  sentAt: Date | null;
  sendOffsetMs: number | null;
}

/**
 * The holder's completion: release the page (only if this token still holds
 * it) with last_completed_at = clock_timestamp() and the new u, and complete
 * the attempt's journal row with the same instant. Idempotent: a repeated
 * completion matches nothing. `released` is false when the token no longer
 * held the page (its death was confirmed meanwhile) or there is no page.
 */
export async function completeFanslySendAttempt(
  db: Database,
  input: CompleteFanslySendAttemptInput,
): Promise<{ released: boolean; journaled: boolean }> {
  const result = await db.execute<{ released: number; journaled: number }>(sql`
    with released as (
      update fansly_page_send_guards
         set holder_token = null,
             holder_source = null,
             holder_operation = null,
             holder_host = null,
             holder_pid = null,
             holder_pid_start = null,
             holder_pid_ns = null,
             holder_boot_id = null,
             holder_instance = null,
             holder_role = null,
             captured_at = null,
             lease_until = null,
             closed_reason = null,
             closed_at = null,
             last_completed_at = clock_timestamp(),
             next_u = ${input.nextU},
             updated_at = clock_timestamp()
       where page_id = ${input.pageId}
         and holder_token = ${input.token}::uuid
      returning last_completed_at
    ), journaled as (
      update fansly_send_log
         set completed_at = coalesce((select last_completed_at from released), clock_timestamp()),
             outcome = ${input.outcome},
             outcome_detail = ${input.outcomeDetail},
             http_status = ${input.httpStatus},
             sent_at = coalesce(${input.sentAt}, sent_at),
             send_offset_ms = coalesce(${input.sendOffsetMs}, send_offset_ms)
       where guard_token = ${input.token}::uuid
         and completed_at is null
      returning id
    )
    select (select count(*) from released)::int as released,
           (select count(*) from journaled)::int as journaled
  `);
  const row = result.rows[0];
  return { released: Number(row?.released ?? 0) > 0, journaled: Number(row?.journaled ?? 0) > 0 };
}

export interface FanslySendGuardRow {
  pageId: number;
  pageLabel: string | null;
  holderToken: string | null;
  holderSource: string | null;
  holderOperation: string | null;
  holderHost: string | null;
  holderPid: number | null;
  holderPidStart: string | null;
  holderPidNs: string | null;
  holderBootId: string | null;
  holderInstance: string | null;
  holderRole: string | null;
  capturedAt: Date | null;
  leaseUntil: Date | null;
  leaseExpired: boolean;
  lastCompletedAt: Date;
  nextU: number;
  closedReason: string | null;
  closedAt: Date | null;
  /** 0229: `legacy`, or `fansly_sync_engine` once the switch gave it away. */
  ownerEngine: string;
  engineSwitchedAt: Date | null;
  dbNow: Date;
}

type GuardSqlRow = Omit<
  FanslySendGuardRow,
  "pageId" | "capturedAt" | "leaseUntil" | "lastCompletedAt" | "closedAt" | "engineSwitchedAt" | "dbNow"
> & {
  pageId: string | number | bigint;
  capturedAt: Date | string | null;
  leaseUntil: Date | string | null;
  lastCompletedAt: Date | string;
  closedAt: Date | string | null;
  engineSwitchedAt: Date | string | null;
  dbNow: Date | string;
};

function normalizeGuardRow(row: GuardSqlRow): FanslySendGuardRow {
  return {
    ...row,
    pageId: Number(row.pageId),
    holderPid: row.holderPid === null ? null : Number(row.holderPid),
    nextU: Number(row.nextU),
    leaseExpired: row.leaseExpired === true,
    capturedAt: toDate(row.capturedAt),
    leaseUntil: toDate(row.leaseUntil),
    lastCompletedAt: toDate(row.lastCompletedAt) as Date,
    closedAt: toDate(row.closedAt),
    engineSwitchedAt: toDate(row.engineSwitchedAt),
    dbNow: toDate(row.dbNow) as Date,
  };
}

const guardColumns = sql`
  g.page_id::text as "pageId",
  p.label as "pageLabel",
  g.holder_token::text as "holderToken",
  g.holder_source as "holderSource",
  g.holder_operation as "holderOperation",
  g.holder_host as "holderHost",
  g.holder_pid as "holderPid",
  g.holder_pid_start as "holderPidStart",
  g.holder_pid_ns as "holderPidNs",
  g.holder_boot_id as "holderBootId",
  g.holder_instance::text as "holderInstance",
  g.holder_role as "holderRole",
  g.captured_at as "capturedAt",
  g.lease_until as "leaseUntil",
  coalesce(g.lease_until <= clock_timestamp(), false) as "leaseExpired",
  g.last_completed_at as "lastCompletedAt",
  g.next_u as "nextU",
  g.closed_reason as "closedReason",
  g.closed_at as "closedAt",
  g.owner_engine as "ownerEngine",
  g.engine_switched_at as "engineSwitchedAt",
  clock_timestamp() as "dbNow"
`;

/** Every guard row, for `fansly-send-guard status`. */
export async function listFanslySendGuards(db: Database): Promise<FanslySendGuardRow[]> {
  const result = await db.execute<GuardSqlRow>(sql`
    select ${guardColumns}
      from fansly_page_send_guards g
      left join pages p on p.id = g.page_id
     order by p.label nulls last, g.page_id
  `);
  return result.rows.map(normalizeGuardRow);
}

/** Held rows, for the termination confirmation. `expiredOnly` limits them to
 *  holders that overran their lease (the sweeper's view). */
export async function listHeldFanslySendGuards(
  db: Database,
  options: { expiredOnly: boolean },
): Promise<FanslySendGuardRow[]> {
  const result = await db.execute<GuardSqlRow>(sql`
    select ${guardColumns}
      from fansly_page_send_guards g
      left join pages p on p.id = g.page_id
     where g.holder_token is not null
       and (${!options.expiredOnly} or g.lease_until <= clock_timestamp())
     order by g.page_id
  `);
  return result.rows.map(normalizeGuardRow);
}

/** Record that the page is closed: its holder overran the lease and is not
 *  confirmed dead. Changes nothing else; the page stays held. */
export async function markFanslySendGuardClosed(
  db: Database,
  input: { pageId: number; token: string; reason: string },
): Promise<boolean> {
  const result = await db.execute(sql`
    update fansly_page_send_guards
       set closed_reason = ${input.reason},
           closed_at = clock_timestamp(),
           updated_at = clock_timestamp()
     where page_id = ${input.pageId}
       and holder_token = ${input.token}::uuid
       and closed_reason is null
       and lease_until <= clock_timestamp()
  `);
  return (result.rowCount ?? 0) > 0;
}

/**
 * The holder's process is confirmed gone (by the OS or by Docker): release the
 * page as if its request had completed now, with u = 0.2 (the next capture
 * waits 1.2 × S), and complete the holder's journal row as
 * `confirmed_terminated`. Only the exact token is released, so a capture that
 * replaced it is never touched. Returns whether this call released it.
 */
export async function confirmFanslySendGuardTerminated(
  db: Database,
  input: { pageId: number; token: string; evidence: string; requireExpiredLease: boolean },
): Promise<boolean> {
  const result = await db.execute<{ released: number }>(sql`
    with released as (
      update fansly_page_send_guards
         set holder_token = null,
             holder_source = null,
             holder_operation = null,
             holder_host = null,
             holder_pid = null,
             holder_pid_start = null,
             holder_pid_ns = null,
             holder_boot_id = null,
             holder_instance = null,
             holder_role = null,
             captured_at = null,
             lease_until = null,
             closed_reason = null,
             closed_at = null,
             last_completed_at = clock_timestamp(),
             next_u = ${FANSLY_SEND_GUARD_RESTART_U},
             updated_at = clock_timestamp()
       where page_id = ${input.pageId}
         and holder_token = ${input.token}::uuid
         and (${!input.requireExpiredLease} or lease_until <= clock_timestamp())
      returning last_completed_at
    ), journaled as (
      update fansly_send_log
         set completed_at = (select last_completed_at from released),
             outcome = 'confirmed_terminated',
             outcome_detail = ${input.evidence}
       where guard_token = ${input.token}::uuid
         and completed_at is null
         and exists (select 1 from released)
      returning id
    )
    select (select count(*) from released)::int as released
  `);
  return Number(result.rows[0]?.released ?? 0) > 0;
}
