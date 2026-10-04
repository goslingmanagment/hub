// A sync reader that wants a handful of rows out of the biggest sync journal,
// and had no index leading with the columns it filters on: the
// purchase-history readers want rows by (page_id, endpoint) from
// sync_raw_payloads (788 MB, 2.5M rows on prod 2026-09-30). The legacy lane's
// three reads per chunk were seq scans of ~0.8-1.1 s each before any egress
// (that lane is gone since step 4, S4-16; the engine's switch import reads the
// captured ids through the same index). (Migration 0223's other index served
// the legacy dm_messages 5xx breaker's streak read, which went with the legacy
// DM handler at step 4, S4-14.)
//
// The SQL was always correct and does not change; migration 0223 adds a
// partial index for it. What these tests assert is the plan PostgreSQL picks
// for the statement the repository actually sends, captured off the pool with
// its bound values and explained over the same unnamed-statement protocol the
// runtime uses (so a bound endpoint is planned as the constant it is).

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  createFanslyPage,
  createModel,
  listFanslyPurchaseHistoryCapturedContentIds,
} from "@agency_hub_core/db";

import { startIntegrationTestDatabase, type StartedTestDatabase } from "./helpers/db.ts";
import { INTEGRATION_TEST_TIMEOUT_MS } from "./helpers/timeouts.ts";

let testDb: StartedTestDatabase | null = null;

/** The statement drizzle put on the wire for `run`, verbatim. */
async function captureStatement(
  run: () => Promise<unknown>,
): Promise<{ text: string; values: unknown[] }> {
  const pool = testDb!.pool as unknown as {
    query: (config: unknown, values?: unknown) => Promise<unknown>;
  };
  const original = pool.query.bind(pool);
  const captured: { text: string; values: unknown[] }[] = [];
  pool.query = (config: unknown, values?: unknown) => {
    if (typeof config === "string") {
      captured.push({ text: config, values: (values as unknown[]) ?? [] });
    } else if (config && typeof (config as { text?: unknown }).text === "string") {
      const record = config as { text: string; values?: unknown[] };
      captured.push({ text: record.text, values: (values as unknown[]) ?? record.values ?? [] });
    }
    return original(config, values);
  };
  try {
    await run();
  } finally {
    pool.query = original;
  }
  const statement = captured.at(-1);
  if (!statement) {
    throw new Error("No statement reached the pool");
  }
  return statement;
}

async function explain(statement: { text: string; values: unknown[] }): Promise<string> {
  const plan = await testDb!.pool.query<{ "QUERY PLAN": string }>(
    `explain ${statement.text}`,
    statement.values,
  );
  return plan.rows.map((row) => row["QUERY PLAN"]).join("\n");
}

describe("sync lookup query plans", () => {
  beforeAll(async () => {
    testDb = await startIntegrationTestDatabase();
  }, INTEGRATION_TEST_TIMEOUT_MS);

  afterAll(async () => {
    await testDb?.stop();
    testDb = null;
  });

  it(
    "serves the purchase-history capture read from the purchase-history index",
    async (context) => {
      if (!testDb) {
        context.skip();
        return;
      }
      const pool = testDb.pool;
      const model = await createModel(testDb.db, { slug: "ph-plan-model", name: "PH Plan Model" });
      const pageIds: number[] = [];
      for (const label of ["ph-plan-a", "ph-plan-b", "ph-plan-c"]) {
        const page = await createFanslyPage(testDb.db, { modelId: model!.id, label });
        pageIds.push(page!.id);
      }
      const [pageId] = pageIds as [number];

      // 100 000 captures in the production mix: DM and group pages dominate,
      // purchase_history is under 0.5 % and interleaved with them, and the
      // contract probe/storm endpoints are rarer still.
      await pool.query(
        `
        insert into sync_raw_payloads (
          page_id, endpoint, request_params, response_payload,
          mapper_version, payload_kind, retain_until
        )
        select
          ($1::bigint[])[1 + n % 3],
          case
            when n % 20000 = 13 then 'purchase_history_contract_storm'
            when n % 5000 = 11 then 'purchase_history_contract_probe'
            when n % 250 = 7 then 'purchase_history'
            when n % 10 < 6 then 'dm_messages'
            when n % 10 < 8 then 'messaging_groups'
            when n % 10 = 8 then 'earnings_transactions'
            else 'followers'
          end,
          case
            when n % 20000 = 13 then jsonb_build_object('mediaKind', 'single')
            when n % 5000 = 11 or n % 250 = 7 then jsonb_build_object('accountMediaId', n::text)
            else jsonb_build_object('n', n)
          end,
          '{}'::jsonb,
          'plan-test',
          'mapping_critical',
          now() + interval '30 days'
        from generate_series(1, 100000) as n
      `,
        [pageIds],
      );
      await pool.query("analyze sync_raw_payloads");

      // What the read gets back, so the seed is known to reach it: the
      // engine's one-time import at the step-3 switch reads the captured ids.
      const count = (predicate: (n: number) => boolean) =>
        Array.from({ length: 100_000 }, (_, index) => index + 1)
          .filter((n) => n % 3 === 0 && predicate(n)).length;
      const capturedIds = await listFanslyPurchaseHistoryCapturedContentIds(testDb.db, pageId);
      expect(capturedIds).toHaveLength(count((n) => n % 250 === 7));

      const statements = [
        await captureStatement(() => listFanslyPurchaseHistoryCapturedContentIds(testDb!.db, pageId)),
      ];
      for (const statement of statements) {
        const plan = await explain(statement);
        expect(plan).toContain("sync_raw_payloads_purchase_history_idx");
        // The defect this replaces: a whole-table read per call.
        expect(plan).not.toContain("Seq Scan on sync_raw_payloads");
      }
    },
    INTEGRATION_TEST_TIMEOUT_MS,
  );
});
