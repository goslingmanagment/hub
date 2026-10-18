// The rig of the page transport switch tests (tests/sync-transport-switch*.integration.test.ts):
// split out of one file so the CI shards can spread its tests.
// The transport switch of a page (Project Browser plan §3.2 «Выбор транспорта
// страницы», «Переключение транспорта страницы и откат», §4.7, owner
// decision №12; stage 3 PR 14, row 14's checks) on a real host: the page's
// Node transport over a fake Fansly origin behind a CONNECT proxy, its
// browser a fake operator (the operator's own RPC server).
// - Both ways with a request in flight: the request finishes and is
//   committed by the owner that admitted it; no admission of the transport
//   the page left commits after the switch, and nothing is sent through it
//   once its slot ended; the new transport's first send is ≥ 1.2 × S after
//   the last send of the old one (S at least the owner's 2 s minimum).
// - A page that leaves its browser has its operator stop it; a page on Node
//   never links to its browser.
// - The rollback of a page connected through its browser, its Chrome down
//   and no Node session stored: prepare (a credentials hold that admits only
//   a candidate check), the identity check through Node by the session the
//   owner sends, its storing and trusting in one transaction (a CAS: a base
//   moved in between stores nothing), then the verify lifts the hold and the
//   page works on Node.

import { randomUUID } from "node:crypto";
import { setTimeout as sleep } from "node:timers/promises";

import { afterAll, afterEach, beforeAll, beforeEach, expect } from "vitest";

import {
  confirmSyncOwnersStopped,
  insertPageBrowser,
  setPageBrowserSettings,
  setSyncPageTransport,
  type Database,
} from "@agency_hub_core/db";

import { readFanslyPageGeneration } from "../../apps/runtime/src/services/egress/fansly-probe-context.ts";
import { sealPageBrowserSecrets } from "../../apps/runtime/src/services/egress/page-browser-link.ts";
import { SyncCrashFault } from "../../apps/runtime/src/sync/engine/commit.ts";
import { SyncEngineHost } from "../../apps/runtime/src/sync/engine/host.ts";
import type { StallTracking } from "../../apps/runtime/src/sync/engine/watchdog.ts";
import { openBrowserPage, type BrowserPage } from "../../apps/runtime/src/sync/fansly/browser-page.ts";
import { readBrowserCredentialsGeneration } from "../../apps/runtime/src/sync/fansly/browser-transport.ts";
import { changeSyncPageTransport, SYNC_PAGE_TRANSPORT_AUDIT_EVENT } from "../../apps/runtime/src/sync/page-transport.ts";
import { resetIntegrationDatabase, startIntegrationTestDatabase, type StartedTestDatabase } from "./db.ts";
import { FakeOperator, linkSettings, OPERATOR_TOKEN, SESSION_A } from "./page-browser-operator.ts";
import { makeTestActor, quietLogger, RecordingMetrics } from "./sync-engine-host.ts";
import {
  CountingConnectProxy,
  ensureHarnessSettingTable,
  FakeChats,
  FakeFanslyServer,
  HARNESS_OWN_REF,
  harnessConfig,
  harnessHostOptions,
  harnessIdentityRegistry,
  harnessRng,
  harnessRoutes,
  seedHarnessPage,
  type FakeRoute,
  type HarnessPage,
} from "./sync-engine.ts";

export const S = 300;
/** The takeover floor's setting: S, at least the owner's minimum (I4). */
export const FLOOR_S = 2_000;
export const ENV = { timeZone: "Europe/Berlin", languages: ["en-US", "en"], geolocation: { latitude: 52.5, longitude: 13.4, accuracyM: 50 } };
export const RPC_TIMING = { pingMs: 100, linkLossMs: 1_000, helloTimeoutMs: 1_000, reconnectMs: [50, 100], refusedRetryMs: 500 };

export let testDb: StartedTestDatabase | null = null;
export const cleanups: Array<() => Promise<void> | void> = [];

export function db(): Database {
  return testDb!.db as unknown as Database;
}

export function session(token: string) {
  return { authorization: token, fanslyClientId: "client-id", fanslyClientCheck: "client-check", fanslySessionId: "session-id" };
}

export interface Rig {
  server: FakeFanslyServer;
  proxy: CountingConnectProxy;
  operator: FakeOperator;
  page: HarnessPage;
  profileId: string;
  config: ReturnType<typeof harnessConfig>;
  /** The authorization of every `/account/me` at the origin, in order. */
  identityTokens: string[];
}

export async function rig(options: { first?: FakeRoute[]; session?: string | null } = {}): Promise<Rig> {
  const server = await FakeFanslyServer.start();
  const proxy = await CountingConnectProxy.start();
  const operator = await FakeOperator.start({ accountId: HARNESS_OWN_REF, ...(options.session === undefined ? {} : { session: options.session }) });
  cleanups.push(async () => {
    await server.close();
    await proxy.close();
    await operator.close();
  });
  // Its state every 100 ms, as the real operator every 5 s.
  operator.startStatePushes(100);
  const identityTokens: string[] = [];
  server.route((request) => {
    if (request.url.pathname === "/api/v1/account/me") identityTokens.push(String(request.headers.authorization ?? ""));
    return null;
  });
  for (const route of options.first ?? []) server.route(route);
  for (const route of harnessRoutes(new FakeChats())) server.route(route);
  const label = `switch-${randomUUID().slice(0, 8)}`;
  const page = await seedHarnessPage({ db: db(), pool: testDb!.pool }, { mode: "live", proxyUrl: proxy.url, label });
  const config = harnessConfig(testDb!.connectionString, server.apiBaseUrl);
  const profileId = randomUUID();
  await insertPageBrowser(db(), {
    profileId,
    container: `page-browser-${label}`,
    pageId: page.pageId,
    ...sealPageBrowserSecrets(config, { engineToken: OPERATOR_TOKEN, apiToken: "api-token", vncPassword: "vnc-password" }),
  });
  await setPageBrowserSettings(db(), { profileId, pinnedExitIp: "203.0.113.7", env: ENV });
  return { server, proxy, operator, page, profileId, config, identityTokens };
}

export async function startHost(r: Rig, extra: { watchdog?: StallTracking } = {}): Promise<SyncEngineHost> {
  const host = new SyncEngineHost({
    ...harnessHostOptions({
      db: db(),
      pool: testDb!.pool,
      connectionString: testDb!.connectionString,
      config: r.config,
      rng: harnessRng(11),
      registry: harnessIdentityRegistry(),
    }),
    ...(extra.watchdog === undefined ? {} : { watchdog: extra.watchdog }),
    browserOverrides: {
      url: () => r.operator.url,
      // The harness proxy is a CONNECT one: the hello's SOCKS5 is the fake's.
      settings: async (pageId) => linkSettings({ pageId, expectedAccountId: HARNESS_OWN_REF }),
      rpcTiming: RPC_TIMING,
      transportTiming: { unavailableRetryMs: 100, resultWaitMs: 10_000 },
      leaveWaitMs: 5_000,
    },
  });
  cleanups.push(() => host.stop());
  await host.start();
  return host;
}

export interface AttemptRow {
  id: number;
  generation: string;
  resource: string | null;
  origin: string;
  outcome: string;
  sendMark: string | null;
  admittedAt: Date;
  sentAt: Date | null;
}

export async function attempts(pageId: number): Promise<AttemptRow[]> {
  return (await testDb!.pool.query<AttemptRow>(
    `select a.id::int, a.owner_generation::text as generation, w.resource, a.origin, a.outcome, a.send_mark as "sendMark",
            a.admitted_at as "admittedAt", a.sent_at as "sentAt"
       from sync_attempts a left join sync_work w on w.id = a.work_id
      where a.page_id = $1 order by a.id`,
    [pageId],
  )).rows;
}

export async function audits(pageId: number): Promise<Array<Record<string, unknown>>> {
  return (await testDb!.pool.query<{ metadata: Record<string, unknown> }>(
    "select metadata from audit_events where platform_account_id = $1 and event_type = $2 order by id",
    [pageId, SYNC_PAGE_TRANSPORT_AUDIT_EVENT],
  )).rows.map((row) => row.metadata);
}

/** The page's credentials hold (`auth`/`identity_mismatch`), or null. */
export async function credentialsHold(pageId: number): Promise<{ kind: string; detail: Record<string, unknown> } | null> {
  const row = (await testDb!.pool.query<{ kind: string; detail: Record<string, unknown> }>(
    "select kind, detail from sync_holds where page_id = $1 and scope = 'page' and kind <> 'network'", [pageId],
  )).rows[0];
  return row ?? null;
}

export async function trusted(pageId: number): Promise<string | null> {
  return (await testDb!.pool.query<{ g: string | null }>("select credentials_generation as g from sync_pages where page_id = $1", [pageId])).rows[0]!.g;
}

export async function nodeGeneration(page: HarnessPage): Promise<string> {
  return db().transaction(async (raw) => readFanslyPageGeneration(raw as unknown as Database, page.pageLabel), { isolationLevel: "repeatable read", accessMode: "read only" });
}

/** The page's last confirmed leave of its browser and a pending one. */
export async function leftBy(pageId: number): Promise<{ by: string | null; generation: string | null; pending: string | null }> {
  return (await testDb!.pool.query<{ by: string | null; generation: string | null; pending: string | null }>(
    `select browser_left_by as by, browser_left_generation::text as generation, browser_leave_generation::text as pending
       from sync_pages where page_id = $1`, [pageId],
  )).rows[0]!;
}

export function sendsOf(rows: AttemptRow[], generation: bigint): AttemptRow[] {
  return rows.filter((row) => row.generation === generation.toString() && row.sentAt !== null);
}

/** The send marks of the sends whose answer was captured: a request still in
 *  flight has its instant (written at its start, best effort) and no mark
 *  yet. */
export function marksOf(sends: AttemptRow[]): Array<string | null> {
  return [...new Set(sends.filter((row) => row.outcome !== "sent").map((row) => row.sendMark))];
}

/** The database, its reset and the cleanups around every test of a file. */
export function useSwitchHarness(): void {
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
    for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
  });
}

export async function onBrowser(r: Rig): Promise<void> {
  await db().transaction(async (raw) => setSyncPageTransport(raw as unknown as Database, { pageId: r.page.pageId, to: "browser" }));
  await testDb!.pool.query("update sync_pages set credentials_generation = $2 where page_id = $1",
    [r.page.pageId, await readBrowserCredentialsGeneration(db(), r.page.pageId, SESSION_A)]);
}

/**
 * The engine on its browser dies after a request went, before its capture:
 * the operator keeps the outcome, the attempt is left unfinished. The
 * deploy confirms the dead owner, and the owner moves the page to Node
 * while no `sync` runs. Returns the attempt.
 */
export async function diedAfterBrowserSent(r: Rig): Promise<AttemptRow> {
  r.operator.deliverResults = false;
  let browser!: BrowserPage;
  const crashed = await makeTestActor({
    db: db(),
    pageId: r.page.pageId,
    registry: harnessIdentityRegistry(),
    settingMs: 60,
    ownRef: HARNESS_OWN_REF,
    faults: (at) => {
      if (at === "after_send") throw new SyncCrashFault(at);
    },
    build: async ({ generation, pacer }) => {
      browser = await openBrowserPage({
        db: db(), config: r.config, logger: quietLogger, metrics: new RecordingMetrics(), registry: harnessIdentityRegistry(),
        clock: { monoNow: () => performance.now(), wallNow: () => new Date(), sleep: (ms, signal) => sleep(ms, undefined, { signal: signal ?? undefined }) },
        pageId: r.page.pageId, generation, ownRef: HARNESS_OWN_REF, settingMs: 60,
        raiseTakeoverFloor: (at) => pacer.raiseTakeoverFloor(at), enqueue: async () => undefined,
        overrides: { url: () => r.operator.url, settings: async (pageId) => linkSettings({ pageId, expectedAccountId: HARNESS_OWN_REF }), rpcTiming: RPC_TIMING },
      });
      browser.start();
      return { transport: browser.transport, site: browser.site };
    },
  });
  await expect(crashed.actor.run({ stop: crashed.stop.signal, abort: crashed.abort.signal })).rejects.toBeInstanceOf(SyncCrashFault);
  await browser.stop();
  await browser.transport.close();
  const [old] = await attempts(r.page.pageId);
  expect(old).toMatchObject({ outcome: "admitted" });
  expect(r.operator.held.has(old!.id)).toBe(true);
  await confirmSyncOwnersStopped(db(), { runningHosts: ["sync-a", "sync-b"], ownHost: "cli", confirmedBy: "test", dryRun: false, pageIds: [r.page.pageId] });
  await changeSyncPageTransport(db(), { pageLabel: r.page.pageLabel, to: "node", prepare: false, actor: "test" });
  r.operator.deliverResults = true;
  return old!;
}

export const attemptOf = async (r: Rig, id: number) => (await attempts(r.page.pageId)).find((row) => row.id === id)!;

/** The browser's answers 3 MiB long (three body parts of 1 MiB): JSON
 *  padded with spaces, which it reads all the same. */
export function bigAnswers(r: Rig): void {
  const base = r.operator.respond;
  r.operator.respond = (send) => {
    const answer = base(send);
    const text = String(answer.body);
    return { ...answer, body: text + " ".repeat(3 * 1024 * 1024 - Buffer.byteLength(text)) };
  };
}

/** The fake operator's link now: it grows when a connection comes or goes. */
export const currentLinkOf = (r: Rig) => r.operator.link;
