import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import {
  ensurePollRows,
  getSyncPage,
  upsertDemand,
  upsertFans,
  upsertPageDmConversation,
  type Database,
} from "@agency_hub_core/db";
import type { FanslyWireOutcome, FanslyWireRequest } from "@agency_hub_core/fansly";

import { createEngineRegistry, pollsFor, type EngineRegistry } from "../apps/runtime/src/sync/engine/resource.ts";
import { FANSLY_RESOURCE_SPECS, fanslyResourceSpec } from "../apps/runtime/src/sync/fansly/registry.ts";
import {
  resetIntegrationDatabase,
  startIntegrationTestDatabase,
  type StartedTestDatabase,
} from "./helpers/db.ts";
import {
  countRows,
  makeTestActor,
  okResponse,
  RecordingAlerts,
  RecordingMetrics,
  ScriptedLiveTransport,
  seedSyncPage,
  waitFor,
} from "./helpers/sync-engine-host.ts";

// The audience resources of the Fansly Sync Engine (design §5.1, §5.11–§5.13)
// through the real actor and commits against a real database: a scripted
// live transport answers each wire route. What is pinned: the legacy writes
// (pages, subscriptions, follows, fans, lookups, probes) land in the apply
// transaction; every walk keeps its position in its work row; the refusals the
// legacy chunks threw are outcomes (restart, refused, quarantine) that never
// retry by themselves.

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

const OWN_ID = "300000000000000001";
const FOLLOW_EPOCH_MS = 1561494359900;

function followId(at: Date, sequence = 0): string {
  return ((BigInt(at.getTime() - FOLLOW_EPOCH_MS) << 22n) + BigInt(sequence)).toString();
}

function accountMe(id: string, counts: { followCount?: number; subscriberCount?: number } = {}) {
  return {
    account: {
      id,
      username: "model",
      displayName: "Model",
      createdAt: Date.UTC(2024, 0, 1),
      followCount: counts.followCount ?? 0,
      subscriberCount: counts.subscriberCount ?? 0,
      earningsWallet: { id: "wallet", balance: 1234 },
      walls: [],
      subscriptionTiers: [],
      email: "model@example.invalid",
    },
  };
}

function subscription(id: string, subscriberId: string, overrides: Record<string, unknown> = {}) {
  return {
    id,
    historyId: `h-${id}`,
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
    ...overrides,
  };
}

function subscribersPage(items: unknown[], totalActive: number) {
  return { stats: { totalActive, totalExpired: 0, total: totalActive }, subscriptions: items };
}

function fanAccount(id: string, extra: Record<string, unknown> = {}) {
  return { id, username: `fan${id.slice(-4)}`, displayName: `Fan ${id.slice(-4)}`, createdAt: Date.UTC(2025, 0, 1), ...extra };
}

/** A registry of every Fansly entry whose standing polls are parked far ahead,
 *  so only the work a test makes due runs. */
async function quietRegistry(pageId: number): Promise<EngineRegistry> {
  const registry = createEngineRegistry(FANSLY_RESOURCE_SPECS);
  const page = await getSyncPage(db(), pageId);
  await ensurePollRows(db(), {
    pageId,
    polls: pollsFor(registry, page!).map((poll) => ({ ...poll, phase: 0.999 })),
  });
  return registry;
}

async function makeDue(pageId: number, resource: string, extra: { subject?: string; reason?: string; params?: unknown } = {}) {
  const spec = fanslyResourceSpec(resource)!;
  await upsertDemand(db(), {
    pageId,
    resource,
    kind: spec.kind,
    class: spec.class,
    ...(extra.subject === undefined ? {} : { subject: extra.subject }),
    ...(extra.reason === undefined ? {} : { demand: { reasons: [extra.reason] } }),
    ...(extra.params === undefined ? {} : { params: extra.params }),
  });
}

async function seedPage(
  facts: { followerCount?: number | null; subscriberCount?: number; verifiedAgoMs?: number; externalId?: string | null } = {},
) {
  const { pageId } = await seedSyncPage({ db: db(), pool: testDb!.pool }, { mode: "live", guard: "fansly_sync_engine" });
  await testDb!.pool.query(
    `update pages set external_page_id = $2, follower_count = $3, subscriber_count = $4,
            last_verified_at = clock_timestamp() - $5::double precision * interval '1 millisecond'
      where id = $1`,
    [pageId, facts.externalId === undefined ? OWN_ID : facts.externalId, facts.followerCount === undefined ? 0 : facts.followerCount,
      facts.subscriberCount ?? 0, facts.verifiedAgoMs ?? 60_000],
  );
  return pageId;
}

function requestParam(req: FanslyWireRequest, name: string): string | null {
  return new URL(req.url).searchParams.get(name);
}

type Responder = (req: FanslyWireRequest) => FanslyWireOutcome;

async function runLive(
  pageId: number,
  respond: Responder,
  until: () => Promise<boolean>,
  options: { alerts?: RecordingAlerts; metrics?: RecordingMetrics } = {},
) {
  const registry = await quietRegistry(pageId);
  return { registry, ...(await drive(pageId, registry, respond, until, options)) };
}

async function drive(
  pageId: number,
  registry: EngineRegistry,
  respond: Responder,
  until: () => Promise<boolean>,
  options: { alerts?: RecordingAlerts; metrics?: RecordingMetrics } = {},
) {
  const transport = new ScriptedLiveTransport();
  transport.respond = (req) => respond(req);
  const alerts = options.alerts ?? new RecordingAlerts();
  const metrics = options.metrics ?? new RecordingMetrics();
  const { actor, stop, abort } = await makeTestActor({
    db: db(),
    pageId,
    registry,
    alerts,
    metrics,
    transport,
  });
  const run = actor.run({ stop: stop.signal, abort: abort.signal });
  try {
    await waitFor(async () => ((await until()) ? true : null), 30_000, "the work to settle");
  } finally {
    stop.abort();
    await run;
  }
  return { hits: transport.hits.map((hit) => hit.spec), alerts, metrics };
}

async function workRow(pageId: number, resource: string) {
  const result = await testDb!.pool.query<{
    state: string; cursor: Record<string, unknown>; proof: Record<string, unknown> | null; result: Record<string, unknown> | null;
    waiting_reason: string | null; due_at: Date; params: Record<string, unknown>; last_error_class: string | null;
  }>(
    `select state, cursor, proof, result, waiting_reason, due_at, params, last_error_class from sync_work
      where page_id = $1 and resource = $2 and not shadow order by id desc limit 1`,
    [pageId, resource],
  );
  return result.rows[0] ?? null;
}

async function appliedAttempts(pageId: number, resource: string): Promise<number> {
  return countRows(testDb!.pool, "select count(*)::int as n from sync_attempts where page_id = $1 and resource = $2 and apply_state = 'applied'", [pageId, resource]);
}

describe("account.poll", () => {
  it("writes the page's identity, counters and light timestamp, and records the identity", async (context) => {
    if (!testDb) return context.skip();
    const pageId = await seedPage({ externalId: null, verifiedAgoMs: 5 * 3_600_000 });
    await makeDue(pageId, "account.poll");
    const { hits } = await runLive(pageId, () => okResponse(accountMe(OWN_ID, { followCount: 42, subscriberCount: 7 })),
      async () => (await appliedAttempts(pageId, "account.poll")) === 1);

    expect(hits).toEqual(["account.me"]);
    const page = await testDb.pool.query(
      `select external_page_id, follower_count, subscriber_count, earnings_balance_mills::text as balance,
              last_verified_at > clock_timestamp() - interval '1 minute' as verified,
              last_light_sync_at is not null as light, metadata ->> 'accountCreatedAt' as created
         from pages where id = $1`,
      [pageId],
    );
    expect(page.rows[0]).toEqual({
      external_page_id: OWN_ID, follower_count: 42, subscriber_count: 7, balance: "1234",
      verified: true, light: true, created: "2024-01-01T00:00:00.000Z",
    });
    const sync = await testDb.pool.query("select identity_account_id, identity_checked_at is not null as checked from sync_pages where page_id = $1", [pageId]);
    expect(sync.rows[0]).toEqual({ identity_account_id: OWN_ID, checked: true });
    const observation = await testDb.pool.query("select kind, producer, source from observations where account_id = $1", [pageId]);
    expect(observation.rows).toEqual([{ kind: "account_me", producer: "fansly-sync:account.poll", source: "pull" }]);
    // A poll stays the page's standing row, due again after its period.
    const work = await workRow(pageId, "account.poll");
    expect(work!.state).toBe("open");
    expect(work!.due_at.getTime() - Date.now()).toBeGreaterThan(50 * 60_000);
  });

  it("an answer for another account holds the page and quarantines the step", async (context) => {
    if (!testDb) return context.skip();
    const pageId = await seedPage();
    await makeDue(pageId, "account.poll");
    const alerts = new RecordingAlerts();
    await runLive(pageId, () => okResponse(accountMe("399999999999999999")),
      async () => (await workRow(pageId, "account.poll"))?.state === "quarantined", { alerts });

    const holds = await testDb.pool.query(
      "select kind, until = 'infinity'::timestamptz as indefinite from sync_holds where page_id = $1 and scope = 'page'", [pageId]);
    expect(holds.rows).toEqual([{ kind: "identity_mismatch", indefinite: true }]);
    const page = await testDb.pool.query("select external_page_id from pages where id = $1", [pageId]);
    expect(page.rows[0].external_page_id).toBe(OWN_ID);
    expect(alerts.opened.map((alert) => alert.detail)).toEqual(expect.arrayContaining(["identity_mismatch", "quarantined"]));
  });
});

describe("account.identity", () => {
  it("judges the candidate's answer against the page and writes nothing else: no counters, no identity, no hold", async (context) => {
    if (!testDb) return context.skip();
    const cases = [
      { externalId: OWN_ID, answer: OWN_ID, closeReason: "identity_matches", matches: true },
      { externalId: "300000000000000002", answer: "399999999999999999", closeReason: "identity_differs", matches: false },
    ];
    for (const { externalId, answer, closeReason, matches } of cases) {
      const pageId = await seedPage({ externalId, followerCount: 5, subscriberCount: 4, verifiedAgoMs: 3 * 3_600_000 });
      await makeDue(pageId, "account.identity", { params: { candidate: { generation: "candidate-1" } } });
      const { hits } = await runLive(pageId, () => okResponse(accountMe(answer, { followCount: 42, subscriberCount: 7 })),
        async () => (await workRow(pageId, "account.identity"))?.state === "done");

      expect(hits).toEqual(["account.me"]);
      const work = await testDb.pool.query(
        "select close_reason, result from sync_work where page_id = $1 and resource = 'account.identity'",
        [pageId],
      );
      expect(work.rows).toHaveLength(1);
      expect(work.rows[0]).toMatchObject({ close_reason: closeReason, result: { accountId: answer, username: "model", matches } });
      const page = await testDb.pool.query(
        `select external_page_id, follower_count, subscriber_count,
                last_verified_at < clock_timestamp() - interval '2 hours' as stale
           from pages where id = $1`,
        [pageId],
      );
      expect(page.rows[0]).toEqual({ external_page_id: externalId, follower_count: 5, subscriber_count: 4, stale: true });
      const sync = await testDb.pool.query(
        `select sp.identity_account_id, (select count(*)::int from sync_holds h where h.page_id = sp.page_id) as holds
           from sync_pages sp where sp.page_id = $1`, [pageId]);
      expect(sync.rows[0]).toEqual({ identity_account_id: null, holds: 0 });
      // The answer is journaled like every served response.
      expect(await countRows(testDb.pool, "select count(*)::int as n from observations where account_id = $1 and kind = 'account_me'", [pageId])).toBe(1);
    }
  });
});

describe("subscribers.poll", () => {
  it("walks the page, retires the unseen subscription, and asks the lookup walk for the new fans' profiles", async (context) => {
    if (!testDb) return context.skip();
    const pageId = await seedPage({ subscriberCount: 2 });
    // A current subscription the walk will not serve, last seen long before.
    const [stale] = await upsertFans(db(), [{ platform: "fansly", platformUserId: "500000000000000009" }]);
    await testDb.pool.query(
      `insert into page_subscriptions (platform_subscription_id, platform_account_id, fan_id, raw_status, canonical_status,
              price_mills, renew_price_mills, is_current, last_seen_at)
       values ('sub-stale', $1, $2, 3, 'active', 0, 0, true, clock_timestamp() - interval '2 days')`,
      [pageId, stale!.id],
    );
    await makeDue(pageId, "subscribers.poll");
    const served = [subscription("sub-1", "500000000000000001"), subscription("sub-2", "500000000000000002")];
    const { hits } = await runLive(pageId, (req) => {
      if (req.spec === "subscribers.page") return okResponse(subscribersPage(served, 2));
      if (req.spec === "accounts.by_ids") {
        return okResponse((requestParam(req, "ids") ?? "").split(",").filter((id) => id.endsWith("1")).map((id) => fanAccount(id)));
      }
      throw new Error(`unexpected ${req.spec}`);
    }, async () => (await workRow(pageId, "fan-profiles.lookup"))?.state === "done");

    expect(hits).toEqual(["subscribers.page", "accounts.by_ids"]);
    const subscriptions = await testDb.pool.query(
      "select platform_subscription_id as id, is_current, last_seen_generation::int as gen, canonical_status from page_subscriptions where platform_account_id = $1 order by 1",
      [pageId],
    );
    expect(subscriptions.rows).toEqual([
      { id: "sub-1", is_current: true, gen: 1, canonical_status: "active" },
      { id: "sub-2", is_current: true, gen: 1, canonical_status: "active" },
      { id: "sub-stale", is_current: false, gen: null, canonical_status: "active" },
    ]);
    const poll = await workRow(pageId, "subscribers.poll");
    expect(poll!.state).toBe("open");
    expect(poll!.cursor).toMatchObject({ generation: 1, walk: null, last: { destructiveFinalization: true, pageCount: 1 } });
    // The lookup: one request for both ids; the returned one gets its profile;
    // the omitted one is only the page's answer, never a shared deleted mark
    // (arena "vanished chat" D2); both are stamped with the result.
    const lookup = await workRow(pageId, "fan-profiles.lookup");
    expect(lookup!.params).toEqual({ ids: ["500000000000000001", "500000000000000002"] });
    const fans = await testDb.pool.query(
      `select f.platform_user_id as id, f.username, f.deleted_detected_at is not null as deleted, fp.account_lookup_at is not null as stamped,
              fp.account_probe_resolved as resolved, fp.account_probe_at = fp.account_lookup_at as answered_with_stamp
         from fans f join page_fans fp on fp.fan_id = f.id and fp.platform_account_id = $1
        where f.platform_user_id in ('500000000000000001', '500000000000000002') order by 1`,
      [pageId],
    );
    expect(fans.rows).toEqual([
      { id: "500000000000000001", username: "fan0001", deleted: false, stamped: true, resolved: true, answered_with_stamp: true },
      { id: "500000000000000002", username: null, deleted: false, stamped: true, resolved: false, answered_with_stamp: true },
    ]);
    expect(lookup!.result).toMatchObject({ requested: 2, returned: 1, fallback: 1 });
    const kinds = await testDb.pool.query("select kind from observations where account_id = $1 order by id", [pageId]);
    expect(kinds.rows.map((row) => row.kind)).toEqual(["subscribers", "account_lookup"]);
  });

  it("waits for a fresh /account/me counter and makes account.poll due", async (context) => {
    if (!testDb) return context.skip();
    const pageId = await seedPage({ verifiedAgoMs: 3 * 3_600_000 });
    await makeDue(pageId, "subscribers.poll");
    const { hits } = await runLive(pageId, (req) => {
      if (req.spec === "account.me") return okResponse(accountMe(OWN_ID));
      throw new Error(`unexpected ${req.spec}`);
    }, async () => (await appliedAttempts(pageId, "account.poll")) === 1);
    expect(hits).toEqual(["account.me"]);
    const waiting = await workRow(pageId, "subscribers.poll");
    expect(waiting).toMatchObject({ state: "open", waiting_reason: "dependency" });
  });

  it("refuses a stated zero it cannot explain: nothing retired, the poll waits for its period", async (context) => {
    if (!testDb) return context.skip();
    // Six current subscriptions, none lapsed, and a counter that is not 0.
    const pageId = await seedPage({ subscriberCount: 6 });
    const fans = await upsertFans(db(), Array.from({ length: 6 }, (_, index) => ({
      platform: "fansly" as const,
      platformUserId: `51000000000000000${index}`,
    })));
    for (const [index, fan] of fans.entries()) {
      await testDb.pool.query(
        `insert into page_subscriptions (platform_subscription_id, platform_account_id, fan_id, raw_status, canonical_status,
                price_mills, renew_price_mills, is_current, auto_renew, ends_at, last_seen_at)
         values ($3, $1, $2, 3, 'active', 0, 0, true, true, clock_timestamp() + interval '10 days', clock_timestamp() - interval '1 day')`,
        [pageId, fan.id, `sub-${index}`],
      );
    }
    await makeDue(pageId, "subscribers.poll");
    const metrics = new RecordingMetrics();
    await runLive(pageId, () => okResponse(subscribersPage([], 0)),
      async () => (await appliedAttempts(pageId, "subscribers.poll")) === 1, { metrics });

    expect(await countRows(testDb.pool, "select count(*)::int as n from page_subscriptions where platform_account_id = $1 and is_current", [pageId])).toBe(6);
    const poll = await workRow(pageId, "subscribers.poll");
    expect(poll!.state).toBe("open");
    expect(poll!.cursor).toMatchObject({ walk: null, last: { refused: { reason: "too_many_current", currentCount: 6 } } });
    expect(poll!.due_at.getTime() - Date.now()).toBeGreaterThan(50 * 60_000);
    expect(metrics.get("sync_apply_effect")).toBe(1);
  });
});

describe("followers", () => {
  it("head: new follows above the known one, presence from the served page, the reconcile decision", async (context) => {
    if (!testDb) return context.skip();
    const pageId = await seedPage({ followerCount: 5 });
    // The legacy reconcile walked an hour ago: the owner floor holds a new one.
    await testDb.pool.query(
      "insert into page_sync_cursors (page_id, stream, state) values ($1, 'followers_reconcile', $2::jsonb)",
      [pageId, JSON.stringify({ fullSweepStartedAt: new Date(Date.now() - 3_600_000).toISOString() })],
    );
    const now = new Date();
    const known = followId(new Date(now.getTime() - 3 * 86_400_000));
    const newer = [followId(new Date(now.getTime() - 60_000), 2), followId(new Date(now.getTime() - 120_000), 1)];
    await upsertDemand(db(), { pageId, resource: "followers.head", kind: "poll", class: "planned" });
    await testDb.pool.query("update sync_work set cursor = $2 where page_id = $1 and resource = 'followers.head'", [pageId, JSON.stringify({ knownFollowId: known })]);
    const page = {
      followers: [
        { id: newer[0], followerId: "600000000000000001" },
        { id: newer[1], followerId: "600000000000000002" },
        { id: known, followerId: "600000000000000003" },
      ],
      aggregationData: {
        accounts: [
          fanAccount("600000000000000001", { lastSeenAt: Date.now() - 60_000 }),
          fanAccount("600000000000000002"),
          fanAccount("600000000000000003"),
        ],
      },
    };
    const { hits } = await runLive(pageId, (req) => {
      if (req.spec === "followers.page") return okResponse(page);
      throw new Error(`unexpected ${req.spec}`);
    }, async () => (await appliedAttempts(pageId, "followers.head")) === 1
      && (await workRow(pageId, "followers.reconcile"))?.waiting_reason === "not_due");

    expect(hits).toEqual(["followers.page"]);
    const follows = await testDb.pool.query("select platform_follow_id as id, is_active from page_follows where platform_account_id = $1 order by 1", [pageId]);
    // The known follow is the boundary: it is not written again.
    expect(follows.rows).toEqual([...newer].sort().map((id) => ({ id, is_active: true })));
    const head = await workRow(pageId, "followers.head");
    expect(head!.cursor).toMatchObject({ knownFollowId: newer[0], walk: null });
    expect(head!.proof).toMatchObject({ sourceFollowerCount: 5, activeFollowerCount: 2, reconcile: { countMismatch: true, requested: true } });
    const presence = await testDb.pool.query(
      `select f.platform_user_id as id from page_fans fp join fans f on f.id = fp.fan_id
        where fp.platform_account_id = $1 and fp.external_presence_at is not null`,
      [pageId],
    );
    expect(presence.rows).toEqual([{ id: "600000000000000001" }]);
    const followerSync = await testDb.pool.query("select last_follower_sync_at is not null as synced from pages where id = $1", [pageId]);
    expect(followerSync.rows[0].synced).toBe(true);
    // The decision became reconcile demand, held by the owner's daily floor.
    const reconcile = await workRow(pageId, "followers.reconcile");
    expect(reconcile).toMatchObject({ state: "open", waiting_reason: "not_due" });
    expect(reconcile!.due_at.getTime() - Date.now()).toBeGreaterThan(22 * 3_600_000);
  });

  it("head: a follower count /account/me omitted stays unknown — no stated total today, no count mismatch", async (context) => {
    if (!testDb) return context.skip();
    const pageId = await seedPage({ followerCount: null });
    await upsertDemand(db(), { pageId, resource: "followers.head", kind: "poll", class: "planned" });
    const now = new Date();
    const follows = [followId(now, 2), followId(new Date(now.getTime() - 1_000), 1)];
    const page = {
      followers: follows.map((id, index) => ({ id, followerId: `61000000000000000${index}` })),
      aggregationData: { accounts: follows.map((_, index) => fanAccount(`61000000000000000${index}`)) },
    };
    await runLive(pageId, (req) => {
      if (req.spec === "followers.page") return okResponse(page);
      throw new Error(`unexpected ${req.spec}`);
    }, async () => (await appliedAttempts(pageId, "followers.head")) === 1);

    const head = await workRow(pageId, "followers.head");
    expect(head!.proof).toMatchObject({ sourceFollowerCount: null, activeFollowerCount: 2, reconcile: { countMismatch: false, requested: false } });
    const rollups = await testDb.pool.query(
      "select new_followers, known_total_followers from daily_followers where platform_account_id = $1",
      [pageId],
    );
    expect(rollups.rows).toEqual([{ new_followers: 2, known_total_followers: null }]);
    expect(await workRow(pageId, "followers.reconcile")).toBeNull();
  });

  it("reconcile: account, every page, terminal account — membership proven, the unseen follow retired", async (context) => {
    if (!testDb) return context.skip();
    const pageId = await seedPage({ followerCount: 3 });
    const [gone] = await upsertFans(db(), [{ platform: "fansly", platformUserId: "610000000000000009" }]);
    await testDb.pool.query(
      `insert into page_follows (platform_account_id, fan_id, platform_follow_id, followed_at, first_seen_at, last_seen_at, is_active)
       values ($1, $2, '1000', clock_timestamp() - interval '30 days', clock_timestamp() - interval '30 days', clock_timestamp() - interval '2 days', true)`,
      [pageId, gone!.id],
    );
    await makeDue(pageId, "followers.reconcile", { reason: "owner" });
    const now = Date.now();
    const served = {
      followers: [
        { id: followId(new Date(now - 60_000), 1), followerId: "610000000000000001" },
        { id: followId(new Date(now - 120_000), 2), followerId: "610000000000000002" },
      ],
      aggregationData: { accounts: [fanAccount("610000000000000001"), fanAccount("610000000000000002")] },
    };
    const { hits } = await runLive(pageId, (req) => {
      if (req.spec === "account.me") return okResponse(accountMe(OWN_ID, { followCount: 2 }));
      if (req.spec === "followers.page") return okResponse(served);
      throw new Error(`unexpected ${req.spec}`);
    }, async () => (await workRow(pageId, "followers.reconcile"))?.state === "done");

    expect(hits).toEqual(["account.me", "followers.page", "account.me"]);
    const follows = await testDb.pool.query(
      "select platform_follow_id as id, is_active, last_seen_generation::int as gen from page_follows where platform_account_id = $1 order by is_active, 1",
      [pageId],
    );
    expect(follows.rows[0]).toEqual({ id: "1000", is_active: false, gen: null });
    expect(follows.rows.slice(1).map((row) => [row.is_active, row.gen])).toEqual([[true, 1], [true, 1]]);
    const work = await workRow(pageId, "followers.reconcile");
    expect(work!.proof).toMatchObject({ outcome: "complete", membershipProof: "exact_generation", deactivatedCount: 1, generationObservedCount: 2 });
    expect(work!.cursor).toMatchObject({ generation: 1, walk: null });
    expect(typeof (work!.cursor as { lastFullSweepStartedAt?: unknown }).lastFullSweepStartedAt).toBe("string");
  });

  it("reconcile: a deactivation past the safety ceiling is quarantined, nothing retired", async (context) => {
    if (!testDb) return context.skip();
    const pageId = await seedPage({ followerCount: 2 });
    const fans = await upsertFans(db(), Array.from({ length: 60 }, (_, index) => ({
      platform: "fansly" as const,
      platformUserId: `62${String(index).padStart(16, "0")}`,
    })));
    for (const [index, fan] of fans.entries()) {
      await testDb.pool.query(
        `insert into page_follows (platform_account_id, fan_id, platform_follow_id, followed_at, first_seen_at, last_seen_at, is_active)
         values ($1, $2, $3, clock_timestamp() - interval '30 days', clock_timestamp() - interval '30 days', clock_timestamp() - interval '2 days', true)`,
        [pageId, fan.id, String(2000 + index)],
      );
    }
    await makeDue(pageId, "followers.reconcile", { reason: "owner" });
    const now = Date.now();
    const served = {
      followers: [
        { id: followId(new Date(now - 60_000), 1), followerId: "630000000000000001" },
        { id: followId(new Date(now - 120_000), 2), followerId: "630000000000000002" },
      ],
      aggregationData: { accounts: [fanAccount("630000000000000001"), fanAccount("630000000000000002")] },
    };
    const alerts = new RecordingAlerts();
    await runLive(pageId, (req) => {
      if (req.spec === "account.me") return okResponse(accountMe(OWN_ID, { followCount: 2 }));
      if (req.spec === "followers.page") return okResponse(served);
      throw new Error(`unexpected ${req.spec}`);
    }, async () => (await workRow(pageId, "followers.reconcile"))?.state === "quarantined", { alerts });

    expect(await countRows(testDb.pool, "select count(*)::int as n from page_follows where platform_account_id = $1 and is_active and platform_follow_id::numeric < 3000", [pageId])).toBe(60);
    const work = await workRow(pageId, "followers.reconcile");
    expect(work!.last_error_class).toBe("apply:quarantine:followers_reconcile_deactivation_blast_radius");
    const attempt = await testDb.pool.query(
      "select apply_state, apply_error from sync_attempts where page_id = $1 and resource = 'followers.reconcile' order by id desc limit 1",
      [pageId],
    );
    expect(attempt.rows[0]).toEqual({ apply_state: "quarantined", apply_error: "quarantine:followers_reconcile_deactivation_blast_radius" });
    expect(alerts.opened.some((alert) => alert.subKey === "live_degraded" && alert.detail === "quarantined")).toBe(true);
  });
});

describe("fan-profiles", () => {
  it("probe: an unresolvable partner is recorded for the page, and its conversation stays in message sync", async (context) => {
    if (!testDb) return context.skip();
    const pageId = await seedPage();
    const partner = "650000000000000001";
    const [fan] = await upsertFans(db(), [{ platform: "fansly", platformUserId: partner }]);
    await testDb.pool.query("insert into page_fans (fan_id, platform_account_id) values ($1, $2)", [fan!.id, pageId]);
    const conversation = await upsertPageDmConversation(db(), {
      platformAccountId: pageId, fanId: fan!.id, platformConversationId: "g-1", partnerPlatformUserId: partner,
      partnerUsername: null, partnerDisplayName: null, conversationFlags: 0, unreadCount: 0, subscriptionTierId: null,
      lastMessageId: null, lastUnreadMessageId: null, lastMessageAt: null, lastMessageSenderId: null,
      lastMessageSenderRole: "fan", lastMessagePreview: null, lastSeenGeneration: null,
    });
    const conversationId = Number((conversation as { id: number }).id);
    await makeDue(pageId, "fan-profiles.probe", { subject: partner, params: { conversationId } });
    await runLive(pageId, () => okResponse([]), async () => (await workRow(pageId, "fan-profiles.probe"))?.state === "done");

    const probe = await testDb.pool.query("select account_probe_resolved from page_fans where fan_id = $1 and platform_account_id = $2", [fan!.id, pageId]);
    expect(probe.rows[0].account_probe_resolved).toBe(false);
    // A lookup miss is the page's own evidence: the chat is not excluded.
    const metadata = await testDb.pool.query("select metadata from page_dm_threads where id = $1", [conversationId]);
    expect(metadata.rows[0].metadata).not.toHaveProperty("messageSyncExcludedReason");
    expect((await workRow(pageId, "fan-profiles.probe"))!.result).toEqual({ resolution: "unresolved" });
  });
});
