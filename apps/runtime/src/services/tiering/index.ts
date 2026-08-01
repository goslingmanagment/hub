import { createHash } from "node:crypto";
import { createWriteStream } from "node:fs";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import type { PgBoss } from "pg-boss";

import type { AppContext } from "../../bootstrap.ts";
import { loadEffectiveConfig } from "../effective-config.ts";
import { ensureQueueCreated, type QueueCreationClient } from "../sync-queue.ts";

// Kernel Stage 28: retention tiering. Aged monthly partitions of the two
// ledgers export to Parquet in the on-box lake (Q3 declined → same volume),
// are verified against their manifest AND a fresh Postgres count, and only
// then DETACH into the tiered_pending_drop schema. DROP is a separate,
// owner-gated act after the restore drill passes — nothing here deletes.
//
// EXECUTION DECISIONS (recorded):
// - The hot window is a deploy-time CONSTANT (target §3.4), not a config knob.
// - Export rides NDJSON → DuckDB COPY TO PARQUET with an EXPLICIT column
//   schema per table. postgres_scanner was rejected: extension install needs
//   network at run time; json+parquet are bundled in @duckdb/node-api and
//   work offline in prod and in Testcontainers suites alike.
// - Restricted observation kinds are not dropped: they export to
//   lake/restricted/… under the same manifest/verify discipline, outside the
//   analytics search path (stage-11 §2; Stage 29 wires access scoping).
export const TIERING_HOT_WINDOW_MONTHS = 6;

export const RESTRICTED_OBSERVATION_KINDS = new Set(["desktop.guard_audit"]);

// Stage 29: the restricted AI class NEVER exports to the lake — excluded by
// construction (only TIERED_TABLES tier) and pinned by test so a future
// "tier everything" sweep cannot pick these up silently.
export const LAKE_EXCLUDED_TABLES = ["ai_generation_content", "ai_acceptance_events"] as const;

interface TieredTableSpec {
  table: "observations" | "domain_events";
  plane: string;
  /** DuckDB column schema — MUST cover every Postgres column (pinned by test). */
  columns: Record<string, string>;
  /** The column restricted-kind filtering applies to (observations only). */
  kindColumn?: string;
}

export const TIERED_TABLES: TieredTableSpec[] = [
  {
    table: "observations",
    plane: "capture",
    kindColumn: "kind",
    columns: {
      id: "BIGINT",
      source: "VARCHAR",
      producer: "VARCHAR",
      platform: "VARCHAR",
      account_id: "BIGINT",
      native_account_ref: "VARCHAR",
      kind: "VARCHAR",
      payload: "JSON",
      payload_hash: "VARCHAR",
      idempotency_key: "VARCHAR",
      observed_at: "TIMESTAMPTZ",
      received_at: "TIMESTAMPTZ",
      actor_principal_id: "BIGINT",
      parse_version: "INTEGER",
    },
  },
  {
    table: "domain_events",
    plane: "ledger",
    columns: {
      id: "BIGINT",
      account_id: "BIGINT",
      account_seq: "BIGINT",
      type: "VARCHAR",
      occurred_at: "TIMESTAMPTZ",
      fan_identity_ref: "VARCHAR",
      conversation_ref: "VARCHAR",
      message_ref: "VARCHAR",
      transaction_ref: "VARCHAR",
      post_ref: "VARCHAR",
      data: "JSON",
      schema_version: "INTEGER",
      observation_id: "BIGINT",
      dedup_key: "VARCHAR",
      created_at: "TIMESTAMPTZ",
    },
  },
];

export interface TierablePartition {
  table: TieredTableSpec["table"];
  partition: string;
  /** Exclusive upper bound of the partition's range. */
  toBound: Date;
  year: string;
  month: string;
}

export interface TieringManifest {
  table: string;
  partition: string;
  rowCount: number;
  restrictedRowCount: number;
  minId: number | null;
  maxId: number | null;
  sha256: string;
  restrictedSha256: string | null;
  exportedAt: string;
  /** Stage 28 erasure rewrites append themselves here (filter-out + re-checksum). */
  erasures?: Array<{ scopeRef: string; removedRows: number; at: string }>;
}

const PARTITION_NAME = /^(observations|domain_events)_(\d{4})_(\d{2})$/;

/** Monthly partitions whose entire range is older than the hot window.
 * The pre-2024 catch-alls and the current-year tail never match. */
export async function listTierablePartitions(
  app: Pick<AppContext, "db">,
  now = new Date(),
): Promise<TierablePartition[]> {
  const horizon = new Date(Date.UTC(
    now.getUTCFullYear(),
    now.getUTCMonth() - TIERING_HOT_WINDOW_MONTHS,
    1,
  ));
  const rows = await rawQuery<{ parent: string; child: string; bound: string }>(app, `
    select p.relname as parent, c.relname as child,
           pg_get_expr(c.relpartbound, c.oid) as bound
    from pg_inherits i
    join pg_class c on c.oid = i.inhrelid
    join pg_class p on p.oid = i.inhparent
    join pg_namespace n on n.oid = c.relnamespace
    where p.relname in ('observations', 'domain_events')
      and n.nspname = 'public'
    order by c.relname
  `);

  const tierable: TierablePartition[] = [];
  for (const row of rows) {
    const nameMatch = PARTITION_NAME.exec(row.child);
    if (!nameMatch) {
      continue; // catch-all partitions (pre_2024 / MINVALUE tails) stay hot
    }
    const boundMatch = /TO \('([^']+)'\)/.exec(row.bound ?? "");
    if (!boundMatch) {
      continue;
    }
    const toBound = new Date(boundMatch[1]!);
    if (Number.isNaN(toBound.getTime()) || toBound.getTime() > horizon.getTime()) {
      continue;
    }
    tierable.push({
      table: row.parent as TierablePartition["table"],
      partition: row.child,
      toBound,
      year: nameMatch[2]!,
      month: nameMatch[3]!,
    });
  }
  return tierable;
}

async function rawQuery<T extends Record<string, unknown>>(app: Pick<AppContext, "db">, text: string): Promise<T[]> {
  const { sql } = await import("drizzle-orm");
  const result = await app.db.execute<T>(sql.raw(text));
  return result.rows as T[];
}

function lakePaths(lakeDir: string, spec: TieredTableSpec, partition: TierablePartition) {
  const base = path.join(lakeDir, spec.plane, spec.table, partition.year);
  return {
    dir: base,
    parquet: path.join(base, `${partition.month}.parquet`),
    manifest: path.join(base, `${partition.month}.manifest.json`),
    restrictedDir: path.join(lakeDir, "restricted", spec.table, partition.year),
    restrictedParquet: path.join(
      lakeDir, "restricted", spec.table, partition.year, `${partition.month}.parquet`,
    ),
  };
}

async function sha256File(filePath: string): Promise<string> {
  const bytes = await readFile(filePath);
  return createHash("sha256").update(bytes).digest("hex");
}

async function dumpPartitionNdjson(
  app: Pick<AppContext, "db">,
  spec: TieredTableSpec,
  partition: string,
  target: string,
  restrictedTarget: string | null,
): Promise<{ rows: number; restrictedRows: number; minId: number | null; maxId: number | null }> {
  const stream = createWriteStream(target, { encoding: "utf8" });
  const restrictedStream = restrictedTarget
    ? createWriteStream(restrictedTarget, { encoding: "utf8" })
    : null;
  let rows = 0;
  let restrictedRows = 0;
  let minId: number | null = null;
  let maxId: number | null = null;

  const batchSize = 5000;
  let afterId = 0;
  for (;;) {
    const batch = await rawQuery<{ id: string; doc: string }>(app, `
      select t.id::text as id, row_to_json(t)::text as doc
      from "${partition}" t
      where t.id > ${afterId}
      order by t.id
      limit ${batchSize}
    `);
    if (batch.length === 0) {
      break;
    }
    for (const row of batch) {
      const id = Number(row.id);
      minId = minId === null ? id : Math.min(minId, id);
      maxId = maxId === null ? id : Math.max(maxId, id);
      const isRestricted = restrictedStream !== null
        && spec.kindColumn !== undefined
        && RESTRICTED_OBSERVATION_KINDS.has(
          (JSON.parse(row.doc) as Record<string, unknown>)[spec.kindColumn] as string,
        );
      if (isRestricted) {
        restrictedStream!.write(row.doc + "\n");
        restrictedRows += 1;
      } else {
        stream.write(row.doc + "\n");
        rows += 1;
      }
    }
    afterId = Number(batch[batch.length - 1]!.id);
  }

  await new Promise<void>((resolve, reject) => {
    stream.end((error?: Error | null) => (error ? reject(error) : resolve()));
  });
  if (restrictedStream) {
    await new Promise<void>((resolve, reject) => {
      restrictedStream.end((error?: Error | null) => (error ? reject(error) : resolve()));
    });
  }
  return { rows, restrictedRows, minId, maxId };
}

function duckdbColumnsLiteral(columns: Record<string, string>): string {
  return `{${Object.entries(columns).map(([name, type]) => `${name}: '${type}'`).join(", ")}}`;
}

export async function ndjsonToParquet(
  ndjsonPath: string,
  parquetPath: string,
  columns: Record<string, string>,
): Promise<void> {
  const { DuckDBInstance } = await import("@duckdb/node-api");
  const instance = await DuckDBInstance.create(":memory:");
  const connection = await instance.connect();
  try {
    await connection.run(
      `COPY (SELECT * FROM read_json('${ndjsonPath.replaceAll("'", "''")}', format='newline_delimited', columns=${duckdbColumnsLiteral(columns)})) `
      + `TO '${parquetPath.replaceAll("'", "''")}' (FORMAT parquet)`,
    );
  } finally {
    connection.closeSync();
  }
}

export async function readParquetIds(parquetPath: string): Promise<number[]> {
  const { DuckDBInstance } = await import("@duckdb/node-api");
  const instance = await DuckDBInstance.create(":memory:");
  const connection = await instance.connect();
  try {
    const reader = await connection.run(
      `SELECT id::bigint AS id FROM read_parquet('${parquetPath.replaceAll("'", "''")}') ORDER BY id`,
    );
    const rows = await reader.getRowObjects();
    return rows.map((row) => Number(row.id));
  } finally {
    connection.closeSync();
  }
}

export async function countParquetRows(parquetPath: string): Promise<number> {
  const { DuckDBInstance } = await import("@duckdb/node-api");
  const instance = await DuckDBInstance.create(":memory:");
  const connection = await instance.connect();
  try {
    const reader = await connection.run(
      `SELECT count(*)::bigint AS n FROM read_parquet('${parquetPath.replaceAll("'", "''")}')`,
    );
    const rows = await reader.getRowObjects();
    return Number(rows[0]?.n ?? 0);
  } finally {
    connection.closeSync();
  }
}

export interface TieringPartitionResult {
  table: string;
  partition: string;
  status: "exported" | "verified" | "detached" | "skipped_manifest" | "failed";
  rowCount?: number;
  restrictedRowCount?: number;
  error?: string;
}

/**
 * Export → verify → detach for one partition. Every failure aborts THAT
 * partition loudly (incident via the caller) and leaves it hot; the manifest
 * short-circuits an already-verified export (idempotent re-runs).
 */
export async function tierPartition(
  app: Pick<AppContext, "db" | "config" | "logger">,
  partition: TierablePartition,
  options?: { dryRun?: boolean },
): Promise<TieringPartitionResult> {
  const spec = TIERED_TABLES.find((candidate) => candidate.table === partition.table)!;
  const lakeDir = app.config.lakeDir;
  const paths = lakePaths(lakeDir, spec, partition);

  const pgCount = await rawQuery<{ n: string }>(app, `select count(*)::text as n from "${partition.partition}"`);
  const hotRows = Number(pgCount[0]?.n ?? 0);

  if (options?.dryRun) {
    return { table: partition.table, partition: partition.partition, status: "skipped_manifest", rowCount: hotRows };
  }

  await mkdir(paths.dir, { recursive: true });

  // Idempotency: an existing manifest that still verifies means the export
  // is done; only the detach step may remain.
  let manifest: TieringManifest | null;
  try {
    manifest = JSON.parse(await readFile(paths.manifest, "utf8")) as TieringManifest;
  } catch {
    manifest = null;
  }

  if (!manifest) {
    const scratch = path.join(tmpdir(), `tiering-${partition.partition}-${process.pid}`);
    await mkdir(scratch, { recursive: true });
    const ndjson = path.join(scratch, "rows.ndjson");
    const restrictedNdjson = spec.kindColumn ? path.join(scratch, "restricted.ndjson") : null;
    try {
      const dumped = await dumpPartitionNdjson(app, spec, partition.partition, ndjson, restrictedNdjson);
      const tmpParquet = `${paths.parquet}.tmp`;
      await ndjsonToParquet(ndjson, tmpParquet, spec.columns);
      let restrictedSha: string | null = null;
      if (restrictedNdjson && dumped.restrictedRows > 0) {
        await mkdir(paths.restrictedDir, { recursive: true });
        const tmpRestricted = `${paths.restrictedParquet}.tmp`;
        await ndjsonToParquet(restrictedNdjson, tmpRestricted, spec.columns);
        await rename(tmpRestricted, paths.restrictedParquet);
        restrictedSha = await sha256File(paths.restrictedParquet);
      }
      await rename(tmpParquet, paths.parquet);
      manifest = {
        table: partition.table,
        partition: partition.partition,
        rowCount: dumped.rows,
        restrictedRowCount: dumped.restrictedRows,
        minId: dumped.minId,
        maxId: dumped.maxId,
        sha256: await sha256File(paths.parquet),
        restrictedSha256: restrictedSha,
        exportedAt: new Date().toISOString(),
      };
      await writeFile(paths.manifest, JSON.stringify(manifest, null, 2) + "\n");
    } finally {
      await rm(scratch, { recursive: true, force: true });
    }
  }

  // VERIFY — in this absolute order, before any detach: parquet re-read,
  // checksum recompute, and a FRESH Postgres count.
  const parquetRows = await countParquetRows(paths.parquet);
  const restrictedRows = manifest.restrictedRowCount > 0
    ? await countParquetRows(paths.restrictedParquet)
    : 0;
  const checksum = await sha256File(paths.parquet);
  const freshCount = await rawQuery<{ n: string }>(app, `select count(*)::text as n from "${partition.partition}"`);
  const freshRows = Number(freshCount[0]?.n ?? 0);

  if (
    parquetRows !== manifest.rowCount
    || restrictedRows !== manifest.restrictedRowCount
    || checksum !== manifest.sha256
    || parquetRows + restrictedRows !== freshRows
  ) {
    return {
      table: partition.table,
      partition: partition.partition,
      status: "failed",
      error: `verification mismatch: parquet=${parquetRows}+${restrictedRows} manifest=${manifest.rowCount}+${manifest.restrictedRowCount} `
        + `pg=${freshRows} checksum_ok=${checksum === manifest.sha256}`,
    };
  }

  // DETACH — the partition leaves the hot table but nothing is dropped:
  // it moves whole into tiered_pending_drop (DROP is owner-gated, after the
  // global restore drill).
  await rawQuery(app, `create schema if not exists tiered_pending_drop`);
  await rawQuery(app, `alter table "${partition.table}" detach partition "${partition.partition}"`);
  await rawQuery(app, `alter table "${partition.partition}" set schema tiered_pending_drop`);

  return {
    table: partition.table,
    partition: partition.partition,
    status: "detached",
    rowCount: manifest.rowCount,
    restrictedRowCount: manifest.restrictedRowCount,
  };
}

export interface TieringCycleResult {
  tierable: number;
  detached: number;
  failed: number;
  results: TieringPartitionResult[];
}

export async function runTieringCycle(
  app: Pick<AppContext, "db" | "config" | "logger">,
  options?: { dryRun?: boolean; now?: Date },
): Promise<TieringCycleResult> {
  const partitions = await listTierablePartitions(app, options?.now ?? new Date());
  const results: TieringPartitionResult[] = [];
  for (const partition of partitions) {
    try {
      results.push(await tierPartition(app, partition, options));
    } catch (error) {
      results.push({
        table: partition.table,
        partition: partition.partition,
        status: "failed",
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
  const failed = results.filter((result) => result.status === "failed");
  for (const failure of failed) {
    app.logger.error(
      { partition: failure.partition, error: failure.error },
      "Tiering failed; partition stays hot",
    );
  }
  return {
    tierable: partitions.length,
    detached: results.filter((result) => result.status === "detached").length,
    failed: failed.length,
    results,
  };
}

export interface RestoreDrillResult {
  table: string;
  partition: string;
  restoredRows: number;
  manifestRows: number;
  parkedRows: number;
  attached: boolean;
  countsMatch: boolean;
}

/**
 * Kernel Stage 28 Task 2 — the restore drill that gates any DROP: rebuild
 * the partition FROM PARQUET ALONE (general + restricted files), re-attach
 * it to the hot table, and prove counts identical to the manifest AND to
 * the parked pre-detach table. The parked original in tiered_pending_drop
 * is untouched — the drill proves the lake alone is sufficient.
 */
export async function runRestoreDrill(
  app: Pick<AppContext, "db" | "config" | "logger">,
  input: { table: TieredTableSpec["table"]; year: string; month: string },
): Promise<RestoreDrillResult> {
  const spec = TIERED_TABLES.find((candidate) => candidate.table === input.table)!;
  const partition = `${input.table}_${input.year}_${input.month}`;
  const paths = lakePaths(app.config.lakeDir, spec, {
    table: input.table,
    partition,
    toBound: new Date(0),
    year: input.year,
    month: input.month,
  });

  const manifest = JSON.parse(await readFile(paths.manifest, "utf8")) as TieringManifest;
  const manifestRows = manifest.rowCount + manifest.restrictedRowCount;

  // Parquet → NDJSON (DuckDB, offline), general + restricted merged back.
  const scratch = path.join(tmpdir(), `restore-${partition}-${process.pid}`);
  await mkdir(scratch, { recursive: true });
  const ndjson = path.join(scratch, "rows.ndjson");
  const restoreTable = `restore_${partition}`;
  try {
    const { DuckDBInstance } = await import("@duckdb/node-api");
    const instance = await DuckDBInstance.create(":memory:");
    const connection = await instance.connect();
    try {
      const sources = [`read_parquet('${paths.parquet.replaceAll("'", "''")}')`];
      if (manifest.restrictedRowCount > 0) {
        sources.push(`read_parquet('${paths.restrictedParquet.replaceAll("'", "''")}')`);
      }
      await connection.run(
        `COPY (${sources.map((source) => `SELECT * FROM ${source}`).join(" UNION ALL ")}) `
        + `TO '${ndjson.replaceAll("'", "''")}' (FORMAT json)`,
      );
    } finally {
      connection.closeSync();
    }

    // Rebuild a staging table shaped like the parent and repopulate it from
    // the NDJSON rows via jsonb_populate_record (types cast back: ISO
    // timestamps, \x hex bytea, nested payload JSON).
    await rawQuery(app, `drop table if exists "${restoreTable}"`);
    // INCLUDING ALL: ATTACH PARTITION requires the child to already carry
    // the parent's CHECK constraints (defaults alone fail the attach).
    await rawQuery(app, `create table "${restoreTable}" (like "${input.table}" including all)`);
    const content = await readFile(ndjson, "utf8");
    const lines = content.split("\n").filter((line) => line.trim() !== "");
    const batchSize = 1000;
    for (let offset = 0; offset < lines.length; offset += batchSize) {
      const batch = lines.slice(offset, offset + batchSize);
      const arrayLiteral = `[${batch.join(",")}]`;
      const { sql } = await import("drizzle-orm");
      await app.db.execute(sql`
        insert into ${sql.raw(`"${restoreTable}"`)}
        overriding system value
        select * from jsonb_populate_recordset(null::${sql.raw(`"${input.table}"`)}, ${arrayLiteral}::jsonb)
      `);
    }

    const restored = await rawQuery<{ n: string }>(app, `select count(*)::text as n from "${restoreTable}"`);
    const restoredRows = Number(restored[0]?.n ?? 0);

    const parked = await rawQuery<{ n: string }>(
      app,
      `select count(*)::text as n from tiered_pending_drop."${partition}"`,
    ).catch(() => [{ n: "-1" }]);
    const parkedRows = Number(parked[0]?.n ?? -1);

    const countsMatch = restoredRows === manifestRows
      && (parkedRows === -1 || parkedRows === restoredRows);

    let attached = false;
    if (countsMatch) {
      // Re-attach: the range is free (the original is detached and parked).
      const monthStart = `${input.year}-${input.month}-01`;
      await rawQuery(app, `
        alter table "${input.table}" attach partition "${restoreTable}"
        for values from ('${monthStart}') to ('${monthStart}'::date + interval '1 month')
      `);
      attached = true;
    }

    return {
      table: input.table,
      partition,
      restoredRows,
      manifestRows,
      parkedRows,
      attached,
      countsMatch,
    };
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
}

export const TIERING_QUEUE = "retention-tiering";

export async function ensureTieringQueue(
  boss: QueueCreationClient,
  createdQueues?: Set<string>,
) {
  await ensureQueueCreated(boss, TIERING_QUEUE, undefined, createdQueues);
}

/** Daily off-peak check; a no-op until the first partition ages out of the
 * hot window (~2027-01 — data starts 2026-07). */
export async function ensureTieringSchedule(boss: Pick<PgBoss, "schedule">) {
  await boss.schedule(TIERING_QUEUE, "40 4 * * *");
}

/**
 * The SCHEDULED tiering run, gated on `retentionTieringEnabled` (default false).
 *
 * The gate lives here and not inside `runTieringCycle` on purpose: the owner CLI
 * (`tiering:run`) is an explicit act and stays UNGATED, while the 04:40 UTC
 * schedule must not detach a partition behind the owner's back. Detaching a month
 * makes the agent read plane mint false capture floors and breaks an observation
 * replay with the documented 23514 failure, so the deploy ships the schedule inert
 * and the owner opens it deliberately.
 *
 * The flag is read from the EFFECTIVE config on every cycle: the boot-time
 * `app.config` never sees a dashboard flip, so a boot-time read would make the
 * switch a lie until the next restart. `ensureTieringSchedule` stays
 * unconditional — the queue and its schedule exist either way, the callback simply
 * no-ops.
 */
export function startTieringWorker(
  app: AppContext,
  boss: Pick<PgBoss, "work">,
) {
  return boss.work(TIERING_QUEUE, async () => {
    const effective = await loadEffectiveConfig(app.db, app.config);
    if (effective.retentionTieringEnabled !== true) {
      app.logger.debug(
        { queue: TIERING_QUEUE },
        "Retention tiering disabled by config; scheduled cycle skipped",
      );
      return;
    }
    const cycle = await runTieringCycle(app);
    if (cycle.tierable > 0) {
      app.logger.info(
        { tierable: cycle.tierable, detached: cycle.detached, failed: cycle.failed },
        "Retention tiering cycle complete",
      );
    }
  });
}
