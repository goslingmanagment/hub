import { randomUUID } from "node:crypto";

import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import {
  acquirePageSyncLease,
  acquireTargetedPageSyncLease,
  createFanslyPage,
  createModel,
  createOnlyFansPage,
  ensurePageSyncStates,
  ensureSyncPage,
  FANSLY_SYNC_ENGINE_HYDRATION_LANE,
  getFanslySyncLiveness,
  insertAgentKey,
  isFanslyPageEngineOwned,
  listDispatchableAgentHydrationRequests,
  listDispatchingAgentHydrationRequests,
  listExpirableAgentHydrationRequests,
  listRunnablePageSync,
  listStuckAgentHydrationDispatches,
  markPageSyncEnqueued,
  releaseTargetedPageSyncLease,
  requestPageSync,
  startSyncRun,
  type SyncPageMode,
} from "@agency_hub_core/db";

import { buildApiServer } from "../apps/runtime/src/api/server.ts";
import type { AppContext } from "../apps/runtime/src/bootstrap.ts";
import { downloadAiMediaThroughPageEgress } from "../apps/runtime/src/services/ai-media-describe/worker.ts";
import {
  reconcileAgentHydrationDispatches,
  sweepStuckAgentHydration,
} from "../apps/runtime/src/services/agent-hydration.ts";
import { createUserAccount } from "../apps/runtime/src/services/auth.ts";
import { saveProxy } from "../apps/runtime/src/services/page-context.ts";
import { setPageProxy } from "../apps/runtime/src/services/page-proxies.ts";
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

  it("the repository reader names the engine's pages and only them", async () => {
    const pages = await seedFencePages();
    expect(await isFanslyPageEngineOwned(db().db, pages.handover.id)).toEqual({ owned: true, mode: "handover" });
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

  it("still watches a shadow page's due streams and runs (J8)", async () => {
    const model = await createModel(db().db, { slug: "silent-shadow", name: "Silent" });
    const page = await createFanslyPage(db().db, { modelId: model!.id, label: "silent-shadow" });
    await setMode(page!.id, "shadow");
    const now = new Date();
    await pendingStream(page!.id, "light", new Date(now.getTime() - 3_600_000));
    const run = await startSyncRun(db().db, {
      platformAccountId: page!.id, stream: "light", trigger: "scheduled", startedAt: new Date(now.getTime() - 60_000),
    });
    expect(await getFanslySyncLiveness(db().db, { since: new Date(now.getTime() - 3_600_000), dueBefore: now }))
      .toEqual({ latestStartedAt: run!.startedAt, hasDueStream: true });
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

  it("dispatches no request of a page the engine owns", async () => {
    const pages = await seedFencePages();
    const keyId = await seedKey([pages.handover.id, pages.live.id, pages.off.id, pages.shadow.id, pages.onlyfans.id]);
    const approved: Record<string, number> = {};
    for (const [name, page] of Object.entries({
      handover: pages.handover, live: pages.live, off: pages.off, shadow: pages.shadow,
    })) {
      approved[name] = await seedRequest({ keyId, pageId: page.id, state: "approved" });
    }
    approved.onlyfans = await seedRequest({ keyId, pageId: pages.onlyfans.id, state: "approved" });

    const dispatchable = async () => (await listDispatchableAgentHydrationRequests(db().db, { limit: 50 }))
      .map((row) => row.id).sort((a, b) => a - b);
    expect(await dispatchable())
      .toEqual([approved.off!, approved.shadow!, approved.onlyfans!].sort((a, b) => a - b));

    // Back to `off`: the list sees the page again.
    await setMode(pages.live.id, "off");
    expect(await dispatchable()).toContain(approved.live!);
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
    expect(await reconcileAgentHydrationDispatches(app)).toBe(0);
    expect(await sweepStuckAgentHydration(app)).toBe(0);
    const rows = await db().pool.query(
      "select id::int as id, state from agent_hydration_requests order by id",
    );
    expect(rows.rows).toEqual([
      { id: engineDispatching, state: "dispatching" },
      { id: engineRequested, state: "requested" },
    ]);
  });
});

// ── (g) the /account/me levers and the describer's download ─────────────────
//
// The probes and the alias backfill that were fenced here are deleted (step 4,
// S4-20): `sync probe` and `sync work enqueue --resource
// fan-profiles.alias-backfill` are the engine's. Nothing outside the engine
// can send for a Fansly page any more, so "sent nothing" is read off the
// journal of the senders outside it (`fansly_send_log`).

describe("(g) the levers refuse a page the engine does not run with a 409 and send nothing", () => {
  async function engineFixture(mode: SyncPageMode, label = "fence-lever") {
    const app = createTestAppContext(db());
    const page = await seedPage(app, label);
    await setMode(page.id, mode);
    return { app, page };
  }

  async function journaledSends(): Promise<number> {
    return (await db().pool.query("select count(*)::int as n from fansly_send_log")).rows[0].n;
  }

  // S3-05: on a `live` page these routes go through the engine
  // (tests/sync-account-routing.integration.test.ts); a page being switched
  // answers 409 `fansly_page_switching` before anything is resolved or sent.
  it("the owner routes answer 409 on a handover page", async () => {
    const mode = "handover";
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
      expect(verify.json()).toMatchObject({ error: "fansly_page_switching", statusCode: 409 });
      expect(verify.json().message).toContain(`${f.page.label} is being switched to the Fansly Sync Engine (${mode})`);

      const credentials = await server.inject({
        method: "PATCH", url: `/api/v1/admin/pages/${f.page.label}/credentials`, headers: { cookie },
        payload: { platform: "fansly" },
      });
      expect(credentials.statusCode).toBe(409);
      expect(credentials.json()).toMatchObject({ error: "fansly_page_switching" });
    } finally {
      await server.close();
    }
    expect(await journaledSends()).toBe(0);
  });

  it("the verify route refuses a shadow page: no legacy sender is left behind it (S4-19)", async () => {
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
      expect(verify.statusCode).toBe(409);
      expect(verify.json()).toMatchObject({ error: "legacy_sync_retired", statusCode: 409 });
    } finally {
      await server.close();
    }
    expect(await journaledSends()).toBe(0);
  });

  it("the proxy change behind the CLI refuses a page being switched before anything is resolved or sent", async () => {
    const f = await engineFixture("handover");
    const switching = expect.objectContaining({ name: "FanslyPageSwitchingError", statusCode: 409, code: "fansly_page_switching" });
    await expect(setPageProxy(f.app, f.page.label, { url: "http://proxy.example.test:8080" }))
      .rejects.toThrow(switching);
    expect(await journaledSends()).toBe(0);
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

  it("a shadow page is not fenced (J8), and nothing sends for it: the describer downloads no Fansly file, its /account/me levers refuse (S4-19)", async () => {
    const app = createTestAppContext(db());
    const page = await seedPage(app, "fence-shadow-lever");
    await setMode(page.id, "shadow");

    // The CDN download goes on to resolve the page's egress: this page has no
    // proxy yet, so it fails closed there, exactly as an `off` page does.
    await expect(downloadAiMediaThroughPageEgress(app, { url: "https://cdn3.fansly.com/a.jpg", pageId: page.id }))
      .rejects.toThrow(/has no assigned proxy/);

    await saveProxy(app, page.id, { url: "http://proxy.example.test:8080" });
    // With an egress, the Fansly file is still not this path's to fetch: no
    // legacy sender is left for the page (S4-20), so the row looks again later.
    expect(await downloadAiMediaThroughPageEgress(app, { url: "https://cdn3.fansly.com/a.jpg", pageId: page.id }))
      .toEqual({ ok: false, reason: "send_guard", httpStatus: null });
    await createUserAccount(app, { username: "owner", role: "owner", password: "owner-secret" }, { source: "cli" });
    const server = await buildApiServer(app);
    await server.ready();
    try {
      const login = await server.inject({
        method: "POST", url: "/api/v1/auth/login", payload: { username: "owner", password: "owner-secret" },
      });
      const header = login.headers["set-cookie"];
      const cookie = (Array.isArray(header) ? header[0] : header)!.split(";")[0]!;
      const credentials = await server.inject({
        method: "PATCH", url: `/api/v1/admin/pages/${page.label}/credentials`, headers: { cookie },
        payload: { platform: "fansly", session: { authorization: "fresh-token" } },
      });
      // The engine does not run a shadow page and no legacy `/account/me` is
      // left to check a candidate with: refused before anything is sent.
      expect(credentials.statusCode).toBe(409);
      expect(credentials.json()).toMatchObject({ error: "legacy_sync_retired" });
    } finally {
      await server.close();
    }

    await expect(setPageProxy(app, page.label, { url: "http://proxy.example.test:8080" }))
      .rejects.toMatchObject({ code: "legacy_sync_retired", statusCode: 409 });
    expect(await journaledSends()).toBe(0);
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

  it("`page verify` refuses a page being switched", async () => {
    const app = createTestAppContext(db());
    const page = await seedPage(app, "fence-cli");
    await setMode(page.id, "handover");
    try {
      // S3-05: a live page's verify is the engine's (sync-account-routing).
      const verify = await loadCliProgram(app);
      await expect(verify.parseAsync(["page", "verify", "--page", page.label], { from: "user" }))
        .rejects.toThrow(expect.objectContaining({ code: "fansly_page_switching", statusCode: 409 }));
    } finally {
      vi.doUnmock("../apps/runtime/src/bootstrap.ts");
      vi.resetModules();
    }
    expect((await db().pool.query("select count(*)::int as n from fansly_send_log")).rows[0].n).toBe(0);
  });

  it("`page verify` refuses a shadow page: no legacy sender is left behind it (S4-19)", async () => {
    const app = createTestAppContext(db(), { databaseUrl: db().connectionString });
    const page = await seedPage(app, "fence-cli-shadow");
    await saveProxy(app, page.id, { url: "http://proxy.example.test:8080" });
    await setMode(page.id, "shadow");
    try {
      const verify = await loadCliProgram(app);
      await expect(verify.parseAsync(["page", "verify", "--page", page.label], { from: "user" }))
        .rejects.toThrow(expect.objectContaining({ code: "legacy_sync_retired", statusCode: 409 }));
      expect((await db().pool.query("select count(*)::int as n from fansly_send_log")).rows[0].n).toBe(0);
    } finally {
      vi.doUnmock("../apps/runtime/src/bootstrap.ts");
      vi.resetModules();
    }
  });
});
