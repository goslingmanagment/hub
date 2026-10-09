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

import {
  CAPTURE_PENDING_AGE_PLANNER_SQL,
  CAPTURE_PENDING_AGE_SQL,
  readCapturePendingAgeMs,
} from "../apps/runtime/src/services/golden-signals.ts";
import {
  computeHealthFloorBacklogMs,
  type HealthFloorDescriptor,
} from "../apps/runtime/src/services/health-floors.ts";
import { sql } from "../packages/db/node_modules/drizzle-orm/index.js";
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

      // What the sweep actually gets back, not just how it got there: a plan
      // assertion alone would still pass if the `not exists` anti-join were
      // lost, and the sweep would then re-project every settled row forever.
      const candidates = await listOfapiWebhookEventsForSpendProjection(
        testDb.db,
        { limit: 200 },
      );
      const unprojected = await pool.query<{ id: string }>(`
        select e.id::text as id
        from ofapi_webhook_events e
        where e.event_type in ('transactions.new', 'messages.ppv.unlocked', 'tips.received')
          and e.status <> 'pending'
          and e.platform_account_id is not null
          and e.id % 5 = 0
        order by e.id
        limit 200
      `);
      expect(unprojected.rows.length).toBeGreaterThan(0);
      expect(candidates.map((row) => String(row.id)))
        .toEqual(unprojected.rows.map((row) => row.id));

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

      // And the steady state the sweep actually lives in: once everything is
      // projected it must come back empty rather than re-offering the corpus.
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
          and e.id % 5 = 0
      `);
      expect(await listOfapiWebhookEventsForSpendProjection(testDb.db, { limit: 200 }))
        .toEqual([]);
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
      // Leaf indexes carry the partition prefix (observations_2026_08_…), so
      // the parent's own name never appears in a plan.
      expect(plan).toMatch(/Index Only Scan using observations_\w+_health_floor_idx/);
      // The defect this replaces: `parse_version` and `source` were heap
      // filters, so a probe read every row of its kind in every partition.
      expect(plan).not.toContain("observations_kind_received_at_idx");
      expect(plan).not.toMatch(/Seq Scan on observations_/);

      // The kinds:null family had it worse: `source = $s and parse_version < $v`
      // matched no index at all and was a parallel seq scan of the whole
      // journal (96 605 buffers, 2.9-4.0 s on prod). It has to be on the index
      // too, or the sampler keeps a whole-table read in it.
      const totalStatement = await captureStatement(() =>
        computeHealthFloorBacklogMs(testDb!.db, {
          name: "obs_backlog_command_result_result_v1",
          source: "command_result",
          lane: "result",
          kinds: null,
          version: 1,
        })
      );
      const totalPlan = await explain(totalStatement);
      expect(totalPlan).toMatch(/observations_\w+_health_floor_idx/);
      // Empty partitions cost zero either way and PostgreSQL happily seq-scans
      // them; what must never happen is a seq scan that actually READS rows.
      const seqScanned = [...totalPlan.matchAll(/Seq Scan on observations_\w+[^\n]*rows=(\d+)/g)]
        .map((match) => Number(match[1]));
      expect(seqScanned.filter((rows) => rows > 0)).toEqual([]);
    },
    INTEGRATION_TEST_TIMEOUT_MS,
  );

  it(
    "measures the capture wedge from the partial pending index, never the processed_at BRIN",
    async (context) => {
      if (!testDb) {
        context.skip();
        return;
      }
      const pool = testDb.pool;

      // The journal on prod: a large settled history, and rows that arrive
      // with a null processed_at and are stamped moments later — so the
      // partial index keeps the pages it grew to while all it holds is a few
      // waiting rows (prod 2026-10-09: 664 kB, zero rows). Rows an earlier
      // test left waiting are settled first: nothing else waits.
      await pool.query(`
        update ofapi_webhook_events set processed_at = received_at + interval '2 seconds', status = 'processed'
        where processed_at is null
      `);
      await pool.query(`
        insert into ofapi_webhook_events (idempotency_key, event_type, payload, payload_hash, status, received_at, processed_at)
        select 'settled_' || lpad(n::text, 20, '0'), 'messages.received', '{}'::jsonb, '\\x00'::bytea, 'processed',
               now() - interval '3 days' + make_interval(secs => n),
               now() - interval '3 days' + make_interval(secs => n + 2)
        from generate_series(1, 100000) as n
      `);
      await pool.query(`
        insert into ofapi_webhook_events (idempotency_key, event_type, payload, payload_hash, received_at)
        select 'wedge_' || lpad(n::text, 20, '0'), 'messages.received', '{}'::jsonb, '\\x00'::bytea,
               now() - make_interval(secs => n)
        from generate_series(1, 20000) as n
      `);
      // The oldest of the three still waiting is 40 minutes old.
      await pool.query(`
        update ofapi_webhook_events set processed_at = received_at + interval '2 seconds', status = 'processed'
        where idempotency_key like 'wedge_%'
          and idempotency_key not in ('wedge_' || lpad('2400', 20, '0'), 'wedge_' || lpad('600', 20, '0'), 'wedge_' || lpad('60', 20, '0'))
      `);
      await pool.query("vacuum analyze ofapi_webhook_events");

      // The shipped statement under the shipped setting, the way the sampler
      // runs it (readCapturePendingAgeMs; tests/golden-signals-plan-guards.test.ts
      // pins that it does). Which path wins WITHOUT the setting turns on the
      // partial index's post-vacuum statistics: on prod (83 pages for 2
      // tuples, the BRIN priced at 24) the BRIN won, so the plan is pinned
      // rather than left to them.
      const plan = await testDb.db.transaction(async (tx) => {
        await tx.execute(CAPTURE_PENDING_AGE_PLANNER_SQL);
        const explained = await tx.execute<{ "QUERY PLAN": string }>(
          sql`explain (analyze, buffers) ${CAPTURE_PENDING_AGE_SQL}`,
        );
        return explained.rows.map((row) => row["QUERY PLAN"]).join("\n");
      });
      expect(plan).toContain("Index Only Scan using ofapi_webhook_events_pending_received_idx");
      expect(plan).not.toContain("ofapi_webhook_events_processed_at_brin");
      expect(plan).not.toContain("Seq Scan on ofapi_webhook_events");

      // Same number as before: the oldest waiting row, not a newer one.
      const ageMs = await readCapturePendingAgeMs(testDb.db);
      expect(ageMs / 60_000).toBeCloseTo(40, 0);

      // SET LOCAL ended with the gauge's transaction: the pool keeps bitmap scans.
      const setting = await pool.query<{ enable_bitmapscan: string }>("show enable_bitmapscan");
      expect(setting.rows[0]?.enable_bitmapscan).toBe("on");
    },
    INTEGRATION_TEST_TIMEOUT_MS,
  );

  it(
    "probes a caught-up kinds:null floor without walking the version's other sources",
    async (context) => {
      if (!testDb) {
        context.skip();
        return;
      }
      const pool = testDb.pool;

      // Prod shape (2026-10-09): the journal holds ~1.7 M version-0 rows of the
      // OTHER sources; the kinds:null source (command_result) is a small slice
      // that is fully parsed, so nothing of it waits below its floor. Column
      // statistics are independent, so the planner still expects a few hundred
      // pending rows of it at version 0 — and a `min()` rewritten into
      // `order by received_at limit 1` over (parse_version, received_at) then
      // looks cheap, while it really walks every version-0 row to the end.
      await pool.query(`
        insert into observations (
          source, producer, platform, kind, payload, payload_hash,
          idempotency_key, received_at, parse_version
        )
        select
          case when n % 100 = 0 then 'command_result' when n % 2 = 0 then 'fansly_ws' else 'client_capture' end,
          'plan-test',
          null,
          case when n % 100 = 0 then 'command.result' when n % 2 = 0 then 'fansly.ws.frame.v1' else 'desktop.send_audit' end,
          '{}'::jsonb,
          '\\x00'::bytea,
          'walk_' || lpad(n::text, 20, '0'),
          date_trunc('month', now()) + make_interval(secs => n % 2000000),
          case when n % 100 = 0 then 1 else 0 end
        from generate_series(1, 80000) as n
      `);
      await pool.query("analyze observations");

      const statement = await captureStatement(() =>
        computeHealthFloorBacklogMs(testDb!.db, {
          name: "obs_backlog_command_result_result_v1",
          source: "command_result",
          lane: "result",
          kinds: null,
          version: 1,
        })
      );
      const plan = await explain(statement);
      expect(plan).toMatch(/observations_\w+_health_floor_idx/);
      // The defect, by name: the time-ordered walk of the version's rows.
      expect(plan).not.toMatch(/observations_\w+_parse_version_received_at_idx/);
      expect(plan).not.toMatch(/Seq Scan on observations_\w+[^\n]*actual[^\n]*rows=[1-9]/);
    },
    INTEGRATION_TEST_TIMEOUT_MS,
  );

  it("excludes unsettled captures below the replay family's minimum version", async () => {
    if (!testDb) throw new Error("PostgreSQL required");
    await testDb.pool.query(`
      insert into observations (source, producer, kind, payload, payload_hash, idempotency_key, received_at, parse_version)
      values
        ('ofapi_capture', 'floor-test', 'ofapi.posts_page.v1', '{}', '\\x00', 'of-pending', now() - interval '9 hours', 0),
        ('ofapi_capture', 'floor-test', 'ofapi.posts_page.v1', '{}', '\\x00', 'of-replay', now() - interval '1 hour', 7),
        ('ofapi_capture', 'floor-test', 'ofapi.posts_page.v1', '{}', '\\x00', 'of-done', now() - interval '3 hours', 8)
    `);
    for (const kinds of [["ofapi.posts_page.v1"], null]) {
      const age = await computeHealthFloorBacklogMs(testDb.db, {
        name: "of-test", source: "ofapi_capture", lane: "ofapi-posts", kinds, minimumParseVersion: 7, version: 8,
      });
      expect(Math.abs(age - 3_600_000)).toBeLessThan(1_000);
    }
  });

  it(
    "reports the same backlog the pre-index probe did",
    async (context) => {
      if (!testDb) {
        context.skip();
        return;
      }
      const pool = testDb.pool;

      // The rewrite is an ACCESS-PATH change; the number must not move. Its own
      // rows, its own source, so this holds standalone: `alpha` is unparsed,
      // `beta` is stamped part-way up, `gamma` is at the floor (caught up).
      await pool.query(`
        insert into observations (
          source, producer, platform, kind, payload, payload_hash,
          idempotency_key, received_at, parse_version
        ) values
          ('operator', 'floor-test', null, 'alpha', '{}'::jsonb, '\\x00'::bytea, 'floor_a1', now() - interval '9 hours', 0),
          ('operator', 'floor-test', null, 'alpha', '{}'::jsonb, '\\x00'::bytea, 'floor_a2', now() - interval '5 hours', 0),
          ('operator', 'floor-test', null, 'beta',  '{}'::jsonb, '\\x00'::bytea, 'floor_b1', now() - interval '7 hours', 2),
          ('operator', 'floor-test', null, 'beta',  '{}'::jsonb, '\\x00'::bytea, 'floor_b2', now() - interval '3 hours', 2),
          ('operator', 'floor-test', null, 'gamma', '{}'::jsonb, '\\x00'::bytea, 'floor_g1', now() - interval '8 hours', 5),
          ('operator', 'floor-test', null, 'gamma', '{}'::jsonb, '\\x00'::bytea, 'floor_g2', now() - interval '2 hours', 5)
      `);

      /** The probe exactly as it read before migration 0144 — the oracle. */
      async function previousProbe(floor: HealthFloorDescriptor): Promise<number> {
        if (floor.kinds === null) {
          const total = await pool.query<{ backlog_ms: string | null }>(
            `select coalesce(extract(epoch from (now() - min(o.received_at))) * 1000, 0)::float8 as backlog_ms
             from observations o
             where o.source = $1 and o.parse_version < $2`,
            [floor.source, floor.version],
          );
          return Number(total.rows[0]?.backlog_ms ?? 0);
        }
        if (floor.kinds.length === 0) {
          return 0;
        }
        const perKind = await pool.query<{ backlog_ms: string | null }>(
          `select coalesce(max(extract(epoch from (now() - per_kind.min_received)) * 1000), 0)::float8 as backlog_ms
           from unnest($1::text[]) as kind_list(kind)
           cross join lateral (
             select min(o.received_at) as min_received
             from observations o
             where o.kind = kind_list.kind and o.source = $2 and o.parse_version < $3
           ) per_kind`,
          [[...floor.kinds], floor.source, floor.version],
        );
        return Number(perKind.rows[0]?.backlog_ms ?? 0);
      }

      const floors: HealthFloorDescriptor[] = [
        // A real backlog spanning two kinds and two parse versions.
        { name: "t", source: "operator", lane: "t", kinds: ["alpha", "beta"], version: 5 },
        // Caught up: every row is already at the floor.
        { name: "t", source: "operator", lane: "t", kinds: ["gamma"], version: 5 },
        // A version-0 family measures an empty set, never a false backlog.
        { name: "t", source: "operator", lane: "t", kinds: ["alpha"], version: 0 },
        // No kinds at all.
        { name: "t", source: "operator", lane: "t", kinds: [], version: 5 },
        // kinds:null — the total over the source.
        { name: "t", source: "operator", lane: "t", kinds: null, version: 5 },
      ];

      for (const floor of floors) {
        const expected = await previousProbe(floor);
        const actual = await computeHealthFloorBacklogMs(testDb.db, floor);
        if (expected === 0) {
          expect(actual).toBe(0);
        } else {
          // Both read now() at slightly different instants.
          expect(Math.abs(actual - expected)).toBeLessThan(1_000);
        }
      }

      // The oldest unparsed row is 9 hours old, and that is what the family
      // gauge reports — not the 3-hour or the 5-hour row.
      const backlogMs = await computeHealthFloorBacklogMs(testDb.db, {
        name: "t",
        source: "operator",
        lane: "t",
        kinds: ["alpha", "beta"],
        version: 5,
      });
      expect(backlogMs / 3_600_000).toBeCloseTo(9, 1);
    },
    INTEGRATION_TEST_TIMEOUT_MS,
  );
});
