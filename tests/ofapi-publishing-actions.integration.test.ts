import { createHash, randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createModel, createOnlyFansPage, createOrGetOfapiCaptureJob, insertObservation, setPageOfapiAccountId } from "@agency_hub_core/db";
import type { AppContext } from "../apps/runtime/src/bootstrap.ts";
import { buildApiServer } from "../apps/runtime/src/api/server.ts";
import { createUserAccount } from "../apps/runtime/src/services/auth.ts";
import { createOfapiClient } from "../apps/runtime/src/services/ofapi.ts";
import { ofapiCollectionPolicyHooks } from "../apps/runtime/src/services/ofapi-collection-policy.ts";
import { createTestAppContext } from "./helpers/runtime.ts";
import { resetIntegrationDatabase, startIntegrationTestDatabase, type StartedTestDatabase } from "./helpers/db.ts";

// Fixture passwords hash at minimum cost; sign-in still runs the real argon2
// verify (tests/helpers/cheap-argon2.ts).
vi.mock("argon2", () => import("./helpers/cheap-argon2.ts"));

let database: StartedTestDatabase;
let app: AppContext;
let server: Awaited<ReturnType<typeof buildApiServer>>;
let pageId: number;
let cookie: string;
let fetchMock: ReturnType<typeof vi.fn<typeof fetch>>;
const ACCOUNT = "acct_expandedactions";
const ROOT = "/api/v1/admin/ofapi/actions";

beforeAll(async () => {
  const started = await startIntegrationTestDatabase();
  if (!started) throw new Error("Expanded OFAPI action regressions require PostgreSQL");
  database = started;
}, 120000);
afterAll(async () => { await database?.stop(); });
afterEach(async () => {
  vi.useRealTimers();
  await server?.close();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});
beforeEach(async () => {
  await resetIntegrationDatabase(database.pool);
  app = createTestAppContext(database);
  app.config.ofapiApiKey = "synthetic-expanded-actions-key";
  const model = (await createModel(app.db, { slug: "expanded-actions", name: "Expanded actions" }))!;
  pageId = (await createOnlyFansPage(app.db, { modelId: model.id, label: "Expanded action account" }))!.id;
  await setPageOfapiAccountId(app.db, { pageId, ofapiAccountId: ACCOUNT });
  await database.pool.query("insert into ofapi_credit_state(id,last_balance,last_balance_at) values(1,10000,now()) on conflict(id) do update set last_balance=10000,last_balance_at=now()");
  app.ofapi = createOfapiClient({ apiKey: app.config.ofapiApiKey, restDelayMs: 0, ...ofapiCollectionPolicyHooks(app.db) });
  vi.spyOn(app.ofapi, "getCredentialPreflight").mockResolvedValue({ status: "verified", expectedTeam: "synthetic", observedTeam: "synthetic", credentialFingerprint: "synthetic", checkedAt: new Date().toISOString(), reason: null, rosterScope: "unknown" });
  fetchMock = vi.fn<typeof fetch>();
  vi.stubGlobal("fetch", fetchMock);
  await createUserAccount(app, { username: "expanded-owner", password: "synthetic-owner-password", role: "owner" }, { source: "cli" });
  server = await buildApiServer(app);
  const login = await server.inject({ method: "POST", url: "/api/v1/auth/login", payload: { username: "expanded-owner", password: "synthetic-owner-password" } });
  expect(login.statusCode).toBe(200);
  const header = login.headers["set-cookie"];
  cookie = (Array.isArray(header) ? header[0]! : String(header)).split(";")[0]!;
});

// These are real HTTP-boundary payloads. The integrated route validates the
// complete action union; no cast into a narrower domain can hide missing fields.
const prepare = (id: string, command: Record<string, unknown>) => server.inject({ method: "POST", url: ROOT, headers: { cookie }, payload: { id, command } });
const dispatch = (id: string) => server.inject({ method: "POST", url: `${ROOT}/${id}/dispatch`, headers: { cookie }, payload: {} });
const retained = (id: string) => server.inject({ method: "GET", url: `${ROOT}/${id}`, headers: { cookie } });
const response = (data: unknown, status = 200) => new Response(JSON.stringify({ data, _meta: { _credits: { used: 1, balance: 9999 } } }), { status, headers: { "content-type": "application/json" } });
function sent() {
  const [url, init] = fetchMock.mock.calls.at(-1)!;
  return { url: new URL(String(url)), method: init?.method, rawBody: init?.body, body: typeof init?.body === "string" ? JSON.parse(init.body) : init?.body instanceof Uint8Array ? JSON.parse(new TextDecoder().decode(init.body)) : undefined };
}
async function expectPrepared(id: string, command: Record<string, unknown>) {
  const before = fetchMock.mock.calls.length;
  const result = await prepare(id, command);
  expect(result.statusCode, result.body).toBe(200);
  expect(result.json()).toMatchObject({ id, state: "prepared" });
  expect(fetchMock).toHaveBeenCalledTimes(before);
}
async function expectConfirmed(id: string) {
  const result = await dispatch(id);
  expect(result.statusCode, result.body).toBe(200);
  expect(result.json()).toMatchObject({ id, state: "confirmed", accountingState: "complete" });
  const saved = await retained(id);
  expect(saved.statusCode, saved.body).toBe(200);
  expect(saved.json()).toEqual(result.json());
  return result.json();
}

describe("expanded publishing actions through the owner API", () => {
  it("confirms the documented empty HTTP 200 post edit without inventing a new resource ID", async () => {
    const id = randomUUID();
    await expectPrepared(id, { action: "post_update", pageId, postId: "501", text: "Обновлённая подпись" });
    fetchMock.mockResolvedValueOnce(new Response("", { status: 200 }));
    expect(await expectConfirmed(id)).toMatchObject({ remoteId: null });
    expect(sent()).toMatchObject({ method: "PUT", body: { text: "Обновлённая подпись" } });
    expect(sent().url.pathname.endsWith(`/${ACCOUNT}/posts/501`)).toBe(true);
    expect((await dispatch(id)).json()).toMatchObject({ state: "confirmed" });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("passes scheduling to the provider and retains the accepted post identity", async () => {
    const id = randomUUID();
    const scheduledDate = new Date(Date.now() + 3600000).toISOString();
    const command = { action: "post_create", pageId, text: "Scheduled text", scheduledDate };
    await expectPrepared(id, command);
    fetchMock.mockResolvedValueOnce(response({ id: 502, responseType: "post", isScheduled: true }));
    expect(await expectConfirmed(id)).toMatchObject({ remoteId: "502", responseData: { id: 502, responseType: "post", isScheduled: true } });
    expect(sent()).toMatchObject({ method: "POST", body: { text: "Scheduled text", scheduledDate } });
    expect(sent().body).not.toHaveProperty("reuseProviderOperation");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("confirms campaign queue acceptance while preserving unfinished provider state", async () => {
    const id = randomUUID();
    await expectPrepared(id, { action: "campaign_create", pageId, text: "Всем привет", userIds: ["101", "202"], userLists: ["fans"] });
    const queue = { id: 601, isDone: false, isReady: false, hasError: false, isCanceled: false };
    fetchMock.mockResolvedValueOnce(response(queue));
    expect(await expectConfirmed(id)).toMatchObject({ remoteId: "601", responseData: queue });
    expect(sent()).toMatchObject({ method: "POST", body: { text: "Всем привет", userIds: [101, 202], userLists: ["fans"] } });
    expect(sent().url.pathname.endsWith(`/${ACCOUNT}/mass-messaging`)).toBe(true);
  });

  it("accepts a queue publish success receipt without requiring an undocumented returned ID", async () => {
    const id = randomUUID();
    await expectPrepared(id, { action: "queue_publish", pageId, queueId: "601" });
    fetchMock.mockResolvedValueOnce(response({ success: true }));
    expect(await expectConfirmed(id)).toMatchObject({ remoteId: null, responseData: { success: true } });
    expect(sent()).toMatchObject({ method: "PUT", rawBody: undefined });
    expect(sent().url.pathname.endsWith(`/${ACCOUNT}/queue/601/publish`)).toBe(true);
  });

  it("preserves Unicode and reserved characters in the documented comment query parameters", async () => {
    const id = randomUUID();
    const text = "Привет 👋 + & / ? # % — reply";
    await expectPrepared(id, { action: "post_comment_create", pageId, postId: "501", text, answerTo: "81", giphyId: "gif_test" });
    fetchMock.mockResolvedValueOnce(response({ id: 701, text }, 201));
    expect(await expectConfirmed(id)).toMatchObject({ remoteId: "701", responseData: { id: 701, text } });
    const request = sent();
    expect(request.method).toBe("POST");
    expect(request.rawBody).toBeUndefined();
    expect(request.url.pathname.endsWith(`/${ACCOUNT}/posts/501/comments`)).toBe(true);
    expect(Object.fromEntries(request.url.searchParams)).toEqual({ text, answerTo: "81", giphyId: "gif_test" });
  });

  it("refuses a newly admitted publication in the past before creating custody or calling the provider", async () => {
    const id = randomUUID();
    const result = await prepare(id, { action: "post_create", pageId, text: "Too late", scheduledDate: new Date(Date.now() - 60000).toISOString() });
    expect(result.statusCode).toBe(400);
    expect((await database.pool.query("select count(*)::int n from ofapi_action_intents where id=$1", [id])).rows[0].n).toBe(0);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("returns an existing accepted intent after its scheduled date has passed without reapplying admission or resending", async () => {
    const now = Date.now();
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(now);
    const id = randomUUID();
    const command = { action: "post_create", pageId, text: "Already accepted", scheduledDate: new Date(now + 60000).toISOString() };
    await expectPrepared(id, command);
    fetchMock.mockResolvedValueOnce(response({ id: 502, responseType: "post" }));
    const original = await expectConfirmed(id);
    vi.setSystemTime(now + 120000);
    const replay = await prepare(id, command);
    expect(replay.statusCode, replay.body).toBe(200);
    expect(replay.json()).toEqual(original);
    expect((await dispatch(id)).json()).toEqual(original);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("keeps unexpected successful campaign bodies indeterminate and never submits that intent twice", async () => {
    const id = randomUUID();
    await expectPrepared(id, { action: "campaign_create", pageId, text: "Queue body check", userIds: ["101"] });
    fetchMock.mockResolvedValueOnce(response({ success: true }));
    const result = await dispatch(id);
    expect(result.statusCode, result.body).toBe(200);
    expect(result.json()).toMatchObject({ state: "indeterminate", errorCode: "vendor_result_unconfirmed" });
    expect((await dispatch(id)).json()).toMatchObject({ state: "indeterminate" });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});


describe("publishing media admission through the owner API", () => {
  it("rechecks vault readiness at execution and reuses ready vault material across separate posts", async () => {
    await database.pool.query("insert into ofapi_media_catalog(account_id,page_id,media_ref,material_kind,is_ready,metadata,observation_id,observation_received_at) values($1,$2,'101','vault',true,'{}',1,now())", [ACCOUNT,pageId]);
    const id = randomUUID();
    const command = { action: "post_create", pageId, text: "Owned vault", mediaFiles: ["101"] };
    await expectPrepared(id, command);
    await database.pool.query("update ofapi_media_catalog set is_ready=false where page_id=$1", [pageId]);
    expect((await dispatch(id)).statusCode).toBe(409);
    expect(fetchMock).not.toHaveBeenCalled();
    await database.pool.query("update ofapi_media_catalog set is_ready=true where page_id=$1", [pageId]);
    fetchMock.mockImplementation(async () => response({ id: 801, responseType: "post" }));
    await expectConfirmed(id);
    expect(sent().body).toMatchObject({mediaFiles:[101]});
    const next = randomUUID();
    await expectPrepared(next, command);
    await expectConfirmed(next);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect((await database.pool.query("select count(*)::int n from ofapi_media_token_custody")).rows[0].n).toBe(0);
  });

  it("atomically consumes a completed upload across separate posts and keeps the blocked draft unspent", async () => {
    const token = "ofapi_media_publish_once";
    const jobId = randomUUID();
    const actor = Number((await database.pool.query("select id from users where username='expanded-owner'")).rows[0].id);
    await createOrGetOfapiCaptureJob(app.db, {id:jobId,pageId,ofapiAccountId:ACCOUNT,kind:"media_upload",activeSlotKey:`page:${pageId}:test:${jobId}`,target:{requestId:randomUUID(),sourceId:randomUUID(),destination:"cdn",maxCredits:3},budgetScope:"interactive",originPrincipalId:actor,createdBy:"owner",maxCalls:3,maxCredits:3});
    const receivedAt = new Date();
    const cursor = {mediaRef:token,status:"completed",isReady:true,hasError:false};
    const evidence = await insertObservation(app.db,{source:"ofapi_capture",producer:"ofapi:media-test",platform:"onlyfans",kind:"ofapi.media_upload_response.v1",accountId:pageId,nativeAccountRef:ACCOUNT,idempotencyKey:randomUUID(),payload:cursor,payloadHash:createHash("sha256").update(JSON.stringify(cursor)).digest(),receivedAt});
    await database.pool.query("update ofapi_capture_jobs set state='complete',cursor=$2::jsonb,terminal_observation_id=$3,terminal_observation_received_at=$4,completed_at=now() where id=$1", [jobId,JSON.stringify(cursor),evidence.observationId,receivedAt]);
    const command = { action: "post_create", pageId, text: "Owned upload", mediaFiles: [token] };
    const first = randomUUID(), second = randomUUID();
    await expectPrepared(first,command);
    await expectPrepared(second,command);
    fetchMock.mockResolvedValue(response({id:802,responseType:"post"}));
    await expectConfirmed(first);
    expect(sent().body).toMatchObject({mediaFiles:[token]});
    expect((await dispatch(second)).statusCode).toBe(409);
    expect((await retained(second)).json()).toMatchObject({state:"prepared",actualCredits:null});
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect((await database.pool.query("select spent_credits from ofapi_credit_state where id=1")).rows[0].spent_credits).toBe(1);
  });
});
