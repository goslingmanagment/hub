import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  LAKE_EXCLUDED_TABLES,
  TIERED_TABLES,
  countParquetRows,
  listTierablePartitions,
  runRestoreDrill,
  runTieringCycle,
} from "../apps/runtime/src/services/tiering/index.ts";
import {
  startIntegrationTestDatabase,
  type StartedTestDatabase,
} from "./helpers/db.ts";
import { INTEGRATION_TEST_TIMEOUT_MS } from "./helpers/timeouts.ts";

let testDb: StartedTestDatabase | null = null;
let lakeDir = "";

// The migrations create observations partitions from 2026-01; with "now"
// pinned to 2026-10 the 2026-01..03 months are past the 6-month hot window.
// Detaching is a schema-level act that survives table truncation, so the
// whole drill runs as ONE sequential story: tamper-abort first, then the
// clean export→verify→detach cycle, then the idempotent re-run.
const NOW = new Date("2026-10-01T12:00:00.000Z");

function appStub() {
  return {
    db: testDb!.db,
    config: { lakeDir } as never,
    logger: { info: () => {}, warn: () => {}, error: () => {} },
  } as never;
}

async function seedAgedObservation(kind: string, receivedAt: string, idempotencyKey: string) {
  await testDb!.pool.query(
    `insert into observations (source, producer, platform, kind, payload, payload_hash,
                               idempotency_key, observed_at, received_at, parse_version)
     values ('webhook', 'ofapi:webhook', 'onlyfans', $1, '{"n":1}'::jsonb, sha256($2::bytea),
             $2, $3, $3, 1)`,
    [kind, idempotencyKey, receivedAt],
  );
}

async function isAttached(partition: string): Promise<boolean> {
  const { rows } = await testDb!.pool.query(
    `select 1 from pg_inherits i join pg_class c on c.oid = i.inhrelid
     where c.relname = $1`,
    [partition],
  );
  return rows.length === 1;
}

beforeAll(async () => {
  testDb = await startIntegrationTestDatabase();
  lakeDir = await mkdtemp(path.join(tmpdir(), "kernel-lake-"));
}, 120_000);

afterAll(async () => {
  await testDb?.stop();
  if (lakeDir) {
    await rm(lakeDir, { recursive: true, force: true });
  }
});

describe("retention tiering (Stage 28)", () => {
  it("never tiers the Stage 29 restricted AI class (exclusion pin)", () => {
    for (const excluded of LAKE_EXCLUDED_TABLES) {
      expect(TIERED_TABLES.map((spec) => spec.table)).not.toContain(excluded);
    }
  });


  it("covers every Postgres column in the DuckDB schema (drift pin)", async (context) => {
    if (!testDb) {
      context.skip();
      return;
    }
    for (const spec of TIERED_TABLES) {
      const { rows } = await testDb.pool.query<{ column_name: string }>(
        `select column_name from information_schema.columns
         where table_schema = 'public' and table_name = $1 order by ordinal_position`,
        [spec.table],
      );
      expect(Object.keys(spec.columns).sort()).toEqual(
        rows.map((row) => row.column_name).sort(),
      );
    }
  }, INTEGRATION_TEST_TIMEOUT_MS);

  it("tamper-aborts, then exports→verifies→detaches, then re-runs as a no-op", async (context) => {
    if (!testDb) {
      context.skip();
      return;
    }

    await seedAgedObservation("messages.received", "2026-01-10T10:00:00.000Z", "tier-a");
    await seedAgedObservation("messages.sent", "2026-01-11T10:00:00.000Z", "tier-b");
    // Restricted kinds go to lake/restricted, never the general lake.
    await seedAgedObservation("desktop.guard_audit", "2026-01-12T10:00:00.000Z", "tier-c");

    const tierable = await listTierablePartitions(appStub(), NOW);
    const names = tierable.map((partition) => partition.partition);
    expect(names).toContain("observations_2026_01");
    // The current-window partitions never qualify.
    expect(names).not.toContain("observations_2026_09");

    // ── Phase 1: a poisoned manifest fails verification; nothing detaches.
    const dir = path.join(lakeDir, "capture", "observations", "2026");
    await mkdir(dir, { recursive: true });
    await writeFile(path.join(dir, "01.manifest.json"), JSON.stringify({
      table: "observations",
      partition: "observations_2026_01",
      rowCount: 2,
      restrictedRowCount: 1,
      minId: 1,
      maxId: 3,
      sha256: "0".repeat(64),
      restrictedSha256: null,
      exportedAt: NOW.toISOString(),
    }));
    await writeFile(path.join(dir, "01.parquet"), "definitely not parquet");

    const tampered = await runTieringCycle(appStub(), { now: NOW });
    const january = tampered.results.find((r) => r.partition === "observations_2026_01");
    expect(january?.status).toBe("failed");
    expect(await isAttached("observations_2026_01")).toBe(true);

    // ── Phase 2: clear the poison → the clean cycle tiers the aged months.
    await rm(path.join(dir, "01.manifest.json"));
    await rm(path.join(dir, "01.parquet"));

    const clean = await runTieringCycle(appStub(), { now: NOW });
    expect(clean.failed).toBe(0);
    const januaryClean = clean.results.find((r) => r.partition === "observations_2026_01");
    expect(januaryClean).toMatchObject({
      status: "detached",
      rowCount: 2,
      restrictedRowCount: 1,
    });

    const parquet = path.join(dir, "01.parquet");
    expect(await countParquetRows(parquet)).toBe(2);
    const restricted = path.join(lakeDir, "restricted", "observations", "2026", "01.parquet");
    expect(await countParquetRows(restricted)).toBe(1);

    const manifest = JSON.parse(await readFile(path.join(dir, "01.manifest.json"), "utf8"));
    expect(manifest).toMatchObject({ rowCount: 2, restrictedRowCount: 1 });
    expect(manifest.sha256).toMatch(/^[0-9a-f]{64}$/);

    // Out of the hot table, parked whole — nothing dropped.
    expect(await isAttached("observations_2026_01")).toBe(false);
    const { rows: parked } = await testDb.pool.query(
      `select count(*)::int as n from tiered_pending_drop.observations_2026_01`,
    );
    expect(parked[0]).toEqual({ n: 3 });

    // ── Phase 3: the re-run finds nothing tierable (already detached).
    const rerun = await runTieringCycle(appStub(), { now: NOW });
    expect(rerun.results.find((r) => r.partition === "observations_2026_01")).toBeUndefined();
    expect(rerun.failed).toBe(0);

    // ── Phase 4: the restore drill — from Parquet ALONE (general +
    // restricted), rebuild the partition, match manifest AND the parked
    // pre-detach rows, and re-attach it to the hot table.
    const drill = await runRestoreDrill(appStub(), {
      table: "observations",
      year: "2026",
      month: "01",
    });
    expect(drill).toMatchObject({
      restoredRows: 3,
      manifestRows: 3,
      parkedRows: 3,
      countsMatch: true,
      attached: true,
    });

    const { rows: restoredHot } = await testDb.pool.query(
      `select count(*)::int as n, count(*) filter (where kind = 'desktop.guard_audit')::int as restricted
       from observations where received_at >= '2026-01-01' and received_at < '2026-02-01'`,
    );
    expect(restoredHot[0]).toEqual({ n: 3, restricted: 1 });
  }, INTEGRATION_TEST_TIMEOUT_MS);
});
