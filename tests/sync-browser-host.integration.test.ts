// A live page on a real host (Project Browser plan §3.2, §4.7, §4.13): the
// page sends through its own browser — a fake operator, the operator's own
// RPC server — and nothing else. Every send is the operator's
// (`transport_reported`), nothing reaches a Fansly origin from the process,
// the hand-over to the owner is recorded, and a new owner of the page (the
// next host) sends its first request ≥ 1.2 × S after the previous owner's
// last one (S at least the owner's 2 s minimum, I5).

import { randomUUID } from "node:crypto";

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { findPageBrowserByPage, insertPageBrowser, setPageBrowserSettings, type Database } from "@agency_hub_core/db";

import { sealPageBrowserSecrets } from "../apps/runtime/src/services/egress/page-browser-link.ts";
import { SyncEngineHost } from "../apps/runtime/src/sync/engine/host.ts";
import { readBrowserCredentialsGeneration } from "../apps/runtime/src/sync/fansly/browser-transport.ts";
import { resetIntegrationDatabase, startIntegrationTestDatabase, type StartedTestDatabase } from "./helpers/db.ts";
import { FakeOperator, linkSettings, OPERATOR_TOKEN, SESSION_A } from "./helpers/page-browser-operator.ts";
import {
  ensureHarnessSettingTable,
  FakeFanslyServer,
  HARNESS_OWN_REF,
  harnessConfig,
  harnessHostOptions,
  harnessIdentityRegistry,
  harnessRng,
  seedHarnessPage,
  until,
} from "./helpers/sync-engine.ts";

const S = 300;
/** The takeover floor's setting: S, at least the owner's minimum (I4). */
const FLOOR_S = 2_000;
const ENV = { timeZone: "Europe/Berlin", languages: ["en-US", "en"], geolocation: { latitude: 52.5, longitude: 13.4, accuracyM: 50 } };
const RPC_TIMING = { pingMs: 100, linkLossMs: 1_000, helloTimeoutMs: 1_000, reconnectMs: [50, 100], refusedRetryMs: 500 };

let testDb: StartedTestDatabase | null = null;
const cleanups: Array<() => Promise<void> | void> = [];

function db(): Database {
  return testDb!.db as unknown as Database;
}

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

interface Rig {
  server: FakeFanslyServer;
  operator: FakeOperator;
  pageId: number;
  config: ReturnType<typeof harnessConfig>;
}

/** A live page with its browser ready (a profile bound, its exit IP pinned,
 *  its environment set) and its browser's session trusted by the engine. */
async function rig(): Promise<Rig> {
  const server = await FakeFanslyServer.start();
  const operator = await FakeOperator.start({ accountId: HARNESS_OWN_REF });
  cleanups.push(async () => {
    await server.close();
    await operator.close();
  });
  // Its state every 100 ms, as the real operator every 5 s.
  operator.startStatePushes(100);
  const label = `browser-${randomUUID().slice(0, 8)}`;
  // The page's proxy: its browser's way out (the operator stands in for it).
  const page = await seedHarnessPage({ db: db(), pool: testDb!.pool }, { mode: "live", proxyUrl: "socks5://127.0.0.1:1080", label });
  const config = harnessConfig(testDb!.connectionString, server.apiBaseUrl);
  const profileId = randomUUID();
  await insertPageBrowser(db(), {
    profileId,
    container: `page-browser-${label}`,
    pageId: page.pageId,
    ...sealPageBrowserSecrets(config, { engineToken: OPERATOR_TOKEN, apiToken: "api-token", vncPassword: "vnc-password" }),
  });
  await setPageBrowserSettings(db(), { profileId, pinnedExitIp: "203.0.113.7", env: ENV });
  await testDb!.pool.query("update sync_pages set credentials_generation = $2 where page_id = $1",
    [page.pageId, await readBrowserCredentialsGeneration(db(), page.pageId, SESSION_A)]);
  return { server, operator, pageId: page.pageId, config };
}

/** The production host over the harness, its pages on their browsers: no
 *  stand-in transport. */
async function startHost(r: Rig): Promise<SyncEngineHost> {
  const { liveTransportFactory: _standIn, ...options } = harnessHostOptions({
    db: db(),
    pool: testDb!.pool,
    connectionString: testDb!.connectionString,
    config: r.config,
    rng: harnessRng(11),
    registry: harnessIdentityRegistry(),
  });
  const host = new SyncEngineHost({
    ...options,
    browserOverrides: {
      url: () => r.operator.url,
      settings: async (pageId) => linkSettings({ pageId, expectedAccountId: HARNESS_OWN_REF }),
      rpcTiming: RPC_TIMING,
      transportTiming: { unavailableRetryMs: 100, resultWaitMs: 10_000 },
    },
  });
  cleanups.push(() => host.stop());
  await host.start();
  return host;
}

interface AttemptRow {
  id: number;
  generation: string;
  resource: string | null;
  outcome: string;
  sendMark: string | null;
  sentAt: Date | null;
}

async function attempts(pageId: number): Promise<AttemptRow[]> {
  return (await testDb!.pool.query<AttemptRow>(
    `select a.id::int, a.owner_generation::text as generation, w.resource, a.outcome, a.send_mark as "sendMark", a.sent_at as "sentAt"
       from sync_attempts a left join sync_work w on w.id = a.work_id
      where a.page_id = $1 order by a.id`,
    [pageId],
  )).rows;
}

function sendsOf(rows: AttemptRow[], generation: bigint): AttemptRow[] {
  return rows.filter((row) => row.generation === generation.toString() && row.sentAt !== null);
}

describe("a live page on a real host", () => {
  it("sends through its browser alone: the operator's sends, nothing from the process, the hand-over recorded", async (context) => {
    if (!testDb) return context.skip();
    const r = await rig();
    const host = await startHost(r);
    await until(async () => r.operator.physical.length >= 3, 30_000, "the page running on its browser");
    const owner = host.state(r.pageId);
    expect(owner.kind).toBe("running");
    const generation = owner.kind === "running" ? owner.generation : 0n;

    const rows = await attempts(r.pageId);
    const sends = sendsOf(rows, generation);
    expect(sends.length).toBeGreaterThanOrEqual(3);
    // Every answered send carries the instant the browser reported.
    expect([...new Set(sends.filter((row) => row.outcome !== "sent").map((row) => row.sendMark))]).toEqual(["transport_reported"]);
    // Every physical request is an admission of this owner.
    const admissions = new Set(rows.filter((row) => row.generation === generation.toString()).map((row) => row.id));
    expect(r.operator.physical.every((request) => admissions.has(request.attemptId))).toBe(true);
    expect(r.operator.physical[0]!.generation).toBe(Number(generation));
    // Nothing reached a Fansly origin from the process itself.
    expect(r.server.arrivals).toEqual([]);
    // The hand-over: the operator's quiesced for this owner, recorded.
    await until(async () => (await findPageBrowserByPage(db(), r.pageId))!.handoverGeneration === generation, 5_000, "the hand-over");
    // A running page's browser is never told to stop.
    expect(r.operator.commands).toEqual([]);
  }, 90_000);

  it("a new owner's first send through the browser is ≥ 1.2 × S after the previous owner's last one", async (context) => {
    if (!testDb) return context.skip();
    const r = await rig();
    const first = await startHost(r);
    await until(async () => r.operator.physical.length >= 2, 30_000, "the page running on its browser");
    const g1 = (first.state(r.pageId) as { generation: bigint }).generation;
    await first.stop();

    const second = await startHost(r);
    const g2 = g1 + 1n;
    await until(async () => sendsOf(await attempts(r.pageId), g2).length >= 1, 30_000, "the new owner's first send");
    expect(second.state(r.pageId)).toMatchObject({ kind: "running", generation: g2 });
    const rows = await attempts(r.pageId);
    const lastBefore = sendsOf(rows, g1).at(-1)!;
    const firstAfter = sendsOf(rows, g2)[0]!;
    expect(firstAfter.sentAt!.getTime() - lastBefore.sentAt!.getTime()).toBeGreaterThanOrEqual(1.2 * FLOOR_S);
  }, 90_000);
});
