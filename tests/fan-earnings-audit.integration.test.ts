import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { parseFanslyEarningsObservation } from "../apps/runtime/src/services/canonicalize/fansly-earnings.ts";
import { earningsAuditPageSchema } from "../scripts/fansly-events/earnings-audit-types.ts";
import { auditRow, earningsAuditFixture } from "./helpers/earnings-audit-fixture.ts";
import { resetIntegrationDatabase, startIntegrationTestDatabase, type StartedTestDatabase } from "./helpers/db.ts";

let db: StartedTestDatabase;
let f: Awaited<ReturnType<typeof earningsAuditFixture>>;
beforeAll(async () => {
  const started = await startIntegrationTestDatabase();
  if (!started) throw new Error("Docker Postgres is required");
  db = started;
}, 120_000);
afterAll(async () => { await db?.stop(); });
beforeEach(async () => {
  await resetIntegrationDatabase(db.pool);
  f = await earningsAuditFixture(db);
});

async function observations() {
  return f.withAudit(async (client, scope) => {
    const result = await client.query("select fansly_earnings_audit_observations($1) as result", [scope]);
    const page = earningsAuditPageSchema.parse(result.rows[0].result);
    if (page.operation !== "observations") throw new Error("Wrong test operation");
    return page.rows;
  });
}

describe("C2a bounded earnings audit readers", () => {
  it("reads all zero/negative earnings through restricted functions without granting tables", async () => {
    await f.capture([auditRow(0), auditRow(-80, "fan-b")]);
    await f.parse(); await f.project();
    expect(await f.report()).toMatchObject({
      verified: true, observationCount: 1, projectionCount: 2, outcomes: { matched: 2 },
    });
    await f.withAudit(async (client) => {
      await expect(client.query("select * from fan_earnings_stats")).rejects.toThrow(/permission denied/);
    });
    await f.withAudit(async (client) => {
      await expect(client.query("select * from capture_json_hot_bodies")).rejects.toThrow(/permission denied/);
    });
    const grants = await db.pool.query(`select has_function_privilege(
      'earnings_audit_test_reader', 'fansly_earnings_audit_payload(jsonb)', 'execute') as allowed`);
    expect(grants.rows[0].allowed).toBe(false);
  });

  it("preserves complete parser output while withholding unused and malformed nested content", async () => {
    const valid = auditRow(100);
    const payloads = [
      null, { private: "must-not-export" }, "must-not-export", false, 5, [],
      [null, ["must-not-export"], "must-not-export", true, 12],
      [{ ...valid, private: "must-not-export", type: "must-not-export" }],
      [{ ...valid, correlationAccountId: 123, totalGross: "must-not-export" }],
      [{ ...valid, year: { private: "must-not-export" } }],
      [valid, { ...valid, totalNet: ["must-not-export"] }],
      [auditRow(Number.MAX_SAFE_INTEGER), auditRow(1), auditRow(-1)],
      [{ ...valid, correlationAccountId: { private: "must-not-export" } }, valid],
      [{ ...valid, correlationAccountId: 123 }],
    ];
    for (const payload of payloads) await f.capture(payload);
    const exported = await observations();
    expect(exported).toHaveLength(payloads.length);
    expect(JSON.stringify(exported)).not.toContain("must-not-export");
    for (const [index, row] of exported.entries()) {
      for (const kind of ["fan_earnings_stats", "fan_earnings_monthly"]) {
        const envelope = {
          id: Number(row.id), source: "pull", producer: "test", platform: "fansly",
          accountId: f.page.id, kind, observedAt: null, receivedAt: new Date(row.receivedAt),
        };
        expect(row.status).toBe("available");
        expect(parseFanslyEarningsObservation({ ...envelope, payload: row.payload }))
          .toEqual(parseFanslyEarningsObservation({ ...envelope, payload: payloads[index] }));
      }
    }
  });

  it("distinguishes pointer-only JSON null, empty, unavailable and disagreeing copies", async () => {
    for (const payload of [null, [], [auditRow(100)]]) {
      const ref = await f.catalog(payload);
      await f.capture(payload, { payloadRef: ref, omitInlinePayload: true });
    }
    const missing = await f.catalog([auditRow(200)]);
    await f.capture([auditRow(200)], { payloadRef: missing, omitInlinePayload: true });
    await db.pool.query("delete from capture_json_hot_bodies where bucket_month=$1 and object_id=$2", [
      missing.bucketMonth, missing.objectId,
    ]);
    const other = await f.catalog([auditRow(300)]);
    await f.capture([auditRow(301)], { payloadRef: other });
    const rows = await observations();
    expect(rows.map(row => row.status)).toEqual([
      "available", "available", "available", "body_missing", "copy_disagreement",
    ]);
    expect(rows[0]).toMatchObject({ payload: null });
    expect(rows[1]).toMatchObject({ payload: [] });
  });

  it("refuses cross-account and restricted CAS pointers before returning any body", async () => {
    for (const options of [{ accountId: f.page.id + 1 }, { restricted: true }]) {
      const ref = await f.catalog([{ ...auditRow(100), correlationAccountId: "must-not-export" }], options);
      await f.capture([], { payloadRef: ref, omitInlinePayload: true });
    }
    const rows = await observations();
    expect(rows.map(row => row.status)).toEqual(["scope_mismatch", "scope_mismatch"]);
    expect(JSON.stringify(rows)).not.toContain("must-not-export");
  });

  it("refuses compressed oversized bodies and reports shape limits without emitting empty success", async () => {
    const oversized = [{ ...auditRow(100), private: "x".repeat(1_000_000) }];
    await f.capture(oversized);
    const ref = await f.catalog(oversized);
    await f.capture(oversized, { payloadRef: ref, omitInlinePayload: true });
    await f.capture(Array(513).fill(null));
    await f.capture([auditRow(100, "x".repeat(257))]);
    const compression = await db.pool.query(`select pg_column_compression(o.payload) as compression
      from observations o where o.payload is not null order by o.id limit 1`);
    expect(compression.rows[0].compression).not.toBeNull();
    const rows = await observations();
    expect(rows.map(row => row.status)).toEqual([
      "compressed_body", "body_limit", "compressed_body", "shape_limit",
    ]);
    expect(rows.every(row => row.payload === null)).toBe(true);
    const shape = await db.pool.query("select fansly_earnings_audit_payload($1) as payload", [JSON.stringify(Array(513).fill(null))]);
    expect(shape.rows[0].payload).toBeNull();
  });

  it("freezes pagination across concurrent captures and projector writes", async () => {
    await f.capture([auditRow(100)]);
    await f.parse(); await f.project();
    await f.withAudit(async (client, scope) => {
      await f.capture([auditRow(200)]);
      await f.parse(); await f.project();
      const before = await client.query("select fansly_earnings_audit_observations($1) result", [scope]);
      const projected = await client.query("select fansly_earnings_audit_projection($1) result", [scope]);
      expect(before.rows[0].result.rows).toHaveLength(1);
      expect(projected.rows[0].result.rows[0].grossMills).toBe("100");
    });
    expect(await f.report()).toMatchObject({ verified: true, observationCount: 2 });
  });

  it("rejects wrong isolation, foreign snapshots, bad ranges and invalid cursors", async () => {
    await expect(db.pool.query(`select fansly_earnings_audit_scope(
      $1, now() - interval '1 day', now())`, [f.page.label]))
      .rejects.toThrow(/requires_repeatable_read_only/);
    await f.withAudit(async (client, scope) => {
      await expect(client.query("select fansly_earnings_audit_observations($1)", [
        { ...scope, snapshot: "0:0:" },
      ])).rejects.toThrow(/snapshot_mismatch/);
    });
    await f.withAudit(async (client) => {
      await expect(client.query(`select fansly_earnings_audit_scope(
        $1, now() - interval '367 days', now())`, [f.page.label]))
        .rejects.toThrow(/invalid_earnings_audit_window/);
    });
    await f.withAudit(async (client, scope) => {
      await expect(client.query("select fansly_earnings_audit_observations($1, null, 1, 101)", [scope]))
        .rejects.toThrow(/invalid_earnings_audit_cursor/);
    });
  });

  it("reports detached retained partitions instead of certifying an incomplete corpus", async () => {
    await f.capture([auditRow(100)], { receivedAt: new Date("2026-01-15T00:00:00Z") });
    await f.parse(); await f.project();
    await db.pool.query("alter table observations detach partition observations_2026_01");
    try {
      const report = await f.report();
      expect(report.scope.partitions).toContainEqual({
        name: "observations_2026_01", bound: null, attached: false, detachedRows: "1",
      });
      expect(report.verified).toBe(false);
    } finally {
      await db.pool.query(`alter table observations attach partition observations_2026_01
        for values from ('2026-01-01') to ('2026-02-01')`);
    }
  });
});
