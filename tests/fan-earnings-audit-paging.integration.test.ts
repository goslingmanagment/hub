import { readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { exportEarningsAudit } from "../scripts/fansly-events/earnings-audit-export.ts";
import { auditSqlLiteral } from "../scripts/fansly-events/earnings-audit-reader.ts";
import { auditRow, earningsAuditFixture } from "./helpers/earnings-audit-fixture.ts";
import { earningsAuditPsql } from "./helpers/earnings-audit-psql.ts";
import { resetIntegrationDatabase, startIntegrationTestDatabase, type StartedTestDatabase } from "./helpers/db.ts";

let db: StartedTestDatabase;
let f: Awaited<ReturnType<typeof earningsAuditFixture>>;
let psql: Awaited<ReturnType<typeof earningsAuditPsql>>;
const outputs: string[] = [];
beforeAll(async () => {
  const started = await startIntegrationTestDatabase();
  if (!started) throw new Error("Docker Postgres is required");
  db = started;
  psql = await earningsAuditPsql(db);
}, 120_000);
afterAll(async () => {
  await psql?.close(); await db?.stop();
  for (const output of outputs) await rm(output, { recursive: true, force: true });
});
beforeEach(async () => {
  await resetIntegrationDatabase(db.pool);
  f = await earningsAuditFixture(db);
});

async function collect() {
  const outputDirectory = join(process.env.TMPDIR ?? "/tmp", "hub-audit-pages-" + crypto.randomUUID());
  outputs.push(outputDirectory);
  const bursts: number[] = [];
  const result = await exportEarningsAudit({
    page: f.page.label, from: "2026-01-01T00:00:00Z", to: new Date().toISOString(), outputDirectory,
  }, () => {
    const reader = psql.reader();
    return {
      read: sql => reader.read(sql),
      readMany(sql, count) { bursts.push(count); return reader.readMany(sql, count); },
      close: () => reader.close(),
    };
  });
  const manifest = JSON.parse(await readFile(join(outputDirectory, "manifest.json"), "utf8"));
  const report = result.completed
    ? JSON.parse(await readFile(join(outputDirectory, "report.json"), "utf8")) : null;
  return { result, manifest, report, bursts };
}

describe("C2a batched psql pagination", () => {
  it.each([0, 100, 101, 800, 801])("exhausts exactly %i observations, preserving microsecond cursors", async count => {
    await db.pool.query(`insert into observations (
      source, producer, platform, account_id, kind, payload, payload_hash,
      idempotency_key, received_at, parse_version
    ) select 'pull', 'test:psql-pages', 'fansly', $1, 'fan_earnings_stats',
      $2::jsonb, $3, 'pages-' || i,
      transaction_timestamp() - interval '1 hour' + i * interval '1 microsecond', 7
      from generate_series(1, $4::integer) i`, [f.page.id, JSON.stringify([auditRow(100)]), Buffer.alloc(32), count]);
    const { result, manifest, report, bursts } = await collect();
    const observationPages = Math.max(1, Math.ceil(count / 100));
    expect(result).toMatchObject({ completed: true, verified: false });
    expect(manifest.records).toBe(observationPages + 3);
    expect(report.observationCount).toBe(count);
    expect(bursts.reduce((sum, size) => sum + size, 0)).toBe(observationPages + 1);
    expect(bursts.length).toBe(Math.ceil(observationPages / 8) + 1);
    expect(bursts.every(size => size >= 1 && size <= 8)).toBe(true);
  });

  it("paginates a real projection and treats shell/psql-looking cursor values as data", async () => {
    const special = "fan'\\ :audit_page `echo injected` $(echo injected)\n\\echo injected";
    for (let index = 0; index < 201; index += 1) {
      await f.capture([auditRow(100, index === 100 ? special : "fan-" + index)]);
    }
    await f.parse(); await f.project();
    const first = await collect();
    expect(first.result).toMatchObject({ completed: true, verified: true });
    expect(first.report.outcomes).toEqual({ matched: 201 });
    // Put the unusual cursor exactly on a page boundary. Its mismatch is real;
    // successful transport must retain it instead of altering or executing it.
    await db.pool.query(`update fan_earnings_stats set "window"=$1 where fan_id=(
      select s.fan_id from fan_earnings_stats s order by s.fan_id offset 99 limit 1
    )`, [special]);
    const second = await collect();
    expect(second.result).toMatchObject({ completed: true, verified: false });
    expect(second.report.projectionCount).toBe(201);
    expect(second.report.samples.some((row: { actual?: { window: string } }) => row.actual?.window === special)).toBe(true);
  });

  it("stops on a gset SQL error without echoing stale variables as success", async () => {
    const reader = psql.reader();
    try {
      const value = { text: "'\\ `echo injected` $(echo injected)\n:audit_page" };
      const sql = `select ${auditSqlLiteral(JSON.stringify(value))} as audit_page
        \\gset
        \\echo :audit_page`;
      expect(await reader.readMany(sql, 1)).toEqual([value]);
      await expect(reader.readMany(sql + `\nselect 1/0 as audit_page
        \\gset
        \\echo :audit_page`, 2)).rejects.toThrow(/ended unexpectedly/);
      expect((await reader.close()).stderr).toContain("division by zero");
    } finally {
      await reader.close();
    }
  });
});
