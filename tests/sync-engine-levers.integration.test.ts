import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { Client } from "pg";

import {
  adminFollowersReconcileOverrideApplyResponseSchema,
  adminFollowersReconcileOverridePreviewResponseSchema,
  adminSyncBlockResponseSchema,
  syncBlocksPageSchema,
} from "@agency_hub_core/contracts";
import {
  ensurePollRows,
  getSyncPage,
  setPagePause,
  upsertDemand,
  upsertFans,
  type Database,
} from "@agency_hub_core/db";
import type { FanslyWireOutcome, FanslyWireRequest } from "@agency_hub_core/fansly";

import { buildApiServer } from "../apps/runtime/src/api/server.ts";
import type { AppContext } from "../apps/runtime/src/bootstrap.ts";
import { createUserAccount } from "../apps/runtime/src/services/auth.ts";
import { buildSyncEngineCommandGroup } from "../apps/runtime/src/sync/cli.ts";
import { ApplyQuarantine } from "../apps/runtime/src/sync/engine/commit.ts";
import { createEngineRegistry, pollsFor, type EngineRegistry, type ResourceModule } from "../apps/runtime/src/sync/engine/resource.ts";
import { FANSLY_RESOURCE_SPECS, fanslyResourceSpec } from "../apps/runtime/src/sync/fansly/registry.ts";
import { SYNC_WORK_ENQUEUE_AUDIT_EVENT, SYNC_WORK_REQUEUE_AUDIT_EVENT } from "../apps/runtime/src/sync/inspect.ts";
import {
  resetIntegrationDatabase,
  startIntegrationTestDatabase,
  type StartedTestDatabase,
} from "./helpers/db.ts";
import { createTestAppContext } from "./helpers/runtime.ts";
import {
  countRows,
  makeTestActor,
  okResponse,
  pollsRequest,
  RecordingAlerts,
  ScriptedLiveTransport,
  seedSyncPage,
  testRegistry,
  testSpec,
  waitFor,
} from "./helpers/sync-engine-host.ts";

vi.mock("argon2", () => import("./helpers/cheap-argon2.ts"));

/**
 * The owner's levers on a page the Fansly Sync Engine owns (design step 3
 * §3.2 items 4–5), against a real database, the real server and the real
 * actor:
 *
 *  - the legacy buttons speak for the engine: "sync now" makes the block's
 *    polls due (NOTIFY), pause/resume move only the block's registry keys,
 *    reset requeues the block's quarantined work — `page_sync_states` is never
 *    touched (J5) — and a page in `handover` refuses a reading lever (409);
 *  - the followers blast-radius override reads the engine walk the apply
 *    quarantined (`result.quarantine`, its cursor) and closes it;
 *  - `sync work requeue` re-applies a captured answer from the journal with
 *    no request at the origin; `sync work enqueue` files the owner's demand on
 *    a live page only; both are audited.
 */

let testDb: StartedTestDatabase | null = null;
let app: AppContext;
let server: Awaited<ReturnType<typeof buildApiServer>> | null = null;
let ownerCookie = "";
const OWN_ID = "300000000000000001";
const FOLLOW_EPOCH_MS = 1561494359900;

beforeAll(async () => {
  testDb = await startIntegrationTestDatabase();
}, 180_000);

afterAll(async () => {
  await server?.close();
  await testDb?.stop();
});

function db(): Database {
  return testDb!.db as unknown as Database;
}

const pages = { live: 0, handover: 0, legacy: 0 };

beforeEach(async (context) => {
  if (!testDb) {
    context.skip();
    return;
  }
  await resetIntegrationDatabase(testDb.pool);
  // With the database URL the api starts its pg-boss (the legacy levers
  // enqueue wake-ups; the engine's need none).
  app = createTestAppContext(testDb, { authPolicyEnforcement: "enforce", databaseUrl: testDb.connectionString });
  const handles = { db: db(), pool: testDb.pool };
  pages.live = (await seedSyncPage(handles, { label: "lilly-1", mode: "live", guard: "fansly_sync_engine" })).pageId;
  pages.handover = (await seedSyncPage(handles, { label: "lilly-2", mode: "handover", guard: "fansly_sync_engine" })).pageId;
  pages.legacy = (await seedSyncPage(handles, { label: "ari-1", mode: "shadow" })).pageId;
  for (const [pageId, externalId] of [[pages.live, OWN_ID], [pages.handover, "300000000000000002"]] as const) {
    await testDb.pool.query(
      "update pages set external_page_id = $2, follower_count = 2 where id = $1",
      [pageId, externalId],
    );
  }
  await createUserAccount(app, { username: "owner", role: "owner", password: "owner-secret" }, { source: "cli" });
  await server?.close();
  server = await buildApiServer(app);
  await server.ready();
  const login = await server.inject({
    method: "POST",
    url: "/api/v1/auth/login",
    payload: { username: "owner", password: "owner-secret" },
  });
  const setCookie = login.headers["set-cookie"];
  const raw = Array.isArray(setCookie) ? setCookie[0] : setCookie;
  ownerCookie = String(raw ?? "").split(";")[0] ?? "";
  expect(ownerCookie).not.toBe("");
});

afterEach(async () => {
  await server?.close();
  server = null;
});

function ownerPost(url: string, payload: Record<string, unknown> = {}) {
  return server!.inject({ method: "POST", url, headers: { cookie: ownerCookie }, payload });
}

function ownerGet(url: string) {
  return server!.inject({ method: "GET", url, headers: { cookie: ownerCookie } });
}

/** Every registry poll of a page's live journal, parked an hour or more out. */
async function parkPolls(pageId: number): Promise<EngineRegistry> {
  const registry = createEngineRegistry(FANSLY_RESOURCE_SPECS);
  const page = await getSyncPage(db(), pageId);
  await ensurePollRows(db(), {
    pageId,
    shadow: false,
    polls: pollsFor(registry, page!, false).map((poll) => ({ ...poll, phase: 0.999 })),
  });
  return registry;
}

async function dueNow(pageId: number, resource: string): Promise<boolean> {
  const result = await testDb!.pool.query<{ due: boolean }>(
    "select due_at <= clock_timestamp() as due from sync_work where page_id = $1 and resource = $2 and not shadow and state = 'open'",
    [pageId, resource],
  );
  return result.rows[0]?.due === true;
}

async function legacyStateRows(pageId: number): Promise<string> {
  const result = await testDb!.pool.query(
    "select to_jsonb(s) as row from page_sync_states s where page_id = $1 order by stream",
    [pageId],
  );
  return JSON.stringify(result.rows);
}

function cli(lines: string[]) {
  return buildSyncEngineCommandGroup({
    openContext: async () => ({ db: db(), rawConfig: app.config, close: async () => undefined }),
    print: (line) => lines.push(line),
  });
}

describe("block levers on an engine page", () => {
  it("sync now: the block's polls due now with a NOTIFY; trigger-all; a page in handover refuses", async () => {
    await parkPolls(pages.live);
    await parkPolls(pages.handover);
    const legacyBefore = await legacyStateRows(pages.live);
    const listener = new Client({ connectionString: testDb!.connectionString });
    await listener.connect();
    const notices: string[] = [];
    listener.on("notification", (message) => notices.push(message.payload ?? ""));
    await listener.query("listen fansly_sync_work");
    try {
      const response = await ownerPost("/api/v1/admin/sync/blocks/trigger", { pageLabel: "lilly-1", block: "financials" });
      expect(response.statusCode).toBe(200);
      const body = adminSyncBlockResponseSchema.parse(response.json());
      expect(body.engine).toEqual({ mode: "live", resources: ["top-spenders", "transactions"], affected: 3 });
      expect(await dueNow(pages.live, "top-spenders.window")).toBe(true);
      expect(await dueNow(pages.live, "transactions.insurance")).toBe(true);
      expect(await dueNow(pages.live, "transactions.rescan")).toBe(true);
      expect(await dueNow(pages.live, "account.poll")).toBe(false);
      await waitFor(() => (notices.includes(String(pages.live)) ? true : null), 5_000, "the actor's NOTIFY");
    } finally {
      await listener.end();
    }

    const scoped = await ownerPost("/api/v1/admin/sync/trigger", { pageLabel: "lilly-1", scope: "light" });
    expect(scoped.statusCode).toBe(202);
    expect(await dueNow(pages.live, "account.poll")).toBe(true);

    const all = await ownerPost("/api/v1/admin/sync/trigger-all");
    expect(all.statusCode).toBe(202);
    expect(await dueNow(pages.live, "subscribers.poll")).toBe(true);
    // The page in handover is neither read by the engine nor by legacy.
    expect(await dueNow(pages.handover, "subscribers.poll")).toBe(false);
    expect(await countRows(testDb!.pool, "select count(*)::int as n from page_sync_states where page_id = $1", [pages.handover])).toBe(0);
    // The legacy page is triggered the legacy way.
    expect(await countRows(testDb!.pool, "select count(*)::int as n from page_sync_states where page_id = $1", [pages.legacy])).toBeGreaterThan(0);
    const audit = await testDb!.pool.query<{ metadata: { pagesQueued: number; engine?: Array<{ pageLabel: string }> } }>(
      "select metadata from audit_events where event_type = 'admin.sync_trigger_all' order by id desc limit 1",
    );
    expect(audit.rows[0]!.metadata.engine?.map((entry) => entry.pageLabel)).toEqual(["lilly-1"]);

    const refused = await ownerPost("/api/v1/admin/sync/blocks/trigger", { pageLabel: "lilly-2", block: "financials" });
    expect(refused.statusCode).toBe(409);
    expect(refused.json()).toMatchObject({ error: "fansly_page_switching" });
    const refusedScope = await ownerPost("/api/v1/admin/sync/trigger", { pageLabel: "lilly-2", scope: "all" });
    expect(refusedScope.statusCode).toBe(409);
    // Legacy state of the engine page: untouched by every lever (J5).
    expect(await legacyStateRows(pages.live)).toBe(legacyBefore);
  });

  it("pause and resume move only the block's keys; the page's other pauses stay", async () => {
    await setPagePause(db(), { pageId: pages.live, resources: ["media-stats.walk"] });
    const paused = await ownerPost("/api/v1/admin/sync/blocks/pause", { pageLabel: "lilly-1", block: "audience" });
    expect(paused.statusCode).toBe(200);
    expect(adminSyncBlockResponseSchema.parse(paused.json()).engine).toEqual({
      mode: "live",
      resources: ["subscribers.poll", "subscribers.history", "followers.head", "followers.reconcile", "fan-profiles.lookup"],
      affected: 5,
    });
    const row = await getSyncPage(db(), pages.live);
    expect(row!.pausedResources).toEqual([
      "fan-profiles.lookup", "followers.head", "followers.reconcile", "media-stats.walk", "subscribers.history", "subscribers.poll",
    ]);
    // The Settings block reads the pause back for its buttons.
    const blocks = await ownerGet("/api/v1/pages/lilly-1/sync/blocks");
    expect(blocks.statusCode).toBe(200);
    const audience = syncBlocksPageSchema.parse(blocks.json().page).blocks.audience;
    expect(audience).toMatchObject({ state: "engine", engineMode: "live" });
    expect(audience.metrics.pausedResources).toHaveLength(5);

    const resumed = await ownerPost("/api/v1/admin/sync/blocks/resume", { pageLabel: "lilly-1", block: "audience" });
    expect(resumed.statusCode).toBe(200);
    expect((await getSyncPage(db(), pages.live))!.pausedResources).toEqual(["media-stats.walk"]);
    // A page in handover may be paused: nothing reads.
    expect((await ownerPost("/api/v1/admin/sync/blocks/pause", { pageLabel: "lilly-2", block: "audience" })).statusCode).toBe(200);
  });

  it("reset requeues the block's quarantined work and never touches legacy state", async () => {
    await parkPolls(pages.live);
    await testDb!.pool.query(
      `update sync_work set state = 'quarantined', waiting_reason = 'quarantined',
              result = '{"quarantine":{"reason":"plan:page_missing","detail":{},"attemptId":null,"at":"2026-10-02T10:00:00Z"}}'::jsonb
        where page_id = $1 and resource in ('transactions.rescan', 'dm-conversations.head') and not shadow`,
      [pages.live],
    );
    const legacyBefore = await legacyStateRows(pages.live);
    const response = await ownerPost("/api/v1/admin/sync/blocks/reset", { pageLabel: "lilly-1", block: "financials" });
    expect(response.statusCode).toBe(200);
    expect(adminSyncBlockResponseSchema.parse(response.json()).engine).toMatchObject({ mode: "live", affected: 1 });
    const rows = await testDb!.pool.query<{ resource: string; state: string; result: unknown; due: boolean }>(
      `select resource, state, result, due_at <= clock_timestamp() as due from sync_work
        where page_id = $1 and resource in ('transactions.rescan', 'dm-conversations.head') and not shadow order by resource`,
      [pages.live],
    );
    expect(rows.rows).toEqual([
      // Another block's quarantine stays.
      { resource: "dm-conversations.head", state: "quarantined", result: expect.anything(), due: false },
      { resource: "transactions.rescan", state: "open", result: null, due: true },
    ]);
    // The message-history reset deletes nothing on an engine page: it requeues.
    const history = await ownerPost("/api/v1/admin/sync/blocks/reset", { pageLabel: "lilly-1", block: "messages_history" });
    expect(history.statusCode).toBe(200);
    expect(await legacyStateRows(pages.live)).toBe(legacyBefore);
    expect((await ownerPost("/api/v1/admin/sync/blocks/reset", { pageLabel: "lilly-2", block: "financials" })).statusCode).toBe(409);
  });
});

describe("the follower reconcile on an engine page", () => {
  function followId(at: Date, sequence = 0): string {
    return ((BigInt(at.getTime() - FOLLOW_EPOCH_MS) << 22n) + BigInt(sequence)).toString();
  }

  function accountMe(followCount: number) {
    return {
      account: {
        id: OWN_ID,
        username: "model",
        displayName: "Model",
        createdAt: Date.UTC(2024, 0, 1),
        followCount,
        subscriberCount: 0,
        earningsWallet: { id: "wallet", balance: 1234 },
        walls: [],
        subscriptionTiers: [],
        email: "model@example.invalid",
      },
    };
  }

  /** The engine walk refuses to retire 60 unseen follows (blast radius). */
  async function quarantineTheWalk(pageId: number): Promise<number> {
    const fans = await upsertFans(db(), Array.from({ length: 60 }, (_, index) => ({
      platform: "fansly" as const,
      platformUserId: `62${String(index).padStart(16, "0")}`,
    })));
    for (const [index, fan] of fans.entries()) {
      await testDb!.pool.query(
        `insert into page_follows (platform_account_id, fan_id, platform_follow_id, followed_at, first_seen_at, last_seen_at, is_active)
         values ($1, $2, $3, clock_timestamp() - interval '30 days', clock_timestamp() - interval '30 days', clock_timestamp() - interval '2 days', true)`,
        [pageId, fan.id, String(2000 + index)],
      );
    }
    const registry = await parkPolls(pageId);
    const spec = fanslyResourceSpec("followers.reconcile")!;
    await upsertDemand(db(), {
      pageId, shadow: false, resource: spec.key, kind: spec.kind, class: spec.class, demand: { reasons: ["owner"] },
    });
    const now = Date.now();
    const served = {
      followers: [
        { id: followId(new Date(now - 60_000), 1), followerId: "630000000000000001" },
        { id: followId(new Date(now - 120_000), 2), followerId: "630000000000000002" },
      ],
      aggregationData: {
        accounts: ["630000000000000001", "630000000000000002"].map((id) => ({
          id, username: `fan${id.slice(-4)}`, displayName: `Fan ${id.slice(-4)}`, createdAt: Date.UTC(2025, 0, 1),
        })),
      },
    };
    const transport = new ScriptedLiveTransport();
    transport.respond = (req: FanslyWireRequest): FanslyWireOutcome => {
      if (req.spec === "account.me") return okResponse(accountMe(2));
      if (req.spec === "followers.page") return okResponse(served);
      throw new Error(`unexpected ${req.spec}`);
    };
    const { actor, stop, abort } = await makeTestActor({ db: db(), pageId, mode: "live", registry, transport });
    const run = actor.run({ stop: stop.signal, abort: abort.signal });
    try {
      await waitFor(async () => {
        const row = await testDb!.pool.query<{ id: string }>(
          "select id::text from sync_work where page_id = $1 and resource = 'followers.reconcile' and state = 'quarantined'",
          [pageId],
        );
        return row.rows[0] === undefined ? null : Number(row.rows[0].id);
      }, 30_000, "the reconcile's quarantine");
    } finally {
      stop.abort();
      await run;
    }
    const row = await testDb!.pool.query<{ id: string }>(
      "select id::text from sync_work where page_id = $1 and resource = 'followers.reconcile' and state = 'quarantined'",
      [pageId],
    );
    return Number(row.rows[0]!.id);
  }

  it("the blast-radius override reads the quarantined walk, retires exactly the previewed set and closes the walk", async () => {
    const workId = await quarantineTheWalk(pages.live);
    const quarantined = await testDb!.pool.query<{ result: { quarantine: Record<string, unknown> }; cursor: { walk: Record<string, unknown> } }>(
      "select result, cursor from sync_work where id = $1", [workId],
    );
    // The apply's refusal is on the row: reason, its own detail, the attempt.
    expect(quarantined.rows[0]!.result.quarantine).toMatchObject({
      reason: "apply:quarantine:followers_reconcile_deactivation_blast_radius",
      detail: { refusal: "followers_reconcile_deactivation_blast_radius", deactivationLimit: 50 },
      attemptId: expect.any(Number),
      at: expect.any(String),
    });
    const generation = Number(quarantined.rows[0]!.cursor.walk.generation);
    const legacyBefore = await legacyStateRows(pages.live);

    const preview = await ownerPost("/api/v1/admin/sync/followers-reconcile/blast-radius/preview", { pageLabel: "lilly-1" });
    expect(preview.statusCode).toBe(200);
    const evidence = adminFollowersReconcileOverridePreviewResponseSchema.parse(preview.json());
    expect(evidence).toMatchObject({
      blockedRequestSeq: workId,
      generation,
      candidateCount: 60,
      deactivationLimit: 50,
      overrideRequired: true,
      audiencePaused: false,
      audienceLeaseFree: true,
      readyToApply: false,
    });
    const echo = {
      pageLabel: "lilly-1",
      blockedRequestSeq: evidence.blockedRequestSeq,
      blockedAt: evidence.blockedAt,
      generation: evidence.generation,
      fullSweepStartedAt: evidence.fullSweepStartedAt,
      candidateSha256: evidence.candidateSha256,
    };
    // The audience must be paused first, as on a legacy page.
    expect((await ownerPost("/api/v1/admin/sync/followers-reconcile/blast-radius/apply", echo)).statusCode).toBe(409);
    expect((await ownerPost("/api/v1/admin/sync/blocks/pause", { pageLabel: "lilly-1", block: "audience" })).statusCode).toBe(200);
    const ready = adminFollowersReconcileOverridePreviewResponseSchema.parse(
      (await ownerPost("/api/v1/admin/sync/followers-reconcile/blast-radius/preview", { pageLabel: "lilly-1" })).json(),
    );
    expect(ready.readyToApply).toBe(true);
    // A stale echo is refused.
    const stale = await ownerPost("/api/v1/admin/sync/followers-reconcile/blast-radius/apply", { ...echo, blockedRequestSeq: workId + 1 });
    expect(stale.statusCode).toBe(409);

    const applied = await ownerPost("/api/v1/admin/sync/followers-reconcile/blast-radius/apply", echo);
    expect(applied.statusCode).toBe(200);
    expect(adminFollowersReconcileOverrideApplyResponseSchema.parse(applied.json())).toMatchObject({
      deactivatedCount: 60,
      audienceRemainsPaused: true,
    });
    expect(await countRows(testDb!.pool,
      "select count(*)::int as n from page_follows where platform_account_id = $1 and is_active", [pages.live])).toBe(2);
    const closed = await testDb!.pool.query<{ state: string; close_reason: string; cursor: Record<string, unknown>; result: unknown }>(
      "select state, close_reason, cursor, result from sync_work where id = $1", [workId],
    );
    expect(closed.rows[0]).toMatchObject({ state: "done", close_reason: "blast_radius_override_applied", result: null });
    expect(closed.rows[0]!.cursor).toMatchObject({
      generation,
      walk: null,
      lastFullSweepStartedAt: evidence.fullSweepStartedAt,
      last: { outcome: "blast_radius_override_applied", deactivatedCount: 60 },
    });
    const audit = await testDb!.pool.query<{ metadata: Record<string, unknown> }>(
      "select metadata from audit_events where event_type = 'admin.followers_reconcile_blast_radius_override_applied'",
    );
    expect(audit.rows[0]!.metadata).toMatchObject({ engine: { mode: "live", workId }, deactivatedCount: 60 });
    expect(await legacyStateRows(pages.live)).toBe(legacyBefore);
    // Nothing left to override.
    expect((await ownerPost("/api/v1/admin/sync/followers-reconcile/blast-radius/preview", { pageLabel: "lilly-1" })).statusCode).toBe(409);
  }, 60_000);

  it("the reset cancels the quarantined walk and files the owner's demand for a fresh one", async () => {
    const workId = await quarantineTheWalk(pages.live);
    const response = await ownerPost("/api/v1/admin/sync/followers-reconcile/reset", { pageLabel: "lilly-1" });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ action: "reset", stream: "followers_reconcile", requests: [{ stream: "followers_reconcile", requestedSeq: 1 }] });
    const rows = await testDb!.pool.query<{ id: string; state: string; close_reason: string | null; demand: { reasons: string[] } }>(
      "select id::text, state, close_reason, demand from sync_work where page_id = $1 and resource = 'followers.reconcile' and not shadow order by id",
      [pages.live],
    );
    expect(rows.rows.map((row) => ({ id: Number(row.id), state: row.state, closeReason: row.close_reason }))).toEqual([
      { id: workId, state: "cancelled", closeReason: "owner_reset" },
      { id: expect.any(Number), state: "open", closeReason: null },
    ]);
    expect(rows.rows[1]!.demand.reasons).toEqual(["owner"]);
    expect((await ownerPost("/api/v1/admin/sync/followers-reconcile/reset", { pageLabel: "lilly-2" })).statusCode).toBe(409);
  }, 60_000);
});

describe("sync work requeue and enqueue", () => {
  it("re-applies a captured answer from the journal with no request at the origin", async () => {
    let fixed = false;
    let applies = 0;
    const module: ResourceModule = {
      plan: async () => ({ kind: "request", request: pollsRequest }),
      apply: async () => {
        applies += 1;
        if (!fixed) throw new ApplyQuarantine("unmapped_rows", { rows: 3 });
        return { work: { satisfiesRevision: true, close: "done" }, followups: [] };
      },
      shadow: async () => ({ work: { satisfiesRevision: true, close: "done" }, followups: [] }),
    };
    const planQuarantine: ResourceModule = {
      plan: async () => ({ kind: "quarantine", reason: "page_missing" }),
      apply: async () => { throw new Error("never"); },
      shadow: async () => ({ work: { satisfiesRevision: true, close: "done" }, followups: [] }),
    };
    const registry = testRegistry([testSpec("fix.read", module), testSpec("plan.stuck", planQuarantine)]);
    await upsertDemand(db(), { pageId: pages.live, shadow: false, resource: "fix.read", kind: "trigger", class: "urgent" });
    await upsertDemand(db(), { pageId: pages.live, shadow: false, resource: "plan.stuck", kind: "trigger", class: "urgent" });
    const transport = new ScriptedLiveTransport();
    const { actor, stop, abort } = await makeTestActor({
      db: db(), pageId: pages.live, mode: "live", registry, transport, alerts: new RecordingAlerts(),
    });
    const run = actor.run({ stop: stop.signal, abort: abort.signal });
    try {
      await waitFor(async () => {
        const n = await countRows(testDb!.pool,
          "select count(*)::int as n from sync_work where page_id = $1 and state = 'quarantined' and not shadow", [pages.live]);
        return n === 2 ? true : null;
      }, 30_000, "both quarantines");
      expect(transport.hits).toHaveLength(1);
      expect(applies).toBe(1);
      const quarantined = await testDb!.pool.query<{ id: string; resource: string; result: { quarantine: Record<string, unknown> } }>(
        "select id::text, resource, result from sync_work where page_id = $1 and state = 'quarantined' order by resource",
        [pages.live],
      );
      const [fix, stuck] = quarantined.rows;
      expect(fix!.result.quarantine).toMatchObject({
        reason: "apply:quarantine:unmapped_rows",
        detail: { rows: 3, refusal: "unmapped_rows" },
        attemptId: expect.any(Number),
      });
      expect(stuck!.result.quarantine).toMatchObject({ reason: "plan:page_missing", detail: {}, attemptId: null });

      // `sync work list` shows what the quarantine recorded.
      const listed: string[] = [];
      await cli(listed).parseAsync(["node", "sync", "work", "list", "--page", "lilly-1", "--state", "quarantined"]);
      const rows = JSON.parse(listed.join("\n")) as Array<{ work: { id: number; result: { quarantine: unknown } }; waiting: { reason: string } }>;
      expect(rows.map((row) => row.work.id).sort()).toEqual([Number(fix!.id), Number(stuck!.id)].sort());
      expect(rows.every((row) => row.waiting.reason === "quarantined")).toBe(true);

      // The fix lands; the owner requeues the row.
      fixed = true;
      const printed: string[] = [];
      await cli(printed).parseAsync(["node", "sync", "work", "requeue", "--page", "lilly-1", "--work", fix!.id, "--note", "fixed"]);
      expect(JSON.parse(printed.join("\n"))).toMatchObject({
        requeued: [{ work: Number(fix!.id), resource: "fix.read", via: `reapply_attempt_${String(fix!.result.quarantine.attemptId)}` }],
      });
      await waitFor(async () => {
        const row = await testDb!.pool.query<{ state: string }>("select state from sync_work where id = $1", [Number(fix!.id)]);
        return row.rows[0]?.state === "done" ? true : null;
      }, 30_000, "the re-apply");
    } finally {
      stop.abort();
      await run;
    }
    // Applied from the journal: one request in all, the same attempt applied.
    expect(transport.hits).toHaveLength(1);
    expect(applies).toBe(2);
    const attempts = await testDb!.pool.query<{ apply_state: string; apply_failures: number }>(
      "select apply_state, apply_failures from sync_attempts where page_id = $1 and resource = 'fix.read'", [pages.live],
    );
    expect(attempts.rows).toEqual([{ apply_state: "applied", apply_failures: 0 }]);
    const fixRow = await testDb!.pool.query<{ result: unknown }>(
      "select result from sync_work where page_id = $1 and resource = 'fix.read'", [pages.live],
    );
    expect(fixRow.rows[0]!.result).toBeNull();
    const audit = await testDb!.pool.query<{ metadata: Record<string, unknown> }>(
      "select metadata from audit_events where event_type = $1", [SYNC_WORK_REQUEUE_AUDIT_EVENT],
    );
    expect(audit.rows[0]!.metadata).toMatchObject({ pageLabel: "lilly-1", note: "fixed", requeued: [{ resource: "fix.read" }] });

    // A plan quarantine opens due now (no answer to re-apply).
    const opened: string[] = [];
    await cli(opened).parseAsync(["node", "sync", "work", "requeue", "--page", "lilly-1", "--quarantined", "--resource", "plan.stuck"]);
    expect(JSON.parse(opened.join("\n"))).toMatchObject({ requeued: [{ resource: "plan.stuck", via: "run_again" }] });
    expect(await dueNow(pages.live, "plan.stuck")).toBe(true);
  }, 60_000);

  it("enqueue files the owner's demand for an owner key of a live page, audited; every other page or key is refused", async () => {
    const printed: string[] = [];
    await cli(printed).parseAsync(["node", "sync", "work", "enqueue", "--page", "lilly-1", "--resource", "transactions.backfill"]);
    expect(printed[0]).toMatch(/^lilly-1: transactions\.backfill queued as work \d+/);
    const row = await testDb!.pool.query<{ shadow: boolean; kind: string; class: string; demand: { reasons: string[] } }>(
      "select shadow, kind, class, demand from sync_work where page_id = $1 and resource = 'transactions.backfill'", [pages.live],
    );
    expect(row.rows).toEqual([{ shadow: false, kind: "goal", class: "planned", demand: expect.objectContaining({ reasons: ["owner"] }) }]);
    const audit = await testDb!.pool.query<{ metadata: Record<string, unknown> }>(
      "select metadata from audit_events where event_type = $1", [SYNC_WORK_ENQUEUE_AUDIT_EVENT],
    );
    expect(audit.rows[0]!.metadata).toMatchObject({ pageLabel: "lilly-1", resource: "transactions.backfill", created: true });

    await expect(cli([]).parseAsync(["node", "sync", "work", "enqueue", "--page", "lilly-2", "--resource", "transactions.backfill"]))
      .rejects.toThrow(/handover: owner work is enqueued only on a live page/);
    await expect(cli([]).parseAsync(["node", "sync", "work", "enqueue", "--page", "ari-1", "--resource", "transactions.backfill"]))
      .rejects.toThrow(/shadow: owner work is enqueued only on a live page/);
    await expect(cli([]).parseAsync(["node", "sync", "work", "enqueue", "--page", "lilly-1", "--resource", "account.verify"]))
      .rejects.toThrow(/sync work enqueue takes one of/);
    expect(await countRows(testDb!.pool, "select count(*)::int as n from audit_events where event_type = $1", [SYNC_WORK_ENQUEUE_AUDIT_EVENT])).toBe(1);
    // A second enqueue merges into the open row.
    const again: string[] = [];
    await cli(again).parseAsync(["node", "sync", "work", "enqueue", "--page", "lilly-1", "--resource", "transactions.backfill"]);
    expect(again[0]).toMatch(/merged into open work/);
  });
});

