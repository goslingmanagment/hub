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
import { readBrowserCredentialsGeneration } from "../apps/runtime/src/sync/fansly/browser-transport.ts";
import { fanslyResourceSpec } from "../apps/runtime/src/sync/fansly/registry.ts";
import { resetIntegrationDatabase, startIntegrationTestDatabase, type StartedTestDatabase } from "./helpers/db.ts";
import { FakeOperator, OPERATOR_TOKEN, SESSION_A } from "./helpers/page-browser-operator.ts";
import { HARNESS_OWN_REF, harnessConfig, seedHarnessPage, until, type HarnessPage } from "./helpers/sync-engine.ts";
import { makeTestActor, quietLogger, RecordingMetrics, testSpec } from "./helpers/sync-engine-host.ts";

// A browser page's slot (Project Browser plan §3.2, §4.3, §4.7, §4.13; stage
// 3 PR 14) on a live page's actor against a fake operator — the operator's
// own RPC server:
// - the site's admission messages an operator's image still knows
//   (`siteAdmit`, `wsAdmit`, `admissionCancel`, `siteDone`, `wsDone`): parsed
//   and taken by nobody — the link stays up, nothing is journaled, the
//   engine's own work goes on (A10-04 step 6: the parser keeps their cases
//   while an operator with the old site path may run);
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

async function actorOn(
  r: Rig,
  options: { settingMs?: number; floorSettingMs?: number; withRead?: boolean } = {},
) {
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

describe("the site's admission messages, taken by nobody", () => {
  it("an operator's siteAdmit, wsAdmit, admissionCancel, siteDone and a wsDone of unknown fate keep the link up, journal nothing, and the engine's next attempt completes", async () => {
    const r = await rig();
    await actorOn(r, { withRead: true });
    await until(async () => (await attempts(r.page.pageId)).some((row) => row.outcome === "response"), 10_000, "the engine's own reads");
    const links = r.operator.links.length;
    const hellos = r.operator.hellos.length;

    const asked = r.operator.siteAdmit({ path: "/api/v1/account/me", route: "account.me" });
    const socket = r.operator.wsAdmit();
    r.operator.server.send({ type: "admissionCancel", kind: "site", id: asked.siteRequestId, reason: "wait_expired" });
    r.operator.server.send({
      type: "siteDone", siteRequestId: asked.siteRequestId, attemptId: 999_991, sent: true, sentMono: monoMs(), sentWall: Date.now(),
      connectionReused: false, status: 200, retryAfter: null, error: null, body: "buffered",
    });
    // The operator's start-up sweep of a socket an older engine admitted.
    r.operator.server.send({
      type: "wsDone", connectionId: randomUUID(), attemptId: 999_992, sent: false, sentMono: null, status: null,
      error: "the handshake's fate is unknown: the operator started again", fate: "unknown",
    });
    // An attempt admitted after them: its check comes on the same link, after them.
    const before = Math.max(...(await attempts(r.page.pageId)).map((row) => row.id));
    await until(async () => (await attempts(r.page.pageId)).some((row) => row.id > before && row.outcome === "response"), 10_000, "the engine's next attempt");

    // The link never dropped (a message it could not parse closes it).
    expect(r.operator.links.slice(links)).toEqual([]);
    expect(r.operator.hellos).toHaveLength(hellos);
    // Nothing of them is journaled, answered or acknowledged.
    const rows = await attempts(r.page.pageId);
    expect(rows.filter((row) => row.origin === "site" || row.browserRequestId === asked.siteRequestId || row.browserRequestId === socket.connectionId || row.id >= 999_991)).toEqual([]);
    expect(r.operator.siteAnswers).toEqual([]);
    expect(r.operator.wsAnswers).toEqual([]);
    expect(r.operator.acks.filter((id) => id >= 999_991)).toEqual([]);
  }, 30_000);
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
    // Before quiesced: no send of the engine.
    await sleep(400);
    expect(r.operator.sends).toEqual([]);
    expect((await findPageBrowser(db(), r.profileId))!.handoverGeneration).toBeNull();

    release();
    await until(async () => r.operator.physical.length >= 1, 20_000, "the first request after quiesced");
    // 1.2 × S after the browser's last send (the guard adds 1 ms).
    expect(r.operator.physical[0]!.checkedMono - lastSend).toBeGreaterThanOrEqual(1.2 * floorSettingMs);
    await until(async () => (await findPageBrowser(db(), r.profileId))!.handoverGeneration === made.generation, 5_000, "the hand-over recorded");
    expect((await findPageBrowser(db(), r.profileId))!.handoverQuiescedAt).toBeInstanceOf(Date);
  }, 60_000);
});

// Variant Б (plan-b-browser-host §4.2): an operator of protocol minor 4 lets
// the site's own requests go and tells the engine what left (`siteSent`) and
// how it ended (`siteEnded`). Nothing of the site is admitted or refused.
describe("variant Б: the site's own traffic, observed", () => {
  async function pageRow(pageId: number) {
    const result = await testDb!.pool.query<{ credentialsGeneration: string | null; identityAccountId: string | null }>(
      `select credentials_generation as "credentialsGeneration", identity_account_id as "identityAccountId" from sync_pages where page_id = $1`,
      [pageId],
    );
    return result.rows[0]!;
  }

  async function credentialsHold(pageId: number) {
    const result = await testDb!.pool.query<{ kind: string; detail: { failedAttemptId: number | null; failedAt: string; credentialsGeneration: string | null; failedObserved?: true } }>(
      `select kind, detail from sync_holds where page_id = $1 and scope = 'page' and kind in ('auth', 'identity_mismatch')`,
      [pageId],
    );
    return result.rows[0] ?? null;
  }

  async function verifyStatuses(pageId: number): Promise<Array<number | null>> {
    const result = await testDb!.pool.query<{ httpStatus: number | null }>(
      `select http_status as "httpStatus" from sync_attempts where page_id = $1 and resource = 'account.verify' order by id`,
      [pageId],
    );
    return result.rows.map((row) => row.httpStatus);
  }

  async function siteErrorClass(siteRequestId: string): Promise<string | null> {
    const result = await testDb!.pool.query<{ errorClass: string | null }>(
      `select error_class as "errorClass" from sync_attempts where browser_request_id = $1 and outcome = 'response'`, [siteRequestId],
    );
    return result.rows[0]?.errorClass ?? null;
  }

  async function clearedAudit(pageId: number): Promise<Array<Record<string, unknown>>> {
    const result = await testDb!.pool.query<{ metadata: Record<string, unknown> }>(
      "select metadata from audit_events where platform_account_id = $1 and event_type = 'sync.credentials_hold_cleared' order by id", [pageId],
    );
    return result.rows.map((row) => row.metadata);
  }

  // Audit 2026-10-22 P2-1: the site's refusal named the browser's digest H,
  // which every request of the page — its verify too — carries, so A3 never
  // admitted a verify and the page stood until a new login.
  it("a site's own 401 holds the page with no digest: one verify of the browser's session clears it; the site's next 401 within the hour holds nothing, after it one verify again", async () => {
    const r = await rig();
    const trusted = (await pageRow(r.page.pageId)).credentialsGeneration;
    const { made } = await actorOn(r);
    await until(async () => r.operator.links.includes(true), 5_000, "the link");
    const refused = r.operator.siteSent({ path: "/api/v1/polls" });
    r.operator.siteEnded(refused, { status: 401 });
    await until(async () => (await verifyStatuses(r.page.pageId)).length === 1 && (await credentialsHold(r.page.pageId)) === null, 10_000, "the verify's proof");
    expect(await clearedAudit(r.page.pageId)).toEqual([expect.objectContaining({
      resource: "account.verify",
      credentialsGeneration: trusted,
      cleared: expect.objectContaining({ kind: "auth", failedAttemptId: null, credentialsGeneration: null, observed: true }),
    })]);
    // A few laps more: the verify went once.
    await sleep(1_500);
    expect(await verifyStatuses(r.page.pageId)).toEqual([200]);

    // The site repeats its refused request within the hour: no evidence —
    // no hold, no verify; journaled as the site's answer, counted.
    const again = r.operator.siteSent({ path: "/api/v1/polls" });
    r.operator.siteEnded(again, { status: 401 });
    await until(async () => (await siteErrorClass(again.siteRequestId)) !== null, 5_000, "the site's next refusal");
    expect(await siteErrorClass(again.siteRequestId)).toBe("site:401");
    expect((made.deps.metrics as RecordingMetrics).get("sync_site_refusal_discounted")).toBe(1);
    await sleep(1_500);
    expect(await credentialsHold(r.page.pageId)).toBeNull();
    expect(await verifyStatuses(r.page.pageId)).toEqual([200]);

    // The hour has passed: the site's refusal holds again, for one verify.
    await testDb!.pool.query(
      "update audit_events set created_at = created_at - interval '61 minutes' where platform_account_id = $1 and event_type = 'sync.credentials_hold_cleared'", [r.page.pageId],
    );
    const later = r.operator.siteSent({ path: "/api/v1/polls" });
    r.operator.siteEnded(later, { status: 401 });
    await until(async () => (await verifyStatuses(r.page.pageId)).length === 2 && (await clearedAudit(r.page.pageId)).length === 2, 10_000, "the second verify's proof");
    expect(await siteErrorClass(later.siteRequestId)).toBe("auth");
    expect(await credentialsHold(r.page.pageId)).toBeNull();
    expect(await verifyStatuses(r.page.pageId)).toEqual([200, 200]);
  }, 40_000);

  it("within the hour the engine's own 401 still holds the page with its digest", async () => {
    const r = await rig();
    const trusted = (await pageRow(r.page.pageId)).credentialsGeneration;
    await actorOn(r, { withRead: true });
    await until(async () => r.operator.links.includes(true), 5_000, "the link");
    const refused = r.operator.siteSent({ path: "/api/v1/polls" });
    r.operator.siteEnded(refused, { status: 401 });
    await until(async () => (await clearedAudit(r.page.pageId)).length === 1, 10_000, "the verify's proof");
    // The session dies: the engine's own read is refused.
    const answer = r.operator.respond;
    r.operator.respond = (send) => (new URL(send.url).pathname.endsWith("/polls")
      ? { status: 401, headers: { "content-type": "application/json" }, body: JSON.stringify({ success: false, error: { code: 401, details: "Unauthorized" } }) }
      : answer(send));
    await until(async () => (await credentialsHold(r.page.pageId)) !== null, 10_000, "the engine's refusal");
    const held = await credentialsHold(r.page.pageId);
    expect(held?.detail).toMatchObject({ credentialsGeneration: trusted, failedAttemptId: expect.any(Number) });
    // H is refused by Hub's own request: no verify of it.
    await sleep(1_500);
    expect(await verifyStatuses(r.page.pageId)).toEqual([200]);
    expect(await credentialsHold(r.page.pageId)).not.toBeNull();
  }, 30_000);

  it("a verify refused in turn names the browser's digest: no second verify, also after the site's next refusal", async () => {
    const r = await rig();
    const trusted = (await pageRow(r.page.pageId)).credentialsGeneration;
    const answer = r.operator.respond;
    r.operator.respond = (send) => (new URL(send.url).pathname.endsWith("/account/me")
      ? { status: 401, headers: { "content-type": "application/json" }, body: JSON.stringify({ success: false, error: { code: 401, details: "Unauthorized" } }) }
      : answer(send));
    await actorOn(r);
    await until(async () => r.operator.links.includes(true), 5_000, "the link");
    const first = r.operator.siteSent({ path: "/api/v1/polls" });
    r.operator.siteEnded(first, { status: 401 });
    await until(async () => (await credentialsHold(r.page.pageId))?.detail.credentialsGeneration === trusted, 10_000, "the verify's refusal");
    expect(await verifyStatuses(r.page.pageId)).toEqual([401]);
    const refusedByVerify = await credentialsHold(r.page.pageId);
    expect(refusedByVerify?.detail).toMatchObject({ credentialsGeneration: trusted, failedAttemptId: expect.any(Number) });
    const next = r.operator.siteSent({ path: "/api/v1/polls" });
    r.operator.siteEnded(next, { status: 401 });
    await until(async () => (await attempts(r.page.pageId)).some((row) => row.browserRequestId === next.siteRequestId && row.httpStatus === 401), 5_000, "the site's next refusal");
    await sleep(1_500);
    expect(await verifyStatuses(r.page.pageId)).toEqual([401]);
    // Under the hold the site's refusal changed nothing: the verify's stands.
    expect(await credentialsHold(r.page.pageId)).toEqual(refusedByVerify);
  }, 30_000);

  it("the site refused again while the verify is in flight changes nothing: that verify's 200 clears the hold, one verify in all", async () => {
    const r = await rig();
    let release!: () => void;
    const held = new Promise<void>((resolve) => (release = resolve));
    let verifySent = false;
    // The verify's answer waits, after its send, until the site's next refusal is committed.
    r.operator.beforeResult = async (send) => {
      if (!new URL(send.url).pathname.endsWith("/account/me")) return;
      verifySent = true;
      await held;
    };
    await actorOn(r);
    await until(async () => r.operator.links.includes(true), 5_000, "the link");
    const first = r.operator.siteSent({ path: "/api/v1/polls" });
    r.operator.siteEnded(first, { status: 401 });
    await until(async () => verifySent, 10_000, "the verify sent");
    const opened = await credentialsHold(r.page.pageId);
    expect(opened?.detail).toMatchObject({ credentialsGeneration: null, failedAttemptId: null, failedObserved: true });
    // Sent after the verify, committed before its answer.
    const overlap = r.operator.siteSent({ path: "/api/v1/polls" });
    r.operator.siteEnded(overlap, { status: 401 });
    await until(async () => (await siteErrorClass(overlap.siteRequestId)) !== null, 5_000, "the overlapping refusal");
    expect(await credentialsHold(r.page.pageId)).toEqual(opened);
    release();
    await until(async () => (await clearedAudit(r.page.pageId)).length === 1, 10_000, "the verify's proof");
    expect(await credentialsHold(r.page.pageId)).toBeNull();
    await sleep(1_500);
    expect(await verifyStatuses(r.page.pageId)).toEqual([200]);
  }, 30_000);

  it("journals the site's send and its end", async () => {
    const r = await rig();
    await actorOn(r);
    await until(async () => r.operator.links.includes(true), 5_000, "the link");
    const sent = r.operator.siteSent({ path: "/api/v1/account/me", route: "account.me" });
    r.operator.siteEnded(sent, { status: 200 });
    await until(async () => (await attempts(r.page.pageId)).some((row) => row.browserRequestId === sent.siteRequestId && row.outcome === "response"), 5_000, "the observed attempt and its end");
    const row = (await attempts(r.page.pageId)).find((a) => a.browserRequestId === sent.siteRequestId)!;
    expect(row).toMatchObject({ origin: "site", class: "site", operation: "account.me", httpStatus: 200, sendMark: "transport_reported" });
    // The site socket's handshake is told as a send of route ws.upgrade: its row is class urgent.
    const upgrade = r.operator.siteSent({ host: "wsv3.fansly.com", path: "/", route: "ws.upgrade" });
    r.operator.siteEnded(upgrade, { status: 101 });
    await until(async () => (await attempts(r.page.pageId)).some((a) => a.browserRequestId === upgrade.siteRequestId && a.outcome === "response"), 5_000, "the observed handshake and its end");
    expect((await attempts(r.page.pageId)).find((a) => a.browserRequestId === upgrade.siteRequestId)).toMatchObject({ origin: "site", class: "urgent", operation: "ws.upgrade", httpStatus: 101 });
    // Nothing of the site was asked or answered on the admission path.
    expect(r.operator.siteAnswers).toEqual([]);
  }, 30_000);

  it("the site's 429 holds the route for the engine's own requests", async () => {
    const r = await rig();
    await actorOn(r);
    await until(async () => r.operator.links.includes(true), 5_000, "the link");
    const limited = r.operator.siteSent({ path: "/api/v1/account/me", route: "account.me" });
    r.operator.siteEnded(limited, { status: 429, retryAfter: "60" });
    await until(async () => {
      const held = await testDb!.pool.query("select 1 from sync_holds where page_id = $1 and scope = 'route' and key = 'account.me' and kind = 'route_hold' and until > now()", [r.page.pageId]);
      return held.rows.length === 1;
    }, 5_000, "the route hold of the site's 429");
    expect((await attempts(r.page.pageId)).filter((a) => a.origin === "site").map((a) => a.httpStatus)).toEqual([429]);
  }, 30_000);
});

// Minor 6: the operator keeps each observation until the engine confirms its
// commit (`siteObservedAck`) and tells it again until then; the engine takes
// a hop once by its key (`sync_observed_site_requests`, 0289).
describe("minor 6: the site's observations, delivered for sure", () => {
  interface ObservedRow {
    attemptId: number | null;
    browserRequestId: string;
    hop: number;
    sentRecordedAt: Date | null;
    endStatus: number | null;
    endedRecordedAt: Date | null;
  }

  async function observedRows(pageId: number, requestKey: string): Promise<ObservedRow[]> {
    const result = await testDb!.pool.query<ObservedRow>(
      `select attempt_id::int as "attemptId", browser_request_id as "browserRequestId", hop, sent_recorded_at as "sentRecordedAt",
              end_status as "endStatus", ended_recorded_at as "endedRecordedAt"
         from sync_observed_site_requests where page_id = $1 and request_key = $2 order by hop`,
      [pageId, requestKey],
    );
    return result.rows;
  }

  it("a send told again journals no second attempt; each fact is confirmed once committed; the site's 429 holds its route", async () => {
    const r = await rig();
    await testDb!.pool.query("update sync_pages set paused_all = true where page_id = $1", [r.page.pageId]);
    const { made } = await actorOn(r);
    await until(async () => r.operator.links.includes(true), 5_000, "the link");
    const requestKey = randomUUID();
    const sent = r.operator.siteSent({ path: "/api/v1/account/me", route: "account.me", requestKey });
    // Told again at once: the same message while it waits in the journal's chain.
    r.operator.tellAgain(sent);
    await until(async () => r.operator.observedAcks.filter((seq) => seq === sent.deliverySeq).length === 2, 5_000, "the send confirmed for both");
    // Told anew (to a new connection: what still flies) once it is committed.
    const { deliverySeq: _first, type: _type, ...again } = sent;
    const announced = r.operator.siteSent(again);
    await until(async () => r.operator.observedAcks.includes(announced.deliverySeq!), 5_000, "the repeat confirmed");
    const rows = (await attempts(r.page.pageId)).filter((row) => row.browserRequestId === sent.siteRequestId);
    expect(rows).toHaveLength(1);
    expect(await observedRows(r.page.pageId, requestKey)).toEqual([
      expect.objectContaining({ attemptId: rows[0]!.id, browserRequestId: sent.siteRequestId, hop: 0, sentRecordedAt: expect.any(Date), endedRecordedAt: null }),
    ]);
    expect((made.deps.metrics as RecordingMetrics).get("sync_site_observed_repeated")).toBeGreaterThanOrEqual(1);

    const ended = r.operator.siteEnded(sent, { status: 429, retryAfter: "60" });
    await until(async () => r.operator.observedAcks.includes(ended.deliverySeq!), 5_000, "the end confirmed");
    r.operator.tellAgain(ended);
    await until(async () => r.operator.observedAcks.filter((seq) => seq === ended.deliverySeq).length === 2, 5_000, "the end confirmed again");
    const held = await testDb!.pool.query("select 1 from sync_holds where page_id = $1 and scope = 'route' and key = 'account.me' and kind = 'route_hold' and until > now()", [r.page.pageId]);
    expect(held.rows).toHaveLength(1);
    expect((await attempts(r.page.pageId)).filter((row) => row.browserRequestId === sent.siteRequestId)).toEqual([
      expect.objectContaining({ outcome: "response", httpStatus: 429 }),
    ]);
    expect(await observedRows(r.page.pageId, requestKey)).toEqual([expect.objectContaining({ endStatus: 429, endedRecordedAt: expect.any(Date) })]);
  }, 30_000);

  it("an end before its send's journal commits nothing and is not confirmed — told again after its send, it is; a redirect's hops are two attempts", async () => {
    const r = await rig();
    await testDb!.pool.query("update sync_pages set paused_all = true where page_id = $1", [r.page.pageId]);
    const { made } = await actorOn(r);
    await until(async () => r.operator.links.includes(true), 5_000, "the link");
    const requestKey = randomUUID();
    const siteRequestId = "939.231";
    // The send's message, built but never told yet.
    const sent = { type: "siteSent" as const, siteRequestId, method: "GET", host: "apiv3.fansly.com", path: "/api/v1/polls", route: "site.other", sessionFingerprint: SESSION_A, sentMono: monoMs(), requestKey, hop: 0, deliverySeq: 900 };
    const early = r.operator.siteEnded(sent, { status: 200 });
    await until(async () => (made.deps.metrics as RecordingMetrics).get("sync_site_observed_early") >= 1, 5_000, "the early end taken");
    expect(r.operator.observedAcks).not.toContain(early.deliverySeq);
    expect(await observedRows(r.page.pageId, requestKey)).toEqual([]);
    r.operator.tellAgain(sent);
    r.operator.tellAgain(early);
    await until(async () => r.operator.observedAcks.includes(900) && r.operator.observedAcks.includes(early.deliverySeq!), 5_000, "both confirmed");
    // Its redirect's next hop: the same id and key, another attempt.
    const next = r.operator.siteSent({ siteRequestId, path: "/api/v1/polls", requestKey, hop: 1 });
    r.operator.siteEnded(next, { status: 200 });
    await until(async () => (await observedRows(r.page.pageId, requestKey)).length === 2 && (await observedRows(r.page.pageId, requestKey)).every((row) => row.endedRecordedAt !== null), 5_000, "both hops ended");
    const rows = (await attempts(r.page.pageId)).filter((row) => row.browserRequestId === siteRequestId);
    expect(rows.map((row) => row.outcome)).toEqual(["response", "response"]);
    expect((await observedRows(r.page.pageId, requestKey)).map((row) => row.attemptId)).toEqual(rows.map((row) => row.id));
  }, 30_000);

  it("a site 429 whose hold did not commit keeps the own slots closed; once it commits they open", async () => {
    const r = await rig();
    await testDb!.pool.query("update sync_pages set paused_all = true where page_id = $1", [r.page.pageId]);
    const { made } = await actorOn(r);
    await until(async () => r.operator.links.includes(true), 5_000, "the link");
    const pacer = made.deps.pacer;
    const requestKey = randomUUID();
    // The send's message, built but never told yet: its end commits nothing.
    const sent = { type: "siteSent" as const, siteRequestId: "940.1", method: "GET", host: "apiv3.fansly.com", path: "/api/v1/account/me", route: "account.me", sessionFingerprint: SESSION_A, sentMono: monoMs(), requestKey, hop: 0, deliverySeq: 901 };
    const early = r.operator.siteEnded(sent, { status: 429, retryAfter: "60" });
    await until(async () => (made.deps.metrics as RecordingMetrics).get("sync_site_observed_early") >= 1, 5_000, "the early end taken");
    expect(r.operator.observedAcks).not.toContain(early.deliverySeq);
    expect(pacer.slotOpensAtMono(40) - systemClock.monoNow()).toBeGreaterThan(60_000);
    r.operator.tellAgain(sent);
    r.operator.tellAgain(early);
    await until(async () => r.operator.observedAcks.includes(early.deliverySeq!), 5_000, "the end confirmed");
    const held = await testDb!.pool.query("select 1 from sync_holds where page_id = $1 and scope = 'route' and key = 'account.me' and kind = 'route_hold' and until > now()", [r.page.pageId]);
    expect(held.rows).toHaveLength(1);
    expect(pacer.slotOpensAtMono(40) - systemClock.monoNow()).toBeLessThan(5_000);
  }, 30_000);
});
