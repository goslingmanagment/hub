import { randomUUID } from "node:crypto";

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";

import {
  acquireSyncPageOwnership,
  ensurePostRepliesWalkRow,
  insertPageBrowser,
  markBrowserWsLoss,
  readFanslyWsGapPass,
  readSyncLivePathFacts,
  stampFanslyWsGapReconciled,
  type Database,
} from "@agency_hub_core/db";
import type { AppConfig } from "@agency_hub_core/shared";

import type { BufferEvent } from "../apps/page-browser/src/rpc/protocol.ts";
import type { Metrics, SyncMetricLabels } from "../apps/runtime/src/sync/engine/ports.ts";
import { readPageBrowserLinkRevision, readPageBrowserLinkSettings, sealPageBrowserSecrets } from "../apps/runtime/src/services/egress/page-browser-link.ts";
import { PageBrowserRpcClient, type PageBrowserRpcTiming } from "../apps/runtime/src/services/egress/page-browser-rpc.ts";
import { createFanslyWsLiveApplier } from "../apps/runtime/src/services/fansly-ws/live-apply.ts";
import { createEngineRegistry, type ResourceModule } from "../apps/runtime/src/sync/engine/resource.ts";
import { BROWSER_INTAKE_RECENT_BATCHES, BrowserBufferIntake, BrowserIntakeCrash, type BrowserIntakeFaultHook } from "../apps/runtime/src/sync/fansly/browser-intake.ts";
import { readBrowserCredentialsGeneration } from "../apps/runtime/src/sync/fansly/browser-transport.ts";
import { fanslyResourceSpec } from "../apps/runtime/src/sync/fansly/registry.ts";
import { BrowserWsSource } from "../apps/runtime/src/sync/fansly/ws/browser-source.ts";
import { resetIntegrationDatabase, startIntegrationTestDatabase, type StartedTestDatabase } from "./helpers/db.ts";
import { serviceFrame, wrapped } from "./helpers/fansly-ws-fixtures.ts";
import { FakeOperator, OPERATOR_TOKEN, SESSION_A, SESSION_B } from "./helpers/page-browser-operator.ts";
import { HARNESS_OWN_REF, harnessConfig, seedHarnessPage, until, type HarnessPage } from "./helpers/sync-engine.ts";
import { countRows, quietLogger, testOwner, testSpec } from "./helpers/sync-engine-host.ts";
import { WS_AUTH_REFUSED_FRAME, WS_NOOP_FRAME, WS_PONG_FRAME, WS_SESSION_FRAME } from "./helpers/sync-ws.ts";

// The intake of a page's operator buffer (Project Browser plan §3.2 «Приём
// буфера и восстановление», «Кадры сокета», «Ответы на собственные
// API-запросы сайта», §4.4; stage 3 PR 13, row 13's checks) against a fake
// operator streaming its buffer through the operator's own EventStream:
// - frames by event id (`browser:<buffer id>:<number>`) into the socket's
//   pipeline (observation, decode receipt, the live overlay), fenced by the
//   page and the session — a frame from the buffer after its connection
//   closed is taken, one of a connection the page never opened is not;
// - a break at every transaction boundary — a crash before the commit,
//   after the commit before the ack, an ack lost — loses nothing and
//   duplicates nothing; the same events delivered again change nothing;
// - a volume made anew: the intake starts over with the new buffer, a late
//   ack of the old one acknowledges nothing of it;
// - gaps of every reason, with a known boundary and with none, lower the
//   next connection's gap_since, and its verification asks for the repair;
// - the site's answers into observations (`browser_site`) through the codec.

const PROXY = "socks5://127.0.0.1:1080";
const TIMING: Partial<PageBrowserRpcTiming> = { pingMs: 100, linkLossMs: 1_000, helloTimeoutMs: 1_000, reconnectMs: [50, 100], refusedRetryMs: 500 };
const INTAKE_TIMING = { retryMs: [50, 100], bodyRetryMs: 50 };
const POLL_KEY = "browser.polls";
/** A hang guard for a test of several awaited events (a loaded CI machine). */
const LONG_TEST_MS = 120_000;

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

function registry() {
  const poll: ResourceModule = {
    plan: async () => ({ kind: "request", request: { spec: "polls", params: {} } }),
    apply: async () => ({ work: { satisfiesRevision: true }, followups: [] }),
  };
  return createEngineRegistry([
    fanslyResourceSpec("repair.ws-gap")!,
    fanslyResourceSpec("account.verify")!,
    fanslyResourceSpec("dm-messages.head")!,
    fanslyResourceSpec("dm-messages.catchup")!,
    fanslyResourceSpec("post-replies.walk")!,
    testSpec(POLL_KEY, poll, { kind: "poll", class: "planned", period: { everyMs: 3_600_000 }, operations: ["polls"] }),
  ]);
}

/** Metrics with their labels: a count of a name whose labels include
 *  `labels`. */
class LabelledMetrics implements Metrics {
  readonly seen: Array<{ name: string; labels: SyncMetricLabels; by: number }> = [];
  increment(name: string, labels: SyncMetricLabels = {}, by = 1): void {
    this.seen.push({ name, labels, by });
  }
  count(name: string, labels: SyncMetricLabels = {}): number {
    return this.seen
      .filter((one) => one.name === name && Object.entries(labels).every(([key, value]) => one.labels[key] === value))
      .reduce((sum, one) => sum + one.by, 0);
  }
}

const PAGE_SETTINGS = {
  pinnedExitIp: "203.0.113.7",
  env: { timeZone: "Europe/Berlin", languages: ["en-US", "en"], geolocation: { latitude: 52.5, longitude: 13.4, accuracyM: 50 } },
};

interface Engine {
  generation: bigint;
  client: PageBrowserRpcClient;
  source: BrowserWsSource;
  intake: BrowserBufferIntake;
  metrics: LabelledMetrics;
  /** The engine dies: nothing more is committed or acknowledged. */
  crash(): Promise<void>;
}

interface Rig {
  page: HarnessPage;
  operator: FakeOperator;
  /** The engine (re)started: a new owner generation, a new link, a new intake. */
  start(options?: { faults?: BrowserIntakeFaultHook; live?: boolean }): Promise<Engine>;
}

async function rig(): Promise<Rig> {
  const operator = await FakeOperator.start({ accountId: HARNESS_OWN_REF });
  cleanups.push(() => operator.close());
  const label = `intake-${randomUUID().slice(0, 8)}`;
  const page = await seedHarnessPage({ db: db(), pool: testDb!.pool }, { mode: "live", proxyUrl: PROXY, label });
  await insertPageBrowser(db(), {
    profileId: randomUUID(),
    container: `page-browser-${label}`,
    pageId: page.pageId,
    ...sealPageBrowserSecrets(config(), { engineToken: OPERATOR_TOKEN, apiToken: "api-token", vncPassword: "vnc-password" }),
  });
  // The engine trusts the session the site's socket opens under.
  const trusted = await readBrowserCredentialsGeneration(db(), page.pageId, SESSION_A);
  await testDb!.pool.query("update sync_pages set credentials_generation = $2 where page_id = $1", [page.pageId, trusted]);
  return {
    page,
    operator,
    async start(options = {}) {
      const acquired = await acquireSyncPageOwnership(db(), { pageId: page.pageId, owner: testOwner(), judgePreviousOwner: () => "test_confirmed_dead" });
      if (acquired.kind !== "acquired") throw new Error(`could not acquire the page: ${acquired.kind}`);
      const client = new PageBrowserRpcClient({
        url: operator.url,
        ownerGeneration: acquired.generation,
        settings: () => readPageBrowserLinkSettings({ db: db(), config: config() }, page.pageId, PAGE_SETTINGS),
        revision: () => readPageBrowserLinkRevision({ db: db() }, page.pageId, PAGE_SETTINGS),
        timing: TIMING,
      });
      const source = new BrowserWsSource({ db: db(), pageId: page.pageId });
      const metrics = new LabelledMetrics();
      const applier = options.live === true ? createFanslyWsLiveApplier({ db: db(), logger: quietLogger as never }) : null;
      const intake = new BrowserBufferIntake({
        db: db(),
        pageId: page.pageId,
        generation: acquired.generation,
        ownRef: HARNESS_OWN_REF,
        client,
        source,
        registry: registry(),
        logger: quietLogger,
        metrics,
        timing: INTAKE_TIMING,
        ...(applier === null ? {} : { applyLive: (id: number) => applier.enqueue(id) }),
        ...(options.faults === undefined ? {} : { faults: options.faults }),
      });
      let crashed = false;
      const crash = async () => {
        if (crashed) return;
        crashed = true;
        await intake.stop();
        await client.close();
        await applier?.drain(1_000);
      };
      cleanups.push(crash);
      client.start();
      intake.start();
      await until(async () => client.up, 5_000, "the link to the operator");
      return { generation: acquired.generation, client, source, intake, metrics, crash };
    },
  };
}

interface FrameRow {
  idempotencyKey: string;
  frame: string;
  generation: string;
}

/** The frames journaled under `kind` (default: the ones applied). */
async function frames(pageId: number, kind = "fansly.ws.frame.v1"): Promise<FrameRow[]> {
  const result = await testDb!.pool.query<FrameRow>(
    `select k.idempotency_key as "idempotencyKey", o.payload->>'frame' as frame, o.payload->>'generation' as generation
       from observations o join observation_keys k on k.observation_id = o.id and k.received_at = o.received_at
      where o.account_id = $1 and o.source = 'fansly_ws' and o.kind = $2 order by o.id`,
    [pageId, kind],
  );
  return result.rows;
}

interface ConnectionRow {
  browserConnectionId: string;
  generation: string;
  startedAt: Date;
  closedAt: Date | null;
  verifiedAt: Date | null;
  gapSince: Date;
  lastCaptureAt: Date | null;
}

async function connections(pageId: number): Promise<ConnectionRow[]> {
  const result = await testDb!.pool.query<ConnectionRow>(
    `select browser_connection_id::text as "browserConnectionId", generation, started_at as "startedAt", closed_at as "closedAt",
            verified_at as "verifiedAt", gap_since as "gapSince", last_capture_at as "lastCaptureAt"
       from fansly_ws_connections where page_id = $1 order by started_at, id`,
    [pageId],
  );
  return result.rows;
}

async function position(pageId: number): Promise<{ bufferId: string | null; ackedSeq: number; lastWall: Date | null; gapSince: Date | null; haltedBufferId: string | null }> {
  const result = await testDb!.pool.query<{ bufferId: string | null; ackedSeq: string; lastWall: Date | null; gapSince: Date | null; haltedBufferId: string | null }>(
    `select events_buffer_id::text as "bufferId", events_acked_seq::text as "ackedSeq", events_last_wall as "lastWall", events_gap_since as "gapSince",
            events_halted_buffer_id::text as "haltedBufferId"
       from page_browsers where page_id = $1`,
    [pageId],
  );
  const row = result.rows[0]!;
  return { ...row, ackedSeq: Number(row.ackedSeq) };
}

async function demands(pageId: number, resource: string): Promise<number> {
  return countRows(testDb!.pool, "select count(*)::int as n from sync_work where page_id = $1 and resource = $2", [pageId, resource]);
}

async function committedUpTo(pageId: number, seq: number): Promise<void> {
  await until(async () => (await position(pageId)).ackedSeq >= seq, 10_000, `the events up to ${seq} committed`);
}

/** The repair of the page's socket ran: its rows reconciled, its work gone. */
async function repaired(pageId: number): Promise<void> {
  // As the repair stamps them (`stampFanslyWsGapReconciled`).
  await testDb!.pool.query(
    `update fansly_ws_connections set state_reconciled_at = now(), transient_unknown = tstzrange(least(gap_since, verified_at), verified_at)
      where page_id = $1 and verified_at is not null`,
    [pageId],
  );
  await testDb!.pool.query("delete from sync_work where page_id = $1 and resource = 'repair.ws-gap'", [pageId]);
}

/** A connection's life on the operator's side: open, the session, frames. */
function open(operator: FakeOperator, connectionId: string, atWall?: number): BufferEvent {
  return operator.append({ kind: "ws.open", connectionId, attemptId: 1, sessionFingerprint: SESSION_A }, atWall);
}

function frame(operator: FakeOperator, connectionId: string, text: string, atWall?: number): BufferEvent {
  return operator.append({ kind: "ws.in", connectionId, frame: text }, atWall);
}

function close(operator: FakeOperator, connectionId: string, atWall?: number): BufferEvent {
  return operator.append({ kind: "ws.close", connectionId, code: 1006, reason: null }, atWall);
}

describe("frames by event id", () => {
  it("a connection's frames go into the socket's pipeline under their event id, fenced by the page and the session, and are acknowledged after the commit", async (context) => {
    if (!testDb) return context.skip();
    const r = await rig();
    const engine = await r.start({ live: true });
    const connectionId = randomUUID();
    const message = {
      id: "900000000000000101", groupId: "800000000000000001", senderId: "700000000000000001", createdAt: Date.now() / 1000 - 1,
      content: "hello", attachments: [], type: 1, correlationId: null, inReplyTo: null,
    };
    const business = serviceFrame({ type: 1, message });
    open(r.operator, connectionId);
    frame(r.operator, connectionId, WS_SESSION_FRAME);
    const captured = frame(r.operator, connectionId, business);
    frame(r.operator, connectionId, WS_PONG_FRAME);
    const last = frame(r.operator, connectionId, WS_NOOP_FRAME);
    await committedUpTo(r.page.pageId, last.seq);
    const rows = await frames(r.page.pageId);
    const generation = await readBrowserCredentialsGeneration(db(), r.page.pageId, SESSION_A);
    // Only business frames are journaled, as the engine's own socket does.
    expect(rows.map((row) => row.idempotencyKey)).toEqual([`browser:${r.operator.buffer.id}:${captured.seq}`, `browser:${r.operator.buffer.id}:${last.seq}`]);
    expect(rows[0]).toMatchObject({ frame: business, generation });
    expect(await countRows(testDb.pool, "select count(*)::int as n from fansly_ws_decode_receipts where page_id = $1", [r.page.pageId])).toBe(2);
    // The live overlay applies it as every captured frame.
    await until(async () => (await countRows(testDb!.pool, "select count(*)::int as n from dm_live_messages where page_id = $1", [r.page.pageId])) === 1, 10_000, "the live overlay");
    // The session's confirmation verified the connection and asked for its repair.
    const [row] = await connections(r.page.pageId);
    expect(row).toMatchObject({ browserConnectionId: connectionId, generation, closedAt: null });
    expect(row!.verifiedAt).not.toBeNull();
    expect(row!.lastCaptureAt).not.toBeNull();
    expect(await demands(r.page.pageId, "repair.ws-gap")).toBe(1);
    // Acknowledged after the commit: the operator dropped them.
    await until(async () => r.operator.buffer.acknowledged === last.seq, 5_000, "the ack");
    expect(r.operator.buffer.kept).toEqual([]);
    expect(await position(r.page.pageId)).toMatchObject({ bufferId: r.operator.buffer.id, ackedSeq: last.seq });
    await engine.crash();
  }, 60_000);

  it("a frame from the buffer after its connection closed is taken; one of a connection the page never opened is kept as a fact, never applied, and acknowledged", async (context) => {
    if (!testDb) return context.skip();
    const r = await rig();
    await r.start();
    const connectionId = randomUUID();
    open(r.operator, connectionId);
    close(r.operator, connectionId);
    const late = frame(r.operator, connectionId, WS_NOOP_FRAME);
    const foreign = frame(r.operator, randomUUID(), WS_NOOP_FRAME);
    await committedUpTo(r.page.pageId, foreign.seq);
    const rows = await frames(r.page.pageId);
    expect(rows.map((row) => row.idempotencyKey)).toEqual([`browser:${r.operator.buffer.id}:${late.seq}`]);
    expect((await frames(r.page.pageId, "fansly.ws.frame.v1:unattributed")).map((row) => row.idempotencyKey)).toEqual([`browser:${r.operator.buffer.id}:${foreign.seq}`]);
    expect(await countRows(testDb.pool, "select count(*)::int as n from fansly_ws_decode_receipts where page_id = $1", [r.page.pageId])).toBe(1);
    expect((await connections(r.page.pageId))[0]!.closedAt).not.toBeNull();
    await until(async () => r.operator.buffer.acknowledged === foreign.seq, 5_000, "the ack of both");
  }, 60_000);

  it("the socket's refusal of the session asks for the identity check", async (context) => {
    if (!testDb) return context.skip();
    const r = await rig();
    await r.start();
    const connectionId = randomUUID();
    open(r.operator, connectionId);
    const refused = frame(r.operator, connectionId, WS_AUTH_REFUSED_FRAME);
    await committedUpTo(r.page.pageId, refused.seq);
    expect(await demands(r.page.pageId, "account.verify")).toBe(1);
    expect(await frames(r.page.pageId)).toEqual([]);
  }, 60_000);
});

describe("a break at every transaction boundary", () => {
  it("a crash before the commit: nothing of the batch is written; after the restart every event is taken once", async (context) => {
    if (!testDb) return context.skip();
    const r = await rig();
    const connectionId = randomUUID();
    open(r.operator, connectionId);
    frame(r.operator, connectionId, WS_SESSION_FRAME);
    frame(r.operator, connectionId, WS_NOOP_FRAME);
    const last = frame(r.operator, connectionId, serviceFrame({ type: 99, n: 2 }, 99));
    const first = await r.start({ faults: (point) => {
      if (point === "in_batch") throw new BrowserIntakeCrash(point);
    } });
    await until(async () => first.intake.stopReason !== null, 10_000, "the crash");
    expect(first.intake.stopReason).toBe("crash:in_batch");
    await first.crash();
    expect(await frames(r.page.pageId)).toEqual([]);
    expect(await connections(r.page.pageId)).toEqual([]);
    expect(await position(r.page.pageId)).toMatchObject({ bufferId: null, ackedSeq: 0 });
    expect(r.operator.buffer.acknowledged).toBe(0);

    await r.start();
    await committedUpTo(r.page.pageId, last.seq);
    expect((await frames(r.page.pageId)).map((row) => row.idempotencyKey)).toEqual([
      `browser:${r.operator.buffer.id}:3`,
      `browser:${r.operator.buffer.id}:4`,
    ]);
    expect(await connections(r.page.pageId)).toHaveLength(1);
    expect(await demands(r.page.pageId, "repair.ws-gap")).toBe(1);
    await until(async () => r.operator.buffer.acknowledged === last.seq, 5_000, "the ack");
  }, 60_000);

  it("a crash after the commit, before the ack: the next subscription starts after it — nothing is taken twice", async (context) => {
    if (!testDb) return context.skip();
    const r = await rig();
    const connectionId = randomUUID();
    open(r.operator, connectionId);
    frame(r.operator, connectionId, WS_NOOP_FRAME);
    const last = frame(r.operator, connectionId, serviceFrame({ type: 99, n: 2 }, 99));
    const first = await r.start({ faults: (point) => {
      if (point === "after_commit") throw new BrowserIntakeCrash(point);
    } });
    await until(async () => first.intake.stopReason !== null, 10_000, "the crash");
    await first.crash();
    // Committed, never acknowledged: the operator keeps the events.
    expect(await position(r.page.pageId)).toMatchObject({ ackedSeq: last.seq });
    expect(r.operator.buffer.acknowledged).toBe(0);
    expect(r.operator.buffer.kept).toHaveLength(3);
    const before = await frames(r.page.pageId);
    expect(before).toHaveLength(2);

    const second = await r.start();
    // The subscription is the acknowledgement: the operator drops them, and
    // nothing comes again.
    await until(async () => r.operator.buffer.acknowledged === last.seq, 5_000, "the subscription's acknowledgement");
    expect(r.operator.subscriptions.at(-1)).toMatchObject({ bufferId: r.operator.buffer.id, afterSeq: last.seq });
    const next = frame(r.operator, connectionId, serviceFrame({ type: 99, n: 3 }, 99));
    await committedUpTo(r.page.pageId, next.seq);
    expect(await frames(r.page.pageId)).toHaveLength(3);
    expect(await connections(r.page.pageId)).toHaveLength(1);
    expect(second.intake.batches.every((batch) => batch.fromSeq > last.seq)).toBe(true);
  }, 60_000);

  it("an ack lost on the way: the link breaks, the next subscription acknowledges what was committed, nothing comes twice", async (context) => {
    if (!testDb) return context.skip();
    const r = await rig();
    const connectionId = randomUUID();
    open(r.operator, connectionId);
    const last = frame(r.operator, connectionId, WS_NOOP_FRAME);
    // Every ack of this link is lost on the way.
    r.operator.dropAcks = 1_000;
    const engine = await r.start();
    await committedUpTo(r.page.pageId, last.seq);
    await engine.intake.idle();
    // The ack after the commit is on its way; it is lost there.
    await until(async () => r.operator.dropAcks < 1_000, 5_000, "the ack lost on the way");
    expect(r.operator.buffer.acknowledged).toBe(0);
    const batches = engine.intake.committedBatches;
    r.operator.dropAcks = 0;
    r.operator.server.protocolError("a test breaks the link after a lost ack");
    await until(async () => r.operator.buffer.acknowledged === last.seq, 10_000, "the subscription after the reconnect");
    expect(r.operator.subscriptions.at(-1)).toMatchObject({ afterSeq: last.seq });
    await engine.intake.idle();
    expect(engine.intake.committedBatches).toBe(batches);
    expect(await frames(r.page.pageId)).toHaveLength(1);
    expect(await connections(r.page.pageId)).toHaveLength(1);
  }, 60_000);

  it("the same events delivered again change nothing: the position skips them, and where it does not, the event ids hold", async (context) => {
    if (!testDb) return context.skip();
    const r = await rig();
    const connectionId = randomUUID();
    open(r.operator, connectionId);
    frame(r.operator, connectionId, WS_SESSION_FRAME);
    frame(r.operator, connectionId, WS_NOOP_FRAME);
    r.operator.siteResponse({ route: "site.other", path: "/api/v1/versioning", body: "{}" });
    const last = close(r.operator, connectionId);
    // Every ack is lost: the operator keeps every event and may send it again.
    r.operator.dropAcks = 1_000;
    const engine = await r.start();
    await committedUpTo(r.page.pageId, last.seq);
    const snapshot = async () => ({
      frames: await frames(r.page.pageId),
      connections: await connections(r.page.pageId),
      receipts: await countRows(testDb!.pool, "select count(*)::int as n from fansly_ws_decode_receipts where page_id = $1", [r.page.pageId]),
      site: await countRows(testDb!.pool, "select count(*)::int as n from observations where account_id = $1 and source = 'browser_site'", [r.page.pageId]),
      repairs: await demands(r.page.pageId, "repair.ws-gap"),
    });
    const before = await snapshot();
    expect(before).toMatchObject({ receipts: 1, site: 1, repairs: 1 });
    expect(before.frames).toHaveLength(1);
    const batches = engine.intake.committedBatches;

    // The operator's stream sends them all again on the same connection.
    r.operator.stream.subscribe({ type: "events.subscribe", ownerGeneration: Number(engine.generation), bufferId: r.operator.buffer.id, afterSeq: 0 });
    await new Promise((resolve) => setTimeout(resolve, 500));
    await engine.intake.idle();
    expect(engine.intake.committedBatches).toBe(batches);
    expect(await snapshot()).toEqual(before);

    // Even a position that forgot them takes nothing twice: every write is
    // keyed by the event's id.
    await engine.crash();
    await testDb.pool.query("update page_browsers set events_acked_seq = 0 where page_id = $1", [r.page.pageId]);
    const again = await r.start();
    await until(async () => again.intake.batches.some((batch) => batch.uptoSeq === last.seq), 10_000, "the events taken again");
    expect(again.intake.batches[0]!.fromSeq).toBe(1);
    expect(await snapshot()).toEqual(before);
    expect(await position(r.page.pageId)).toMatchObject({ ackedSeq: last.seq });
  }, 60_000);
});

describe("a volume made anew", () => {
  it("the intake starts over with the new buffer; a late ack of the old one acknowledges nothing of it; the old tail is a gap", async (context) => {
    if (!testDb) return context.skip();
    const r = await rig();
    const engine = await r.start();
    const old = r.operator.buffer;
    const first = randomUUID();
    open(r.operator, first, Date.now() - 60_000);
    frame(r.operator, first, WS_SESSION_FRAME, Date.now() - 59_000);
    const lastOld = frame(r.operator, first, WS_NOOP_FRAME, Date.now() - 50_000);
    await committedUpTo(r.page.pageId, lastOld.seq);
    expect((await position(r.page.pageId)).bufferId).toBe(old.id);

    // The volume is made anew while the engine is away: new numbers from 1,
    // the start's gap with no boundary (nothing before it in this buffer).
    r.operator.recreateBuffer();
    r.operator.gap("operator_start", null);
    const second = randomUUID();
    const reopened = open(r.operator, second);
    const lastNew = frame(r.operator, second, WS_NOOP_FRAME);
    r.operator.server.protocolError("a test restarts the operator with a new volume");
    await until(async () => (await position(r.page.pageId)).bufferId === r.operator.buffer.id && (await position(r.page.pageId)).ackedSeq === lastNew.seq, 10_000, "the new buffer taken");
    expect(r.operator.subscriptions.at(-1)).toMatchObject({ bufferId: r.operator.buffer.id, afterSeq: 0 });
    expect(reopened.seq).toBe(2);

    // A late ack of the old buffer reaches the new one: refused, nothing of
    // the new buffer is acknowledged by it.
    const acknowledged = r.operator.buffer.acknowledged;
    r.operator.append({ kind: "ws.in", connectionId: second, frame: WS_PONG_FRAME });
    engine.client.ack(old.id, 2);
    await until(async () => r.operator.refusals.some((refused) => refused.of === "ack" && refused.givenBufferId === old.id), 5_000, "the late ack refused");
    expect(r.operator.refusals.find((refused) => refused.givenBufferId === old.id)).toMatchObject({ reason: "foreign_buffer", bufferId: r.operator.buffer.id });
    expect(r.operator.buffer.acknowledged).toBeGreaterThanOrEqual(acknowledged);
    await committedUpTo(r.page.pageId, lastNew.seq + 1);
    expect(engine.intake.position).toMatchObject({ bufferId: r.operator.buffer.id });

    // Every frame of both buffers once, under its own buffer's ids.
    expect((await frames(r.page.pageId)).map((row) => row.idempotencyKey)).toEqual([
      `browser:${old.id}:${lastOld.seq}`,
      `browser:${r.operator.buffer.id}:${lastNew.seq}`,
    ]);
    // The old buffer's untaken tail: the new connection's gap runs from the
    // last event taken of the old one.
    const rows = await connections(r.page.pageId);
    expect(rows).toHaveLength(2);
    expect(rows[1]!.gapSince.getTime()).toBe(lastOld.atWall);
  }, 60_000);
});

describe("a subscription the operator cannot serve as asked", () => {
  it("ahead of the buffer (the engine has more of it than it gave): halted for good — even once its numbers grow past the position nothing of it is taken or acknowledged; another buffer is", async (context) => {
    if (!testDb) return context.skip();
    const r = await rig();
    const connectionId = randomUUID();
    open(r.operator, connectionId);
    const last = frame(r.operator, connectionId, WS_NOOP_FRAME);
    const first = await r.start();
    await committedUpTo(r.page.pageId, last.seq);
    await until(async () => r.operator.buffer.acknowledged === last.seq, 5_000, "the ack");
    await first.crash();
    // The position names more than this buffer ever gave (a buffer file
    // restored from before): its numbers are not this history's.
    await testDb.pool.query("update page_browsers set events_acked_seq = 10 where page_id = $1", [r.page.pageId]);
    const halted = r.operator.buffer;
    const second = await r.start();
    await until(async () => r.operator.refusals.some((refused) => refused.reason === "ahead"), 5_000, "the refusal");
    await until(async () => (await position(r.page.pageId)).haltedBufferId === halted.id, 5_000, "the halt written");
    const subscriptions = r.operator.subscriptions.length;
    // Astra's scenario: the restored buffer's numbers grow past the position
    // with events the engine never took; a retry would subscribe after 10 and
    // acknowledge them all.
    for (let i = 0; i < 12; i++) frame(r.operator, connectionId, serviceFrame({ type: 99, n: i }, 99));
    r.operator.server.protocolError("a test breaks the link: a new hello of the same buffer");
    await until(async () => r.operator.hellos.length >= 3 && second.client.up, 5_000, "the new hello");
    await new Promise((resolve) => setTimeout(resolve, 800));
    await second.intake.idle();
    expect(r.operator.subscriptions.slice(subscriptions)).toEqual([]);
    expect(second.intake.committedBatches).toBe(0);
    expect(await frames(r.page.pageId)).toHaveLength(1);
    expect(r.operator.buffer.acknowledged).toBe(last.seq);
    expect(r.operator.buffer.kept).toHaveLength(12);
    expect(second.metrics.count("sync_browser_buffer_halted")).toBeGreaterThanOrEqual(1);
    // Visible: alert 2 reads it.
    expect((await readSyncLivePathFacts(db(), { pageId: r.page.pageId, decodeWindowMs: 60_000, unconfirmedAfterMs: 60_000 })).bufferHalted)
      .toMatchObject({ bufferId: halted.id, reason: "ahead" });

    // Another buffer (the operator's volume made anew) is taken, and its
    // first commit lifts the halt.
    r.operator.recreateBuffer();
    const next = frame(r.operator, connectionId, WS_NOOP_FRAME);
    r.operator.server.protocolError("a test restarts the operator with a new volume");
    await until(async () => (await position(r.page.pageId)).bufferId === r.operator.buffer.id && (await position(r.page.pageId)).ackedSeq === next.seq, 10_000, "the new buffer taken");
    expect((await position(r.page.pageId)).haltedBufferId).toBeNull();
  }, 60_000);

  it("a buffer that cannot be opened: subscribed again once the operator's state says it opened", async (context) => {
    if (!testDb) return context.skip();
    const r = await rig();
    r.operator.buffer.unavailable = { cause: "locked" };
    r.operator.state = { ...r.operator.state, stopReason: "buffer_unavailable" };
    const connectionId = randomUUID();
    r.operator.buffer.append({ kind: "ws.open", connectionId, attemptId: 1, sessionFingerprint: SESSION_A });
    const last = r.operator.buffer.append({ kind: "ws.in", connectionId, frame: WS_NOOP_FRAME });
    const engine = await r.start();
    await until(async () => r.operator.refusals.some((refused) => refused.reason === "unavailable"), 5_000, "the refusal");
    expect(await position(r.page.pageId)).toMatchObject({ bufferId: null, ackedSeq: 0 });
    r.operator.buffer.unavailable = null;
    r.operator.pushState({ stopReason: null });
    await committedUpTo(r.page.pageId, last.seq);
    expect(await position(r.page.pageId)).toMatchObject({ bufferId: r.operator.buffer.id, ackedSeq: last.seq });
    expect(await frames(r.page.pageId)).toHaveLength(1);
    expect(engine.intake.position).toMatchObject({ bufferId: r.operator.buffer.id });
  }, 60_000);

  it("events after the position that the operator no longer has (a position older than its acknowledgements) are a gap since the last event committed", async (context) => {
    if (!testDb) return context.skip();
    const r = await rig();
    const connectionId = randomUUID();
    open(r.operator, connectionId, Date.now() - 60_000);
    const taken = frame(r.operator, connectionId, WS_NOOP_FRAME, Date.now() - 50_000);
    const first = await r.start();
    await committedUpTo(r.page.pageId, taken.seq);
    await first.crash();
    // The operator's buffer was acknowledged past the position (a database
    // restored from before those commits): the events between are gone.
    frame(r.operator, connectionId, serviceFrame({ type: 99, n: 2 }, 99), Date.now() - 40_000);
    const gone = close(r.operator, connectionId, Date.now() - 30_000);
    r.operator.buffer.acknowledge(gone.seq);
    const next = randomUUID();
    const reopened = open(r.operator, next);
    const second = await r.start();
    await committedUpTo(r.page.pageId, reopened.seq);
    expect(second.metrics.count("sync_browser_events_missing")).toBe(1);
    expect(second.intake.batches[0]).toMatchObject({ fromSeq: reopened.seq });
    const rows = await connections(r.page.pageId);
    expect(rows).toHaveLength(2);
    // The new connection reads back from the last event the engine has.
    expect(rows[1]!.gapSince.getTime()).toBe(taken.atWall);
    expect(await frames(r.page.pageId)).toHaveLength(1);
  }, 60_000);
});

describe("gaps", () => {
  const REASONS = ["ws_reconnect", "operator_start", "chrome_restart", "buffer_full", "disk_full"] as const;

  it("every reason with a known boundary: the next connection's gap starts there, and its verification asks for the repair from it", async (context) => {
    if (!testDb) return context.skip();
    const r = await rig();
    await r.start();
    const base = Date.now() - 600_000;
    let before = randomUUID();
    open(r.operator, before, base);
    let boundary = frame(r.operator, before, WS_NOOP_FRAME, base + 1_000);
    close(r.operator, before, base + 5_000);
    const expected: Array<{ reason: string; boundary: number }> = [];
    for (const [i, reason] of REASONS.entries()) {
      const at = base + (i + 1) * 60_000;
      r.operator.gap(reason, boundary, at);
      expected.push({ reason, boundary: boundary.atWall });
      before = randomUUID();
      open(r.operator, before, at + 1_000);
      frame(r.operator, before, WS_SESSION_FRAME, at + 2_000);
      boundary = frame(r.operator, before, WS_NOOP_FRAME, at + 3_000);
      close(r.operator, before, at + 10_000);
    }
    const last = r.operator.buffer.lastSeq;
    await committedUpTo(r.page.pageId, last);
    const rows = await connections(r.page.pageId);
    expect(rows).toHaveLength(REASONS.length + 1);
    // Each gap's boundary is earlier than the previous connection's close:
    // the gap starts at the boundary the operator named.
    for (const [i, gap] of expected.entries()) {
      expect(rows[i + 1]!.gapSince.getTime(), gap.reason).toBe(gap.boundary);
      expect(rows[i]!.closedAt!.getTime(), gap.reason).toBeGreaterThan(gap.boundary);
    }
    expect((await position(r.page.pageId)).gapSince).toBeNull();
    // The repair reads back from the earliest gap of the verified rows.
    const pass = await readFanslyWsGapPass(db(), { pageId: r.page.pageId });
    expect(pass.targets).toHaveLength(REASONS.length);
    expect(pass.since!.getTime()).toBe(expected[0]!.boundary - 60_000);
    expect(await demands(r.page.pageId, "repair.ws-gap")).toBe(1);
  }, 60_000);

  // Astra's review of PR 15, rounds 6 and 7: CDP told the last frame (five
  // minutes old) and the close only now. The operator stamps the frame no
  // later than Chrome saw it — by its session's calibration, or before one
  // by what is proven of its connection — and starts the gap at it
  // (page-browser-ws.test.ts); here, the
  // database's side of it: a message missed four minutes ago is inside the
  // window the repair reads back — where a boundary of "now" (the take)
  // left it out by 180 s.
  it("a late-told last frame and close: the gap from the frame as Chrome saw it — a message missed four minutes ago is inside the repair's window", async (context) => {
    if (!testDb) return context.skip();
    const r = await rig();
    await r.start();
    const now = Date.now();
    const before = randomUUID();
    open(r.operator, before, now - 600_000);
    frame(r.operator, before, WS_SESSION_FRAME, now - 590_000);
    const last = frame(r.operator, before, WS_NOOP_FRAME, now - 300_000);
    // The close as the operator now writes it: its own stamp, no earlier
    // than the frame; the boundary the frame's.
    close(r.operator, before, now - 1_000);
    r.operator.gap("ws_reconnect", last, now - 500);
    const after = randomUUID();
    open(r.operator, after, now - 400);
    const verified = frame(r.operator, after, WS_SESSION_FRAME, now - 300);
    await committedUpTo(r.page.pageId, verified.seq);
    const rows = await connections(r.page.pageId);
    expect(rows[1]!.gapSince.getTime()).toBe(last.atWall);
    const missed = now - 240_000;
    const pass = await readFanslyWsGapPass(db(), { pageId: r.page.pageId });
    expect(pass.targets).toHaveLength(2);
    expect(pass.since!.getTime()).toBeLessThanOrEqual(missed);
    // A boundary at the take ("now") would read back to now − 60 s: the
    // missed message 180 s outside.
    expect(missed - (now - 500 - 60_000)).toBe(-179_500);
  }, LONG_TEST_MS);

  // The loss boundary moves only on a socket's open and frames (Chrome's own
  // time of them): a site answer taken after them is stamped at the
  // operator's take, and bounds no socket message — before this change the
  // gap started at the answer's take (the last event of any kind), late by
  // whatever CDP took to tell a frame after it.
  it("every reason with no boundary (nothing before it in its buffer): the gap starts at the last socket event the engine took — never at a later site answer's take — kept until a connection takes it", async (context) => {
    if (!testDb) return context.skip();
    for (const reason of REASONS) {
      await resetIntegrationDatabase(testDb.pool);
      const r = await rig();
      const engine = await r.start();
      const before = randomUUID();
      open(r.operator, before, Date.now() - 180_000);
      const last = frame(r.operator, before, WS_NOOP_FRAME, Date.now() - 150_000);
      const answer = r.operator.siteResponse({ route: "site.other", path: "/api/v1/versioning", body: "{\"success\":true,\"response\":{}}" }, Date.now() - 120_000);
      await committedUpTo(r.page.pageId, answer.seq);
      expect((await position(r.page.pageId)).lastWall!.getTime(), reason).toBe(last.atWall);
      const gap = r.operator.gap(reason, null);
      expect(gap).toMatchObject({ fromSeq: null, fromWall: null });
      await committedUpTo(r.page.pageId, gap.seq);
      // Kept until a connection takes it.
      expect((await position(r.page.pageId)).gapSince!.getTime(), reason).toBe(last.atWall);
      const connectionId = randomUUID();
      // In the past: the database never dates a connection after its own clock.
      const opened = open(r.operator, connectionId, Date.now() - 5_000);
      await committedUpTo(r.page.pageId, opened.seq);
      const rows = await connections(r.page.pageId);
      expect(rows[1]!.gapSince.getTime(), reason).toBe(last.atWall);
      expect(rows[1]!.startedAt.getTime(), reason).toBe(opened.atWall);
      expect((await position(r.page.pageId)).gapSince, reason).toBeNull();
      expect(engine.metrics.count("sync_browser_gaps", { reason, boundary: "unknown" }), reason).toBe(1);
      await engine.crash();
    }
  }, 120_000);

  it("a gap with no boundary and no socket event taken yet (only a site answer): nothing bounds it — the next connection reads back from the previous connection's end, as for the engine's own socket", async (context) => {
    if (!testDb) return context.skip();
    const r = await rig();
    await r.start();
    // The page's socket before its browser: the engine's own, closed an hour ago.
    const closedAt = new Date(Date.now() - 3_600_000);
    await testDb.pool.query(
      `insert into fansly_ws_connections (id, page_id, generation, origin, started_at, last_guard_at, verified_at, gap_since, closed_at)
       values ($1, $2, $3, 'node', $4::timestamptz - interval '1 hour', $4, $4::timestamptz - interval '1 hour', $4::timestamptz - interval '1 hour', $4)`,
      [randomUUID(), r.page.pageId, "c".repeat(64), closedAt.toISOString()],
    );
    r.operator.siteResponse({ route: "site.other", path: "/api/v1/versioning", body: "{\"success\":true,\"response\":{}}" }, Date.now() - 120_000);
    const gap = r.operator.gap("operator_start", null);
    await committedUpTo(r.page.pageId, gap.seq);
    expect(await position(r.page.pageId)).toMatchObject({ lastWall: null, gapSince: null });
    const opened = open(r.operator, randomUUID(), Date.now() - 5_000);
    await committedUpTo(r.page.pageId, opened.seq);
    const rows = await connections(r.page.pageId);
    expect(rows).toHaveLength(2);
    expect(rows[1]!.gapSince.getTime()).toBe(closedAt.getTime());
  }, 60_000);

  it("a gap with no boundary after a connection's close: its last frame — a close moves no boundary later (the operator stamps a close of its own at its take)", async (context) => {
    if (!testDb) return context.skip();
    const r = await rig();
    await r.start();
    const first = randomUUID();
    open(r.operator, first, Date.now() - 30_000);
    const last = frame(r.operator, first, WS_NOOP_FRAME, Date.now() - 25_000);
    // The browser went under it: the operator's own close, at its take.
    close(r.operator, first, Date.now() - 1_000);
    r.operator.gap("chrome_restart", null);
    const opened = open(r.operator, randomUUID());
    await committedUpTo(r.page.pageId, opened.seq);
    const rows = await connections(r.page.pageId);
    expect(rows[1]!.gapSince.getTime()).toBe(last.atWall);
  }, 60_000);
});

// The residual PR 15 left (its rule: an instant crossing operator → engine is
// the operator's clock; a socket event is Chrome's time of it, mapped by a
// calibration that errs early). A site answer and a gap are stamped at the
// operator's take, and a frame CDP tells late can follow either in the stream
// with an older stamp. The loss boundary the engine reads a loss of unnamed
// start back from is that frame's: a message missed after it is inside the
// repair's window — where the last event of any kind (the take before it)
// started the window 200 s late, past the 60 s margin.
describe("the loss boundary: a frame CDP told late", () => {
  /** A connection whose frame `late` Chrome saw at now − 300 s, told by CDP
   *  only after an event the operator took at now − 100 s. */
  type Setup = (r: Rig, now: number) => Promise<{ engine: Engine; connectionId: string; late: BufferEvent }>;

  const AFTER: Record<"a site answer" | "a gap", Setup> = {
    async "a site answer"(r, now) {
      const connectionId = randomUUID();
      open(r.operator, connectionId, now - 600_000);
      const verified = frame(r.operator, connectionId, WS_SESSION_FRAME, now - 590_000);
      const engine = await r.start();
      await committedUpTo(r.page.pageId, verified.seq);
      await repaired(r.page.pageId);
      r.operator.siteResponse({ route: "site.other", path: "/api/v1/versioning", body: "{\"success\":true,\"response\":{}}" }, now - 100_000);
      return { engine, connectionId, late: frame(r.operator, connectionId, WS_NOOP_FRAME, now - 300_000) };
    },
    async "a gap"(r, now) {
      const before = randomUUID();
      open(r.operator, before, now - 700_000);
      const boundary = frame(r.operator, before, WS_SESSION_FRAME, now - 690_000);
      close(r.operator, before, now - 680_000);
      // The reconnect's gap at the operator's take; the open in its commit
      // and the session by Chrome's time, older.
      r.operator.gap("ws_reconnect", boundary, now - 100_000);
      const connectionId = randomUUID();
      open(r.operator, connectionId, now - 330_000);
      const verified = frame(r.operator, connectionId, WS_SESSION_FRAME, now - 320_000);
      const engine = await r.start();
      await committedUpTo(r.page.pageId, verified.seq);
      await repaired(r.page.pageId);
      return { engine, connectionId, late: frame(r.operator, connectionId, WS_NOOP_FRAME, now - 300_000) };
    },
  };

  for (const [after, setup] of Object.entries(AFTER)) {
    for (const loss of ["events the operator no longer has", "a new volume's untaken tail"] as const) {
      it(`after ${after}: ${loss} — read back from the frame as Chrome saw it, a message missed after it inside the repair's window`, async (context) => {
        if (!testDb) return context.skip();
        const r = await rig();
        const now = Date.now();
        const { engine, connectionId, late } = await setup(r, now);
        await committedUpTo(r.page.pageId, late.seq);
        // The loss boundary is the frame's, not the later take before it.
        expect.soft((await position(r.page.pageId)).lastWall!.getTime()).toBe(late.atWall);
        await engine.crash();
        // Chrome saw it 60 s after the late frame; it never reaches the engine.
        const missed = frame(r.operator, connectionId, serviceFrame({ type: 99, n: 1 }, 99), now - 240_000);
        if (loss === "events the operator no longer has") {
          // Acknowledged past a position restored from before: deleted.
          const gone = frame(r.operator, connectionId, serviceFrame({ type: 99, n: 2 }, 99), now - 200_000);
          r.operator.buffer.acknowledge(gone.seq);
          const survivor = frame(r.operator, connectionId, WS_NOOP_FRAME, now - 20_000);
          const second = await r.start();
          await committedUpTo(r.page.pageId, survivor.seq);
          expect(second.metrics.count("sync_browser_events_missing")).toBe(1);
        } else {
          // The volume made anew: the old buffer's tail is never taken.
          const old = r.operator.buffer.id;
          r.operator.recreateBuffer();
          r.operator.gap("operator_start", null);
          const opened = open(r.operator, randomUUID(), now - 20_000);
          await r.start();
          await until(async () => (await position(r.page.pageId)).bufferId === r.operator.buffer.id && (await position(r.page.pageId)).ackedSeq === opened.seq, 10_000, "the new buffer taken");
          expect(r.operator.buffer.id).not.toBe(old);
        }
        // The connection still open, verified: its repair asked for at once,
        // read back from the late frame.
        expect(await demands(r.page.pageId, "repair.ws-gap")).toBe(1);
        const pass = await readFanslyWsGapPass(db(), { pageId: r.page.pageId });
        expect(pass.targets).toHaveLength(1);
        expect(pass.since!.getTime()).toBe(late.atWall - 60_000);
        expect(pass.since!.getTime()).toBeLessThanOrEqual(missed.atWall);
        // From the take before the frame (now − 100 s), the window would
        // start at now − 160 s: the missed message 80 s outside it.
        expect(now - 100_000 - 60_000 - missed.atWall).toBe(80_000);
      }, LONG_TEST_MS);
    }
  }

  // The operator names its start's gap, and a full buffer's, from the last
  // event it saved, of any kind: a site answer stamped at its take, while a
  // frame Chrome saw before it was still on its way through CDP — never
  // saved. The engine reads it back no later than the last socket event it
  // took before the gap.
  it("a boundary the operator names from a site answer (its start, a full buffer): read back no later than the last socket event before it — a message CDP was still telling is inside the repair's window", async (context) => {
    if (!testDb) return context.skip();
    for (const reason of ["operator_start", "buffer_full", "disk_full"] as const) {
      await resetIntegrationDatabase(testDb.pool);
      const r = await rig();
      const now = Date.now();
      const before = randomUUID();
      open(r.operator, before, now - 600_000);
      const verified = frame(r.operator, before, WS_SESSION_FRAME, now - 590_000);
      const engine = await r.start();
      await committedUpTo(r.page.pageId, verified.seq);
      await repaired(r.page.pageId);
      const last = frame(r.operator, before, WS_NOOP_FRAME, now - 300_000);
      const answer = r.operator.siteResponse({ route: "site.other", path: "/api/v1/versioning", body: "{\"success\":true,\"response\":{}}" }, now - 100_000);
      // Chrome saw it at now − 240 s; CDP told it after the answer, and the
      // break came first: it never reached the buffer.
      const missed = now - 240_000;
      r.operator.gap(reason, answer, now - 10_000);
      close(r.operator, before, now - 10_000);
      const after = randomUUID();
      open(r.operator, after, now - 5_000);
      const reverified = frame(r.operator, after, WS_SESSION_FRAME, now - 4_000);
      await committedUpTo(r.page.pageId, reverified.seq);
      const rows = await connections(r.page.pageId);
      expect(rows[1]!.gapSince.getTime(), reason).toBe(last.atWall);
      const pass = await readFanslyWsGapPass(db(), { pageId: r.page.pageId });
      expect(pass.targets, reason).toHaveLength(1);
      expect(pass.since!.getTime(), reason).toBeLessThanOrEqual(missed);
      // From the answer's take, the window would start at now − 160 s.
      expect(answer.atWall - 60_000 - missed, reason).toBe(80_000);
      expect(engine.metrics.count("sync_browser_gaps", { reason, boundary: "known" }), reason).toBe(1);
      await engine.crash();
    }
  }, LONG_TEST_MS);
});

describe("the site's answers", () => {
  it("into observations (browser_site) by event id, through the codec; the login's never; a body broken on the way is asked for again", async (context) => {
    if (!testDb) return context.skip();
    const r = await rig();
    const engine = await r.start();
    const route = r.operator.siteResponse({ route: "polls", path: "/api/v1/polls", query: "ngsw-bypass=true", body: JSON.stringify({ success: true, response: { polls: [{ id: "1" }] } }) });
    const other = r.operator.siteResponse({ route: "site.other", path: "/api/v1/versioning", body: "{\"success\":true,\"response\":{\"v\":1}}" });
    const failed = r.operator.siteResponse({ route: "polls", path: "/api/v1/polls", status: 500, body: "{\"success\":false}" });
    const cached = r.operator.siteResponse({ route: "polls", path: "/api/v1/polls", source: "cache_unconfirmed", body: JSON.stringify({ success: true, response: { polls: [] } }) });
    const login = r.operator.siteResponse({ route: "auth.login", method: "POST", path: "/api/v1/login", body: "{\"secret\":\"token\"}" });
    r.operator.corruptNextBody = false;
    const incomplete = r.operator.siteResponse({ route: "polls", path: "/api/v1/polls", complete: false, body: "" });
    await committedUpTo(r.page.pageId, incomplete.seq);
    const result = await testDb.pool.query<{ key: string; kind: string; producer: string; payload: Record<string, unknown> }>(
      `select k.idempotency_key as key, o.kind, o.producer, o.payload
         from observations o join observation_keys k on k.observation_id = o.id and k.received_at = o.received_at
        where o.account_id = $1 and o.source = 'browser_site' order by o.id`,
      [r.page.pageId],
    );
    const byKey = new Map(result.rows.map((row) => [row.key, row]));
    const key = (event: BufferEvent) => `fansly-site:${r.page.pageId}:${r.operator.buffer.id}:${event.seq}`;
    expect(byKey.get(key(route))).toMatchObject({ kind: "polls", producer: "fansly-site:polls", payload: { polls: [{ id: "1" }] } });
    expect(byKey.get(key(other))).toMatchObject({ kind: "fansly.site.site.other", producer: "fansly-site:site.other", payload: { status: 200, path: "/api/v1/versioning", body: { success: true, response: { v: 1 } } } });
    expect(byKey.get(key(failed))).toMatchObject({ kind: "polls:failed", payload: { status: 500 } });
    expect(byKey.get(key(cached))).toMatchObject({ kind: "polls:unconfirmed", payload: { source: "cache_unconfirmed", disposition: "rejected_not_applied" } });
    expect(byKey.has(key(login))).toBe(false);
    expect(byKey.get(key(incomplete))).toMatchObject({ kind: "polls:incomplete", payload: { disposition: "incomplete_not_captured" } });
    // The poll that reads the route is asked for: its own request backfills it.
    expect(await countRows(testDb.pool, "select count(*)::int as n from sync_work where page_id = $1 and resource = $2 and demand_revision > 0", [r.page.pageId, POLL_KEY])).toBe(1);
    expect(result.rows).toHaveLength(5);

    // A body broken on the way: the batch is cut before it, and it comes
    // again whole.
    r.operator.corruptNextBody = true;
    const broken = r.operator.siteResponse({ route: "site.other", path: "/api/v1/x", body: "{\"n\":1}" });
    await committedUpTo(r.page.pageId, broken.seq);
    expect(engine.metrics.count("sync_browser_body_incomplete")).toBeGreaterThanOrEqual(1);
    const kept = await testDb.pool.query<{ payload: Record<string, unknown> }>(
      `select o.payload from observations o join observation_keys k on k.observation_id = o.id and k.received_at = o.received_at
        where k.source = 'browser_site' and k.idempotency_key = $1`,
      [key(broken)],
    );
    expect(kept.rows[0]!.payload).toMatchObject({ body: { n: 1 } });
  }, 60_000);
});

// Astra's review of PR 13: nothing is acknowledged unless it is kept in full,
// or a loss boundary and its repair are committed with it.
describe("the review of PR 13", () => {
  it("a frame the business traversal refuses (4,097 children) is a loss on its connection: its gap opens again and the repair is asked for before it is acknowledged", async (context) => {
    if (!testDb) return context.skip();
    const r = await rig();
    const engine = await r.start();
    const connectionId = randomUUID();
    open(r.operator, connectionId);
    const verified = frame(r.operator, connectionId, WS_SESSION_FRAME);
    await committedUpTo(r.page.pageId, verified.seq);
    await repaired(r.page.pageId);
    expect((await readFanslyWsGapPass(db(), { pageId: r.page.pageId })).targets).toEqual([]);
    const big = frame(r.operator, connectionId, wrapped(10001, Array.from({ length: 4_097 }, () => '{"t":10000,"d":"{}"}')));
    await committedUpTo(r.page.pageId, big.seq);
    expect(engine.metrics.count("sync_browser_frames_lost")).toBe(1);
    expect(await demands(r.page.pageId, "repair.ws-gap")).toBe(1);
    expect((await readFanslyWsGapPass(db(), { pageId: r.page.pageId })).targets).toHaveLength(1);
    expect(await frames(r.page.pageId)).toEqual([]);
    await until(async () => r.operator.buffer.acknowledged === big.seq, 5_000, "the ack after the loss is committed");
  }, 60_000);

  it("events lost on a connection still open and verified (a position restored behind the operator's acknowledgement): its repair is asked for at once", async (context) => {
    if (!testDb) return context.skip();
    const r = await rig();
    const connectionId = randomUUID();
    open(r.operator, connectionId, Date.now() - 60_000);
    frame(r.operator, connectionId, WS_SESSION_FRAME, Date.now() - 59_000);
    const taken = frame(r.operator, connectionId, WS_NOOP_FRAME, Date.now() - 50_000);
    const first = await r.start();
    await committedUpTo(r.page.pageId, taken.seq);
    await first.crash();
    await repaired(r.page.pageId);
    // The operator acknowledged — and deleted — events the engine no longer
    // has a record of; the first that survives is the same open connection's.
    frame(r.operator, connectionId, serviceFrame({ type: 99, n: 2 }, 99), Date.now() - 40_000);
    const gone = frame(r.operator, connectionId, serviceFrame({ type: 99, n: 3 }, 99), Date.now() - 30_000);
    r.operator.buffer.acknowledge(gone.seq);
    const survivor = frame(r.operator, connectionId, serviceFrame({ type: 99, n: 4 }, 99), Date.now() - 20_000);
    await r.start();
    await committedUpTo(r.page.pageId, survivor.seq);
    expect(await demands(r.page.pageId, "repair.ws-gap")).toBe(1);
    const pass = await readFanslyWsGapPass(db(), { pageId: r.page.pageId });
    expect(pass.targets).toHaveLength(1);
    expect(pass.since!.getTime()).toBeLessThanOrEqual(taken.atWall - 60_000);
  }, 60_000);

  /** A post of the page's own, queued for its reply walk by the projector. */
  async function ownPost(pageId: number, postId: string): Promise<void> {
    await testDb!.pool.query(
      `insert into creator_posts (account_id, platform, platform_post_id, text_plain, published_at, first_observed_at, last_observed_at,
         content_hash, attachment_count, source_event_id, source_observation_id, source_account_seq)
       values ($1, 'fansly', $2, 'a post', now() - interval '1 day', now() - interval '1 day', now(), repeat('d', 64), 0, 1, 1, 1)`,
      [pageId, postId],
    );
    await ensurePostRepliesWalkRow(db(), { pageId, subjectRef: postId, dueAt: new Date(Date.now() + 86_400_000) });
  }

  async function backfills(pageId: number): Promise<Array<{ resource: string; subject: string }>> {
    const work = await testDb!.pool.query<{ resource: string; subject: string }>(
      "select resource, subject from sync_work where page_id = $1 and resource <> 'account.verify' order by resource, subject",
      [pageId],
    );
    return work.rows;
  }

  it("an incomplete chat head page or reply page asks for the read that backfills it: the chat's head, the walk of a post of the page's own", async (context) => {
    if (!testDb) return context.skip();
    const r = await rig();
    await ownPost(r.page.pageId, "555000000000000001");
    await r.start();
    r.operator.siteResponse({ route: "messages.page", path: "/api/v1/message", query: "groupId=800000000000000001&limit=25&ngsw-bypass=true", complete: false, body: "" });
    const last = r.operator.siteResponse({ route: "post.replies", path: "/api/v1/post/555000000000000001/replies", query: "ngsw-bypass=true", complete: false, body: "" });
    await committedUpTo(r.page.pageId, last.seq);
    expect(await backfills(r.page.pageId)).toEqual([
      { resource: "dm-messages.head", subject: "800000000000000001" },
      { resource: "post-replies.walk", subject: "" },
    ]);
    const queue = await testDb.pool.query<{ refreshClass: string; dirtyReason: string }>(
      `select refresh_class as "refreshClass", dirty_reason as "dirtyReason" from subject_refresh_state
        where page_id = $1 and plane = 'post_replies' and subject_ref = '555000000000000001'`,
      [r.page.pageId],
    );
    expect(queue.rows).toEqual([{ refreshClass: "dirty", dirtyReason: "browser_site_incomplete" }]);
  }, 60_000);

  it("an incomplete OLDER chat page is no head read: the engine reads history only for a request (I12), so its mark stays, said so", async (context) => {
    if (!testDb) return context.skip();
    const r = await rig();
    const engine = await r.start();
    const last = r.operator.siteResponse({ route: "messages.page", path: "/api/v1/message", query: "groupId=800000000000000002&before=456&limit=25", complete: false, body: "" });
    await committedUpTo(r.page.pageId, last.seq);
    expect(await backfills(r.page.pageId)).toEqual([]);
    expect(engine.metrics.count("sync_browser_site_unbackfilled", { why: "history_read_by_request_only" })).toBe(1);
    const marks = await testDb.pool.query<{ payload: Record<string, unknown> }>(
      "select payload from observations where account_id = $1 and kind = 'dm_messages:incomplete'",
      [r.page.pageId],
    );
    expect(marks.rows[0]!.payload).toMatchObject({ query: "groupId=800000000000000002&before=456&limit=25", disposition: "incomplete_not_captured" });
  }, 60_000);

  it("an incomplete reply page of a post that is not the page's own (or of a session the engine does not trust) queues nothing under the page", async (context) => {
    if (!testDb) return context.skip();
    const r = await rig();
    const engine = await r.start();
    // A post the page does not have: never queued under it.
    const foreignPost = r.operator.siteResponse({ route: "post.replies", path: "/api/v1/post/999000000000000001/replies", complete: false, body: "" });
    await committedUpTo(r.page.pageId, foreignPost.seq);
    // The page's own post, but the answer came under another session.
    await ownPost(r.page.pageId, "555000000000000002");
    r.operator.live = SESSION_B;
    const foreignSession = r.operator.siteResponse({ route: "post.replies", path: "/api/v1/post/555000000000000002/replies", complete: false, body: "" });
    const chat = r.operator.siteResponse({ route: "messages.page", path: "/api/v1/message", query: "groupId=800000000000000003", complete: false, body: "" });
    await committedUpTo(r.page.pageId, chat.seq);
    expect(foreignSession.seq).toBeLessThan(chat.seq);
    expect(await backfills(r.page.pageId)).toEqual([]);
    const queued = await testDb.pool.query<{ subjectRef: string; refreshClass: string }>(
      `select subject_ref as "subjectRef", refresh_class as "refreshClass" from subject_refresh_state where page_id = $1 and plane = 'post_replies' order by subject_ref`,
      [r.page.pageId],
    );
    expect(queued.rows).toEqual([{ subjectRef: "555000000000000002", refreshClass: "fresh" }]);
    expect(engine.metrics.count("sync_browser_site_unbackfilled", { why: "not_a_post_of_the_page" })).toBe(1);
    expect(engine.metrics.count("sync_browser_site_unbackfilled", { why: "untrusted_session" })).toBe(2);
  }, 60_000);

  it("a refused frame of a connection the page has no row of is still a loss: marked, the page's open connection repaired, the next connection's gap from it", async (context) => {
    if (!testDb) return context.skip();
    const r = await rig();
    await r.start();
    const big = () => wrapped(10001, Array.from({ length: 4_097 }, () => '{"t":10000,"d":"{}"}'));
    // No connection open: the next one's gap starts at the refused frame.
    const lone = frame(r.operator, randomUUID(), big(), Date.now() - 30_000);
    const opened = open(r.operator, randomUUID(), Date.now() - 20_000);
    const connectionId = (opened as Extract<BufferEvent, { kind: "ws.open" }>).connectionId;
    const verified = frame(r.operator, connectionId, WS_SESSION_FRAME, Date.now() - 19_000);
    await committedUpTo(r.page.pageId, verified.seq);
    expect((await connections(r.page.pageId))[0]!.gapSince.getTime()).toBe(lone.atWall);
    expect(await frames(r.page.pageId, "fansly.ws.frame.v1:refused")).toHaveLength(1);
    await repaired(r.page.pageId);
    // An open, verified connection: its repair is asked for at once.
    const other = frame(r.operator, randomUUID(), big(), Date.now() - 10_000);
    await committedUpTo(r.page.pageId, other.seq);
    expect(await frames(r.page.pageId, "fansly.ws.frame.v1:refused")).toHaveLength(2);
    expect(await demands(r.page.pageId, "repair.ws-gap")).toBe(1);
    const pass = await readFanslyWsGapPass(db(), { pageId: r.page.pageId });
    expect(pass.targets).toHaveLength(1);
    expect(pass.since!.getTime()).toBe(other.atWall - 60_000);
  }, 60_000);

  it("a loss found on a connection opened long ago is read back from the loss, not excluded by the connection's age; its repair clears it", async (context) => {
    if (!testDb) return context.skip();
    const r = await rig();
    const id = randomUUID();
    const browserConnectionId = randomUUID();
    // Opened eight days ago, its opening gap repaired long since.
    await testDb.pool.query(
      `insert into fansly_ws_connections (id, page_id, generation, origin, browser_connection_id, started_at, last_guard_at, verified_at, gap_since,
         state_reconciled_at, transient_unknown)
       values ($1, $2, $3, 'browser', $4, now() - interval '8 days', now(), now() - interval '8 days', now() - interval '8 days 1 hour',
               now() - interval '8 days', tstzrange(now() - interval '8 days 1 hour', now() - interval '8 days'))`,
      [id, r.page.pageId, "c".repeat(64), browserConnectionId],
    );
    const lostAt = new Date(Date.now() - 48 * 3_600_000);
    await db().transaction(async (tx) => markBrowserWsLoss(tx as unknown as Database, { pageId: r.page.pageId, browserConnectionId, since: lostAt }));
    const pass = await readFanslyWsGapPass(db(), { pageId: r.page.pageId });
    expect(pass.targets).toEqual([id]);
    expect(pass.since!.getTime()).toBe(lostAt.getTime() - 60_000);
    expect(await stampFanslyWsGapReconciled(db(), { pageId: r.page.pageId, targets: pass.targets, since: pass.since! })).toBe(1);
    expect((await readFanslyWsGapPass(db(), { pageId: r.page.pageId })).targets).toEqual([]);
    const row = await testDb.pool.query<{ lossSince: Date | null }>("select loss_since as \"lossSince\" from fansly_ws_connections where id = $1", [id]);
    expect(row.rows[0]!.lossSince).toBeNull();
  }, 60_000);

  it("a halt never written before the process died: the restored buffer, grown past the position, is still refused by its sent mark — nothing deleted — and the halt is written once the database is back", async (context) => {
    if (!testDb) return context.skip();
    const r = await rig();
    const connectionId = randomUUID();
    open(r.operator, connectionId);
    const last = frame(r.operator, connectionId, WS_NOOP_FRAME);
    const first = await r.start();
    await committedUpTo(r.page.pageId, last.seq);
    await until(async () => r.operator.buffer.acknowledged === last.seq, 5_000, "the ack");
    await first.crash();
    // The engine committed more of this buffer than the restored file gave.
    await testDb.pool.query("update page_browsers set events_acked_seq = 10 where page_id = $1", [r.page.pageId]);
    const second = await r.start({ faults: (point) => {
      if (point === "halt_write") throw new Error("the database is away");
    } });
    await until(async () => r.operator.refusals.filter((refused) => refused.reason === "ahead").length >= 1, 5_000, "the refusal");
    await new Promise((resolve) => setTimeout(resolve, 200));
    // The process dies with the halt never written.
    await second.crash();
    expect((await position(r.page.pageId)).haltedBufferId).toBeNull();
    // The restored buffer grows well past the position.
    for (let i = 0; i < 12; i++) frame(r.operator, connectionId, serviceFrame({ type: 99, n: i }, 99));
    expect(r.operator.buffer.lastSeq).toBeGreaterThan(10);
    const refusals = r.operator.refusals.length;
    const third = await r.start();
    await until(async () => r.operator.refusals.slice(refusals).some((refused) => refused.reason === "ahead"), 5_000, "refused again by the sent mark");
    await until(async () => (await position(r.page.pageId)).haltedBufferId === r.operator.buffer.id, 5_000, "the halt written");
    await third.intake.idle();
    expect(r.operator.buffer.acknowledged).toBe(last.seq);
    expect(r.operator.buffer.kept).toHaveLength(12);
    expect(third.intake.committedBatches).toBe(0);
  }, 60_000);

  it("an old loss mark on a connection never hides a fresh loss: the read-back is clamped to the week, and the repair clears it", async (context) => {
    if (!testDb) return context.skip();
    const r = await rig();
    const id = randomUUID();
    const browserConnectionId = randomUUID();
    // Opened eight days ago, its opening gap repaired, a loss marked then.
    await testDb.pool.query(
      `insert into fansly_ws_connections (id, page_id, generation, origin, browser_connection_id, started_at, last_guard_at, verified_at, gap_since,
         state_reconciled_at, transient_unknown, loss_since)
       values ($1, $2, $3, 'browser', $4, now() - interval '8 days', now(), now() - interval '8 days', now() - interval '8 days 1 hour',
               now() - interval '8 days', tstzrange(now() - interval '8 days 1 hour', now() - interval '8 days'), now() - interval '8 days')`,
      [id, r.page.pageId, "c".repeat(64), browserConnectionId],
    );
    // A fresh loss: `least()` keeps the eight-day mark.
    await db().transaction(async (tx) => markBrowserWsLoss(tx as unknown as Database, { pageId: r.page.pageId, browserConnectionId, since: new Date(Date.now() - 48 * 3_600_000) }));
    const pass = await readFanslyWsGapPass(db(), { pageId: r.page.pageId });
    expect(pass.targets).toEqual([id]);
    const week = 7 * 24 * 3_600_000;
    expect(Math.abs(Date.now() - pass.since!.getTime() - (week + 60_000))).toBeLessThan(10_000);
    expect(await stampFanslyWsGapReconciled(db(), { pageId: r.page.pageId, targets: pass.targets, since: pass.since! })).toBe(1);
    expect((await readFanslyWsGapPass(db(), { pageId: r.page.pageId })).targets).toEqual([]);
  }, 60_000);

  it("a halt whose write fails keeps the intake closed until it is written; a restart then finds it, however the buffer grew", async (context) => {
    if (!testDb) return context.skip();
    const r = await rig();
    const connectionId = randomUUID();
    open(r.operator, connectionId);
    const last = frame(r.operator, connectionId, WS_NOOP_FRAME);
    const first = await r.start();
    await committedUpTo(r.page.pageId, last.seq);
    await until(async () => r.operator.buffer.acknowledged === last.seq, 5_000, "the ack");
    await first.crash();
    await testDb.pool.query("update page_browsers set events_acked_seq = 10 where page_id = $1", [r.page.pageId]);
    const halted = r.operator.buffer.id;
    let failWrites = 3;
    const second = await r.start({ faults: (point) => {
      if (point === "halt_write" && failWrites > 0) {
        failWrites -= 1;
        throw new Error("the database is away for a moment");
      }
    } });
    await until(async () => r.operator.refusals.some((refused) => refused.reason === "ahead"), 5_000, "the refusal");
    const subscriptions = r.operator.subscriptions.length;
    // A new hello while the halt is not written: nothing is subscribed.
    r.operator.server.protocolError("a test breaks the link while the halt is not written");
    await until(async () => (await position(r.page.pageId)).haltedBufferId === halted, 10_000, "the halt written at last");
    expect(failWrites).toBe(0);
    expect(r.operator.subscriptions.slice(subscriptions)).toEqual([]);
    // The restored buffer grows past the position; the engine restarts.
    for (let i = 0; i < 12; i++) frame(r.operator, connectionId, serviceFrame({ type: 99, n: i }, 99));
    await second.crash();
    const third = await r.start();
    await new Promise((resolve) => setTimeout(resolve, 500));
    await third.intake.idle();
    expect(r.operator.subscriptions.slice(subscriptions)).toEqual([]);
    expect(r.operator.buffer.acknowledged).toBe(last.seq);
    expect(third.intake.committedBatches).toBe(0);
  }, 60_000);

  it("the repair takes a page browser's verified gap opened up to a week ago (its buffer replays up to 72 h); the engine's own socket's a day", async (context) => {
    if (!testDb) return context.skip();
    const r = await rig();
    const insert = (origin: "node" | "browser", hoursAgo: number) => testDb!.pool.query(
      `insert into fansly_ws_connections (id, page_id, generation, origin, browser_connection_id, started_at, last_guard_at, verified_at, gap_since, closed_at)
       values ($1, $2, $3, $4, $5, now() - $6 * interval '1 hour', now() - $6 * interval '1 hour', now() - $6 * interval '1 hour',
               now() - ($6 + 1) * interval '1 hour', now() - ($6 - 1) * interval '1 hour')`,
      [randomUUID(), r.page.pageId, "c".repeat(64), origin, origin === "browser" ? randomUUID() : null, hoursAgo],
    );
    await insert("node", 47);
    await insert("browser", 47);
    const pass = await readFanslyWsGapPass(db(), { pageId: r.page.pageId });
    expect(pass.targets).toHaveLength(1);
    const target = await testDb.pool.query<{ origin: string }>("select origin from fansly_ws_connections where id = $1::uuid", [pass.targets[0]]);
    expect(target.rows[0]!.origin).toBe("browser");
    expect(Date.now() - pass.since!.getTime()).toBeGreaterThan(47 * 3_600_000);
  }, 60_000);

  it("keeps a bounded ring of its batches, however many it commits", async (context) => {
    if (!testDb) return context.skip();
    const r = await rig();
    const engine = await r.start();
    const connectionId = randomUUID();
    open(r.operator, connectionId);
    for (let i = 0; i < BROWSER_INTAKE_RECENT_BATCHES + 8; i++) {
      const event = frame(r.operator, connectionId, WS_PONG_FRAME);
      await committedUpTo(r.page.pageId, event.seq);
    }
    await engine.intake.idle();
    expect(engine.intake.committedBatches).toBeGreaterThan(BROWSER_INTAKE_RECENT_BATCHES);
    expect(engine.intake.batches).toHaveLength(BROWSER_INTAKE_RECENT_BATCHES);
    expect(engine.intake.batches.at(-1)!.uptoSeq).toBe(r.operator.buffer.lastSeq);
  }, 60_000);
});

describe("frames of a session the engine does not trust", () => {
  it("are kept as facts, never applied: no receipt, nothing on the live overlay", async (context) => {
    if (!testDb) return context.skip();
    const r = await rig();
    await r.start();
    const connectionId = randomUUID();
    // The site's socket opened under another session than the verified one.
    r.operator.append({ kind: "ws.open", connectionId, attemptId: 1, sessionFingerprint: SESSION_B });
    const message = {
      id: "900000000000000202", groupId: "800000000000000001", senderId: "700000000000000001", createdAt: Date.now() / 1000 - 1,
      content: "hello", attachments: [], type: 1, correlationId: null, inReplyTo: null,
    };
    const last = frame(r.operator, connectionId, serviceFrame({ type: 1, message }));
    await committedUpTo(r.page.pageId, last.seq);
    expect(await frames(r.page.pageId)).toEqual([]);
    const kept = await frames(r.page.pageId, "fansly.ws.frame.v1:unverified_session");
    expect(kept).toHaveLength(1);
    expect(kept[0]!.generation).toBe(await readBrowserCredentialsGeneration(db(), r.page.pageId, SESSION_B));
    expect(await countRows(testDb.pool, "select count(*)::int as n from fansly_ws_decode_receipts where page_id = $1", [r.page.pageId])).toBe(0);
    await until(async () => r.operator.buffer.acknowledged === last.seq, 5_000, "the ack");
  }, 60_000);

  it("a frame with text the journal cannot store (an unpaired surrogate) is kept with it replaced, never a stalled stream", async (context) => {
    if (!testDb) return context.skip();
    const r = await rig();
    await r.start();
    const connectionId = randomUUID();
    open(r.operator, connectionId);
    // Valid JSON as the site received it, with a raw unpaired surrogate.
    const text = `{"t":10000,"d":"{\\"serviceId\\":99,\\"event\\":\\"a${String.fromCharCode(0xd800)}b\\"}"}`;
    const odd = frame(r.operator, connectionId, text);
    await committedUpTo(r.page.pageId, odd.seq);
    const kept = await frames(r.page.pageId);
    expect(kept).toHaveLength(1);
    expect(kept[0]!.frame).toContain("\uFFFD");
  }, 60_000);

  it("a connection whose page has no proxy for a moment is not let go: the batch waits and is taken once it has one", async (context) => {
    if (!testDb) return context.skip();
    const r = await rig();
    await r.start();
    // The proxy goes away for a moment (the link's hello was said with it).
    const removed = await testDb.pool.query<{ row: unknown }>(
      "delete from egress_endpoints e where e.platform_account_id = $1 returning to_jsonb(e) as row",
      [r.page.pageId],
    );
    const connectionId = randomUUID();
    const opened = open(r.operator, connectionId);
    await new Promise((resolve) => setTimeout(resolve, 400));
    expect(await connections(r.page.pageId)).toEqual([]);
    expect(r.operator.buffer.acknowledged).toBe(0);
    await testDb.pool.query("insert into egress_endpoints select * from jsonb_populate_record(null::egress_endpoints, $1::jsonb)", [JSON.stringify(removed.rows[0]!.row)]);
    await committedUpTo(r.page.pageId, opened.seq);
    expect(await connections(r.page.pageId)).toHaveLength(1);
  }, 60_000);
});
