import { ofapiCollectionHandlers } from "../apps/runtime/src/services/ofapi-collection-handlers.ts";
import { executeErasure } from "../apps/runtime/src/services/erasure/index.ts";
import { rebuildOfapiReadSnapshotProjection } from "../apps/runtime/src/services/projections/ofapi-read-snapshots.ts";
import { createHash, randomUUID } from "node:crypto";
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
  closeAdmissionRefusedOfapiCollectionRuns,
  reserveOfapiCollectionRequest,
  resumeOfapiCollectionJob,
  saveOfapiReadSnapshot,
  upsertFans,
} from "@agency_hub_core/db";
import { createOfapiClient } from "../apps/runtime/src/services/ofapi.ts";
import { ofapiCollectionPolicyHooks } from "../apps/runtime/src/services/ofapi-collection-policy.ts";
import {
  runOfapiCollectionJob,
  materializeOfapiReadSnapshot,
  planOfapiReadCollection,
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
  it("continues explicitly selected legacy latest-fan jobs after audience reclassification", async () => {
    const created = await job(["fans_latest?type=new&start_date=2026-09-10&end_date=2026-09-16"]);
    const fetch = vi.fn(async () => response({ users: [{ id: 123 }], hasMore: false }, null));
    vi.stubGlobal("fetch", fetch);
    await runOfapiCollectionJob(app, created.id);
    expect(await getOfapiCollectionJob(app.db, created.id)).toMatchObject({ state: "completed", used_calls: 1 });
    expect(fetch).toHaveBeenCalledTimes(1);
    const snapshots = await readOfapiStoredSnapshots(app.db, { pageId, operation: "ofapi_read_fans_latest" });
    expect(snapshots[0]?.items).toEqual([expect.objectContaining({ fanId: "123" })]);
  });
  it("keeps a checkpointed legacy latest-fan plan and cursor on resume", async () => {
    const created = await job(["fans_latest?type=new&start_date=2026-09-10&end_date=2026-09-16"]);
    const token = (await claimOfapiCollectionJob(app.db, created.id))!;
    const step = planOfapiReadCollection((await getOfapiCollectionJob(app.db, created.id))!, "acct_test")[0]!;
    step.query.offset = "20";
    await checkpointOfapiCollectionJob(app.db, { id: created.id, token,
      checkpoint: { plan: [step], index: 0 }, state: "paused", reason: "owner_pause" });
    await resumeOfapiCollectionJob(app.db, created.id, 0, actor);
    const fetch = vi.fn(async (_url: unknown) => response({ users: [{ id: 124 }], hasMore: false }, null));
    vi.stubGlobal("fetch", fetch);
    await runOfapiCollectionJob(app, created.id);
    expect(await getOfapiCollectionJob(app.db, created.id)).toMatchObject({ state: "completed", used_calls: 1 });
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(String(fetch.mock.calls[0]?.[0])).toContain("offset=20");
  });
  it("does not let historical latest-fan category compatibility bypass background off", async () => {
    const created = await job(["fans_latest"]);
    const step = planOfapiReadCollection((await getOfapiCollectionJob(app.db, created.id))!, "acct_test")[0]!;
    const fetch = vi.fn(); vi.stubGlobal("fetch", fetch);
    await expect(captureOfapiCollectionRead(app, {
      pageId, accountId: "acct_test", step,
      context: { category: "profile_notifications", purpose: "background", jobId: created.id },
      stepKey: "legacy-background-off", maxBytes: 1000000, beforeDispatch: async () => true,
    })).rejects.toMatchObject({ phase: "pre_dispatch", cause: { reason: "collection_off" } });
    expect(fetch).not.toHaveBeenCalled();
  });
  it("finishes a legacy paused scheduled 503 locally and waits for the existing next interval", async () => {
    await applyOfapiCollectionPolicy(app.db, { expectedRevision: 0, changes: [{ pageId,
      category: "profile_notifications", mode: "scheduled", intervalMinutes: 15,
      dailyCreditLimit: 10, maxCallsPerRun: 1, includeDetails: false }] }, actor);
    const scheduledAt = new Date();
    const [id] = await enqueueDueOfapiCollectionSchedules(app.db, ["profile_notifications"], scheduledAt);
    const base = { operation: "ofapi_read_fans_expired", pathname: "/acct_test/fans/expired", query: { limit: "20", offset: "0" }, detail: false };
    const nextQuery = { limit: "20", offset: "40" };
    const checkpoint = { plan: [base], index: 0, nextQuery, visited: ["earlier-window"] };
    const token = (await claimOfapiCollectionJob(app.db, id!))!;
    await checkpointOfapiCollectionJob(app.db, { id: id!, token, checkpoint, state: "running" });
    const body = JSON.stringify({ error: "temporarily_unavailable", _meta: { _credits: { used: 1, balance: 9999 } } });
    const fetch = vi.fn(async () => new Response(body, { status: 503 }));
    vi.stubGlobal("fetch", fetch);
    const captured = await captureOfapiCollectionRead(app, {
      pageId, accountId: "acct_test", step: { ...base, query: nextQuery }, stepKey: `legacy503:${id}`,
      context: { category: "profile_notifications", purpose: "background", jobId: id! },
      maxBytes: 100000, beforeDispatch: async () => true,
    });
    // The deployed pre-fix runner parked a known transient response without
    // advancing its cursor or including the failed response's bytes.
    await checkpointOfapiCollectionJob(app.db, { id: id!, token, checkpoint, state: "paused", reason: "Vendor HTTP 503; response captured" });
    const before = (await getOfapiCollectionJob(app.db, id!))!;
    await resumeOfapiCollectionJob(app.db, id!, 1, actor);
    expect(await runOfapiCollectionJob(app, id!)).toEqual({ state: "failed", reason: "Vendor HTTP 503; response captured" });
    const failed = (await getOfapiCollectionJob(app.db, id!))!;
    expect(failed.used_calls).toBe(1);
    expect(Number(failed.used_credits)).toBe(1);
    expect(failed.max_calls).toBe(before.max_calls);
    expect(failed.max_credits).toBe(before.max_credits);
    expect(failed.max_bytes).toBe(before.max_bytes);
    expect(Number(failed.used_bytes)).toBe(Buffer.byteLength(body));
    expect(failed.checkpoint).toMatchObject({ ...checkpoint, failedResponseObservationId: captured.observationId, failedResponseStatus: 503 });
    expect(await runOfapiCollectionJob(app, id!)).toEqual({ state: "busy" });
    expect(await enqueueDueOfapiCollectionSchedules(app.db, ["profile_notifications"], new Date(scheduledAt.getTime() + 14 * 60000))).toEqual([]);
    const next = await enqueueDueOfapiCollectionSchedules(app.db, ["profile_notifications"], new Date(scheduledAt.getTime() + 16 * 60000));
    expect(next).toHaveLength(1);
    expect(next[0]).not.toBe(id);
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(await readOfapiStoredSnapshots(app.db, { pageId })).toEqual([]);
  });
  it.each([
    [429, "failed"], [500, "failed"], [503, "failed"], [599, "failed"],
    [302, "paused"], [401, "paused"], [402, "paused"], [403, "paused"], [422, "paused"],
  ] as const)("retains a captured scheduled HTTP %i as %s without immediate retry", async (status, state) => {
    await applyOfapiCollectionPolicy(app.db, { expectedRevision: 0, changes: [{ pageId,
      category: "profile_notifications", mode: "scheduled", intervalMinutes: 15,
      dailyCreditLimit: 10, maxCallsPerRun: 1, includeDetails: false }] }, actor);
    const scheduledAt = new Date();
    const [id] = await enqueueDueOfapiCollectionSchedules(app.db, ["profile_notifications"], scheduledAt);
    const body = JSON.stringify({ error: "synthetic", _meta: { _credits: { used: 1, balance: 9999 } } });
    const fetch = vi.fn(async () => new Response(body, { status }));
    vi.stubGlobal("fetch", fetch);
    expect(await runOfapiCollectionJob(app, id!)).toEqual({ state, reason: `Vendor HTTP ${status}; response captured` });
    const stopped = (await getOfapiCollectionJob(app.db, id!))!;
    expect(stopped.used_calls).toBe(1);
    expect(Number(stopped.used_credits)).toBe(1);
    expect(Number(stopped.used_bytes)).toBe(Buffer.byteLength(body));
    expect(stopped.checkpoint.failedResponseStatus).toBe(status);
    expect((await db.pool.query("select count(*)::int count from observations where kind='ofapi.collection_read_response.v1'")).rows[0].count).toBe(1);
    expect(await runOfapiCollectionJob(app, id!)).toEqual({ state: "busy" });
    expect(await enqueueDueOfapiCollectionSchedules(app.db, ["profile_notifications"], new Date(scheduledAt.getTime() + 14 * 60000))).toEqual([]);
    expect(await enqueueDueOfapiCollectionSchedules(app.db, ["profile_notifications"], new Date(scheduledAt.getTime() + 16 * 60000)))
      .toHaveLength(state === "failed" ? 1 : 0);
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(await readOfapiStoredSnapshots(app.db, { pageId })).toEqual([]);
  });
  it("keeps a one-off 503 paused and charges its retained bytes once across owner resumes", async () => {
    const approved = await job(["me"], 1);
    const body = JSON.stringify({ error: "unavailable", _meta: { _credits: { used: 1, balance: 9999 } } });
    const fetch = vi.fn(async () => new Response(body, { status: 503 }));
    vi.stubGlobal("fetch", fetch);
    for (let revision = 0; revision < 3; revision++) {
      if (revision) await resumeOfapiCollectionJob(app.db, approved.id, revision - 1, actor);
      expect(await runOfapiCollectionJob(app, approved.id)).toEqual({ state: "paused", reason: "Vendor HTTP 503; response captured" });
      const paused = (await getOfapiCollectionJob(app.db, approved.id))!;
      expect(paused.used_calls).toBe(1);
      expect(Number(paused.used_credits)).toBe(1);
      expect(Number(paused.used_bytes)).toBe(Buffer.byteLength(body));
    }
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(await readOfapiStoredSnapshots(app.db, { pageId })).toEqual([]);
  });
  it.each(["indeterminate", "invalid_json", "invalid_contract"] as const)("does not grant a fresh scheduled request after %s failure", async (failure) => {
    await applyOfapiCollectionPolicy(app.db, { expectedRevision: 0, changes: [{ pageId,
      category: "profile_notifications", mode: "scheduled", intervalMinutes: 15,
      dailyCreditLimit: 10, maxCallsPerRun: 2, includeDetails: false }] }, actor);
    const scheduledAt = new Date();
    const [id] = await enqueueDueOfapiCollectionSchedules(app.db, ["profile_notifications"], scheduledAt);
    const fetch = vi.fn(async () => {
      if (failure === "indeterminate") throw new Error("connection reset after dispatch");
      return failure === "invalid_json" ? new Response("<html>malformed response</html>") : response({ list: "invalid" });
    });
    vi.stubGlobal("fetch", fetch);
    const handlers = { profile_notifications: { plan: () => [{ operation: "ofapi_read_fans_expired",
      pathname: "/acct_test/fans/expired", query: { limit: "20", offset: "0" } }] } };
    expect(await runOfapiCollectionJob(app, id!, handlers)).toMatchObject({ state: "paused" });
    if (failure === "indeterminate")
      expect((await db.pool.query("select state from ofapi_request_attempts")).rows).toEqual([{ state: "indeterminate" }]);
    await resumeOfapiCollectionJob(app.db, id!, 1, actor);
    expect(await runOfapiCollectionJob(app, id!, handlers)).toMatchObject({ state: "paused" });
    expect(await enqueueDueOfapiCollectionSchedules(app.db, ["profile_notifications"], new Date(scheduledAt.getTime() + 16 * 60000))).toEqual([]);
    expect(fetch).toHaveBeenCalledTimes(1);
    expect((await getOfapiCollectionJob(app.db, id!))!.used_calls).toBe(1);
    expect(await readOfapiStoredSnapshots(app.db, { pageId })).toEqual([]);
  });
  it("reuses the paid step after its plan round-trips through JSONB and local materialization fails", async () => {
    const fetch = vi.fn(async () => response({ id: "55", username: "creator" }));
    vi.stubGlobal("fetch", fetch);
    const approved = await createOfapiCollectionJob(app.db, {
      pageId, category: "profile_notifications", expectedRevision: 0,
      maxCalls: 1, maxCredits: 1, maxBytes: 100000,
      from: null, to: null, selection: ["me"],
    }, actor);
    const materialize = vi.fn().mockRejectedValueOnce(new Error("Local projection temporarily unavailable")).mockResolvedValue(undefined);
    const handlers = { profile_notifications: { plan: planOfapiReadCollection, materialize } };
    expect(await runOfapiCollectionJob(app, approved.id, handlers)).toEqual({ state: "queued", reason: "Local projection temporarily unavailable" });
    const checkpoint = (await getOfapiCollectionJob(app.db, approved.id))!;
    expect(checkpoint.used_calls).toBe(1);
    expect(Number(checkpoint.used_credits)).toBe(1);
    expect(await runOfapiCollectionJob(app, approved.id, handlers)).toEqual({ state: "completed" });
    expect(fetch).toHaveBeenCalledTimes(1);
    const completed = (await getOfapiCollectionJob(app.db, approved.id))!;
    expect(Number(completed.used_credits)).toBe(1);
    expect(completed.used_calls).toBe(1);
    expect(Number(completed.used_bytes)).toBeGreaterThan(0);
    expect((await db.pool.query("select count(*)::int count from ofapi_capture_jobs where kind='collection_read'")).rows[0].count).toBe(1);
    expect(await readOfapiStoredSnapshots(app.db, { pageId })).toHaveLength(1);
  });
  it.each(["retained", "wrong_query", "changed_binding", "no_response"] as const)("recovers an exhausted legacy checkpoint only from its exact captured response: %s", async (scenario) => {
    const fetch = vi.fn(async () => response({ id: "55", username: "creator" }));
    vi.stubGlobal("fetch", fetch);
    const approved = await createOfapiCollectionJob(app.db, {
      pageId, category: "profile_notifications", expectedRevision: 0,
      maxCalls: 1, maxCredits: 1, maxBytes: 100000,
      from: null, to: null, selection: ["me"],
    }, actor);
    const step = { operation: "ofapi_read_me", pathname: "/acct_test/me", query: {}, detail: false };
    const token = (await claimOfapiCollectionJob(app.db, approved.id))!;
    await checkpointOfapiCollectionJob(app.db, { id: approved.id, token, checkpoint: { plan: [step] }, state: "running" });
    if (scenario === "no_response") {
      await reserveOfapiCollectionRequest(app.db, { pageId, operation: step.operation, requestId: randomUUID(),
        context: { category: "profile_notifications", purpose: "one_off", jobId: approved.id } });
    } else {
      // Match the slot spelling deployed before canonical JSON identity. The
      // runner must adopt this paid response despite a different current slot.
      await captureOfapiCollectionRead(app, {
        pageId, accountId: "acct_test", step,
        stepKey: `${approved.id}:0:${createHash("sha256").update(JSON.stringify(step)).digest("hex")}`,
        context: { category: "profile_notifications", purpose: "one_off", jobId: approved.id },
        maxBytes: 100000, beforeDispatch: async () => true,
      });
    }
    const checkpoint = { plan: [step], ...(scenario === "wrong_query" ? { nextQuery: { changed: "scope" } } : {}) };
    await checkpointOfapiCollectionJob(app.db, { id: approved.id, token, checkpoint, state: "paused", reason: "local_recovery_failed" });
    if (scenario === "changed_binding") await db.pool.query("update pages set ofapi_account_id='acct_changed' where id=$1", [pageId]);
    if (scenario !== "retained") {
      await expect(resumeOfapiCollectionJob(app.db, approved.id, 0, actor)).rejects.toThrow("job_not_resumable");
      expect(fetch).toHaveBeenCalledTimes(scenario === "no_response" ? 0 : 1);
      return;
    }
    expect(await resumeOfapiCollectionJob(app.db, approved.id, 0, actor)).toMatchObject({ state: "queued", revision: 1 });
    expect(await runOfapiCollectionJob(app, approved.id)).toEqual({ state: "completed" });
    expect(fetch).toHaveBeenCalledTimes(1);
    const completed = (await getOfapiCollectionJob(app.db, approved.id))!;
    expect(completed.used_calls).toBe(1);
    expect(Number(completed.used_credits)).toBe(1);
    expect(Number(completed.max_credits)).toBe(1);
    expect(completed.max_calls).toBe(1);
    expect(Number(completed.used_bytes)).toBeGreaterThan(0);
    expect((await db.pool.query("select count(*)::int count from ofapi_capture_jobs where kind='collection_read'")).rows[0].count).toBe(1);
  });
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
  it("retains an exhausted scheduled cursor as incomplete and admits the next bounded interval", async () => {
    const settings = { pageId, category: "profile_notifications" as const, mode: "scheduled" as const,
      intervalMinutes: 15, dailyCreditLimit: 10, maxCallsPerRun: 1, includeDetails: false };
    await applyOfapiCollectionPolicy(app.db, { expectedRevision: 0, changes: [settings] }, actor);
    const fetch = vi.fn<typeof globalThis.fetch>()
      .mockResolvedValueOnce(response({ list: [{ id: "55" }], hasMore: true, nextOffset: 20 }))
      .mockResolvedValueOnce(response({ list: [{ id: "56" }], hasMore: false }));
    vi.stubGlobal("fetch", fetch);
    const handlers = { profile_notifications: { plan: () => [{ operation: "ofapi_read_fans_expired",
      pathname: "/acct_test/fans/expired", query: { limit: "20", offset: "0" } }] } };
    const [firstId] = await enqueueDueOfapiCollectionSchedules(app.db, ["profile_notifications"]);
    expect(await runOfapiCollectionJob(app, firstId!, handlers)).toEqual({
      state: "failed", reason: "scheduled_run_exhausted:job_limit",
    });
    const first = await getOfapiCollectionJob(app.db, firstId!);
    expect(first).toMatchObject({ state: "failed", used_calls: 1, checkpoint: { index: 0, nextQuery: { offset: "20" } } });
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(await enqueueDueOfapiCollectionSchedules(app.db, ["profile_notifications"])).toEqual([]);
    const snapshots = await readOfapiStoredSnapshots(app.db, { pageId });
    expect(snapshots).toHaveLength(1);
    expect(snapshots[0]!.coverage).toMatchObject({ state: "partial", nextQuery: { offset: "20" } });
    // Advance the schedule/usage windows without resetting task spend or its cursor.
    await db.pool.query("update ofapi_collection_schedules set last_scheduled_at=now()-interval '16 minutes'");
    await db.pool.query("update ofapi_collection_requests set created_at=now()-interval '16 minutes'");
    const [nextId] = await enqueueDueOfapiCollectionSchedules(app.db, ["profile_notifications"]);
    expect(nextId).toBeDefined(); expect(nextId).not.toBe(firstId);
    expect(await runOfapiCollectionJob(app, nextId!, handlers)).toEqual({ state: "completed" });
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(new URL(String(fetch.mock.calls[1]![0])).searchParams.get("offset")).toBe("0");
    expect((await getOfapiCollectionJob(app.db, firstId!))!.checkpoint).toEqual(first!.checkpoint);
    expect(await readOfapiStoredSnapshots(app.db, { pageId })).toHaveLength(2);
  });
  it("releases both bounded allowances when the final authority check throws before HTTP", async () => {
    const fetch = vi.fn(); vi.stubGlobal("fetch", fetch);
    const approved = await job(["me"], 1);
    await expect(captureOfapiCollectionRead(app, {
      pageId, accountId: "acct_test", step: { operation: "ofapi_read_me", pathname: "/acct_test/me", query: {} },
      stepKey: `authority-refused:${approved.id}`, maxBytes: 100000,
      context: { category: "profile_notifications", purpose: "one_off", jobId: approved.id },
      beforeDispatch: async () => { throw new Error("Binding changed at final admission"); },
    })).rejects.toMatchObject({ phase: "pre_dispatch", reason: "cancelled" });
    expect(fetch).not.toHaveBeenCalled();
    const retained = await getOfapiCollectionJob(app.db, approved.id);
    expect(retained?.used_calls).toBe(0); expect(Number(retained?.used_credits)).toBe(0);
    expect((await db.pool.query("select state,credit_state from ofapi_request_attempts")).rows)
      .toEqual([{ state: "released_pre_dispatch", credit_state: "released" }]);
    expect((await db.pool.query("select state from ofapi_collection_requests")).rows).toEqual([{ state: "released" }]);
    expect((await db.pool.query("select count(*)::int count from ofapi_credit_receipts")).rows[0].count).toBe(0);
    expect((await db.pool.query("select count(*)::int count from observations where kind='ofapi.collection_read_response.v1'")).rows[0].count).toBe(0);
    // A fresh reviewed attempt can still use the unchanged one-call ceiling.
    await reserveOfapiCollectionRequest(app.db, { pageId, operation: "ofapi_read_me", requestId: randomUUID(),
      context: { category: "profile_notifications", purpose: "one_off", jobId: approved.id } });
  });
  it.each(["daily_limit", "interval_limit"])("terminates a scheduled %s refusal without bypassing a later owner pause", async (limit) => {
    await applyOfapiCollectionPolicy(app.db, { expectedRevision: 0, changes: [{ pageId,
      category: "profile_notifications", mode: "scheduled", intervalMinutes: 15, includeDetails: false,
      dailyCreditLimit: limit === "daily_limit" ? 1 : 10, maxCallsPerRun: limit === "interval_limit" ? 1 : 10 }] }, actor);
    await reserveOfapiCollectionRequest(app.db, { pageId, operation: "ofapi_read_me", requestId: "previous-run",
      context: { category: "profile_notifications", purpose: "background" } });
    const fetch = vi.fn(); vi.stubGlobal("fetch", fetch);
    const [id] = await enqueueDueOfapiCollectionSchedules(app.db, ["profile_notifications"]);
    expect(await runOfapiCollectionJob(app, id!)).toEqual({ state: "failed", reason: `scheduled_run_exhausted:${limit}` });
    expect((await getOfapiCollectionJob(app.db, id!))?.used_calls).toBe(0);
    expect(fetch).not.toHaveBeenCalled();
    await applyOfapiCollectionPolicy(app.db, { expectedRevision: 1, changes: [], backgroundPaused: true }, actor);
    expect(await enqueueDueOfapiCollectionSchedules(app.db, ["profile_notifications"], new Date(Date.now() + 86400000))).toEqual([]);
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

// 2026-09-18: a 93% disk refused every scheduled read at capture admission.
// Each run parked as paused and held its category's schedule until an owner
// noticed; nothing was collected again for two weeks.
describe("capture-admission refusals of scheduled runs", () => {
  const setStorageHealthy = (healthy: boolean) =>
    db.pool.query(
      "update ofapi_storage_health_state set healthy=$1,breached=$2,checked_at=clock_timestamp(),updated_at=clock_timestamp()",
      [healthy, !healthy],
    );
  async function scheduledRun(at: Date) {
    await applyOfapiCollectionPolicy(app.db, { expectedRevision: 0, changes: [{ pageId,
      category: "profile_notifications", mode: "scheduled", intervalMinutes: 15,
      dailyCreditLimit: 10, maxCallsPerRun: 1, includeDetails: false }] }, actor);
    const [id] = await enqueueDueOfapiCollectionSchedules(app.db, ["profile_notifications"], at);
    return id!;
  }
  const later = (at: Date) => new Date(at.getTime() + 16 * 60000);

  it("ends a refused scheduled run failed with no request, and the next interval schedules", async () => {
    const at = new Date();
    const id = await scheduledRun(at);
    await setStorageHealthy(false);
    const fetch = vi.fn();
    vi.stubGlobal("fetch", fetch);
    expect(await runOfapiCollectionJob(app, id)).toEqual({
      state: "failed",
      reason: "scheduled_run_refused:storage_unhealthy",
    });
    expect(fetch).not.toHaveBeenCalled();
    expect(await getOfapiCollectionJob(app.db, id)).toMatchObject({ state: "failed", used_calls: 0 });
    await setStorageHealthy(true);
    const next = await enqueueDueOfapiCollectionSchedules(app.db, ["profile_notifications"], later(at));
    expect(next).toHaveLength(1);
    expect(next[0]).not.toBe(id);
  });

  it("keeps a refused one-off run paused for the owner", async () => {
    const created = await job(["me"]);
    await setStorageHealthy(false);
    const fetch = vi.fn();
    vi.stubGlobal("fetch", fetch);
    expect(await runOfapiCollectionJob(app, created.id)).toEqual({
      state: "paused",
      reason: "Capture admission: storage_unhealthy",
    });
    expect(fetch).not.toHaveBeenCalled();
  });

  it("closes runs parked by a refusal before the fix, and no other pause", async () => {
    const at = new Date();
    const id = await scheduledRun(at);
    const token = (await claimOfapiCollectionJob(app.db, id))!;
    await checkpointOfapiCollectionJob(app.db, { id, token, checkpoint: {}, state: "paused",
      reason: "Capture admission: storage_unhealthy" });
    expect(await enqueueDueOfapiCollectionSchedules(app.db, ["profile_notifications"], later(at))).toEqual([]);

    expect(await closeAdmissionRefusedOfapiCollectionRuns(app.db)).toEqual([{
      id, pageId, category: "profile_notifications", reason: "scheduled_run_refused:storage_unhealthy",
    }]);
    expect(await getOfapiCollectionJob(app.db, id)).toMatchObject({
      state: "failed", reason: "scheduled_run_refused:storage_unhealthy", lease_token: null,
    });
    const [nextId] = await enqueueDueOfapiCollectionSchedules(app.db, ["profile_notifications"], later(at));
    expect(nextId).toBeDefined();

    // A pause held for a captured vendor outcome stays for the owner.
    const nextToken = (await claimOfapiCollectionJob(app.db, nextId!))!;
    await checkpointOfapiCollectionJob(app.db, { id: nextId!, token: nextToken, checkpoint: {}, state: "paused",
      reason: "Vendor HTTP 404; response captured" });
    expect(await closeAdmissionRefusedOfapiCollectionRuns(app.db)).toEqual([]);
    expect(await getOfapiCollectionJob(app.db, nextId!)).toMatchObject({ state: "paused" });
  });
});

describe("OnlyFans payout requests dataset", () => {
  it("captures payout requests and serves one latest row per invoice to read:money keys", async () => {
    const collect = async (list: unknown[]) => {
      const created = await createOfapiCollectionJob(app.db, {
        pageId, category: "balances", expectedRevision: 0, maxCalls: 1, maxCredits: 10,
        maxBytes: 100000, from: null, to: null, selection: ["payout_requests"],
      }, actor);
      const fetch = vi.fn(async (_url: unknown) => response({ list, marker: 2 }));
      vi.stubGlobal("fetch", fetch);
      expect(await runOfapiCollectionJob(app, created.id)).toEqual({ state: "completed" });
      expect(fetch).toHaveBeenCalledTimes(1);
      expect(String(fetch.mock.calls[0]?.[0])).toContain("/payouts/payout-requests?limit=50&offset=0");
    };
    await collect([
      { invoiceId: "9001", createdAt: "2026-09-20T10:00:00+00:00", amount: 247.46, currency: "USD", state: "new", rejectReason: null },
      { invoiceId: "9000", createdAt: "2026-09-13T10:00:00+00:00", amount: 300, currency: "USD", state: "done", rejectReason: null },
    ]);
    // The same invoice, observed later in its final state.
    await collect([
      { invoiceId: "9001", createdAt: "2026-09-20T10:00:00+00:00", amount: 247.46, currency: "USD", state: "done", rejectReason: null },
    ]);

    await setConfigOverride(app.db, { key: "agentReadPlaneMode", value: "full", userId: actor, groupId: randomUUID() });
    const makeKey = async (name: string, capabilities: string[]) => {
      const token = `${AGENT_KEY_TOKEN_PREFIX}${name}-synthetic-token`;
      await insertAgentKey(app.db, {
        name, keyPrefix: token.slice(0, AGENT_KEY_TOKEN_PREFIX.length + 6), keyDigest: sha256Hex(token),
        capabilities, pageIds: [pageId], dailyRequestBudget: 100, dailyRowBudget: 10000,
        expiresAt: new Date(Date.now() + 86400000), createdBy: actor,
      });
      return token;
    };
    const money = await makeKey("payouts-money", ["read:datasets", "read:money"]);
    const noMoney = await makeKey("payouts-no-money", ["read:datasets"]);
    const server = await buildApiServer(app);
    try {
      const query = (token: string) => server.inject({
        method: "POST",
        url: "/api/v1/agent/pages/read-page/datasets/ofapi_payout_requests/query",
        headers: { authorization: `Bearer ${token}` },
        payload: { from: "2026-09-01T00:00:00Z", to: "2026-10-01T00:00:00Z", limit: 20 },
      });
      expect((await query(noMoney)).statusCode).toBe(403);
      const result = await query(money);
      expect(result.statusCode, result.body).toBe(200);
      const body = JSON.parse(result.body) as {
        items: Array<{ fields: Record<string, unknown> }>;
        capture: { planes: Array<{ plane: string; state: string; captureFloor?: { at: string | null } }> };
      };
      expect(body.items.map((item) => item.fields)).toEqual([
        expect.objectContaining({ platform: "onlyfans", payoutRef: "9001", amountMills: 247460, currency: "USD",
          state: "done", rejectReason: null, requestedAt: "2026-09-20T10:00:00.000Z" }),
        expect.objectContaining({ payoutRef: "9000", amountMills: 300000, state: "done",
          requestedAt: "2026-09-13T10:00:00.000Z" }),
      ]);
      expect(body.capture.planes).toContainEqual(expect.objectContaining({
        plane: "ofapi_read_snapshots", state: "read",
        captureFloor: expect.objectContaining({ at: "2026-09-13T10:00:00.000Z" }),
      }));
    } finally {
      await server.close();
    }
  });
});
