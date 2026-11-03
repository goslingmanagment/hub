import { randomUUID } from "node:crypto";
import { setTimeout as sleep } from "node:timers/promises";

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { insertPageBrowser, upsertDemand, type Database } from "@agency_hub_core/db";
import type { AppConfig } from "@agency_hub_core/shared";

import { readPageBrowserLinkRevision, readPageBrowserLinkSettings, sealPageBrowserSecrets } from "../apps/runtime/src/services/egress/page-browser-link.ts";
import { PageBrowserRpcClient } from "../apps/runtime/src/services/egress/page-browser-rpc.ts";
import { PART_LANE_KEY } from "../apps/runtime/src/sync/engine/part-lane.ts";
import { createEngineRegistry, type ResourceModule } from "../apps/runtime/src/sync/engine/resource.ts";
import { createBrowserPageTransport, readBrowserCredentialsGeneration } from "../apps/runtime/src/sync/fansly/browser-transport.ts";
import { resetIntegrationDatabase, startIntegrationTestDatabase, type StartedTestDatabase } from "./helpers/db.ts";
import { FakeOperator, OPERATOR_TOKEN, SESSION_A } from "./helpers/page-browser-operator.ts";
import { HARNESS_OWN_REF, harnessCdnUrlAllowed, harnessConfig, runActorUntil, seedHarnessPage, until } from "./helpers/sync-engine.ts";
import { makeTestActor, testSpec } from "./helpers/sync-engine-host.ts";

// The storage lane of a page's actor (vault packs, 0347): an upload's parts —
// works of `publish.part` — go a few at once beside the page's one managed
// request and outside its pause, where the page's browser says it takes them
// so (protocol minor 10: `uploads.parallelParts`). Each is admitted, sent and
// committed as any request of the actor, but its attempt applies no pause and
// takes no slot of the cycle; the actor's own pick leaves them to the lane.
// Here a part's request is a plain read (the lane's mechanics, not an
// upload's: publish/uploads.ts and the write module's tests have those).

const READ_KEY = "browser.read";
const PROXY = "socks5://127.0.0.1:1080";

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

/** The page's own standing read (its turns at the pacer; a due poll goes
 *  before any planned goal), and the lane's key: each of its works one
 *  request, closed by its answer. */
function registry(pollEveryMs = 20) {
  const poll: ResourceModule = {
    plan: async () => ({ kind: "request", request: { spec: "polls", params: {} } }),
    apply: async () => ({ work: { satisfiesRevision: true }, followups: [] }),
  };
  const part: ResourceModule = {
    plan: async () => ({ kind: "request", request: { spec: "account.walls", params: {} } }),
    apply: async () => ({ work: { satisfiesRevision: true, close: "done", closeReason: "part_done" }, followups: [] }),
  };
  return createEngineRegistry([
    testSpec(READ_KEY, poll, { kind: "poll", class: "planned", period: { everyMs: pollEveryMs } }),
    testSpec(PART_LANE_KEY, part, { kind: "goal", class: "planned" }),
  ]);
}

async function rig(protocolMinor?: number, pollEveryMs?: number) {
  const operator = await FakeOperator.start({ accountId: HARNESS_OWN_REF, ...(protocolMinor === undefined ? {} : { protocolMinor }) });
  cleanups.push(() => operator.close());
  const label = `lane-${randomUUID().slice(0, 8)}`;
  const page = await seedHarnessPage({ db: db(), pool: testDb!.pool }, { mode: "live", proxyUrl: PROXY, label });
  await insertPageBrowser(db(), {
    profileId: randomUUID(),
    container: `page-browser-${label}`,
    pageId: page.pageId,
    ...sealPageBrowserSecrets(config(), { engineToken: OPERATOR_TOKEN, apiToken: "api-token", vncPassword: "vnc-password" }),
  });
  const verified = await readBrowserCredentialsGeneration(db(), page.pageId, SESSION_A);
  await testDb!.pool.query("update sync_pages set credentials_generation = $2 where page_id = $1", [page.pageId, verified]);
  const pageSettings = {
    pinnedExitIp: "203.0.113.7",
    env: { timeZone: "Europe/Berlin", languages: ["en-US", "en"], geolocation: { latitude: 52.5, longitude: 13.4, accuracyM: 50 } },
  };
  const client = new PageBrowserRpcClient({
    url: operator.url,
    ownerGeneration: 1n,
    settings: () => readPageBrowserLinkSettings({ db: db(), config: config() }, page.pageId, pageSettings),
    revision: () => readPageBrowserLinkRevision({ db: db() }, page.pageId, pageSettings),
    timing: { pingMs: 100, linkLossMs: 1_000, helloTimeoutMs: 1_000, reconnectMs: [50, 100], refusedRetryMs: 500 },
  });
  const transport = await createBrowserPageTransport({ db: db(), config: config() }, { pageId: page.pageId }, {
    client,
    timing: { unavailableRetryMs: 200, resultWaitMs: 5_000 },
    cdnUrlAllowed: harnessCdnUrlAllowed,
  });
  cleanups.push(() => transport.close());
  await until(async () => client.up, 5_000, "the link to the operator");
  const made = await makeTestActor({ db: db(), pageId: page.pageId, registry: registry(pollEveryMs), transport, settingMs: 200, ownRef: HARNESS_OWN_REF });
  return { page, operator, client, made };
}

async function seedParts(pageId: number, count: number): Promise<void> {
  for (let index = 0; index < count; index += 1) {
    await upsertDemand(db(), {
      pageId, resource: PART_LANE_KEY, subject: `part-${index}`, kind: "goal", class: "planned",
      dueAt: new Date(Date.now() - 1_000), deadlineAt: null, demand: { reasons: ["test:part"] }, createOnly: true,
    });
  }
}

interface LaneAttempt {
  resource: string;
  outcome: string;
  pauseMs: number;
  slot: number | null;
}

async function attempts(pageId: number): Promise<LaneAttempt[]> {
  const result = await testDb!.pool.query<LaneAttempt>(
    `select resource, outcome, pause_ms as "pauseMs", slot from sync_attempts where page_id = $1 order by id`,
    [pageId],
  );
  return result.rows;
}

const isPart = (url: string) => new URL(url).pathname.endsWith("/account/walls");

describe("the storage lane (vault packs, 0347)", () => {
  it("sends a page's parts three at once, outside its pause, beside its own turns — each admitted and committed once", async (context) => {
    if (!testDb) return context.skip();
    const { page, operator, client, made } = await rig();
    expect(client.parallelParts).toBe(3);
    let inFlight = 0;
    let most = 0;
    let readsMeanwhile = 0;
    operator.beforeRelease = (send) => {
      if (isPart(send.url)) {
        inFlight += 1;
        most = Math.max(most, inFlight);
      } else if (inFlight > 0) {
        readsMeanwhile += 1;
      }
    };
    operator.beforeResult = async (send) => {
      if (!isPart(send.url)) return;
      // A part's bytes take a while to go up.
      await sleep(600);
      inFlight -= 1;
    };
    await seedParts(page.pageId, 7);
    await runActorUntil(made, async () => (await attempts(page.pageId)).filter((row) => row.resource === PART_LANE_KEY && row.outcome === "response").length >= 7, 30_000, "seven parts");
    expect(most).toBe(3);
    // The page's own reads went on at its pace while parts were on the wire.
    expect(readsMeanwhile).toBeGreaterThan(0);
    const rows = await attempts(page.pageId);
    const parts = rows.filter((row) => row.resource === PART_LANE_KEY);
    expect(parts).toHaveLength(7);
    // No pause applied, no slot of the cycle taken; the page's own reads keep both.
    expect(parts.every((row) => row.pauseMs === 0 && row.slot === null)).toBe(true);
    const reads = rows.filter((row) => row.resource === READ_KEY);
    expect(reads.length).toBeGreaterThan(0);
    expect(reads.every((row) => row.pauseMs >= 200 && row.slot !== null)).toBe(true);
    // Every part left once, under its own attempt.
    const physical = operator.physical.filter((request) => isPart(request.url)).map((request) => request.attemptId);
    expect(new Set(physical).size).toBe(7);
    expect(made.actor.laneAdmissions).toBe(7);
  }, 60_000);

  it("an operator that takes no parts at once (before minor 10): no lane — a part takes the page's turn, at its pause", async (context) => {
    if (!testDb) return context.skip();
    // Its own read seldom due: in the page's turn a due poll goes first.
    const { page, operator, client, made } = await rig(9, 60_000);
    expect(client.parallelParts).toBe(0);
    let inFlight = 0;
    let most = 0;
    operator.beforeRelease = (send) => {
      if (!isPart(send.url)) return;
      inFlight += 1;
      most = Math.max(most, inFlight);
    };
    operator.beforeResult = async (send) => {
      if (!isPart(send.url)) return;
      await sleep(100);
      inFlight -= 1;
    };
    await seedParts(page.pageId, 3);
    await runActorUntil(made, async () => (await attempts(page.pageId)).filter((row) => row.resource === PART_LANE_KEY && row.outcome === "response").length >= 3, 30_000, "three parts");
    expect(most).toBe(1);
    expect(made.actor.laneAdmissions).toBe(0);
    const parts = (await attempts(page.pageId)).filter((row) => row.resource === PART_LANE_KEY);
    expect(parts.every((row) => row.pauseMs >= 200 && row.slot !== null)).toBe(true);
  }, 60_000);
});
