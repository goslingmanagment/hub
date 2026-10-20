import { randomUUID } from "node:crypto";

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { insertPageBrowser, type Database } from "@agency_hub_core/db";
import type { AppConfig } from "@agency_hub_core/shared";

import { readPageBrowserLinkRevision, readPageBrowserLinkSettings, sealPageBrowserSecrets } from "../apps/runtime/src/services/egress/page-browser-link.ts";
import { PageBrowserRpcClient, type PageBrowserRpcTiming } from "../apps/runtime/src/services/egress/page-browser-rpc.ts";
import { SyncCrashFault, type SyncFaultHook } from "../apps/runtime/src/sync/engine/commit.ts";
import { createEngineRegistry, type EngineRegistry, type ResourceModule } from "../apps/runtime/src/sync/engine/resource.ts";
import type { PageTransport } from "../apps/runtime/src/sync/engine/ports.ts";
import { createBrowserPageTransport, readBrowserCredentialsGeneration } from "../apps/runtime/src/sync/fansly/browser-transport.ts";
import { fanslyResourceSpec } from "../apps/runtime/src/sync/fansly/registry.ts";
import { resetIntegrationDatabase, startIntegrationTestDatabase, type StartedTestDatabase } from "./helpers/db.ts";
import { FakeOperator, OPERATOR_TOKEN, SESSION_A, SESSION_B } from "./helpers/page-browser-operator.ts";
import {
  HARNESS_OWN_REF,
  harnessCdnUrlAllowed,
  harnessConfig,
  runActorUntil,
  seedHarnessPage,
  until,
  type HarnessPage,
} from "./helpers/sync-engine.ts";
import { makeTestActor, testSpec } from "./helpers/sync-engine-host.ts";

// The outcomes a page's operator keeps until the engine commits them
// (Project Browser plan §3.2 «Приём буфера и восстановление»; spec §6.1
// `recover`; stage 3 PR 13), on a live page's actor against a fake operator:
// - at the engine's start, BEFORE its recovery closes the attempts left
//   unfinished `unknown`, the operator is asked about them: its outcome,
//   resent, is committed and applied as the attempt's own; `not_sent` closes
//   it as not sent; `unknown` (or no operator within the wait) leaves it
//   `unknown`, as before — and its outcome, coming later, is kept as a fact,
//   never applied in its place;
// - a CDN reply whose capture committed and whose apply did not reaches the
//   describer's handoff after the restart;
// - the site path's ends (a site request's, a site socket's) settle their
//   attempts;
// - an answer of another session is kept as a fact, never applied;
// - nothing is ever sent again from what the operator kept.

const READ_KEY = "browser.read";
/** A `/polls` answer well past 64K characters. */
const LARGE_POLLS = { polls: Array.from({ length: 3_000 }, (_, i) => ({ id: String(1_000_000 + i), question: `question ${"x".repeat(40)}` })) };
const PROXY = "socks5://127.0.0.1:1080";
const TIMING: Partial<PageBrowserRpcTiming> = { pingMs: 100, linkLossMs: 1_000, helloTimeoutMs: 1_000, reconnectMs: [50, 100], refusedRetryMs: 500 };
const PAGE_SETTINGS = {
  pinnedExitIp: "203.0.113.7",
  env: { timeZone: "Europe/Berlin", languages: ["en-US", "en"], geolocation: { latitude: 52.5, longitude: 13.4, accuracyM: 50 } },
};

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

/** A standing read of `/polls` (its applies counted by attempt) and the
 *  production identity verify. */
function pollRegistry(applied: number[] = []): EngineRegistry {
  const poll: ResourceModule = {
    plan: async () => ({ kind: "request", request: { spec: "polls", params: {} } }),
    apply: async (_tx, input) => {
      applied.push(input.attempt.id);
      return { work: { satisfiesRevision: true }, followups: [] };
    },
  };
  return createEngineRegistry([
    testSpec(READ_KEY, poll, { kind: "poll", class: "planned", period: { everyMs: 20 } }),
    fanslyResourceSpec("account.verify")!,
  ]);
}

interface Rig {
  page: HarnessPage;
  operator: FakeOperator;
}

async function rig(): Promise<Rig> {
  const operator = await FakeOperator.start({ accountId: HARNESS_OWN_REF });
  cleanups.push(() => operator.close());
  const label = `held-${randomUUID().slice(0, 8)}`;
  const page = await seedHarnessPage({ db: db(), pool: testDb!.pool }, { mode: "live", proxyUrl: PROXY, label });
  await insertPageBrowser(db(), {
    profileId: randomUUID(),
    container: `page-browser-${label}`,
    pageId: page.pageId,
    ...sealPageBrowserSecrets(config(), { engineToken: OPERATOR_TOKEN, apiToken: "api-token", vncPassword: "vnc-password" }),
  });
  const verified = await readBrowserCredentialsGeneration(db(), page.pageId, SESSION_A);
  await testDb!.pool.query("update sync_pages set credentials_generation = $2 where page_id = $1", [page.pageId, verified]);
  return { page, operator };
}

interface Engine {
  client: PageBrowserRpcClient;
  transport: PageTransport;
  made: Awaited<ReturnType<typeof makeTestActor>>;
}

/** One run of the engine for the page: its link (of the generation its
 *  acquisition takes), its transport, its actor. */
async function engine(
  r: Rig,
  generation: bigint,
  options: {
    registry: EngineRegistry;
    faults?: SyncFaultHook;
    resultWaitMs?: number;
    settingsBlocked?: () => boolean;
    db?: Database;
    limits?: { lateMax: number; pendingMax: number };
  },
): Promise<Engine> {
  const client = new PageBrowserRpcClient({
    url: r.operator.url,
    ownerGeneration: generation,
    settings: async () => {
      if (options.settingsBlocked?.() === true) throw new Error("the page's settings do not read yet");
      return readPageBrowserLinkSettings({ db: db(), config: config() }, r.page.pageId, PAGE_SETTINGS);
    },
    revision: () => readPageBrowserLinkRevision({ db: db() }, r.page.pageId, PAGE_SETTINGS),
    timing: TIMING,
  });
  const transport = await createBrowserPageTransport({ db: db(), config: config() }, { pageId: r.page.pageId }, {
    client,
    timing: { unavailableRetryMs: 200, resultWaitMs: options.resultWaitMs ?? 5_000, recoverWaitMs: 1_000, ...options.limits },
    cdnUrlAllowed: harnessCdnUrlAllowed,
  });
  cleanups.push(() => transport.close());
  const made = await makeTestActor({
    db: options.db ?? db(),
    pageId: r.page.pageId,
    registry: options.registry,
    transport,
    settingMs: 60,
    ownRef: HARNESS_OWN_REF,
    ...(options.faults === undefined ? {} : { faults: options.faults }),
  });
  expect(made.generation).toBe(generation);
  return { client, transport, made };
}

/** The engine dies at `point` of its first request, its outcome kept by the
 *  operator: the attempt stays as the crash left it. */
async function crashAt(r: Rig, point: "after_admit" | "after_send" | "in_apply", registry: EngineRegistry): Promise<number> {
  const first = await engine(r, 1n, {
    registry,
    resultWaitMs: 300,
    faults: (at) => {
      if (at === point) throw new SyncCrashFault(at);
    },
  });
  if (point !== "after_admit") await until(async () => first.client.up, 5_000, "the link");
  await expect(first.made.actor.run({ stop: first.made.stop.signal, abort: first.made.abort.signal })).rejects.toBeInstanceOf(SyncCrashFault);
  await first.transport.close();
  const rows = await attempts(r.page.pageId);
  expect(rows).toHaveLength(1);
  return rows[0]!.id;
}

interface AttemptRow {
  id: number;
  resource: string;
  outcome: string;
  sendMark: string | null;
  errorClass: string | null;
  applyState: string;
  httpStatus: number | null;
  observationKey: string | null;
}

async function attempts(pageId: number): Promise<AttemptRow[]> {
  const result = await testDb!.pool.query<AttemptRow>(
    `select a.id::int, a.resource, a.outcome, a.send_mark as "sendMark", a.error_class as "errorClass", a.apply_state as "applyState",
            a.http_status as "httpStatus", k.idempotency_key as "observationKey"
       from sync_attempts a
       left join observation_keys k on k.observation_id = a.observation_id and k.received_at = a.observation_received_at
      where a.page_id = $1 order by a.id`,
    [pageId],
  );
  return result.rows;
}

async function attempt(pageId: number, id: number): Promise<AttemptRow | undefined> {
  return (await attempts(pageId)).find((row) => row.id === id);
}

async function observationsOfKind(pageId: number, kind: string): Promise<Array<{ payload: Record<string, unknown> }>> {
  const result = await testDb!.pool.query<{ payload: Record<string, unknown> }>(
    "select payload from observations where account_id = $1 and kind = $2 order by id",
    [pageId, kind],
  );
  return result.rows;
}

/** No `send` of an attempt that existed before the restart came after it. */
function nothingSentAgain(r: Rig, before: number, oldIds: readonly number[]): void {
  const later = r.operator.sends.slice(before);
  for (const id of oldIds) expect(later.filter((send) => send.attemptId === id), `attempt ${id}`).toEqual([]);
}

describe("at the engine's start, before the recovery closes anything unknown", () => {
  it("an outcome the operator kept is resent and committed as the attempt's own — captured, applied, acknowledged — never sent again", async (context) => {
    if (!testDb) return context.skip();
    const r = await rig();
    const applied: number[] = [];
    // The operator keeps the result and never delivers it to the first run.
    r.operator.deliverResults = false;
    const old = await crashAt(r, "after_send", pollRegistry(applied));
    expect(await attempt(r.page.pageId, old)).toMatchObject({ outcome: "admitted" });
    expect(r.operator.held.has(old)).toBe(true);
    expect(r.operator.physical.map((request) => request.attemptId)).toEqual([old]);
    const sends = r.operator.sends.length;

    r.operator.deliverResults = true;
    const second = await engine(r, 2n, { registry: pollRegistry(applied) });
    await runActorUntil(second.made, async () => r.operator.acks.includes(old), 20_000, "the kept outcome acknowledged");
    expect(r.operator.recovers[0]).toEqual([old]);
    expect(await attempt(r.page.pageId, old)).toMatchObject({
      outcome: "response",
      // Its `sent` went to the run that crashed: unknown to this one — the
      // result's own instant proves nothing (Astra's review of PR 15, round 6).
      sendMark: "completion_fallback",
      applyState: "applied",
      httpStatus: 200,
      observationKey: `fansly-sync:${r.page.pageId}:attempt:${old}`,
    });
    expect(applied.filter((id) => id === old)).toHaveLength(1);
    nothingSentAgain(r, sends, [old]);
    expect(r.operator.physical.filter((request) => request.attemptId === old)).toHaveLength(1);
  }, 60_000);

  it("not_sent: the operator's record shows it never left — closed as not sent, its work read again by a new attempt", async (context) => {
    if (!testDb) return context.skip();
    const r = await rig();
    r.operator.recoverState = () => "not_sent";
    const old = await crashAt(r, "after_admit", pollRegistry());
    expect(r.operator.sends).toEqual([]);
    const second = await engine(r, 2n, { registry: pollRegistry() });
    await runActorUntil(second.made, async () => r.operator.physical.length >= 1, 20_000, "a new read");
    expect(await attempt(r.page.pageId, old)).toMatchObject({ outcome: "aborted_before_send", errorClass: "not_sent:held", applyState: "none" });
    expect(r.operator.recovers[0]).toEqual([old]);
    nothingSentAgain(r, 0, [old]);
  }, 60_000);

  it("the operator out of reach at the start: unknown as before; its outcome, coming later, is kept as a fact — never applied in its place — and acknowledged", async (context) => {
    if (!testDb) return context.skip();
    const r = await rig();
    const applied: number[] = [];
    // A large answer: kept complete, never cut at 64K (Astra's review).
    r.operator.respond = () => ({ status: 200, headers: { "content-type": "application/json" }, body: JSON.stringify({ success: true, response: LARGE_POLLS }) });
    r.operator.deliverResults = false;
    const old = await crashAt(r, "after_send", pollRegistry(applied));
    const sends = r.operator.sends.length;
    r.operator.deliverResults = true;
    let blocked = true;
    const second = await engine(r, 2n, { registry: pollRegistry(applied), settingsBlocked: () => blocked });
    const run = second.made.actor.run({ stop: second.made.stop.signal, abort: second.made.abort.signal });
    try {
      // The recovery waited for the operator in vain: the attempt is unknown.
      await until(async () => (await attempt(r.page.pageId, old))?.outcome === "unknown", 10_000, "the attempt closed unknown");
      expect(r.operator.recovers).toEqual([]);
      blocked = false;
      await until(async () => r.operator.acks.includes(old), 20_000, "the late outcome acknowledged");
    } finally {
      second.made.stop.abort();
      await run;
    }
    expect(await attempt(r.page.pageId, old)).toMatchObject({ outcome: "unknown", applyState: "none" });
    const late = await observationsOfKind(r.page.pageId, "polls:late");
    expect(late).toHaveLength(1);
    expect(late[0]!.payload).toMatchObject({ status: 200, attemptId: old, disposition: "late_not_applied", answer: LARGE_POLLS });
    expect(JSON.stringify(late[0]!.payload).length).toBeGreaterThan(64 * 1024);
    expect(applied).not.toContain(old);
    nothingSentAgain(r, sends, [old]);
  }, 60_000);
});

describe("between steps", () => {
  it("an answer of another session is never the request's: kept as a fact, never applied, acknowledged", async (context) => {
    if (!testDb) return context.skip();
    const r = await rig();
    const applied: number[] = [];
    r.operator.resultSession = SESSION_B;
    const run = await engine(r, 1n, { registry: pollRegistry(applied) });
    await runActorUntil(run.made, async () => r.operator.acks.length >= 1, 20_000, "an answer acknowledged");
    const id = r.operator.acks[0]!;
    expect(await attempt(r.page.pageId, id)).toMatchObject({ outcome: "transport_error", applyState: "none" });
    const kept = await observationsOfKind(r.page.pageId, "polls:foreign_session");
    expect(kept.length).toBeGreaterThanOrEqual(1);
    expect(kept[0]!.payload).toMatchObject({ status: 200, attemptId: id, disposition: "rejected_foreign_session" });
    expect(applied).toEqual([]);
    // Each was sent once.
    const ids = r.operator.physical.map((request) => request.attemptId);
    expect(new Set(ids).size).toBe(ids.length);
  }, 60_000);
});

// Astra's review of PR 13: nothing from a doubtful source is applied, and
// nothing is acknowledged before it is kept in full.
describe("the review of PR 13", () => {
  it("a recovered answer of another session is never applied: kept as a fact, the attempt settled as a request that went without its answer", async (context) => {
    if (!testDb) return context.skip();
    const r = await rig();
    const applied: number[] = [];
    r.operator.deliverResults = false;
    r.operator.resultSession = SESSION_B;
    const old = await crashAt(r, "after_send", pollRegistry(applied));
    r.operator.deliverResults = true;
    const second = await engine(r, 2n, { registry: pollRegistry(applied) });
    await runActorUntil(second.made, async () => r.operator.acks.includes(old), 20_000, "the foreign answer acknowledged");
    expect(await attempt(r.page.pageId, old)).toMatchObject({ outcome: "transport_error", applyState: "none", observationKey: null });
    expect(applied).not.toContain(old);
    const kept = (await observationsOfKind(r.page.pageId, "polls:foreign_session")).filter((row) => row.payload.attemptId === old);
    expect(kept).toHaveLength(1);
    expect(kept[0]!.payload).toMatchObject({ disposition: "rejected_foreign_session", status: 200, answer: [] });
  }, 60_000);
});
