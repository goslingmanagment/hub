import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { setTimeout as delay } from "node:timers/promises";
import { exportEarningsAudit } from "../scripts/fansly-events/earnings-audit-export.ts";
import { earningsAuditPsql } from "./helpers/earnings-audit-psql.ts";
import { afterAll, beforeAll, beforeEach, expect, it } from "vitest";
import { auditRow, earningsAuditFixture } from "./helpers/earnings-audit-fixture.ts";
import { resetIntegrationDatabase, startIntegrationTestDatabase, type StartedTestDatabase } from "./helpers/db.ts";

let db: StartedTestDatabase;
let psql: Awaited<ReturnType<typeof earningsAuditPsql>>;
let directory: string;
beforeAll(async () => {
  const started = await startIntegrationTestDatabase();
  if (!started) throw new Error("Docker Postgres is required");
  db = started;
  psql = await earningsAuditPsql(db);
  directory = await mkdtemp(join(tmpdir(), "hub-audit-scale-"));
}, 120_000);
afterAll(async () => {
  await psql?.close(); await db?.stop(); await rm(directory, { recursive: true, force: true });
});
beforeEach(async () => { await resetIntegrationDatabase(db.pool); });

async function retainMeasurement(
  name: string, counts: Record<string, number>, started: number, transport = "local_pg_client",
) {
  const measurement = {
    fixture: name, ...counts, elapsedMs: Math.round(performance.now() - started),
    transport, productionLatencyMeasured: false,
  };
  const output = process.env.FANSLY_AUDIT_BENCHMARK_OUTPUT;
  if (output) await writeFile(join(output, name + ".json"), JSON.stringify(measurement, null, 2) + "\n", { flag: "wx" });
}

it("exhausts 120,000 retained captures without claiming that an absent projection is correct", async () => {
  const f = await earningsAuditFixture(db);
  // Read-cost fixture only: intentionally absent events/projection must stay
  // unverified. No claim about canonicalization throughput or production speed.
  await db.pool.query(`insert into observations (
    source, producer, platform, account_id, kind, payload, payload_hash,
    idempotency_key, received_at, parse_version
  ) select 'pull', 'test:earnings-scale', 'fansly', $1, 'fan_earnings_stats',
    jsonb_build_array(jsonb_build_object('correlationAccountId', 'fan-' || (i % 1000),
      'totalGross', i, 'totalNet', i)), $2, 'scale-' || i,
    transaction_timestamp() - interval '2 days' + i * interval '1 millisecond', 7
    from generate_series(1, 120000) i`, [f.page.id, Buffer.alloc(32)]);
  const started = performance.now();
  const outputDirectory = join(directory, "corpus");
  let responseBatches = 0;
  const exported = await exportEarningsAudit({
    page: f.page.label, from: "2026-01-01T00:00:00Z", to: new Date().toISOString(), outputDirectory,
  }, () => {
    const reader = psql.reader();
    return {
      read: sql => reader.read(sql),
      async readMany(sql, count) {
        responseBatches += 1;
        // Reproduce WAN round-trip cost once per burst, not once per page.
        await delay(100);
        return reader.readMany(sql, count);
      },
      close: () => reader.close(),
    };
  });
  expect(exported).toMatchObject({ completed: true, verified: false });
  expect(responseBatches).toBe(151);
  const report = JSON.parse(await readFile(join(outputDirectory, "report.json"), "utf8"));
  expect(report).toMatchObject({
    observationCount: 120000, observations: { valid: 120000 }, projectionCount: 0,
    verified: false, projectorCaughtUp: false, outcomes: { projection_pending: 1000 },
  });
  await retainMeasurement("corpus", {
    observations: 120000, fanWindows: 1000, responseBatches, artificialRoundTripMs: 100,
  }, started, "local_docker_psql");
}, 120_000);

it("reads 1,000 real projected source receipts across batches", async () => {
  const f = await earningsAuditFixture(db);
  for (let index = 0; index < 1000; index += 1) {
    await f.capture([auditRow(100, "fan-" + index)]);
  }
  let parsed = 0;
  while (parsed < 1000) {
    const result = await f.parse();
    if (result.stamped === 0) throw new Error("Scale fixture canonicalization stopped early");
    parsed += result.stamped;
  }
  await f.project();
  const started = performance.now();
  const report = await f.report(100);
  expect(report).toMatchObject({
    verified: true, observationCount: 1000, projectionCount: 1000, outcomes: { matched: 1000 },
  });
  await retainMeasurement("projection", { observations: 1000, projectionRows: 1000 }, started);
}, 120_000);
