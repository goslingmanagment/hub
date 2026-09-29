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
// With a case label the checks are soft and name the case, so a table-driven
// test reports every failing case instead of stopping at the first.
function checker(label?: string) {
  return label === undefined
    ? { check: expect, say: (detail?: string) => detail }
    : { check: expect.soft, say: (detail?: string) => (detail === undefined ? label : `${label}: ${detail}`) };
}
async function expectPrepared(id: string, command: Record<string, unknown>, label?: string) {
  const { check, say } = checker(label);
  const before = fetchMock.mock.calls.length;
  const result = await prepare(id, command);
  check(result.statusCode, say(result.body)).toBe(200);
  check(result.json(), say()).toMatchObject({ id, state: "prepared" });
  check(fetchMock, say()).toHaveBeenCalledTimes(before);
}
async function expectConfirmed(id: string, label?: string) {
  const { check, say } = checker(label);
  const result = await dispatch(id);
  check(result.statusCode, say(result.body)).toBe(200);
  check(result.json(), say()).toMatchObject({ id, state: "confirmed", accountingState: "complete" });
  const saved = await retained(id);
  check(saved.statusCode, say(saved.body)).toBe(200);
  check(saved.json(), say()).toEqual(result.json());
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

  // Seven request mappings through the integrated action union, sharing one
  // owner session. Each case prepares its own action id, provider-call counts
  // are deltas rather than absolute, and every check is soft and names its
  // case, so one broken mapping cannot hide the others.
  it("maps each account action to its exact provider request through the owner API", async () => {
    const cases: Array<{ name: string; run: (name: string) => Promise<void> }> = [
      {
        name: "bank_payout_details_read reads the payout details through the governed one-shot route",
        run: async (name) => {
          const id = randomUUID();
          const before = fetchMock.mock.calls.length;
          await expectPrepared(id, { action: "bank_payout_details_read", pageId }, name);
          const details = { payoutSystem: "synthetic-bank", accountNumber: "masked-last-four-1234" };
          fetchMock.mockResolvedValueOnce(response(details));
          expect.soft(await expectConfirmed(id, name), name).toMatchObject({ responseData: details });
          expect.soft(sent(), name).toMatchObject({ method: "GET", rawBody: undefined });
          expect.soft(sent().url.pathname.endsWith(`/${ACCOUNT}/banking/details/bank`), name).toBe(true);
          expect.soft(fetchMock.mock.calls.length - before, name).toBe(1);
        },
      },
      ...[
        { action: "saved_message_autosend_update", period: 12, path: "/messages/settings/enable-or-update-automatic-messaging" },
        { action: "saved_post_autopost_update", period: 48, path: "/posts/settings/enable-or-update-automatic-posting" },
      ].map(({ action, period, path }) => ({
        name: `${action} goes to the provider's native scheduler with only its period`,
        run: async (name: string) => {
          const id = randomUUID();
          const before = fetchMock.mock.calls.length;
          await expectPrepared(id, { action, pageId, period }, name);
          fetchMock.mockResolvedValueOnce(response({ period }));
          expect.soft(await expectConfirmed(id, name), name).toMatchObject({ responseData: { period } });
          expect.soft(sent(), name).toMatchObject({ method: "PATCH", body: { period } });
          expect.soft(sent().url.pathname.endsWith(`/${ACCOUNT}/saved-for-later${path}`), name).toBe(true);
          expect.soft(fetchMock.mock.calls.length - before, name).toBe(1);
        },
      })),
      {
        name: "an unsupported scheduler period is rejected before admission",
        run: async (name) => {
          const before = fetchMock.mock.calls.length;
          const result = await prepare(randomUUID(), { action: "saved_post_autopost_update", pageId, period: 8 });
          expect.soft(result.statusCode, name).toBe(400);
          expect.soft(fetchMock.mock.calls.length - before, name).toBe(0);
        },
      },
      {
        name: "account_profile_update translates explicit clears to null while retaining omitted fields",
        run: async (name) => {
          const id = randomUUID();
          await expectPrepared(id, { action: "account_profile_update", pageId, name: "Новое имя", about: null, clearFields: ["website", "location"] }, name);
          fetchMock.mockResolvedValueOnce(response({ success: true }));
          await expectConfirmed(id, name);
          expect.soft(sent(), name).toMatchObject({ method: "POST", body: { name: "Новое имя", about: null, website: null, location: null } });
          expect.soft(sent().body, name).not.toHaveProperty("username");
          expect.soft(sent().body, name).not.toHaveProperty("wishlist");
          expect.soft(sent().body, name).not.toHaveProperty("clearFields");
          expect.soft(sent().url.pathname.endsWith(`/${ACCOUNT}/settings/profile`), name).toBe(true);
        },
      },
      {
        name: "subscription_price_update preserves decimal prices and the provider's explicit free value",
        run: async (name) => {
          const before = fetchMock.mock.calls.length;
          for (const [priceCents, price] of [[499, "4.99"], [1299, "12.99"], [0, "free"]] as const) {
            const label = `${name} (${priceCents} cents)`;
            const id = randomUUID();
            await expectPrepared(id, { action: "subscription_price_update", pageId, priceCents }, label);
            fetchMock.mockResolvedValueOnce(response({ success: true }));
            await expectConfirmed(id, label);
            expect.soft(sent(), label).toMatchObject({ method: "PATCH", body: { price } });
            expect.soft(sent().url.pathname.endsWith(`/${ACCOUNT}/settings/subscription-price`), label).toBe(true);
          }
          expect.soft(fetchMock.mock.calls.length - before, name).toBe(3);
        },
      },
      {
        name: "blocked_countries_update preserves an explicit geography clear as null and an empty state replacement",
        run: async (name) => {
          const id = randomUUID();
          await expectPrepared(id, { action: "blocked_countries_update", pageId, blockedCountries: null, blockedStates: [] }, name);
          fetchMock.mockResolvedValueOnce(response({ success: true }));
          await expectConfirmed(id, name);
          expect.soft(sent(), name).toMatchObject({ method: "PUT", body: { blockedCountries: null, blockedStates: [] } });
          expect.soft(sent().url.pathname.endsWith(`/${ACCOUNT}/settings/blocked-countries`), name).toBe(true);
        },
      },
    ];
    for (const { name, run } of cases) {
      await run(name);
    }
  });
});
