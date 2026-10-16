import { sql } from "drizzle-orm";

import type { Database } from "../client.ts";

// Daily per-table storage census (migration 0284). Written by the hourly disk
// check; the first check of a UTC day records the day, the rest find it there.

/** UTC calendar day of `at`, as the census keys it. */
export function storageCensusDay(at: Date): string {
  return at.toISOString().slice(0, 10);
}

/**
 * Records every table's size and write counters for `sampledAt`'s UTC day,
 * once. Returns the number of rows written, or null when the day was already
 * recorded (nothing is read beyond one primary-key probe then).
 *
 * Only catalog size functions and pg_stat counters: no table is scanned, so
 * the cost does not grow with the data. Partitions roll up into their root
 * (pg_partition_root); tables parked outside `public` (tiered_pending_drop)
 * keep a schema-qualified name so they stay visible.
 *
 * The size functions take ACCESS SHARE on each relation, so a VACUUM FULL or
 * DDL holding a table would stall them: one transaction under a 2 s
 * lock_timeout gives up instead, and the next hourly check tries again.
 */
export async function recordStorageRelationCensus(
  db: Database,
  sampledAt: Date,
): Promise<number | null> {
  const day = storageCensusDay(sampledAt);
  const existing = await db.execute<{ found: boolean }>(sql`
    select exists (select 1 from storage_relation_daily where sampled_on = ${day}::date) as found
  `);
  if (existing.rows[0]?.found) {
    return null;
  }
  return db.transaction(async (tx) => {
    await tx.execute(sql`set local lock_timeout = '2s'`);
    await tx.execute(sql`set local statement_timeout = '60s'`);
    const result = await tx.execute(sql`
      insert into storage_relation_daily (
        sampled_on, relation, partitions,
        heap_bytes, toast_bytes, index_bytes, total_bytes,
        live_tuples, dead_tuples, inserts, updates, hot_updates, deletes,
        sampled_at
      )
      select ${day}::date,
             case when rn.nspname = 'public' then root.relname else rn.nspname || '.' || root.relname end,
             count(*) filter (where c.relispartition)::int,
             coalesce(sum(pg_table_size(c.oid) - coalesce(pg_total_relation_size(nullif(c.reltoastrelid, 0)), 0)), 0)::bigint,
             coalesce(sum(coalesce(pg_total_relation_size(nullif(c.reltoastrelid, 0)), 0)), 0)::bigint,
             coalesce(sum(pg_indexes_size(c.oid)), 0)::bigint,
             coalesce(sum(pg_total_relation_size(c.oid)), 0)::bigint,
             coalesce(sum(s.n_live_tup), 0)::bigint,
             coalesce(sum(s.n_dead_tup), 0)::bigint,
             coalesce(sum(s.n_tup_ins), 0)::bigint,
             coalesce(sum(s.n_tup_upd), 0)::bigint,
             coalesce(sum(s.n_tup_hot_upd), 0)::bigint,
             coalesce(sum(s.n_tup_del), 0)::bigint,
             ${sampledAt}
      from pg_class c
      join pg_namespace n on n.oid = c.relnamespace
      join pg_class root on root.oid = coalesce(pg_partition_root(c.oid), c.oid)
      join pg_namespace rn on rn.oid = root.relnamespace
      left join pg_stat_all_tables s on s.relid = c.oid
      where c.relkind in ('r', 'p', 'm')
        and n.nspname not in ('pg_catalog', 'information_schema', 'pg_toast')
        and n.nspname not like 'pg\\_temp\\_%'
        and n.nspname not like 'pg\\_toast\\_temp\\_%'
      group by rn.nspname, root.relname
      on conflict (sampled_on, relation) do nothing
    `);
    return result.rowCount ?? 0;
  });
}
