// Two sync readers that want a handful of rows out of the two biggest sync
// journals, and had no index leading with the columns they filter on:
//
// - every purchase_history chunk reads its captures, its contract-probe pages
//   and its storm verdicts by (page_id, endpoint) from sync_raw_payloads
//   (788 MB, 2.5M rows on prod 2026-09-30): three seq scans per chunk before
//   any egress, ~0.8-1.1 s each;
// - the dm_messages 5xx breaker reads one thread's attempts by (page_id,
//   request_shape ->> 'groupId') from sync_http_attempts (598 MB): a seq scan,
//   ~3 s mean, while the dm_messages lease is held.
//
// The SQL was always correct and does not change; migration 0223 adds a
// partial index for each. What these tests assert is the plan PostgreSQL picks
// for the statement the repository actually sends, captured off the pool with
// its bound values and explained over the same unnamed-statement protocol the
// runtime uses (so a bound endpoint is planned as the constant it is).

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  countRecentTerminalDmMessageConversationFailureStreak,
  createFanslyPage,
  createModel,
  listFanslyPurchaseHistoryCaptures,
  listFanslyPurchaseHistoryStormVerdicts,
  startSyncRun,
} from "@agency_hub_core/db";

import {
  FANSLY_PURCHASE_HISTORY_CONTRACT_PROBE_ENDPOINT,
  FANSLY_PURCHASE_HISTORY_CONTRACT_STORM_ENDPOINT,
} from "../apps/runtime/src/services/sync/fansly-purchase-history.ts";
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

function ascending(ids: number[]): boolean {
  return ids.every((id, index) => index === 0 || ids[index - 1]! < id);
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
    "serves every purchase_history chunk read from the purchase-history index",
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
            when n % 20000 = 13 then '${FANSLY_PURCHASE_HISTORY_CONTRACT_STORM_ENDPOINT}'
            when n % 5000 = 11 then '${FANSLY_PURCHASE_HISTORY_CONTRACT_PROBE_ENDPOINT}'
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

      // What the chunk gets back, so the seed is known to reach every read.
      const count = (predicate: (n: number) => boolean) =>
        Array.from({ length: 100_000 }, (_, index) => index + 1)
          .filter((n) => n % 3 === 0 && predicate(n)).length;
      const captures = await listFanslyPurchaseHistoryCaptures(testDb.db, pageId);
      expect(captures).toHaveLength(count((n) => n % 250 === 7));
      expect(ascending(captures.map((row) => row.id))).toBe(true);
      const probes = await listFanslyPurchaseHistoryCaptures(
        testDb.db,
        pageId,
        FANSLY_PURCHASE_HISTORY_CONTRACT_PROBE_ENDPOINT,
      );
      expect(probes).toHaveLength(count((n) => n % 5000 === 11 && n % 20000 !== 13));
      expect(ascending(probes.map((row) => row.id))).toBe(true);
      const verdicts = await listFanslyPurchaseHistoryStormVerdicts(testDb.db, pageId);
      expect(verdicts).toHaveLength(count((n) => n % 20000 === 13));
      expect(verdicts.every((verdict) => verdict.kind === "single")).toBe(true);

      const statements = [
        await captureStatement(() => listFanslyPurchaseHistoryCaptures(testDb!.db, pageId)),
        await captureStatement(() =>
          listFanslyPurchaseHistoryCaptures(testDb!.db, pageId, FANSLY_PURCHASE_HISTORY_CONTRACT_PROBE_ENDPOINT)
        ),
        await captureStatement(() => listFanslyPurchaseHistoryStormVerdicts(testDb!.db, pageId)),
      ];
      for (const statement of statements) {
        const plan = await explain(statement);
        expect(plan).toContain("sync_raw_payloads_purchase_history_idx");
        // The defect this replaces: a whole-table read per call, three per chunk.
        expect(plan).not.toContain("Seq Scan on sync_raw_payloads");
      }
    },
    INTEGRATION_TEST_TIMEOUT_MS,
  );

  it(
    "reads a DM thread's 5xx streak from the dm-group index",
    async (context) => {
      if (!testDb) {
        context.skip();
        return;
      }
      const pool = testDb.pool;
      const model = await createModel(testDb.db, { slug: "dm-plan-model", name: "DM Plan Model" });
      const runs: { id: number; pageId: number; stream: string }[] = [];
      for (const label of ["dm-plan-a", "dm-plan-b", "dm-plan-c"]) {
        const page = await createFanslyPage(testDb.db, { modelId: model!.id, label });
        for (const stream of ["dm_messages", "dm_conversations", "followers"] as const) {
          const run = await startSyncRun(testDb.db, {
            platformAccountId: page!.id,
            stream,
            trigger: "scheduled",
          });
          runs.push({ id: run!.id, pageId: page!.id, stream });
        }
      }
      const target = runs[0]!;

      // 60 000 attempts over a month: group and follower walks dominate, and
      // the /message reads spread over 1 000 threads a page, so one thread is a
      // few rows the streak check must not find by reading them all.
      await pool.query(
        `
        insert into sync_http_attempts (
          sync_run_id, page_id, provider, stream, operation, logical_request_id,
          attempt_number, state, http_status, request_shape, started_at, finished_at
        )
        select
          ($1::bigint[])[1 + n % 9],
          ($2::bigint[])[1 + n % 9],
          'fansly',
          (($3::text[])[1 + n % 9])::sync_stream,
          case ($3::text[])[1 + n % 9]
            when 'dm_messages' then 'messages'
            when 'dm_conversations' then 'messaging_groups'
            else 'followers'
          end,
          'plan:' || n,
          1,
          'success',
          200,
          case
            when ($3::text[])[1 + n % 9] = 'dm_messages' then jsonb_build_object('groupId', 'group-' || (n % 3000))
            else jsonb_build_object('offset', n)
          end,
          now() - interval '30 days' + make_interval(secs => n * 40),
          now() - interval '30 days' + make_interval(secs => n * 40 + 1)
        from generate_series(1, 60000) as n
      `,
        [runs.map((run) => run.id), runs.map((run) => run.pageId), runs.map((run) => run.stream)],
      );
      // The thread under test: a success, then two terminal 5xx (the second
      // after a retried attempt) — a streak of two.
      await pool.query(
        `
        insert into sync_http_attempts (
          sync_run_id, page_id, provider, stream, operation, logical_request_id,
          attempt_number, state, failure_kind, http_status, request_shape, started_at, finished_at
        ) values
          ($1, $2, 'fansly', 'dm_messages', 'messages', 'streak:1', 1, 'success', null, 200,
           '{"groupId":"streak-group"}', now() - interval '3 minutes', now() - interval '3 minutes'),
          ($1, $2, 'fansly', 'dm_messages', 'messages', 'streak:2', 1, 'failed', 'http', 500,
           '{"groupId":"streak-group"}', now() - interval '2 minutes', now() - interval '2 minutes'),
          ($1, $2, 'fansly', 'dm_messages', 'messages', 'streak:3', 1, 'retry', 'http', 503,
           '{"groupId":"streak-group"}', now() - interval '90 seconds', now() - interval '90 seconds'),
          ($1, $2, 'fansly', 'dm_messages', 'messages', 'streak:3', 2, 'failed', 'http', 503,
           '{"groupId":"streak-group"}', now() - interval '1 minute', now() - interval '1 minute')
      `,
        [target.id, target.pageId],
      );
      await pool.query("analyze sync_http_attempts");

      const input = { platformAccountId: target.pageId, platformConversationId: "streak-group" };
      expect(await countRecentTerminalDmMessageConversationFailureStreak(testDb.db, input)).toBe(2);

      const plan = await explain(await captureStatement(() =>
        countRecentTerminalDmMessageConversationFailureStreak(testDb!.db, input)
      ));
      expect(plan).toContain("sync_http_attempts_dm_group_idx");
      // The defect this replaces: the thread's attempts found by reading the
      // whole 30-day attempt journal.
      expect(plan).not.toContain("Seq Scan on sync_http_attempts");
    },
    INTEGRATION_TEST_TIMEOUT_MS,
  );
});
