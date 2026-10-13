import { randomUUID } from "node:crypto";
import { setTimeout as sleep } from "node:timers/promises";

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { findPageBrowser, insertPageBrowser, setPageBrowserSettings, type Database } from "@agency_hub_core/db";
import type { AppConfig } from "@agency_hub_core/shared";

import { monoMs } from "../apps/page-browser/src/shared/util.ts";
import { sealPageBrowserSecrets } from "../apps/runtime/src/services/egress/page-browser-link.ts";
import { systemClock } from "../apps/runtime/src/sync/engine/ports.ts";
import { createEngineRegistry, type ResourceModule } from "../apps/runtime/src/sync/engine/resource.ts";
import { openBrowserPage, type BrowserPage } from "../apps/runtime/src/sync/fansly/browser-page.ts";
import { protocolSiteRefusal, siteHostClass } from "../apps/runtime/src/sync/fansly/browser-site.ts";
import { readBrowserCredentialsGeneration } from "../apps/runtime/src/sync/fansly/browser-transport.ts";
import { fanslyResourceSpec } from "../apps/runtime/src/sync/fansly/registry.ts";
import { resetIntegrationDatabase, startIntegrationTestDatabase, type StartedTestDatabase } from "./helpers/db.ts";
import { FakeOperator, OPERATOR_TOKEN, SESSION_A, SESSION_B } from "./helpers/page-browser-operator.ts";
import { HARNESS_OWN_REF, harnessConfig, seedHarnessPage, until, type HarnessPage } from "./helpers/sync-engine.ts";
import { makeTestActor, quietLogger, RecordingMetrics, testSpec } from "./helpers/sync-engine-host.ts";

// A browser page's slot (Project Browser plan §3.2, §4.3, §4.7, §4.13; stage
// 3 PR 14) on a live page's actor against a fake operator — the operator's
// own RPC server:
// - the site path: the operator's `siteAdmit` and `wsAdmit` are PR 8's
//   pending requests; admitted through the pacer and the journal (origin
//   site, class site), answered on the link, their ends committed by the
//   engine's rules and acknowledged after that commit; what the engine
//   refuses goes back in the protocol's words;
// - the hand-over: nothing of this owner goes before the operator's
//   `quiesced`; the takeover pause counts from the last send it names; the
//   owner it answered is recorded on the profile.

const PROXY = "socks5://127.0.0.1:1080";
const ENV = { timeZone: "Europe/Berlin", languages: ["en-US", "en"], geolocation: { latitude: 52.5, longitude: 13.4, accuracyM: 50 } };
const RPC_TIMING = { pingMs: 100, linkLossMs: 1_000, helloTimeoutMs: 1_000, reconnectMs: [50, 100], refusedRetryMs: 500 };

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

const READ_KEY = "browser.read";

/** No work of the engine's own (`withRead`: a standing read of `/polls`),
 *  and the production identity verify. */
function registry(withRead = false) {
  const poll: ResourceModule = {
    plan: async () => ({ kind: "request", request: { spec: "polls", params: {} } }),
    apply: async () => ({ work: { satisfiesRevision: true }, followups: [] }),
  };
  return createEngineRegistry([
    ...(withRead ? [testSpec(READ_KEY, poll, { kind: "poll", class: "planned", period: { everyMs: 20 } })] : []),
    fanslyResourceSpec("account.verify")!,
  ]);
}

interface Rig {
  page: HarnessPage;
  profileId: string;
  operator: FakeOperator;
}

async function rig(): Promise<Rig> {
  const operator = await FakeOperator.start({ accountId: HARNESS_OWN_REF });
  cleanups.push(() => operator.close());
  const label = `site-${randomUUID().slice(0, 8)}`;
  const page = await seedHarnessPage({ db: db(), pool: testDb!.pool }, { mode: "live", proxyUrl: PROXY, label });
  const profileId = randomUUID();
  await insertPageBrowser(db(), {
    profileId,
    container: `page-browser-${label}`,
    pageId: page.pageId,
    ...sealPageBrowserSecrets(config(), { engineToken: OPERATOR_TOKEN, apiToken: "api-token", vncPassword: "vnc-password" }),
  });
  await setPageBrowserSettings(db(), { profileId, pinnedExitIp: "203.0.113.7", env: ENV });
  // The engine trusts the browser's session.
  const trusted = await readBrowserCredentialsGeneration(db(), page.pageId, SESSION_A);
  await testDb!.pool.query("update sync_pages set credentials_generation = $2 where page_id = $1", [page.pageId, trusted]);
  return { page, profileId, operator };
}

async function actorOn(r: Rig, options: { settingMs?: number; floorSettingMs?: number; withRead?: boolean } = {}) {
  let browser: BrowserPage | null = null;
  const made = await makeTestActor({
    db: db(),
    pageId: r.page.pageId,
    registry: registry(options.withRead === true),
    settingMs: options.settingMs ?? 40,
    ownRef: HARNESS_OWN_REF,
    metrics: new RecordingMetrics(),
    build: async ({ generation, pacer }) => {
      browser = await openBrowserPage({
        db: db(),
        config: config(),
        logger: quietLogger,
        metrics: new RecordingMetrics(),
        registry: registry(options.withRead === true),
        clock: systemClock,
        pageId: r.page.pageId,
        generation,
        ownRef: HARNESS_OWN_REF,
        settingMs: options.floorSettingMs ?? options.settingMs ?? 40,
        raiseTakeoverFloor: (at) => pacer.raiseTakeoverFloor(at),
        enqueue: async () => undefined,
        overrides: { url: () => r.operator.url, rpcTiming: RPC_TIMING, transportTiming: { unavailableRetryMs: 100, resultWaitMs: 5_000 } },
      });
      browser.start();
      return { transport: browser.transport, site: browser.site };
    },
  });
  const page = browser as unknown as BrowserPage;
  // The actor runs until the test ends.
  const run = made.actor.run({ stop: made.stop.signal, abort: made.abort.signal });
  cleanups.push(async () => {
    made.stop.abort();
    made.abort.abort();
    await run;
    await page.stop();
    await page.transport.close();
  });
  return { made, browser: page };
}

interface AttemptRow {
  id: number;
  origin: string;
  class: string;
  operation: string;
  outcome: string;
  sendMark: string | null;
  browserRequestId: string | null;
  httpStatus: number | null;
}

async function attempts(pageId: number): Promise<AttemptRow[]> {
  const result = await testDb!.pool.query<AttemptRow>(
    `select id::int, origin, class, operation, outcome, send_mark as "sendMark", browser_request_id as "browserRequestId",
            http_status as "httpStatus"
       from sync_attempts where page_id = $1 order by id`,
    [pageId],
  );
  return result.rows;
}

describe("the site path over the operator's RPC", () => {
  it("a site request and the site socket's CONNECT are admitted through the pacer and journaled; their ends are committed, then acknowledged", async (context) => {
    if (!testDb) return context.skip();
    const r = await rig();
    const { made } = await actorOn(r);
    await until(async () => r.operator.links.includes(true), 5_000, "the link");

    const ended = new Set<number>();
    const asked = r.operator.siteAdmit({ path: "/api/v1/messaging/groups", query: "?limit=25", route: "messaging.groups" });
    await until(async () => {
      const answer = r.operator.siteAnswers.find((a) => a.siteRequestId === asked.siteRequestId);
      if (answer?.admit === true && !ended.has(answer.attemptId)) {
        ended.add(answer.attemptId);
        r.operator.siteDone(answer, { status: 200 });
      }
      const rows = await attempts(r.page.pageId);
      return answer?.admit === true && rows.some((row) => row.id === answer.attemptId && row.outcome === "response")
        && r.operator.acks.includes(answer.attemptId);
    }, 20_000, "the site request admitted, ended, committed and acknowledged");
    const siteAnswer = r.operator.siteAnswers.find((a) => a.siteRequestId === asked.siteRequestId)!;
    expect(siteAnswer).toMatchObject({ admit: true, ownerGeneration: Number(made.generation) });
    // The deadline is on the operator's clock, in the send window.
    if (siteAnswer.admit) expect(siteAnswer.deadlineMono - monoMs()).toBeLessThanOrEqual(15_000);
    const siteRow = (await attempts(r.page.pageId)).find((row) => siteAnswer.admit && row.id === siteAnswer.attemptId)!;
    expect(siteRow).toMatchObject({ origin: "site", class: "site", operation: "messaging.groups", outcome: "response", sendMark: "transport_reported", browserRequestId: asked.siteRequestId, httpStatus: 200 });
    // Committed, then acknowledged: the operator keeps nothing of it.
    expect(r.operator.heldEnds.size).toBe(0);

    const socket = r.operator.wsAdmit();
    await until(async () => {
      const answer = r.operator.wsAnswers.find((a) => a.connectionId === socket.connectionId);
      if (answer?.admit === true && !ended.has(answer.attemptId)) {
        ended.add(answer.attemptId);
        r.operator.wsDone(answer, { status: 101 });
      }
      return answer?.admit === true && r.operator.acks.includes(answer.attemptId);
    }, 20_000, "the socket admitted, opened, committed and acknowledged");
    const wsAnswer = r.operator.wsAnswers.find((a) => a.connectionId === socket.connectionId)!;
    const wsRow = (await attempts(r.page.pageId)).find((row) => wsAnswer.admit && row.id === wsAnswer.attemptId)!;
    expect(wsRow).toMatchObject({ origin: "site", class: "site", operation: "ws.upgrade", outcome: "response", browserRequestId: socket.connectionId, httpStatus: 101 });
    // Asked again (the operator repeats it after a reconnect): nothing twice.
    r.operator.siteAdmit({ siteRequestId: asked.siteRequestId, path: "/api/v1/messaging/groups" });
    await sleep(500);
    expect(r.operator.siteAnswers.filter((a) => a.siteRequestId === asked.siteRequestId)).toHaveLength(1);
  }, 60_000);

  it("what the engine refuses goes back in the protocol's words: a write, another session, the second socket, a paused page", async (context) => {
    if (!testDb) return context.skip();
    const r = await rig();
    await actorOn(r);
    await until(async () => r.operator.links.includes(true), 5_000, "the link");
    const write = r.operator.siteAdmit({ method: "POST", path: "/api/v1/message" });
    const foreign = r.operator.siteAdmit({ path: "/api/v1/messaging/groups", sessionFingerprint: SESSION_B });
    const chat = r.operator.wsAdmit({ url: "wss://chatws.fansly.com/" });
    await until(async () => r.operator.siteAnswers.length >= 2 && r.operator.wsAnswers.length >= 1, 10_000, "the refusals");
    expect(r.operator.siteAnswers.find((a) => a.siteRequestId === write.siteRequestId)).toMatchObject({ admit: false, reason: "mode" });
    expect(r.operator.siteAnswers.find((a) => a.siteRequestId === foreign.siteRequestId)).toMatchObject({ admit: false, reason: "session_mismatch" });
    expect(r.operator.wsAnswers.find((a) => a.connectionId === chat.connectionId)).toMatchObject({ admit: false, reason: "mode" });

    await testDb.pool.query("update sync_pages set paused_all = true where page_id = $1", [r.page.pageId]);
    const paused = r.operator.siteAdmit({ path: "/api/v1/messaging/groups" });
    await until(async () => r.operator.siteAnswers.some((a) => a.siteRequestId === paused.siteRequestId), 10_000, "the paused page's refusal");
    expect(r.operator.siteAnswers.find((a) => a.siteRequestId === paused.siteRequestId)).toMatchObject({ admit: false, reason: "paused" });
    expect((await attempts(r.page.pageId)).filter((row) => row.origin === "site")).toEqual([]);
  }, 60_000);

  it("names the host classes and the refusals as the protocol does", () => {
    expect(siteHostClass("apiv3.fansly.com")).toBe("api");
    expect(siteHostClass("wsv3.fansly.com")).toBe("ws");
    expect(siteHostClass("cdn3.fansly.com")).toBe("cdn");
    expect(siteHostClass("chatws.fansly.com")).toBeNull();
    expect(siteHostClass("evil.example")).toBeNull();
    expect(protocolSiteRefusal("waited_too_long")).toBe("wait_expired");
    expect(protocolSiteRefusal("route_held")).toBe("route_hold");
    expect(protocolSiteRefusal("hour_ceiling")).toBe("site_hour_cap");
    expect(protocolSiteRefusal("credentials")).toBe("held");
    expect(protocolSiteRefusal("write")).toBe("mode");
  });
});

describe("the hand-over: the operator's quiesced", () => {
  it("nothing goes before it; the pause counts from the last send it names; its owner is recorded on the profile", async (context) => {
    if (!testDb) return context.skip();
    const r = await rig();
    let release!: () => void;
    r.operator.holdQuiesce = new Promise<void>((resolve) => (release = resolve));
    // The browser's last send, as the previous owner left it.
    const lastSend = monoMs();
    r.operator.lastSendMono = lastSend;
    const floorSettingMs = 1_000;
    const { made } = await actorOn(r, { settingMs: 40, floorSettingMs, withRead: true });
    await until(async () => r.operator.links.includes(true), 5_000, "the link");
    const asked = r.operator.siteAdmit({ path: "/api/v1/messaging/groups" });
    // Before quiesced: no send of the engine, no answer to the site.
    await sleep(400);
    expect(r.operator.sends).toEqual([]);
    expect(r.operator.siteAnswers).toEqual([]);
    expect((await findPageBrowser(db(), r.profileId))!.handoverGeneration).toBeNull();

    release();
    let ended = false;
    await until(async () => {
      const admitted = r.operator.siteAnswers.find((a) => a.siteRequestId === asked.siteRequestId);
      if (admitted?.admit === true && !ended) {
        ended = true;
        r.operator.siteDone(admitted, { status: 200 });
      }
      return r.operator.physical.length >= 1 && ended;
    }, 20_000, "the first requests after quiesced");
    // 1.2 × S after the browser's last send (the guard adds 1 ms): the
    // site's grant and the engine's first check alike.
    expect(r.operator.physical[0]!.checkedMono - lastSend).toBeGreaterThanOrEqual(1.2 * floorSettingMs);
    const granted = r.operator.siteAnswers.find((a) => a.siteRequestId === asked.siteRequestId);
    if (granted?.admit === true) expect(granted.deadlineMono - 15_000 - lastSend).toBeGreaterThanOrEqual(1.2 * floorSettingMs - 50);
    const answer = r.operator.siteAnswers.find((a) => a.siteRequestId === asked.siteRequestId);
    expect(answer?.admit).toBe(true);
    await until(async () => (await findPageBrowser(db(), r.profileId))!.handoverGeneration === made.generation, 5_000, "the hand-over recorded");
    expect((await findPageBrowser(db(), r.profileId))!.handoverQuiescedAt).toBeInstanceOf(Date);
  }, 60_000);
});
