import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { appendDomainEvents } from "@agency_hub_core/db";
import { EarningsAudit } from "../scripts/fansly-events/earnings-audit.ts";
import { earningsAuditScopeSchema } from "../scripts/fansly-events/earnings-audit-types.ts";
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

describe("C2a retained snapshots versus the real earnings projector", () => {
  it.each(["fan_earnings_stats", "fan_earnings_monthly"])(
    "%s audits A-B-A, stale arrival and equal-time observation ordering", async kind => {
      async function observe(minute: number, amount: number) {
        const capture = await f.capture([auditRow(amount)], {
          kind, observedAt: new Date(Date.UTC(2026, 8, 1, 0, minute)),
        });
        await f.parse(); await f.project();
        return capture.observationId;
      }
      async function expectCurrent(amount: number, sourceId: number, observationCount: number) {
        expect(await f.report(1)).toMatchObject({
          verified: true, observationCount, projectionCount: 1, outcomes: { matched: 1 },
        });
        const current = await db.pool.query(
          "select gross_mills::text, source_observation_id::text from fan_earnings_stats",
        );
        expect(current.rows).toEqual([{
          gross_mills: String(amount), source_observation_id: String(sourceId),
        }]);
      }

      await observe(1, 100);
      await observe(2, 200);
      const repeatedSource = await observe(3, 100);
      await expectCurrent(100, repeatedSource, 3);
      await observe(0, 50);
      await expectCurrent(100, repeatedSource, 4);
      const laterSource = await observe(3, 125);
      await expectCurrent(125, laterSource, 5);
    },
  );

  it("resolves legacy source ID zero, but refuses an unavailable legacy event", async () => {
    await f.capture([auditRow(100)]);
    await f.parse(); await f.project();
    await db.pool.query("update fan_earnings_stats set source_observation_id=0");
    expect(await f.report()).toMatchObject({ verified: true, legacySources: 1, outcomes: { matched: 1 } });
    await db.pool.query("update fan_earnings_stats set source_event_id=-1");
    expect(await f.report()).toMatchObject({ verified: false, outcomes: { source_unavailable: 1 } });
  });

  it("paginates equal receipt timestamps without dropping the later observation ID", async () => {
    const receivedAt = new Date(Date.now() - 3600_000);
    await f.capture([auditRow(100)], { receivedAt });
    await f.capture([auditRow(200)], { receivedAt });
    await f.parse(); await f.project();
    expect(await f.report(1)).toMatchObject({
      verified: true, observationCount: 2, projectionCount: 1, outcomes: { matched: 1 },
    });
  });

  it("keeps projection lag distinct from a remaining mismatch after catch-up", async () => {
    await f.capture([auditRow(100)]);
    await f.parse(); await f.project();
    await f.capture([auditRow(200)]);
    await f.parse();
    expect(await f.report()).toMatchObject({
      verified: false, projectorCaughtUp: false, outcomes: { projection_pending: 1 },
    });
    await f.project();
    expect(await f.report()).toMatchObject({ verified: true, outcomes: { matched: 1 } });
    await db.pool.query("update fan_earnings_stats set gross_mills=201");
    expect(await f.report()).toMatchObject({ verified: false, outcomes: { source_mismatch: 1 } });
  });

  it("reports missing rows without hiding zero-valued fans", async () => {
    await f.capture([auditRow(0)]);
    await f.parse(); await f.project();
    await db.pool.query("delete from fan_earnings_stats");
    expect(await f.report()).toMatchObject({
      verified: false, projectorCaughtUp: true, projectionCount: 0, outcomes: { missing: 1 },
    });
  });

  it("reports an extra legacy row that its retained empty observation cannot reconstruct", async () => {
    const empty = await f.capture([]);
    await f.parse();
    await appendDomainEvents(db.db, f.page.id, [{
      type: "fan.earnings_observed", occurredAt: empty.receivedAt,
      observationId: empty.observationId, fanIdentityRef: "ghost",
      data: { window: "lifetime", grossMills: 100, netMills: 80 },
      schemaVersion: 1, dedupKey: "legacy-extra-row",
    }]);
    await f.project();
    expect(await f.report()).toMatchObject({ verified: false, observations: { empty: 1 }, outcomes: { extra: 1 } });
  });

  it("does not certify empty-only or partially invalid observations", async () => {
    await f.capture([]);
    await f.parse();
    await db.pool.query(`insert into projection_seq_watermarks(projection, account_id, high_seq)
      values ('fan_earnings_stats', $1, 0)`, [f.page.id]);
    expect(await f.report()).toMatchObject({ verified: false, projectorCaughtUp: true, observations: { empty: 1 } });
    await f.capture([auditRow(100), { ...auditRow(100), totalNet: null }]);
    await f.parse(); await f.project();
    expect(await f.report()).toMatchObject({
      verified: false, parseDebt: 1, projectionCount: 0, observations: { invalid_earnings_money: 1 },
    });
  });

  it("distinguishes a projection sourced outside the selected received-at cohort", async () => {
    const now = Date.now();
    await f.capture([auditRow(100)], { receivedAt: new Date(now - 3600_000) });
    await f.capture([auditRow(200)], { receivedAt: new Date(now - 1800_000) });
    await f.parse(); await f.project();
    await f.withAudit(async (client) => {
      const scopeResult = await client.query("select fansly_earnings_audit_scope($1,$2,$3) scope", [
        f.page.label, new Date(now - 7200_000), new Date(now - 2700_000),
      ]);
      const scope = earningsAuditScopeSchema.parse(scopeResult.rows[0].scope);
      const audit = new EarningsAudit(scope);
      for (const operation of ["observations", "projection"]) {
        const rows = await client.query(`select fansly_earnings_audit_${operation}($1) result`, [scope]);
        audit.accept(rows.rows[0].result);
      }
      expect(audit.report()).toMatchObject({ verified: false, outcomes: { outside_cohort: 1 } });
    });
  });

  it("withholds unexpected nested event fields instead of exporting unrelated content", async () => {
    await f.capture([auditRow(100)]);
    await f.parse(); await f.project();
    await db.pool.query(`update domain_events set data = jsonb_build_object(
      'window', jsonb_build_object('secret', 'must-not-export'),
      'grossMills', jsonb_build_object('secret', 'must-not-export'), 'netMills', 100)
      where type='fan.earnings_observed'`);
    const report = await f.report();
    expect(report).toMatchObject({ verified: false, outcomes: { source_mismatch: 1 } });
    expect(JSON.stringify(report)).not.toContain("must-not-export");
  });
});
