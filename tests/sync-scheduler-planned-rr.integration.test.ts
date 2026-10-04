import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import type { Database } from "@agency_hub_core/db";

import type { ApplyResult, ResourceModule } from "../apps/runtime/src/sync/engine/resource.ts";
import {
  resetIntegrationDatabase,
  startIntegrationTestDatabase,
  type StartedTestDatabase,
} from "./helpers/db.ts";
import {
  countRows,
  makeTestActor,
  pollsRequest,
  seedSyncPage,
  testRegistry,
  testSpec,
  waitFor,
} from "./helpers/sync-engine-host.ts";

// The planned class (plan §3, design §3.4, SK2): due polls first, by due
// time; then round robin BY RESOURCE KEY, so thousands of per-subject
// triggers can never starve a long walk. A test-only registry stands in for
// the real resources.

let testDb: StartedTestDatabase | null = null;

beforeAll(async () => {
  testDb = await startIntegrationTestDatabase();
}, 120_000);

afterAll(async () => {
  await testDb?.stop();
});

beforeEach(async () => {
  if (testDb) await resetIntegrationDatabase(testDb.pool);
});

function db(): Database {
  return testDb!.db as unknown as Database;
}

const CATCHUP = "dm-messages.catchup";
const MEDIA_WALK = "media-stats.walk";
const VAULT_WALK = "catalog.vault";
const POLL = "subscribers.poll";

function plannedRegistry() {
  const closes: ApplyResult = { work: { satisfiesRevision: true, close: "done" }, followups: [] };
  const walks = (): ResourceModule => {
    let step = 0;
    return {
      plan: async () => ({ kind: "request", request: pollsRequest }),
      // A long walk: one more page each step, never done in this test.
      apply: async () => ({ work: { satisfiesRevision: false, cursor: { step: ++step } }, followups: [] }),
    };
  };
  const once: ResourceModule = {
    plan: async () => ({ kind: "request", request: pollsRequest }),
    apply: async () => closes,
  };
  return testRegistry([
    testSpec(CATCHUP, once, { kind: "trigger", class: "planned" }),
    testSpec(MEDIA_WALK, walks(), { kind: "goal", class: "planned" }),
    testSpec(VAULT_WALK, walks(), { kind: "goal", class: "planned" }),
    testSpec(POLL, once, { kind: "poll", class: "planned", period: { everyMs: 3_600_000 } }),
  ]);
}

describe("the planned class", () => {
  it("6 000 triggers next to two walks: each walk is served in every 3 planned slots; a due poll goes first", async (context) => {
    if (!testDb) return context.skip();
    const { pageId } = await seedSyncPage({ db: db(), pool: testDb.pool }, { mode: "live", guard: "fansly_sync_engine" });
    await testDb.pool.query(`
      insert into sync_work (page_id, shadow, resource, subject, kind, class, due_at)
      select $1, false, $2, 'group-' || g, 'trigger', 'planned', clock_timestamp() - interval '1 minute'
        from generate_series(1, 6000) g`, [pageId, CATCHUP]);
    await testDb.pool.query(`
      insert into sync_work (page_id, shadow, resource, subject, kind, class, due_at) values
        ($1, false, $2, '', 'goal', 'planned', clock_timestamp()),
        ($1, false, $3, '', 'goal', 'planned', clock_timestamp()),
        ($1, false, $4, '', 'poll', 'planned', clock_timestamp() + interval '1 hour')`,
      [pageId, MEDIA_WALK, VAULT_WALK, POLL]);

    const { actor, stop, abort } = await makeTestActor({ db: db(), pageId, registry: plannedRegistry(), settingMs: 5 });
    const run = actor.run({ stop: stop.signal, abort: abort.signal });
    let pollDueAfterId = 0;
    try {
      await waitFor(async () => (await countRows(testDb!.pool, "select count(*)::int as n from sync_attempts") >= 24 ? true : null),
        30_000, "24 planned slots");
      // The poll becomes due: it is taken before any walk or trigger.
      const latest = await testDb.pool.query<{ id: string }>("select coalesce(max(id), 0)::text as id from sync_attempts");
      pollDueAfterId = Number(latest.rows[0]!.id);
      await testDb.pool.query("update sync_work set due_at = clock_timestamp() where resource = $1", [POLL]);
      await waitFor(async () => (await countRows(testDb!.pool, "select count(*)::int as n from sync_attempts") >= 48 ? true : null),
        30_000, "48 planned slots");
    } finally {
      stop.abort();
      await run;
    }

    const attempts = await testDb.pool.query<{ id: string; resource: string; class: string }>(
      "select a.id::text as id, a.resource, a.class from sync_attempts a order by a.id",
    );
    expect(new Set(attempts.rows.map((row) => row.class))).toEqual(new Set(["planned"]));
    // A due poll first: at most the one step already picked before it was due.
    const afterDue = attempts.rows.filter((row) => Number(row.id) > pollDueAfterId).slice(0, 2).map((row) => row.resource);
    expect(afterDue).toContain(POLL);
    expect(attempts.rows.filter((row) => row.resource === POLL)).toHaveLength(1);

    // Round robin by key: every window of three walk/trigger slots serves both walks.
    const sequence = attempts.rows.map((row) => row.resource).filter((resource) => resource !== POLL);
    for (let start = 0; start + 3 <= sequence.length; start += 1) {
      const window = sequence.slice(start, start + 3);
      expect(window, `slots ${start}..${start + 2}: ${window.join(", ")}`).toContain(MEDIA_WALK);
      expect(window, `slots ${start}..${start + 2}: ${window.join(", ")}`).toContain(VAULT_WALK);
    }
    const catchups = sequence.filter((resource) => resource === CATCHUP).length;
    expect(catchups).toBeGreaterThanOrEqual(Math.floor(sequence.length / 3) - 1);
    // The triggers keep their own share and close as they are served.
    expect(await countRows(testDb.pool, "select count(*)::int as n from sync_work where resource = $1 and state = 'done'", [CATCHUP]))
      .toBe(catchups);
  }, 60_000);
});
