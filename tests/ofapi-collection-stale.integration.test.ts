import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import {
  applyOfapiCollectionPolicy,
  createModel,
  createOnlyFansPage,
  enqueueDueOfapiCollectionSchedules,
  getOfapiCollectionSnapshot,
  listOfapiCollectionScheduleHealth,
  setPageOfapiAccountId,
} from "@agency_hub_core/db";
import type { OfapiCollectionSettings } from "@agency_hub_core/shared";
import { buildApiServer } from "../apps/runtime/src/api/server.ts";
import { createUserAccount } from "../apps/runtime/src/services/auth.ts";
import { ofapiCollectionPolicyHooks } from "../apps/runtime/src/services/ofapi-collection-policy.ts";
import { runOfapiCollectionJob, sweepOfapiCollections } from "../apps/runtime/src/services/ofapi-collection-runner.ts";
import { checkOfapiCollectionStaleness } from "../apps/runtime/src/services/ofapi-collection-stale.ts";
import { createOfapiClient } from "../apps/runtime/src/services/ofapi.ts";
import { startIntegrationTestDatabase, resetIntegrationDatabase, type StartedTestDatabase } from "./helpers/db.ts";
import { createTestAppContext } from "./helpers/runtime.ts";

// Fixture passwords hash at minimum cost; sign-in still runs the real argon2 verify.
vi.mock("argon2", () => import("./helpers/cheap-argon2.ts"));

// Traffic sources plan §2.8 п. 3 (PR 19): a scheduled collection category no
// run completed for more than two intervals is stale — flagged in the
// collection snapshot, one digest-only incident per page — and the job list
// keeps every unfinished run reachable.

let testDb: StartedTestDatabase;
let app: ReturnType<typeof createTestAppContext>;
let pageId: number;
let otherPageId: number;
let actor: number;
let server: Awaited<ReturnType<typeof buildApiServer>> | null = null;
beforeAll(async () => {
  const started = await startIntegrationTestDatabase();
  if (!started) throw new Error("Integration database unavailable");
  testDb = started;
}, 120_000);
afterAll(async () => { await testDb?.stop(); });
afterEach(async () => { vi.unstubAllGlobals(); await server?.close(); server = null; });
beforeEach(async () => {
  await resetIntegrationDatabase(testDb.pool);
  app = createTestAppContext(testDb);
  actor = (await createUserAccount(app, { username: "owner", role: "owner", password: "synthetic-password" }, { source: "cli" })).id;
  const model = await createModel(app.db, { slug: "stale", name: "Stale" });
  pageId = (await createOnlyFansPage(app.db, { modelId: model!.id, label: "stale-of" }))!.id;
  otherPageId = (await createOnlyFansPage(app.db, { modelId: model!.id, label: "fresh-of" }))!.id;
  await setPageOfapiAccountId(app.db, { pageId, ofapiAccountId: "acct_stale" });
  await setPageOfapiAccountId(app.db, { pageId: otherPageId, ofapiAccountId: "acct_fresh" });
  await testDb.pool.query("insert into ofapi_credit_state(id,last_balance,last_balance_at) values(1,10000,now()) on conflict(id) do update set last_balance=10000,last_balance_at=now()");
  app.ofapi = createOfapiClient({ apiKey: "synthetic", restDelayMs: 0, ...ofapiCollectionPolicyHooks(app.db) });
});

const scheduled = (page: number, overrides: Partial<OfapiCollectionSettings> = {}): OfapiCollectionSettings => ({
  pageId: page, category: "profile_notifications", mode: "scheduled", intervalMinutes: 15,
  dailyCreditLimit: 10, maxCallsPerRun: 1, includeDetails: false, ...overrides,
});
async function apply(changes: OfapiCollectionSettings[], backgroundPaused?: boolean) {
  const revision = Number((await testDb.pool.query("select revision from ofapi_collection_state where id=1")).rows[0].revision);
  return applyOfapiCollectionPolicy(app.db, { expectedRevision: revision, changes, ...(backgroundPaused === undefined ? {} : { backgroundPaused }) }, actor);
}
/** A background run row as the runner leaves it, without a vendor call. */
async function backgroundRun(input: { page: number; state: string; reason?: string | null; minutesAgo: number; usedCalls?: number; maxCalls?: number; plan?: number; index?: number }) {
  const checkpoint = input.plan === undefined ? {} : { plan: Array.from({ length: input.plan }, (_, i) => ({ operation: "ofapi_read_notifications", pathname: `/acct/${i}`, query: {} })), index: input.index ?? 0 };
  const row = await testDb.pool.query(`insert into ofapi_collection_jobs(id,page_id,category,policy_revision,actor_user_id,max_credits,max_calls,max_bytes,target,purpose,state,reason,used_calls,checkpoint,created_at,updated_at)
    values(gen_random_uuid(),$1,'profile_notifications',1,$2,10,$3,1000,'{"from":null,"to":null,"selection":[]}','background',$4,$5,$6,$7::jsonb,now()-make_interval(mins=>$8+5),now()-make_interval(mins=>$8)) returning id`,
  [input.page, actor, input.maxCalls ?? 1, input.state, input.reason ?? null, input.usedCalls ?? 0, JSON.stringify(checkpoint), input.minutesAgo]);
  return String(row.rows[0].id);
}
const backdatePolicies = (minutes: number) => testDb.pool.query(`update ofapi_collection_policies set updated_at=now()-make_interval(mins=>$1)`, [minutes]);
const healthOf = async (page: number, now?: Date) => (await getOfapiCollectionSnapshot(app.db, null, undefined, now ? { now } : {}))
  .policies.find(row => row.pageId === page && row.category === "profile_notifications")!.scheduleHealth;

describe("stale scheduled collection categories", () => {
  it("a run that outgrows its call cap leaves the category stale after two intervals, with the cap and its step in the last run", async () => {
    await apply([scheduled(pageId)]);
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({
      data: { list: [{ id: "55" }], hasMore: true, nextOffset: 20 }, _meta: { _credits: { used: 1, balance: 9999 } },
    }))));
    const handlers = { profile_notifications: { plan: () => [
      { operation: "ofapi_read_fans_expired", pathname: "/acct_stale/fans/expired", query: { limit: "20", offset: "0" } },
      { operation: "ofapi_read_notifications", pathname: "/acct_stale/notifications", query: { limit: "50", offset: "0" } },
    ] } };
    const [runId] = await enqueueDueOfapiCollectionSchedules(app.db, ["profile_notifications"]);
    expect(await runOfapiCollectionJob(app, runId!, handlers)).toEqual({ state: "failed", reason: "scheduled_run_exhausted:job_limit" });

    const appliedAt: Date = (await testDb.pool.query("select updated_at from ofapi_collection_policies where page_id=$1", [pageId])).rows[0].updated_at;
    // Two 15-minute intervals from the owner's change: not yet stale, then stale.
    const fresh = await healthOf(pageId, new Date(appliedAt.getTime() + 29 * 60_000));
    expect(fresh).toMatchObject({ expected: true, stale: false, staleAt: new Date(appliedAt.getTime() + 30 * 60_000).toISOString(), lastCompletedAt: null });
    const stale = await healthOf(pageId, new Date(appliedAt.getTime() + 31 * 60_000));
    expect(stale).toMatchObject({ expected: true, stale: true, lastCompletedAt: null });
    expect(stale.lastRun).toMatchObject({ id: runId, state: "failed", reason: "scheduled_run_exhausted:job_limit", exhaustedLimit: "job_limit",
      usedCalls: 1, maxCalls: 1, stepsDone: 0, stepsTotal: 2 });
    // The page that never had the category scheduled is not expected to run it.
    expect(await healthOf(otherPageId, new Date(appliedAt.getTime() + 31 * 60_000))).toMatchObject({ expected: false, stale: false, staleAt: null });
  });

  it("counts from the later of the last completed run and the owner's last change; pause and off are never stale", async () => {
    await apply([scheduled(pageId, { intervalMinutes: 60 })]);
    await backdatePolicies(10 * 24 * 60);
    await backgroundRun({ page: pageId, state: "completed", minutesAgo: 100, plan: 2, index: 2 });
    expect(await healthOf(pageId)).toMatchObject({ expected: true, stale: false });
    await testDb.pool.query("update ofapi_collection_jobs set updated_at=now()-interval '121 minutes' where state='completed'");
    const stale = await healthOf(pageId);
    expect(stale).toMatchObject({ expected: true, stale: true });
    expect(stale.lastCompletedAt).not.toBeNull();
    // The owner raises the cap: two fresh intervals from that change.
    await apply([scheduled(pageId, { intervalMinutes: 60, maxCallsPerRun: 25 })]);
    expect(await healthOf(pageId)).toMatchObject({ expected: true, stale: false });
    await backdatePolicies(10 * 24 * 60);
    expect(await healthOf(pageId)).toMatchObject({ stale: true });
    // The global background pause and an off policy promise nothing.
    await apply([], true);
    expect(await healthOf(pageId)).toMatchObject({ expected: false, stale: false });
    await apply([scheduled(pageId, { mode: "off" })], false);
    expect(await healthOf(pageId)).toMatchObject({ expected: false, stale: false });
  });

  it("the minutely sweep keeps one digest-only incident per stale page and resolves it when a run completes", async () => {
    await apply([scheduled(pageId)]);
    await apply([scheduled(otherPageId)]);
    await backdatePolicies(60);
    await backgroundRun({ page: pageId, state: "failed", reason: "scheduled_run_exhausted:job_limit", minutesAgo: 10, usedCalls: 25, maxCalls: 25, plan: 4, index: 1 });
    await backgroundRun({ page: otherPageId, state: "completed", minutesAgo: 5, plan: 4, index: 4 });
    const send = vi.fn(async () => null);
    await sweepOfapiCollections(app, { send } as unknown as Parameters<typeof sweepOfapiCollections>[1]);

    const incidents = async () => (await testDb.pool.query(
      "select incident_key,platform_account_id::int,status,error_code,error_summary from notification_incidents where kind='read_gateway_capture' order by incident_key")).rows;
    expect(await incidents()).toEqual([{
      incident_key: `read_gateway_capture:${pageId}:collection_stale`, platform_account_id: pageId, status: "open", error_code: "collection_stale",
      error_summary: "No scheduled run completed for 2+ intervals: profile_notifications (run hits its call cap 25/25, step 2/4)",
    }]);
    // The sweep's own schedule pass is unaffected: the stale page's category is scheduled again.
    expect((await testDb.pool.query("select count(*)::int n from ofapi_collection_jobs where state='queued' and page_id=$1", [pageId])).rows[0].n).toBe(1);

    // The next run is under way: the cause still names the capped run. A
    // second pass refreshes the same latch, no second row.
    expect((await listOfapiCollectionScheduleHealth(app.db)).find(row => row.pageId === pageId)!.health.lastRun)
      .toMatchObject({ state: "failed", exhaustedLimit: "job_limit" });
    await checkOfapiCollectionStaleness(app);
    expect(await incidents()).toHaveLength(1);

    await testDb.pool.query("update ofapi_collection_jobs set state='completed',updated_at=now() where state='queued' and page_id=$1", [pageId]);
    expect(await checkOfapiCollectionStaleness(app)).toEqual({ stalePages: [], resolvedPages: [pageId] });
    expect((await incidents())[0]).toMatchObject({ status: "resolved" });
    // A healthy fleet resolves nothing and opens nothing.
    expect(await checkOfapiCollectionStaleness(app)).toEqual({ stalePages: [], resolvedPages: [] });
  });

  it("the stale check's input holds only the (page, category) pairs a schedule promises", async () => {
    await apply([scheduled(pageId)]);
    const rows = await listOfapiCollectionScheduleHealth(app.db);
    expect(rows.map(row => [row.pageId, row.category])).toEqual([[pageId, "profile_notifications"]]);
  });
});

describe("collection job list", () => {
  it("lists paused jobs first and a state filter reaches an unfinished job past the first hundred", async () => {
    const parked = await backgroundRun({ page: pageId, state: "paused", reason: "OFAPI collection policy refused dispatch", minutesAgo: 30 * 24 * 60 });
    await testDb.pool.query(`insert into ofapi_collection_jobs(id,page_id,category,policy_revision,actor_user_id,max_credits,max_calls,max_bytes,target,purpose,state,created_at,updated_at)
      select gen_random_uuid(),$1,'balances',1,$2,4,4,1000,'{"from":null,"to":null,"selection":[]}','background','completed',now()-make_interval(mins=>g),now()-make_interval(mins=>g)
      from generate_series(1,120) g`, [pageId, actor]);
    const queuedOld = await backgroundRun({ page: pageId, state: "queued", minutesAgo: 20 * 24 * 60 });

    const all = await getOfapiCollectionSnapshot(app.db, null);
    expect(all.jobs).toHaveLength(100);
    expect(all.jobs[0]).toMatchObject({ id: parked, state: "paused", stepsDone: null, stepsTotal: null });
    expect(all.jobs.map(job => job.id)).not.toContain(queuedOld);

    const unfinished = await getOfapiCollectionSnapshot(app.db, null, undefined, { jobState: "unfinished" });
    expect(unfinished.jobs.map(job => [job.id, job.state])).toEqual([[parked, "paused"], [queuedOld, "queued"]]);
    expect((await getOfapiCollectionSnapshot(app.db, null, undefined, { jobState: "queued" })).jobs.map(job => job.id)).toEqual([queuedOld]);
    expect((await getOfapiCollectionSnapshot(app.db, null, undefined, { jobState: "completed" })).jobs).toHaveLength(100);

    // Through the route: the filter is a query parameter of the owner's GET; an unknown state is refused.
    server = await buildApiServer(app);
    const login = await server.inject({ method: "POST", url: "/api/v1/auth/login", payload: { username: "owner", password: "synthetic-password" } });
    const cookie = String(([] as string[]).concat(login.headers["set-cookie"] ?? [])[0]).split(";")[0]!;
    const filtered = await server.inject({ method: "GET", url: "/api/v1/admin/ofapi/collection?jobState=paused", headers: { cookie } });
    expect(filtered.statusCode).toBe(200);
    expect(filtered.json().jobs.map((job: { id: string }) => job.id)).toEqual([parked]);
    expect(filtered.json().policies[0].scheduleHealth).toMatchObject({ expected: expect.any(Boolean), stale: expect.any(Boolean) });
    expect((await server.inject({ method: "GET", url: "/api/v1/admin/ofapi/collection?jobState=blocked", headers: { cookie } })).statusCode).toBe(400);
  });
});
