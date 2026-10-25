import { createHash } from "node:crypto";

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";

import {
  getSyncPage,
  setPageHold,
  setPagePause,
  upsertDemand,
  type Database,
} from "@agency_hub_core/db";

import { SyncCrashFault, type SyncFaultPoint } from "../apps/runtime/src/sync/engine/commit.ts";
import { CREDENTIALS_CHECK_KEYS } from "../apps/runtime/src/sync/engine/errors.ts";
import { SyncEngineHost } from "../apps/runtime/src/sync/engine/host.ts";
import {
  CredentialsGenerationChangedError,
  type PageTransport,
  type SyncMetricLabels,
} from "../apps/runtime/src/sync/engine/ports.ts";
import { resetIntegrationDatabase, startIntegrationTestDatabase, type StartedTestDatabase } from "./helpers/db.ts";
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
  createHarnessTransport,
  ensureHarnessSettingTable,
  FakeChats,
  FakeFanslyServer,
  HARNESS_KEY,
  harnessConfig,
  harnessHostOptions,
  harnessIdentityRegistry,
  harnessRng,
  harnessRoutes,
  seedHarnessPage,
  until,
  type FakeRoute,
  type HarnessPage,
} from "./helpers/sync-engine.ts";
import { clearPageHolds, seedPageHold } from "./helpers/sync-holds.ts";

// The credentials holds of a live page (step 3b ruling 5, A3), end to end:
// a credentials hold records its LATEST refusal and is in force whatever
// digest the engine trusts (A verified, B refused); the verify of B is not
// admitted under it (no 401 loop), the verify of C stored since is — once —
// and its proof clears the hold in the apply's own transaction, which takes
// the page row FOR NO KEY UPDATE from its start (no deadlock with a waiting
// heartbeat). A crash between capture and apply, or a failed proof write,
// applies the stored answer again without a request. Checks-only is read
// from the database; a quarantined verify of credentials no longer stored is
// superseded by the verify of the stored ones (one verify per digest); a hold
// or the owner's pause written after the gate looked refuses at the admission.
//
// The page's session is a token the test sets (the owner's new login in the
// page's browser): the harness transport carries it as `authorization` on
// every request and its digest as the credentials it sends and stores.

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
  /** The session the page's browser holds now. */
  session: { token: string };
}

/** The credentials digest of a session token. */
function digestOf(token: string): string {
  return createHash("sha256").update(`harness-session:${token}`).digest("hex");
}

/**
 * The harness transport under the rig's session: its token on every request,
 * its digest the credentials sent and stored; as the page's live transport,
 * nothing but an identity check goes while that digest is not the verified one.
 */
function sessionTransport(base: PageTransport, pageId: number, session: { token: string }): PageTransport {
  return {
    ...base,
    async prepare(request, context) {
      const built = await base.prepare(request, context);
      const generation = digestOf(session.token);
      if (!CREDENTIALS_CHECK_KEYS.has(context?.work.resource ?? "")) {
        const verified = (await getSyncPage(db(), pageId))?.credentialsGeneration ?? null;
        if (verified !== generation) throw new CredentialsGenerationChangedError(pageId, generation, verified);
      }
      return { ...built, headers: { ...built.headers, authorization: session.token }, credentialsGeneration: generation };
    },
    storedCredentialsGeneration: async () => digestOf(session.token),
  };
}

/** `/account/me` refuses every session whose token is in `refused`. */
function refusing(refused: ReadonlySet<string>): FakeRoute {
  return (request) => (request.url.pathname === "/api/v1/account/me" && refused.has(String(request.headers.authorization ?? ""))
    ? { status: 401, headers: { "content-type": "application/json" }, body: JSON.stringify({ success: false }) }
    : null);
}

/** `/account/me` answers `account` for every session whose token is in `tokens`. */
function answering(tokens: ReadonlySet<string>, account: Record<string, unknown>): FakeRoute {
  return (request) => (request.url.pathname === "/api/v1/account/me" && tokens.has(String(request.headers.authorization ?? ""))
    ? { status: 200, headers: { "content-type": "application/json" }, body: JSON.stringify({ success: true, response: { account } }) }
    : null);
}

/** Another account's session: its `/account/me` is someone else (identity_mismatch). */
const ANOTHER_ACCOUNT = { id: "399999999999999999", username: "someone-else", displayName: null, createdAt: 0, followCount: 0, subscriberCount: 0 };

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
  // The engine verified the session the page starts with.
  const session = { token: "token-a" };
  await testDb!.pool.query("update sync_pages set credentials_generation = $2 where page_id = $1", [page.pageId, digestOf(session.token)]);
  return { server, page, config: harnessConfig(testDb!.connectionString, server.apiBaseUrl), identityTokens, session };
}

async function startHost(r: Rig, seed: number, faults?: (point: SyncFaultPoint) => Promise<void>): Promise<SyncEngineHost> {
  const options = harnessHostOptions({
    db: db(),
    pool: testDb!.pool,
    connectionString: testDb!.connectionString,
    config: r.config,
    rng: harnessRng(seed),
    registry: harnessIdentityRegistry(),
    ...(faults === undefined ? {} : { faults }),
  });
  const host = new SyncEngineHost({
    ...options,
    liveTransportFactory: async (page) => sessionTransport(
      await createHarnessTransport({ db: db(), config: r.config }, r.page),
      page.pageId,
      r.session,
    ),
  });
  hosts.push(host);
  await host.start();
  return host;
}

/** The digest of the session the page's browser holds now. */
function storedGeneration(r: Rig): string {
  return digestOf(r.session.token);
}

/** The owner logs the page's browser in anew (no engine route). */
function storeSession(r: Rig, token: string): string {
  r.session.token = token;
  return storedGeneration(r);
}

/** An auth hold of `failed` that names no refused attempt (as an import
 *  from the legacy engine left one): only a proof sent after it was taken
 *  clears it. */
async function holdAuth(page: HarnessPage, failed: string): Promise<void> {
  await setPageHold(db(), { pageId: page.pageId, kind: "auth", until: "infinity", detail: { status: 401, credentialsGeneration: failed } });
}

async function urgent(pageId: number, subject: string): Promise<void> {
  await upsertDemand(db(), { pageId, resource: HARNESS_KEY.urgent, subject, kind: "trigger", class: "urgent", demand: { reasons: ["test"] } });
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

async function verifyWork(pageId: number): Promise<Array<{ id: number; state: string; close_reason: string | null }>> {
  return (await testDb!.pool.query<{ id: number; state: string; close_reason: string | null }>(
    "select id::int, state, close_reason from sync_work where page_id = $1 and resource = 'account.verify' order by id", [pageId],
  )).rows;
}

async function auditMetadata(pageId: number, eventType: string): Promise<Array<Record<string, unknown>>> {
  return (await testDb!.pool.query<{ metadata: Record<string, unknown> }>(
    "select metadata from audit_events where platform_account_id = $1 and event_type = $2 order by id", [pageId, eventType],
  )).rows.map((row) => row.metadata);
}

/** The page's own hold in its hold set (`sync_holds`: the credentials hold,
 *  else the network hold; nulls without one) and its trusted credentials. */
async function pageRow(pageId: number) {
  return (await testDb!.pool.query<{
    hold: string | null;
    since: Date | null;
    detail: Record<string, unknown> | null;
    credentials_generation: string | null;
    identity_checked_at: Date | null;
  }>(
    `select h.kind as hold, h.since, h.detail, sp.credentials_generation, sp.identity_checked_at
       from sync_pages sp
       left join lateral (
         select kind, since, detail from sync_holds
          where page_id = sp.page_id and scope = 'page'
          order by (kind = 'network'), kind
          limit 1
       ) h on true
      where sp.page_id = $1`,
    [pageId],
  )).rows[0]!;
}

describe("credentials holds of a live page (ruling 5, A3)", () => {
  it("A verified, B refused: the hold stays in force although A is trusted, B is never verified again; C's verify runs once under it and its proof clears it", async (context) => {
    if (!testDb) return context.skip();
    const r = await rig("creds-abc", [refusing(new Set(["token-b"]))]);
    const verified = storedGeneration(r);
    const digestB = storeSession(r, "token-b");
    await urgent(r.page.pageId, "u1");
    await startHost(r, 41);

    await until(async () => (await pageRow(r.page.pageId)).hold === "auth", 15_000, "B's refusal");
    const [refusedVerify] = await verifyAttempts(r.page.pageId);
    const held = await pageRow(r.page.pageId);
    // The latest refusal is recorded; the digest the engine trusts is still A.
    expect(held.detail).toMatchObject({
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

    // The owner logs in C: one verify of C under the hold.
    const digestC = storeSession(r, "token-c");
    await until(async () => r.server.arrivalsAt("/api/v1/trackinglinks").length === 1, 20_000, "the read after C's proof");
    expect(r.identityTokens).toEqual(["token-b", "token-c"]);
    const attempts = await verifyAttempts(r.page.pageId);
    expect(attempts.map((attempt) => [attempt.http_status, attempt.apply_state, attempt.generation]))
      .toEqual([[401, "none", digestB], [200, "applied", digestC]]);
    // The proof, the trusted digest and the clearing were written together,
    // the proof's instant being its send.
    const cleared = await pageRow(r.page.pageId);
    expect(cleared).toMatchObject({ hold: null, since: null, detail: null, credentials_generation: digestC });
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
        since: held.since!.toISOString(),
        failedAttemptId: Number(refusedVerify!.id),
        failedAt: refusedVerify!.sent_at.toISOString(),
        credentialsGeneration: digestB,
      },
    }]);
  }, 90_000);

  it("a crash between the capture and the apply of the verify: the proof is applied from the journal after the restart, no new request; the hold clears only then", async (context) => {
    if (!testDb) return context.skip();
    const r = await rig("creds-crash");
    await holdAuth(r.page, storedGeneration(r));
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
      expect((await pageRow(r.page.pageId)).hold).toBe("auth");
      throw new SyncCrashFault(point);
    });
    await new Promise((resolve) => setTimeout(resolve, 500));
    const digestC = storeSession(r, "token-c");

    await until(async () => r.server.arrivalsAt("/api/v1/trackinglinks").length === 1, 30_000, "the read after the re-applied proof");
    expect(crashed).toBe(true);
    // One /account/me only: the restarted owner applied the journaled answer.
    expect(r.identityTokens).toEqual(["token-c"]);
    const attempts = await verifyAttempts(r.page.pageId);
    expect(attempts.map((attempt) => attempt.apply_state)).toEqual(["applied"]);
    const cleared = await pageRow(r.page.pageId);
    expect(cleared).toMatchObject({ hold: null, credentials_generation: digestC });
  }, 90_000);

  it("B is another account's (identity_mismatch, the verify quarantined); C logged in since supersedes that verify, C's verify runs under the hold and its proof clears it", async (context) => {
    if (!testDb) return context.skip();
    const r = await rig("creds-mismatch-engine", [
      answering(new Set(["token-b"]), ANOTHER_ACCOUNT),
    ]);
    const digestB = storeSession(r, "token-b");
    await urgent(r.page.pageId, "u1");
    await startHost(r, 48);

    await until(async () => (await pageRow(r.page.pageId)).hold === "identity_mismatch", 15_000, "B's identity_mismatch");
    const [mismatch] = await verifyAttempts(r.page.pageId);
    expect((await pageRow(r.page.pageId)).detail).toMatchObject({ credentialsGeneration: digestB, failedAttemptId: Number(mismatch!.id) });
    const [quarantined] = await verifyWork(r.page.pageId);
    expect(quarantined).toMatchObject({ state: "quarantined" });
    // B stays stored: its verify is neither superseded nor sent again.
    await new Promise((resolve) => setTimeout(resolve, 6 * S + 1_000));
    expect(r.identityTokens).toEqual(["token-b"]);
    expect(await verifyWork(r.page.pageId)).toEqual([quarantined]);

    // The owner's renewal: he logs in C — the hold stays until C's own verify.
    const digestC = storeSession(r, "token-c");

    await until(async () => r.server.arrivalsAt("/api/v1/trackinglinks").length === 1, 30_000, "the read after C's proof");
    expect(r.identityTokens).toEqual(["token-b", "token-c"]);
    const attempts = await verifyAttempts(r.page.pageId);
    expect(attempts.map((attempt) => [attempt.apply_state, attempt.generation])).toEqual([["quarantined", digestB], ["applied", digestC]]);
    expect(await verifyWork(r.page.pageId)).toEqual([
      { id: quarantined!.id, state: "superseded", close_reason: "credentials_changed" },
      { id: expect.any(Number), state: "done", close_reason: "verified" },
    ]);
    expect(await pageRow(r.page.pageId)).toMatchObject({ hold: null, credentials_generation: digestC });
    expect(await auditMetadata(r.page.pageId, "sync.credentials_verify_superseded")).toEqual([{
      workId: quarantined!.id,
      attemptId: Number(mismatch!.id),
      quarantine: "identity_mismatch",
      credentialsGeneration: digestB,
      storedCredentialsGeneration: digestC,
    }]);
    expect(await auditMetadata(r.page.pageId, "sync.credentials_hold_cleared")).toEqual([expect.objectContaining({
      attemptId: Number(attempts[1]!.id),
      credentialsGeneration: digestC,
      cleared: expect.objectContaining({ kind: "identity_mismatch", failedAttemptId: Number(mismatch!.id), credentialsGeneration: digestB }),
    })]);
  }, 90_000);
});

describe("the final admission under the page row lock (ruling 5)", () => {
  for (const [kind, hold] of [
    ["auth", { untilSeconds: "infinity", detail: { credentialsGeneration: null } }],
  ] as const) {
    it(`a ${kind} hold written after the gate looked refuses the request before anything is counted`, async (context) => {
      if (!testDb) return context.skip();
      const { pageId } = await seedSyncPage({ db: db(), pool: testDb.pool }, { mode: "live", guard: "fansly_sync_engine" });
      await upsertDemand(db(), { pageId, resource: CRASH_READ_KEY, kind: "trigger", class: "urgent" });
      const transport = new ScriptedLiveTransport();
      const prepare = transport.prepare.bind(transport);
      let held = false;
      transport.prepare = async (request) => {
        if (!held) {
          held = true;
          await seedPageHold(testDb!, { pageId, kind, ...hold });
        }
        return prepare(request);
      };
      const metrics = new RecordingMetrics();
      const { actor, stop, abort } = await makeTestActor({ db: db(), pageId, registry: crashRegistry(), transport, metrics });
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
        await clearPageHolds(testDb, pageId);
        await waitFor(() => (transport.hits.length === 1 ? true : null), 10_000, "the read after the hold");
      } finally {
        stop.abort();
        await run;
      }
    }, 60_000);
  }

  it("the owner's pause committed after the gate and the pick looked admits nothing more", async (context) => {
    if (!testDb) return context.skip();
    const { pageId } = await seedSyncPage({ db: db(), pool: testDb.pool }, { mode: "live", guard: "fansly_sync_engine" });
    await upsertDemand(db(), { pageId, resource: CRASH_READ_KEY, kind: "trigger", class: "urgent" });
    const transport = new ScriptedLiveTransport();
    const prepare = transport.prepare.bind(transport);
    // The interleaving, driven: the gate and the pick saw the page unpaused;
    // the owner's pause (the lever itself) commits between them and the
    // admission — at the transport's build of the picked request.
    let paused = false;
    transport.prepare = async (request) => {
      if (!paused) {
        paused = true;
        await setPagePause(db(), { pageId, all: true, note: "owner pause" });
      }
      return prepare(request);
    };
    const metrics = new LabelledMetrics();
    const { actor, stop, abort } = await makeTestActor({ db: db(), pageId, registry: crashRegistry(), transport, metrics });
    const run = actor.run({ stop: stop.signal, abort: abort.signal });
    try {
      // Whichever comes first: the admission refused, or the request out.
      await waitFor(
        () => (metrics.get("sync_admission_page_held") > 0 || transport.hits.length > 0 ? true : null),
        10_000,
        "the admission after the pause",
      );
      expect(transport.hits).toEqual([]);
      expect(metrics.labelsOf("sync_admission_page_held")).toEqual([{ pageId, kind: "paused" }]);
      const attempts = await testDb.pool.query("select id from sync_attempts where page_id = $1", [pageId]);
      expect(attempts.rows).toEqual([]);
      const work = await testDb.pool.query<{ state: string }>("select state from sync_work where page_id = $1", [pageId]);
      expect(work.rows).toEqual([{ state: "open" }]);
      // The resume: the same work goes out, once.
      await setPagePause(db(), { pageId, all: false });
      await waitFor(() => (transport.hits.length === 1 ? true : null), 10_000, "the read after the resume");
    } finally {
      stop.abort();
      await run;
    }
  }, 60_000);
});

/** The metrics with each increment's labels. */
class LabelledMetrics extends RecordingMetrics {
  readonly labelled: Array<{ name: string; labels: SyncMetricLabels | undefined }> = [];
  override increment(name: string, labels?: SyncMetricLabels, by = 1): void {
    this.labelled.push({ name, labels });
    super.increment(name, labels, by);
  }
  labelsOf(name: string): Array<SyncMetricLabels | undefined> {
    return this.labelled.filter((entry) => entry.name === name).map((entry) => entry.labels);
  }
}
