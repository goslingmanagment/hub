import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import {
  createFanslyPage,
  createLiveSyncPage,
  createModel,
  createOnlyFansPage,
  ensureFanslyPageSendGuard,
  ensurePageSyncStates,
  ensureSyncPage,
  getSyncPage,
  LiveSyncPageRefusedError,
  upsertCheckpoint,
  type Database,
  type LiveSyncPageRefusal,
} from "@agency_hub_core/db";
import { FanslyApiError } from "@agency_hub_core/fansly";

import { buildApiServer } from "../apps/runtime/src/api/server.ts";
import type { AppContext } from "../apps/runtime/src/bootstrap.ts";
import { createUserAccount } from "../apps/runtime/src/services/auth.ts";
import { readFanslyPageGeneration } from "../apps/runtime/src/services/egress/fansly-probe-context.ts";
import { onboardFanslyPage } from "../apps/runtime/src/services/page-onboarding.ts";
import { SyncEngineHost } from "../apps/runtime/src/sync/engine/host.ts";
import { checkFanslyIdentityWithoutPage } from "../apps/runtime/src/sync/fansly/identity-without-page.ts";
import { resetIntegrationDatabase, startIntegrationTestDatabase, type StartedTestDatabase } from "./helpers/db.ts";
import { createTestAppContext } from "./helpers/runtime.ts";
import {
  CountingConnectProxy,
  ensureHarnessSettingTable,
  FakeChats,
  FakeFanslyServer,
  fanslyJson,
  harnessConfig,
  harnessHostOptions,
  harnessRng,
  harnessRoutes,
  HARNESS_OWN_REF,
  until,
  type FakeAnswer,
  type TakeoverRecord,
} from "./helpers/sync-engine.ts";
import { switchRegistry } from "./helpers/sync-switch.ts";

// Fixture passwords hash at minimum cost; sign-in still runs the real argon2
// verify (tests/helpers/cheap-argon2.ts).
vi.mock("argon2", () => import("./helpers/cheap-argon2.ts"));

// The test's page proxy listens on loopback, which the real target check
// refuses; it alone is let through (tests/helpers/loopback-proxy-validation.ts).
const loopbackProxies = vi.hoisted(() => new Set<string>());
vi.mock("../apps/runtime/src/services/proxy-validation.ts", async (importOriginal) =>
  (await import("./helpers/loopback-proxy-validation.ts")).loopbackProxyValidation(await importOriginal(), loopbackProxies));

// Step 4 S4-05: a new Fansly page goes straight to `live` on the Fansly Sync
// Engine, and the dashboard's create-page check keeps working without the
// legacy adapter. Against the S2-14 harness — a fake Fansly origin behind a
// counting CONNECT proxy, the production host, pacer and page transport:
//
//  - onboarding: one journaled no-page `/account/me` (page_id null, source
//    `onboarding`) through the page's own proxy, then the page, its
//    credentials, proxy, identity, live engine row and engine guard in one
//    transaction; no legacy state; the host acquires it within a pass and its
//    first request is ≥ 1.2 × S after the takeover;
//  - `createLiveSyncPage` refuses a page with a legacy footprint;
//  - both callers (onboarding, `/admin/credentials/verify`) refuse a missing or
//    refused proxy before anything is journaled or sent;
//  - `/admin/credentials/verify` answers as before (valid, an invalid session,
//    a refused proxy), and the create-page flow (verify, then create) passes
//    on an app whose legacy adapter throws on any use — the state after S4-20.

const S = 300;
const PAGE_TOKEN = "page-session-token";
const REFUSED_TOKEN = "refused-session-token";
const OTHER_TOKEN = "other-account-token";
const OTHER_ACCOUNT = "300000000000000777";

let testDb: StartedTestDatabase | null = null;
let server: FakeFanslyServer | null = null;
let proxy: CountingConnectProxy | null = null;
let api: Awaited<ReturnType<typeof buildApiServer>> | null = null;
const hosts: SyncEngineHost[] = [];
/** The `authorization` header of every `/account/me` the origin received. */
let checks: string[] = [];

/** On any use: the state after S4-20 deletes the adapter's HTTP. */
const adapterInUse = new Proxy({}, {
  get(_target, property) {
    if (typeof property !== "string" || property === "then") return undefined;
    throw new Error(`the legacy Fansly adapter was used (${property})`);
  },
}) as AppContext["adapter"];

beforeAll(async () => {
  testDb = await startIntegrationTestDatabase();
}, 120_000);

afterAll(async () => {
  await testDb?.stop();
});

beforeEach(async (context) => {
  if (!testDb) {
    context.skip();
    return;
  }
  await resetIntegrationDatabase(testDb.pool);
  await ensureHarnessSettingTable(testDb.pool, S);
  checks = [];
  server = await FakeFanslyServer.start();
  proxy = await CountingConnectProxy.start();
  loopbackProxies.add(new URL(proxy.url).host);
  server.route((request) => (request.url.pathname === "/api/v1/account/me" ? accountMe(String(request.headers.authorization ?? "")) : null));
  for (const route of harnessRoutes(new FakeChats())) server.route(route);
});

afterEach(async () => {
  await api?.close();
  api = null;
  await Promise.all(hosts.splice(0).map((host) => host.stop()));
  if (proxy !== null) loopbackProxies.delete(new URL(proxy.url).host);
  await server?.close();
  await proxy?.close();
  server = null;
  proxy = null;
});

function db(): Database {
  return testDb!.db as unknown as Database;
}

/** `/account/me` by the session that asks: the page's own account, another
 *  account, or a refusal. */
function accountMe(authorization: string): FakeAnswer {
  checks.push(authorization);
  if (authorization === REFUSED_TOKEN) {
    return { status: 401, headers: { "content-type": "application/json" }, body: JSON.stringify({ success: false, error: { code: 401 } }) };
  }
  const id = authorization === OTHER_TOKEN ? OTHER_ACCOUNT : HARNESS_OWN_REF;
  return fanslyJson({
    account: {
      id,
      username: `user_${id.slice(-3)}`,
      displayName: `User ${id.slice(-3)}`,
      createdAt: 1_772_157_317_000,
      followCount: 42,
      subscriberCount: 7,
      earningsWallet: { id: "wallet-1", balance: 12_345 },
      walls: [{ id: "wall-1" }],
      subscriptionTiers: [{ id: "tier-1" }],
    },
  });
}

function app(): AppContext {
  return createTestAppContext(testDb!, { fanslyBaseUrl: server!.apiBaseUrl, adapter: adapterInUse });
}

async function seedModel(slug = "lora"): Promise<void> {
  await createModel(db(), { slug, name: slug });
}

function onboard(context: AppContext, label: string, overrides: { token?: string; proxyUrl?: string | null } = {}) {
  const proxyUrl = overrides.proxyUrl === undefined ? proxy!.url : overrides.proxyUrl;
  return onboardFanslyPage(context, {
    modelSlug: "lora",
    label,
    session: { authorization: overrides.token ?? PAGE_TOKEN },
    proxy: (proxyUrl === null ? null : { url: proxyUrl }) as never,
    by: "test",
  });
}

async function journal() {
  return (await testDb!.pool.query<{
    page_id: string | null;
    source: string;
    operation: string;
    outcome: string | null;
    http_status: number | null;
    sent: boolean;
    completed: boolean;
  }>(`select page_id::text, source, operation, outcome, http_status, sent_at is not null as sent,
             completed_at is not null as completed
        from fansly_send_log order by id`)).rows;
}

async function counts() {
  return (await testDb!.pool.query<Record<string, number>>(`
    select (select count(*)::int from pages) as pages,
           (select count(*)::int from page_credentials) as credentials,
           (select count(*)::int from egress_endpoints) as proxies,
           (select count(*)::int from sync_pages) as sync_pages,
           (select count(*)::int from fansly_page_send_guards) as guards,
           (select count(*)::int from page_sync_states) as sync_states,
           (select count(*)::int from page_sync_cursors) as sync_cursors
  `)).rows[0]!;
}

async function startApi(context: AppContext): Promise<string> {
  await createUserAccount(context, { username: "owner", role: "owner", password: "owner-secret" }, { source: "cli" });
  api = await buildApiServer(context);
  await api.ready();
  const login = await api.inject({ method: "POST", url: "/api/v1/auth/login", payload: { username: "owner", password: "owner-secret" } });
  const setCookie = login.headers["set-cookie"];
  const cookie = String((Array.isArray(setCookie) ? setCookie[0] : setCookie) ?? "").split(";")[0] ?? "";
  expect(cookie).not.toBe("");
  return cookie;
}

describe("onboarding goes straight to live (S4-05)", () => {
  it("creates the page live with its identity and an engine guard, no legacy state; the host acquires it within a pass and sends ≥ 1.2 × S later", async (context) => {
    if (!testDb) return context.skip();
    await seedModel();
    const takeovers: TakeoverRecord[] = [];
    const host = new SyncEngineHost(harnessHostOptions({
      db: db(),
      pool: testDb.pool,
      connectionString: testDb.connectionString,
      config: harnessConfig(testDb.connectionString, server!.apiBaseUrl),
      rng: harnessRng(5),
      registry: switchRegistry(),
      takeovers,
    }));
    hosts.push(host);
    await host.start();

    const { page, account } = await onboard(app(), "onboard-live");
    expect(account.id).toBe(HARNESS_OWN_REF);

    // One journaled no-page check, through the page's own proxy, with its session.
    expect(await journal()).toEqual([
      { page_id: null, source: "onboarding", operation: "account_me", outcome: "response", http_status: 200, sent: true, completed: true },
    ]);
    expect(checks).toEqual([PAGE_TOKEN]);
    expect(proxy!.tunnels).toBe(1);
    const check = server!.arrivalsAt("/api/v1/account/me")[0]!;

    const row = (await getSyncPage(db(), page.id))!;
    expect(row).toMatchObject({
      mode: "live",
      modeChangedBy: "onboarding:test",
      identityAccountId: HARNESS_OWN_REF,
      credentialsGeneration: await testDb.db.transaction(async (tx) => readFanslyPageGeneration(tx as unknown as Database, page.label)),
    });
    expect(row.legacyImportedAt).not.toBeNull();
    expect(row.requestsEnabledAt).not.toBeNull();
    // The proof's instant is the check's send (this process's clock).
    expect(Math.abs(row.identityCheckedAt!.getTime() - check.wallMs)).toBeLessThan(1_000);
    const guard = (await testDb.pool.query(
      "select owner_engine, engine_switched_at is not null as switched, holder_token, next_u from fansly_page_send_guards where page_id = $1",
      [page.id],
    )).rows[0];
    expect(guard).toEqual({ owner_engine: "fansly_sync_engine", switched: true, holder_token: null, next_u: 0.2 });
    expect(await counts()).toMatchObject({ pages: 1, sync_pages: 1, guards: 1, sync_states: 0, sync_cursors: 0 });
    const stored = (await testDb.pool.query(
      "select external_page_id, username, follower_count, subscriber_count, earnings_balance_mills, last_verified_at is not null as verified from pages where id = $1",
      [page.id],
    )).rows[0];
    expect(stored).toEqual({
      external_page_id: HARNESS_OWN_REF, username: "user_001", follower_count: 42, subscriber_count: 7,
      earnings_balance_mills: 12_345n, verified: true,
    });

    // Adopted within one mode-loop pass (the production loop runs every 2 s).
    await until(async () => host.state(page.id).kind === "running", 2_000, "the live owner");
    expect(host.state(page.id)).toMatchObject({ kind: "running", mode: "live" });
    // The trusted digest is the stored one: reads go out without a verify first.
    await until(async () => server!.arrivalsAt("/api/v1/polls").length >= 1, 15_000, "the engine's first read");
    expect(takeovers[0]!.floorDelayMs).toBeGreaterThanOrEqual(1.2 * S);
    const engine = server!.arrivals.filter((arrival) => arrival.seq > check.seq);
    expect(engine[0]!.mono - check.mono).toBeGreaterThanOrEqual(1.2 * S);
    expect(engine[0]!.mono - takeovers[0]!.mono).toBeGreaterThanOrEqual(1.2 * S - 1);
    expect(server!.arrivalsAt("/api/v1/account/me")).toHaveLength(1);
    // Nothing of the legacy engine: no page row in its send log, no stream state.
    expect((await journal()).filter((entry) => entry.page_id !== null)).toEqual([]);
    expect(await counts()).toMatchObject({ sync_states: 0, sync_cursors: 0 });
  }, 60_000);

  it("leaves nothing behind when the session is refused, and refuses a second page of the same account", async (context) => {
    if (!testDb) return context.skip();
    await seedModel();
    const failed = onboard(app(), "refused-page", { token: REFUSED_TOKEN });
    await expect(failed).rejects.toBeInstanceOf(FanslyApiError);
    await expect(failed).rejects.toMatchObject({ status: 401, message: "Fansly authorization failed (401)" });
    expect(await counts()).toMatchObject({ pages: 0, credentials: 0, proxies: 0, sync_pages: 0, guards: 0 });
    expect(await journal()).toEqual([
      { page_id: null, source: "onboarding", operation: "account_me", outcome: "response", http_status: 401, sent: true, completed: true },
    ]);

    await onboard(app(), "first-page");
    await expect(onboard(app(), "second-page")).rejects.toThrow(
      `Upstream account "fansly:${HARNESS_OWN_REF}" is already bound to page "first-page"`,
    );
    expect(await counts()).toMatchObject({ pages: 1, credentials: 1, proxies: 1, sync_pages: 1, guards: 1 });
    expect((await journal()).map((entry) => entry.source)).toEqual(["onboarding", "onboarding", "onboarding"]);
  });

  it("refuses a missing or refused proxy before anything is journaled or sent, for both callers", async (context) => {
    if (!testDb) return context.skip();
    await seedModel();
    await expect(onboard(app(), "no-proxy", { proxyUrl: null })).rejects.toMatchObject({ statusCode: 400 });
    await expect(onboard(app(), "private-proxy", { proxyUrl: "socks5://10.1.2.3:1080" })).rejects.toThrow(/Proxy host/);
    for (const proxyInput of [null, undefined, { url: "http://127.0.0.1:9" }]) {
      await expect(checkFanslyIdentityWithoutPage(app(), {
        session: { authorization: PAGE_TOKEN },
        proxy: proxyInput,
        source: "credentials_verify",
      })).rejects.toMatchObject({ statusCode: 400 });
    }
    expect(await journal()).toEqual([]);
    expect(checks).toEqual([]);
    expect(proxy!.tunnels).toBe(0);
    expect(await counts()).toMatchObject({ pages: 0, sync_pages: 0, guards: 0 });
  });
});

describe("createLiveSyncPage refuses a page with a past", () => {
  const generation = "a".repeat(64);

  async function attempt(pageId: number): Promise<LiveSyncPageRefusal[] | "created"> {
    try {
      await testDb!.db.transaction(async (tx) => createLiveSyncPage(tx as unknown as Database, {
        pageId,
        by: "onboarding:test",
        identityAccountId: "acct",
        identityCheckedAt: new Date(),
        credentialsGeneration: generation,
      }));
      return "created";
    } catch (error) {
      if (error instanceof LiveSyncPageRefusedError) return [...error.reasons];
      throw error;
    }
  }

  async function fanslyPage(label: string): Promise<number> {
    const model = await createModel(db(), { slug: `model-${label}`, name: label });
    return (await createFanslyPage(db(), { modelId: model!.id, label }))!.id;
  }

  it("writes nothing for a legacy footprint, an engine or guard row, or a page that is not Fansly", async (context) => {
    if (!testDb) return context.skip();
    const states = await fanslyPage("with-states");
    await ensurePageSyncStates(db(), { pageId: states });
    const cursors = await fanslyPage("with-cursors");
    await upsertCheckpoint(db(), { platformAccountId: cursors, stream: "light", cursorText: "0" });
    const sendLog = await fanslyPage("with-send-log");
    await testDb.pool.query(
      `insert into fansly_send_log (page_id, guard_token, source, operation, holder_host, holder_pid, holder_role, holder_instance, captured_at)
       values ($1, gen_random_uuid(), 'sync_stream', 'account_me', 'host', 1, 'worker', gen_random_uuid(), clock_timestamp())`,
      [sendLog],
    );
    const engineRow = await fanslyPage("with-engine-row");
    await ensureSyncPage(db(), { pageId: engineRow });
    const guardRow = await fanslyPage("with-guard-row");
    await ensureFanslyPageSendGuard(db(), guardRow);
    const model = await createModel(db(), { slug: "model-of", name: "of" });
    const onlyFans = (await createOnlyFansPage(db(), { modelId: model!.id, label: "of-page" }))!.id;
    const before = await counts();

    expect(await attempt(states)).toEqual(["legacy_sync_states"]);
    expect(await attempt(cursors)).toEqual(["legacy_sync_cursors"]);
    expect(await attempt(sendLog)).toEqual(["legacy_send_log"]);
    expect(await attempt(engineRow)).toEqual(["sync_page_exists"]);
    expect(await attempt(guardRow)).toEqual(["send_guard_exists"]);
    expect(await attempt(onlyFans)).toEqual(["no_fansly_page"]);
    expect(await counts()).toEqual(before);

    const clean = await fanslyPage("clean");
    expect(await attempt(clean)).toBe("created");
    expect((await getSyncPage(db(), clean))!.mode).toBe("live");
  });
});

describe("the dashboard's create-page check (/admin/credentials/verify) without the adapter", () => {
  it("answers as before: valid, an invalid session, a refused proxy", async (context) => {
    if (!testDb) return context.skip();
    const cookie = await startApi(app());
    const verify = (payload: Record<string, unknown>) =>
      api!.inject({ method: "POST", url: "/api/v1/admin/credentials/verify", headers: { cookie }, payload: { platform: "fansly", ...payload } });

    const valid = await verify({ session: { authorization: PAGE_TOKEN }, proxy: { url: proxy!.url } });
    expect(valid.statusCode, valid.body).toBe(200);
    expect(valid.json()).toEqual({ valid: true, platform: "fansly", username: "user_001", displayName: "User 001" });

    const invalid = await verify({ session: { authorization: REFUSED_TOKEN }, proxy: { url: proxy!.url } });
    expect(invalid.statusCode).toBe(400);
    expect(invalid.json().message).toBe("Credential verification failed: Fansly authorization failed (401)");

    const refused = await verify({ session: { authorization: PAGE_TOKEN }, proxy: { url: "socks5://127.0.0.1:1080" } });
    expect(refused.statusCode).toBe(400);
    expect(refused.json().message).toContain("Proxy host");
    const missing = await verify({ session: { authorization: PAGE_TOKEN } });
    expect(missing.statusCode).toBe(400);

    expect(await journal()).toEqual([
      { page_id: null, source: "credentials_verify", operation: "account_me", outcome: "response", http_status: 200, sent: true, completed: true },
      { page_id: null, source: "credentials_verify", operation: "account_me", outcome: "response", http_status: 401, sent: true, completed: true },
    ]);
    expect(checks).toEqual([PAGE_TOKEN, REFUSED_TOKEN]);
  });

  it("verifies, then creates a live page; a duplicate label is a typed 409 with nothing written", async (context) => {
    if (!testDb) return context.skip();
    await seedModel();
    const cookie = await startApi(app());
    const payload = { platform: "fansly", session: { authorization: PAGE_TOKEN }, proxy: { url: proxy!.url } };

    const verified = await api!.inject({ method: "POST", url: "/api/v1/admin/credentials/verify", headers: { cookie }, payload });
    expect(verified.statusCode, verified.body).toBe(200);
    const created = await api!.inject({
      method: "POST",
      url: "/api/v1/admin/pages",
      headers: { cookie },
      payload: { ...payload, modelSlug: "lora", label: "dashboard-page" },
    });
    expect(created.statusCode, created.body).toBe(200);
    expect(created.json()).toMatchObject({
      page: { label: "dashboard-page", platform: "fansly", username: "user_001" },
      verified: true,
      syncQueued: true,
      syncWarning: null,
      syncRetry: null,
    });
    const pageId = Number(created.json().page.id);
    expect((await getSyncPage(db(), pageId))).toMatchObject({ mode: "live", modeChangedBy: "onboarding:api:owner" });
    expect(await counts()).toMatchObject({ pages: 1, sync_pages: 1, guards: 1, sync_states: 0, sync_cursors: 0 });

    const duplicate = await api!.inject({
      method: "POST",
      url: "/api/v1/admin/pages",
      headers: { cookie },
      payload: { ...payload, session: { authorization: OTHER_TOKEN }, modelSlug: "lora", label: "dashboard-page" },
    });
    expect(duplicate.statusCode).toBe(409);
    expect(duplicate.json()).toEqual({ error: "conflict", message: 'Page "dashboard-page" already exists', statusCode: 409 });
    expect(await counts()).toMatchObject({ pages: 1, credentials: 1, proxies: 1, sync_pages: 1, guards: 1 });
    expect((await journal()).map((entry) => [entry.page_id, entry.source])).toEqual([
      [null, "credentials_verify"],
      [null, "onboarding"],
      [null, "onboarding"],
    ]);
  });
});
