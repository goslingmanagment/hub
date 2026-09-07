import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import {
  applyOfapiCollectionPolicy, createModel, createOnlyFansPage, createOfapiCollectionJob,
  enqueueDueOfapiCollectionSchedules, getOfapiCollectionSnapshot, setPageOfapiAccountId,
} from "@agency_hub_core/db";
import { createUserAccount } from "../apps/runtime/src/services/auth.ts";
import { buildApiServer } from "../apps/runtime/src/api/server.ts";
import { createOfapiClient } from "../apps/runtime/src/services/ofapi.ts";
import { ofapiCollectionPolicyHooks } from "../apps/runtime/src/services/ofapi-collection-policy.ts";
import { runOfapiCollectionJob } from "../apps/runtime/src/services/ofapi-collection-runner.ts";
import { startIntegrationTestDatabase, resetIntegrationDatabase, type StartedTestDatabase } from "./helpers/db.ts";
import { createTestAppContext } from "./helpers/runtime.ts";

let db: StartedTestDatabase;
let app: ReturnType<typeof createTestAppContext>;
let server: Awaited<ReturnType<typeof buildApiServer>>;
let pageId: number;
let actor: number;
let ownerCookie: string;
beforeAll(async () => {
  const started = await startIntegrationTestDatabase();
  if (!started) throw new Error("Integration database unavailable");
  db = started;
}, 120000);
afterAll(async () => { await db?.stop(); });
afterEach(async () => { vi.unstubAllGlobals(); await server?.close(); });
async function login(username: string, role: "owner" | "team_lead") {
  await createUserAccount(app, { username, role, password: "synthetic-password" }, { source: "cli" });
  const result = await server.inject({ method: "POST", url: "/api/v1/auth/login", payload: { username, password: "synthetic-password" } });
  expect(result.statusCode).toBe(200);
  const header = result.headers["set-cookie"];
  return (Array.isArray(header) ? header[0]! : String(header)).split(";")[0]!;
}
beforeEach(async () => {
  await resetIntegrationDatabase(db.pool);
  app = createTestAppContext(db);
  const model = (await createModel(app.db, { slug: "finish", name: "Finish incomplete" }))!;
  pageId = (await createOnlyFansPage(app.db, { modelId: model.id, label: "finish-of" }))!.id;
  await setPageOfapiAccountId(app.db, { pageId, ofapiAccountId: "acct_test" });
  await db.pool.query("insert into ofapi_credit_state(id,last_balance,last_balance_at) values(1,10000,now()) on conflict(id) do update set last_balance=10000,last_balance_at=now()");
  app.ofapi = createOfapiClient({ apiKey: "synthetic", restDelayMs: 0, ...ofapiCollectionPolicyHooks(app.db) });
  server = await buildApiServer(app);
  ownerCookie = await login("owner", "owner");
  actor = Number((await db.pool.query("select id from users where username='owner'")).rows[0].id);
});
const finish = (id: string, overrides: Record<string, unknown> = {}, cookie = ownerCookie) => server.inject({
  method: "POST", url: `/api/v1/admin/ofapi/collection/jobs/${id}/finish-incomplete`, headers: { cookie },
  payload: { pageId, expectedRevision: 1, expectedState: "paused", reason: "Owner reviewed the incomplete periodic run", ...overrides },
});
async function scheduled() {
  await applyOfapiCollectionPolicy(app.db, { expectedRevision: 0, changes: [{ pageId,
    category: "profile_notifications", mode: "scheduled", intervalMinutes: 15,
    dailyCreditLimit: 10, maxCallsPerRun: 3, includeDetails: false }] }, actor);
  const at = new Date();
  const [id] = await enqueueDueOfapiCollectionSchedules(app.db, ["profile_notifications"], at);
  return { id: id!, at };
}
const handlers = { profile_notifications: { plan: () => [{ operation: "ofapi_read_fans_expired",
  pathname: "/acct_test/fans/expired", query: { limit: "20", offset: "0" } }] } };

describe("owner finishes an incomplete scheduled OFAPI read", () => {
  it.each(["captured404", "indeterminate"] as const)("preserves partial data and %s charges, admits one CAS action, and waits for the next interval", async failure => {
    const { id, at } = await scheduled();
    const fetch = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ data: { list: [{ id: "55" }], hasMore: true, nextOffset: 20 }, _meta: { _credits: { used: 1, balance: 9999 } } })))
      .mockImplementationOnce(async () => {
        if (failure === "indeterminate") throw new Error("connection reset after dispatch");
        return new Response(JSON.stringify({ error: "not found", _meta: { _credits: { used: 1, balance: 9998 } } }), { status: 404 });
      });
    vi.stubGlobal("fetch", fetch);
    expect(await runOfapiCollectionJob(app, id, handlers)).toMatchObject({ state: "paused" });
    const before = (await db.pool.query("select * from ofapi_collection_jobs where id=$1", [id])).rows[0];
    expect(before.checkpoint).toMatchObject({ index: 0, nextQuery: { offset: "20" } });
    const tables = ["ofapi_capture_jobs", "ofapi_request_attempts", "ofapi_credit_ledger", "ofapi_credit_state", "ofapi_collection_requests", "observations", "ofapi_read_snapshots", "ofapi_collection_schedules"];
    const retained = await Promise.all(tables.map(table => db.pool.query(`select * from ${table} order by 1`)));
    expect((await getOfapiCollectionSnapshot(app.db, null)).jobs.find(job => job.id === id)?.canFinishIncomplete).toBe(true);
    expect((await getOfapiCollectionSnapshot(app.db, [pageId])).jobs.find(job => job.id === id)?.canFinishIncomplete).toBe(false);
    const results = await Promise.all([finish(id), finish(id)]);
    expect(results.map(result => result.statusCode).sort()).toEqual([200, 409]);
    expect(results.find(result => result.statusCode === 200)?.json()).toEqual({ id, state: "failed", revision: 2 });
    expect((await finish(id, { expectedRevision: 2 })).statusCode).toBe(409);
    const after = (await db.pool.query("select * from ofapi_collection_jobs where id=$1", [id])).rows[0];
    for (const key of ["target", "checkpoint", "max_credits", "max_calls", "max_bytes", "used_credits", "used_calls", "used_bytes", "policy_revision", "created_at"])
      expect(after[key], key).toEqual(before[key]);
    expect(after.state).toBe("failed");
    expect(after.reason).toBe("owner_finished_incomplete");
    for (let index = 0; index < tables.length; index++)
      expect((await db.pool.query(`select * from ${tables[index]} order by 1`)).rows, tables[index]).toEqual(retained[index]!.rows);
    const audit = (await db.pool.query("select actor_user_id,platform_account_id,metadata from audit_events where event_type='admin.ofapi_collection_job_finished_incomplete'")).rows;
    expect(audit).toHaveLength(1);
    expect(Number(audit[0].actor_user_id)).toBe(actor);
    expect(Number(audit[0].platform_account_id)).toBe(pageId);
    expect(audit[0].metadata).toMatchObject({ revision: 2, jobId: id, action: "finish_incomplete" });
    expect((await db.pool.query("select changes from ofapi_collection_audit where revision=2")).rows[0].changes.previousReason).toBe(before.reason);
    expect(await runOfapiCollectionJob(app, id, handlers)).toEqual({ state: "busy" });
    expect(await enqueueDueOfapiCollectionSchedules(app.db, ["profile_notifications"], new Date(at.getTime() + 14 * 60000))).toEqual([]);
    expect(await enqueueDueOfapiCollectionSchedules(app.db, ["profile_notifications"], new Date(at.getTime() + 16 * 60000))).toHaveLength(1);
    expect(fetch).toHaveBeenCalledTimes(2);
  });
  it("requires the owner session, matching page, current revision and paused state", async () => {
    const { id } = await scheduled();
    await db.pool.query("update ofapi_collection_jobs set state='paused' where id=$1", [id]);
    const fetch = vi.fn(); vi.stubGlobal("fetch", fetch);
    const leadCookie = await login("lead", "team_lead");
    expect((await finish(id, {}, "")).statusCode).toBe(401);
    expect((await finish(id, {}, leadCookie)).statusCode).toBe(403);
    expect((await finish(id, { expectedRevision: 0 })).statusCode).toBe(409);
    expect((await finish(id, { expectedState: "running" })).statusCode).toBe(400);
    const model = (await createModel(app.db, { slug: "other", name: "Other" }))!;
    const otherPage = (await createOnlyFansPage(app.db, { modelId: model.id, label: "other-of" }))!.id;
    expect((await finish(id, { pageId: otherPage })).statusCode).toBe(409);
    expect((await getOfapiCollectionSnapshot(app.db, null)).revision).toBe(1);
    expect((await db.pool.query("select state from ofapi_collection_jobs where id=$1", [id])).rows[0].state).toBe("paused");
    expect(fetch).not.toHaveBeenCalled();
  });
  it.each(["one_off", "export", "upload", "baseline", "queued", "running", "leased"] as const)("refuses %s work without changing the row or scheduling a request", async kind => {
    const { id } = await scheduled();
    await db.pool.query("update ofapi_collection_jobs set state='paused' where id=$1", [id]);
    if (kind === "one_off") await db.pool.query("update ofapi_collection_jobs set purpose='one_off' where id=$1", [id]);
    if (kind === "export" || kind === "upload") await db.pool.query("update ofapi_collection_jobs set target=target||jsonb_build_object('executor',$2::text) where id=$1", [id, kind]);
    if (kind === "baseline") await db.pool.query("update ofapi_collection_jobs set category='core_messages' where id=$1", [id]);
    if (kind === "queued" || kind === "running") await db.pool.query("update ofapi_collection_jobs set state=$2 where id=$1", [id, kind]);
    if (kind === "leased") await db.pool.query("update ofapi_collection_jobs set lease_token=$2,lease_until=now()+interval '3 minutes' where id=$1", [id, randomUUID()]);
    const before = (await db.pool.query("select * from ofapi_collection_jobs where id=$1", [id])).rows[0];
    expect((await getOfapiCollectionSnapshot(app.db, null)).jobs.find(job => job.id === id)?.canFinishIncomplete).toBe(false);
    const fetch = vi.fn(); vi.stubGlobal("fetch", fetch);
    expect((await finish(id)).statusCode).toBe(409);
    expect((await db.pool.query("select * from ofapi_collection_jobs where id=$1", [id])).rows[0]).toEqual(before);
    expect(fetch).not.toHaveBeenCalled();
  });
  it("can close a failed read while global pause remains authoritative", async () => {
    const { id } = await scheduled();
    await db.pool.query("update ofapi_collection_jobs set state='paused' where id=$1", [id]);
    await applyOfapiCollectionPolicy(app.db, { expectedRevision: 1, changes: [], backgroundPaused: true }, actor);
    expect((await finish(id, { expectedRevision: 2 })).statusCode).toBe(200);
    expect((await getOfapiCollectionSnapshot(app.db, null)).backgroundPaused).toBe(true);
    expect(await enqueueDueOfapiCollectionSchedules(app.db, ["profile_notifications"], new Date(Date.now() + 86400000))).toEqual([]);
    const oneOff = await createOfapiCollectionJob(app.db, { expectedRevision: 3, pageId, category: "vault_files", maxCalls: 1, maxCredits: 1, maxBytes: 100, from: null, to: null, selection: ["owned-source"] }, actor);
    await db.pool.query("update ofapi_collection_jobs set state='paused',purpose='background' where id=$1", [oneOff.id]);
    expect((await finish(oneOff.id, { expectedRevision: 3 })).statusCode).toBe(409);
  });
  it("does not close a paused outer row while its physical GET is still in flight", async () => {
    const { id } = await scheduled();
    let resolveVendor!: (response: Response) => void;
    const vendor = new Promise<Response>(resolve => { resolveVendor = resolve; });
    const fetch = vi.fn(() => vendor);
    vi.stubGlobal("fetch", fetch);
    const running = runOfapiCollectionJob(app, id, handlers);
    try {
      await vi.waitFor(() => expect(fetch).toHaveBeenCalledTimes(1));
      // An owner pause can race a dispatched response; even an expired outer
      // lease must not turn its still-open inner attempt into finishable work.
      await db.pool.query("update ofapi_collection_jobs set state='paused',lease_until=now()-interval '1 second' where id=$1", [id]);
      expect((await getOfapiCollectionSnapshot(app.db, null)).jobs.find(job => job.id === id)?.canFinishIncomplete).toBe(false);
      expect((await finish(id)).statusCode).toBe(409);
      expect((await db.pool.query("select state from ofapi_request_attempts")).rows).toEqual([{ state: "dispatching" }]);
    } finally {
      resolveVendor(new Response(JSON.stringify({ data: { list: [], hasMore: false } })));
      await running;
    }
    expect(fetch).toHaveBeenCalledTimes(1);
  });
});
