import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  appendDomainEvents,
  ensureDomainEventPartitions,
  listDomainEventAccountBounds,
} from "@agency_hub_core/db";

import { PgDialect } from "../packages/db/node_modules/drizzle-orm/pg-core/index.js";
import { startIntegrationTestDatabase, type StartedTestDatabase } from "./helpers/db.ts";

// listDomainEventAccountBounds feeds the v2 gap rule on every stream connect
// and resume. It reads the oldest retained account_seq as the first entry of
// each partition's (account_id, account_seq) index; the statement it replaced
// aggregated every event of the account. These cases pin the answers to the
// old statement's, including the shapes a plain fixture never reaches: the
// oldest row in an older partition than the newest, a counter whose events are
// all gone, no counter at all, and a detached partition.

/** The statement this function ran until 2026-10, kept as the oracle. */
const LEGACY_BOUNDS_SQL = `
  select s.account_id::text as account_id,
         (s.next_seq - 1)::text as current_seq,
         min(de.account_seq)::text as oldest_retained
  from domain_event_seq s
  left join domain_events de on de.account_id = s.account_id
  where s.account_id = any($1::bigint[])
  group by s.account_id, s.next_seq
`;

const ACCOUNT_SPREAD = 8101;
const ACCOUNT_EMPTIED = 8102;
const ACCOUNT_NO_COUNTER = 8103;
const ACCOUNT_NEIGHBOUR = 8104;

let harness: StartedTestDatabase;
let dedup = 0;

beforeAll(async () => {
  const started = await startIntegrationTestDatabase();
  if (!started) {
    throw new Error("Docker-backed Postgres is required for this integration test");
  }
  harness = started;
  await ensureDomainEventPartitions(harness.db, { now: new Date("2026-09-01T00:00:00.000Z"), monthsAhead: 2 });

  // seq 1 lands in 2026-10, seq 2 in 2025-03, seq 3 in 2026-09: the account's
  // oldest retained row, once seq 1 is pruned, sits in the OLDEST partition.
  await append(ACCOUNT_SPREAD, ["2026-10-05", "2025-03-01", "2026-09-10", "2026-10-06"]);
  await harness.pool.query("delete from domain_events where account_id = $1 and account_seq = 1", [ACCOUNT_SPREAD]);

  // A counter whose every event is gone (pruned or erased).
  await append(ACCOUNT_EMPTIED, ["2026-09-12", "2026-10-02"]);
  await harness.pool.query("delete from domain_events where account_id = $1", [ACCOUNT_EMPTIED]);

  // Rows of another account interleave with ACCOUNT_SPREAD's in every partition.
  await append(ACCOUNT_NEIGHBOUR, ["2025-02-01", "2026-09-11", "2026-10-07"]);
}, 120_000);

afterAll(async () => {
  await harness?.stop();
});

async function append(accountId: number, days: readonly string[]) {
  for (const day of days) {
    dedup += 1;
    await appendDomainEvents(harness.db, accountId, [{
      type: "message.created",
      occurredAt: new Date(`${day}T12:00:00.000Z`),
      data: { n: dedup },
      schemaVersion: 1,
      observationId: 0,
      dedupKey: `bounds-test:${dedup}`,
    }]);
  }
}

async function legacyBounds(accountIds: readonly number[]) {
  const result = await harness.pool.query<{ account_id: string; current_seq: string; oldest_retained: string | null }>(
    LEGACY_BOUNDS_SQL,
    [accountIds],
  );
  return new Map(result.rows.map((row) => [Number(row.account_id), {
    accountId: Number(row.account_id),
    oldestRetainedSeq: row.oldest_retained === null ? null : Number(row.oldest_retained),
    currentSeq: Number(row.current_seq),
  }]));
}

/** The public result for accounts the legacy statement saw (it returns no row
 * for an account without a counter; the function fills that one in). */
async function expectSameAsLegacy(accountIds: readonly number[]) {
  const bounds = await listDomainEventAccountBounds(harness.db, accountIds);
  const legacy = await legacyBounds(accountIds);
  for (const [accountId, row] of legacy) {
    expect(bounds.get(accountId), `account ${accountId}`).toEqual(row);
  }
  return bounds;
}

describe("listDomainEventAccountBounds", () => {
  it("returns an empty map for no accounts", async () => {
    expect(await listDomainEventAccountBounds(harness.db, [])).toEqual(new Map());
  });

  it("reads the oldest retained seq from an older partition than the newest row", async () => {
    const bounds = await expectSameAsLegacy([ACCOUNT_SPREAD]);
    expect(bounds.get(ACCOUNT_SPREAD)).toEqual({ accountId: ACCOUNT_SPREAD, oldestRetainedSeq: 2, currentSeq: 4 });
  });

  it("keeps the current seq and no oldest row for a counter whose events are all gone", async () => {
    const bounds = await expectSameAsLegacy([ACCOUNT_EMPTIED]);
    expect(bounds.get(ACCOUNT_EMPTIED)).toEqual({ accountId: ACCOUNT_EMPTIED, oldestRetainedSeq: null, currentSeq: 2 });
  });

  it("answers zero events for an account without a counter row", async () => {
    const bounds = await listDomainEventAccountBounds(harness.db, [ACCOUNT_NO_COUNTER]);
    expect(bounds.get(ACCOUNT_NO_COUNTER)).toEqual({ accountId: ACCOUNT_NO_COUNTER, oldestRetainedSeq: null, currentSeq: 0 });
  });

  it("answers several accounts in one call without mixing their rows", async () => {
    const accounts = [ACCOUNT_SPREAD, ACCOUNT_EMPTIED, ACCOUNT_NO_COUNTER, ACCOUNT_NEIGHBOUR];
    const bounds = await expectSameAsLegacy(accounts);
    expect([...bounds.keys()].sort()).toEqual([...accounts].sort());
    expect(bounds.get(ACCOUNT_NEIGHBOUR)).toEqual({ accountId: ACCOUNT_NEIGHBOUR, oldestRetainedSeq: 1, currentSeq: 3 });
    expect(bounds.get(ACCOUNT_SPREAD)?.oldestRetainedSeq).toBe(2);
  });

  it("ignores a detached partition, as the aggregate did", async () => {
    const holder = await harness.pool.query<{ partition: string; bound: string }>(`
      select de.tableoid::regclass::text as partition, pg_get_expr(c.relpartbound, c.oid) as bound
      from domain_events de
      join pg_class c on c.oid = de.tableoid
      where de.account_id = $1 and de.account_seq = 2
    `, [ACCOUNT_SPREAD]);
    const { partition, bound } = holder.rows[0]!;
    await harness.pool.query(`alter table domain_events detach partition ${partition}`);
    try {
      const bounds = await expectSameAsLegacy([ACCOUNT_SPREAD, ACCOUNT_NEIGHBOUR]);
      expect(bounds.get(ACCOUNT_SPREAD)).toEqual({ accountId: ACCOUNT_SPREAD, oldestRetainedSeq: 3, currentSeq: 4 });
    } finally {
      await harness.pool.query(`alter table domain_events attach partition ${partition} ${bound}`);
    }
    const restored = await expectSameAsLegacy([ACCOUNT_SPREAD]);
    expect(restored.get(ACCOUNT_SPREAD)?.oldestRetainedSeq).toBe(2);
  });

  it("plans the oldest row as an index probe per partition, not an aggregate over the account", async () => {
    // Render the function's own statement, then plan it with its parameters.
    const dialect = new PgDialect();
    const rendered: Array<{ sql: string; params: unknown[] }> = [];
    const capturing = {
      execute: async (query: Parameters<PgDialect["sqlToQuery"]>[0]) => {
        rendered.push(dialect.sqlToQuery(query));
        return { rows: [] };
      },
    };
    await listDomainEventAccountBounds(capturing as never, [ACCOUNT_SPREAD, ACCOUNT_NEIGHBOUR]);
    expect(rendered).toHaveLength(1);
    const plan = await harness.pool.query<{ "QUERY PLAN": unknown }>(
      `explain (format json) ${rendered[0]!.sql}`,
      rendered[0]!.params,
    );
    const text = JSON.stringify(plan.rows[0]!["QUERY PLAN"]);
    expect(text).toContain("\"Node Type\":\"Limit\"");
    expect(text).toContain("account_id_account_seq_idx");
    expect(text).not.toContain("\"Node Type\":\"Aggregate\"");
  });
});
