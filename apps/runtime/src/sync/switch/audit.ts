import { sql } from "drizzle-orm";

import { insertAuditEvent, type Database } from "@agency_hub_core/db";

// The audit trail of the step-3 switch and its rollback (design step 3 §3.5
// item 7, J4). Every transition of either CLI writes one `audit_events` row;
// the CLIs derive where they are from the database (mode, guard owner,
// `legacy_imported_at`, `requests_enabled_at`) AND the page's newest row of
// either kind, so a half-done rollback is never resumed as a switch (or the
// other way round), and a reverted switch is finished, not re-run.

export const SYNC_SWITCH_AUDIT_EVENT = "admin.sync_switch";
export const SYNC_ROLLBACK_AUDIT_EVENT = "admin.sync_rollback";

/** The switch's phases as audited (`metadata.phase`). */
export const SYNC_SWITCH_PHASES = [
  "start",
  "A_handover",
  "A_guard_handed",
  "B_stopped",
  "R_rebuilt",
  "I_imported",
  "C_live",
  "C_owner",
  "C_requests",
  "H_converted",
  "reverting",
  "reverted",
  "done",
] as const;
export type SyncSwitchPhase = (typeof SYNC_SWITCH_PHASES)[number];

/** The rollback's steps as audited (`metadata.step`). */
export const SYNC_ROLLBACK_STEPS = [
  "start",
  "1_handover",
  "2_released",
  "3_guard_handed",
  "4_work_closed",
  "5_off",
  "waiting_stop",
  "auth_hold",
  "route_holds",
  "done",
] as const;
export type SyncRollbackStep = (typeof SYNC_ROLLBACK_STEPS)[number];

export interface SwitchAuditRow {
  id: number;
  eventType: typeof SYNC_SWITCH_AUDIT_EVENT | typeof SYNC_ROLLBACK_AUDIT_EVENT;
  /** `metadata.phase` of a switch row, `metadata.step` of a rollback row. */
  stage: string;
  createdAt: Date;
  metadata: Record<string, unknown>;
}

function stageOf(eventType: string, metadata: Record<string, unknown>): string {
  const value = eventType === SYNC_SWITCH_AUDIT_EVENT ? metadata.phase : metadata.step;
  return typeof value === "string" ? value : "?";
}

/** The page's newest switch or rollback row (null: neither ever ran). */
export async function readLatestSwitchAudit(db: Database, pageId: number): Promise<SwitchAuditRow | null> {
  const result = await db.execute<{ id: string; eventType: string; createdAt: Date | string; metadata: Record<string, unknown> | null }>(sql`
    select a.id::text as id, a.event_type as "eventType", a.created_at as "createdAt", a.metadata
      from audit_events a
     where a.platform_account_id = ${pageId}
       and a.event_type in (${SYNC_SWITCH_AUDIT_EVENT}, ${SYNC_ROLLBACK_AUDIT_EVENT})
     order by a.id desc
     limit 1
  `);
  const row = result.rows[0];
  if (!row) return null;
  const metadata = row.metadata ?? {};
  return {
    id: Number(row.id),
    eventType: row.eventType as SwitchAuditRow["eventType"],
    stage: stageOf(row.eventType, metadata),
    createdAt: row.createdAt instanceof Date ? row.createdAt : new Date(row.createdAt),
    metadata,
  };
}

/** When the page's current switch run started (its newest `start` row), or
 *  null. The legacy import skips legacy failures recorded after it. */
export async function readSwitchStartedAt(db: Database, pageId: number): Promise<Date | null> {
  const result = await db.execute<{ createdAt: Date | string }>(sql`
    select a.created_at as "createdAt"
      from audit_events a
     where a.platform_account_id = ${pageId}
       and a.event_type = ${SYNC_SWITCH_AUDIT_EVENT}
       and a.metadata ->> 'phase' = 'start'
     order by a.id desc
     limit 1
  `);
  const value = result.rows[0]?.createdAt;
  return value === undefined ? null : value instanceof Date ? value : new Date(value);
}

/** The mode the page's newest rollback run started from (its `start` row's
 *  `from`), or null. */
export async function readRollbackStartedFrom(db: Database, pageId: number): Promise<string | null> {
  const result = await db.execute<{ from: string | null }>(sql`
    select a.metadata ->> 'from' as "from"
      from audit_events a
     where a.platform_account_id = ${pageId}
       and a.event_type = ${SYNC_ROLLBACK_AUDIT_EVENT}
       and a.metadata ->> 'step' = 'start'
     order by a.id desc
     limit 1
  `);
  return result.rows[0]?.from ?? null;
}

/** Whether any page was ever switched live before (the first switched page
 *  opens its history requests one hour after the switch, the others at once). */
export async function anyPageWasLive(db: Database, input: { exceptPageId: number }): Promise<boolean> {
  const result = await db.execute<{ found: boolean }>(sql`
    select exists (
      select 1 from audit_events a
       where a.event_type = ${SYNC_SWITCH_AUDIT_EVENT}
         and a.metadata ->> 'phase' = 'C_live'
         and a.platform_account_id is distinct from ${input.exceptPageId}
    ) as found
  `);
  return result.rows[0]?.found === true;
}

export async function recordSwitchAudit(
  db: Database,
  input: { pageId: number; phase: SyncSwitchPhase; actor: string; detail?: Record<string, unknown> },
): Promise<void> {
  await insertAuditEvent(db, {
    platformAccountId: input.pageId,
    source: "cli",
    eventType: SYNC_SWITCH_AUDIT_EVENT,
    metadata: { phase: input.phase, pageId: input.pageId, actor: input.actor, ...(input.detail ?? {}) },
  });
}

export async function recordRollbackAudit(
  db: Database,
  input: { pageId: number; step: SyncRollbackStep; actor: string; detail?: Record<string, unknown> },
): Promise<void> {
  await insertAuditEvent(db, {
    platformAccountId: input.pageId,
    source: "cli",
    eventType: SYNC_ROLLBACK_AUDIT_EVENT,
    metadata: { step: input.step, pageId: input.pageId, actor: input.actor, ...(input.detail ?? {}) },
  });
}

/** A rollback that has not reached `done`: a switch must never resume it. */
export function isUnfinishedRollback(row: SwitchAuditRow | null): boolean {
  return row !== null && row.eventType === SYNC_ROLLBACK_AUDIT_EVENT && row.stage !== "done";
}
