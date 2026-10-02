import { randomUUID } from "node:crypto";

import { afterEach, beforeAll, afterAll, beforeEach, describe, expect, it } from "vitest";

import { confirmSyncOwnersStopped, upsertDemand, type Database } from "@agency_hub_core/db";

import { createDefaultFanslySendOsProbe } from "../apps/runtime/src/services/fansly-send-guard/os-probe.ts";
import { SyncEngineHost } from "../apps/runtime/src/sync/engine/host.ts";
import { SEND_WINDOW_MS, TAKEOVER_FACTOR } from "../apps/runtime/src/sync/engine/pacer.ts";
import { systemClock } from "../apps/runtime/src/sync/engine/ports.ts";
import { submitHistoryRequest } from "../apps/runtime/src/sync/requests/history.ts";
import { resetIntegrationDatabase, startIntegrationTestDatabase, type StartedTestDatabase } from "./helpers/db.ts";
import {
  CountingConnectProxy,
  demandHarnessDownload,
  earlyWakingClock,
  ensureHarnessSettingTable,
  FakeChats,
  FakeFanslyServer,
  harnessConfig,
  harnessHostOptions,
  harnessRng,
  harnessRoutes,
  HARNESS_KEY,
  seedChatThread,
  seedHarnessPage,
  setHarnessSetting,
  spawnSyncChild,
  until,
  type FakeArrival,
  type HarnessPage,
  type TakeoverRecord,
} from "./helpers/sync-engine.ts";

// Plan §15 step 2, "заглушка транспорта считает каждый физический запрос":
// the engine's live loop (the production host, ownership session, takeover
// floor, pacer, actor, commits and page transport) against a fake Fansly
// origin behind the page proxy, with real undici in between. Every kind of
// physical request a page makes goes through the pacer once per admission —
// polls, urgent triggers, history reads, the identity check's /account/me, a
// CDN download whose 302 is the next admission, the WebSocket Upgrade, and
// REST answers of 302 and 421 that must not be followed or re-sent — and the
// origin's arrival log is the judge: no two arrivals of the page closer than
// S, one arrival per sent attempt. Then the same under timers that fire
// early, a setting changed mid-run, a proxy slow to open its tunnel, two
// restarts (graceful, and kill -9 of a real process mid-request) and a
// dispatch that misses its send window.
//
// The CDN download and the Upgrade are the production resources
// (`media-download.fetch`, `ws.connect`, S3-04) through the production page
// transport; the identity check is still a test-only key (`account.identity`
// sends with S3-05), on the same page egress and send-check composition.

const S = 300;

let testDb: StartedTestDatabase | null = null;
let server: FakeFanslyServer | null = null;
let proxy: CountingConnectProxy | null = null;
const hosts: SyncEngineHost[] = [];
const children: Array<ReturnType<typeof spawnSyncChild>> = [];

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
  for (const child of children.splice(0)) {
    child.kill("SIGKILL");
    await child.exited;
  }
  await Promise.all(hosts.splice(0).map((host) => host.stop()));
  await server?.close();
  await proxy?.close();
  server = null;
  proxy = null;
});

function db(): Database {
  return testDb!.db as unknown as Database;
}

interface Rig {
  server: FakeFanslyServer;
  proxy: CountingConnectProxy;
  chats: FakeChats;
  page: HarnessPage;
  config: ReturnType<typeof harnessConfig>;
}

async function rig(): Promise<Rig> {
  server = await FakeFanslyServer.start();
  proxy = await CountingConnectProxy.start();
  const chats = new FakeChats();
  for (const route of harnessRoutes(chats)) server.route(route);
  const page = await seedHarnessPage({ db: db(), pool: testDb!.pool }, { mode: "live", proxyUrl: proxy.url });
  return { server, proxy, chats, page, config: harnessConfig(testDb!.connectionString, server.apiBaseUrl) };
}

async function startHost(r: Rig, options: { seed: number; takeovers?: TakeoverRecord[]; early?: boolean; hostName?: string }) {
  const base = createDefaultFanslySendOsProbe();
  const host = new SyncEngineHost(harnessHostOptions({
    db: db(),
    pool: testDb!.pool,
    connectionString: testDb!.connectionString,
    config: r.config,
    rng: harnessRng(options.seed),
    ...(options.takeovers === undefined ? {} : { takeovers: options.takeovers }),
    ...(options.early === true ? { clock: earlyWakingClock(systemClock, 50) } : {}),
    ...(options.hostName === undefined ? {} : { probe: { ...base, hostname: () => options.hostName! } }),
  }));
  hosts.push(host);
  await host.start();
  return host;
}

async function demand(pageId: number, resource: string, subject: string, params?: Record<string, unknown>) {
  await upsertDemand(db(), {
    pageId,
    shadow: false,
    resource,
    subject,
    kind: "trigger",
    class: "urgent",
    ...(params === undefined ? {} : { params }),
  });
}

async function scalar(text: string, values: unknown[] = []): Promise<number> {
  const result = await testDb!.pool.query<{ n: number }>(text, values);
  return Number(result.rows[0]?.n ?? 0);
}

function gaps(arrivals: readonly FakeArrival[]): number[] {
  return arrivals.slice(1).map((arrival, index) => arrival.mono - arrivals[index]!.mono);
}

interface SentAttempt {
  id: string;
  resource: string;
  setting_ms: number;
  pause_ms: number;
  gap_prev_ms: number | null;
  send_mark: string;
  http_status: number | null;
  outcome: string;
}

async function sentAttempts(pageId: number): Promise<SentAttempt[]> {
  const result = await testDb!.pool.query<SentAttempt>(
    `select id::text, resource, setting_ms, pause_ms, gap_prev_ms, send_mark, http_status, outcome
       from sync_attempts where page_id = $1 and not shadow and sent_at is not null order by sent_at, id`,
    [pageId],
  );
  return result.rows;
}

/** The journal's own check of every send against the pause it was admitted
 *  with, and of the pause against the setting read at that admission. */
function expectJournalPaced(attempts: readonly SentAttempt[]) {
  for (const attempt of attempts) {
    expect(attempt.pause_ms, attempt.id).toBeGreaterThanOrEqual(attempt.setting_ms);
    if (attempt.gap_prev_ms !== null) expect(attempt.gap_prev_ms, attempt.id).toBeGreaterThanOrEqual(attempt.pause_ms);
  }
}

describe("every physical request of a page, counted at the origin", () => {
  it("polls, urgent reads, history reads, identity, CDN hops, the Upgrade and REST 302/421: one arrival per send, none closer than S", async (context) => {
    if (!testDb) return context.skip();
    const r = await rig();
    // A third of the answers close their connection, so the page keeps
    // opening tunnels; every fifth tunnel takes 0.3–5 s to come up (a proxy
    // slow to connect before the headers are written).
    r.server.closeShare = 0.35;
    r.proxy.tunnelDelayMs = (index) => (index % 5 === 3 ? 300 + Math.random() * 4_700 : Math.random() * 20);
    const { pageId } = r.page;
    for (let n = 1; n <= 6; n += 1) await demand(pageId, HARNESS_KEY.urgent, `u${n}`);
    for (const key of [HARNESS_KEY.identity, HARNESS_KEY.ws, HARNESS_KEY.redirect, HARNESS_KEY.misdirected]) {
      await demand(pageId, key, "a");
      await demand(pageId, key, "b");
    }
    for (const name of ["img-1", "img-2"]) {
      await demandHarnessDownload({ db: db(), pool: testDb.pool }, { pageId, config: r.config, url: `${r.server.origin}/cdn/${name}` });
    }
    // A history request for one chat of 90 messages the hub holds none of:
    // the head, three pages below it and the empty page (⌈90/25⌉ + 1).
    const chat = r.chats.add({ count: 90, ageMs: 86_400_000 });
    await seedChatThread({ db: db(), pool: testDb.pool }, pageId, chat);
    await submitHistoryRequest({ db: db(), rawConfig: r.config }, {
      pageId,
      requester: { kind: "owner_cli", userId: null },
      fans: [{ kind: "conversation", conversationRef: chat.groupId }],
      depth: { kind: "all" },
      reason: "pacer-transport",
      idempotencyKey: randomUUID(),
    });

    const host = await startHost(r, { seed: 11 });
    await until(async () => {
      const open = await scalar(
        "select count(*)::int as n from sync_work where page_id = $1 and kind <> 'poll' and state not in ('done', 'cancelled')",
        [pageId],
      );
      const polls = await scalar(
        "select count(*)::int as n from sync_attempts where page_id = $1 and resource = $2 and sent_at is not null",
        [pageId, HARNESS_KEY.poll],
      );
      return open === 0 && polls >= 4;
    }, 90_000, "every one-shot work closed and a few polls");
    await host.stop();

    const arrivals = r.server.arrivals;
    expect(gaps(arrivals).filter((gap) => gap < S)).toEqual([]);
    const sent = await sentAttempts(pageId);
    expect(arrivals).toHaveLength(sent.length);
    // The check ran at `onRequestStart` for every kind: no send was taken at
    // its completion instead.
    expect(sent.filter((attempt) => attempt.send_mark !== "request_start")).toEqual([]);
    expectJournalPaced(sent);
    expect(await scalar("select count(*)::int as n from sync_attempts where page_id = $1 and outcome = 'aborted_before_send'", [pageId])).toBe(0);

    const at = (prefix: string) => r.server.arrivalsAt(prefix);
    const byResource = (resource: string) => sent.filter((attempt) => attempt.resource === resource);
    // The 302 and the 421 are answers: one arrival each, no hop, no re-send.
    expect(at("/api/v1/recapstats").map((arrival) => [arrival.path.split("?")[0], arrival.status]))
      .toEqual([["/api/v1/recapstats", 302], ["/api/v1/recapstats", 302]]);
    expect(byResource(HARNESS_KEY.redirect).map((attempt) => attempt.http_status)).toEqual([302, 302]);
    expect(at("/api/v1/message/broadcast/scheduled").map((arrival) => arrival.status)).toEqual([421, 421]);
    expect(byResource(HARNESS_KEY.misdirected).map((attempt) => attempt.http_status)).toEqual([421, 421]);
    // The Upgrade is one request, completed at its 101.
    expect(arrivals.filter((arrival) => arrival.upgrade).map((arrival) => arrival.status)).toEqual([101, 101]);
    expect(byResource(HARNESS_KEY.ws).map((attempt) => attempt.http_status)).toEqual([101, 101]);
    // A CDN download: its redirect is the next admission, never a hop inside one.
    expect(at("/cdn/").map((arrival) => [arrival.path, arrival.status]).sort()).toEqual([
      ["/cdn/final/img-1", 200], ["/cdn/final/img-2", 200], ["/cdn/img-1", 302], ["/cdn/img-2", 302],
    ]);
    expect(byResource(HARNESS_KEY.cdn)).toHaveLength(4);
    // Both files reached the describer's handoff buffer, and no URL the journal.
    expect(await scalar("select count(*)::int as n from sync_media_handoff where page_id = $1", [pageId])).toBe(2);
    expect(await scalar(
      "select count(*)::int as n from sync_attempts where page_id = $1 and request::text like '%/cdn/%'", [pageId])).toBe(0);
    expect(at("/api/v1/account/me")).toHaveLength(2);
    expect(at("/api/v1/trackinglinks")).toHaveLength(6);
    // The history reads went through the requests class, one arrival each.
    expect(at("/api/v1/message?")).toHaveLength(5);
    expect(await scalar(
      "select count(*)::int as n from sync_attempts where page_id = $1 and resource = 'dm-messages.history' and class = 'requests' and sent_at is not null",
      [pageId],
    )).toBe(5);
    expect(await scalar("select count(*)::int as n from history_requests where page_id = $1 and state = 'done'", [pageId])).toBe(1);
    // The proxy opened new tunnels along the way, some of them slowly.
    expect(r.proxy.tunnels).toBeGreaterThan(5);
  }, 120_000);

  it("timers that fire 50 ms early and a setting changed 300 → 600 → 300 ms: every gap follows the setting read at its admission", async (context) => {
    if (!testDb) return context.skip();
    const r = await rig();
    const { pageId } = r.page;
    for (let n = 1; n <= 60; n += 1) await demand(pageId, HARNESS_KEY.urgent, `u${String(n).padStart(2, "0")}`);
    const host = await startHost(r, { seed: 23, early: true });
    await until(async () => r.server.arrivals.length >= 8, 60_000, "8 sends at 300 ms");
    await setHarnessSetting(testDb.pool, 600);
    await until(async () => r.server.arrivals.length >= 18, 60_000, "10 more sends");
    await setHarnessSetting(testDb.pool, 300);
    await until(async () => r.server.arrivals.length >= 28, 60_000, "10 more sends");
    await host.stop();

    const arrivals = r.server.arrivals;
    const sent = await sentAttempts(pageId);
    expect(arrivals).toHaveLength(sent.length);
    expectJournalPaced(sent);
    // The arrival log against the setting each later request was admitted under.
    const short = gaps(arrivals).flatMap((gap, index) => (gap < sent[index + 1]!.setting_ms
      ? [{ attempt: sent[index + 1]!.id, gap, settingMs: sent[index + 1]!.setting_ms }]
      : []));
    expect(short).toEqual([]);
    // Both settings were read and obeyed: the raised one stretched gaps past
    // 600 ms, the lowered one let them shrink again (it is not sticky).
    const settings = sent.map((attempt) => attempt.setting_ms);
    expect(settings).toContain(600);
    expect(settings.lastIndexOf(300)).toBeGreaterThan(settings.indexOf(600));
    const gapsUnder = (settingMs: number) => gaps(arrivals).filter((_gap, index) => sent[index + 1]!.setting_ms === settingMs);
    expect(Math.min(...gapsUnder(600))).toBeGreaterThanOrEqual(600);
    expect(Math.min(...gapsUnder(300))).toBeLessThan(600);
  }, 120_000);
});

describe("restarts", () => {
  it("a graceful restart: the new owner's first send waits 1.2 × S after its takeover and after the last send", async (context) => {
    if (!testDb) return context.skip();
    const r = await rig();
    const { pageId } = r.page;
    for (let n = 1; n <= 40; n += 1) await demand(pageId, HARNESS_KEY.urgent, `u${String(n).padStart(2, "0")}`);
    const takeovers: TakeoverRecord[] = [];
    const first = await startHost(r, { seed: 31, takeovers });
    await until(async () => r.server.arrivals.length >= 6, 60_000, "6 sends of the first owner");
    await first.stop();
    const lastOfFirst = r.server.arrivals.at(-1)!;
    const firstCount = r.server.arrivals.length;
    const second = await startHost(r, { seed: 32, takeovers });
    await until(async () => r.server.arrivals.length >= firstCount + 6, 60_000, "6 sends of the second owner");
    await second.stop();

    expect(takeovers).toHaveLength(2);
    const takeover = takeovers[1]!;
    const firstOfSecond = r.server.arrivals[firstCount]!;
    expect(firstOfSecond.mono - takeover.mono).toBeGreaterThanOrEqual(TAKEOVER_FACTOR * S);
    expect(firstOfSecond.mono - lastOfFirst.mono).toBeGreaterThanOrEqual(TAKEOVER_FACTOR * S);
    expect(gaps(r.server.arrivals).filter((gap) => gap < S)).toEqual([]);
    const sent = await sentAttempts(pageId);
    expect(r.server.arrivals).toHaveLength(sent.length);
    expectJournalPaced(sent);
    const generations = await testDb.pool.query<{ g: string }>(
      "select distinct owner_generation::text as g from sync_attempts where page_id = $1 order by 1", [pageId]);
    expect(generations.rows.map((row) => row.g)).toEqual(["1", "2"]);
  }, 120_000);

  it("kill -9 of a real process mid-request: once its stop is confirmed, the next owner waits 1.2 × S past every send of the dead one", async (context) => {
    if (!testDb) return context.skip();
    const r = await rig();
    const { pageId } = r.page;
    // Every answer is held back, so the kill lands while a request is on the wire.
    r.server.answerDelayMs = 250;
    for (let n = 1; n <= 40; n += 1) await demand(pageId, HARNESS_KEY.urgent, `u${String(n).padStart(2, "0")}`);
    const child = spawnSyncChild("harness-live", {
      DATABASE_URL: testDb.connectionString,
      FANSLY_BASE_URL: r.server.apiBaseUrl,
      SYNC_TEST_HOSTNAME: "sync-dead",
      RNG_SEED: "41",
    });
    children.push(child);
    await child.ready;
    await until(async () => r.server.arrivals.length >= 5, 60_000, "5 sends of the doomed process");
    child.kill("SIGKILL");
    expect(await child.exited).toEqual({ code: null, signal: "SIGKILL" });
    const deadCount = r.server.arrivals.length;
    const lastOfDead = r.server.arrivals.at(-1)!;

    // No lock session, no safe release: the dead owner's stop is unconfirmed
    // until the operator confirms it (rule (e), `sync ownership confirm-stopped`).
    const confirmed = await confirmSyncOwnersStopped(db(), {
      runningHosts: ["sync-live", "sync-other"],
      ownHost: "sync-live",
      confirmedBy: "test",
      dryRun: false,
      pageIds: [pageId],
    });
    expect(confirmed).toHaveLength(1);
    const takeovers: TakeoverRecord[] = [];
    const next = await startHost(r, { seed: 42, takeovers, hostName: "sync-live" });
    await until(async () => r.server.arrivals.length >= deadCount + 4, 60_000, "4 sends of the next owner");
    await next.stop();

    expect(takeovers).toHaveLength(1);
    const firstOfNext = r.server.arrivals[deadCount]!;
    expect(firstOfNext.mono - takeovers[0]!.mono).toBeGreaterThanOrEqual(TAKEOVER_FACTOR * S);
    expect(firstOfNext.mono - lastOfDead.mono).toBeGreaterThanOrEqual(TAKEOVER_FACTOR * S);
    expect(gaps(r.server.arrivals).filter((gap) => gap < S)).toEqual([]);
    // The request the dead process had on the wire is `unknown` (recovered by
    // the next owner) and was not re-sent as the same attempt.
    const unknown = await scalar(
      "select count(*)::int as n from sync_attempts where page_id = $1 and owner_generation = 1 and outcome = 'unknown'", [pageId]);
    expect(unknown).toBe(1);
    const sent = await scalar("select count(*)::int as n from sync_attempts where page_id = $1 and sent_at is not null", [pageId]);
    expect(r.server.arrivals.length).toBeGreaterThanOrEqual(sent);
    expect(r.server.arrivals.length).toBeLessThanOrEqual(sent + unknown);
  }, 120_000);
});

describe("the send window", () => {
  it(`a dispatch whose tunnel comes up after ${SEND_WINDOW_MS / 1000} s is refused before a byte: no origin hit, the work goes on`, async (context) => {
    if (!testDb) return context.skip();
    const r = await rig();
    const { pageId } = r.page;
    // Every request needs its own tunnel; the first one takes 16 s.
    r.server.closeShare = 1;
    r.proxy.tunnelDelayMs = (index) => (index === 0 ? SEND_WINDOW_MS + 1_000 : 0);
    await demand(pageId, HARNESS_KEY.urgent, "late");
    const host = await startHost(r, { seed: 51 });
    await until(async () => (await scalar(
      "select count(*)::int as n from sync_work where page_id = $1 and resource = $2 and state = 'done'", [pageId, HARNESS_KEY.urgent],
    )) === 1, 60_000, "the read done on its second admission");
    await host.stop();

    const attempts = await testDb.pool.query<{ outcome: string; error_class: string | null; sent: boolean }>(
      `select outcome, error_class, sent_at is not null as sent from sync_attempts
        where page_id = $1 and resource = $2 order by id`,
      [pageId, HARNESS_KEY.urgent],
    );
    expect(attempts.rows).toEqual([
      { outcome: "aborted_before_send", error_class: "not_sent:send_deadline_passed", sent: false },
      { outcome: "response", error_class: null, sent: true },
    ]);
    expect(r.server.arrivalsAt("/api/v1/trackinglinks")).toHaveLength(1);
    // The late tunnel came up and carried nothing to the origin.
    expect(r.proxy.tunnels).toBeGreaterThanOrEqual(2);
    expect(r.proxy.bytesPerTunnel[0]).toBe(0);
  }, 90_000);
});
