import { randomUUID } from "node:crypto";
import { setTimeout as sleep } from "node:timers/promises";

import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import {
  acquirePageSyncLease,
  acquireTargetedPageSyncLease,
  beginFanslyWsConnection,
  captureFanslyWsFrame,
  createFanslyPage,
  createModel,
  createOnlyFansPage,
  ensurePageSyncStates,
  ensureSyncPage,
  FANSLY_SYNC_ENGINE_HYDRATION_LANE,
  getFanslyFastLanePageSyncGate,
  getFanslySyncLiveness,
  getProjectionWatermark,
  insertAgentKey,
  isFanslyPageEngineOwned,
  listAutoApprovableAgentHydrationRequests,
  listDispatchableAgentHydrationRequests,
  listDispatchingAgentHydrationRequests,
  listEngineOwnedFanslyPages,
  listExpirableAgentHydrationRequests,
  listPendingFanslyWsLiveReceipts,
  listRunnablePageSync,
  listStuckAgentHydrationDispatches,
  markPageSyncEnqueued,
  releaseTargetedPageSyncLease,
  requestPageSync,
  routeFanslyWsHintEvent,
  startSyncRun,
  upsertFanPages,
  upsertFans,
  upsertPageDmConversation,
  upsertPageDmMessages,
  appendDomainEvents,
  type SyncPageMode,
} from "@agency_hub_core/db";
import { FANSLY_WS_CAPTURE_KIND } from "@agency_hub_core/shared";

import { buildApiServer } from "../apps/runtime/src/api/server.ts";
import type { AppContext } from "../apps/runtime/src/bootstrap.ts";
import { downloadAiMediaThroughPageEgress } from "../apps/runtime/src/services/ai-media-describe/worker.ts";
import {
  reconcileAgentHydrationDispatches,
  sweepStuckAgentHydration,
} from "../apps/runtime/src/services/agent-hydration.ts";
import { createUserAccount } from "../apps/runtime/src/services/auth.ts";
import { runCanonicalization } from "../apps/runtime/src/services/canonicalize-driver.ts";
import { readFanslyPageGeneration } from "../apps/runtime/src/services/egress/fansly-probe-context.ts";
import * as socketTransport from "../apps/runtime/src/services/egress/fansly-receiver-socket.ts";
import { runFanslyEndpointProbe } from "../apps/runtime/src/services/fansly-endpoint-probe.ts";
import { backfillFanslyPageAliases } from "../apps/runtime/src/services/fansly-page-alias-backfill.ts";
import { runFanslyReplayProbe } from "../apps/runtime/src/services/fansly-replay-probe.ts";
import { reconcileRecentFanslyWsDeletions } from "../apps/runtime/src/services/fansly-ws-deletions.ts";
import { applyFanslyWsPolicyRepair } from "../apps/runtime/src/services/fansly-ws-policy-repair.ts";
import { startFanslyWsWorker, type FanslyWsWorkerTiming } from "../apps/runtime/src/services/fansly-ws/worker.ts";
import { saveProxy } from "../apps/runtime/src/services/page-context.ts";
import { setPageProxy } from "../apps/runtime/src/services/page-proxies.ts";
import {
  FANSLY_WS_HINT_PROJECTION,
  runFanslyWsHintProjection,
} from "../apps/runtime/src/services/projections/fansly-ws-hints.ts";
import { runMessageArchiveProjection } from "../apps/runtime/src/services/projections/message-archive.ts";
import {
  FANSLY_PAGE_ON_SYNC_ENGINE_CODE,
  FanslyPageOnSyncEngineError,
} from "../apps/runtime/src/services/sync-engine-guard.ts";
import { engineOwnedRefusalLine, refuseEngineOwnedPage } from "../scripts/fansly-ws/engine-owned.ts";
import {
  resetIntegrationDatabase,
  seedFanslyPage,
  startIntegrationTestDatabase,
  type StartedTestDatabase,
} from "./helpers/db.ts";
import { createTestAppContext } from "./helpers/runtime.ts";

// Step-3 design §3.1 (S3-01): the legacy fences of a page the Fansly Sync
// Engine owns. With `sync_pages.mode` written directly, a page in `handover` or
// `live` is invisible to every legacy scheduler and refused by every legacy
// lever, while an `off`, a `shadow` and an OnlyFans page (no `sync_pages` row)
// behave exactly as before (J8); leaving to `off` restores the legacy engine
// with no other action.

// Fixture passwords hash at minimum cost (the owner routes below).
vi.mock("argon2", () => import("./helpers/cheap-argon2.ts"));

let testDb: StartedTestDatabase | null = null;

beforeAll(async () => {
  testDb = await startIntegrationTestDatabase();
}, 120_000);

afterAll(async () => {
  await testDb?.stop();
});

beforeEach(async (context) => {
  if (!testDb) return context.skip();
  await resetIntegrationDatabase(testDb.pool);
});

function db() {
  if (!testDb) throw new Error("no test database");
  return testDb;
}

/** The mode as the switch would leave it, written directly (no capability). */
async function setMode(pageId: number, mode: SyncPageMode) {
  await ensureSyncPage(db().db, { pageId });
  await db().pool.query(
    "update sync_pages set mode = $2, mode_changed_at = clock_timestamp(), mode_changed_by = 'test' where page_id = $1",
    [pageId, mode],
  );
}

const ENGINE_MODES = ["handover", "live"] as const satisfies readonly SyncPageMode[];

/** A Fansly page with a stored session (tests/helpers/db.ts `seedFanslyPage`). */
async function seedPage(app: ReturnType<typeof createTestAppContext>, label = "lora-main") {
  const { page } = await seedFanslyPage(app.db, app.config.encryptionKey, 1, label);
  if (!page) throw new Error("page missing");
  return page;
}

/** One page per case: `handover`, `live`, `off`, `shadow` (Fansly) and an
 *  OnlyFans page without a `sync_pages` row. */
async function seedFencePages() {
  const model = await createModel(db().db, { slug: `fence-${randomUUID().slice(0, 8)}`, name: "Fence" });
  if (!model) throw new Error("model missing");
  const fansly = async (label: string, mode: SyncPageMode) => {
    const page = await createFanslyPage(db().db, { modelId: model.id, label });
    if (!page) throw new Error("page missing");
    await setMode(page.id, mode);
    return page;
  };
  const handover = await fansly("fence-handover", "handover");
  const live = await fansly("fence-live", "live");
  const off = await fansly("fence-off", "off");
  const shadow = await fansly("fence-shadow", "shadow");
  const onlyfans = await createOnlyFansPage(db().db, { modelId: model.id, label: "fence-of" });
  if (!onlyfans) throw new Error("page missing");
  return { model, handover, live, off, shadow, onlyfans };
}

/** Every stream of the page settled except `stream`, which holds a runnable
 *  request. */
async function pendingStream(pageId: number, stream: "light" | "dm_messages", now: Date) {
  await ensurePageSyncStates(db().db, { pageId, now });
  await db().pool.query(
    `update page_sync_states
        set applied_seq = request_seq, status = 'idle', succeeded_at = $3,
            blocker_kind = null, blocker_code = null, blocker_message = null, blocked_at = null
      where page_id = $1 and stream <> $2`,
    [pageId, stream, now],
  );
  await requestPageSync(db().db, { pageId, streams: [stream], source: "recovery", now });
  await db().pool.query(
    `update page_sync_states
        set status = 'pending', blocker_kind = null, blocker_code = null, blocker_message = null, blocked_at = null,
            retry_at = null, retry_kind = null, leased_seq = null, lease_token = null, enqueued_at = null
      where page_id = $1 and stream = $2`,
    [pageId, stream],
  );
}

describe("(a) the legacy page-sync schedulers", () => {
  it("never enqueue or lease a stream of a page the engine owns, and resume when it leaves", async () => {
    const pages = await seedFencePages();
    const now = new Date();
    const all = [pages.handover, pages.live, pages.off, pages.shadow, pages.onlyfans];
    for (const page of all) await pendingStream(page.id, "light", now);
    const legacy = [pages.off.id, pages.shadow.id, pages.onlyfans.id].sort((a, b) => a - b);

    expect((await listRunnablePageSync(db().db, now)).map((row) => row.pageId).sort((a, b) => a - b))
      .toEqual(legacy);

    for (const page of all) await markPageSyncEnqueued(db().db, page.id, now);
    const enqueued = await db().pool.query<{ page_id: string; enqueued: boolean }>(
      `select page_id::text, enqueued_at is not null as enqueued from page_sync_states
        where stream = 'light' and page_id = any($1::bigint[]) order by page_id`,
      [all.map((page) => page.id)],
    );
    expect(Object.fromEntries(enqueued.rows.map((row) => [Number(row.page_id), row.enqueued]))).toEqual({
      [pages.handover.id]: false, [pages.live.id]: false,
      [pages.off.id]: true, [pages.shadow.id]: true, [pages.onlyfans.id]: true,
    });

    const targeted = async (pageId: number) => acquireTargetedPageSyncLease(db().db, {
      pageId, stream: "light", workerId: "targeted", leaseToken: randomUUID(), leaseTtlMs: 60_000, now,
    });
    for (const page of [pages.handover, pages.live]) expect(await targeted(page.id)).toBeNull();
    for (const page of [pages.off, pages.shadow, pages.onlyfans]) {
      const lease = await targeted(page.id);
      expect(lease).toMatchObject({ pageId: page.id, stream: "light" });
      await releaseTargetedPageSyncLease(db().db, { pageId: page.id, stream: "light", leaseToken: lease!.leaseToken });
    }

    const lease = (pageId: number) => acquirePageSyncLease(db().db, {
      pageId, workerId: "executor", leaseToken: randomUUID(), leaseTtlMs: 60_000, now,
    });
    for (const page of [pages.handover, pages.live]) expect(await lease(page.id)).toBeNull();
    for (const page of [pages.off, pages.shadow, pages.onlyfans]) {
      expect(await lease(page.id)).toMatchObject({ pageId: page.id, stream: "light", status: "running" });
    }
    // Nothing of the engine's pages was touched: still pending, unleased.
    const engineRows = await db().pool.query(
      `select status, leased_seq, enqueued_at from page_sync_states
        where stream = 'light' and page_id = any($1::bigint[])`,
      [[pages.handover.id, pages.live.id]],
    );
    expect(engineRows.rows).toEqual([
      { status: "pending", leased_seq: null, enqueued_at: null },
      { status: "pending", leased_seq: null, enqueued_at: null },
    ]);

    // Leaving to `off` (the rollback's last step) restores the page at once.
    await setMode(pages.handover.id, "off");
    expect((await listRunnablePageSync(db().db, now)).map((row) => row.pageId)).toContain(pages.handover.id);
    expect(await lease(pages.handover.id)).toMatchObject({ pageId: pages.handover.id, stream: "light" });
  });

  it("the repository readers name the engine's pages and only them", async () => {
    const pages = await seedFencePages();
    expect(await listEngineOwnedFanslyPages(db().db)).toEqual([
      { pageId: pages.handover.id, label: "fence-handover", mode: "handover" },
      { pageId: pages.live.id, label: "fence-live", mode: "live" },
    ]);
    expect(await isFanslyPageEngineOwned(db().db, pages.live.id)).toEqual({ owned: true, mode: "live" });
    expect(await isFanslyPageEngineOwned(db().db, pages.shadow.id)).toEqual({ owned: false, mode: "shadow" });
    expect(await isFanslyPageEngineOwned(db().db, pages.onlyfans.id)).toEqual({ owned: false, mode: null });
  });
});

describe("(b) the sync_silent deadman", () => {
  it.each(ENGINE_MODES)("ignores a %s page's due streams and runs", async (mode) => {
    const model = await createModel(db().db, { slug: "silent", name: "Silent" });
    const page = await createFanslyPage(db().db, { modelId: model!.id, label: "silent" });
    await setMode(page!.id, mode);
    const now = new Date();
    await pendingStream(page!.id, "light", new Date(now.getTime() - 3_600_000));
    const run = await startSyncRun(db().db, {
      platformAccountId: page!.id, stream: "light", trigger: "scheduled", startedAt: new Date(now.getTime() - 60_000),
    });
    const window = { since: new Date(now.getTime() - 3_600_000), dueBefore: now };

    expect(await getFanslySyncLiveness(db().db, window)).toEqual({ latestStartedAt: null, hasDueStream: false });

    await setMode(page!.id, "off");
    expect(await getFanslySyncLiveness(db().db, window)).toEqual({
      latestStartedAt: run!.startedAt, hasDueStream: true,
    });
  });
});

describe("(c) the AI fast lane's page gate", () => {
  it("holds a page the engine owns and no other", async () => {
    const pages = await seedFencePages();
    const now = new Date();
    for (const page of [pages.handover, pages.live, pages.off, pages.shadow]) {
      await ensurePageSyncStates(db().db, { pageId: page.id, now });
      await db().pool.query(
        `update page_sync_states set status = 'idle', blocker_kind = null, blocker_code = null,
                blocker_message = null, blocked_at = null, retry_at = null, retry_kind = null
          where page_id = $1`,
        [page.id],
      );
    }
    for (const page of [pages.handover, pages.live]) {
      expect(await getFanslyFastLanePageSyncGate(db().db, { pageId: page.id, now }))
        .toEqual({ cooldown: false, held: true });
    }
    for (const page of [pages.off, pages.shadow]) {
      expect(await getFanslyFastLanePageSyncGate(db().db, { pageId: page.id, now }))
        .toEqual({ cooldown: false, held: false });
    }
  });
});

describe("(d) agent hydration", () => {
  const DAY_MS = 86_400_000;
  const hex = (char: string) => char.repeat(64);

  async function seedKey(pageIds: number[]) {
    const key = await insertAgentKey(db().db, {
      name: "fence", keyPrefix: "agency_hub_agent_fence", keyDigest: hex("d"),
      capabilities: ["read:messages", "request:hydration"], pageIds,
      dailyRequestBudget: 5000, dailyRowBudget: 500_000,
      expiresAt: new Date(Date.now() + 30 * DAY_MS), createdBy: null,
    });
    return key.id;
  }

  async function seedRequest(input: {
    keyId: number;
    pageId: number;
    state: "requested" | "approved" | "dispatching";
    executionLane?: string | null;
    expiresAt?: Date;
    dispatchDeadlineAt?: Date | null;
  }): Promise<number> {
    const approved = input.state !== "requested";
    const result = await db().pool.query<{ id: string }>(
      `insert into agent_hydration_requests (
          request_ref, agent_key_id, page_id, conversation_ref, state, target_before_message_ref,
          reason_sha256, reason_length, idempotency_key, request_fingerprint, coverage_fingerprint, admissible,
          expires_at, decided_at, decision_approved, decision_source, decision_allow_mark_read, decision_max_calls,
          dispatched_at, dispatch_deadline_at, execution_lane, execution_ref)
        values (gen_random_uuid(), $1, $2, $3, $4::text, '1000', $5, 10, gen_random_uuid(), $5, $5, true,
          $6::timestamptz, case when $7::boolean then now() end, case when $7::boolean then true end,
          case when $7::boolean then 'owner' end, case when $7::boolean then false end,
          case when $7::boolean then 10 end,
          case when $4::text = 'dispatching' then now() end, $8::timestamptz, $9::text,
          case when $9::text is not null then 'ref' end)
        returning id::text as id`,
      [
        input.keyId, input.pageId, `group-${randomUUID().slice(0, 8)}`, input.state, hex("a"),
        input.expiresAt ?? new Date(Date.now() + DAY_MS), approved,
        input.dispatchDeadlineAt ?? null, input.executionLane ?? null,
      ],
    );
    return Number(result.rows[0]!.id);
  }

  it("neither dispatches nor auto-approves a request of a page the engine owns", async () => {
    const pages = await seedFencePages();
    const keyId = await seedKey([pages.handover.id, pages.live.id, pages.off.id, pages.shadow.id, pages.onlyfans.id]);
    const approved: Record<string, number> = {};
    const requested: Record<string, number> = {};
    for (const [name, page] of Object.entries({
      handover: pages.handover, live: pages.live, off: pages.off, shadow: pages.shadow,
    })) {
      approved[name] = await seedRequest({ keyId, pageId: page.id, state: "approved" });
      requested[name] = await seedRequest({ keyId, pageId: page.id, state: "requested" });
    }
    approved.onlyfans = await seedRequest({ keyId, pageId: pages.onlyfans.id, state: "approved" });

    const dispatchable = await listDispatchableAgentHydrationRequests(db().db, { limit: 50 });
    expect(dispatchable.map((row) => row.id).sort((a, b) => a - b))
      .toEqual([approved.off!, approved.shadow!, approved.onlyfans!].sort((a, b) => a - b));

    // Auto-approval: the policy approves one request per page at a time, so
    // the pages' approved rows go first.
    await db().pool.query("delete from agent_hydration_requests where state = 'approved'");
    const candidates = await listAutoApprovableAgentHydrationRequests(db().db, {
      limit: 50, utcDayStart: new Date(Date.now() - DAY_MS),
    });
    expect(candidates.map((row) => row.id).sort((a, b) => a - b))
      .toEqual([requested.off!, requested.shadow!].sort((a, b) => a - b));

    // Back to `off`: both lists see the page again.
    await setMode(pages.live.id, "off");
    expect((await listAutoApprovableAgentHydrationRequests(db().db, {
      limit: 50, utcDayStart: new Date(Date.now() - DAY_MS),
    })).map((row) => row.id)).toContain(requested.live!);
  });

  it("leaves the engine's rows to the engine: no expiry, no reconcile, no stuck sweep", async () => {
    const pages = await seedFencePages();
    const keyId = await seedKey([pages.live.id, pages.off.id]);
    const past = new Date(Date.now() - 60_000);
    const engineDispatching = await seedRequest({
      keyId, pageId: pages.live.id, state: "dispatching",
      executionLane: FANSLY_SYNC_ENGINE_HYDRATION_LANE, dispatchDeadlineAt: past,
    });
    // Not a shape the wrapper writes; it pins that the lane alone decides.
    const engineRequested = await seedRequest({
      keyId, pageId: pages.live.id, state: "requested", executionLane: FANSLY_SYNC_ENGINE_HYDRATION_LANE, expiresAt: past,
    });
    const legacyDispatching = await seedRequest({
      keyId, pageId: pages.off.id, state: "dispatching", executionLane: "vendor_paid_low", dispatchDeadlineAt: past,
    });
    const legacyRequested = await seedRequest({ keyId, pageId: pages.off.id, state: "requested", expiresAt: past });

    expect((await listStuckAgentHydrationDispatches(db().db, { limit: 50 })).map((row) => row.id))
      .toEqual([legacyDispatching]);
    expect((await listDispatchingAgentHydrationRequests(db().db, { limit: 50 })).map((row) => row.id))
      .toEqual([legacyDispatching]);
    expect((await listExpirableAgentHydrationRequests(db().db, { limit: 50 })).map((row) => row.id))
      .toEqual([legacyRequested]);

    // The runtime sweeps on the engine's rows alone change nothing.
    await db().pool.query("delete from agent_hydration_requests where id = any($1::bigint[])",
      [[legacyDispatching, legacyRequested]]);
    const app = createTestAppContext(db());
    expect(await reconcileAgentHydrationDispatches(app, {} as never)).toBe(0);
    expect(await sweepStuckAgentHydration(app, {} as never)).toBe(0);
    const rows = await db().pool.query(
      "select id::int as id, state from agent_hydration_requests order by id",
    );
    expect(rows.rows).toEqual([
      { id: engineDispatching, state: "dispatching" },
      { id: engineRequested, state: "requested" },
    ]);
  });
});

// ── (e) the legacy WS supervisor ────────────────────────────────────────────

// Production timing scaled down 10x, as tests/fansly-b0.integration.test.ts.
const scaled: FanslyWsWorkerTiming = {
  configPollMs: 1_000, configStaleMs: 2_000, pagePauseMs: 1_000, backoffBaseMs: 150,
  authTimeoutMs: 1_000, checkMs: 500, guardStaleMs: 1_500, pingMs: 2_000, pongTimeoutMs: 3_000,
  drainMs: 2_000, applyDrainMs: 1_500,
};

function frame(fan: string) {
  return JSON.stringify({ t: 10001, d: JSON.stringify([
    { t: 10000, d: JSON.stringify({ serviceId: 5, event: JSON.stringify({ type: 1, data: { accountId: fan } }) }) },
  ]) });
}

async function wsLockHolders(pageId: number): Promise<number> {
  const result = await db().pool.query<{ n: number }>(
    `select count(*)::int as n from pg_locks
      where locktype = 'advisory' and classid = 58213 and objid = $1 and objsubid = 2 and granted
        and database = (select oid from pg_database where datname = current_database())`,
    [pageId],
  );
  return result.rows[0]!.n;
}

async function wsFixture(label: string) {
  const app = createTestAppContext(db(), { databaseUrl: db().connectionString });
  const page = await seedPage(app, label);
  await saveProxy(app, page.id, { url: "http://proxy.example.test:8080", username: "test", password: "test" });
  await db().pool.query("update pages set external_page_id = '999' where id = $1", [page.id]);
  await setMode(page.id, "off");
  app.config.fanslyWsCaptureEnabled = true;
  app.config.fanslyWsCapturePageAllowlist = page.label;
  const stops: ReturnType<typeof vi.fn>[] = [];
  let active: EventTarget | null = null;
  const open = vi.spyOn(socketTransport, "openFanslyReceiverSocket").mockImplementation(() => {
    const stop = vi.fn();
    stops.push(stop);
    const socket = Object.assign(new EventTarget(), { send: vi.fn((data: string) => {
      if (data === "p") socket.dispatchEvent(new MessageEvent("message", { data: '{"t":2,"d":"{}"}' }));
    }) });
    active = socket;
    queueMicrotask(() => {
      socket.dispatchEvent(new Event("open"));
      socket.dispatchEvent(new MessageEvent("message", { data: '{"t":1,"d":"{}"}' }));
      socket.dispatchEvent(new MessageEvent("message", { data: frame("123") }));
    });
    return { socket, stop } as unknown as ReturnType<typeof socketTransport.openFanslyReceiverSocket>;
  });
  const observations = async () => (await db().pool.query<{ n: number }>(
    "select count(*)::int as n from observations where source = 'fansly_ws'",
  )).rows[0]!.n;
  return { app, page, open, stops, observations, deliver: (raw: string) => active!.dispatchEvent(new MessageEvent("message", { data: raw })) };
}

describe("(e) the legacy WS supervisor", () => {
  it("drops a page entering handover within one poll: frames drained, lock released, row closed", async () => {
    const f = await wsFixture("fence-ws");
    const worker = startFanslyWsWorker(f.app, { timing: scaled });
    try {
      await vi.waitFor(async () => expect(await f.observations()).toBe(1), { timeout: 10_000 });
      await vi.waitFor(async () => expect((await db().pool.query(
        "select count(*)::int as n from fansly_ws_connections where verified_at is not null",
      )).rows[0].n).toBe(1), { timeout: 5_000 });
      expect(await wsLockHolders(f.page.id)).toBe(1);

      // A frame already received when the switch fences the page.
      f.deliver(frame("456"));
      const changedAt = Date.now();
      await setMode(f.page.id, "handover");
      await vi.waitFor(() => expect(f.stops[0]).toHaveBeenCalledOnce(), { timeout: 10_000 });
      // One poll, as the step-1 live-off bound (tests/fansly-b0.integration.test.ts).
      expect(Date.now() - changedAt).toBeLessThan(scaled.configPollMs + scaled.configStaleMs + scaled.checkMs);

      await vi.waitFor(async () => expect((await db().pool.query(
        "select stop_reason, closed_at is not null as closed from fansly_ws_connections where page_id = $1",
        [f.page.id],
      )).rows).toEqual([{ stop_reason: "disabled", closed: true }]), { timeout: 10_000 });
      await vi.waitFor(async () => expect(await wsLockHolders(f.page.id)).toBe(0), { timeout: 10_000 });
      // Both frames were captured and applied before the attempt closed.
      expect(await f.observations()).toBe(2);
      expect(await listPendingFanslyWsLiveReceipts(f.app.db, { limit: 10, pageId: f.page.id })).toEqual([]);

      // The supervisor does not come back while the engine owns the page.
      await sleep(2 * scaled.configPollMs + 200);
      expect(f.open).toHaveBeenCalledOnce();
      expect(await wsLockHolders(f.page.id)).toBe(0);

      // Leaving to `off` restores it with no other action.
      await setMode(f.page.id, "off");
      await vi.waitFor(() => expect(f.open).toHaveBeenCalledTimes(2), { timeout: 10_000 });
    } finally {
      await worker.stop();
      f.open.mockRestore();
    }
  });

  it("never opens the socket of a page the engine already owns", async () => {
    const f = await wsFixture("fence-ws-live");
    await setMode(f.page.id, "live");
    const worker = startFanslyWsWorker(f.app, { timing: scaled });
    try {
      await sleep(2 * scaled.configPollMs + 200);
      expect(f.open).not.toHaveBeenCalled();
      expect(await wsLockHolders(f.page.id)).toBe(0);
      expect((await db().pool.query("select count(*)::int as n from fansly_ws_connections")).rows[0].n).toBe(0);
    } finally {
      await worker.stop();
      f.open.mockRestore();
    }
  });

  it("waits off the reconnect ladder, without a failure of its own, while the guard row is the engine's", async () => {
    const f = await wsFixture("fence-ws-guard");
    await db().pool.query(
      "insert into fansly_page_send_guards (page_id, last_completed_at, next_u) values ($1, now() - interval '1 hour', 0) on conflict (page_id) do nothing",
      [f.page.id],
    );
    await db().pool.query(
      "update fansly_page_send_guards set owner_engine = 'fansly_sync_engine', engine_switched_at = now() where page_id = $1",
      [f.page.id],
    );
    const warn = vi.spyOn(f.app.logger, "warn");
    const worker = startFanslyWsWorker(f.app, { timing: scaled });
    try {
      await vi.waitFor(
        () => expect(f.app.fanslySendGuards!.counters.engineOwnedRefusals).toBeGreaterThanOrEqual(2),
        { timeout: 10_000 },
      );
      expect(f.open).not.toHaveBeenCalled();
      // Only the guard's own refusal is logged; the supervisor reports no
      // failure of its own.
      expect(new Set(warn.mock.calls.map((call) => call[1])))
        .toEqual(new Set(["Fansly page is owned by the Fansly Sync Engine; the legacy sender stops"]));
      expect((await db().pool.query("select count(*)::int as n from fansly_ws_connections")).rows[0].n).toBe(0);
    } finally {
      await worker.stop();
      f.open.mockRestore();
      warn.mockRestore();
    }
  });
});

// ── (f) the ws-hints projector, (i) the minutely deletion reconcile ──────────

const GENERATION = "a".repeat(64);
const GROUP = "100";
const FAN = "111";
let receiptId = 9_000;

async function seedThread(app: ReturnType<typeof createTestAppContext>, pageId: number, base: Date) {
  const [fan] = await upsertFans(app.db, [{ platform: "fansly", platformUserId: FAN }]);
  const thread = await upsertPageDmConversation(app.db, {
    platformAccountId: pageId, fanId: fan!.id, platformConversationId: GROUP,
    partnerPlatformUserId: FAN, partnerUsername: null, partnerDisplayName: null,
    conversationFlags: 0, unreadCount: 0, subscriptionTierId: null,
    lastMessageId: "150", lastUnreadMessageId: null, lastMessageAt: new Date(base.getTime() + 60_000),
    lastMessageSenderId: FAN, lastMessageSenderRole: "fan", lastMessagePreview: "second",
    messageCoverageStatus: "complete", newestStoredMessageId: "150", oldestStoredMessageId: "149",
    storedMessageCount: 2, lastMessageSyncAt: new Date(base.getTime() + 120_000), isVisible: true,
    lastSeenGeneration: 1, metadata: {},
  });
  if (!thread) throw new Error("thread missing");
  const message = (id: string, offsetMs: number, content: string) => ({
    conversationId: thread.id, platformAccountId: pageId, platformMessageId: id,
    senderPlatformUserId: FAN, senderRole: "fan" as const, createdAt: new Date(base.getTime() + offsetMs),
    content, totalTipAmountCents: 0, inReplyToMessageId: null, inReplyToRootMessageId: null,
  });
  await upsertPageDmMessages(app.db, [message("149", 0, "first"), message("150", 60_000, "second")]);
  const event = (ref: string, occurredAt: Date, text: string) => ({
    type: "message.received", occurredAt, fanIdentityRef: FAN, conversationRef: GROUP, messageRef: ref,
    transactionRef: null, data: { text, tipAmountMills: 0, isTip: false }, schemaVersion: 1,
    observationId: 1, dedupKey: `msg:received:${ref}`,
  });
  await appendDomainEvents(app.db, pageId, [
    event("149", base, "first"), event("150", new Date(base.getTime() + 60_000), "second"),
  ]);
  await runMessageArchiveProjection(app, { accountId: pageId });
  return thread;
}

async function threadWindow(id: number) {
  return (await db().pool.query(
    `select stored_message_count, newest_stored_message_id, oldest_stored_message_id
       from page_dm_threads where id = $1`,
    [id],
  )).rows[0];
}

async function deletedAt(table: "page_dm_messages" | "message_archive", ref: string, pageId: number) {
  const column = table === "page_dm_messages" ? "platform_account_id" : "account_id";
  const ref_column = table === "page_dm_messages" ? "platform_message_id" : "message_ref";
  return (await db().pool.query(
    `select deleted_at from ${table} where ${column} = $1 and ${ref_column} = $2`, [pageId, ref],
  )).rows[0]?.deleted_at ?? null;
}

describe("(f) the ws-hints projector", () => {
  type App = ReturnType<typeof createTestAppContext>;
  /** One socket frame the legacy worker captured a minute ago, canonicalized
   *  into its `fansly.ws_signal_observed` event. */
  async function signal(app: App, pageId: number, event: Record<string, unknown>, generation = GENERATION) {
    const connectionId = randomUUID();
    await beginFanslyWsConnection(db().db, { id: connectionId, pageId, generation });
    await captureFanslyWsFrame(db().db, {
      connectionId, pageId, generation, accountRef: "999", ordinal: 1, receivedAt: new Date(Date.now() - 60_000),
      frame: JSON.stringify({ t: 10000, d: { serviceId: 5, event } }),
      validate: async () => {},
    });
    expect(await runCanonicalization(app, { accountId: pageId, kinds: [FANSLY_WS_CAPTURE_KIND] }))
      .toMatchObject({ errored: 0, stamped: 1 });
  }
  const deletion = { type: 10, message: { id: "150", groupId: GROUP, correlationId: "77", type: 1 } };
  const created = (id: string) => ({ type: 1, message: { id, groupId: GROUP, content: "hello" } });
  /** A hint policy in force for the page (the step-1 B1 rollout shape). */
  async function enableHints(app: App, page: { id: number; label: string }) {
    await saveProxy(app, page.id, { url: "http://proxy.example.test:8080", username: "test", password: "test" });
    const generation = await readFanslyPageGeneration(app.db, page.label);
    Object.assign(app.config, {
      fanslyWsCaptureEnabled: true, fanslyWsCapturePageAllowlist: page.label,
      fanslyWsHintsEnabled: true, fanslyWsHintsPageAllowlist: page.label,
      fanslyWsHintsTypeAllowlist: "message_created",
      fanslyWsHintsPolicies: JSON.stringify({ [page.label]: {
        generation, activationAt: "2026-01-01T00:00:00Z", baselineAttempts24h: 1000, baselineReference: "fixture",
      } }),
    });
    return generation;
  }
  const outcomes = async (pageId: number) => (await db().pool.query<{ message_ref: string; outcome: string }>(
    "select message_ref, outcome from fansly_ws_hint_receipts where page_id = $1 order by event_id", [pageId],
  )).rows;
  const dirtyQueue = async (pageId: number) => (await db().pool.query(
    "select subject_ref, requested_revision from subject_refresh_state where page_id = $1 order by subject_ref", [pageId],
  )).rows;
  const dmWake = async (pageId: number) => (await db().pool.query<{ request_seq: string }>(
    "select request_seq::text from page_sync_states where page_id = $1 and stream = 'dm_messages'", [pageId],
  )).rows[0]?.request_seq ?? null;
  const headSeq = async (pageId: number) => Number((await db().pool.query<{ seq: string }>(
    "select max(account_seq)::text as seq from domain_events where account_id = $1", [pageId],
  )).rows[0]!.seq);

  it.each(ENGINE_MODES)(
    "on a %s page files every receipt under no policy: deletions as debt, hints disabled, no dirty queue, no wake",
    async (mode) => {
      const app = createTestAppContext(db());
      const page = await seedPage(app);
      const generation = await enableHints(app, page);
      await setMode(page.id, "shadow");
      // Before the switch: the hint routes and wakes the DM stream (J8).
      await signal(app, page.id, created("149"), generation);
      expect(await runFanslyWsHintProjection(app, { accountId: page.id })).toMatchObject({ applied: 1 });
      expect(await dirtyQueue(page.id)).toEqual([{ subject_ref: GROUP, requested_revision: 1n }]);
      const woken = await dmWake(page.id);
      expect(woken).not.toBeNull();
      // That run finished: an event wake reaches only an idle stream.
      await db().pool.query(
        `update page_sync_states set status = 'idle', applied_seq = request_seq,
            leased_seq = null, lease_token = null, lease_expires_at = null
          where page_id = $1`,
        [page.id],
      );

      // Frames the legacy socket captured before the switch, projected after it.
      await signal(app, page.id, created("151"), generation);
      await signal(app, page.id, deletion, generation);
      await setMode(page.id, mode);
      const result = await runFanslyWsHintProjection(app, { accountId: page.id });
      expect(result).toMatchObject({ accounts: 1, applied: 0 });
      expect(await getProjectionWatermark(app.db, FANSLY_WS_HINT_PROJECTION, page.id)).toBe(await headSeq(page.id));
      // The deletion keeps its receipt (the reconcile's only evidence); the
      // hint is filed but routes nothing.
      expect(await outcomes(page.id)).toEqual([
        { message_ref: "149", outcome: "routed" },
        { message_ref: "151", outcome: "disabled" },
        { message_ref: "150", outcome: "mutation_debt" },
      ]);
      expect(await dirtyQueue(page.id)).toEqual([{ subject_ref: GROUP, requested_revision: 1n }]);
      // The routed subject is still due, yet the fenced stream is not woken.
      expect(await dmWake(page.id)).toBe(woken);

      // Back to `off`: the same due subject wakes the stream again.
      await setMode(page.id, "off");
      await runFanslyWsHintProjection(app, { accountId: page.id });
      expect(Number(await dmWake(page.id))).toBeGreaterThan(Number(woken));
    },
  );

  it("a deletion captured before the switch and projected after it is still marked, also after a phase-B revert", async () => {
    const app = createTestAppContext(db());
    const page = await seedPage(app);
    await setMode(page.id, "shadow");
    const thread = await seedThread(app, page.id, new Date(Date.now() - 3_600_000));
    // Acked in shadow: the engine's `dm-live.deletions` closes it without a write.
    await signal(app, page.id, deletion);
    await setMode(page.id, "handover");
    await runFanslyWsHintProjection(app, { accountId: page.id });
    const before = await threadWindow(thread.id);
    expect(await reconcileRecentFanslyWsDeletions(app, { accountId: page.id }))
      .toEqual({ hotMarked: 1, archiveMarked: 1, windowsRepaired: 0 });
    expect(await deletedAt("page_dm_messages", "150", page.id)).toBeInstanceOf(Date);
    expect(await deletedAt("message_archive", "150", page.id)).toBeInstanceOf(Date);
    // The window is the engine's while it owns the page.
    expect(await threadWindow(thread.id)).toEqual(before);

    // Phase B times out: back to shadow, the reconcile re-derives the window.
    await setMode(page.id, "shadow");
    expect(await reconcileRecentFanslyWsDeletions(app, { accountId: page.id }))
      .toEqual({ hotMarked: 0, archiveMarked: 0, windowsRepaired: 1 });
    expect(await threadWindow(thread.id)).toEqual({
      stored_message_count: 1, newest_stored_message_id: "149", oldest_stored_message_id: "149",
    });
  });

  it("on a shadow page routes as before", async () => {
    const app = createTestAppContext(db());
    const page = await seedPage(app);
    await setMode(page.id, "shadow");
    await signal(app, page.id, deletion);
    await runFanslyWsHintProjection(app, { accountId: page.id });
    // The deletion's mutation_debt receipt, as before the step-3 fences.
    expect(await outcomes(page.id)).toEqual([{ message_ref: "150", outcome: "mutation_debt" }]);
    expect(await getProjectionWatermark(app.db, FANSLY_WS_HINT_PROJECTION, page.id)).toBe(await headSeq(page.id));
  });
});

describe("(i) the minutely deletion reconcile", () => {
  async function fixture(mode: SyncPageMode) {
    const app = createTestAppContext(db());
    const page = await seedPage(app);
    const thread = await seedThread(app, page.id, new Date(Date.now() - 3_600_000));
    // The receipt the hint projector filed before the switch.
    const id = ++receiptId;
    await routeFanslyWsHintEvent(db().db, {
      id, pageId: page.id, observationId: id, receivedAt: new Date(Date.now() - 120_000), generation: GENERATION,
      node: { path: [], outcome: "mutation_debt", mutation: {
        messageRef: "150", groupRef: GROUP, correlationRef: "77", bulk: false,
      } },
    }, null);
    await setMode(page.id, mode);
    return { app, page, thread };
  }

  it("marks a receipt's rows on an engine page but writes none of its window columns", async () => {
    const f = await fixture("live");
    const before = await threadWindow(f.thread.id);
    expect(await reconcileRecentFanslyWsDeletions(f.app, { accountId: f.page.id }))
      .toEqual({ hotMarked: 1, archiveMarked: 1, windowsRepaired: 0 });
    expect(await deletedAt("page_dm_messages", "150", f.page.id)).toBeInstanceOf(Date);
    expect(await deletedAt("message_archive", "150", f.page.id)).toBeInstanceOf(Date);
    // The window still counts the marked row: on an engine page it is the
    // engine's to recompute, and the drift pass leaves it alone too.
    expect(await threadWindow(f.thread.id)).toEqual(before);
    expect(await reconcileRecentFanslyWsDeletions(f.app, { accountId: f.page.id }))
      .toEqual({ hotMarked: 0, archiveMarked: 0, windowsRepaired: 0 });
    expect(await threadWindow(f.thread.id)).toEqual(before);

    // Back to `off`: the drift pass re-derives the window on the next pass.
    await setMode(f.page.id, "off");
    expect(await reconcileRecentFanslyWsDeletions(f.app, { accountId: f.page.id }))
      .toEqual({ hotMarked: 0, archiveMarked: 0, windowsRepaired: 1 });
    expect(await threadWindow(f.thread.id)).toEqual({
      stored_message_count: 1, newest_stored_message_id: "149", oldest_stored_message_id: "149",
    });
  });

  it("refreshes the window with the mark on an off page", async () => {
    const f = await fixture("off");
    expect(await reconcileRecentFanslyWsDeletions(f.app, { accountId: f.page.id }))
      .toEqual({ hotMarked: 1, archiveMarked: 1, windowsRepaired: 0 });
    expect(await threadWindow(f.thread.id)).toEqual({
      stored_message_count: 1, newest_stored_message_id: "149", oldest_stored_message_id: "149",
    });
  });
});

// ── (g) the /account/me levers, the probes, the scripts ─────────────────────

describe("(g) the legacy levers refuse an engine page with a 409 and send nothing", () => {
  function adapterSpies() {
    return {
      getAccountMe: vi.fn(async () => { throw new Error("must not send"); }),
      verifySession: vi.fn(async () => { throw new Error("must not send"); }),
      getAccountsByIdsPage: vi.fn(async () => { throw new Error("must not send"); }),
    };
  }

  async function engineFixture(mode: SyncPageMode, label = "fence-lever") {
    const adapter = adapterSpies();
    const app = createTestAppContext(db(), { adapter: adapter as unknown as AppContext["adapter"] });
    const page = await seedPage(app, label);
    await setMode(page.id, mode);
    return { app, page, adapter };
  }

  const refusal = (label: string, mode: string) => expect.objectContaining({
    name: "FanslyPageOnSyncEngineError", statusCode: 409, code: FANSLY_PAGE_ON_SYNC_ENGINE_CODE,
    pageLabel: label, mode,
  });

  it.each(ENGINE_MODES)("the owner routes answer 409 on a %s page", async (mode) => {
    const f = await engineFixture(mode);
    await createUserAccount(f.app, { username: "owner", role: "owner", password: "owner-secret" }, { source: "cli" });
    const server = await buildApiServer(f.app);
    await server.ready();
    try {
      const login = await server.inject({
        method: "POST", url: "/api/v1/auth/login", payload: { username: "owner", password: "owner-secret" },
      });
      expect(login.statusCode).toBe(200);
      const header = login.headers["set-cookie"];
      const cookie = (Array.isArray(header) ? header[0] : header)!.split(";")[0]!;

      const verify = await server.inject({
        method: "POST", url: `/api/v1/admin/pages/${f.page.label}/verify`, headers: { cookie },
      });
      expect(verify.statusCode).toBe(409);
      expect(verify.json()).toMatchObject({ error: FANSLY_PAGE_ON_SYNC_ENGINE_CODE, statusCode: 409 });
      expect(verify.json().message).toContain(`Page ${f.page.label} is on the Fansly Sync Engine (mode ${mode})`);

      const credentials = await server.inject({
        method: "PATCH", url: `/api/v1/admin/pages/${f.page.label}/credentials`, headers: { cookie },
        payload: { platform: "fansly" },
      });
      expect(credentials.statusCode).toBe(409);
      expect(credentials.json()).toMatchObject({ error: FANSLY_PAGE_ON_SYNC_ENGINE_CODE });
    } finally {
      await server.close();
    }
    expect(f.adapter.getAccountMe).not.toHaveBeenCalled();
    expect(f.adapter.verifySession).not.toHaveBeenCalled();
  });

  it("the verify route still sends for a shadow page (J8)", async () => {
    const f = await engineFixture("shadow");
    await saveProxy(f.app, f.page.id, { url: "http://proxy.example.test:8080" });
    await createUserAccount(f.app, { username: "owner", role: "owner", password: "owner-secret" }, { source: "cli" });
    const server = await buildApiServer(f.app);
    await server.ready();
    try {
      const login = await server.inject({
        method: "POST", url: "/api/v1/auth/login", payload: { username: "owner", password: "owner-secret" },
      });
      const header = login.headers["set-cookie"];
      const cookie = (Array.isArray(header) ? header[0] : header)!.split(";")[0]!;
      const verify = await server.inject({
        method: "POST", url: `/api/v1/admin/pages/${f.page.label}/verify`, headers: { cookie },
      });
      expect(verify.statusCode).not.toBe(409);
    } finally {
      await server.close();
    }
    expect(f.adapter.getAccountMe).toHaveBeenCalled();
  });

  it("the services behind the CLIs refuse before anything is resolved or sent", async () => {
    const f = await engineFixture("handover");
    await expect(setPageProxy(f.app, f.page.label, { url: "http://proxy.example.test:8080" }))
      .rejects.toThrow(refusal(f.page.label, "handover"));
    await expect(backfillFanslyPageAliases(f.app, { pageLabels: [f.page.label] }))
      .rejects.toThrow(refusal(f.page.label, "handover"));
    await expect(runFanslyEndpointProbe(f.app, { pageLabels: [f.page.label], dryRun: true }))
      .rejects.toThrow(refusal(f.page.label, "handover"));
    await expect(runFanslyReplayProbe(f.app, { pageLabels: [f.page.label], dryRun: true }))
      .rejects.toThrow(refusal(f.page.label, "handover"));
    await expect(applyFanslyWsPolicyRepair(f.app, {
      id: randomUUID(), pageLabel: f.page.label, pageId: f.page.id, nativeAccountId: "999",
      fromGeneration: "a".repeat(64), toGeneration: "b".repeat(64), fingerprint: "c".repeat(64),
      policyVersion: 0, expiresAt: new Date(Date.now() + 60_000).toISOString(),
    })).rejects.toThrow(refusal(f.page.label, "handover"));
    expect(f.adapter.verifySession).not.toHaveBeenCalled();
    expect(f.adapter.getAccountsByIdsPage).not.toHaveBeenCalled();
    expect((await db().pool.query("select count(*)::int as n from fansly_send_log")).rows[0].n).toBe(0);
  });

  it("an unrestricted alias backfill skips the engine's page and names it", async () => {
    const f = await engineFixture("live");
    const [fan] = await upsertFans(f.app.db, [{ platform: "fansly", platformUserId: "4242" }]);
    await upsertFanPages(f.app.db, [{ fanId: fan!.id, platformAccountId: f.page.id, isFollower: true }]);
    expect(await backfillFanslyPageAliases(f.app, {})).toMatchObject({
      totalPages: 0, pages: [], skippedEngineOwnedPages: [f.page.label],
    });
    expect(f.adapter.getAccountsByIdsPage).not.toHaveBeenCalled();
  });

  it("the operator scripts refuse with a one-line reason", async () => {
    const f = await engineFixture("live", "lilly-1");
    const failure = await refuseEngineOwnedPage(f.app.db, "lilly-1").catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(FanslyPageOnSyncEngineError);
    expect(engineOwnedRefusalLine(failure)).toBe(
      "Page lilly-1 is on the Fansly Sync Engine (mode live): the legacy engine sends nothing for it; "
        + "the page's socket belongs to the engine; see `pnpm cli sync page status --page lilly-1`\n",
    );
    expect(engineOwnedRefusalLine(new Error("provider text"))).toBeNull();
    await setMode(f.page.id, "shadow");
    await expect(refuseEngineOwnedPage(f.app.db, "lilly-1")).resolves.toBeUndefined();
  });

  it("the AI describer's CDN download is refused before an egress is resolved", async () => {
    const f = await engineFixture("live");
    // The page has no proxy: resolving its egress would fail closed.
    expect(await downloadAiMediaThroughPageEgress(f.app, { url: "https://cdn3.fansly.com/a.jpg", pageId: f.page.id }))
      .toEqual({ ok: false, reason: "send_guard", httpStatus: null });
    await setMode(f.page.id, "off");
    await expect(downloadAiMediaThroughPageEgress(f.app, { url: "https://cdn3.fansly.com/a.jpg", pageId: f.page.id }))
      .rejects.toThrow();
  });
});

describe("(g) the runtime CLI", () => {
  async function loadCliProgram(appContext: AppContext) {
    vi.resetModules();
    vi.doMock("../apps/runtime/src/bootstrap.ts", () => ({ createAppContext: async () => appContext }));
    const { buildProgram } = await import("../apps/runtime/src/cli.ts");
    const program = buildProgram();
    program.exitOverride();
    program.configureOutput({ writeOut: () => {}, writeErr: () => {}, outputError: () => {} });
    return program;
  }

  it.each(ENGINE_MODES)("`page verify` and `dm backfill-thread` refuse a %s page", async (mode) => {
    const getAccountMe = vi.fn(async () => { throw new Error("must not send"); });
    const app = createTestAppContext(db(), { adapter: { getAccountMe } as unknown as AppContext["adapter"] });
    const page = await seedPage(app, "fence-cli");
    await setMode(page.id, mode);
    const thread = await seedThread(app, page.id, new Date(Date.now() - 3_600_000));
    const expected = expect.objectContaining({ code: FANSLY_PAGE_ON_SYNC_ENGINE_CODE, statusCode: 409 });
    try {
      const verify = await loadCliProgram(app);
      await expect(verify.parseAsync(["page", "verify", "--page", page.label], { from: "user" }))
        .rejects.toThrow(expected);
      const backfill = await loadCliProgram(app);
      await expect(backfill.parseAsync(["dm", "backfill-thread", "--thread", String(thread.id)], { from: "user" }))
        .rejects.toThrow(expected);
    } finally {
      vi.doUnmock("../apps/runtime/src/bootstrap.ts");
      vi.resetModules();
    }
    expect(getAccountMe).not.toHaveBeenCalled();
    // Refused before the queue was even opened.
    expect((await db().pool.query("select to_regclass('pgboss.job') is null as absent")).rows[0].absent).toBe(true);
  });
});
