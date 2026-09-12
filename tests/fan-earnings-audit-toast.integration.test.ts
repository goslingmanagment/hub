import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
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

const padded = (amount: number, size = 5000) => [{ ...auditRow(amount), private: "x".repeat(size) }];

describe("C2a PostgreSQL TOAST bounds", () => {
  it("reads compressed inline, CAS and matching dual copies through the real parser and projector", async () => {
    const payload = padded(100);
    const ref = await f.catalog(payload);
    await f.capture(payload);
    await f.capture(payload, { payloadRef: ref, omitInlinePayload: true });
    await f.capture(payload, { payloadRef: ref });
    const sizes = await db.pool.query(`
      select pg_column_compression(o.payload) as compression,
        pg_column_size(o.payload) as stored, fansly_earnings_audit_raw_bytes(o.payload) as raw
      from observations o where o.payload is not null
      union all
      select pg_column_compression(b.body), pg_column_size(b.body), fansly_earnings_audit_raw_bytes(b.body)
      from capture_json_hot_bodies b`);
    expect(sizes.rows).toHaveLength(3);
    for (const row of sizes.rows) {
      expect(row.compression).not.toBeNull();
      expect(row.stored).toBeLessThan(row.raw);
      expect(row.raw).toBeGreaterThan(5000);
      expect(row.raw).toBeLessThan(65536);
    }
    await f.parse(); await f.project();
    expect(await f.report()).toMatchObject({
      verified: true, observationCount: 3, observations: { valid: 3 }, outcomes: { matched: 1 },
    });
    expect(JSON.stringify(await observations())).not.toContain("private");
  });

  it("rejects oversized compressed copies even when the other copy or catalog receipt is small", async () => {
    const good = await f.catalog(padded(100));
    await f.capture(padded(100, 1_000_000), { payloadRef: good });
    const forged = await f.catalog(padded(200));
    await f.capture(padded(200), { payloadRef: forged, omitInlinePayload: true });
    await db.pool.query("update capture_json_hot_bodies set body=$1 where bucket_month=$2 and object_id=$3", [
      JSON.stringify(padded(200, 1_000_000)), forged.bucketMonth, forged.objectId,
    ]);
    const rows = await observations();
    expect(rows.map(row => row.status)).toEqual(["body_limit", "body_limit"]);
    expect(rows.every(row => row.payload === null)).toBe(true);
  });

  it("compares compressed dual copies before discarding unused fields", async () => {
    const ref = await f.catalog(padded(100));
    const different = [{ ...padded(100)[0], private: "y".repeat(5000) }];
    await f.capture(different, { payloadRef: ref });
    expect(await observations()).toMatchObject([{ status: "copy_disagreement", payload: null }]);
  });

  it("bounds numeric text expansion at root, row and field positions", async () => {
    for (const payload of ["1e100000", "[1e100000]", "1e-10000", '[{"totalGross":1e100000}]']) {
      const observation = await f.capture([]);
      await db.pool.query("update observations set payload=$1::jsonb where id=$2", [payload, observation.observationId]);
    }
    const rows = await observations();
    expect(rows).toHaveLength(4);
    expect(rows.every(row => row.status === "shape_limit" && row.payload === null)).toBe(true);
    expect((await f.report()).verified).toBe(false);
  });

  it("never serializes an unused large exponent and preserves supported numeric scalars", async () => {
    const observation = await f.capture([]);
    const payload = JSON.stringify(auditRow(100)).slice(0, -1) + ',"private":1e100000}';
    await db.pool.query("update observations set payload=$1::jsonb where id=$2", [
      "[" + payload + "]", observation.observationId,
    ]);
    const rows = await observations();
    expect(rows).toMatchObject([{ status: "available", payload: [auditRow(100)] }]);
    const result = await db.pool.query(`select fansly_earnings_audit_payload(
      '[1e100,1e-100,-1e100,0,null,true]'::jsonb) as payload`);
    expect(result.rows[0].payload).toEqual([1e100, 1e-100, -1e100, 0, null, true]);
  });

  it("rejects a bounded binary datum whose sanitized JSON exceeds the export limit", async () => {
    const payload = Array.from({ length: 500 }, () => ({ totalGross: 1e100, totalNet: 1e100 }));
    await f.capture(payload);
    const size = await db.pool.query("select fansly_earnings_audit_raw_bytes(o.payload) as bytes from observations o");
    expect(size.rows[0].bytes).toBeLessThan(65536);
    expect(await observations()).toMatchObject([{ status: "shape_limit", payload: null }]);
  });

  it("keeps both implementation helpers private to the restricted reader", async () => {
    for (const signature of ["fansly_earnings_audit_raw_bytes(jsonb)", "fansly_earnings_audit_scalar(jsonb,boolean)"]) {
      const grants = await db.pool.query("select has_function_privilege('earnings_audit_test_reader',$1,'execute') as allowed", [signature]);
      expect(grants.rows[0].allowed).toBe(false);
    }
    expect((await db.pool.query("show server_version_num")).rows[0].server_version_num).toMatch(/^16/);
  });
});
