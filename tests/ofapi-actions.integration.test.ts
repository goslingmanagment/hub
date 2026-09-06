import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { applyVerifiedOfapiBinding, createModel, createOnlyFansPage, createUser, setPageOfapiAccountId } from "@agency_hub_core/db";
import { decryptJsonWithKeyVersion } from "@agency_hub_core/shared";
import type { OfapiAction } from "@agency_hub_core/contracts";
import type { AppContext } from "../apps/runtime/src/bootstrap.ts";
import { createOfapiClient } from "../apps/runtime/src/services/ofapi.ts";
import { ofapiCollectionPolicyHooks } from "../apps/runtime/src/services/ofapi-collection-policy.ts";
import { createUserAccount } from "../apps/runtime/src/services/auth.ts";
import { buildApiServer } from "../apps/runtime/src/api/server.ts";
import { ConflictError } from "../apps/runtime/src/services/errors.ts";
import { executeErasure } from "../apps/runtime/src/services/erasure/index.ts";
import { cancelOfapiAction, dispatchOfapiAction, getOfapiAction, listOfapiActions, OFAPI_ACTION_RESPONSE_KIND, prepareOfapiAction, repairOfapiAction } from "../apps/runtime/src/services/ofapi-actions.ts";
import { createTestAppContext } from "./helpers/runtime.ts";
import { resetIntegrationDatabase, startIntegrationTestDatabase, type StartedTestDatabase } from "./helpers/db.ts";

let database: StartedTestDatabase;
let app: AppContext;
let actor: number;
let pageId: number;
let fetchMock: ReturnType<typeof vi.fn>;
let server: Awaited<ReturnType<typeof buildApiServer>> | null = null;
const ACCOUNT = "acct_actionintegration";
const response = (data: unknown, credits = 1, status = 200) => new Response(JSON.stringify({ data, _meta: { _credits: { used: credits, balance: 10000 - credits } } }), { status });

beforeAll(async () => {
  const started = await startIntegrationTestDatabase();
  if (!started) throw new Error("OFAPI action regressions require PostgreSQL");
  database = started;
}, 120000);
afterAll(async () => { await database?.stop(); });
afterEach(async () => {
  await server?.close();
  server = null;
  await removeReceiptFault();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});
beforeEach(async () => {
  await resetIntegrationDatabase(database.pool);
  app = createTestAppContext(database);
  app.config.ofapiApiKey = "synthetic-actions-key";
  actor = (await createUser(app.db, { username: "action-owner", passwordHash: "synthetic", role: "owner" }))!.id;
  const model = (await createModel(app.db, { slug: "action-model", name: "Action Model" }))!;
  pageId = (await createOnlyFansPage(app.db, { modelId: model.id, label: "Action account" }))!.id;
  await setPageOfapiAccountId(app.db, { pageId, ofapiAccountId: ACCOUNT });
  await database.pool.query("insert into ofapi_credit_state(id,last_balance,last_balance_at) values(1,10000,now()) on conflict(id) do update set last_balance=10000,last_balance_at=now()");
  app.ofapi = createOfapiClient({ apiKey: "synthetic-actions-key", restDelayMs: 0, ...ofapiCollectionPolicyHooks(app.db) });
  vi.spyOn(app.ofapi, "getCredentialPreflight").mockResolvedValue({ status: "verified", expectedTeam: "synthetic", observedTeam: "synthetic", credentialFingerprint: "synthetic", checkedAt: new Date().toISOString(), reason: null, rosterScope: "unknown" });
  fetchMock = vi.fn();
  vi.stubGlobal("fetch", fetchMock);
});

const createList = (name = "Renewals"): OfapiAction => ({ action: "user_list_create", pageId, name });
const batch = (ids = ["101", "202"]): OfapiAction => ({ action: "user_list_add_users", pageId, listId: "555", ids, skip_invalid: true });
async function prepare(command: OfapiAction, id = randomUUID()) { await prepareOfapiAction(app, { id, command }, actor); return id; }
async function apply(id: string) { return dispatchOfapiAction(app, id, actor); }
async function spent() { return Number((await database.pool.query("select spent_credits from ofapi_credit_state where id=1")).rows[0].spent_credits); }
async function ledger(id: string) { return (await database.pool.query("select credits,estimated,request_id from ofapi_credit_ledger where request_id=$1", [id])).rows; }
async function captures(id: string) { return (await database.pool.query("select id,payload from observations where kind=$1 and payload->>'intentId'=$2", [OFAPI_ACTION_RESPONSE_KIND, id])).rows; }
function expectOnlyBusyContenders(results: PromiseSettledResult<unknown>[]) {
  expect(results.some(result => result.status === "fulfilled")).toBe(true);
  for (const result of results) if (result.status === "rejected") {
    expect(result.reason).toBeInstanceOf(ConflictError);
    expect(result.reason).toMatchObject({ statusCode: 409 });
  }
}
async function installReceiptFault() {
  await database.pool.query("create function action_receipt_settlement_fault() returns trigger language plpgsql as $$ begin if new.result_encrypted is not null then raise exception 'synthetic local receipt outage'; end if; return new; end $$");
  await database.pool.query("create trigger action_receipt_settlement_fault before update on ofapi_action_intents for each row execute function action_receipt_settlement_fault()");
}
async function removeReceiptFault() {
  if (!database) return;
  await database.pool.query("drop trigger if exists action_receipt_settlement_fault on ofapi_action_intents");
  await database.pool.query("drop function if exists action_receipt_settlement_fault()");
}
async function login(username: string, role: "owner" | "team_lead") {
  await createUserAccount(app, { username, role, password: "synthetic-owner-password" }, { source: "cli" });
  server ??= await buildApiServer(app);
  const result = await server.inject({ method: "POST", url: "/api/v1/auth/login", payload: { username, password: "synthetic-owner-password" } });
  expect(result.statusCode).toBe(200);
  const header = result.headers["set-cookie"];
  return (Array.isArray(header) ? header[0]! : String(header)).split(";")[0]!;
}

describe("governed OFAPI owner action custody", () => {
  it("keeps prepare, dispatch and retained evidence owner-only through the real API", async () => {
    const ownerCookie = await login("api-action-owner", "owner");
    const teamCookie = await login("api-action-team", "team_lead");
    const id = randomUUID();
    const payload = { id, command: createList() };
    const base = "/api/v1/admin/ofapi/actions";
    for (const entry of [
      { method: "POST" as const, url: base, payload },
      { method: "GET" as const, url: `${base}?pageId=${pageId}` },
      { method: "GET" as const, url: `${base}/${id}` },
      { method: "POST" as const, url: `${base}/${id}/dispatch`, payload: {} },
      { method: "POST" as const, url: `${base}/${id}/cancel`, payload: {} },
      { method: "POST" as const, url: `${base}/${id}/repair`, payload: {} },
    ]) {
      expect((await server!.inject(entry)).statusCode).toBe(401);
      expect((await server!.inject({ ...entry, headers: { cookie: teamCookie } })).statusCode).toBe(403);
    }
    const prepared = await server!.inject({ method: "POST", url: base, headers: { cookie: ownerCookie }, payload });
    expect(prepared.statusCode).toBe(200);
    expect(prepared.json()).toMatchObject({ id, state: "prepared" });
    expect(fetchMock).not.toHaveBeenCalled();
    fetchMock.mockResolvedValueOnce(response({ id: 555 }));
    const dispatched = await server!.inject({ method: "POST", url: `${base}/${id}/dispatch`, headers: { cookie: ownerCookie }, payload: {} });
    expect(dispatched.statusCode).toBe(200);
    expect(dispatched.json()).toMatchObject({ state: "confirmed", remoteId: "555" });
    const retained = await server!.inject({ method: "GET", url: `${base}/${id}`, headers: { cookie: ownerCookie } });
    expect(retained.statusCode).toBe(200);
    expect(retained.json()).toMatchObject({ responseData: { id: 555 } });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("prepares locally, preserves immutable page labels and dispatches one physical request under concurrent and repeated calls", async () => {
    const id = randomUUID();
    const prepared = await prepareOfapiAction(app, { id, command: createList() }, actor);
    expect(prepared).toMatchObject({ state: "prepared", pageId, accountId: ACCOUNT, pageLabel: "Action account", estimatedCredits: 1 });
    expect(fetchMock).not.toHaveBeenCalled();
    await database.pool.query("update pages set label='Renamed later' where id=$1", [pageId]);
    expect(await getOfapiAction(app, id)).toMatchObject({ pageLabel: "Action account" });
    let releaseResponse!: () => void;
    let dispatchStarted!: () => void;
    const started = new Promise<void>(resolve => { dispatchStarted = resolve; });
    const responseReady = new Promise<void>(resolve => { releaseResponse = resolve; });
    fetchMock.mockImplementationOnce(async () => { dispatchStarted(); await responseReady; return response({ id: 555, name: "Renewals" }); });
    const first = apply(id);
    const second = apply(id);
    const outcomes = Promise.allSettled([first, second]);
    await started;
    releaseResponse();
    expectOnlyBusyContenders(await outcomes);
    expect(await apply(id)).toMatchObject({ state: "confirmed", remoteId: "555", accountingState: "complete" });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(String(fetchMock.mock.calls[0]![0]).endsWith(`/${ACCOUNT}/user-lists`)).toBe(true);
    expect((await captures(id))).toHaveLength(1);
    expect(await spent()).toBe(1);
    expect((await listOfapiActions(app, pageId)).intents).toHaveLength(1);
  });

  it("binds an action ID to its exact payload and principal, including concurrent mismatches", async () => {
    const id = randomUUID();
    const competitors = await Promise.allSettled([
      prepareOfapiAction(app, { id, command: createList("A") }, actor),
      prepareOfapiAction(app, { id, command: createList("B") }, actor),
    ]);
    expect(competitors.map(item => item.status).sort()).toEqual(["fulfilled", "rejected"]);
    const stored = await getOfapiAction(app, id);
    await expect(prepareOfapiAction(app, { id, command: createList("Different") }, actor)).rejects.toThrow("another request");
    const anotherOwner = (await createUser(app.db, { username: "another-owner", passwordHash: "synthetic", role: "owner" }))!.id;
    await expect(prepareOfapiAction(app, { id, command: stored.command }, anotherOwner)).rejects.toThrow("another request");
    expect(await prepareOfapiAction(app, { id, command: stored.command }, actor)).toEqual(stored);
    expect((await database.pool.query("select count(*)::int n from ofapi_action_intents where id=$1", [id])).rows[0].n).toBe(1);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("refuses replacement bindings, binding generations and changed credentials before any HTTP", async () => {
    const original = await prepare(createList());
    await database.pool.query("update pages set ofapi_binding_generation=ofapi_binding_generation+1 where id=$1", [pageId]);
    await expect(apply(original)).rejects.toThrow();
    const current = await prepare(createList());
    await database.pool.query("update pages set ofapi_account_id='acct_replacement',ofapi_binding_generation=ofapi_binding_generation+1 where id=$1", [pageId]);
    await expect(apply(current)).rejects.toThrow();
    const newBinding = await prepare(createList());
    app.config.ofapiApiKey = "synthetic-rotated-key";
    await expect(apply(newBinding)).rejects.toThrow();
    expect(fetchMock).not.toHaveBeenCalled();
    expect(await spent()).toBe(0);
  });

  it("makes verified binding replacement wait until the in-flight response is captured and settled", async () => {
    const id = await prepare(createList());
    const oldGeneration = Number((await database.pool.query("select ofapi_binding_generation from pages where id=$1", [pageId])).rows[0].ofapi_binding_generation);
    let releaseResponse!: () => void;
    let dispatchStarted!: () => void;
    const started = new Promise<void>(resolve => { dispatchStarted = resolve; });
    const responseReady = new Promise<void>(resolve => { releaseResponse = resolve; });
    fetchMock.mockImplementationOnce(async () => { dispatchStarted(); await responseReady; return response({ id: 555, name: "Renewals" }); });
    const dispatch = apply(id);
    await started;
    let replacementEntered = false;
    const replacement = applyVerifiedOfapiBinding(app.db, {
      pageId, expectedAccountId: ACCOUNT, expectedGeneration: oldGeneration,
      accountId: "acct_replacement", creatorId: "123", historicalAccountIds: [ACCOUNT],
      evidence: { source: "synthetic-binding-race" }, recovery: [], authVerifiedAt: new Date(),
    }, { afterLock: async () => {
      replacementEntered = true;
      expect(await captures(id)).toHaveLength(1);
      const capturedIntent = (await database.pool.query("select state,response_observation_id from ofapi_action_intents where id=$1", [id])).rows[0];
      expect(capturedIntent.state).toBe("confirmed");
      expect(capturedIntent.response_observation_id).not.toBeNull();
    } });
    // Observe the actual PostgreSQL wait instead of relying on a wall-clock sleep.
    try {
      await expect.poll(async () => (await database.pool.query("select exists(select 1 from pg_locks where locktype='advisory' and classid=9003010 and objid=$1::oid and database=(select oid from pg_database where datname=current_database()) and not granted) as waiting", [pageId])).rows[0].waiting, { timeout: 5000 }).toBe(true);
      expect(replacementEntered).toBe(false);
      expect(await captures(id)).toHaveLength(0);
      expect((await database.pool.query("select ofapi_account_id from pages where id=$1", [pageId])).rows[0].ofapi_account_id).toBe(ACCOUNT);
    } finally {
      releaseResponse();
      await Promise.allSettled([dispatch, replacement]);
    }
    expect(await dispatch).toMatchObject({ state: "confirmed", accountId: ACCOUNT, remoteId: "555" });
    expect(await replacement).toBe(true);
    expect(replacementEntered).toBe(true);
    expect((await database.pool.query("select ofapi_account_id,ofapi_binding_generation from pages where id=$1", [pageId])).rows[0]).toMatchObject({ ofapi_account_id: "acct_replacement", ofapi_binding_generation: oldGeneration + 1 });
    expect(await getOfapiAction(app, id)).toMatchObject({ state: "confirmed", accountId: ACCOUNT });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("cancels prepared actions without egress and does not reinterpret cancel as an undo after dispatch", async () => {
    const cancelled = await prepare(createList());
    expect(await cancelOfapiAction(app, cancelled, actor)).toMatchObject({ state: "cancelled" });
    expect(await apply(cancelled)).toMatchObject({ state: "cancelled" });
    expect(fetchMock).not.toHaveBeenCalled();
    const dispatched = await prepare(createList());
    fetchMock.mockResolvedValueOnce(response({ id: 555 }));
    await apply(dispatched);
    await expect(cancelOfapiAction(app, dispatched, actor)).rejects.toThrow();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it.each(["timeout", "server error", "malformed JSON", "missing identity"] as const)("retains %s as indeterminate and never retries the mutation", async failure => {
    const id = await prepare(createList());
    if (failure === "timeout") fetchMock.mockRejectedValueOnce(new DOMException("synthetic timeout", "TimeoutError"));
    if (failure === "server error") fetchMock.mockResolvedValueOnce(response({ error: "synthetic upstream error" }, 1, 503));
    if (failure === "malformed JSON") fetchMock.mockResolvedValueOnce(new Response("{truncated-json"));
    if (failure === "missing identity") fetchMock.mockResolvedValueOnce(response({ name: "No native ID" }));
    expect(await apply(id)).toMatchObject({ state: "indeterminate" });
    expect(await getOfapiAction(app, id)).toMatchObject({ state: "indeterminate" });
    expect(await apply(id)).toMatchObject({ state: "indeterminate" });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(await captures(id)).toHaveLength(failure === "timeout" ? 0 : 1);
  });

  it("rejects definite provider failures and retains undocumented empty deletion acknowledgements as indeterminate", async () => {
    const denied = await prepare({ action: "user_list_delete", pageId, listId: "555" });
    fetchMock.mockResolvedValueOnce(response({ error: "permission_denied" }, 1, 403));
    expect(await apply(denied)).toMatchObject({ state: "rejected" });
    const malformed = await prepare({ action: "user_list_delete", pageId, listId: "555" });
    fetchMock.mockResolvedValueOnce(response({}));
    expect(await apply(malformed)).toMatchObject({ state: "indeterminate" });
    const removed = await prepare({ action: "user_list_delete", pageId, listId: "555" });
    fetchMock.mockResolvedValueOnce(new Response(null, { status: 204 }));
    expect(await apply(removed)).toMatchObject({ state: "indeterminate", errorCode: "vendor_result_unconfirmed" });
    await apply(removed);
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it("does not confirm an ordinary list addition from 204 without the exact returned recipient IDs", async () => {
    const id = await prepare({ action: "user_list_add_users", pageId, listId: "555", ids: ["101", "202"] });
    fetchMock.mockResolvedValueOnce(new Response(null, { status: 204 }));
    expect(await apply(id)).toMatchObject({ state: "indeterminate", errorCode: "vendor_result_unconfirmed", responseData: null });
    expect(await repairOfapiAction(app, id)).toMatchObject({ state: "indeterminate" });
    expect(await apply(id)).toMatchObject({ state: "indeterminate" });
    expect(await captures(id)).toHaveLength(1);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it.each(["fan", "page"] as const)("keeps an action ID spent after %s erasure removes its encrypted command and receipt", async scopeType => {
    const lakeDir = await mkdtemp(join(tmpdir(), "ofapi-action-identity-erasure-"));
    app.config.lakeDir = lakeDir;
    try {
      const id = randomUUID();
      const command: OfapiAction = { action: "fan_notes_update", pageId, fanId: "101", notes: "Erase this private note" };
      await prepare(command, id);
      fetchMock.mockResolvedValueOnce(response({ id: 101, notes: command.notes }));
      expect(await apply(id)).toMatchObject({ state: "confirmed" });
      expect(await captures(id)).toHaveLength(1);

      await executeErasure(app, scopeType === "fan"
        ? { scopeType, platform: "onlyfans", fanRef: "101" }
        : { scopeType, pageLabel: "Action account" }, { initiatedBy: actor });
      expect((await database.pool.query("select id from ofapi_action_intents where id=$1", [id])).rows).toEqual([]);
      expect(await captures(id)).toHaveLength(0);
      // The permanent anti-replay fence contains no page, principal or payload.
      expect((await database.pool.query("select * from ofapi_action_identities where id=$1", [id])).rows).toEqual([{ id }]);
      await expect(prepare(command, id)).rejects.toBeInstanceOf(ConflictError);
      await expect(apply(id)).rejects.toThrow("was not found");
      expect(fetchMock).toHaveBeenCalledTimes(1);

      // Erasure cleans old material; it does not ban future owner actions.
      const fresh = await prepare(command);
      expect(await getOfapiAction(app, fresh)).toMatchObject({ state: "prepared" });
      expect(fetchMock).toHaveBeenCalledTimes(1);
    } finally {
      await rm(lakeDir, { recursive: true, force: true });
    }
  });

  it("retains a complete partial result, including the exact failed fan IDs and reasons", async () => {
    const id = await prepare(batch());
    const result = { added: [101], failed: { "202": "User not found" } };
    fetchMock.mockResolvedValueOnce(response(result, 2));
    expect(await apply(id)).toMatchObject({ state: "partial", responseData: result, actualCredits: 2, estimatedCredits: 5 });
    expect(await apply(id)).toMatchObject({ state: "partial", responseData: result });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(await spent()).toBe(2);
  });

  it.each([
    { label: "missing outcome", ids: ["101", "202"], result: { added: [101], failed: {} } },
    { label: "foreign outcome", ids: ["101", "202"], result: { added: [101], failed: { "303": "Invalid" } } },
    { label: "duplicate success", ids: ["101", "202"], result: { added: [101, 101], failed: {} } },
    { label: "success/failure overlap", ids: ["101", "202"], result: { added: [101], failed: { "101": "Invalid" } } },
    { label: "unsafe numeric ID", ids: ["9007199254740992", "202"], result: { added: [9007199254740992], failed: { "202": "Invalid" } } },
  ])("does not confirm partial responses with $label", async ({ ids, result }) => {
    const id = await prepare(batch(ids));
    fetchMock.mockResolvedValueOnce(response(result, 2));
    expect(await apply(id)).toMatchObject({ state: "indeterminate", errorCode: "vendor_partial_result_unconfirmed" });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("keeps exact native notes encrypted in intents, response custody and audit storage", async () => {
    const notes = "PRIVATE-NATIVE-NOTE: preserved only for the owner";
    const id = await prepare({ action: "fan_notes_update", pageId, fanId: "101", notes });
    fetchMock.mockResolvedValueOnce(response({ id: 101, notes }));
    expect(await apply(id)).toMatchObject({ state: "confirmed", responseData: { id: 101, notes } });
    const stored = (await database.pool.query("select body_encrypted,result_encrypted from ofapi_action_intents where id=$1", [id])).rows[0];
    expect(JSON.stringify(stored)).not.toContain(notes);
    const clear = decryptJsonWithKeyVersion<{ command: unknown }>(JSON.parse(stored.body_encrypted), app.config.encryptionKeysByVersion);
    expect(clear.command).toMatchObject({ notes });
    const observations = await captures(id);
    expect(observations).toHaveLength(1);
    expect(JSON.stringify(observations.map(row => row.payload))).not.toContain(notes);
    const captured = decryptJsonWithKeyVersion<{ bodyBase64: string; frozen: { command: unknown } }>(observations[0].payload.encryptedBody, app.config.encryptionKeysByVersion);
    expect(JSON.parse(Buffer.from(captured.bodyBase64, "base64").toString())).toMatchObject({ data: { notes } });
    expect(captured.frozen.command).toMatchObject({ notes });
    expect(JSON.stringify((await database.pool.query("select metadata from audit_events where event_type like 'admin.ofapi_action_%'")).rows)).not.toContain(notes);
  });

  it.each([false, true])("reserves five credits, settles actual two once and keeps accounting stable across flag toggles (ledger=%s)", async ledgerEnabled => {
    app.config.ofapiCreditLedgerEnabled = ledgerEnabled;
    const id = await prepare(batch());
    let reservedAtFetch = -1;
    fetchMock.mockImplementationOnce(async () => { reservedAtFetch = await spent(); return response({ added: [101], failed: { "202": "Invalid" } }, 2); });
    expect(await apply(id)).toMatchObject({ state: "partial", actualCredits: 2, accountingState: "complete" });
    expect(reservedAtFetch).toBe(5);
    expect(await spent()).toBe(2);
    expect(await ledger(id)).toHaveLength(ledgerEnabled ? 1 : 0);
    app.config.ofapiCreditLedgerEnabled = !ledgerEnabled;
    expectOnlyBusyContenders(await Promise.allSettled([repairOfapiAction(app, id), repairOfapiAction(app, id)]));
    await getOfapiAction(app, id);
    await apply(id);
    expect(await spent()).toBe(2);
    const entries = await ledger(id);
    expect(entries).toHaveLength(ledgerEnabled ? 1 : 0);
    if (ledgerEnabled) expect(entries[0]).toMatchObject({ credits: 2, estimated: false, request_id: id });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it.each([false, true])("repairs a retained response without HTTP after local failure and a ledger mode change (initial ledger=%s)", async ledgerEnabled => {
    app.config.ofapiCreditLedgerEnabled = ledgerEnabled;
    const id = await prepare(batch());
    await installReceiptFault();
    fetchMock.mockResolvedValueOnce(response({ added: [101, 202], failed: {} }, 2));
    expect(await apply(id)).toMatchObject({ state: "indeterminate", accountingState: "pending" });
    expect(await captures(id)).toHaveLength(1);
    expect(await spent()).toBe(5);
    await removeReceiptFault();
    app.config.ofapiCreditLedgerEnabled = !ledgerEnabled;
    expect(await repairOfapiAction(app, id)).toMatchObject({ state: "confirmed", responseData: { added: [101, 202], failed: {} }, actualCredits: 2, accountingState: "complete" });
    await repairOfapiAction(app, id);
    expect(await spent()).toBe(2);
    expect(await ledger(id)).toHaveLength(ledgerEnabled ? 1 : 0);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("refuses a batch whose five-credit reservation exceeds the cap before any provider call", async () => {
    app.config.ofapiMirrorGlobalDailyCreditBudget = 4;
    const id = await prepare(batch());
    await expect(apply(id)).rejects.toThrow("not dispatched");
    expect(await getOfapiAction(app, id)).toMatchObject({ state: "prepared", estimatedCredits: 5 });
    expect(await spent()).toBe(0);
    expect(await captures(id)).toHaveLength(0);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
