import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";

import {
  getSyncPage,
  storeFanslySession,
  upsertDemand,
  type Database,
} from "@agency_hub_core/db";
import { decryptJsonWithKeyVersion, encryptJson } from "@agency_hub_core/shared";

import type { AppContext } from "../apps/runtime/src/bootstrap.ts";
import { readFanslyPageGeneration } from "../apps/runtime/src/services/egress/fansly-probe-context.ts";
import { saveProxy } from "../apps/runtime/src/services/page-context.ts";
import {
  checkFanslyIdentityThroughEngine,
  FanslyCredentialsChangedError,
  saveVerifiedFanslyCredentials,
} from "../apps/runtime/src/services/sync-engine-account.ts";
import { SyncCrashFault, type SyncFaultPoint } from "../apps/runtime/src/sync/engine/commit.ts";
import { SyncEngineHost } from "../apps/runtime/src/sync/engine/host.ts";
import { encryptSyncWorkSecret } from "../apps/runtime/src/sync/requests/secret-params.ts";
import { enqueueAndWait } from "../apps/runtime/src/sync/requests/urgent.ts";
import { resetIntegrationDatabase, startIntegrationTestDatabase, type StartedTestDatabase } from "./helpers/db.ts";
import { createTestAppContext } from "./helpers/runtime.ts";
import {
  crashRegistry,
  CRASH_READ_KEY,
  makeTestActor,
  RecordingMetrics,
  ScriptedLiveTransport,
  seedSyncPage,
  waitFor,
} from "./helpers/sync-engine-host.ts";
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

// The credentials holds of a live page (step 3b ruling 5, A3), end to end:
// a credentials hold records its LATEST refusal and is in force whatever
// digest the engine trusts (A verified, B refused); the verify of B is not
// admitted under it (no 401 loop), the verify of C stored since is — once —
// and its proof clears the hold in the apply's own transaction, which takes
// the page row FOR NO KEY UPDATE from its start (no deadlock with a waiting
// heartbeat). A crash between capture and apply, or a failed proof write,
// applies the stored answer again without a request. Checks-only is read
// from the database; a candidate save is a CAS on the pair its check proved;
// a hold written after the gate looked refuses at the admission.

const S = 300;

let testDb: StartedTestDatabase | null = null;
let server: FakeFanslyServer | null = null;
const proxies: CountingConnectProxy[] = [];
const hosts: SyncEngineHost[] = [];

beforeAll(async () => {
  testDb = await startIntegrationTestDatabase();
  await testDb?.pool.query(`
    create table if not exists sync_test_effects (observation_id bigint primary key, attempt_id bigint not null);
  `);
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
  page: HarnessPage;
  config: ReturnType<typeof harnessConfig>;
  /** The authorization header of every `/account/me`, in order. */
  identityTokens: string[];
}

/** `/account/me` refuses every session whose token is in `refused`. */
function refusing(refused: ReadonlySet<string>): FakeRoute {
  return (request) => (request.url.pathname === "/api/v1/account/me" && refused.has(String(request.headers.authorization ?? ""))
    ? { status: 401, headers: { "content-type": "application/json" }, body: JSON.stringify({ success: false }) }
    : null);
}

async function rig(label: string, first: readonly FakeRoute[] = []): Promise<Rig> {
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
  const page = await seedHarnessPage({ db: db(), pool: testDb!.pool }, { mode: "live", proxyUrl: proxy.url, label });
  return { server, page, config: harnessConfig(testDb!.connectionString, server.apiBaseUrl), identityTokens };
}

async function startHost(r: Rig, seed: number, faults?: (point: SyncFaultPoint) => Promise<void>): Promise<SyncEngineHost> {
  const host = new SyncEngineHost(harnessHostOptions({
    db: db(),
    pool: testDb!.pool,
    connectionString: testDb!.connectionString,
    config: r.config,
    rng: harnessRng(seed),
    registry: switchRegistry(),
    ...(faults === undefined ? {} : { faults }),
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

function session(token: string) {
  return { authorization: token, fanslyClientId: "client-id", fanslyClientCheck: "client-check", fanslySessionId: "session-id" };
}

/** The owner's session stored out of band (no engine route). */
async function storeSession(page: HarnessPage, token: string): Promise<string> {
  await storeFanslySession(db(), page.pageId, JSON.stringify(encryptJson(session(token), HARNESS_ENCRYPTION_KEY, 1)), 1);
  return storedGeneration(page);
}

/** A legacy-shaped auth hold of `failed` (no refused attempt): only a proof
 *  sent after it was taken clears it. */
async function holdAuth(page: HarnessPage, failed: string): Promise<void> {
  await testDb!.pool.query(
    `update sync_pages set hold_kind = 'auth', hold_until = 'infinity', hold_since = clock_timestamp(),
            hold_detail = jsonb_build_object('status', 401, 'credentialsGeneration', $2::text)
      where page_id = $1`,
    [page.pageId, failed],
  );
}

async function urgent(pageId: number, subject: string): Promise<void> {
  await upsertDemand(db(), { pageId, shadow: false, resource: HARNESS_KEY.urgent, subject, kind: "trigger", class: "urgent", demand: { reasons: ["test"] } });
}

function appContext(): AppContext {
  return createTestAppContext(testDb!, { fanslySendGuardSettingMs: S });
}

interface VerifyAttempt {
  id: string;
  sent_at: Date;
  http_status: number | null;
  apply_state: string;
  generation: string;
}

async function verifyAttempts(pageId: number): Promise<VerifyAttempt[]> {
  return (await testDb!.pool.query<VerifyAttempt>(
    `select id::text, sent_at, http_status, apply_state, request ->> 'credentialsGeneration' as generation
       from sync_attempts where page_id = $1 and resource = 'account.verify' order by id`,
    [pageId],
  )).rows;
}

async function pageRow(pageId: number) {
  return (await testDb!.pool.query<{
    hold_kind: string | null;
    hold_since: Date | null;
    hold_detail: Record<string, unknown>;
    credentials_generation: string | null;
    identity_checked_at: Date | null;
  }>(
    "select hold_kind, hold_since, hold_detail, credentials_generation, identity_checked_at from sync_pages where page_id = $1",
    [pageId],
  )).rows[0]!;
}

describe("credentials holds of a live page (ruling 5, A3)", () => {
  it("A verified, B refused: the hold stays in force although A is trusted, B is never verified again; C's verify runs once under it and its proof clears it", async (context) => {
    if (!testDb) return context.skip();
    const r = await rig("creds-abc", [refusing(new Set(["token-b"]))]);
    const verified = await storedGeneration(r.page);
    const digestB = await storeSession(r.page, "token-b");
    await urgent(r.page.pageId, "u1");
    await startHost(r, 41);

    await until(async () => (await pageRow(r.page.pageId)).hold_kind === "auth", 15_000, "B's refusal");
    const [refusedVerify] = await verifyAttempts(r.page.pageId);
    const held = await pageRow(r.page.pageId);
    // The latest refusal is recorded; the digest the engine trusts is still A.
    expect(held.hold_detail).toMatchObject({
      status: 401,
      credentialsGeneration: digestB,
      failedAttemptId: Number(refusedVerify!.id),
      failedAt: refusedVerify!.sent_at.toISOString(),
    });
    expect(held.credentials_generation).toBe(verified);

    // No 401 loop: the stored digest is the refused one, nothing goes out.
    await new Promise((resolve) => setTimeout(resolve, 6 * S + 1_000));
    expect(r.identityTokens).toEqual(["token-b"]);
    expect(r.server.arrivalsAt("/api/v1/trackinglinks")).toEqual([]);

    // The owner stores C out of band: one verify of C under the hold.
    const digestC = await storeSession(r.page, "token-c");
    await until(async () => r.server.arrivalsAt("/api/v1/trackinglinks").length === 1, 20_000, "the read after C's proof");
    expect(r.identityTokens).toEqual(["token-b", "token-c"]);
    const attempts = await verifyAttempts(r.page.pageId);
    expect(attempts.map((attempt) => [attempt.http_status, attempt.apply_state, attempt.generation]))
      .toEqual([[401, "none", digestB], [200, "applied", digestC]]);
    // The proof, the trusted digest and the clearing were written together,
    // the proof's instant being its send.
    const cleared = await pageRow(r.page.pageId);
    expect(cleared).toMatchObject({ hold_kind: null, hold_since: null, hold_detail: {}, credentials_generation: digestC });
    expect(cleared.identity_checked_at).toEqual(attempts[1]!.sent_at);
    const work = await testDb.pool.query<{ state: string; close_reason: string }>(
      "select state, close_reason from sync_work where page_id = $1 and resource = 'account.verify' order by id", [r.page.pageId],
    );
    expect(work.rows).toEqual([{ state: "done", close_reason: "verified" }]);
    // The durable record: which proof cleared which refusal.
    const audit = await testDb.pool.query<{ metadata: Record<string, unknown> }>(
      "select metadata from audit_events where platform_account_id = $1 and event_type = 'sync.credentials_hold_cleared'", [r.page.pageId],
    );
    expect(audit.rows.map((row) => row.metadata)).toEqual([{
      attemptId: Number(attempts[1]!.id),
      resource: "account.verify",
      sentAt: attempts[1]!.sent_at.toISOString(),
      credentialsGeneration: digestC,
      cleared: {
        kind: "auth",
        since: held.hold_since!.toISOString(),
        failedAttemptId: Number(refusedVerify!.id),
        failedAt: refusedVerify!.sent_at.toISOString(),
        credentialsGeneration: digestB,
      },
    }]);
  }, 90_000);

  it("a crash between the capture and the apply of the verify: the proof is applied from the journal after the restart, no new request; the hold clears only then", async (context) => {
    if (!testDb) return context.skip();
    const r = await rig("creds-crash");
    await holdAuth(r.page, await storedGeneration(r.page));
    await urgent(r.page.pageId, "u1");
    let crashed = false;
    await startHost(r, 42, async (point) => {
      if (point !== "after_capture" || crashed) return;
      const latest = await testDb!.pool.query<{ resource: string }>(
        "select resource from sync_attempts where page_id = $1 order by id desc limit 1", [r.page.pageId],
      );
      if (latest.rows[0]?.resource !== "account.verify") return;
      crashed = true;
      // The answer is captured, the proof not written: still held.
      expect((await pageRow(r.page.pageId)).hold_kind).toBe("auth");
      throw new SyncCrashFault(point);
    });
    await new Promise((resolve) => setTimeout(resolve, 500));
    const digestC = await storeSession(r.page, "token-c");

    await until(async () => r.server.arrivalsAt("/api/v1/trackinglinks").length === 1, 30_000, "the read after the re-applied proof");
    expect(crashed).toBe(true);
    // One /account/me only: the restarted owner applied the journaled answer.
    expect(r.identityTokens).toEqual(["token-c"]);
    const attempts = await verifyAttempts(r.page.pageId);
    expect(attempts.map((attempt) => attempt.apply_state)).toEqual(["applied"]);
    const cleared = await pageRow(r.page.pageId);
    expect(cleared).toMatchObject({ hold_kind: null, credentials_generation: digestC });
  }, 90_000);

  it("a proof write that fails leaves the attempt deferred and the hold in force; the stored answer is applied again, without a request", async (context) => {
    if (!testDb) return context.skip();
    const r = await rig("creds-deferred");
    await holdAuth(r.page, await storedGeneration(r.page));
    await testDb.pool.query(`
      create sequence if not exists sync_test_proof_failures;
      create or replace function sync_test_fail_proof_once() returns trigger language plpgsql as $$
      begin
        if new.identity_checked_at is distinct from old.identity_checked_at
           and nextval('sync_test_proof_failures') = 1 then
          raise exception 'the identity proof write fails once' using errcode = '40001';
        end if;
        return new;
      end $$;
      create trigger sync_test_fail_proof_once before update on sync_pages
        for each row execute function sync_test_fail_proof_once();
    `);
    try {
      await urgent(r.page.pageId, "u1");
      await startHost(r, 43);
      const digestC = await storeSession(r.page, "token-c");
      await until(async () => (await verifyAttempts(r.page.pageId))[0]?.apply_state === "deferred", 15_000, "the deferred proof");
      expect((await pageRow(r.page.pageId)).hold_kind).toBe("auth");

      await until(async () => r.server.arrivalsAt("/api/v1/trackinglinks").length === 1, 20_000, "the read after the re-applied proof");
      expect(r.identityTokens).toEqual(["token-c"]);
      expect((await verifyAttempts(r.page.pageId)).map((attempt) => attempt.apply_state)).toEqual(["applied"]);
      expect(await pageRow(r.page.pageId)).toMatchObject({ hold_kind: null, credentials_generation: digestC });
    } finally {
      await testDb.pool.query(`
        drop trigger if exists sync_test_fail_proof_once on sync_pages;
        drop function if exists sync_test_fail_proof_once();
        drop sequence if exists sync_test_proof_failures;
      `);
    }
  }, 90_000);

  it("the apply of an identity proof holds the page row FOR NO KEY UPDATE from its start: a heartbeat waiting on the row never deadlocks it", async (context) => {
    if (!testDb) return context.skip();
    const r = await rig("creds-locks");
    await holdAuth(r.page, await storedGeneration(r.page));
    await urgent(r.page.pageId, "u1");
    const seen: Array<{ operation: string; shareBlocked: boolean }> = [];
    const heartbeats: Array<Promise<unknown>> = [];
    await startHost(r, 44, async (point) => {
      if (point !== "in_apply") return;
      const applying = await testDb!.pool.query<{ operation: string }>(
        "select operation from sync_attempts where page_id = $1 and apply_state in ('captured', 'deferred') order by id desc limit 1",
        [r.page.pageId],
      );
      const operation = applying.rows[0]?.operation ?? "?";
      let shareBlocked = false;
      try {
        await testDb!.pool.query("select page_id from sync_pages where page_id = $1 for share nowait", [r.page.pageId]);
      } catch (error) {
        shareBlocked = (error as { code?: string }).code === "55P03";
      }
      seen.push({ operation, shareBlocked });
      if (operation === "account.me" && heartbeats.length === 0) {
        // The owner's heartbeat queues on the row while the apply goes on to
        // write the proof on it.
        heartbeats.push(testDb!.pool.query(
          "update sync_pages set owner_heartbeat_at = clock_timestamp() where page_id = $1", [r.page.pageId],
        ));
        await new Promise((resolve) => setTimeout(resolve, 300));
      }
    });
    await new Promise((resolve) => setTimeout(resolve, 500));
    await storeSession(r.page, "token-c");
    await until(async () => seen.some((entry) => entry.operation === "trackinglinks"), 20_000, "the read's apply after the proof");

    await expect(Promise.all(heartbeats)).resolves.toHaveLength(1);
    expect(seen).toContainEqual({ operation: "account.me", shareBlocked: true });
    expect(seen).toContainEqual({ operation: "trackinglinks", shareBlocked: false });
    const [verify] = await verifyAttempts(r.page.pageId);
    expect(verify!.apply_state).toBe("applied");
    const failures = await testDb.pool.query<{ n: number }>(
      "select apply_failures as n from sync_attempts where id = $1", [verify!.id],
    );
    expect(failures.rows[0]!.n).toBe(0);
  }, 90_000);

  it("checks-only is read from the database: a verify closed while the stored digest is still untrusted is raised again", async (context) => {
    if (!testDb) return context.skip();
    const r = await rig("creds-checks-only");
    // The trusted digest is stale and the page's only verify is closed (what
    // a lost in-memory mode and a failed identity write left behind).
    await testDb.pool.query("update sync_pages set credentials_generation = $2 where page_id = $1", [r.page.pageId, "e".repeat(64)]);
    await upsertDemand(db(), { pageId: r.page.pageId, shadow: false, resource: "account.verify", kind: "trigger", class: "urgent" });
    await testDb.pool.query(
      `update sync_work set state = 'done', closed_at = clock_timestamp(), close_reason = 'verified'
        where page_id = $1 and resource = 'account.verify'`,
      [r.page.pageId],
    );
    await urgent(r.page.pageId, "u1");
    await startHost(r, 45);

    await until(async () => r.server.arrivalsAt("/api/v1/trackinglinks").length === 1, 20_000, "the read after the raised verify");
    // The verify went first; nothing else before it.
    expect(r.server.arrivals[0]!.path.split("?")[0]).toBe("/api/v1/account/me");
    const works = await testDb.pool.query<{ state: string; demand: { reasons: string[] } }>(
      "select state, demand from sync_work where page_id = $1 and resource = 'account.verify' order by id", [r.page.pageId],
    );
    expect(works.rows.map((row) => row.state)).toEqual(["done", "done"]);
    expect(works.rows[1]!.demand.reasons).toContain("credentials_changed");
    expect((await getSyncPage(db(), r.page.pageId))!.credentialsGeneration).toBe(await storedGeneration(r.page));
  }, 90_000);
});

describe("the candidate save is a CAS on the pair its check proved (ruling 5)", () => {
  it("a stored half changed after the check stores nothing (409); a check over the unchanged base saves and is trusted", async (context) => {
    if (!testDb) return context.skip();
    const r = await rig("creds-cas");
    const other = await CountingConnectProxy.start();
    proxies.push(other);
    await startHost(r, 46);
    const app = appContext();
    const page = { id: r.page.pageId, label: r.page.pageLabel };
    const storedCiphertext = async () => (await testDb!.pool.query<{ encrypted_session: string }>(
      "select encrypted_session from page_credentials where platform_account_id = $1", [page.id],
    )).rows[0]!.encrypted_session;

    const verified = await checkFanslyIdentityThroughEngine(app, page, { session: session("fresh-token") });
    expect(verified.proof.base).toBe(await storedGeneration(r.page));
    // The proxy changed after the check: the check proved another pair.
    await saveProxy({ config: app.config, db: db() }, page.id, { url: other.url });
    const before = await storedCiphertext();
    const store = async (tx: Database) => {
      await storeFanslySession(tx, page.id, JSON.stringify(encryptJson(session("fresh-token"), HARNESS_ENCRYPTION_KEY, 1)), 1);
    };
    await expect(saveVerifiedFanslyCredentials(app, page, verified, store)).rejects.toBeInstanceOf(FanslyCredentialsChangedError);
    expect(await storedCiphertext()).toBe(before);

    // A new check over the stored pair: stored and trusted together.
    const again = await checkFanslyIdentityThroughEngine(app, page, { session: session("fresh-token") });
    const trusted = await saveVerifiedFanslyCredentials(app, page, again, store);
    expect(trusted).toBe(await storedGeneration(r.page));
    const row = await pageRow(page.id);
    expect(row.credentials_generation).toBe(trusted);
    expect(row.identity_checked_at!.getTime()).toBeGreaterThanOrEqual(again.proof.sentAt.getTime());
    const stored = decryptJsonWithKeyVersion<{ authorization: string }>(await storedCiphertext(), new Map([[1, HARNESS_ENCRYPTION_KEY]]));
    expect(stored.authorization).toBe("fresh-token");
  }, 90_000);

  it("an identity check over another base than its caller read is refused before it is sent", async (context) => {
    if (!testDb) return context.skip();
    const r = await rig("creds-base");
    await startHost(r, 47);
    const config = r.config;
    const waited = await enqueueAndWait({ db: db() }, {
      pageId: r.page.pageId,
      resource: "account.identity",
      params: { candidate: { generation: "c".repeat(64), base: "0".repeat(64), session: true, proxy: false } },
      secretParams: encryptSyncWorkSecret(config, { session: session("fresh-token") }),
      waitMs: 15_000,
      reason: "test",
    });
    expect(waited).toMatchObject({ state: "done", closeReason: "identity_base_changed" });
    expect(r.identityTokens).toEqual([]);
  }, 90_000);
});

describe("the final admission under the page row lock (ruling 5)", () => {
  for (const [kind, hold] of [
    ["network", `hold_kind = 'network', hold_until = clock_timestamp() + interval '1 minute', hold_detail = '{"streak": 3}'`],
    ["auth", `hold_kind = 'auth', hold_until = 'infinity', hold_detail = '{"credentialsGeneration": null}'`],
  ] as const) {
    it(`a ${kind} hold written after the gate looked refuses the request before anything is counted`, async (context) => {
      if (!testDb) return context.skip();
      const { pageId } = await seedSyncPage({ db: db(), pool: testDb.pool }, { mode: "live", guard: "fansly_sync_engine" });
      await upsertDemand(db(), { pageId, shadow: false, resource: CRASH_READ_KEY, kind: "trigger", class: "urgent" });
      const transport = new ScriptedLiveTransport();
      const prepare = transport.prepare.bind(transport);
      let held = false;
      transport.prepare = async (request) => {
        if (!held) {
          held = true;
          await testDb!.pool.query(`update sync_pages set ${hold}, hold_since = clock_timestamp() where page_id = $1`, [pageId]);
        }
        return prepare(request);
      };
      const metrics = new RecordingMetrics();
      const { actor, stop, abort } = await makeTestActor({ db: db(), pageId, mode: "live", registry: crashRegistry(), transport, metrics });
      const run = actor.run({ stop: stop.signal, abort: abort.signal });
      try {
        await waitFor(() => (held ? true : null), 10_000, "the hold written at the prepare");
        await new Promise((resolve) => setTimeout(resolve, 1_000));
        expect(transport.hits).toEqual([]);
        const attempts = await testDb.pool.query("select id from sync_attempts where page_id = $1", [pageId]);
        expect(attempts.rows).toEqual([]);
        const work = await testDb.pool.query<{ state: string }>("select state from sync_work where page_id = $1", [pageId]);
        expect(work.rows).toEqual([{ state: "open" }]);
        expect(metrics.get("sync_admission_page_held")).toBeGreaterThanOrEqual(1);
        // The hold lifted: the read goes out.
        await testDb.pool.query("update sync_pages set hold_kind = null, hold_until = null, hold_since = null, hold_detail = '{}' where page_id = $1", [pageId]);
        await waitFor(() => (transport.hits.length === 1 ? true : null), 10_000, "the read after the hold");
      } finally {
        stop.abort();
        await run;
      }
    }, 60_000);
  }
});
