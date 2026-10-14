import { randomUUID } from "node:crypto";
import { setTimeout as sleep } from "node:timers/promises";

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { acquireSyncPageOwnership, insertPageBrowser, setPageBrowserSettings, type Database } from "@agency_hub_core/db";
import type { AppConfig } from "@agency_hub_core/shared";

import { systemClock } from "../apps/runtime/src/sync/engine/ports.ts";
import { createEngineRegistry, type DemandSignal } from "../apps/runtime/src/sync/engine/resource.ts";
import { openBrowserPage, type BrowserPage } from "../apps/runtime/src/sync/fansly/browser-page.ts";
import { readBrowserCredentialsGeneration } from "../apps/runtime/src/sync/fansly/browser-transport.ts";
import { socketUp } from "../apps/runtime/src/sync/fansly/resources/dm-conversations.ts";
import { fanslyResourceSpec } from "../apps/runtime/src/sync/fansly/registry.ts";
import { sealPageBrowserSecrets } from "../apps/runtime/src/services/egress/page-browser-link.ts";
import { resetIntegrationDatabase, startIntegrationTestDatabase, type StartedTestDatabase } from "./helpers/db.ts";
import { FakeOperator, OPERATOR_TOKEN, SESSION_A } from "./helpers/page-browser-operator.ts";
import { HARNESS_OWN_REF, harnessConfig, seedHarnessPage, until, type HarnessPage } from "./helpers/sync-engine.ts";
import { quietLogger, RecordingMetrics, testOwner } from "./helpers/sync-engine-host.ts";
import { WS_NOOP_FRAME, WS_SESSION_FRAME } from "./helpers/sync-ws.ts";

// The guard and the down timer of a browser page's socket (Project Browser
// plan §3.2 «Кадры сокета», §4.4; stage 3 PR 14), on the slot's real intake
// of a fake operator's stream:
// - a verified site connection that stays quiet is renewed while the link is
//   up and the stream says it is open: it stays up for the alerts and the
//   list's live signal, as the engine's own socket does by its guard;
// - a page whose socket is not up for the bound (from the slot's start, or
//   from the close) raises `dm-conversations.ws-down` once per outage; a
//   demand the database refused is written again.

const PROXY = "socks5://127.0.0.1:1080";
const ENV = { timeZone: "Europe/Berlin", languages: ["en-US", "en"], geolocation: { latitude: 52.5, longitude: 13.4, accuracyM: 50 } };
const RPC_TIMING = { pingMs: 100, linkLossMs: 1_000, helloTimeoutMs: 1_000, reconnectMs: [50, 100], refusedRetryMs: 500 };
const DOWN_AFTER_MS = 1_200;

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

interface Rig {
  page: HarnessPage;
  operator: FakeOperator;
  browser: BrowserPage;
  /** The demands the slot raised, in order. */
  raised: DemandSignal[][];
  /** The next this many demands are refused (the database's failure). */
  refuse: { next: number };
}

async function rig(): Promise<Rig> {
  const operator = await FakeOperator.start({ accountId: HARNESS_OWN_REF });
  cleanups.push(() => operator.close());
  const label = `guard-${randomUUID().slice(0, 8)}`;
  const page = await seedHarnessPage({ db: db(), pool: testDb!.pool }, { mode: "live", proxyUrl: PROXY, label });
  const profileId = randomUUID();
  await insertPageBrowser(db(), {
    profileId,
    container: `page-browser-${label}`,
    pageId: page.pageId,
    ...sealPageBrowserSecrets(config(), { engineToken: OPERATOR_TOKEN, apiToken: "api-token", vncPassword: "vnc-password" }),
  });
  await setPageBrowserSettings(db(), { profileId, pinnedExitIp: "203.0.113.7", env: ENV });
  await testDb!.pool.query("update sync_pages set credentials_generation = $2 where page_id = $1",
    [page.pageId, await readBrowserCredentialsGeneration(db(), page.pageId, SESSION_A)]);
  const acquired = await acquireSyncPageOwnership(db(), { pageId: page.pageId, owner: testOwner(), judgePreviousOwner: () => "test_confirmed_dead" });
  if (acquired.kind !== "acquired") throw new Error(acquired.kind);
  const raised: DemandSignal[][] = [];
  const refuse = { next: 0 };
  const browser = await openBrowserPage({
    db: db(),
    config: config(),
    logger: quietLogger,
    metrics: new RecordingMetrics(),
    registry: createEngineRegistry([fanslyResourceSpec("repair.ws-gap")!, fanslyResourceSpec("dm-conversations.ws-down")!, fanslyResourceSpec("account.verify")!]),
    clock: systemClock,
    pageId: page.pageId,
    generation: acquired.generation,
    ownRef: HARNESS_OWN_REF,
    settingMs: 2_000,
    raiseTakeoverFloor: () => undefined,
    enqueue: async (signals) => {
      if (refuse.next > 0) {
        refuse.next -= 1;
        throw new Error("the database refused the demand");
      }
      raised.push([...signals]);
    },
    overrides: { url: () => operator.url, rpcTiming: RPC_TIMING, guardTiming: { checkMs: 100, downListAfterMs: DOWN_AFTER_MS } },
  });
  cleanups.push(async () => {
    await browser.stop();
    await browser.transport.close();
  });
  return { page, operator, browser, raised, refuse };
}

async function connection(pageId: number, connectionId: string): Promise<{ verifiedAt: Date | null; lastGuardAt: Date; closedAt: Date | null } | null> {
  const row = (await testDb!.pool.query<{ verifiedAt: Date | null; lastGuardAt: Date; closedAt: Date | null }>(
    `select verified_at as "verifiedAt", last_guard_at as "lastGuardAt", closed_at as "closedAt"
       from fansly_ws_connections where page_id = $1 and browser_connection_id = $2`, [pageId, connectionId],
  )).rows[0];
  return row ?? null;
}

const wsDown = (raised: DemandSignal[][]) => raised.flat().filter((signal) => signal.resource === "dm-conversations.ws-down");

describe("a browser page's socket: the guard and the down timer", () => {
  it("a quiet verified connection stays up by its guard; closed, the list's live signal is asked once per outage", async (context) => {
    if (!testDb) return context.skip();
    const r = await rig();
    r.browser.start();
    await until(async () => r.browser.client.up && r.browser.intake.position !== null, 5_000, "the stream subscribed");
    const first = randomUUID();
    r.operator.append({ kind: "ws.open", connectionId: first, attemptId: 1, sessionFingerprint: SESSION_A });
    r.operator.append({ kind: "ws.in", connectionId: first, frame: WS_SESSION_FRAME });
    await until(async () => (await connection(r.page.pageId, first))?.verifiedAt != null, 5_000, "the connection verified");
    expect(await socketUp(db(), r.page.pageId)).toBe(true);

    // Quiet: no frame, yet the row is renewed while the stream says it is open.
    const renewedFrom = (await connection(r.page.pageId, first))!.lastGuardAt.getTime();
    await sleep(DOWN_AFTER_MS + 600);
    expect((await connection(r.page.pageId, first))!.lastGuardAt.getTime()).toBeGreaterThan(renewedFrom + 500);
    expect(wsDown(r.raised)).toEqual([]);
    expect(r.browser.guard.downSince).toBeNull();

    // The site closes its socket: an outage; after the bound, one demand.
    r.operator.append({ kind: "ws.close", connectionId: first, code: 1006, reason: null });
    await until(async () => (await connection(r.page.pageId, first))?.closedAt != null, 5_000, "the connection closed");
    const closedGuard = (await connection(r.page.pageId, first))!.lastGuardAt.getTime();
    await until(async () => wsDown(r.raised).length === 1, DOWN_AFTER_MS + 3_000, "the ws-down demand");
    expect(wsDown(r.raised)[0]).toMatchObject({ demand: { reason: "ws_down" } });
    await sleep(DOWN_AFTER_MS + 300);
    expect(wsDown(r.raised)).toHaveLength(1);
    // A closed connection is never renewed.
    expect((await connection(r.page.pageId, first))!.lastGuardAt.getTime()).toBe(closedGuard);

    // A new connection proves itself: the outage ends; its close is a new one.
    const second = randomUUID();
    r.operator.append({ kind: "ws.open", connectionId: second, attemptId: 2, sessionFingerprint: SESSION_A });
    r.operator.append({ kind: "ws.in", connectionId: second, frame: WS_SESSION_FRAME });
    r.operator.append({ kind: "ws.in", connectionId: second, frame: WS_NOOP_FRAME });
    await until(async () => r.browser.guard.downSince === null, 5_000, "the socket up again");
    r.operator.append({ kind: "ws.close", connectionId: second, code: 1000, reason: null });
    await until(async () => wsDown(r.raised).length === 2, DOWN_AFTER_MS + 3_000, "the second outage's demand");
  }, 60_000);

  it("no socket since the slot started: asked after the bound; a refused demand is written again", async (context) => {
    if (!testDb) return context.skip();
    const r = await rig();
    r.refuse.next = 2;
    const started = Date.now();
    r.browser.start();
    await until(async () => wsDown(r.raised).length === 1, DOWN_AFTER_MS + 3_000, "the ws-down demand");
    expect(Date.now() - started).toBeGreaterThanOrEqual(DOWN_AFTER_MS);
    expect(r.refuse.next).toBe(0);
    await sleep(500);
    expect(wsDown(r.raised)).toHaveLength(1);
  }, 30_000);

  it("the link gone, a connection the stream says is open is not renewed: it goes stale as a dead receiver's", async (context) => {
    if (!testDb) return context.skip();
    const r = await rig();
    r.browser.start();
    await until(async () => r.browser.client.up && r.browser.intake.position !== null, 5_000, "the stream subscribed");
    const id = randomUUID();
    r.operator.append({ kind: "ws.open", connectionId: id, attemptId: 1, sessionFingerprint: SESSION_A });
    r.operator.append({ kind: "ws.in", connectionId: id, frame: WS_SESSION_FRAME });
    await until(async () => (await connection(r.page.pageId, id))?.verifiedAt != null, 5_000, "the connection verified");
    await r.operator.close();
    await until(async () => !r.browser.client.up, 5_000, "the link down");
    await sleep(200);
    const at = (await connection(r.page.pageId, id))!.lastGuardAt.getTime();
    await sleep(600);
    expect((await connection(r.page.pageId, id))!.lastGuardAt.getTime()).toBe(at);
  }, 30_000);
});
