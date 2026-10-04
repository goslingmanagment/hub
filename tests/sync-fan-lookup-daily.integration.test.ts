// Owner decision 2026-09-30: Hub re-reads a fan's Fansly profile (username,
// display name, the creator's notes and custom name on the fan) at most once a
// day; a fan never looked up is looked up at once. The day is kept per page,
// because the notes a lookup returns belong to the page whose session asked.
//
// The rule on the Sync Engine, through the real actor and commits against
// Postgres; only the transport is scripted. An apply that meets fans (here
// `subscribers.poll`) splits them with `partitionLookupIds`: the ones looked
// up through the page within the day keep their stored row, the rest are asked
// of `fan-profiles.lookup`. The walk splits its ids again at every step, sends
// `/account?ids=` for what is due, and stamps `page_fans.account_lookup_at` in
// the transaction that stores the answer. (The legacy lanes' test of the rule
// went with them at step 4, S4-18.)

import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { ensurePollRows, getSyncPage, upsertDemand, type Database } from "@agency_hub_core/db";
import type { FanslyAccount, FanslyWireOutcome, FanslyWireRequest } from "@agency_hub_core/fansly";

import { SyncCrashFault } from "../apps/runtime/src/sync/engine/commit.ts";
import {
  createEngineRegistry,
  demandToUpsert,
  pollsFor,
  type EngineRegistry,
  type ResourceModule,
} from "../apps/runtime/src/sync/engine/resource.ts";
import { upsertHydratedFansForPage } from "../apps/runtime/src/sync/fansly/lib/fan-hydration.ts";
import { FANSLY_RESOURCE_SPECS } from "../apps/runtime/src/sync/fansly/registry.ts";
import {
  FAN_PROFILES_LOOKUP_KEY,
  lookupFollowups,
  partitionLookupIds,
} from "../apps/runtime/src/sync/fansly/resources/fan-profiles.ts";
import {
  resetIntegrationDatabase,
  startIntegrationTestDatabase,
  type StartedTestDatabase,
} from "./helpers/db.ts";
import {
  countRows,
  makeTestActor,
  okResponse,
  ScriptedLiveTransport,
  seedSyncPage,
  waitFor,
} from "./helpers/sync-engine-host.ts";

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

// The walk asks for its due ids in id order.
const FAN_1 = "710000000000000001";
const FAN_2 = "710000000000000002";
const FAN_3 = "710000000000000003";
const FAN_GONE = "710000000000000004";
const FAN_NEW = "710000000000000005";

const DAY_MS = 24 * 60 * 60_000;
const SUBSCRIBERS_POLL_KEY = "subscribers.poll";

function account(id: string, alias?: string): FanslyAccount {
  return {
    id,
    username: `fan_${id.slice(-2)}`,
    displayName: `Fan ${id.slice(-2)}`,
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

function subscription(pageId: number, subscriberId: string) {
  return {
    id: `sub-${pageId}-${subscriberId}`,
    historyId: `h-${pageId}-${subscriberId}`,
    subscriberId,
    subscriptionTierId: "tier",
    subscriptionTierName: "Tier",
    subscriptionTierColor: "#fff",
    planId: "plan",
    status: 3,
    price: 9990,
    renewPrice: 9990,
    autoRenew: 1,
    billingCycle: 30,
    duration: 30,
    renewDate: Date.now() + 86_400_000,
    createdAt: Date.now() - 86_400_000,
    updatedAt: Date.now() - 3_600_000,
    endsAt: Date.now() + 86_400_000,
  };
}

/** A live page and what Fansly serves its session. */
interface LivePage {
  pageId: number;
  registry: EngineRegistry;
  /** The active subscribers `/subscribers` serves. */
  subscribers: string[];
  /** What `/account?ids=` answers for an id; an id missing here has no account. */
  accounts: Map<string, FanslyAccount>;
  /** The ids of every `/account?ids=` request that reached Fansly, in order. */
  lookups: string[][];
}

/** A live page on the real registry, its standing polls parked far ahead: only
 *  the work a test makes due runs. */
async function seedLivePage(): Promise<LivePage> {
  const { pageId } = await seedSyncPage({ db: db(), pool: testDb!.pool }, { mode: "live", guard: "fansly_sync_engine" });
  // The subscribers walk starts only on `/account/me` counters read within 2 h.
  await testDb!.pool.query("update pages set last_verified_at = clock_timestamp() - interval '1 minute' where id = $1", [pageId]);
  const registry = createEngineRegistry(FANSLY_RESOURCE_SPECS);
  const syncPage = await getSyncPage(db(), pageId);
  await ensurePollRows(db(), {
    pageId,
    shadow: false,
    polls: pollsFor(registry, syncPage!, false).map((poll) => ({ ...poll, phase: 0.999 })),
  });
  return { pageId, registry, subscribers: [], accounts: new Map(), lookups: [] };
}

function answer(page: LivePage, req: FanslyWireRequest): FanslyWireOutcome {
  if (req.spec === "subscribers.page") {
    const subscriptions = page.subscribers.map((id) => subscription(page.pageId, id));
    const total = subscriptions.length;
    return okResponse({ stats: { totalActive: total, totalExpired: 0, total }, subscriptions });
  }
  if (req.spec === "accounts.by_ids") {
    const ids = (new URL(req.url).searchParams.get("ids") ?? "").split(",");
    page.lookups.push(ids);
    return okResponse(ids.flatMap((id) => page.accounts.get(id) ?? []));
  }
  throw new Error(`unexpected ${req.spec}`);
}

/** An owner of the page: a new generation each time, as after a restart. */
async function startActor(page: LivePage, registry: EngineRegistry = page.registry) {
  const transport = new ScriptedLiveTransport();
  transport.respond = (req) => answer(page, req);
  const { actor, stop, abort } = await makeTestActor({ db: db(), pageId: page.pageId, mode: "live", registry, transport });
  return { run: actor.run({ stop: stop.signal, abort: abort.signal }), stop };
}

async function runUntil(page: LivePage, settled: () => Promise<boolean>) {
  const { run, stop } = await startActor(page);
  try {
    await waitFor(async () => ((await settled()) ? true : null), 30_000, "the page's work to settle");
  } finally {
    stop.abort();
    await run;
  }
}

function appliedAttempts(pageId: number, resource: string): Promise<number> {
  return countRows(
    testDb!.pool,
    "select count(*)::int as n from sync_attempts where page_id = $1 and resource = $2 and apply_state = 'applied'",
    [pageId, resource],
  );
}

/** Lookup walks of the page that are not closed. */
function pendingLookupWalks(pageId: number): Promise<number> {
  return countRows(
    testDb!.pool,
    "select count(*)::int as n from sync_work where page_id = $1 and resource = $2 and state in ('open', 'running')",
    [pageId, FAN_PROFILES_LOOKUP_KEY],
  );
}

async function lookupWalks(pageId: number) {
  const rows = await testDb!.pool.query<{ state: string; close_reason: string | null }>(
    "select state, close_reason from sync_work where page_id = $1 and resource = $2 order by id",
    [pageId, FAN_PROFILES_LOOKUP_KEY],
  );
  return rows.rows;
}

async function lookupAttempts(pageId: number) {
  const rows = await testDb!.pool.query<{ outcome: string; apply_state: string }>(
    "select outcome, apply_state from sync_attempts where page_id = $1 and resource = $2 order by id",
    [pageId, FAN_PROFILES_LOOKUP_KEY],
  );
  return rows.rows;
}

/** `/account?ids=` answers in the journal: every request that got one. */
function journaledLookups(pageId: number): Promise<number> {
  return countRows(
    testDb!.pool,
    "select count(*)::int as n from observations where account_id = $1 and kind = 'account_lookup'",
    [pageId],
  );
}

async function makeSubscribersPollDue(page: LivePage) {
  const spec = page.registry.spec(SUBSCRIBERS_POLL_KEY)!;
  await upsertDemand(db(), { pageId: page.pageId, shadow: false, resource: spec.key, kind: spec.kind, class: spec.class });
}

/** One read of the page's subscribers: the poll's apply, then the lookup walk
 *  it asked, if it asked one. The ask commits with the poll's apply. */
async function readSubscribers(page: LivePage, subscriberIds: readonly string[]) {
  page.subscribers = [...subscriberIds];
  const before = await appliedAttempts(page.pageId, SUBSCRIBERS_POLL_KEY);
  await makeSubscribersPollDue(page);
  await runUntil(page, async () =>
    (await appliedAttempts(page.pageId, SUBSCRIBERS_POLL_KEY)) === before + 1 && (await pendingLookupWalks(page.pageId)) === 0);
}

/** Ask the lookup walk for these fans the way an apply's follow-up reaches it,
 *  and let the walk close. */
async function askLookupWalk(page: LivePage, ids: readonly string[]) {
  const [signal] = lookupFollowups(ids, "test");
  const upsert = demandToUpsert(signal!, page.registry.spec(FAN_PROFILES_LOOKUP_KEY)!, {
    pageId: page.pageId,
    shadow: false,
    now: new Date(),
  });
  await upsertDemand(db(), upsert!);
  await runUntil(page, async () => (await pendingLookupWalks(page.pageId)) === 0);
}

async function fan(page: LivePage, platformUserId: string) {
  const rows = await testDb!.pool.query<{
    username: string | null;
    deleted: boolean;
    page_alias: string | null;
    looked_up: boolean;
  }>(
    `select f.username, f.deleted_detected_at is not null as deleted, pf.page_alias,
            pf.account_lookup_at is not null as looked_up
       from fans f
       left join page_fans pf on pf.fan_id = f.id and pf.platform_account_id = $2
      where f.platform = 'fansly' and f.platform_user_id = $1`,
    [platformUserId, page.pageId],
  );
  return rows.rows[0] ?? null;
}

async function currentSubscribers(page: LivePage): Promise<string[]> {
  const rows = await testDb!.pool.query<{ id: string }>(
    `select f.platform_user_id as id
       from page_subscriptions s
       join fans f on f.id = s.fan_id
      where s.platform_account_id = $1 and s.is_current
      order by 1`,
    [page.pageId],
  );
  return rows.rows.map((row) => row.id);
}

/** Moves every lookup stamp of a page into the past. */
async function ageStamps(page: LivePage, by: string) {
  await testDb!.pool.query(
    "update page_fans set account_lookup_at = account_lookup_at - $2::interval where platform_account_id = $1",
    [page.pageId, by],
  );
}

describe("a fan's Fansly profile is looked up at most once a day per page", () => {
  it("reuses a lookup under a day old, absent accounts included, and looks up new and never-looked-up fans at once", async (context) => {
    if (!testDb) return context.skip();
    const page = await seedLivePage();
    page.accounts.set(FAN_1, account(FAN_1, "Big Tipper"));
    page.accounts.set(FAN_2, account(FAN_2));
    await readSubscribers(page, [FAN_1, FAN_2, FAN_GONE]);
    expect(page.lookups).toEqual([[FAN_1, FAN_2, FAN_GONE]]);
    expect(await fan(page, FAN_1)).toEqual({ username: "fan_01", deleted: false, page_alias: "Big Tipper", looked_up: true });
    // No account came back: deletion evidence, and a lookup like any other.
    expect(await fan(page, FAN_GONE)).toEqual({ username: null, deleted: true, page_alias: null, looked_up: true });

    // Another apply linked FAN_3 to the page without a lookup (a DM partner
    // the conversation list served without its account): never looked up here.
    await upsertHydratedFansForPage(db(), { platformAccountId: page.pageId, accounts: [], unverifiedIds: [FAN_3] });
    page.accounts.set(FAN_3, account(FAN_3));
    page.accounts.set(FAN_NEW, account(FAN_NEW));
    // Changed in Fansly after the first read: reaches Hub a day later.
    page.accounts.set(FAN_1, { ...account(FAN_1, "Whale"), username: "renamed" });
    page.accounts.set(FAN_GONE, account(FAN_GONE));

    await readSubscribers(page, [FAN_1, FAN_GONE, FAN_3, FAN_NEW]);
    expect(page.lookups).toEqual([[FAN_1, FAN_2, FAN_GONE], [FAN_3, FAN_NEW]]);
    // A reused fan still maps to its stored row (its subscription is stored),
    // and nothing about it is inferred: same name, same alias, still deleted.
    expect(await currentSubscribers(page)).toEqual([FAN_1, FAN_3, FAN_GONE, FAN_NEW]);
    expect(await fan(page, FAN_1)).toMatchObject({ username: "fan_01", page_alias: "Big Tipper" });
    expect(await fan(page, FAN_GONE)).toMatchObject({ username: null, deleted: true });
    expect(await fan(page, FAN_3)).toMatchObject({ username: "fan_03", looked_up: true });
    expect(await fan(page, FAN_NEW)).toMatchObject({ username: "fan_05", looked_up: true });

    // A page of reused fans only asks the walk for nothing: no work, no request.
    await readSubscribers(page, [FAN_2, FAN_3]);
    expect(await currentSubscribers(page)).toEqual([FAN_2, FAN_3]);
    expect(page.lookups).toHaveLength(2);
    expect(await lookupWalks(page.pageId)).toHaveLength(2);

    // 23 hours on, the lookups are still under a day old.
    await ageStamps(page, "23 hours");
    await readSubscribers(page, [FAN_1, FAN_GONE]);
    expect(page.lookups).toHaveLength(2);

    // A day after the lookup the same fans are read again, and the edits arrive.
    await ageStamps(page, "1 hour 1 minute");
    await readSubscribers(page, [FAN_1, FAN_GONE]);
    expect(page.lookups).toEqual([[FAN_1, FAN_2, FAN_GONE], [FAN_3, FAN_NEW], [FAN_1, FAN_GONE]]);
    expect(await fan(page, FAN_1)).toMatchObject({ username: "renamed", page_alias: "Whale" });
    expect(await fan(page, FAN_GONE)).toMatchObject({ username: "fan_04", deleted: false });

    // Every request sent is journaled; a reused fan sends nothing.
    expect(await journaledLookups(page.pageId)).toBe(3);
  });

  it("keeps the day per page: a fan looked up through one page is looked up through another", async (context) => {
    if (!testDb) return context.skip();
    const pageA = await seedLivePage();
    const pageB = await seedLivePage();
    pageA.accounts.set(FAN_1, account(FAN_1, "Alias on A"));
    pageB.accounts.set(FAN_1, account(FAN_1, "Alias on B"));
    await readSubscribers(pageA, [FAN_1]);
    await readSubscribers(pageB, [FAN_1]);
    await readSubscribers(pageA, [FAN_1]);
    await readSubscribers(pageB, [FAN_1]);

    expect(pageA.lookups).toEqual([[FAN_1]]);
    expect(pageB.lookups).toEqual([[FAN_1]]);
    expect(await fan(pageA, FAN_1)).toMatchObject({ page_alias: "Alias on A", looked_up: true });
    expect(await fan(pageB, FAN_1)).toMatchObject({ page_alias: "Alias on B", looked_up: true });

    // The day runs out per page too: A's lookup is a day old, B's is not.
    await ageStamps(pageA, "1 day 1 minute");
    await readSubscribers(pageA, [FAN_1]);
    await readSubscribers(pageB, [FAN_1]);
    expect(pageA.lookups).toEqual([[FAN_1], [FAN_1]]);
    expect(pageB.lookups).toEqual([[FAN_1]]);
  });

  it("does not remember a lookup whose apply rolled back", async (context) => {
    if (!testDb) return context.skip();
    const page = await seedLivePage();
    page.accounts.set(FAN_1, account(FAN_1, "Big Tipper"));
    page.subscribers = [FAN_1];
    await makeSubscribersPollDue(page);

    // The process dies inside the lookup's apply: after the resource's own
    // writes (the profile, the notes, the stamp), before the commit.
    const lookup = await page.registry.module(FAN_PROFILES_LOOKUP_KEY);
    let insideTheApply: { fresh: string[]; due: string[] } | null = null;
    const dying = createEngineRegistry(FANSLY_RESOURCE_SPECS.map((spec) => (spec.key !== FAN_PROFILES_LOOKUP_KEY ? spec : {
      ...spec,
      module: async (): Promise<ResourceModule> => ({
        ...lookup,
        async apply(tx, input) {
          await lookup.apply(tx, input);
          insideTheApply = await partitionLookupIds(tx, { pageId: input.pageId, ids: [FAN_1], now: input.now });
          throw new SyncCrashFault("in_apply");
        },
      }),
    })));
    await expect((await startActor(page, dying)).run).rejects.toBeInstanceOf(SyncCrashFault);

    // The lookup was made and journaled. Inside its transaction the fan read
    // as looked up; the rollback took the stamp with the profile.
    expect(page.lookups).toEqual([[FAN_1]]);
    expect(await journaledLookups(page.pageId)).toBe(1);
    expect(await lookupAttempts(page.pageId)).toEqual([{ outcome: "response", apply_state: "captured" }]);
    expect(insideTheApply).toEqual({ fresh: [FAN_1], due: [] });
    expect(await fan(page, FAN_1)).toEqual({ username: null, deleted: false, page_alias: null, looked_up: false });
    expect(await partitionLookupIds(db(), { pageId: page.pageId, ids: [FAN_1], now: new Date() }))
      .toEqual({ fresh: [], due: [FAN_1] });

    // The next owner stores the journaled answer without asking Fansly again;
    // only then is the lookup remembered.
    await runUntil(page, async () => (await pendingLookupWalks(page.pageId)) === 0);
    expect(page.lookups).toEqual([[FAN_1]]);
    expect(await lookupAttempts(page.pageId)).toEqual([{ outcome: "response", apply_state: "applied" }]);
    expect(await fan(page, FAN_1)).toEqual({ username: "fan_01", deleted: false, page_alias: "Big Tipper", looked_up: true });
    expect(await partitionLookupIds(db(), { pageId: page.pageId, ids: [FAN_1], now: new Date() }))
      .toEqual({ fresh: [FAN_1], due: [] });
  });

  it("the walk sends only what is due at its step, and the day is 24 hours from the stored lookup", async (context) => {
    if (!testDb) return context.skip();
    const page = await seedLivePage();
    page.accounts.set(FAN_1, account(FAN_1));
    page.accounts.set(FAN_2, account(FAN_2));
    await askLookupWalk(page, [FAN_1]);
    expect(page.lookups).toEqual([[FAN_1]]);

    // Whoever asks, and whenever: a fan that is fresh when the walk plans its
    // step is not sent.
    await askLookupWalk(page, [FAN_1, FAN_2]);
    expect(page.lookups).toEqual([[FAN_1], [FAN_2]]);
    // Nothing due: the walk closes without a request.
    await askLookupWalk(page, [FAN_2, FAN_1]);
    expect(page.lookups).toHaveLength(2);
    expect(await lookupWalks(page.pageId)).toEqual([
      { state: "done", close_reason: "profiles_fresh" },
      { state: "done", close_reason: "profiles_fresh" },
      { state: "done", close_reason: "profiles_fresh" },
    ]);
    expect(await lookupAttempts(page.pageId)).toHaveLength(2);

    // The day, from the stamp the apply stored: a millisecond short of 24 h is
    // reused, a millisecond past is due — like a fan with no stamp at all.
    const stamp = await testDb.pool.query<{ at: Date }>(
      `select pf.account_lookup_at as at
         from page_fans pf
         join fans f on f.id = pf.fan_id
        where pf.platform_account_id = $1 and f.platform_user_id = $2`,
      [page.pageId, FAN_1],
    );
    const lookedUpAt = stamp.rows[0]!.at.getTime();
    expect(await partitionLookupIds(db(), { pageId: page.pageId, ids: [FAN_1, FAN_3], now: new Date(lookedUpAt + DAY_MS - 1) }))
      .toEqual({ fresh: [FAN_1], due: [FAN_3] });
    expect(await partitionLookupIds(db(), { pageId: page.pageId, ids: [FAN_1, FAN_3], now: new Date(lookedUpAt + DAY_MS + 1) }))
      .toEqual({ fresh: [], due: [FAN_1, FAN_3] });
  });
});
