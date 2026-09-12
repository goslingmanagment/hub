import { createHash, randomUUID } from "node:crypto";
import type { PoolClient } from "pg";
import {
  createFanslyPage, createModel, insertObservation, putPayloadObject,
  type ObservationInsertInput,
} from "@agency_hub_core/db";
import { runCanonicalization } from "../../apps/runtime/src/services/canonicalize-driver.ts";
import { runFanEarningsProjection } from "../../apps/runtime/src/services/projections/fan-earnings.ts";
import { EarningsAudit } from "../../scripts/fansly-events/earnings-audit.ts";
import {
  earningsAuditPageSchema, earningsAuditScopeSchema, type EarningsAuditScope,
} from "../../scripts/fansly-events/earnings-audit-types.ts";
import type { StartedTestDatabase } from "./db.ts";

export const auditRow = (amount: number, fan = "fan-a") => ({
  correlationAccountId: fan, type: 2110, totalGross: amount, totalNet: amount,
  year: 2026, month: 9,
});

export async function earningsAuditFixture(db: StartedTestDatabase) {
  const model = await createModel(db.db, { slug: "earnings-audit", name: "Audit" });
  if (!model) throw new Error("Missing test model");
  const page = await createFanslyPage(db.db, { modelId: model.id, label: "earnings-audit" });
  if (!page) throw new Error("Missing test page");
  const pageId = page.id;
  const pageLabel = page.label;
  await db.pool.query(`
    DO $$ BEGIN
      IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'earnings_audit_test_reader') THEN
        CREATE ROLE earnings_audit_test_reader;
      END IF;
    END $$;
    GRANT EXECUTE ON FUNCTION fansly_earnings_audit_scope(text, timestamptz, timestamptz)
      TO earnings_audit_test_reader;
    GRANT EXECUTE ON FUNCTION fansly_earnings_audit_observations(jsonb, timestamptz, bigint, integer)
      TO earnings_audit_test_reader;
    GRANT EXECUTE ON FUNCTION fansly_earnings_audit_projection(jsonb, bigint, text, integer)
      TO earnings_audit_test_reader;
  `);
  const app = { db: db.db, logger: { info() {}, warn() {}, error() {} } } as never;
  async function capture(payload: unknown, overrides: Partial<ObservationInsertInput> = {}) {
    return insertObservation(db.db, {
      source: "pull", producer: "test:earnings", platform: "fansly", accountId: pageId,
      kind: "fan_earnings_stats", payload, idempotencyKey: randomUUID(),
      payloadHash: createHash("sha256").update(JSON.stringify(payload)).digest(), ...overrides,
    });
  }
  async function catalog(payload: unknown, overrides: { accountId?: number; restricted?: boolean } = {}) {
    return putPayloadObject(db.db, {
      representation: "canonical_json", json: payload,
      captureInstant: new Date("2026-09-01T00:00:00Z"),
      lane: overrides.restricted ? "ai_generation" : "platform_capture",
      platformAccountId: overrides.accountId ?? pageId,
    });
  }
  async function withAudit<T>(run: (client: PoolClient, scope: EarningsAuditScope) => Promise<T>) {
    const client = await db.pool.connect();
    try {
      await client.query("begin isolation level repeatable read read only");
      await client.query("set local role earnings_audit_test_reader");
      await client.query("set local statement_timeout = '15s'");
      const { rows } = await client.query(`select fansly_earnings_audit_scope(
        $1, transaction_timestamp() - interval '366 days', transaction_timestamp()) as scope`, [pageLabel]);
      return await run(client, earningsAuditScopeSchema.parse(rows[0].scope));
    } finally {
      await client.query("rollback");
      client.release();
    }
  }
  async function report(pageLimit = 1) {
    return withAudit(async (client, scope) => {
      const audit = new EarningsAudit(scope);
      for (const operation of ["observations", "projection"] as const) {
        let cursor: [string | null, string] = operation === "observations" ? [null, "0"] : ["0", ""];
        for (;;) {
          const { rows } = await client.query(
            `select fansly_earnings_audit_${operation}($1, $2, $3, $4) as result`,
            [scope, ...cursor, pageLimit],
          );
          const result = earningsAuditPageSchema.parse(rows[0].result);
          audit.accept(result);
          if (result.exhausted) break;
          if (!result.next) throw new Error("Missing test continuation");
          cursor = result.operation === "observations"
            ? [result.next.receivedAt, result.next.id] : [result.next.fanId, result.next.window];
        }
      }
      return audit.report();
    });
  }
  async function parse() { return runCanonicalization(app, { accountId: pageId }); }
  async function project() { return runFanEarningsProjection(app, { accountId: pageId }); }
  return { page, capture, catalog, withAudit, report, parse, project };
}
