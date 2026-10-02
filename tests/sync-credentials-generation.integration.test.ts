import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";

import {
  getSyncPage,
  storeFanslySession,
  upsertDemand,
  type Database,
} from "@agency_hub_core/db";
import { decryptJsonWithKeyVersion, encryptJson } from "@agency_hub_core/shared";

import type { AppContext } from "../apps/runtime/src/bootstrap.ts";
import { updatePageCredentials } from "../apps/runtime/src/services/connections.ts";
import { readFanslyPageGeneration } from "../apps/runtime/src/services/egress/fansly-probe-context.ts";
import { saveProxy } from "../apps/runtime/src/services/page-context.ts";
import {
  checkFanslyIdentityThroughEngine,
  runFanslyIdentityCheck,
  trustStoredFanslyCredentials,
} from "../apps/runtime/src/services/sync-engine-account.ts";
import { SyncEngineHost } from "../apps/runtime/src/sync/engine/host.ts";
import { resetIntegrationDatabase, startIntegrationTestDatabase, type StartedTestDatabase } from "./helpers/db.ts";
import { createTestAppContext } from "./helpers/runtime.ts";
import {
  CountingConnectProxy,
  ensureHarnessSettingTable,
  FakeChats,
  FakeFanslyServer,
  HARNESS_ENCRYPTION_KEY,
  HARNESS_KEY,
  harnessConfig,
  harnessHostOptions,
  harnessRng,
  harnessRoutes,
  seedHarnessPage,
  until,
  type FakeRoute,
  type HarnessPage,
} from "./helpers/sync-engine.ts";
import { switchRegistry } from "./helpers/sync-switch.ts";

// The engine's credentials generation on a live page (design step 3 §3.5
// item 3, G1/G2/G14/G18, E16): an applied `account.verify` records the digest
// of the stored session and proxy it proved; until then the live transport
// sends nothing but the identity checks. An auth hold names the digest that
// failed: a candidate identity check still runs under it (another session),
// and storing a matching candidate lifts it; a change of the stored
// credentials made out of band lifts it for one verify, never a spin; a new
// proxy is followed by the next request.

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

interface Rig {
  server: FakeFanslyServer;
  proxy: CountingConnectProxy;
  page: HarnessPage;
  config: ReturnType<typeof harnessConfig>;
  /** The authorization header of every `/account/me`, in order. */
  identityTokens: string[];
}

async function rig(first: readonly FakeRoute[] = []): Promise<Rig> {
  server = await FakeFanslyServer.start();
  const proxy = await CountingConnectProxy.start();
  proxies.push(proxy);
  const identityTokens: string[] = [];
  server.route((request) => {
    if (request.url.pathname === "/api/v1/account/me") identityTokens.push(String(request.headers.authorization ?? ""));
    return null;
  });
  for (const route of first) server.route(route);
  for (const route of harnessRoutes(new FakeChats())) server.route(route);
  const page = await seedHarnessPage({ db: db(), pool: testDb!.pool }, { mode: "live", proxyUrl: proxy.url, label: "creds-page" });
  return { server, proxy, page, config: harnessConfig(testDb!.connectionString, server.apiBaseUrl), identityTokens };
}

async function startHost(r: Rig, seed: number): Promise<SyncEngineHost> {
  const host = new SyncEngineHost(harnessHostOptions({
    db: db(),
    pool: testDb!.pool,
    connectionString: testDb!.connectionString,
    config: r.config,
    rng: harnessRng(seed),
    registry: switchRegistry(),
  }));
  hosts.push(host);
  await host.start();
  return host;
}

async function storedGeneration(page: HarnessPage): Promise<string> {
  return db().transaction(
    async (raw) => readFanslyPageGeneration(raw as unknown as Database, page.pageLabel),
    { isolationLevel: "repeatable read", accessMode: "read only" },
  );
}

async function holdAuth(page: HarnessPage, failedGeneration: string): Promise<void> {
  await testDb!.pool.query(
    `update sync_pages set hold_kind = 'auth', hold_until = 'infinity', hold_since = clock_timestamp(),
            hold_detail = jsonb_build_object('status', 401, 'credentialsGeneration', $2::text)
      where page_id = $1`,
    [page.pageId, failedGeneration],
  );
}

async function urgent(pageId: number, subject: string): Promise<void> {
  await upsertDemand(db(), { pageId, shadow: false, resource: HARNESS_KEY.urgent, subject, kind: "trigger", class: "urgent", demand: { reasons: ["test"] } });
}

function appContext(): AppContext {
  return createTestAppContext(testDb!, { fanslySendGuardSettingMs: S });
}

async function verifyAttempts(pageId: number): Promise<number> {
  return Number((await testDb!.pool.query(
    "select count(*)::int as n from sync_attempts where page_id = $1 and resource = 'account.verify'", [pageId],
  )).rows[0].n);
}

describe("the credentials generation of a live page", () => {
  it("is recorded by an applied verify; before it, the transport sends nothing but the verify", async (context) => {
    if (!testDb) return context.skip();
    const r = await rig();
    await testDb.pool.query("update sync_pages set credentials_generation = null where page_id = $1", [r.page.pageId]);
    await urgent(r.page.pageId, "u1");
    await urgent(r.page.pageId, "u2");
    await startHost(r, 31);
    await until(async () => r.server.arrivalsAt("/api/v1/trackinglinks").length === 2, 20_000, "the reads after the verify");

    expect(r.server.arrivals[0]!.path.split("?")[0]).toBe("/api/v1/account/me");
    expect((await getSyncPage(db(), r.page.pageId))!.credentialsGeneration).toBe(await storedGeneration(r.page));
    expect(await verifyAttempts(r.page.pageId)).toBe(1);
    const verify = await testDb.pool.query<{ demand: { reasons: string[] } }>(
      "select demand from sync_work where page_id = $1 and resource = 'account.verify'", [r.page.pageId],
    );
    expect(verify.rows[0]!.demand.reasons).toContain("credentials_changed");
    // The attempt journals the digest it carried (not a secret).
    const journaled = await testDb.pool.query<{ generation: string }>(
      "select request ->> 'credentialsGeneration' as generation from sync_attempts where page_id = $1 and resource = 'account.verify'", [r.page.pageId],
    );
    expect(journaled.rows[0]!.generation).toBe(await storedGeneration(r.page));
  }, 60_000);

  it("under an auth hold, a credentials change runs its identity check, stores the candidate and lifts the hold; nothing else goes out under it", async (context) => {
    if (!testDb) return context.skip();
    const r = await rig();
    const failed = await storedGeneration(r.page);
    await holdAuth(r.page, failed);
    await urgent(r.page.pageId, "u1");
    await startHost(r, 32);
    await new Promise((resolve) => setTimeout(resolve, 1_500));
    expect(r.server.arrivals).toEqual([]);

    const app = appContext();
    const result = await updatePageCredentials(app, r.page.pageLabel, {
      platform: "fansly",
      session: { authorization: "fresh-token", fanslyClientId: "client-id", fanslyClientCheck: "client-check", fanslySessionId: "session-id" },
    });
    expect(result).toMatchObject({ updated: true, verified: true });
    // The identity check went out first, with the candidate session.
    expect(r.server.arrivals[0]!.path.split("?")[0]).toBe("/api/v1/account/me");
    expect(r.identityTokens[0]).toBe("fresh-token");
    const page = (await getSyncPage(db(), r.page.pageId))!;
    expect(page.credentialsGeneration).toBe(await storedGeneration(r.page));
    expect(page.credentialsGeneration).not.toBe(failed);
    const stored = await testDb.pool.query<{ encrypted_session: string }>(
      "select encrypted_session from page_credentials where platform_account_id = $1", [r.page.pageId],
    );
    expect(decryptJsonWithKeyVersion<{ session: { authorization: string } }>(stored.rows[0]!.encrypted_session, new Map([[1, HARNESS_ENCRYPTION_KEY]])).session.authorization)
      .toBe("fresh-token");
    // The hold no longer applies: the queued read goes out, with the new session.
    await until(async () => r.server.arrivalsAt("/api/v1/trackinglinks").length === 1, 15_000, "the read after the hold");
    const identity = await testDb.pool.query<{ state: string; close_reason: string; secret_params: string | null }>(
      "select state, close_reason, secret_params from sync_work where page_id = $1 and resource = 'account.identity'", [r.page.pageId],
    );
    expect(identity.rows).toEqual([{ state: "done", close_reason: "identity_matches", secret_params: null }]);
  }, 60_000);

  it("a takeover verify refused with 401, then the owner's new credentials: the read queued before it goes out", async (context) => {
    if (!testDb) return context.skip();
    // Only the owner's new session is accepted; the stored one gets 401.
    const r = await rig([(request) => (request.url.pathname === "/api/v1/account/me" && request.headers.authorization !== "fresh-token"
      ? { status: 401, headers: { "content-type": "application/json" }, body: JSON.stringify({ success: false }) }
      : null)]);
    await testDb.pool.query("update sync_pages set credentials_generation = null where page_id = $1", [r.page.pageId]);
    const refused = await storedGeneration(r.page);
    // The urgent read is picked first and refused by the transport (nothing
    // verified yet); the verify it raises meets the 401.
    await urgent(r.page.pageId, "u1");
    await startHost(r, 36);
    await until(async () => (await getSyncPage(db(), r.page.pageId))!.holdKind === "auth", 15_000, "the auth hold of the takeover verify");
    const held = (await getSyncPage(db(), r.page.pageId))!;
    expect(held.holdDetail.credentialsGeneration).toBe(refused);
    expect(r.server.arrivalsAt("/api/v1/trackinglinks")).toEqual([]);

    const result = await updatePageCredentials(appContext(), r.page.pageLabel, {
      platform: "fansly",
      session: { authorization: "fresh-token", fanslyClientId: "client-id", fanslyClientCheck: "client-check", fanslySessionId: "session-id" },
    });
    expect(result).toMatchObject({ updated: true, verified: true });
    // The trusted digest is the new one, never the refused one: the actor
    // leaves its checks-only mode and the queued read goes out.
    await until(async () => r.server.arrivalsAt("/api/v1/trackinglinks").length === 1, 15_000, "the queued read after the renewal");
    const page = (await getSyncPage(db(), r.page.pageId))!;
    expect(page.credentialsGeneration).toBe(await storedGeneration(r.page));
    expect(page.credentialsGeneration).not.toBe(refused);
    const work = await testDb.pool.query<{ state: string }>(
      "select state from sync_work where page_id = $1 and resource = $2 and subject = 'u1'", [r.page.pageId, HARNESS_KEY.urgent],
    );
    expect(work.rows.map((row) => row.state)).not.toContain("open");
  }, 60_000);

  it("a refused candidate closes its check and holds nothing; the stored session stays", async (context) => {
    if (!testDb) return context.skip();
    const r = await rig([(request) => (request.url.pathname === "/api/v1/account/me" && request.headers.authorization === "bad-token"
      ? { status: 401, headers: { "content-type": "application/json" }, body: JSON.stringify({ success: false }) }
      : null)]);
    const before = await storedGeneration(r.page);
    await startHost(r, 33);
    const app = appContext();
    await expect(updatePageCredentials(app, r.page.pageLabel, {
      platform: "fansly", session: { authorization: "bad-token" },
    })).rejects.toThrow(/refused|identity/);
    const page = (await getSyncPage(db(), r.page.pageId))!;
    expect(page.holdKind).toBeNull();
    expect(await storedGeneration(r.page)).toBe(before);
  }, 60_000);

  it("an out-of-band change of the stored credentials under an auth hold lifts it for one account.verify, without a spin", async (context) => {
    if (!testDb) return context.skip();
    const r = await rig();
    const failed = await storedGeneration(r.page);
    await holdAuth(r.page, failed);
    await urgent(r.page.pageId, "u1");
    await startHost(r, 34);
    await new Promise((resolve) => setTimeout(resolve, 1_000));
    expect(r.server.arrivals).toEqual([]);
    const session = { authorization: "rotated-token", fanslyClientId: "client-id", fanslyClientCheck: "client-check", fanslySessionId: "session-id" };
    await storeFanslySession(db(), r.page.pageId, JSON.stringify(encryptJson(session, HARNESS_ENCRYPTION_KEY, 1)), 1);

    await until(async () => r.server.arrivalsAt("/api/v1/trackinglinks").length === 1, 20_000, "the read after the verify");
    expect(r.server.arrivals[0]!.path.split("?")[0]).toBe("/api/v1/account/me");
    expect(r.identityTokens).toEqual(["rotated-token"]);
    const page = (await getSyncPage(db(), r.page.pageId))!;
    expect(page.holdKind).toBeNull();
    expect(page.credentialsGeneration).toBe(await storedGeneration(r.page));
    expect(await verifyAttempts(r.page.pageId)).toBe(1);
  }, 60_000);

  it("a candidate identity check's 429 under an auth hold keeps the auth hold: nothing goes out before the 429 ends, the stored session's read waits for the renewal", async (context) => {
    if (!testDb) return context.skip();
    let throttled = 0;
    const r = await rig([(request) => {
      if (request.url.pathname !== "/api/v1/account/me" || request.headers.authorization !== "fresh-token" || throttled > 0) return null;
      throttled += 1;
      return { status: 429, headers: { "content-type": "application/json", "retry-after": "2" }, body: JSON.stringify({ success: false }) };
    }]);
    const failed = await storedGeneration(r.page);
    await holdAuth(r.page, failed);
    await urgent(r.page.pageId, "u1");
    await startHost(r, 37);
    const page = { id: r.page.pageId, label: r.page.pageLabel };
    const fresh = { authorization: "fresh-token", fanslyClientId: "client-id", fanslyClientCheck: "client-check", fanslySessionId: "session-id" };
    const checked = runFanslyIdentityCheck(appContext(), page, { session: fresh });

    // The 429 is carried beside the auth hold: neither replaced nor lifted.
    await until(async () => (await getSyncPage(db(), r.page.pageId))!.holdDetail.timedHold !== undefined, 15_000, "the candidate's 429");
    const held = (await getSyncPage(db(), r.page.pageId))!;
    expect(held.holdKind).toBe("auth");
    expect(held.holdDetail.credentialsGeneration).toBe(failed);
    const carried = held.holdDetail.timedHold as { kind: string; until: string };
    expect(carried.kind).toBe("rate_limit");
    const holdEnd = new Date(carried.until).getTime();

    // The check runs again only after the 429 ended, and passes.
    expect(await checked).toMatchObject({ matches: true });
    const identities = r.server.arrivalsAt("/api/v1/account/me");
    expect(identities.map((arrival) => arrival.status)).toEqual([429, 200]);
    expect(identities[1]!.wallMs).toBeGreaterThanOrEqual(holdEnd);
    // The auth hold outlived the 429: the stored session that failed sends nothing.
    await new Promise((resolve) => setTimeout(resolve, 4 * S));
    expect(r.server.arrivalsAt("/api/v1/trackinglinks")).toEqual([]);
    expect((await getSyncPage(db(), r.page.pageId))!.holdKind).toBe("auth");

    // The renewal (stored and trusted, as the credentials route does) lifts it.
    await db().transaction(async (raw) => {
      const tx = raw as unknown as Database;
      await storeFanslySession(tx, r.page.pageId, JSON.stringify(encryptJson(fresh, HARNESS_ENCRYPTION_KEY, 1)), 1);
      await trustStoredFanslyCredentials(tx, page);
    });
    await until(async () => r.server.arrivalsAt("/api/v1/trackinglinks").length === 1, 15_000, "the read after the renewal");
    expect(r.identityTokens.at(-1)).toBe("fresh-token");
  }, 60_000);

  it("a proxy change: the identity check rides the candidate proxy, and the next request leaves through the new one", async (context) => {
    if (!testDb) return context.skip();
    const r = await rig();
    const next = await CountingConnectProxy.start();
    proxies.push(next);
    await startHost(r, 35);
    await until(async () => r.server.arrivalsAt("/api/v1/polls").length >= 2, 15_000, "polls through the first proxy");
    expect(r.proxy.tunnels).toBeGreaterThan(0);

    const app = appContext();
    const page = { id: r.page.pageId, label: r.page.pageLabel };
    await checkFanslyIdentityThroughEngine(app, page, { proxy: { url: next.url } });
    expect(next.tunnels).toBe(1);
    // Stored and trusted as `setPageProxy` does on a live page.
    await db().transaction(async (raw) => {
      const tx = raw as unknown as Database;
      await saveProxy({ config: app.config, db: tx }, page.id, { url: next.url });
      await trustStoredFanslyCredentials(tx, page);
    });
    const firstTunnels = r.proxy.tunnels;
    const polls = r.server.arrivalsAt("/api/v1/polls").length;
    await until(async () => r.server.arrivalsAt("/api/v1/polls").length >= polls + 2, 15_000, "polls after the change");
    expect(next.tunnels).toBeGreaterThanOrEqual(2);
    expect(r.proxy.tunnels).toBe(firstTunnels);
  }, 60_000);
});
