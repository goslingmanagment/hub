import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { upsertDemand, type Database } from "@agency_hub_core/db";

import type { AppContext } from "../apps/runtime/src/bootstrap.ts";
import { downloadThroughSyncEngine } from "../apps/runtime/src/services/ai-media-describe/engine-download.ts";
import { downloadAiMediaForDescribe } from "../apps/runtime/src/services/ai-media-describe/worker.ts";
import { SyncCrashFault, type SyncLogger } from "../apps/runtime/src/sync/engine/commit.ts";
import { SyncEngineHost } from "../apps/runtime/src/sync/engine/host.ts";
import { createEngineRegistry } from "../apps/runtime/src/sync/engine/resource.ts";
import { fanslyResourceSpec } from "../apps/runtime/src/sync/fansly/registry.ts";
import { createMediaDownloadModule } from "../apps/runtime/src/sync/fansly/resources/media-download.ts";
import { resetIntegrationDatabase, startIntegrationTestDatabase, type StartedTestDatabase } from "./helpers/db.ts";
import { quietLogger, RecordingAlerts, setModeDirect } from "./helpers/sync-engine-host.ts";
import {
  CountingConnectProxy,
  demandHarnessDownload,
  ensureHarnessSettingTable,
  FakeFanslyServer,
  harnessCdnUrlAllowed,
  harnessConfig,
  harnessHostOptions,
  harnessRng,
  harnessRoutes,
  FakeChats,
  HARNESS_KEY,
  seedHarnessPage,
  until,
  type HarnessPage,
} from "./helpers/sync-engine.ts";

// `media-download.fetch` (design S3-04 items 6–7; owner decision №17): the AI
// describer's CDN download of a chat file as requests of a live page, through
// the production host, page transport and resource against a fake CDN behind
// the page proxy. Pinned: one admission per hop (a 302 is the next admission,
// ≥ S after the first), the Fansly-CDN URL policy on the signed URL and on
// every redirect, the 5 MiB cap, a CDN 401/403 that never holds the page and a
// 429 that does, the bytes handed over through the transient buffer (and
// consumed by the describer's read, also by a retry after a wait that ran
// out — with no new request), the signed URL absent from every journal, row
// and log line, and an answer that lived in memory and was lost in a crash
// read again instead of re-applied.

const S = 300;
const SECRET = "Signature=SIGNED-URL-SECRET";

let testDb: StartedTestDatabase | null = null;
let server: FakeFanslyServer | null = null;
let proxy: CountingConnectProxy | null = null;
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
  await proxy?.close();
  server = null;
  proxy = null;
});

function db(): Database {
  return testDb!.db as unknown as Database;
}

interface Rig {
  server: FakeFanslyServer;
  page: HarnessPage;
  config: ReturnType<typeof harnessConfig>;
}

/** The fake CDN's special files besides `/cdn/<name>` (302 → `/cdn/final/<name>` → the bytes). */
function cdnRoutes(fake: FakeFanslyServer) {
  const at = (path: string) => (request: { url: URL }) => request.url.pathname === path;
  fake.route((request) => (at("/cdn/expired")(request) ? { status: 403, body: "expired" } : null));
  fake.route((request) => (at("/cdn/busy")(request) ? { status: 429, body: "slow down" } : null));
  fake.route((request) => (at("/cdn/huge")(request)
    ? { status: 200, headers: { "content-type": "image/jpeg" }, body: Buffer.alloc(6 * 1024 * 1024, 7) }
    : null));
  fake.route((request) => (at("/cdn/evil")(request) ? { status: 302, headers: { location: "http://evil.example/x.jpg" } } : null));
  fake.route((request) => {
    const loop = /^\/cdn\/loop\/(\d+)$/.exec(request.url.pathname);
    return loop === null ? null : { status: 302, headers: { location: `/cdn/loop/${Number(loop[1]) + 1}` } };
  });
}

async function rig(): Promise<Rig> {
  server = await FakeFanslyServer.start();
  proxy = await CountingConnectProxy.start();
  cdnRoutes(server);
  for (const route of harnessRoutes(new FakeChats())) server.route(route);
  const page = await seedHarnessPage({ db: db(), pool: testDb!.pool }, { mode: "live", proxyUrl: proxy.url });
  return { server, page, config: harnessConfig(testDb!.connectionString, server.apiBaseUrl) };
}

function recordingLogger(lines: string[]): SyncLogger {
  const record = (obj: object, msg?: string) => {
    lines.push(`${msg ?? ""} ${JSON.stringify(obj)}`);
  };
  return { debug: record, info: record, warn: record, error: record };
}

/** Only the download (no standing poll): every capture of the run is a hop. */
function downloadOnlyRegistry() {
  return createEngineRegistry([
    { ...fanslyResourceSpec("media-download.fetch")!, module: async () => createMediaDownloadModule({ urlAllowed: harnessCdnUrlAllowed }) },
  ]);
}

async function startHost(r: Rig, options: {
  seed: number;
  logger?: SyncLogger;
  alerts?: RecordingAlerts;
  faults?: (point: string) => void;
  registry?: ReturnType<typeof createEngineRegistry>;
}) {
  const host = new SyncEngineHost(harnessHostOptions({
    db: db(),
    pool: testDb!.pool,
    connectionString: testDb!.connectionString,
    config: r.config,
    rng: harnessRng(options.seed),
    ...(options.registry === undefined ? {} : { registry: options.registry }),
    ...(options.logger === undefined ? {} : { logger: options.logger }),
    ...(options.alerts === undefined ? {} : { alerts: options.alerts }),
    ...(options.faults === undefined ? {} : { faults: options.faults }),
  }));
  hosts.push(host);
  await host.start();
  return host;
}

async function download(r: Rig, path: string) {
  return demandHarnessDownload({ db: db(), pool: testDb!.pool }, { pageId: r.page.pageId, config: r.config, url: `${r.server.origin}${path}` });
}

async function work(workId: number) {
  const result = await testDb!.pool.query<{
    state: string; close_reason: string | null; result: Record<string, unknown> | null; secret: boolean;
    waiting_reason: string | null; cursor: Record<string, unknown>;
  }>(
    `select state, close_reason, result, secret_params is not null as secret, waiting_reason, cursor
       from sync_work where id = $1`,
    [workId],
  );
  return result.rows[0]!;
}

async function closed(workId: number, timeoutMs = 30_000) {
  await until(async () => (await work(workId)).state === "done", timeoutMs, `work ${workId} closed`);
  return work(workId);
}

async function scalar(text: string, values: unknown[] = []): Promise<number> {
  const result = await testDb!.pool.query<{ n: number }>(text, values);
  return Number(result.rows[0]?.n ?? 0);
}

async function attempts(workId: number) {
  const result = await testDb!.pool.query<{
    request: Record<string, unknown>; http_status: number | null; apply_state: string; apply_error: string | null; sent: boolean;
  }>(
    `select request, http_status, apply_state, apply_error, sent_at is not null as sent
       from sync_attempts where work_id = $1 order by id`,
    [workId],
  );
  return result.rows;
}

const cdnArrivals = (r: Rig) => r.server.arrivalsAt("/cdn/").map((arrival) => [arrival.path, arrival.status]);

describe("media-download.fetch on a live page", () => {
  it("walks a 302 as the next admission ≥ S later, hands the bytes over, and keeps the signed URL out of every journal and log", async (context) => {
    if (!testDb) return context.skip();
    const r = await rig();
    const lines: string[] = [];
    const { workId, descriptionId } = await download(r, `/cdn/img-1?${SECRET}`);
    await upsertDemand(db(), { pageId: r.page.pageId, shadow: false, resource: HARNESS_KEY.urgent, subject: "u1", kind: "trigger", class: "urgent" });
    await startHost(r, { seed: 61, logger: recordingLogger(lines) });
    const row = await closed(workId);

    expect(cdnArrivals(r)).toEqual([[`/cdn/img-1?${SECRET}`, 302], ["/cdn/final/img-1", 200]]);
    const [first, second] = r.server.arrivalsAt("/cdn/");
    expect(second!.mono - first!.mono).toBeGreaterThanOrEqual(S);
    const hops = await attempts(workId);
    expect(hops.map((hop) => [hop.request.hop, hop.http_status, hop.apply_state, hop.sent])).toEqual([[0, 302, "applied", true], [1, 200, "applied", true]]);
    for (const hop of hops) {
      expect(Object.keys(hop.request).sort()).toEqual(["hop", "host", "params", "pathSha256", "spec"]);
      expect(hop.request.pathSha256).toMatch(/^[0-9a-f]{64}$/);
    }
    expect(row.close_reason).toBe("downloaded");
    expect(row.secret).toBe(false);
    expect(row.result).toMatchObject({ contentType: "image/jpeg", bytes: "jpeg:img-1".length, hops: 2 });
    const handoff = await testDb.pool.query<{ bytes: Buffer; description_id: string; work_id: string }>(
      "select bytes, description_id::text, work_id::text from sync_media_handoff where id = $1", [row.result!.handoffId]);
    expect(handoff.rows[0]?.bytes.toString()).toBe("jpeg:img-1");
    expect(handoff.rows[0]?.description_id).toBe(String(descriptionId));
    expect(handoff.rows[0]?.work_id).toBe(String(workId));
    // No observation: the bytes are not a captured fact (owner decision №17).
    expect(await scalar("select count(*)::int as n from observations where account_id = $1 and producer like 'fansly-sync:media-download%'", [r.page.pageId])).toBe(0);

    // J7: the signed URL is in the work's ciphertext only, never in a row a
    // reader sees or a log line.
    for (const [table, columns] of [
      ["sync_attempts", "request::text || coalesce(error_class, '') || coalesce(apply_error, '')"],
      ["sync_work", "params::text || coalesce(result::text, '') || cursor::text || demand::text || coalesce(close_reason, '') || coalesce(last_error_class, '')"],
      ["observations", "payload::text"],
    ] as const) {
      expect(await scalar(`select count(*)::int as n from ${table} where (${columns}) like '%SIGNED-URL%'`), table).toBe(0);
      expect(await scalar(`select count(*)::int as n from ${table} where (${columns}) like '%/cdn/%'`), table).toBe(0);
    }
    expect(lines.length).toBeGreaterThan(0);
    expect(lines.filter((line) => line.includes("SIGNED-URL") || line.includes("/cdn/"))).toEqual([]);
  }, 60_000);

  it("requests only Fansly CDN URLs: an off-CDN URL is never sent, a redirect off the CDN or a third redirect ends the download", async (context) => {
    if (!testDb) return context.skip();
    const r = await rig();
    const offCdn = await demandHarnessDownload({ db: db(), pool: testDb.pool }, { pageId: r.page.pageId, config: r.config, url: "http://evil.example/x.jpg" });
    const evil = await download(r, "/cdn/evil");
    const loop = await download(r, "/cdn/loop/0");
    await startHost(r, { seed: 62 });

    expect(await closed(offCdn.workId)).toMatchObject({ close_reason: "host_not_allowed", result: { failure: "host_not_allowed", httpStatus: null }, secret: false });
    expect(await attempts(offCdn.workId)).toEqual([]);
    expect(await closed(evil.workId)).toMatchObject({ result: { failure: "redirect_not_allowed", httpStatus: 302 }, secret: false });
    expect(await closed(loop.workId)).toMatchObject({ result: { failure: "too_many_redirects", httpStatus: 302 } });
    expect((await attempts(loop.workId)).map((hop) => hop.request.hop)).toEqual([0, 1, 2]);
    expect(cdnArrivals(r).map(([path]) => path).sort()).toEqual(["/cdn/evil", "/cdn/loop/0", "/cdn/loop/1", "/cdn/loop/2"]);
    expect(await scalar("select count(*)::int as n from sync_media_handoff")).toBe(0);
  }, 60_000);

  it("caps a file at 5 MiB: an answer, not the page's network failure", async (context) => {
    if (!testDb) return context.skip();
    const r = await rig();
    const huge = await download(r, "/cdn/huge");
    await startHost(r, { seed: 63 });
    expect(await closed(huge.workId)).toMatchObject({ result: { failure: "too_large", httpStatus: 200 } });
    expect(await scalar("select count(*)::int as n from sync_media_handoff")).toBe(0);
    expect(await scalar("select network_failure_streak::int as n from sync_pages where page_id = $1", [r.page.pageId])).toBe(0);
  }, 60_000);

  it("a CDN 403 is the signed URL's: the download fails, the page holds nothing, the next REST work goes out", async (context) => {
    if (!testDb) return context.skip();
    const r = await rig();
    const alerts = new RecordingAlerts();
    const expired = await download(r, "/cdn/expired");
    await startHost(r, { seed: 64, alerts });
    expect(await closed(expired.workId)).toMatchObject({ close_reason: "subject_terminal:403", result: { failure: "http_status", httpStatus: 403 } });
    expect(await scalar("select count(*)::int as n from sync_holds where page_id = $1 and scope = 'page'", [r.page.pageId])).toBe(0);
    await upsertDemand(db(), { pageId: r.page.pageId, shadow: false, resource: HARNESS_KEY.urgent, subject: "after", kind: "trigger", class: "urgent" });
    await until(async () => r.server.arrivalsAt("/api/v1/trackinglinks").length === 1, 30_000, "the next REST read");
    expect(alerts.opened.filter((alert) => alert.detail === "auth")).toEqual([]);
  }, 60_000);

  it("a CDN 429 holds the CDN route like any route's 429 (owner decision №22), never the page: REST goes on", async (context) => {
    if (!testDb) return context.skip();
    const r = await rig();
    const alerts = new RecordingAlerts();
    const busy = await download(r, "/cdn/busy");
    await startHost(r, { seed: 65, alerts });
    await until(async () => (await scalar(
      "select count(*)::int as n from sync_holds where page_id = $1 and scope = 'route' and key = 'cdn.media' and kind = 'route_hold'",
      [r.page.pageId])) === 1, 30_000, "the CDN route's hold");
    expect(await scalar("select count(*)::int as n from sync_holds where page_id = $1 and scope = 'page'", [r.page.pageId])).toBe(0);
    expect(await work(busy.workId)).toMatchObject({ state: "open", waiting_reason: null, secret: true });
    expect(alerts.opened.filter((alert) => alert.subKey === "route_limited").map((alert) => [alert.route, alert.detail]))
      .toEqual([["cdn.media", "rate_limit"]]);
    await upsertDemand(db(), { pageId: r.page.pageId, shadow: false, resource: HARNESS_KEY.urgent, subject: "beside", kind: "trigger", class: "urgent" });
    await until(async () => r.server.arrivalsAt("/api/v1/trackinglinks").length === 1, 30_000, "a REST read beside the held CDN");
    expect(cdnArrivals(r)).toEqual([["/cdn/busy", 429]]);
  }, 60_000);
});

describe("the AI describer's download of a live page's file", () => {
  it("gets the bytes through the actor; a retry after a wait that ran out takes the closed download's bytes with no new request", async (context) => {
    if (!testDb) return context.skip();
    const r = await rig();
    await startHost(r, { seed: 71 });
    const describe = (descriptionId: number, name: string, waitMs: number) => downloadThroughSyncEngine(
      { db: db(), config: r.config, waitMs, urlAllowed: harnessCdnUrlAllowed },
      { pageId: r.page.pageId, descriptionId, url: `${r.server.origin}/cdn/${name}?${SECRET}` },
    );
    const description = async (ref: string) => Number((await testDb!.pool.query<{ id: string }>(
      `insert into ai_media_descriptions (page_id, platform, media_ref, variant, media_kind, sender_role, status)
       values ($1, 'fansly', $2, 'full', 'photo', 'fan', 'pending') returning id::text as id`, [r.page.pageId, ref])).rows[0]!.id);

    const first = await describe(await description("m-1"), "img-7", 30_000);
    expect(first).toEqual({ ok: true, bytes: Buffer.from("jpeg:img-7"), contentType: "image/jpeg" });
    // Consumed by the read.
    expect(await scalar("select count(*)::int as n from sync_media_handoff")).toBe(0);

    const late = await description("m-2");
    expect(await describe(late, "img-8", 1)).toEqual({ ok: false, reason: "timeout", httpStatus: null });
    await until(async () => (await scalar(
      "select count(*)::int as n from sync_work where subject = $1 and state = 'done'", [`desc:${late}`])) === 1, 30_000, "the late download");
    const hits = r.server.arrivalsAt("/cdn/").length;
    expect(await describe(late, "img-8", 30_000)).toEqual({ ok: true, bytes: Buffer.from("jpeg:img-8"), contentType: "image/jpeg" });
    expect(r.server.arrivalsAt("/cdn/")).toHaveLength(hits);
    expect(await scalar("select count(*)::int as n from sync_work where subject = $1", [`desc:${late}`])).toBe(1);
    expect(await scalar("select count(*)::int as n from sync_media_handoff")).toBe(0);
  }, 90_000);

  it("routes by the page's mode: through the actor on a live page, nothing while it switches", async (context) => {
    if (!testDb) return context.skip();
    const r = await rig();
    const app = { db: db(), config: r.config, logger: quietLogger } as unknown as AppContext;
    const input = { pageId: r.page.pageId, descriptionId: 1, url: "https://cdn3.fansly.com/x.jpg" };
    await setModeDirect(testDb.pool, r.page.pageId, "handover");
    expect(await downloadAiMediaForDescribe(app, input)).toEqual({ ok: false, reason: "send_guard", httpStatus: null });
    expect(await scalar("select count(*)::int as n from sync_work where page_id = $1", [r.page.pageId])).toBe(0);
    await setModeDirect(testDb.pool, r.page.pageId, "live");
    // Live: the actor's queue (no actor runs here). A download of the same
    // description already queued answers at once — the next retry's.
    const queued = await download(r, "/cdn/img-3");
    const descriptionId = Number((await testDb.pool.query<{ subject: string }>(
      "select subject from sync_work where id = $1", [queued.workId])).rows[0]!.subject.slice("desc:".length));
    expect(await downloadAiMediaForDescribe(app, { ...input, descriptionId })).toEqual({ ok: false, reason: "timeout", httpStatus: null });
    expect(await scalar("select count(*)::int as n from sync_work where page_id = $1 and resource = 'media-download.fetch'", [r.page.pageId])).toBe(1);
    // An off-CDN URL never reaches the queue.
    expect(await downloadAiMediaForDescribe(app, { ...input, url: "https://example.com/x.jpg" }))
      .toEqual({ ok: false, reason: "host_not_allowed", httpStatus: null });
  }, 60_000);

  it("an answer lost in a crash between capture and apply is read again, never re-applied", async (context) => {
    if (!testDb) return context.skip();
    const r = await rig();
    const { workId } = await download(r, "/cdn/img-9");
    let crashed = false;
    await startHost(r, {
      seed: 72,
      registry: downloadOnlyRegistry(),
      faults: (point) => {
        if (point === "after_capture" && !crashed) {
          crashed = true;
          throw new SyncCrashFault("after_capture");
        }
      },
    });
    const row = await closed(workId, 45_000);
    expect(row.result).toMatchObject({ hops: 2 });
    const hops = await attempts(workId);
    expect(hops.map((hop) => [hop.request.hop, hop.http_status, hop.apply_state, hop.apply_error])).toEqual([
      [0, 302, "skipped", "answer_lost_at_restart"],
      [0, 302, "applied", null],
      [1, 200, "applied", null],
    ]);
    expect(cdnArrivals(r)).toEqual([["/cdn/img-9", 302], ["/cdn/img-9", 302], ["/cdn/final/img-9", 200]]);
  }, 60_000);
});
