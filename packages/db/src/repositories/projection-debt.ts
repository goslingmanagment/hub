import { sql } from "drizzle-orm";

import type { Database } from "../client.ts";

// A2b (decision #135): repair ledger for rebuildable projections. When the
// dm_messages executor's finalize/checkpoint step fails (the message facts
// are already committed and the raw payload was journaled at fetch time),
// the failure is recorded here instead of wedging the stream; the periodic
// sweep re-runs the recompute and resolves. Rows are never deleted (DP 7) —
// resolution is resolved_at, and resolved history is the audit trail.

export const PROJECTION_DEBT_KIND_PAGE_DM_THREAD_SUMMARY = "page_dm_thread_summary";

export interface ProjectionDebtRow {
  id: number;
  kind: string;
  platformAccountId: number;
  conversationId: number;
  errorSummary: string | null;
  attempts: number;
  firstSeenAt: Date;
  lastAttemptAt: Date;
  resolvedAt: Date | null;
}

export interface RecordProjectionDebtInput {
  kind: string;
  platformAccountId: number;
  conversationId: number;
  errorSummary?: string | null;
}

/** Upsert against the unresolved partial-unique row: a fresh failure inserts
 * attempts=1; a repeat failure on the open row bumps attempts/last_attempt_at
 * and refreshes the error summary. */
export async function recordProjectionDebt(
  db: Database,
  input: RecordProjectionDebtInput,
): Promise<void> {
  await db.execute(sql`
    insert into projection_debt (kind, platform_account_id, conversation_id, error_summary)
    values (${input.kind}, ${input.platformAccountId}, ${input.conversationId}, ${input.errorSummary ?? null})
    on conflict (kind, conversation_id) where resolved_at is null
    do update set
      attempts = projection_debt.attempts + 1,
      last_attempt_at = now(),
      error_summary = excluded.error_summary
  `);
}

export async function listUnresolvedProjectionDebt(
  db: Database,
  limit: number,
): Promise<ProjectionDebtRow[]> {
  const result = await db.execute<{
    id: number | string;
    kind: string;
    platformAccountId: number | string;
    conversationId: number | string;
    errorSummary: string | null;
    attempts: number;
    firstSeenAt: Date | string;
    lastAttemptAt: Date | string;
    resolvedAt: Date | string | null;
  }>(sql`
    select d.id::int as "id",
           d.kind as "kind",
           d.platform_account_id::int as "platformAccountId",
           d.conversation_id::int as "conversationId",
           d.error_summary as "errorSummary",
           d.attempts as "attempts",
           d.first_seen_at as "firstSeenAt",
           d.last_attempt_at as "lastAttemptAt",
           d.resolved_at as "resolvedAt"
    from projection_debt d
    where d.resolved_at is null
    order by d.first_seen_at asc, d.id asc
    limit ${limit}
  `);

  return result.rows.map((row) => ({
    id: Number(row.id),
    kind: row.kind,
    platformAccountId: Number(row.platformAccountId),
    conversationId: Number(row.conversationId),
    errorSummary: row.errorSummary,
    attempts: Number(row.attempts),
    firstSeenAt: new Date(row.firstSeenAt),
    lastAttemptAt: new Date(row.lastAttemptAt),
    resolvedAt: row.resolvedAt ? new Date(row.resolvedAt) : null,
  }));
}

/** Marks one debt row repaired. Returns false when the row was already
 * resolved (or never existed) — sweeps racing a concurrent repair are fine. */
export async function resolveProjectionDebt(
  db: Database,
  id: number,
): Promise<boolean> {
  const result = await db.execute(sql`
    update projection_debt
    set resolved_at = now()
    where id = ${id}
      and resolved_at is null
  `);
  return (result.rowCount ?? 0) > 0;
}

/** Health surface: unresolved debt per platform account (pages with zero
 * debt are simply absent). The table only holds open incidents plus resolved
 * history, so this stays cheap. */
export async function countUnresolvedProjectionDebtByAccount(
  db: Database,
  input?: {
    platformAccountIds?: number[];
  },
): Promise<Array<{ platformAccountId: number; unresolvedCount: number }>> {
  const accountFilter = input?.platformAccountIds && input.platformAccountIds.length > 0
    ? sql` and d.platform_account_id in (${sql.join(
      input.platformAccountIds.map((id) => sql`${id}`),
      sql`, `,
    )})`
    : sql``;

  const result = await db.execute<{
    platformAccountId: number | string;
    unresolvedCount: number | string;
  }>(sql`
    select d.platform_account_id::int as "platformAccountId",
           count(*)::int as "unresolvedCount"
    from projection_debt d
    where d.resolved_at is null${accountFilter}
    group by d.platform_account_id
  `);

  return result.rows.map((row) => ({
    platformAccountId: Number(row.platformAccountId),
    unresolvedCount: Number(row.unresolvedCount),
  }));
}
