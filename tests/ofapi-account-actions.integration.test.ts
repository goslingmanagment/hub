import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createModel, createOnlyFansPage, setPageOfapiAccountId } from "@agency_hub_core/db";
import type { AppContext } from "../apps/runtime/src/bootstrap.ts";
import { buildApiServer } from "../apps/runtime/src/api/server.ts";
import { createUserAccount } from "../apps/runtime/src/services/auth.ts";
import { createOfapiClient } from "../apps/runtime/src/services/ofapi.ts";
import { ofapiCollectionPolicyHooks } from "../apps/runtime/src/services/ofapi-collection-policy.ts";
import { createTestAppContext } from "./helpers/runtime.ts";
import { resetIntegrationDatabase, startIntegrationTestDatabase, type StartedTestDatabase } from "./helpers/db.ts";

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

describe("expanded account actions through the owner API", () => {
  it("records a false username availability result as a successful read", async () => {
    const id = randomUUID();
    await expectPrepared(id, { action: "username_availability_read", pageId, username: "taken_username" });
    fetchMock.mockResolvedValueOnce(response({ success: false }));
    expect(await expectConfirmed(id)).toMatchObject({ responseData: { success: false }, errorCode: null });
    expect(sent()).toMatchObject({ method: "POST", body: { username: "taken_username" } });
    expect(sent().url.pathname.endsWith(`/${ACCOUNT}/settings/username-exists`)).toBe(true);
  });

  it("reads the account's payout details through the governed one-shot route", async () => {
    const id = randomUUID();
    await expectPrepared(id, { action: "bank_payout_details_read", pageId });
    const details = { payoutSystem: "synthetic-bank", accountNumber: "masked-last-four-1234" };
    fetchMock.mockResolvedValueOnce(response(details));
    expect(await expectConfirmed(id)).toMatchObject({ responseData: details });
    expect(sent()).toMatchObject({ method: "GET", rawBody: undefined });
    expect(sent().url.pathname.endsWith(`/${ACCOUNT}/banking/details/bank`)).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("retains an accepted withdrawal request as new and converts integer cents to the provider's whole USD amount", async () => {
    const id = randomUUID();
    await expectPrepared(id, { action: "payout_withdrawal_request", pageId, amountCents: 12300 });
    const accepted = { list: [{ state: "new", rejectReason: null }] };
    fetchMock.mockResolvedValueOnce(response(accepted));
    expect(await expectConfirmed(id)).toMatchObject({ remoteId: null, responseData: accepted });
    expect(sent()).toMatchObject({ method: "POST", body: { amount: 123 } });
    expect(sent().url.pathname.endsWith(`/${ACCOUNT}/payouts/request-manual-withdrawal`)).toBe(true);
    expect((await dispatch(id)).json()).toMatchObject({ state: "confirmed", responseData: accepted });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("does not report a rejected or ambiguous payout list as an accepted withdrawal", async () => {
    const id = randomUUID();
    await expectPrepared(id, { action: "payout_withdrawal_request", pageId, amountCents: 5000 });
    fetchMock.mockResolvedValueOnce(response({ list: [{ state: "rejected", rejectReason: "Synthetic rejection" }] }));
    const result = await dispatch(id);
    expect(result.statusCode, result.body).toBe(200);
    expect(result.json()).toMatchObject({ state: "indeterminate", errorCode: "vendor_result_unconfirmed" });
    expect((await dispatch(id)).json()).toMatchObject({ state: "indeterminate" });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it.each([
    { action: "saved_message_autosend_update", period: 12, path: "/messages/settings/enable-or-update-automatic-messaging" },
    { action: "saved_post_autopost_update", period: 48, path: "/posts/settings/enable-or-update-automatic-posting" },
  ])("sends $action to the provider's native scheduler with only its period", async ({ action, period, path }) => {
    const id = randomUUID();
    await expectPrepared(id, { action, pageId, period });
    fetchMock.mockResolvedValueOnce(response({ period }));
    expect(await expectConfirmed(id)).toMatchObject({ responseData: { period } });
    expect(sent()).toMatchObject({ method: "PATCH", body: { period } });
    expect(sent().url.pathname.endsWith(`/${ACCOUNT}/saved-for-later${path}`)).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it.each([
    { action: "saved_message_autosend_disable", path: "/messages/settings/disable-automatic-messaging" },
    { action: "saved_post_autopost_disable", path: "/posts/settings/disable-automatic-posting" },
  ])("sends $action without an invented enable flag or period and accepts the empty list receipt", async ({ action, path }) => {
    const id = randomUUID();
    await expectPrepared(id, { action, pageId });
    fetchMock.mockResolvedValueOnce(response([]));
    expect(await expectConfirmed(id)).toMatchObject({ responseData: [] });
    expect(sent()).toMatchObject({ method: "PATCH", rawBody: undefined });
    expect(sent().url.pathname.endsWith(`/${ACCOUNT}/saved-for-later${path}`)).toBe(true);
  });

  it("rejects unsupported scheduler periods before admission", async () => {
    const id = randomUUID();
    const result = await prepare(id, { action: "saved_post_autopost_update", pageId, period: 8 });
    expect(result.statusCode).toBe(400);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("translates explicit profile clears to null while retaining omitted fields", async () => {
    const id = randomUUID();
    await expectPrepared(id, { action: "account_profile_update", pageId, name: "Новое имя", about: null, clearFields: ["website", "location"] });
    fetchMock.mockResolvedValueOnce(response({ success: true }));
    await expectConfirmed(id);
    expect(sent()).toMatchObject({ method: "POST", body: { name: "Новое имя", about: null, website: null, location: null } });
    expect(sent().body).not.toHaveProperty("username");
    expect(sent().body).not.toHaveProperty("wishlist");
    expect(sent().body).not.toHaveProperty("clearFields");
    expect(sent().url.pathname.endsWith(`/${ACCOUNT}/settings/profile`)).toBe(true);
  });

  it("preserves decimal subscription prices and the provider's explicit free value", async () => {
    for (const [priceCents, price] of [[499, "4.99"], [1299, "12.99"], [0, "free"]] as const) {
      const id = randomUUID();
      await expectPrepared(id, { action: "subscription_price_update", pageId, priceCents });
      fetchMock.mockResolvedValueOnce(response({ success: true }));
      await expectConfirmed(id);
      expect(sent()).toMatchObject({ method: "PATCH", body: { price } });
      expect(sent().url.pathname.endsWith(`/${ACCOUNT}/settings/subscription-price`)).toBe(true);
    }
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it("preserves an explicit geography clear as null and an empty state replacement", async () => {
    const id = randomUUID();
    await expectPrepared(id, { action: "blocked_countries_update", pageId, blockedCountries: null, blockedStates: [] });
    fetchMock.mockResolvedValueOnce(response({ success: true }));
    await expectConfirmed(id);
    expect(sent()).toMatchObject({ method: "PUT", body: { blockedCountries: null, blockedStates: [] } });
    expect(sent().url.pathname.endsWith(`/${ACCOUNT}/settings/blocked-countries`)).toBe(true);
  });
});
