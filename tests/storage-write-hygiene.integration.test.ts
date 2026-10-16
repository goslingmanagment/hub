import { sql } from "../packages/db/node_modules/drizzle-orm/index.js";
import { describe, expect, it } from "vitest";

import {
  type Database,
  listActiveInstances,
  recordStorageRelationCensus,
  upsertInstanceHeartbeat,
} from "@agency_hub_core/db";
import type { RunningSnapshot } from "@agency_hub_core/shared";

import { startIntegrationTestDatabase } from "./helpers/db.ts";

// Migration 0284 and the heartbeat writer (storage audit 2026-10-16).

const DROPPED = [
  "page_fans_platform_account_idx",
  "revenue_daily_account_date_idx",
  "message_media_offers_page_message_idx",
  "ai_acceptance_events_generation_idx",
  "ofapi_credit_ledger_occurred_at_idx",
  "page_fan_external_notes_page_fan_provider_idx",
  "sync_raw_payloads_retain_idx",
  "ofapi_commands_payload_redaction_idx",
  "runtime_instances_last_seen_idx",
] as const;

// The index that answers each dropped prefix index's lookups: its leading
// columns are the dropped index's columns, in order, under the same predicate.
const COVERED_BY = {
  page_fans_platform_account_idx: ["page_fans_platform_account_alias_idx", ["platform_account_id"]],
  revenue_daily_account_date_idx: [
    "revenue_daily_account_date_type_state_uniq", ["platform_account_id", "business_date"],
  ],
  message_media_offers_page_message_idx: ["message_media_offers_pkey", ["page_id", "message_ref"]],
  ai_acceptance_events_generation_idx: [
    "ai_acceptance_events_generation_ref_lifecycle_occurred_at_key", ["generation_ref"],
  ],
  ofapi_credit_ledger_occurred_at_idx: ["ofapi_credit_ledger_occurred_at_id_idx", ["occurred_at"]],
  page_fan_external_notes_page_fan_provider_idx: [
    "page_fan_external_notes_page_fan_provider_active_idx", ["platform_account_id", "fan_id", "provider"],
  ],
} as const;

const snapshotOf = (marker: string): RunningSnapshot => ({
  schemaVersion: 2,
  values: Object.fromEntries(Array.from({ length: 150 }, (_, index) => [
    `configKey${index}`,
    { value: `${marker}-${"x".repeat(40)}-${index}`, source: "default" },
  ])) as unknown as RunningSnapshot["values"],
  skippedOverrides: [],
});

describe("storage write hygiene", () => {
  it("drops the redundant indexes, keeps their covering ones, and leaves HOT room on the fan tables", async () => {
    const testDb = await startIntegrationTestDatabase();
    if (!testDb) {
      return;
    }
    try {
      const present = await testDb.pool.query<{ indexname: string }>(
        `select indexname from pg_indexes where schemaname = 'public' and indexname = any($1::text[])`,
        [DROPPED],
      );
      expect(present.rows).toEqual([]);

      for (const [, [covering, leading]] of Object.entries(COVERED_BY)) {
        const result = await testDb.pool.query<{ columns: string[]; predicate: string | null }>(
          `select array(
                    select a.attname::text
                    from unnest(i.indkey::int2[]) with ordinality as k(attnum, position)
                    join pg_attribute a on a.attrelid = i.indrelid and a.attnum = k.attnum
                    order by k.position
                  ) as columns,
                  pg_get_expr(i.indpred, i.indrelid) as predicate
           from pg_index i
           where i.indexrelid = $1::regclass`,
          [covering],
        );
        const row = result.rows[0]!;
        expect(row.predicate).toBeNull();
        expect(row.columns.slice(0, leading.length)).toEqual([...leading]);
      }

      const options = await testDb.pool.query<{ relname: string; reloptions: string[] | null }>(
        `select relname, reloptions from pg_class
         where relname in ('fans', 'page_fans') and relkind = 'r' order by relname`,
      );
      for (const row of options.rows) {
        expect(row.reloptions).toContain("fillfactor=90");
      }
    } finally {
      await testDb.stop();
    }
  });

  it("heartbeats are HOT updates, and an unchanged config snapshot is kept, a changed one replaced", async () => {
    const testDb = await startIntegrationTestDatabase();
    if (!testDb) {
      return;
    }
    try {
      const startedAt = new Date("2026-10-16T00:00:00.000Z");
      const beat = (db: Database, marker: string) => upsertInstanceHeartbeat(db, {
        role: "worker",
        instanceId: "hygiene-instance",
        startedAt,
        imageTag: "test",
        running: snapshotOf(marker),
      });

      const counters = await testDb.db.transaction(async (tx) => {
        const db = tx as unknown as Database;
        await beat(db, "boot");
        await beat(db, "boot");
        await beat(db, "boot");
        // pg_stat_xact_*: this transaction's own counts, no stats flush needed.
        const stats = await tx.execute<{ n_tup_upd: string; n_tup_hot_upd: string }>(sql`
          select n_tup_upd::text, n_tup_hot_upd::text
          from pg_stat_xact_user_tables where relname = 'runtime_instances'
        `);
        return stats.rows[0]!;
      });
      expect(Number(counters.n_tup_upd)).toBe(2);
      expect(Number(counters.n_tup_hot_upd)).toBe(2);

      const [first] = await listActiveInstances(testDb.db);
      expect(first?.running).toEqual(snapshotOf("boot"));

      await beat(testDb.db, "reloaded");
      const [second] = await listActiveInstances(testDb.db);
      expect(second?.running).toEqual(snapshotOf("reloaded"));
      expect(second!.lastSeenAt.getTime()).toBeGreaterThanOrEqual(first!.lastSeenAt.getTime());
    } finally {
      await testDb.stop();
    }
  });

  it("records one storage census per UTC day, partitions rolled into their root", async () => {
    const testDb = await startIntegrationTestDatabase();
    if (!testDb) {
      return;
    }
    try {
      const at = new Date("2026-10-16T03:15:00.000Z");
      const written = await recordStorageRelationCensus(testDb.db, at);
      expect(written).toBeGreaterThan(100);
      // Same day, later hour: already recorded, nothing written.
      expect(await recordStorageRelationCensus(testDb.db, new Date("2026-10-16T22:15:00.000Z"))).toBeNull();
      // The next day gets its own rows.
      expect(await recordStorageRelationCensus(testDb.db, new Date("2026-10-17T00:15:00.000Z"))).toBe(written);

      const rows = await testDb.pool.query<{
        relation: string; partitions: number; heap: string; toast: string; idx: string; total: string;
      }>(
        `select relation, partitions, heap_bytes::text as heap, toast_bytes::text as toast,
                index_bytes::text as idx, total_bytes::text as total
         from storage_relation_daily where sampled_on = '2026-10-16'`,
      );
      const byName = new Map(rows.rows.map((row) => [row.relation, row]));
      // Partitioned tables are one row each; their partitions never appear alone.
      expect(byName.get("observations")?.partitions).toBeGreaterThan(0);
      expect(byName.get("domain_events")?.partitions).toBeGreaterThan(0);
      expect([...byName.keys()].some((name) => /^observations_\d{4}_\d{2}$/.test(name))).toBe(false);
      expect(byName.get("sync_raw_payloads")?.partitions).toBe(0);
      expect(byName.has("storage_relation_daily")).toBe(true);
      for (const row of rows.rows) {
        expect(BigInt(row.heap) + BigInt(row.toast) + BigInt(row.idx)).toBe(BigInt(row.total));
      }
    } finally {
      await testDb.stop();
    }
  });
});
