import { sql } from "drizzle-orm";

import type { Database } from "../client.ts";

export type FanslyDmShadowReport = {
  pageId: number;
  generation: number;
  startedAt: Date;
  pageCount: number;
  status: "running" | "complete" | "incomplete";
  reason: string | null;
  diagnostics: Record<string, unknown>;
};

/** Use outside the page's business transaction. A diagnostic failure must not
 * roll back captured material, checkpoint progress or membership writes. */
export async function saveFanslyDmShadowReport(db: Database, report: FanslyDmShadowReport) {
  await db.transaction(async (tx) => {
    await tx.execute(sql`set local statement_timeout = '500ms'`);
    await tx.execute(sql`set local lock_timeout = '100ms'`);
    await tx.execute(sql`
      update fansly_dm_shadow_sweeps
      set status = 'incomplete', reason = 'superseded_sweep', updated_at = now()
      where page_id = ${report.pageId} and generation < ${report.generation}
        and status = 'running'
    `);
    await tx.execute(sql`
      insert into fansly_dm_shadow_sweeps (
        page_id, generation, started_at, page_count, status, reason,
        finished_at, diagnostics
      ) values (
        ${report.pageId}, ${report.generation}, ${report.startedAt.toISOString()}::timestamptz,
        ${report.pageCount}, ${report.status}, ${report.reason},
        case when ${report.status} = 'running' then null else now() end,
        ${JSON.stringify(report.diagnostics)}::jsonb
      )
      on conflict (page_id, generation) do update set
        page_count = excluded.page_count, status = excluded.status,
        reason = excluded.reason, diagnostics = excluded.diagnostics,
        finished_at = excluded.finished_at, updated_at = now()
      where fansly_dm_shadow_sweeps.page_count <= excluded.page_count
        and fansly_dm_shadow_sweeps.status = 'running'
    `);
  });
}

export type DmShadowMaterialReceipt = { present: boolean; discoveryToCaptureMs: number | null };

/** Exact pre-apply material check, bounded by one provider list page. */
export async function readFanslyDmShadowMaterial(
  db: Database,
  heads: ReadonlyArray<{ conversationId: number; messageId: string }>,
): Promise<Map<number, DmShadowMaterialReceipt>> {
  if (heads.length === 0) return new Map();
  if (heads.length > 100) throw new Error("DM shadow material check exceeds one list page");
  return db.transaction(async (tx) => {
    // The 5 s timeout allows this diagnostic read more time under load.
    // A timeout leaves material evidence unknown while normal pagination
    // continues. The query scope and real sweep stop conditions stay unchanged;
    // the report writer above retains its separate 500 ms timeout.
    await tx.execute(sql`set local statement_timeout = '5s'`);
    return queryFanslyDmShadowMaterial(tx, heads);
  });
}

/** Shared with the reader-state snapshot; caller owns the transaction budget. */
export async function queryFanslyDmShadowMaterial(
  db: Pick<Database, "execute">,
  heads: ReadonlyArray<{ conversationId: number; messageId: string }>,
): Promise<Map<number, DmShadowMaterialReceipt>> {
  if (heads.length === 0) return new Map();
  const values = sql.join(heads.map((head) => sql`(
    ${head.conversationId}::bigint, ${head.messageId}::text
  )`), sql`, `);
  const result = await db.execute<{
    conversation_id: string; present: boolean; lag_ms: string | null;
  }>(sql`
    select h.conversation_id, exists (
      select 1 from page_dm_messages m
      where m.conversation_id = h.conversation_id
        and m.platform_message_id = h.message_id and m.deleted_at is null
    ) as present,
    extract(epoch from d.captured_at - d.first_observed_at) * 1000 as lag_ms
    from (values ${values}) h(conversation_id, message_id)
    left join fansly_dm_head_debt d
      on d.conversation_id = h.conversation_id and d.message_id = h.message_id
  `);
  return new Map(result.rows.map((row) => [Number(row.conversation_id), {
    present: row.present,
    discoveryToCaptureMs: row.lag_ms === null ? null : Math.ceil(Number(row.lag_ms)),
  }]));
}
