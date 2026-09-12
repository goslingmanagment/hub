import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { exportEarningsAudit } from "../scripts/fansly-events/earnings-audit-export.ts";
import { earningsAuditPsql } from "./helpers/earnings-audit-psql.ts";
import { auditRow, earningsAuditFixture } from "./helpers/earnings-audit-fixture.ts";
import { resetIntegrationDatabase, startIntegrationTestDatabase, type StartedTestDatabase } from "./helpers/db.ts";

let db: StartedTestDatabase;
let f: Awaited<ReturnType<typeof earningsAuditFixture>>;
let directory: string;
let psql: Awaited<ReturnType<typeof earningsAuditPsql>>;
beforeAll(async () => {
  const started = await startIntegrationTestDatabase();
  if (!started) throw new Error("Docker Postgres is required");
  db = started;
  psql = await earningsAuditPsql(db);
  directory = await mkdtemp(join(tmpdir(), "hub-earnings-export-"));
}, 120_000);
afterAll(async () => { await psql?.close(); await db?.stop(); await rm(directory, { recursive: true, force: true }); });
beforeEach(async () => {
  await resetIntegrationDatabase(db.pool);
  f = await earningsAuditFixture(db);
});

async function collect(name: string, options: { wrongRole?: boolean; failRead?: boolean; failCleanup?: boolean } = {}) {
  const outputDirectory = join(directory, name);
  const result = await exportEarningsAudit({
    page: f.page.label, from: new Date(Date.now() - 86400_000).toISOString(),
    to: new Date().toISOString(), outputDirectory,
  }, () => {
    const reader = psql.reader();
    return {
      async read(sql) {
        const value = await reader.read(sql);
        if (options.wrongRole && sql.includes("BEGIN")) {
          if (typeof value !== "object" || value === null) throw new Error("Missing test identity");
          return { ...value, role: "postgres" };
        }
        return value;
      },
      async readMany(sql, count) {
        if (options.failRead) throw new Error("Test connection interruption");
        return reader.readMany(sql, count);
      },
      async close() {
        const cleanup = await reader.close();
        return { ...cleanup, error: options.failCleanup ? "Test cleanup failure" : cleanup.error };
      },
    };
  });
  return { result, outputDirectory };
}

async function seed() {
  await f.capture([auditRow(100)], { receivedAt: new Date(Date.now() - 3600_000) });
  await f.parse(); await f.project();
}

describe("C2a snapshot exporter against Docker Postgres", () => {
  it("retains an exact manifest hash, private files and one frozen read_only snapshot", async () => {
    await seed();
    const { result, outputDirectory } = await collect("complete");
    expect(result).toMatchObject({ completed: true, verified: true, failure: null });
    const raw = await readFile(join(outputDirectory, "snapshot.jsonl"));
    const manifest = JSON.parse(await readFile(join(outputDirectory, "manifest.json"), "utf8"));
    expect(manifest).toMatchObject({ completed: true, records: 4, sha256: createHash("sha256").update(raw).digest("hex") });
    const lines = raw.toString().trim().split("\n").map(line => JSON.parse(line));
    expect(lines[0].identity).toMatchObject({ role: "read_only", readOnly: "on", isolation: "repeatable read" });
    expect(lines[1].scope.asOf).toBe(lines[0].identity.asOf);
    expect(lines[2].scope).toEqual(lines[1].scope);
    expect(lines[3].scope).toEqual(lines[1].scope);
    for (const name of ["snapshot.jsonl", "manifest.json", "report.json", "stderr.txt"]) {
      expect((await stat(join(outputDirectory, name))).mode & 0o777).toBe(0o600);
    }
    expect((await stat(outputDirectory)).mode & 0o777).toBe(0o700);
    await expect(collect("complete")).rejects.toThrow(/EEXIST/);
  });

  it.each([
    ["wrong-role", { wrongRole: true }],
    ["interrupted", { failRead: true }],
    ["cleanup-failed", { failCleanup: true }],
  ] as const)("preserves an incomplete manifest for %s without a success report", async (name, options) => {
    await seed();
    const { result, outputDirectory } = await collect(name, options);
    expect(result.completed).toBe(false);
    expect(result.verified).toBe(false);
    const raw = await readFile(join(outputDirectory, "snapshot.jsonl"));
    const manifest = JSON.parse(await readFile(join(outputDirectory, "manifest.json"), "utf8"));
    expect(manifest.completed).toBe(false);
    expect(manifest.failure).toBeTruthy();
    expect(manifest.sha256).toBe(createHash("sha256").update(raw).digest("hex"));
    await expect(stat(join(outputDirectory, "report.json"))).rejects.toThrow(/ENOENT/);
  });
});
