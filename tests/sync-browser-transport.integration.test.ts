import { randomUUID } from "node:crypto";

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { getSyncPage, insertPageBrowser, storeProxyConfig, type Database } from "@agency_hub_core/db";
import type { AppConfig } from "@agency_hub_core/shared";

import { readPageBrowserLinkRevision, readPageBrowserLinkSettings, sealPageBrowserSecrets } from "../apps/runtime/src/services/egress/page-browser-link.ts";
import { PageBrowserRpcClient, type PageBrowserRpcTiming } from "../apps/runtime/src/services/egress/page-browser-rpc.ts";
import { createEngineRegistry, type ResourceModule } from "../apps/runtime/src/sync/engine/resource.ts";
import type { PageTransport } from "../apps/runtime/src/sync/engine/ports.ts";
import { createBrowserPageTransport, readBrowserCredentialsGeneration, SEND_REPORT_GUARD_MS } from "../apps/runtime/src/sync/fansly/browser-transport.ts";
import { fanslyResourceSpec } from "../apps/runtime/src/sync/fansly/registry.ts";
import { resetIntegrationDatabase, startIntegrationTestDatabase, type StartedTestDatabase } from "./helpers/db.ts";
import { FakeOperator, OPERATOR_TOKEN, SESSION_A, SESSION_B } from "./helpers/page-browser-operator.ts";
import { HARNESS_OWN_REF, harnessConfig, runActorUntil, seedHarnessPage, until, type HarnessPage } from "./helpers/sync-engine.ts";
import { countRows, makeTestActor, testSpec } from "./helpers/sync-engine-host.ts";

// The engine's browser transport (Project Browser plan §3.2, §4.2; stage 3
// PR 12, row 12's checks) on a live page's actor against a fake operator —
// the operator's own RPC server, with a scripted browser behind it (one
// physical request per admitted operation, logged as the origin's arrival
// log):
// - one physical request per admission (a second check of one operation is
//   refused);
// - the pause runs from the send instant the browser reported, not from the
//   grant (`transport_reported` in the journal);
// - a session that changed between prepare and send lets nothing go, on the
//   engine's side and on the operator's, and the new session is verified
//   before any other work;
// - after the identity proof the page leaves checks-only; a new session or a
//   new proxy (a new hello) asks for the proof again;
// - the operator out of reach admits nothing and holds nothing; a result
//   that comes again after a lost link is taken, and acknowledged after its
//   commit.

const READ_KEY = "browser.read";
const PROXY = "socks5://127.0.0.1:1080";
const TIMING: Partial<PageBrowserRpcTiming> = { pingMs: 100, linkLossMs: 1_000, helloTimeoutMs: 1_000, reconnectMs: [50, 100], refusedRetryMs: 500 };

let testDb: StartedTestDatabase | null = null;
const cleanups: Array<() => Promise<void> | void> = [];

beforeAll(async () => {
  testDb = await startIntegrationTestDatabase();
}, 120_000);

afterAll(async () => {
  await testDb?.stop();
});

beforeEach(async () => {
  if (testDb) await resetIntegrationDatabase(testDb.pool);
});

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

function db(): Database {
  return testDb!.db as unknown as Database;
}

function config(): AppConfig {
  return harnessConfig(testDb!.connectionString, "https://apiv3.fansly.invalid/api/v1");
}

/** A standing read of `/polls`, due again 20 ms after each one, and the
 *  production identity verify. */
function registry() {
  const poll: ResourceModule = {
    plan: async () => ({ kind: "request", request: { spec: "polls", params: {} } }),
    apply: async () => ({ work: { satisfiesRevision: true }, followups: [] }),
  };
  return createEngineRegistry([
    testSpec(READ_KEY, poll, { kind: "poll", class: "planned", period: { everyMs: 20 } }),
    fanslyResourceSpec("account.verify")!,
  ]);
}

interface Rig {
  page: HarnessPage;
  operator: FakeOperator;
  transport: PageTransport;
  client: PageBrowserRpcClient;
}

async function rig(options: { verified?: boolean; settingMs?: number; startOperator?: boolean } = {}): Promise<Rig> {
  const operator = await FakeOperator.start({ accountId: HARNESS_OWN_REF });
  cleanups.push(() => operator.close());
  const label = `browser-${randomUUID().slice(0, 8)}`;
  const page = await seedHarnessPage({ db: db(), pool: testDb!.pool }, { mode: "live", proxyUrl: PROXY, label });
  await insertPageBrowser(db(), {
    profileId: randomUUID(),
    container: `page-browser-${label}`,
    pageId: page.pageId,
    ...sealPageBrowserSecrets(config(), { engineToken: OPERATOR_TOKEN, apiToken: "api-token", vncPassword: "vnc-password" }),
  });
  const verified = options.verified === false ? null : await readBrowserCredentialsGeneration(db(), page.pageId, SESSION_A);
  await testDb!.pool.query("update sync_pages set credentials_generation = $2 where page_id = $1", [page.pageId, verified]);
  const pageSettings = {
    pinnedExitIp: "203.0.113.7",
    env: { timeZone: "Europe/Berlin", languages: ["en-US", "en"], geolocation: { latitude: 52.5, longitude: 13.4, accuracyM: 50 } },
  };
  const client = new PageBrowserRpcClient({
    url: operator.url,
    // A fresh page: the actor's acquisition is its first generation.
    ownerGeneration: 1n,
    settings: () => readPageBrowserLinkSettings({ db: db(), config: config() }, page.pageId, pageSettings),
    revision: () => readPageBrowserLinkRevision({ db: db() }, page.pageId, pageSettings),
    timing: TIMING,
  });
  const transport = await createBrowserPageTransport({ db: db(), config: config() }, { pageId: page.pageId }, {
    client,
    timing: { unavailableRetryMs: 200, resultWaitMs: 5_000 },
  });
  cleanups.push(() => transport.close());
  await until(async () => client.up, 5_000, "the link to the operator");
  return { page, operator, transport, client };
}

async function actor(r: Rig, settingMs = 60) {
  const made = await makeTestActor({ db: db(), pageId: r.page.pageId, registry: registry(), transport: r.transport, settingMs, ownRef: HARNESS_OWN_REF });
  expect(made.generation).toBe(1n);
  return made;
}

interface AttemptRow {
  id: number;
  resource: string;
  outcome: string;
  sendMark: string | null;
  errorClass: string | null;
  gapPrevMs: number | null;
  sentAt: Date | null;
  generation: string | null;
}

async function attempts(pageId: number): Promise<AttemptRow[]> {
  const result = await testDb!.pool.query<AttemptRow>(
    `select id::int, resource, outcome, send_mark as "sendMark", error_class as "errorClass", gap_prev_ms as "gapPrevMs",
            sent_at as "sentAt", request->>'credentialsGeneration' as generation
       from sync_attempts where page_id = $1 order by id`,
    [pageId],
  );
  return result.rows;
}

const isVerify = (url: string) => new URL(url).pathname.endsWith("/account/me");

describe("one physical request per admission", () => {
  it("every request is checked once, granted once and leaves once, under its own attempt", async (context) => {
    if (!testDb) return context.skip();
    const r = await rig();
    const made = await actor(r);
    await runActorUntil(made, async () => r.operator.physical.length >= 5, 20_000, "five requests");
    const rows = (await attempts(r.page.pageId)).filter((row) => row.outcome === "response");
    const physicalIds = r.operator.physical.map((request) => request.attemptId);
    expect(new Set(physicalIds).size).toBe(physicalIds.length);
    for (const id of physicalIds) {
      expect(r.operator.checkResults.filter((result) => result.attemptId === id && result.admit)).toHaveLength(1);
    }
    expect(rows.map((row) => row.id)).toEqual(expect.arrayContaining(physicalIds.slice(0, rows.length)));
    expect(rows.every((row) => row.sendMark === "transport_reported")).toBe(true);
    // Every response committed was acknowledged to the operator.
    await until(async () => rows.every((row) => r.operator.acks.includes(row.id)), 5_000, "the acks");
  }, 60_000);

  it("a second check of one operation is refused (lease_used): still one physical request", async (context) => {
    if (!testDb) return context.skip();
    const r = await rig();
    r.operator.checkTwice = true;
    const made = await actor(r);
    await runActorUntil(made, async () => r.operator.physical.length >= 3, 20_000, "three requests");
    for (const request of r.operator.physical) {
      const answers = r.operator.checkResults.filter((result) => result.attemptId === request.attemptId);
      expect(answers.filter((answer) => answer.admit)).toHaveLength(1);
      expect(answers.filter((answer) => !answer.admit && answer.reason === "lease_used")).toHaveLength(1);
    }
    expect(new Set(r.operator.physical.map((request) => request.attemptId)).size).toBe(r.operator.physical.length);
  }, 60_000);
});

describe("the pause runs from the send the browser reported", () => {
  it("the next check comes a full pause after the reported send, not after the grant; the journal says transport_reported", async (context) => {
    if (!testDb) return context.skip();
    const settingMs = 150;
    const r = await rig();
    // The browser sends 400 ms after the grant (its connection, its preflight).
    r.operator.sendDelayMs = 400;
    const made = await actor(r, settingMs);
    await runActorUntil(made, async () => r.operator.physical.length >= 4, 30_000, "four requests");
    const physical = r.operator.physical;
    for (let i = 1; i < physical.length; i++) {
      // The next admission waited for the pause from the reported send: the
      // operator's next check came no earlier than that.
      expect(physical[i]!.checkedMono - physical[i - 1]!.sentMono).toBeGreaterThanOrEqual(settingMs);
      expect(physical[i]!.sentMono - physical[i - 1]!.sentMono).toBeGreaterThanOrEqual(settingMs + 400);
    }
    const rows = (await attempts(r.page.pageId)).filter((row) => row.outcome === "response");
    expect(rows.length).toBeGreaterThanOrEqual(3);
    expect(rows.every((row) => row.sendMark === "transport_reported")).toBe(true);
    // The journal's gap is the reported sends' (the guard adds its 1 ms).
    const byId = new Map(physical.map((request) => [request.attemptId, request]));
    for (let i = 1; i < rows.length; i++) {
      const previous = byId.get(rows[i - 1]!.id);
      const current = byId.get(rows[i]!.id);
      if (previous === undefined || current === undefined) continue;
      expect(rows[i]!.gapPrevMs).toBeCloseTo(current.sentMono - previous.sentMono, -1);
      expect(rows[i]!.gapPrevMs!).toBeGreaterThanOrEqual(settingMs + 400 - SEND_REPORT_GUARD_MS);
    }
  }, 60_000);

  it("without a reported instant the completion is the send (completion_fallback)", async (context) => {
    if (!testDb) return context.skip();
    const r = await rig();
    r.operator.reportSend = false;
    const made = await actor(r);
    await runActorUntil(made, async () => r.operator.physical.length >= 2, 20_000, "two requests");
    const rows = (await attempts(r.page.pageId)).filter((row) => row.outcome === "response");
    expect(rows.length).toBeGreaterThanOrEqual(1);
    expect(rows.every((row) => row.sendMark === "completion_fallback")).toBe(true);
  }, 60_000);
});

describe("a session change between prepare and send", () => {
  it("the engine refuses the check of another session: nothing leaves, and the new session is verified before any other work", async (context) => {
    if (!testDb) return context.skip();
    const r = await rig();
    const made = await actor(r);
    // The site's session changes as the first request reaches the browser;
    // the operator (lagging) still asks — with the live, new session.
    r.operator.skipSessionCheckAtSend = true;
    let switched: number | null = null;
    r.operator.onSendHook = (send) => {
      if (switched !== null) return;
      switched = send.attemptId;
      r.operator.live = SESSION_B;
    };
    await runActorUntil(made, async () => {
      if (switched !== null && r.operator.state.sessionFingerprint !== SESSION_B) r.operator.setSession(SESSION_B);
      return r.operator.physical.some((request) => !isVerify(request.url) && request.session === SESSION_B);
    }, 30_000, "the work under the verified new session");
    expect(switched).not.toBeNull();
    expect(r.operator.checkResults.find((result) => result.attemptId === switched)).toMatchObject({ admit: false, reason: "session_mismatch" });
    expect(r.operator.physical.some((request) => request.attemptId === switched)).toBe(false);
    const rows = await attempts(r.page.pageId);
    expect(rows.find((row) => row.id === switched)).toMatchObject({ outcome: "aborted_before_send", errorClass: "not_sent:session_mismatch" });
    // Under the new session the first request out was the identity proof.
    const underB = r.operator.physical.filter((request) => request.session === SESSION_B);
    expect(isVerify(underB[0]!.url)).toBe(true);
    const verifiedB = await readBrowserCredentialsGeneration(db(), r.page.pageId, SESSION_B);
    expect((await getSyncPage(db(), r.page.pageId))!.credentialsGeneration).toBe(verifiedB);
  }, 60_000);

  it("a session that changes after the grant, before the release: the operator does not let it go", async (context) => {
    if (!testDb) return context.skip();
    const r = await rig();
    let changed: number | null = null;
    r.operator.beforeRelease = (send) => {
      if (changed !== null) return;
      changed = send.attemptId;
      r.operator.setSession(SESSION_B);
    };
    const made = await actor(r);
    await runActorUntil(made, async () => r.operator.physical.some((request) => isVerify(request.url) && request.session === SESSION_B), 30_000, "the verify of the new session");
    expect(r.operator.checkResults.find((result) => result.attemptId === changed)).toMatchObject({ admit: true });
    expect(r.operator.physical.some((request) => request.attemptId === changed)).toBe(false);
    const rows = await attempts(r.page.pageId);
    expect(rows.find((row) => row.id === changed)).toMatchObject({ outcome: "aborted_before_send", errorClass: "not_sent:session_mismatch", sendMark: null });
  }, 60_000);
});

describe("the identity proof and checks-only", () => {
  it("after the proof the page leaves checks-only; a new session, then a new proxy, asks for it again", async (context) => {
    if (!testDb) return context.skip();
    const r = await rig({ verified: false });
    const made = await actor(r);
    const run = made.actor.run({ stop: made.stop.signal, abort: made.abort.signal });
    try {
      // Checks-only: the first request out is the verify; then the work.
      await until(async () => r.operator.physical.some((request) => !isVerify(request.url)), 20_000, "the work after the first proof");
      expect(isVerify(r.operator.physical[0]!.url)).toBe(true);
      const proofA = await readBrowserCredentialsGeneration(db(), r.page.pageId, SESSION_A);
      expect((await getSyncPage(db(), r.page.pageId))!.credentialsGeneration).toBe(proofA);

      // The owner logs in anew: a new session fingerprint, a new generation.
      const beforeB = r.operator.physical.length;
      r.operator.setSession(SESSION_B);
      await until(async () => r.operator.physical.slice(beforeB).some((request) => !isVerify(request.url) && request.session === SESSION_B), 20_000, "the work under the new session");
      const afterB = r.operator.physical.slice(beforeB).filter((request) => request.session === SESSION_B);
      expect(isVerify(afterB[0]!.url)).toBe(true);
      const proofB = await readBrowserCredentialsGeneration(db(), r.page.pageId, SESSION_B);
      expect(proofB).not.toBe(proofA);
      expect((await getSyncPage(db(), r.page.pageId))!.credentialsGeneration).toBe(proofB);

      // The proxy changes: the link says hello again with it, and the proof
      // runs again before the work.
      const beforeProxy = r.operator.physical.length;
      await storeProxyConfig(db(), r.page.pageId, { url: "socks5://127.0.0.2:1081", encryptedAuth: null, keyVersion: null });
      await until(async () => r.operator.hellos.length >= 2, 20_000, "the hello with the new proxy");
      expect(r.operator.hellos.at(-1)!.socks5).toMatchObject({ ip: "127.0.0.2", port: 1081 });
      await until(async () => r.operator.physical.slice(beforeProxy).some((request) => !isVerify(request.url)), 20_000, "the work through the new proxy");
      const afterProxy = r.operator.physical.slice(beforeProxy);
      expect(isVerify(afterProxy[0]!.url)).toBe(true);
      const proofProxy = await readBrowserCredentialsGeneration(db(), r.page.pageId, SESSION_B);
      expect(proofProxy).not.toBe(proofB);
      expect((await getSyncPage(db(), r.page.pageId))!.credentialsGeneration).toBe(proofProxy);
      // Every verify carried the generation it proved.
      const verifies = (await attempts(r.page.pageId)).filter((row) => row.resource === "account.verify" && row.outcome === "response");
      expect(verifies.map((row) => row.generation)).toEqual(expect.arrayContaining([proofA, proofB, proofProxy]));
    } finally {
      made.stop.abort();
      await run;
    }
  }, 90_000);
});

describe("the transport on its own", () => {
  const pollsPlan = { spec: "polls" as const, params: {} };
  const grantingHooks = (onGrant: () => void = () => undefined) => ({
    check: () => {
      throw new Error("a browser request is granted, never checked at a write");
    },
    grant: () => {
      onGrant();
      return null;
    },
  });

  it("prepares without Chrome's or the session's headers, under the browser's generation; an admission of another owner goes nowhere", async (context) => {
    if (!testDb) return context.skip();
    const r = await rig();
    const request = await r.transport.prepare(pollsPlan);
    expect(request.headers).toEqual({});
    expect(request.url).toBe("https://apiv3.fansly.invalid/api/v1/polls?ngsw-bypass=true");
    expect(request.credentialsGeneration).toBe(await readBrowserCredentialsGeneration(db(), r.page.pageId, SESSION_A));
    expect(await r.transport.storedCredentialsGeneration!()).toBe(request.credentialsGeneration);
    const now = performance.now();
    const outcome = await r.transport.send(request, grantingHooks(), new AbortController().signal, {
      attemptId: 901, ownerGeneration: 2n, issuedMono: now, sendDeadlineMono: now + 15_000,
    });
    expect(outcome).toEqual({ kind: "aborted_before_send", refusal: "generation_stale" });
    expect(r.operator.sends).toEqual([]);
  }, 60_000);

  it("sends the admission's absolute deadline on CLOCK_MONOTONIC and the session it was prepared for", async (context) => {
    if (!testDb) return context.skip();
    const r = await rig();
    const request = await r.transport.prepare(pollsPlan);
    const now = performance.now();
    let grants = 0;
    const outcome = await r.transport.send(request, grantingHooks(() => (grants += 1)), new AbortController().signal, {
      attemptId: 902, ownerGeneration: 1n, issuedMono: now, sendDeadlineMono: now + 15_000,
    });
    expect(outcome).toMatchObject({ kind: "response", status: 200, sendMark: "transport_reported" });
    expect(grants).toBe(1);
    const send = r.operator.sends[0]!;
    expect(send).toMatchObject({ attemptId: 902, ownerGeneration: 1, sessionFingerprint: SESSION_A, kind: "api", method: "GET", headers: {} });
    const kernelNow = Number(process.hrtime.bigint()) / 1e6;
    // The deadline is absolute on the kernel's clock: about 15 s after the
    // issue, whatever the engine's clock reads.
    expect(Math.abs(send.sendDeadlineMono - (kernelNow + (now + 15_000 - performance.now())))).toBeLessThan(1_000);
    expect(r.operator.checkResults[0]).toMatchObject({ admit: true, deadlineMono: send.sendDeadlineMono });
    expect(send.requestDeadlineMono).toBeGreaterThanOrEqual(send.sendDeadlineMono);
    // The outcome is acknowledged only once the engine says it committed it.
    expect(r.operator.acks).toEqual([]);
    r.transport.settled!(902);
    await until(async () => r.operator.acks.includes(902), 5_000, "the ack");
  }, 60_000);

  it("a granted request whose link ends for good may have gone: a transport error, sent, at once", async (context) => {
    if (!testDb) return context.skip();
    const r = await rig();
    r.operator.deliverResults = false;
    const request = await r.transport.prepare(pollsPlan);
    const now = performance.now();
    const sending = r.transport.send(request, grantingHooks(), new AbortController().signal, {
      attemptId: 903, ownerGeneration: 1n, issuedMono: now, sendDeadlineMono: now + 15_000,
    });
    await until(async () => r.operator.physical.length === 1, 5_000, "the request out");
    await r.client.close();
    expect(await sending).toMatchObject({ kind: "transport_error", sent: true });
  }, 60_000);
});

describe("the operator out of reach", () => {
  it("no link: nothing is admitted and nothing holds the page", async (context) => {
    if (!testDb) return context.skip();
    const r = await rig();
    await r.operator.close();
    await until(async () => !r.client.up, 5_000, "the link down");
    const made = await actor(r);
    const run = made.actor.run({ stop: made.stop.signal, abort: made.abort.signal });
    await new Promise((resolve) => setTimeout(resolve, 1_500));
    made.stop.abort();
    await run;
    expect(await countRows(testDb.pool, "select count(*)::int as n from sync_attempts where page_id = $1", [r.page.pageId])).toBe(0);
    const page = (await getSyncPage(db(), r.page.pageId))!;
    expect(page.networkFailureStreak).toBe(0);
    expect(await countRows(testDb.pool, "select count(*)::int as n from sync_holds where page_id = $1", [r.page.pageId])).toBe(0);
  }, 60_000);

  it("a request the browser could not take at all is not sent and holds nothing (transport_unavailable)", async (context) => {
    if (!testDb) return context.skip();
    const r = await rig();
    // The site's session is gone in the browser: the operator takes no send.
    r.operator.live = null;
    const made = await actor(r);
    await runActorUntil(made, async () => (await attempts(r.page.pageId)).length >= 1, 20_000, "an attempt");
    const rows = await attempts(r.page.pageId);
    expect(rows[0]).toMatchObject({ outcome: "aborted_before_send", errorClass: "not_sent:transport_unavailable", sentAt: null });
    expect(r.operator.physical).toEqual([]);
    expect((await getSyncPage(db(), r.page.pageId))!.networkFailureStreak).toBe(0);
  }, 60_000);

  it("a link lost after the grant: the result comes again to the next connection, is taken and acknowledged after its commit", async (context) => {
    if (!testDb) return context.skip();
    const r = await rig();
    r.operator.deliverResults = false;
    const made = await actor(r);
    const run = made.actor.run({ stop: made.stop.signal, abort: made.abort.signal });
    try {
      await until(async () => r.operator.physical.length >= 1 && r.operator.held.size >= 1, 20_000, "a request out, its result kept");
      const attemptId = r.operator.physical[0]!.attemptId;
      r.operator.deliverResults = true;
      r.operator.server.protocolError("a test drops the engine after the grant");
      await until(async () => r.operator.acks.includes(attemptId), 20_000, "the ack of the replayed result");
      const row = (await attempts(r.page.pageId)).find((attempt) => attempt.id === attemptId);
      expect(row).toMatchObject({ outcome: "response", sendMark: "transport_reported" });
      expect(r.operator.hellos.length).toBeGreaterThanOrEqual(2);
    } finally {
      made.stop.abort();
      await run;
    }
  }, 60_000);
});
