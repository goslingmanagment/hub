// The two `* * * * *` jobs that were 81–89 % of all block reads on the
// production box (diagnosis 2026-08-23). Both had the same defect: an access
// path whose cost grew with the TABLE instead of with the work, so a job that
// found nothing still read hundreds of thousands of blocks a minute through a
// 128 MB shared_buffers.
//
// A repository test cannot catch that — the queries were always CORRECT. What
// broke was the plan, so the plan is what these tests assert: load a table of a
// realistic shape and size, ANALYZE it, and read back the plan PostgreSQL
// actually chooses for the query the job actually issues (captured off the pool
// so the assertion can never drift from the shipped SQL).

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  createModel,
  createOnlyFansPage,
  listOfapiWebhookEventsForSpendProjection,
  OFAPI_SPEND_PROJECTION_EVENT_TYPES,
} from "@agency_hub_core/db";

import { computeHealthFloorBacklogMs } from "../apps/runtime/src/services/health-floors.ts";
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
    `explain (analyze, buffers) ${statement.text}`,
    statement.values,
  );
  return plan.rows.map((row) => row["QUERY PLAN"]).join("\n");
}

describe("minutely job query plans", () => {
  beforeAll(async () => {
    testDb = await startIntegrationTestDatabase();
  }, INTEGRATION_TEST_TIMEOUT_MS);

  afterAll(async () => {
    await testDb?.stop();
    testDb = null;
  });

  it(
    "serves the OFAPI spend-projection sweep from the spend-candidate index",
    async (context) => {
      if (!testDb) {
        context.skip();
        return;
      }
      const pool = testDb.pool;
      const model = await createModel(testDb.db, { slug: "plan-model", name: "Plan Model" });
      const page = await createOnlyFansPage(testDb.db, { modelId: model!.id, label: "plan-page" });
      const pageId = page!.id;

      // 50 000 journal rows in the production mix: the three spend types are a
      // ~2 % minority, the rest is DM/notification traffic the sweep must never
      // read. `status` and `platform_account_id` vary so the partial index's
      // other two clauses are doing real work.
      await pool.query(
        `
        insert into ofapi_webhook_events (
          idempotency_key, event_type, ofapi_account_id, platform_account_id,
          payload, payload_hash, status, received_at
        )
        select
          'evt_' || lpad(n::text, 20, '0'),
          case
            when n % 50 = 0 then 'transactions.new'
            when n % 50 = 17 then 'messages.ppv.unlocked'
            when n % 50 = 31 then 'tips.received'
            when n % 3 = 0 then 'messages.received'
            when n % 3 = 1 then 'messages.sent'
            else 'users.online'
          end,
          'acct_02000000000000000000000000000000',
          case when n % 97 = 0 then null else $1::bigint end,
          '{}'::jsonb,
          '\\x00'::bytea,
          case when n % 23 = 0 then 'pending' else 'processed' end,
          now() - make_interval(secs => n)
        from generate_series(1, 50000) as n
      `,
        [pageId],
      );

      // Most candidates are already projected — the steady state the sweep runs
      // in, where it walks the journal to find the handful that are not.
      await pool.query(`
        insert into ofapi_spend_projection_events (
          domain_key, projection_status, source_event_type, source_idempotency_key,
          journal_id, ofapi_account_id, occurred_at
        )
        select 'domain_' || e.id, 'projected', e.event_type, e.idempotency_key,
               e.id, e.ofapi_account_id, e.received_at
        from ofapi_webhook_events e
        where e.event_type in ('transactions.new', 'messages.ppv.unlocked', 'tips.received')
          and e.status <> 'pending'
          and e.platform_account_id is not null
          and e.id % 5 <> 0
      `);

      await pool.query("analyze ofapi_webhook_events");
      await pool.query("analyze ofapi_spend_projection_events");

      const statement = await captureStatement(() =>
        listOfapiWebhookEventsForSpendProjection(testDb!.db, { limit: 200 })
      );

      // The event types have to reach the planner as CONSTANTS: a bound
      // parameter cannot be proven to imply the index predicate, and the index
      // is then silently unused.
      for (const eventType of OFAPI_SPEND_PROJECTION_EVENT_TYPES) {
        expect(statement.text).toContain(`'${eventType}'`);
      }

      const plan = await explain(statement);
      expect(plan).toContain("ofapi_webhook_events_spend_candidates_idx");
      // The defect this replaces, by name: the PK walk that read every row.
      expect(plan).not.toContain("ofapi_webhook_events_pkey");
      expect(plan).not.toContain("Seq Scan on ofapi_webhook_events");
    },
    INTEGRATION_TEST_TIMEOUT_MS,
  );

  it(
    "probes a health floor without reading the observations heap",
    async (context) => {
      if (!testDb) {
        context.skip();
        return;
      }
      const pool = testDb.pool;

      // One month of observations at production shape: many kinds per source,
      // a large already-consumed majority, and a genuine unparsed backlog (the
      // case that matters — a caught-up probe is trivial for any plan).
      await pool.query(`
        insert into observations (
          source, producer, platform, kind, payload, payload_hash,
          idempotency_key, received_at, parse_version
        )
        select
          case when n % 4 = 0 then 'webhook' else 'pull' end,
          'plan-test',
          'onlyfans',
          case (n % 8)
            when 0 then 'messages.received'
            when 1 then 'messages.sent'
            when 2 then 'transactions.new'
            when 3 then 'dm_messages'
            when 4 then 'earnings_transactions'
            when 5 then 'posts'
            when 6 then 'fan_earnings_stats'
            else 'purchase_history'
          end,
          '{}'::jsonb,
          '\\x00'::bytea,
          'obs_' || lpad(n::text, 20, '0'),
          date_trunc('month', now()) + make_interval(secs => n % 2000000),
          case when n % 6 = 0 then 0 else 5 end
        from generate_series(1, 60000) as n
      `);
      await pool.query("analyze observations");

      const statement = await captureStatement(() =>
        computeHealthFloorBacklogMs(testDb!.db, {
          name: "obs_backlog_pull_sync_v5",
          source: "pull",
          lane: "sync",
          kinds: [
            "earnings_transactions",
            "dm_messages",
            "fan_earnings_stats",
            "purchase_history",
          ],
          version: 5,
        })
      );

      const plan = await explain(statement);
      expect(plan).toContain("observations_health_floor_idx");
      // The defect this replaces: `parse_version` and `source` were heap
      // filters, so a probe read every row of its kind in every partition.
      expect(plan).not.toContain("observations_kind_received_at_idx");
      expect(plan).not.toMatch(/Seq Scan on observations_/);
    },
    INTEGRATION_TEST_TIMEOUT_MS,
  );
});
