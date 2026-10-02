import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { getSyncPage, type Database } from "@agency_hub_core/db";

import { buildApiServer } from "../apps/runtime/src/api/server.ts";
import type { AppContext } from "../apps/runtime/src/bootstrap.ts";
import { createUserAccount } from "../apps/runtime/src/services/auth.ts";
import { readFanslyPageGeneration } from "../apps/runtime/src/services/egress/fansly-probe-context.ts";
import { setPageProxy } from "../apps/runtime/src/services/page-proxies.ts";
import { SyncEngineHost } from "../apps/runtime/src/sync/engine/host.ts";
import type * as UrgentModule from "../apps/runtime/src/sync/requests/urgent.ts";
import { resetIntegrationDatabase, startIntegrationTestDatabase, type StartedTestDatabase } from "./helpers/db.ts";
import { createTestAppContext } from "./helpers/runtime.ts";
import {
  CountingConnectProxy,
  ensureHarnessSettingTable,
  FakeChats,
  FakeFanslyServer,
  harnessConfig,
  harnessHostOptions,
  harnessRng,
  harnessRoutes,
  seedHarnessPage,
  type HarnessPage,
} from "./helpers/sync-engine.ts";
import { setModeDirect } from "./helpers/sync-engine-host.ts";
import { switchRegistry } from "./helpers/sync-switch.ts";

// The owner's `/account/me` levers by the page's engine mode (design step 3
// §3.5 item 6, E10): `off` keeps the legacy path (the adapter's request,
// paced by the step-1 guard); `handover` answers 409 `fansly_page_switching`
// before anything is resolved or sent; `live` goes through the page's actor —
// `account.verify` for the page verify, `account.identity` with the candidate
// for a credentials or proxy change, stored only when it matches — and a
// check the engine has not answered within the wait answers 409
// `fansly_sync_work_queued` with the work's status link.

vi.mock("argon2", () => import("./helpers/cheap-argon2.ts"));
// The rig's proxies listen on loopback, which the owner's proxy check refuses.
vi.mock("../apps/runtime/src/services/proxy-validation.ts", () => ({ assertAllowedProxyTarget: async () => undefined }));

const forced = vi.hoisted(() => ({ queued: false }));
vi.mock("../apps/runtime/src/sync/requests/urgent.ts", async (importOriginal) => {
  const actual = await importOriginal<typeof UrgentModule>();
  return {
    ...actual,
    enqueueAndWait: async (...args: Parameters<typeof actual.enqueueAndWait>) => {
      if (forced.queued) return { state: "queued" as const, workId: 77, statusUrl: "/api/v1/sync/pages/routing-page/work/77" };
      return actual.enqueueAndWait(...args);
    },
  };
});

const S = 300;

let testDb: StartedTestDatabase | null = null;
let server: FakeFanslyServer | null = null;
const proxies: CountingConnectProxy[] = [];
const hosts: SyncEngineHost[] = [];

beforeAll(async () => {
  testDb = await startIntegrationTestDatabase();
}, 120_000);

afterAll(async () => {
  await testDb?.stop();
});

beforeEach(async () => {
  forced.queued = false;
  if (!testDb) return;
  await resetIntegrationDatabase(testDb.pool);
  await ensureHarnessSettingTable(testDb.pool, S);
});

afterEach(async () => {
  await Promise.all(hosts.splice(0).map((host) => host.stop()));
  await server?.close();
  await Promise.all(proxies.splice(0).map((proxy) => proxy.close()));
  server = null;
});

function db(): Database {
  return testDb!.db as unknown as Database;
}

const sentinel = () => {
  throw new Error("adapter reached");
};

interface Rig {
  page: HarnessPage;
  server: FakeFanslyServer;
  app: AppContext;
  adapter: { getAccountMe: ReturnType<typeof vi.fn>; verifySession: ReturnType<typeof vi.fn> };
  identityTokens: string[];
}

async function rig(mode: "off" | "handover" | "live"): Promise<Rig> {
  server = await FakeFanslyServer.start();
  const proxy = await CountingConnectProxy.start();
  proxies.push(proxy);
  const identityTokens: string[] = [];
  server.route((request) => {
    if (request.url.pathname === "/api/v1/account/me") identityTokens.push(String(request.headers.authorization ?? ""));
    return null;
  });
  for (const route of harnessRoutes(new FakeChats())) server.route(route);
  const page = await seedHarnessPage({ db: db(), pool: testDb!.pool }, { mode: mode === "live" ? "live" : "shadow", proxyUrl: proxy.url, label: "routing-page" });
  if (mode !== "live") await setModeDirect(testDb!.pool, page.pageId, mode);
  const adapter = { getAccountMe: vi.fn(sentinel), verifySession: vi.fn(sentinel) };
  const app = createTestAppContext(testDb!, { adapter: adapter as unknown as AppContext["adapter"], fanslySendGuardSettingMs: S });
  if (mode === "live") {
    const host = new SyncEngineHost(harnessHostOptions({
      db: db(),
      pool: testDb!.pool,
      connectionString: testDb!.connectionString,
      config: harnessConfig(testDb!.connectionString, server.apiBaseUrl),
      rng: harnessRng(41),
      registry: switchRegistry(),
    }));
    hosts.push(host);
    await host.start();
  }
  return { page, server, app, adapter, identityTokens };
}

async function ownerCookie(app: AppContext, apiServer: Awaited<ReturnType<typeof buildApiServer>>): Promise<string> {
  await createUserAccount(app, { username: "owner", role: "owner", password: "owner-secret" }, { source: "cli" });
  const login = await apiServer.inject({ method: "POST", url: "/api/v1/auth/login", payload: { username: "owner", password: "owner-secret" } });
  const header = login.headers["set-cookie"];
  return (Array.isArray(header) ? header[0] : header)!.split(";")[0]!;
}

async function storedGeneration(page: HarnessPage): Promise<string> {
  return db().transaction(
    async (raw) => readFanslyPageGeneration(raw as unknown as Database, page.pageLabel),
    { isolationLevel: "repeatable read", accessMode: "read only" },
  );
}

describe("the /account/me levers by engine mode", () => {
  it("off: the legacy path (the adapter is reached)", async (context) => {
    if (!testDb) return context.skip();
    const r = await rig("off");
    const apiServer = await buildApiServer(r.app);
    await apiServer.ready();
    try {
      const cookie = await ownerCookie(r.app, apiServer);
      const verify = await apiServer.inject({ method: "POST", url: `/api/v1/admin/pages/${r.page.pageLabel}/verify`, headers: { cookie } });
      expect(verify.statusCode).not.toBe(409);
      expect(r.adapter.getAccountMe).toHaveBeenCalled();
      const credentials = await apiServer.inject({
        method: "PATCH", url: `/api/v1/admin/pages/${r.page.pageLabel}/credentials`, headers: { cookie },
        payload: { platform: "fansly", session: { authorization: "fresh" } },
      });
      expect(credentials.statusCode).not.toBe(409);
      expect(r.adapter.verifySession).toHaveBeenCalled();
    } finally {
      await apiServer.close();
    }
    expect(r.server.arrivals).toEqual([]);
  }, 60_000);

  it("handover: 409 fansly_page_switching, nothing resolved, sent or stored", async (context) => {
    if (!testDb) return context.skip();
    const r = await rig("handover");
    const before = await storedGeneration(r.page);
    const apiServer = await buildApiServer(r.app);
    await apiServer.ready();
    try {
      const cookie = await ownerCookie(r.app, apiServer);
      const verify = await apiServer.inject({ method: "POST", url: `/api/v1/admin/pages/${r.page.pageLabel}/verify`, headers: { cookie } });
      expect(verify.statusCode).toBe(409);
      expect(verify.json()).toMatchObject({ error: "fansly_page_switching" });
      const credentials = await apiServer.inject({
        method: "PATCH", url: `/api/v1/admin/pages/${r.page.pageLabel}/credentials`, headers: { cookie },
        payload: { platform: "fansly", session: { authorization: "fresh" } },
      });
      expect(credentials.statusCode).toBe(409);
      expect(credentials.json()).toMatchObject({ error: "fansly_page_switching" });
    } finally {
      await apiServer.close();
    }
    await expect(setPageProxy(r.app, r.page.pageLabel, { url: "http://127.0.0.1:9" })).rejects.toMatchObject({ code: "fansly_page_switching" });
    expect(r.adapter.getAccountMe).not.toHaveBeenCalled();
    expect(r.adapter.verifySession).not.toHaveBeenCalled();
    expect(r.server.arrivals).toEqual([]);
    expect(await storedGeneration(r.page)).toBe(before);
    expect((await testDb.pool.query("select count(*)::int as n from sync_work where not shadow")).rows[0].n).toBe(0);
  }, 60_000);

  it("live: verify, a credentials change and a proxy change go through the page's actor", async (context) => {
    if (!testDb) return context.skip();
    const r = await rig("live");
    const apiServer = await buildApiServer(r.app);
    await apiServer.ready();
    try {
      const cookie = await ownerCookie(r.app, apiServer);
      const verify = await apiServer.inject({ method: "POST", url: `/api/v1/admin/pages/${r.page.pageLabel}/verify`, headers: { cookie } });
      expect(verify.statusCode).toBe(200);
      expect(verify.json()).toEqual({ verified: true, username: "harness", platform: "fansly", syncUnblocked: true });

      const credentials = await apiServer.inject({
        method: "PATCH", url: `/api/v1/admin/pages/${r.page.pageLabel}/credentials`, headers: { cookie },
        payload: { platform: "fansly", session: { authorization: "fresh-token" } },
      });
      expect(credentials.statusCode).toBe(200);
      expect(credentials.json()).toMatchObject({ updated: true, verified: true });
    } finally {
      await apiServer.close();
    }
    expect(r.identityTokens).toEqual(["token", "fresh-token"]);
    expect((await getSyncPage(db(), r.page.pageId))!.credentialsGeneration).toBe(await storedGeneration(r.page));

    const next = await CountingConnectProxy.start();
    proxies.push(next);
    await setPageProxy(r.app, r.page.pageLabel, { url: next.url });
    expect(next.tunnels).toBeGreaterThanOrEqual(1);
    expect((await getSyncPage(db(), r.page.pageId))!.credentialsGeneration).toBe(await storedGeneration(r.page));
    const stored = await testDb.pool.query<{ url: string }>("select url from egress_endpoints where platform_account_id = $1 order by id desc limit 1", [r.page.pageId]);
    expect(stored.rows[0]!.url).toBe(next.url);

    expect(r.adapter.getAccountMe).not.toHaveBeenCalled();
    expect(r.adapter.verifySession).not.toHaveBeenCalled();
    const works = await testDb.pool.query<{ resource: string; close_reason: string }>(
      "select resource, close_reason from sync_work where page_id = $1 and resource like 'account.%' and not shadow order by id", [r.page.pageId],
    );
    expect(works.rows).toEqual([
      { resource: "account.verify", close_reason: "verified" },
      { resource: "account.identity", close_reason: "identity_matches" },
      { resource: "account.identity", close_reason: "identity_matches" },
    ]);
  }, 60_000);

  it("live: a check the engine has not answered is 409 fansly_sync_work_queued with its status link; nothing is stored", async (context) => {
    if (!testDb) return context.skip();
    const r = await rig("live");
    const before = await storedGeneration(r.page);
    forced.queued = true;
    const apiServer = await buildApiServer(r.app);
    await apiServer.ready();
    try {
      const cookie = await ownerCookie(r.app, apiServer);
      const verify = await apiServer.inject({ method: "POST", url: `/api/v1/admin/pages/${r.page.pageLabel}/verify`, headers: { cookie } });
      expect(verify.statusCode).toBe(409);
      expect(verify.json()).toMatchObject({ error: "fansly_sync_work_queued", statusUrl: "/api/v1/sync/pages/routing-page/work/77" });
      const credentials = await apiServer.inject({
        method: "PATCH", url: `/api/v1/admin/pages/${r.page.pageLabel}/credentials`, headers: { cookie },
        payload: { platform: "fansly", session: { authorization: "fresh-token" } },
      });
      expect(credentials.statusCode).toBe(409);
      expect(credentials.json()).toMatchObject({ error: "fansly_sync_work_queued" });
    } finally {
      await apiServer.close();
    }
    expect(await storedGeneration(r.page)).toBe(before);
  }, 60_000);
});
