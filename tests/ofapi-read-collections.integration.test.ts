import { ofapiCollectionHandlers } from "../apps/runtime/src/services/ofapi-collection-handlers.ts";
import { executeErasure } from "../apps/runtime/src/services/erasure/index.ts";
import { rebuildOfapiReadSnapshotProjection } from "../apps/runtime/src/services/projections/ofapi-read-snapshots.ts";
import { randomUUID } from "node:crypto";
import { sha256Hex } from "@agency_hub_core/shared";
import { insertAgentKey, setConfigOverride } from "@agency_hub_core/db";
import { buildApiServer } from "../apps/runtime/src/api/server.ts";
import {
  AGENT_KEY_TOKEN_PREFIX,
  createUserAccount,
} from "../apps/runtime/src/services/auth.ts";
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import {
  applyOfapiCollectionPolicy,
  createModel,
  createOnlyFansPage,
  createOfapiCollectionJob,
  createUser,
  enqueueDueOfapiCollectionSchedules,
  getOfapiCollectionJob,
  readOfapiStoredSnapshots,
  setPageOfapiAccountId,
  claimOfapiCollectionJob,
  checkpointOfapiCollectionJob,
  reserveOfapiCollectionRequest,
  saveOfapiReadSnapshot,
  upsertFans,
} from "@agency_hub_core/db";
import { createOfapiClient } from "../apps/runtime/src/services/ofapi.ts";
import { ofapiCollectionPolicyHooks } from "../apps/runtime/src/services/ofapi-collection-policy.ts";
import {
  runOfapiCollectionJob,
  materializeOfapiReadSnapshot,
} from "../apps/runtime/src/services/ofapi-collection-runner.ts";
import {
  captureOfapiCollectionRead,
  completeOfapiCollectionRead,
} from "../apps/runtime/src/services/ofapi-collection-read-transport.ts";
import {
  startIntegrationTestDatabase,
  resetIntegrationDatabase,
  type StartedTestDatabase,
} from "./helpers/db.ts";
import { createTestAppContext } from "./helpers/runtime.ts";
let db: StartedTestDatabase;
let pageId: number;
let actor: number;
let app: ReturnType<typeof createTestAppContext>;
beforeAll(async () => {
  const started = await startIntegrationTestDatabase();
  if (!started) throw new Error("DB unavailable");
  db = started;
}, 120000);
afterAll(async () => {
  await db?.stop();
});
afterEach(() => vi.unstubAllGlobals());
beforeEach(async () => {
  await resetIntegrationDatabase(db.pool);
  app = createTestAppContext(db);
  actor = (await createUser(app.db, {
    username: "owner",
    role: "owner",
    passwordHash: "synthetic",
  }))!.id;
  const model = (await createModel(app.db, {
    slug: "reads",
    name: "Read coverage",
  }))!;
  pageId = (await createOnlyFansPage(app.db, {
    modelId: model.id,
    label: "read-page",
  }))!.id;
  await setPageOfapiAccountId(app.db, { pageId, ofapiAccountId: "acct_test" });
  await db.pool.query(
    "insert into ofapi_credit_state(id,last_balance,last_balance_at) values(1,10000,now()) on conflict(id) do update set last_balance=10000,last_balance_at=now()",
  );
  app.ofapi = createOfapiClient({
    apiKey: "synthetic",
    restDelayMs: 0,
    ...ofapiCollectionPolicyHooks(app.db),
  });
});
async function job(selection: string[], maxCalls = 5) {
  return createOfapiCollectionJob(
    app.db,
    {
      pageId,
      category: "profile_notifications",
      expectedRevision: 0,
      maxCalls,
      maxCredits: 100,
      maxBytes: 1000000,
      from: null,
      to: null,
      selection,
    },
    actor,
  );
}
const response = (data: unknown, next?: string | null) =>
  new Response(
    JSON.stringify({
      data,
      ...(next === undefined ? {} : { _pagination: { next_page: next } }),
      _meta: { _credits: { used: 1, balance: 9999 } },
    }),
  );
describe("resumable OFAPI collection reads", () => {
  it("captures list preview and explicit member pages, rebuilds their identity, and serves owner CRM context locally", async () => {
    const [fan] = await upsertFans(app.db, [
      { platform: "onlyfans", platformUserId: "9007199254740993" },
    ]);
    await db.pool.query(
      "insert into page_dm_threads(platform_account_id,fan_id,platform_conversation_id,partner_platform_user_id,last_fan_message_at) values($1,$2,'9007199254740993','9007199254740993','2026-09-05T10:00:00Z')",
      [pageId, fan!.id],
    );
    await db.pool.query(
      "insert into fan_spend_lifetime(platform_account_id,fan_id,gross_amount_mills) values($1,$2,12345)",
      [pageId, fan!.id],
    );
    const fetch = vi
      .fn()
      .mockResolvedValueOnce(
        response({
          id: "friends",
          name: "Friends",
          usersCount: 10,
          users: [{ id: "9007199254740993", username: "fan" }],
        }),
      )
      .mockResolvedValueOnce(
        response({ list: [], hasMore: true, nextOffset: 50 }),
      )
      .mockResolvedValueOnce(
        response({
          list: [
            {
              id: "9007199254740993",
              username: "fan",
              totalSpent: 1,
              canReceiveChatMessage: false,
            },
          ],
          hasMore: false,
        }),
      );
    vi.stubGlobal("fetch", fetch);
    const approved = await job(
      ["user_list:friends", "user_list_users:friends"],
      3,
    );
    expect(await runOfapiCollectionJob(app, approved.id)).toEqual({
      state: "completed",
    });
    expect(fetch).toHaveBeenCalledTimes(3);
    expect(
      new URL(String(fetch.mock.calls[2]![0])).searchParams.get("offset"),
    ).toBe("50");
    const snapshots = await readOfapiStoredSnapshots(app.db, { pageId });
    expect(snapshots).toHaveLength(3);
    expect(snapshots[0]).toMatchObject({
      coverage: { state: "complete" },
      items: [
        {
          nativeId: "9007199254740993",
          fanId: "9007199254740993",
          listId: "friends",
          membershipScope: "members",
          contactability: "unavailable",
          priorSpendMills: "12345",
          lastReplyAt: "2026-09-05T10:00:00.000Z",
          crmSource: "local_archive_and_spend_projection",
        },
      ],
    });
    expect(snapshots[1]).toMatchObject({
      coverage: { state: "partial", nextQuery: { offset: "50" } },
      items: [],
    });
    expect(snapshots[2]).toMatchObject({
      items: [
        {
          listId: "friends",
          usersCount: 10,
          membershipCoverage: "preview_only",
          previewUsers: [{ fanId: "9007199254740993" }],
        },
      ],
    });
    await rebuildOfapiReadSnapshotProjection(app, { accountId: pageId });
    expect(
      (await readOfapiStoredSnapshots(app.db, { pageId })).map((row) => ({
        items: row.items,
        observationId: row.observationId,
      })),
    ).toEqual(
      snapshots.map((row) => ({
        items: row.items,
        observationId: row.observationId,
      })),
    );
    expect(
      (
        await db.pool.query(
          "select count(*)::int n from observations where kind='ofapi.collection_read_response.v1'",
        )
      ).rows[0].n,
    ).toBe(3);
    await createUserAccount(
      app,
      {
        username: "list-owner",
        role: "owner",
        password: "test-owner-password",
      },
      { source: "cli" },
    );
    const server = await buildApiServer(app);
    try {
      expect(
        (
          await server.inject({
            method: "GET",
            url: `/api/v1/admin/ofapi/collection/results?pageId=${pageId}`,
          })
        ).statusCode,
      ).toBe(401);
      const login = await server.inject({
        method: "POST",
        url: "/api/v1/auth/login",
        payload: { username: "list-owner", password: "test-owner-password" },
      });
      const cookie = String(login.headers["set-cookie"]).split(";")[0]!;
      const served = await server.inject({
        method: "GET",
        url: `/api/v1/admin/ofapi/collection/results?pageId=${pageId}&operation=ofapi_read_user_list_users`,
        headers: { cookie },
      });
      expect(served.statusCode, served.body).toBe(200);
      expect(served.json().snapshots).toHaveLength(2);
      expect(served.body).toContain("9007199254740993");
      expect(served.body).toContain("12345");
      expect(fetch).toHaveBeenCalledTimes(3);
    } finally {
      await server.close();
    }
  });
  it("collects through an empty following page; captures, canonicalizes and serves local coverage", async () => {
    const fetch = vi
      .fn()
      .mockResolvedValueOnce(
        response(
          { list: [], hasMore: true },
          "https://app.onlyfansapi.com/api/acct_test/following/expired?limit=50&offset=50",
        ),
      )
      .mockResolvedValueOnce(
        response(
          {
            list: [{ id: 7, username: "fan", canReceiveChatMessage: false }],
            hasMore: false,
          },
          null,
        ),
      );
    vi.stubGlobal("fetch", fetch);
    const approved = await job(["following_expired"]);
    expect(await runOfapiCollectionJob(app, approved.id)).toEqual({
      state: "completed",
    });
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(String(fetch.mock.calls[0]![0])).not.toContain("sort");
    expect(String(fetch.mock.calls[1]![0])).toContain("offset=50");
    const stored = await readOfapiStoredSnapshots(app.db, { pageId });
    expect(stored).toHaveLength(2);
    await rebuildOfapiReadSnapshotProjection(app, { accountId: pageId });
    expect(
      (await readOfapiStoredSnapshots(app.db, { pageId })).map(
        (row) => row.observationId,
      ),
    ).toEqual(stored.map((row) => row.observationId));
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(stored[0]).toMatchObject({
      source: "onlyfansapi",
      coverage: { state: "complete" },
      items: [{ nativeId: "7", contactability: "unavailable" }],
    });
    expect(
      (
        await db.pool.query(
          "select count(*)::int count from domain_events where type='ofapi.read_snapshot_observed'",
        )
      ).rows[0].count,
    ).toBe(2);
    expect(
      Number((await getOfapiCollectionJob(app.db, approved.id))?.used_calls),
    ).toBe(2);
  });
  it("replays a captured response after a local failure without spending another call", async () => {
    const fetch = vi.fn(async () =>
      response({ list: [{ id: 7, totalSpent: 2 }], hasMore: false }, null),
    );
    vi.stubGlobal("fetch", fetch);
    const approved = await job(["fans_expired"], 1);
    const step = {
      operation: "ofapi_read_fans_expired",
      pathname: "/acct_test/fans/expired",
      query: { limit: "20", offset: "0" },
    };
    const input = {
      pageId,
      accountId: "acct_test",
      step,
      stepKey: `recovery:${approved.id}`,
      context: {
        category: "profile_notifications" as const,
        purpose: "one_off" as const,
        jobId: approved.id,
      },
      maxBytes: 100000,
      beforeDispatch: async () => true,
    };
    const first = await captureOfapiCollectionRead(app, input);
    expect(fetch).toHaveBeenCalledTimes(1);
    const replay = await captureOfapiCollectionRead(app, input);
    expect(replay.observationId).toBe(first.observationId);
    expect(fetch).toHaveBeenCalledTimes(1);
    const result = await materializeOfapiReadSnapshot(app, {
      pageId,
      step,
      body: replay.body,
      observationId: replay.observationId,
      observationReceivedAt: replay.observationReceivedAt,
    });
    await completeOfapiCollectionRead(app, replay, result.items.length);
    const complete = await captureOfapiCollectionRead(app, input);
    expect(complete.observationId).toBe(first.observationId);
    expect(fetch).toHaveBeenCalledTimes(1);
    await materializeOfapiReadSnapshot(app, {
      pageId,
      step,
      body: replay.body,
      observationId: replay.observationId,
      observationReceivedAt: replay.observationReceivedAt,
    });
    expect(await readOfapiStoredSnapshots(app.db, { pageId })).toHaveLength(1);
  });
  it("replays older captured responses while preserving ordered snapshot history without refetching", async () => {
    const fetch = vi.fn()
      .mockResolvedValueOnce(response({ list: [{ id: 7, totalSpent: 2 }], hasMore: false }, null))
      .mockResolvedValueOnce(response({ list: [{ id: 7, totalSpent: 9 }], hasMore: false }, null));
    vi.stubGlobal("fetch", fetch);
    const step = { operation: "ofapi_read_fans_expired", pathname: "/acct_test/fans/expired", query: { limit: "20", offset: "0" } };
    const captured = [];
    for (let index = 0; index < 2; index++) {
      const approved = await job(["fans_expired"], 1);
      captured.push(await captureOfapiCollectionRead(app, {
        pageId, accountId: "acct_test", step, stepKey: `ordered-recovery:${approved.id}`,
        context: { category: "profile_notifications", purpose: "one_off", jobId: approved.id },
        maxBytes: 100000, beforeDispatch: async () => true,
      }));
    }
    for (const capture of [...captured].reverse()) {
      const result = await materializeOfapiReadSnapshot(app, { pageId, step, body: capture.body,
        observationId: capture.observationId, observationReceivedAt: capture.observationReceivedAt });
      await completeOfapiCollectionRead(app, capture, result.items.length);
    }
    const snapshots = await readOfapiStoredSnapshots(app.db, { pageId });
    expect(snapshots).toHaveLength(2);
    expect(snapshots[0]!.observationId).toBe(String(captured[1]!.observationId));
    expect((await db.pool.query("select count(*)::int count from domain_events where type='ofapi.read_snapshot_observed'")).rows[0].count).toBe(2);
    await rebuildOfapiReadSnapshotProjection(app, { accountId: pageId });
    expect((await readOfapiStoredSnapshots(app.db, { pageId })).map(row => row.observationId)).toEqual(snapshots.map(row => row.observationId));
    expect(fetch).toHaveBeenCalledTimes(2);
  });
  it.each(["page", "fan"] as const)("does not recreate read snapshots loaded before a completed %s erasure", async (scopeType) => {
    vi.stubGlobal("fetch", vi.fn(async () => response({ list: [{ id: "55", username: "fan" }], hasMore: false }, null)));
    const approved = await job(["fans_expired"], 1);
    expect(await runOfapiCollectionJob(app, approved.id)).toEqual({ state: "completed" });
    const stored = (await db.pool.query("select * from ofapi_read_snapshots where page_id=$1", [pageId])).rows[0]!;
    await executeErasure(app, scopeType === "page" ? { scopeType: "page", pageLabel: "read-page" } : { scopeType: "fan", platform: "onlyfans", fanRef: "55" }, { initiatedBy: actor });
    // Simulate the projection having loaded this event before the erasure committed.
    await saveOfapiReadSnapshot(app.db, {
      pageId, category: stored.category, operation: stored.operation, pathname: stored.pathname,
      query: stored.query, observedAt: stored.observed_at, observationId: Number(stored.observation_id),
      observationReceivedAt: stored.observation_received_at, eventId: Number(stored.event_id),
      granularity: stored.granularity, coverage: stored.coverage, items: stored.items,
    });
    expect(await readOfapiStoredSnapshots(app.db, { pageId })).toEqual([]);
  });
  it("admits only one lease and enforces physical scheduled job caps plus changed policy", async () => {
    const approved = await job(["me"]);
    const leases = await Promise.all([
      claimOfapiCollectionJob(app.db, approved.id),
      claimOfapiCollectionJob(app.db, approved.id),
    ]);
    expect(leases.filter(Boolean)).toHaveLength(1);
    await checkpointOfapiCollectionJob(app.db, {
      id: approved.id,
      token: leases.find(Boolean)!,
      checkpoint: { index: 0 },
      state: "paused",
    });
    await expect(
      checkpointOfapiCollectionJob(app.db, {
        id: approved.id,
        token: leases.find(Boolean)!,
        checkpoint: { index: 999 },
        state: "completed",
      }),
    ).rejects.toThrow("lease lost");
    const settings = {
      pageId,
      category: "profile_notifications" as const,
      mode: "scheduled" as const,
      intervalMinutes: 15,
      dailyCreditLimit: 10,
      maxCallsPerRun: 1,
      includeDetails: false,
    };
    await applyOfapiCollectionPolicy(
      app.db,
      { expectedRevision: 0, changes: [settings] },
      actor,
    );
    const ids = await enqueueDueOfapiCollectionSchedules(app.db, [
      "profile_notifications",
    ]);
    expect(ids).toHaveLength(1);
    expect(
      await enqueueDueOfapiCollectionSchedules(app.db, [
        "profile_notifications",
      ]),
    ).toEqual([]);
    const context = {
      category: "profile_notifications" as const,
      purpose: "background" as const,
      jobId: ids[0]!,
    };
    await reserveOfapiCollectionRequest(app.db, {
      pageId,
      operation: "ofapi_read_me",
      requestId: "first",
      context,
    });
    await expect(
      reserveOfapiCollectionRequest(app.db, {
        pageId,
        operation: "ofapi_read_me",
        requestId: "second",
        context,
      }),
    ).rejects.toThrow("job_limit");
    await applyOfapiCollectionPolicy(
      app.db,
      { expectedRevision: 1, changes: [{ ...settings, mode: "off" }] },
      actor,
    );
    await expect(
      reserveOfapiCollectionRequest(app.db, {
        pageId,
        operation: "ofapi_read_me",
        requestId: "disabled",
        context,
      }),
    ).rejects.toThrow();
  });
  it("never schedules default-off categories or dispatches malformed approved selections", async () => {
    const fetch = vi.fn();
    vi.stubGlobal("fetch", fetch);
    expect(
      await enqueueDueOfapiCollectionSchedules(app.db, [
        "profile_notifications",
        "balances",
      ]),
    ).toEqual([]);
    const approved = await job(["settings"]);
    expect(await runOfapiCollectionJob(app, approved.id)).toMatchObject({
      state: "paused",
      reason: "Unsupported collection selection settings",
    });
    expect(fetch).not.toHaveBeenCalled();
  });
  it("serves source-labelled financial metrics only to page-granted Agent keys with read:money", async () => {
    const approved = await createOfapiCollectionJob(
      app.db,
      {
        pageId,
        category: "balances",
        expectedRevision: 0,
        maxCalls: 1,
        maxCredits: 10,
        maxBytes: 100000,
        from: null,
        to: null,
        selection: ["payout_balances"],
      },
      actor,
    );
    const fetch = vi.fn(async () =>
      response({
        payoutAvailable: "12.345",
        payoutPending: 2,
        currency: "USD",
      }),
    );
    vi.stubGlobal("fetch", fetch);
    expect(await runOfapiCollectionJob(app, approved.id)).toEqual({
      state: "completed",
    });
    await setConfigOverride(app.db, {
      key: "agentReadPlaneMode",
      value: "full",
      userId: actor,
      groupId: randomUUID(),
    });
    const makeKey = async (name: string, money: boolean, granted = pageId) => {
      const token = `${AGENT_KEY_TOKEN_PREFIX}${name}-synthetic-token`;
      await insertAgentKey(app.db, {
        name,
        keyPrefix: token.slice(0, AGENT_KEY_TOKEN_PREFIX.length + 6),
        keyDigest: sha256Hex(token),
        capabilities: money
          ? ["read:datasets", "read:money"]
          : ["read:datasets"],
        pageIds: [granted],
        dailyRequestBudget: 100,
        dailyRowBudget: 10000,
        expiresAt: new Date(Date.now() + 86400000),
        createdBy: actor,
      });
      return token;
    };
    const allowed = await makeKey("money", true),
      denied = await makeKey("no-money", false);
    const otherModel = (await createModel(app.db, {
      slug: "ungranted",
      name: "Other",
    }))!;
    const otherPage = (await createOnlyFansPage(app.db, {
      modelId: otherModel.id,
      label: "ungranted",
    }))!;
    const ungranted = await makeKey("wrong-page", true, otherPage.id);
    const server = await buildApiServer(app);
    try {
      const request = (token: string) =>
        server.inject({
          method: "POST",
          url: "/api/v1/agent/pages/read-page/datasets/ofapi_financial_snapshots/query",
          headers: { authorization: `Bearer ${token}` },
          payload: {
            from: new Date(Date.now() - 86400000).toISOString(),
            to: new Date(Date.now() + 86400000).toISOString(),
            limit: 20,
          },
        });
      expect((await request(denied)).statusCode).toBe(403);
      expect((await request(ungranted)).statusCode).toBe(404);
      const result = await request(allowed);
      expect(result.statusCode, result.body).toBe(200);
      expect(result.body).toContain("12345");
      expect(result.body).toContain("onlyfansapi");
      expect(result.body).toContain("payoutAvailable");
      expect(fetch).toHaveBeenCalledTimes(1);
    } finally {
      await server.close();
    }
  });
});

it("uses the runtime visitor handler to preserve exactly one UTC day without a second paid read", async () => {
  const fetch = vi
    .fn()
    .mockResolvedValue(
      response({
        isAvailable: true,
        hasStats: true,
        chart: {
          visitors: [{ date: "2026-09-01", count: 17 }],
          duration: [{ date: "2026-09-01", count: 9 }],
        },
      }),
    );
  vi.stubGlobal("fetch", fetch);
  const approved = await createOfapiCollectionJob(
    app.db,
    {
      pageId,
      category: "visitors",
      expectedRevision: 0,
      maxCalls: 1,
      maxCredits: 5,
      maxBytes: 1000000,
      from: "2026-09-01T00:00:00.000Z",
      to: "2026-09-02T00:00:00.000Z",
      selection: ["total"],
    },
    actor,
  );
  expect(
    await runOfapiCollectionJob(app, approved.id, ofapiCollectionHandlers),
  ).toEqual({ state: "completed" });
  const url = new URL(String(fetch.mock.calls[0]![0]));
  expect(url.searchParams.get("start_date")).toBe("2026-09-01T00:00:00.000Z");
  expect(url.searchParams.get("end_date")).toBe("2026-09-01T23:59:59.999Z");
  const daily = (
    await db.pool.query(
      "select day::text as date,total_visitors::text,source from ofapi_profile_visitors_daily where page_id=$1",
      [pageId],
    )
  ).rows;
  expect(daily).toEqual([
    { date: "2026-09-01", total_visitors: "17", source: "rest_total" },
  ]);
  await runOfapiCollectionJob(app, approved.id, ofapiCollectionHandlers);
  expect(fetch).toHaveBeenCalledTimes(1);
});
