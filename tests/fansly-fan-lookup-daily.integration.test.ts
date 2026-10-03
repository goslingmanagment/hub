// Owner decision 2026-09-30: Hub re-reads a fan's Fansly profile (username,
// display name, the creator's notes and custom name on the fan) at most once a
// day; a fan never looked up is looked up at once. The day is kept per page,
// because the notes a lookup returns belong to the page whose session asked.
//
// Before this rule every transactions page, subscribers page and follower
// fallback looked the same fans up again (about 540 account_lookup requests a
// day in prod). End to end against Postgres: the real journal, the real fan
// upserts and the per-page stamps; only the adapter is faked. (The legacy DM
// partner probe that shared the rule went with the legacy DM sweep at step 4,
// S4-14; the engine's fan-profiles resource asks the same once-a-day question.)

import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import {
  createFanslyPage,
  createModel,
  runWithPageSyncExecutionContext,
  startSyncRun,
} from "@agency_hub_core/db";
import type { FanslyAccount } from "@agency_hub_core/fansly";

import type { AppContext } from "../apps/runtime/src/bootstrap.ts";
import { lookupHydratedFans } from "../apps/runtime/src/services/sync/fan-hydration.ts";
import { upsertHydratedFansForPage } from "../apps/runtime/src/sync/fansly/lib/fan-hydration.ts";
import {
  resetIntegrationDatabase,
  startIntegrationTestDatabase,
  type StartedTestDatabase,
} from "./helpers/db.ts";
import { createTestAppContext } from "./helpers/runtime.ts";

let testDb: StartedTestDatabase | null = null;
let pageA = 0;
let pageB = 0;
let app: AppContext;
/** What Fansly answers for an id; an id missing here has no account. */
let served: Map<string, FanslyAccount>;
let lookups: string[][];

const requestContext = { session: { authorization: "synthetic-token" } } as never;

function account(id: string, alias?: string): FanslyAccount {
  return {
    id,
    username: `fan_${id}`,
    displayName: `Fan ${id}`,
    createdAt: 1_770_000_000_000,
    notes: alias === undefined ? [] : [{
      id: `note-${id}`,
      contentType: 12002,
      title: "Custom Username",
      note: alias,
      updatedAt: 1_775_000_000_000,
    }],
  };
}

beforeAll(async () => {
  testDb = await startIntegrationTestDatabase();
}, 120_000);

afterAll(async () => {
  await testDb?.stop();
});

beforeEach(async (context) => {
  if (!testDb) {
    context.skip();
    return;
  }
  await resetIntegrationDatabase(testDb.pool);
  const model = await createModel(testDb.db, { slug: "fan-lookup-daily", name: "Fan lookup daily" });
  pageA = (await createFanslyPage(testDb.db, { modelId: model!.id, label: "fan-lookup-daily-a" }))!.id;
  pageB = (await createFanslyPage(testDb.db, { modelId: model!.id, label: "fan-lookup-daily-b" }))!.id;
  served = new Map();
  lookups = [];
  app = createTestAppContext(testDb, {
    adapter: {
      async getAccountsByIdsPage(_context: unknown, ids: string[]) {
        lookups.push([...ids]);
        const parsed = ids.flatMap((id) => served.get(id) ?? []);
        return { parsed, raw: { success: true, response: parsed } };
      },
    } as unknown as AppContext["adapter"],
  });
});

async function inRun<T>(pageId: number, run: (syncRunId: number) => Promise<T>) {
  const syncRun = await startSyncRun(testDb!.db, { platformAccountId: pageId, stream: "transactions", trigger: "scheduled" });
  return runWithPageSyncExecutionContext(
    { pageId, stream: "transactions", requestSeq: 1, leaseToken: "fan-lookup-daily" },
    () => run(syncRun!.id),
  );
}

/** One page write the way the transactions lane does it: look up, then store. */
async function hydratePage(pageId: number, platformUserIds: string[]) {
  return inRun(pageId, async (syncRunId) => {
    const hydrated = await lookupHydratedFans(app, {
      requestContext,
      platformAccountId: pageId,
      platformUserIds,
      capture: { platformAccountId: pageId, syncRunId },
    });
    const fanMap = await upsertHydratedFansForPage(testDb!.db, {
      platformAccountId: pageId,
      accounts: hydrated.accounts,
      fallbackIds: hydrated.fallbackIds,
      reusedIds: hydrated.reusedIds,
      lookup: hydrated.lookup,
    });
    return { hydrated, fanMap };
  });
}

async function fan(platformUserId: string, pageId = pageA) {
  const rows = await testDb!.pool.query<{
    id: string;
    username: string | null;
    deleted: boolean;
    page_alias: string | null;
  }>(
    `select f.id::text, f.username, f.deleted_detected_at is not null as deleted, pf.page_alias
       from fans f
       left join page_fans pf on pf.fan_id = f.id and pf.platform_account_id = $2
      where f.platform = 'fansly' and f.platform_user_id = $1`,
    [platformUserId, pageId],
  );
  return rows.rows[0] ?? null;
}

async function journaledLookups(pageId: number) {
  const rows = await testDb!.pool.query<{ ids: string[] }>(
    `select request_params -> 'ids' as ids from sync_raw_payloads
      where page_id = $1 and endpoint = 'account_lookup' order by id`,
    [pageId],
  );
  return rows.rows.map((row) => row.ids);
}

/** Moves every stamp of a page a day and a minute into the past. */
async function ageStamps(pageId: number) {
  await testDb!.pool.query(
    `update page_fans
        set account_lookup_at = account_lookup_at - interval '1 day 1 minute'
      where platform_account_id = $1`,
    [pageId],
  );
}

describe("Fansly fan lookup at most once a day per page", () => {
  it("reuses a lookup under a day old, absent accounts included, and looks up new and never-looked-up fans at once", async () => {
    served.set("fan-1", account("fan-1", "Big Tipper"));
    served.set("fan-2", account("fan-2"));
    const first = await hydratePage(pageA, ["fan-1", "fan-2", "fan-gone"]);
    expect(lookups).toEqual([["fan-1", "fan-2", "fan-gone"]]);
    expect(await fan("fan-1")).toMatchObject({ username: "fan_fan-1", deleted: false, page_alias: "Big Tipper" });
    expect(await fan("fan-gone")).toMatchObject({ username: null, deleted: true });

    // Another lane linked fan-3 to the page without a lookup (a DM partner
    // from the sweep's own aggregation): it was never looked up here.
    await upsertHydratedFansForPage(testDb!.db, { platformAccountId: pageA, accounts: [], unverifiedIds: ["fan-3"] });
    served.set("fan-3", account("fan-3"));
    served.set("fan-new", account("fan-new"));
    // Changed in Fansly after the first read: reaches Hub a day later.
    served.set("fan-1", { ...account("fan-1", "Whale"), username: "renamed" });
    served.set("fan-gone", account("fan-gone"));

    const second = await hydratePage(pageA, ["fan-1", "fan-gone", "fan-3", "fan-new", "fan-1"]);
    expect(lookups).toEqual([["fan-1", "fan-2", "fan-gone"], ["fan-3", "fan-new"]]);
    expect(second.hydrated.reusedIds).toEqual(["fan-1", "fan-gone"]);
    // A reused id still maps to its stored fan row, and nothing about it is
    // inferred: same name, same alias, still deleted.
    expect(second.fanMap.get("fan-1")).toBe(first.fanMap.get("fan-1"));
    expect(second.fanMap.get("fan-gone")).toBe(first.fanMap.get("fan-gone"));
    expect(await fan("fan-1")).toMatchObject({ username: "fan_fan-1", page_alias: "Big Tipper" });
    expect(await fan("fan-gone")).toMatchObject({ deleted: true });
    expect(await fan("fan-3")).toMatchObject({ username: "fan_fan-3" });
    expect(await fan("fan-new")).toMatchObject({ username: "fan_fan-new" });

    // Every request actually sent is journaled; a reused id sends nothing.
    expect(await journaledLookups(pageA)).toEqual([["fan-1", "fan-2", "fan-gone"], ["fan-3", "fan-new"]]);

    // A page of reused ids only sends no request at all.
    const third = await hydratePage(pageA, ["fan-2", "fan-3"]);
    expect(lookups).toHaveLength(2);
    expect(third.hydrated.lookup).toBeNull();
    expect([...third.fanMap.keys()].sort()).toEqual(["fan-2", "fan-3"]);

    // A day later the same fans are read again, and the edits arrive.
    await ageStamps(pageA);
    await hydratePage(pageA, ["fan-1", "fan-gone"]);
    expect(lookups.at(-1)).toEqual(["fan-1", "fan-gone"]);
    expect(await fan("fan-1")).toMatchObject({ username: "renamed", page_alias: "Whale" });
    expect(await fan("fan-gone")).toMatchObject({ username: "fan_fan-gone", deleted: false });
  });

  it("keeps the day per page: a fan looked up through one page is looked up through another", async () => {
    served.set("fan-1", account("fan-1", "Alias on A"));
    await hydratePage(pageA, ["fan-1"]);
    served.set("fan-1", account("fan-1", "Alias on B"));
    await hydratePage(pageB, ["fan-1"]);
    await hydratePage(pageA, ["fan-1"]);
    await hydratePage(pageB, ["fan-1"]);

    expect(lookups).toEqual([["fan-1"], ["fan-1"]]);
    expect(await fan("fan-1", pageA)).toMatchObject({ page_alias: "Alias on A" });
    expect(await fan("fan-1", pageB)).toMatchObject({ page_alias: "Alias on B" });
  });

  it("does not remember a lookup whose page write rolled back", async () => {
    served.set("fan-1", account("fan-1"));
    await inRun(pageA, async (syncRunId) => {
      const hydrated = await lookupHydratedFans(app, {
        requestContext,
        platformAccountId: pageA,
        platformUserIds: ["fan-1"],
        capture: { platformAccountId: pageA, syncRunId },
      });
      await expect(testDb!.db.transaction(async (tx) => {
        await upsertHydratedFansForPage(tx, { platformAccountId: pageA, ...hydrated });
        throw new Error("page write failed");
      })).rejects.toThrow("page write failed");
    });

    await hydratePage(pageA, ["fan-1"]);
    expect(lookups).toEqual([["fan-1"], ["fan-1"]]);
    // The failed page's lookup was still journaled: it was made.
    expect(await journaledLookups(pageA)).toEqual([["fan-1"], ["fan-1"]]);
  });
});
