import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import type { AppContext } from "../apps/runtime/src/bootstrap.ts";
import { createUserAccount } from "../apps/runtime/src/services/auth.ts";
import { readShiftReportsFeed } from "../apps/runtime/src/services/shift-handins.ts";
import { startIntegrationTestDatabase, type StartedTestDatabase } from "./helpers/db.ts";
import { createTestAppContext } from "./helpers/runtime.ts";
import { fixtureUserId } from "./helpers/user-identity.ts";

// The ledger's feed of shift-report versions (review R2-b): a version that becomes visible late — its hand-in started
// earlier and wrote later, or its transaction committed after a later id's — is still served, never jumped over by the
// cursor. Two interleavings: A starts, B starts and inserts, A inserts; and A inserts in a transaction that commits
// after B's. Whatever is committed before a read and not served by it comes from a later read of `next`.

vi.mock("argon2", () => import("./helpers/cheap-argon2.ts"));

let testDb: StartedTestDatabase | null = null;
let app: AppContext;
let userId = 0;
let shiftNo = 0;

/** A submitted report of a fresh shift row: its handin id. */
async function handin(): Promise<number> {
  shiftNo += 1;
  const day = `2026-11-${String(shiftNo).padStart(2, "0")}`;
  const shift = await testDb!.pool.query(
    `insert into shifts (user_id, state, started_at, ended_at, worked_minutes, messages, report_date, pages)
     values ($1, 'closed', $2::timestamptz, $3::timestamptz, 60, 10, $4::date, '[]'::jsonb) returning id`,
    [userId, `${day}T10:00:00Z`, `${day}T11:00:00Z`, day],
  );
  const row = await testDb!.pool.query(
    `insert into shift_handins (shift_id, user_id, report_date, state, current_version, submitted_at)
     values ($1, $2, $3::date, 'submitted', 1, now()) returning id`,
    [shift.rows[0].id, userId, day],
  );
  return Number(row.rows[0].id);
}

/** One version, its hand-in having started `agoSeconds` before now (the service takes `submitted_at` at the start). */
const VERSION = `insert into shift_handin_versions (handin_id, version, submitted_at, door, actor_user_id, total_mills, rule_version)
  values ($1, 1, clock_timestamp() - make_interval(secs => $2), 'workboard', $3, 1000, 'test') returning id`;

async function feedFrom(since: string | undefined) {
  return readShiftReportsFeed(app, { pageIds: [], ...(since === undefined ? {} : { since }), limit: 100 });
}

describe("the ledger's feed under out-of-order commits", () => {
  beforeAll(async () => {
    testDb = await startIntegrationTestDatabase();
    if (!testDb) return;
    app = createTestAppContext(testDb);
    await createUserAccount(app, { username: "feeder", role: "chatter" }, { source: "cli" });
    userId = await fixtureUserId(app, "feeder");
  }, 180_000);

  afterAll(async () => {
    await testDb?.stop();
  });

  it("serves a version whose hand-in started first and wrote last (A starts, B starts and inserts, A inserts)", async (context) => {
    if (!testDb) return context.skip();
    const start = (await feedFrom(undefined)).next;
    const [handinA, handinB] = [await handin(), await handin()];
    // B wrote first: the smaller id, a hand-in 5 s old. A wrote second: the larger id, a hand-in begun 15 s ago.
    const b = Number((await testDb.pool.query(VERSION, [handinB, 5, userId])).rows[0].id);
    const a = Number((await testDb.pool.query(VERSION, [handinA, 15, userId])).rows[0].id);
    expect(b).toBeLessThan(a);
    const first = await feedFrom(start);

    // Time passes: B's hand-in is as old as A's now (the row's own clock moved by hand; versions are otherwise immutable).
    const client = await testDb.pool.connect();
    try {
      await client.query("set session_replication_role = replica");
      await client.query("update shift_handin_versions set submitted_at = clock_timestamp() - interval '15 seconds' where id = $1", [b]);
    } finally {
      await client.query("reset session_replication_role");
      client.release();
    }
    const second = await feedFrom(first.next);
    const served = [...first.reports, ...second.reports].map((one) => one.id);
    expect(served.sort((x, y) => x - y)).toEqual([b, a]);
  });

  it("serves a version whose transaction committed after a later id was served", async (context) => {
    if (!testDb) return context.skip();
    const start = (await feedFrom(undefined)).next;
    const [handinA, handinB] = [await handin(), await handin()];
    const slow = await testDb.pool.connect();
    try {
      // A inserts first (the smaller id) and keeps its transaction open (its hand-in's other work, a slow ledger call).
      await slow.query("begin");
      const a = Number((await slow.query(VERSION, [handinA, 15, userId])).rows[0].id);
      // B inserts after it and commits at once.
      const b = Number((await testDb.pool.query(VERSION, [handinB, 15, userId])).rows[0].id);
      expect(a).toBeLessThan(b);
      const first = await feedFrom(start);
      expect(first.reports.map((one) => one.id)).toEqual([b]);
      await slow.query("commit");
      const second = await feedFrom(first.next);
      expect(second.reports.map((one) => one.id)).toEqual([a]);
      // Nothing is served twice.
      expect((await feedFrom(second.next)).reports).toEqual([]);
    } finally {
      await slow.query("rollback").catch(() => undefined);
      slow.release();
    }
  });
});
