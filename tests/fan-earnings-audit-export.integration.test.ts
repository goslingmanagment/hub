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

type CollectOptions = {
  identityOverride?: Record<string, unknown>;
  inheritedGenericPlan?: boolean;
  failRead?: boolean;
  failCleanup?: boolean;
};

async function collect(name: string, options: CollectOptions = {}) {
  const outputDirectory = join(directory, name);
  const inheritedModes: unknown[] = [];
  const result = await exportEarningsAudit({
    page: f.page.label, from: new Date(Date.now() - 86400_000).toISOString(),
    to: new Date().toISOString(), outputDirectory,
  }, () => {
    const reader = psql.reader();
    return {
      async read(sql) {
        if (options.inheritedGenericPlan && sql.includes("BEGIN")) {
          inheritedModes.push(await reader.read(`SET plan_cache_mode = force_generic_plan;
            SELECT jsonb_build_object('mode', current_setting('plan_cache_mode'));`));
        }
        const value = await reader.read(sql);
        if (options.inheritedGenericPlan && sql.includes("ROLLBACK;")) {
          // Same psql connection: a fresh connection would not prove SET LOCAL reset.
          inheritedModes.push(await reader.read(
            "SELECT jsonb_build_object('mode', current_setting('plan_cache_mode'));",
          ));
        }
        if (options.identityOverride && sql.includes("BEGIN")) {
          if (typeof value !== "object" || value === null) throw new Error("Missing test identity");
          return { ...value, ...options.identityOverride };
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
  return { result, outputDirectory, inheritedModes };
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
    expect(lines[0].identity).toMatchObject({
      role: "read_only", readOnly: "on", isolation: "repeatable read", planCacheMode: "force_custom_plan",
    });
    expect(lines[1].scope.asOf).toBe(lines[0].identity.asOf);
    expect(lines[2].scope).toEqual(lines[1].scope);
    expect(lines[3].scope).toEqual(lines[1].scope);
    for (const name of ["snapshot.jsonl", "manifest.json", "report.json", "stderr.txt"]) {
      expect((await stat(join(outputDirectory, name))).mode & 0o777).toBe(0o600);
    }
    expect((await stat(outputDirectory)).mode & 0o777).toBe(0o700);
    await expect(collect("complete")).rejects.toThrow(/EEXIST/);
  });

  it("uses custom plans within the audit and restores an inherited generic plan after rollback", async () => {
    await seed();
    const { result, inheritedModes } = await collect("inherited-plan", { inheritedGenericPlan: true });
    expect(result).toMatchObject({ completed: true, verified: true, failure: null });
    expect(inheritedModes).toEqual([{ mode: "force_generic_plan" }, { mode: "force_generic_plan" }]);
  });

  it.each([
    ["wrong-role", { identityOverride: { role: "postgres" } }],
    ["wrong-plan", { identityOverride: { planCacheMode: "auto" } }],
    ["missing-plan", { identityOverride: { planCacheMode: undefined } }],
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
