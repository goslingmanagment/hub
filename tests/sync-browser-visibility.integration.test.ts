import { randomUUID } from "node:crypto";

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";

import {
  agentSyncPageStatusSchema,
} from "@agency_hub_core/contracts";
import {
  findPageBrowserByPage,
  insertPageBrowser,
  listSyncPages,
  markPageBrowserUndrained,
  setPageBrowserSettings,
  setSyncPageTransport,
  type Database,
} from "@agency_hub_core/db";

import { sealPageBrowserSecrets } from "../apps/runtime/src/services/egress/page-browser-link.ts";
import { SYNC_BROWSER_AUDIT_EVENTS } from "../apps/runtime/src/sync/browser-levers.ts";
import { buildSyncEngineCommandGroup } from "../apps/runtime/src/sync/cli.ts";
import { SyncAlertEvaluator } from "../apps/runtime/src/sync/engine/alerts.ts";
import { SyncEngineHost } from "../apps/runtime/src/sync/engine/host.ts";
import { readBrowserCredentialsGeneration } from "../apps/runtime/src/sync/fansly/browser-transport.ts";
import { readSyncPageStatuses } from "../apps/runtime/src/sync/inspect.ts";
import { toSyncPageStatusWire } from "../apps/runtime/src/sync/requests/wire.ts";
import { resetIntegrationDatabase, startIntegrationTestDatabase, type StartedTestDatabase } from "./helpers/db.ts";
import { FakeOperator, linkSettings, OPERATOR_TOKEN, SESSION_A } from "./helpers/page-browser-operator.ts";
import { quietLogger } from "./helpers/sync-engine-host.ts";
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
  until,
  type HarnessPage,
} from "./helpers/sync-engine.ts";

// A page's browser made visible and steerable (Project Browser plan §4.11;
// stage 3 PR 17) on a real host, its browser a fake operator (the operator's
// own RPC server):
// - what the operator says of itself goes on its profile's row — its state,
//   its alarm — and from there to the page's status (the «Браузер» block,
//   `/api/v1/sync/pages`, the agents' status: no secret in it) and to the
//   alert evaluator's `browser:<kind>` latches;
// - the owner's levers through the CLI, each audited: the stop (the page
//   paused, the operator told to stop, until it says it did) and the start
//   (the stop and its pause lifted, the browser started), the self-test (the
//   exit closed for it and opened again), the pin of the exit IP;
// - the browser started at the switch to it, never while the page is paused;
// - the drain of a stopped container's buffer while the page stays on Node.

const S = 300;
const ENV = { timeZone: "Europe/Berlin", languages: ["en-US", "en"], geolocation: { latitude: 52.5, longitude: 13.4, accuracyM: 50 } };
const RPC_TIMING = { pingMs: 100, linkLossMs: 1_000, helloTimeoutMs: 1_000, reconnectMs: [50, 100], refusedRetryMs: 500 };
const SECRETS = { engineToken: OPERATOR_TOKEN, apiToken: "api-token-3c9d1e", vncPassword: "vnc-password-77a0b2" };

let testDb: StartedTestDatabase | null = null;
const cleanups: Array<() => Promise<void> | void> = [];

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

function db(): Database {
  return testDb!.db as unknown as Database;
}

interface Rig {
  server: FakeFanslyServer;
  operator: FakeOperator;
  page: HarnessPage;
  profileId: string;
  config: ReturnType<typeof harnessConfig>;
}

async function rig(): Promise<Rig> {
  const server = await FakeFanslyServer.start();
  const proxy = await CountingConnectProxy.start();
  const operator = await FakeOperator.start({ accountId: HARNESS_OWN_REF });
  cleanups.push(async () => {
    await server.close();
    await proxy.close();
    await operator.close();
  });
  operator.startStatePushes(100);
  for (const route of harnessRoutes(new FakeChats())) server.route(route);
  const label = `visible-${randomUUID().slice(0, 8)}`;
  const page = await seedHarnessPage({ db: db(), pool: testDb!.pool }, { mode: "live", proxyUrl: proxy.url, label });
  const config = harnessConfig(testDb!.connectionString, server.apiBaseUrl);
  const profileId = randomUUID();
  await insertPageBrowser(db(), { profileId, container: `page-browser-${label}`, pageId: page.pageId, ...sealPageBrowserSecrets(config, SECRETS) });
  await setPageBrowserSettings(db(), { profileId, pinnedExitIp: "203.0.113.7", env: ENV });
  return { server, operator, page, profileId, config };
}

async function onBrowser(r: Rig): Promise<void> {
  await db().transaction(async (raw) => setSyncPageTransport(raw as unknown as Database, { pageId: r.page.pageId, to: "browser" }));
  await testDb!.pool.query("update sync_pages set credentials_generation = $2 where page_id = $1",
    [r.page.pageId, await readBrowserCredentialsGeneration(db(), r.page.pageId, SESSION_A)]);
}

async function startHost(r: Rig): Promise<SyncEngineHost> {
  const host = new SyncEngineHost({
    ...harnessHostOptions({
      db: db(),
      pool: testDb!.pool,
      connectionString: testDb!.connectionString,
      config: r.config,
      rng: harnessRng(17),
      registry: harnessIdentityRegistry(),
    }),
    browserOverrides: {
      url: () => r.operator.url,
      settings: async (pageId) => linkSettings({ pageId, expectedAccountId: HARNESS_OWN_REF }),
      rpcTiming: RPC_TIMING,
      transportTiming: { unavailableRetryMs: 100, resultWaitMs: 10_000 },
      leaveWaitMs: 5_000,
      recorderTiming: { stateRefreshMs: 500, deliveryWriteMs: 200 },
      controlTiming: { everyMs: 100, stopEveryMs: 300, startEveryMs: 1_000, commandWaitMs: 3_000 },
    },
  });
  cleanups.push(() => host.stop());
  await host.start();
  return host;
}

function cli(r: Rig, printed: string[]) {
  return buildSyncEngineCommandGroup({
    openContext: async () => ({ db: db(), rawConfig: r.config, close: async () => undefined }),
    print: (line) => printed.push(line),
  });
}

async function audits(pageId: number, eventType: string): Promise<Array<Record<string, unknown>>> {
  return (await testDb!.pool.query<{ metadata: Record<string, unknown> }>(
    "select metadata from audit_events where platform_account_id = $1 and event_type = $2 order by id", [pageId, eventType],
  )).rows.map((row) => row.metadata);
}

async function browserRow(pageId: number) {
  return (await findPageBrowserByPage(db(), pageId))!;
}

async function pause(pageId: number): Promise<{ pausedAll: boolean; note: string | null }> {
  return (await testDb!.pool.query<{ pausedAll: boolean; note: string | null }>(
    `select paused_all as "pausedAll", pause_note as note from sync_pages where page_id = $1`, [pageId],
  )).rows[0]!;
}

const kindsOf = (r: Rig) => r.operator.commands.map((command) => command.command.kind);

async function stopOwnsPause(pageId: number): Promise<boolean> {
  return (await testDb!.pool.query<{ mine: boolean }>("select browser_stop_paused as mine from sync_pages where page_id = $1", [pageId])).rows[0]!.mine;
}

describe("what the operator says goes on its profile's row, to the status and the alerts", () => {
  it("its state, its alarm and the delivery of its events; the status block without a secret; the evaluator's browser latches", async (context) => {
    if (!testDb) return context.skip();
    const r = await rig();
    await onBrowser(r);
    const host = await startHost(r);
    await until(async () => (await browserRow(r.page.pageId)).lastStateAt !== null, 15_000, "the operator's state recorded");
    expect(host.state(r.page.pageId).kind).toBe("running");
    r.operator.pushState({ step: "ready" });
    await until(async () => (await browserRow(r.page.pageId)).step === "ready", 10_000, "ready recorded");
    // An event of the site's socket: its delivery measured.
    r.operator.append({ kind: "gap", fromSeq: null, fromWall: null, reason: "operator_start" });
    r.operator.alarm("header_mismatch", { route: "account.me", hubHeaders: 4, siteHeaders: 5 });
    await until(async () => (await browserRow(r.page.pageId)).alarmKind === "header_mismatch", 10_000, "the alarm recorded");
    await until(async () => (await browserRow(r.page.pageId)).deliveryP95Ms !== null, 10_000, "the delivery measured");
    const row = await browserRow(r.page.pageId);
    expect(row).toMatchObject({
      step: "ready", stopReason: null, exitOpen: true, downSince: null, exitIp: "203.0.113.7", chromeVersion: "155.0.0.0",
      alarmDetail: { route: "account.me", hubHeaders: 4, siteHeaders: 5 }, linkError: null,
    });

    const [status] = (await readSyncPageStatuses(db(), r.config, await listSyncPages(db()))).filter((entry) => entry.pageLabel === r.page.pageLabel);
    const wire = toSyncPageStatusWire(status!);
    expect(agentSyncPageStatusSchema.parse(wire)).toEqual(wire);
    expect(wire.browser).toMatchObject({
      profileId: r.profileId,
      transport: "browser",
      state: { step: "ready", stopReason: null, exitOpen: true, mode: "automation" },
      session: { present: true, accountId: HARNESS_OWN_REF },
      proxy: { pinnedExitIp: "203.0.113.7", exitIp: "203.0.113.7", matches: true, problem: null },
      versions: { chrome: "155.0.0.0", operator: "test" },
      alarm: { kind: "header_mismatch" },
      alerts: [{ kind: "protocol_changed", detail: "alarm_header_mismatch" }],
    });
    expect(wire.browser!.delivery.lastEventAt).not.toBeNull();
    const text = JSON.stringify(wire);
    for (const secret of [OPERATOR_TOKEN, SECRETS.apiToken, SECRETS.vncPassword, SESSION_A, row.sessionFingerprint!]) expect(text).not.toContain(secret);

    const evaluator = new SyncAlertEvaluator({ db: db(), logger: quietLogger, registry: harnessIdentityRegistry() });
    const pass = await evaluator.runOnce();
    expect(pass!.opened).toContainEqual({ pageId: r.page.pageId, subKey: "browser:protocol_changed", detail: "alarm_header_mismatch" });
    expect(pass!.unevaluated).toEqual([]);
    const latches = await testDb.pool.query<{ key: string; summary: string }>(
      "select incident_key as key, error_summary as summary from notification_incidents where status = 'open' and incident_key like $1",
      [`fansly_sync_engine:${r.page.pageId}:browser:%`],
    );
    expect(latches.rows.map((latch) => latch.key)).toEqual([`fansly_sync_engine:${r.page.pageId}:browser:protocol_changed`]);

    // The operator goes silent while the page's owner runs: browser_down.
    await r.operator.close();
    await testDb.pool.query("update page_browsers set last_state_at = clock_timestamp() - interval '3 minutes' where profile_id = $1", [r.profileId]);
    // A slot taken 3 min ago (a fresh one has the bound's grace), its owner beating.
    await testDb.pool.query("update sync_pages set owner_acquired_at = clock_timestamp() - interval '3 minutes' where page_id = $1", [r.page.pageId]);
    const silent = await evaluator.runOnce();
    expect(silent!.opened).toContainEqual({ pageId: r.page.pageId, subKey: "browser:browser_down", detail: "no_state" });
  }, 90_000);

  it("a page on Node with a browser: the block says so, nothing of it pages, its browser is never linked; a page without one has no block", async (context) => {
    if (!testDb) return context.skip();
    const r = await rig();
    const plain = await seedHarnessPage({ db: db(), pool: testDb.pool }, { mode: "live", proxyUrl: null, label: `plain-${randomUUID().slice(0, 8)}`, ownRef: "300000000000000999" });
    // The browser said it was down long ago: on Node that pages nobody.
    await testDb.pool.query(
      "update page_browsers set step = 'exit_closed', stop_reason = 'proxy_unavailable', down_since = clock_timestamp() - interval '1 hour', last_state_at = clock_timestamp() - interval '1 hour' where profile_id = $1",
      [r.profileId],
    );
    const statuses = await readSyncPageStatuses(db(), r.config, await listSyncPages(db()));
    const withBrowser = toSyncPageStatusWire(statuses.find((entry) => entry.pageLabel === r.page.pageLabel)!);
    const without = toSyncPageStatusWire(statuses.find((entry) => entry.pageLabel === plain.pageLabel)!);
    expect(withBrowser.browser).toMatchObject({ transport: "node", alerts: [] });
    expect("browser" in without).toBe(false);
    const evaluator = new SyncAlertEvaluator({ db: db(), logger: quietLogger, registry: harnessIdentityRegistry() });
    const pass = await evaluator.runOnce();
    expect(pass!.opened.filter((entry) => entry.subKey.startsWith("browser:"))).toEqual([]);
    expect(pass!.unevaluated).toEqual([]);
    const recorded = await testDb.pool.query<{ rule: string; failure: string | null }>(
      "select rule, failure from sync_alert_evaluations where page_id = $1 and rule = 'browser'", [r.page.pageId],
    );
    expect(recorded.rows).toEqual([{ rule: "browser", failure: null }]);
    const host = await startHost(r);
    await until(async () => r.server.arrivalsAt("/api/v1/polls").length >= 1, 20_000, "the page running on Node");
    expect(host.state(r.page.pageId).kind).toBe("running");
    expect(r.operator.links).toEqual([]);
  }, 60_000);
});

describe("the owner's levers (sync browser …), each audited", () => {
  it("stop: the page paused and its operator told to stop until it says it did; start: the stop and its pause lifted, the browser started", async (context) => {
    if (!testDb) return context.skip();
    const r = await rig();
    await onBrowser(r);
    r.operator.onOtherCommand = (command) => {
      if (command.command.kind !== "restartBrowser") return { ok: false, detail: "not in this fake" };
      r.operator.pushState({ step: "ready", stopReason: null, exitOpen: true });
      return { ok: true, detail: "the start began" };
    };
    await startHost(r);
    r.operator.pushState({ step: "ready" });
    await until(async () => (await browserRow(r.page.pageId)).step === "ready", 15_000, "ready recorded");
    const printed: string[] = [];
    await cli(r, printed).parseAsync(["browser", "stop", r.page.pageLabel, "--note", "drill", "--wait-ms", "15000"], { from: "user" });
    const stopped = JSON.parse(printed.join("\n"));
    expect(stopped.stopped).toEqual([expect.objectContaining({ page: r.page.pageLabel, already: false, pausedByStop: true, operatorConfirmed: true })]);
    expect(kindsOf(r)).toEqual(["stopPage"]);
    expect(await pause(r.page.pageId)).toEqual({ pausedAll: true, note: "the owner stopped the page's browser (sync browser stop)" });
    expect(await browserRow(r.page.pageId)).toMatchObject({ stopReason: "owner_stop", exitOpen: false });
    expect(await stopOwnsPause(r.page.pageId)).toBe(true);
    expect(await audits(r.page.pageId, SYNC_BROWSER_AUDIT_EVENTS.stop)).toEqual([expect.objectContaining({ pageLabel: r.page.pageLabel, note: "drill", pausedByStop: true })]);
    // Kept stopped: nothing starts it while the stop stands.
    await new Promise((resolve) => setTimeout(resolve, 1_500));
    expect(kindsOf(r)).toEqual(["stopPage"]);

    printed.length = 0;
    await cli(r, printed).parseAsync(["browser", "start", r.page.pageLabel], { from: "user" });
    const started = JSON.parse(printed.join("\n"));
    expect(started).toMatchObject({ page: r.page.pageLabel, wasStopped: true, resumed: true, result: { ok: true } });
    expect(kindsOf(r)).toEqual(["stopPage", "restartBrowser"]);
    expect(await pause(r.page.pageId)).toEqual({ pausedAll: false, note: null });
    expect((await browserRow(r.page.pageId)).ownerStopAt).toBeNull();
    expect(await audits(r.page.pageId, SYNC_BROWSER_AUDIT_EVENTS.start)).toEqual([expect.objectContaining({ wasStopped: true, resumed: true })]);
  }, 90_000);

  it("a stop of a page the owner paused before keeps his pause at the start; stop --all reaches every page with a browser", async (context) => {
    if (!testDb) return context.skip();
    const r = await rig();
    await testDb.pool.query("update sync_pages set paused_all = true, pause_note = 'mine' where page_id = $1", [r.page.pageId]);
    const printed: string[] = [];
    await cli(r, printed).parseAsync(["browser", "stop", "--all", "--wait-ms", "200"], { from: "user" });
    expect(JSON.parse(printed.join("\n")).stopped).toEqual([expect.objectContaining({ page: r.page.pageLabel, pausedByStop: false, operatorConfirmed: false })]);
    expect(await pause(r.page.pageId)).toEqual({ pausedAll: true, note: "mine" });
    printed.length = 0;
    await cli(r, printed).parseAsync(["browser", "start", r.page.pageLabel, "--wait-ms", "200"], { from: "user" });
    expect(JSON.parse(printed.join("\n"))).toMatchObject({ wasStopped: true, resumed: false });
    expect(await pause(r.page.pageId)).toEqual({ pausedAll: true, note: "mine" });
    await expect(cli(r, printed).parseAsync(["browser", "stop"], { from: "user" })).rejects.toThrow(/name one page, or --all/);
  }, 30_000);

  it("start lifts no pause the owner changed after the stop: his own pause stays (Astra PR 17, P1-4)", async (context) => {
    if (!testDb) return context.skip();
    const r = await rig();
    const printed: string[] = [];
    await cli(r, printed).parseAsync(["browser", "stop", r.page.pageLabel, "--wait-ms", "200"], { from: "user" });
    expect(await stopOwnsPause(r.page.pageId)).toBe(true);
    // The owner pauses the page himself: the pause is his now.
    await cli(r, printed).parseAsync(["page", "pause", "--page", r.page.pageLabel, "--all", "--note", "maintenance"], { from: "user" });
    expect(await stopOwnsPause(r.page.pageId)).toBe(false);
    printed.length = 0;
    await cli(r, printed).parseAsync(["browser", "start", r.page.pageLabel, "--wait-ms", "200"], { from: "user" });
    expect(JSON.parse(printed.join("\n"))).toMatchObject({ wasStopped: true, resumed: false });
    expect(await pause(r.page.pageId)).toEqual({ pausedAll: true, note: "maintenance" });
    // Resumed by him after a stop, then paused again: still his.
    await cli(r, printed).parseAsync(["browser", "stop", r.page.pageLabel, "--wait-ms", "200"], { from: "user" });
    await cli(r, printed).parseAsync(["page", "resume", "--page", r.page.pageLabel, "--all"], { from: "user" });
    await cli(r, printed).parseAsync(["page", "pause", "--page", r.page.pageLabel, "--all", "--note", "again mine"], { from: "user" });
    await cli(r, printed).parseAsync(["browser", "start", r.page.pageLabel, "--wait-ms", "200"], { from: "user" });
    expect(await pause(r.page.pageId)).toEqual({ pausedAll: true, note: "again mine" });
    expect(await audits(r.page.pageId, SYNC_BROWSER_AUDIT_EVENTS.start)).toEqual([
      expect.objectContaining({ resumed: false }), expect.objectContaining({ resumed: false }),
    ]);
  }, 30_000);

  it("snapshot: the profile is quiet only once the operator answered this stop — after Chrome is down, not when it says the stop (Astra PR 17, P1-3)", async (context) => {
    if (!testDb) return context.skip();
    const r = await rig();
    await onBrowser(r);
    await startHost(r);
    r.operator.pushState({ step: "ready" });
    await until(async () => (await browserRow(r.page.pageId)).step === "ready", 15_000, "ready recorded");
    // Chrome takes 2.5 s to go down; the operator says the stop at once.
    r.operator.chromeStopMs = 2_500;
    const printed: string[] = [];
    let stateSaidAt: number | null = null;
    const watch = (async () => {
      await until(async () => (await browserRow(r.page.pageId)).stopReason === "owner_stop", 15_000, "the stop said");
      stateSaidAt = Date.now();
    })();
    const begun = Date.now();
    await cli(r, printed).parseAsync(["browser", "snapshot", r.page.pageLabel, "--wait-ms", "15000"], { from: "user" });
    const answeredAt = Date.now();
    await watch;
    const snapshot = JSON.parse(printed.join("\n"));
    expect(snapshot).toMatchObject({ operatorConfirmed: true, confirmation: { ok: true } });
    expect(snapshot.follows).toContain("the profile is quiet");
    expect(answeredAt - begun).toBeGreaterThanOrEqual(2_400);
    expect(stateSaidAt! - begun).toBeLessThan(answeredAt - begun - 1_000);
    expect(await audits(r.page.pageId, SYNC_BROWSER_AUDIT_EVENTS.snapshot)).toHaveLength(1);

    // A Chrome that does not go down: no snapshot.
    printed.length = 0;
    r.operator.chromeStopMs = 0;
    r.operator.chromeStays = true;
    await expect(cli(r, printed).parseAsync(["browser", "snapshot", r.page.pageLabel, "--wait-ms", "15000"], { from: "user" }))
      .rejects.toThrow(/has not said its browser stopped; no snapshot now/);
    expect(JSON.parse(printed.join("\n"))).toMatchObject({ operatorConfirmed: false, confirmation: { ok: false, detail: "the exit is closed, but Chrome is still up" } });
  }, 60_000);

  it("a halt for the owner's decision is the operator's (held across its restarts): Hub mirrors it, nothing starts it; the owner's audited start clears it by its id, then starts the browser (Astra PR 17, rounds 1 and 3)", async (context) => {
    if (!testDb) return context.skip();
    const r = await rig();
    await onBrowser(r);
    r.operator.onOtherCommand = (command) => {
      if (command.command.kind !== "restartBrowser") return { ok: false, detail: "not in this fake" };
      r.operator.pushState({ step: "ready", stopReason: null, exitOpen: true });
      return { ok: true, detail: "the start began" };
    };
    await startHost(r);
    // Headers that differ from the site's: the operator holds a halt for the owner.
    const halt = { id: randomUUID(), reason: "header_mismatch" as const, atWall: Date.now() };
    r.operator.pushState({ step: "exit_closed", exitOpen: false, stopReason: "header_mismatch", retryAtWall: null, halt });
    await until(async () => (await browserRow(r.page.pageId)).haltId === halt.id, 15_000, "the halt mirrored");
    // The operator starts again: it stands with no reason, still holding the halt.
    r.operator.pushState({ step: "exit_closed", exitOpen: false, stopReason: null, retryAtWall: null, halt });
    await until(async () => (await browserRow(r.page.pageId)).stopReason === null, 10_000, "the stand recorded");
    await new Promise((resolve) => setTimeout(resolve, 1_500));
    expect(kindsOf(r)).toEqual([]);
    const [status] = (await readSyncPageStatuses(db(), r.config, await listSyncPages(db()))).filter((entry) => entry.pageLabel === r.page.pageLabel);
    expect(status!.browser).toMatchObject({ halt: { reason: "header_mismatch" }, alerts: [{ kind: "protocol_changed", detail: "header_mismatch" }] });

    const printed: string[] = [];
    await cli(r, printed).parseAsync(["browser", "start", r.page.pageLabel, "--note", "headers checked"], { from: "user" });
    expect(JSON.parse(printed.join("\n"))).toMatchObject({ halt: { id: halt.id, reason: "header_mismatch" }, result: { outcome: "ok", ok: true } });
    expect(kindsOf(r)).toEqual(["clearHalt", "restartBrowser"]);
    await until(async () => (await browserRow(r.page.pageId)).haltReason === null, 10_000, "the mirror cleared with the operator's state");
    expect(await audits(r.page.pageId, SYNC_BROWSER_AUDIT_EVENTS.start)).toEqual([
      expect.objectContaining({ note: "headers checked", halt: expect.objectContaining({ id: halt.id, reason: "header_mismatch" }) }),
    ]);
  }, 60_000);

  it("selftest: the exit closed for it, the test, the exit opened again — once, by the command's own ids", async (context) => {
    if (!testDb) return context.skip();
    const r = await rig();
    await onBrowser(r);
    r.operator.onOtherCommand = (command) => {
      if (command.command.kind === "closeExit") r.operator.pushState({ step: "exit_ip_verified", exitOpen: false });
      if (command.command.kind === "openExit") r.operator.pushState({ step: "exit_open", exitOpen: true });
      return { ok: true, detail: `${command.command.kind}: done` };
    };
    await startHost(r);
    r.operator.pushState({ step: "ready" });
    await until(async () => (await browserRow(r.page.pageId)).step === "ready", 15_000, "ready recorded");
    const printed: string[] = [];
    await cli(r, printed).parseAsync(["browser", "selftest", r.page.pageLabel, "--note", "after the update"], { from: "user" });
    const asked = JSON.parse(printed.join("\n"));
    expect(asked.result).toEqual({ outcome: "ok", ok: true, detail: "closeExit: closeExit: done; selfTest: selfTest: done; openExit: openExit: done", doneAt: expect.any(String) });
    const commands = r.operator.commands.filter((command) => command.command.kind !== "stopPage");
    expect(commands.map((command) => command.command.kind)).toEqual(["closeExit", "selfTest", "openExit"]);
    const commandId = (await testDb.pool.query<{ id: string }>("select command_id::text as id from page_browser_commands where id = $1", [asked.command.id])).rows[0]!.id;
    expect(commands.map((command) => command.commandId)).toEqual([`${commandId}:closeExit`, `${commandId}:selfTest`, `${commandId}:openExit`]);
    expect(await audits(r.page.pageId, SYNC_BROWSER_AUDIT_EVENTS.selftest)).toEqual([expect.objectContaining({ note: "after the update", commandId: asked.command.id })]);
  }, 60_000);

  it("a command no owner takes is never run: closed as not run at its expiry", async (context) => {
    if (!testDb) return context.skip();
    const r = await rig();
    const printed: string[] = [];
    // No host runs: nobody takes it. Its expiry made short.
    const cliRun = cli(r, printed).parseAsync(["browser", "selftest", r.page.pageLabel, "--wait-ms", "3000"], { from: "user" });
    await until(async () => (await testDb!.pool.query("select 1 from page_browser_commands")).rowCount === 1, 5_000, "the command asked");
    await testDb.pool.query("update page_browser_commands set expires_at = clock_timestamp()");
    await cliRun;
    expect(JSON.parse(printed.join("\n")).result).toMatchObject({ ok: false, detail: expect.stringContaining("not run: no owner") });
  }, 30_000);

  it("pin-ip: the exit IP and the environment the hello carries, audited; a malformed one refused", async (context) => {
    if (!testDb) return context.skip();
    const r = await rig();
    await setPageBrowserSettings(db(), { profileId: r.profileId, pinnedExitIp: null, env: null });
    const printed: string[] = [];
    await cli(r, printed).parseAsync(["browser", "pin-ip", r.page.pageLabel, "--ip", "198.51.100.4"], { from: "user" });
    expect(JSON.parse(printed.join("\n"))).toEqual({ page: r.page.pageLabel, pinnedExitIp: "198.51.100.4", env: null, ready: false });
    printed.length = 0;
    await cli(r, printed).parseAsync(["browser", "pin-ip", r.page.pageLabel, "--env", JSON.stringify(ENV), "--note", "Berlin proxy"], { from: "user" });
    expect(JSON.parse(printed.join("\n"))).toEqual({ page: r.page.pageLabel, pinnedExitIp: "198.51.100.4", env: ENV, ready: true });
    expect(await audits(r.page.pageId, SYNC_BROWSER_AUDIT_EVENTS.pinIp)).toEqual([
      expect.objectContaining({ from: { pinnedExitIp: null, env: null }, to: { pinnedExitIp: "198.51.100.4", env: null } }),
      expect.objectContaining({ note: "Berlin proxy", to: { pinnedExitIp: "198.51.100.4", env: ENV } }),
    ]);
    await expect(cli(r, printed).parseAsync(["browser", "pin-ip", r.page.pageLabel, "--ip", "not-an-ip"], { from: "user" })).rejects.toThrow(/Not an IP address/);
    await expect(cli(r, printed).parseAsync(["browser", "pin-ip", r.page.pageLabel, "--env", '{"timeZone":"UTC"}'], { from: "user" })).rejects.toThrow(/timeZone, languages/);
    // The status names no secret of the page.
    printed.length = 0;
    await cli(r, printed).parseAsync(["browser", "status", "--page", r.page.pageLabel], { from: "user" });
    const status = printed.join("\n");
    expect(JSON.parse(status)).toEqual([expect.objectContaining({ page: r.page.pageLabel })]);
    for (const secret of Object.values(SECRETS)) expect(status).not.toContain(secret);
    await expect(cli(r, printed).parseAsync(["browser", "log", r.page.pageLabel], { from: "user" })).rejects.toThrow(/scripts\/deploy-page-browser\.sh log/);
  }, 30_000);
});

describe("the browser started at the switch to it", () => {
  it("a browser that stands is started — not while the page is paused, never one halted for the owner's decision", async (context) => {
    if (!testDb) return context.skip();
    const r = await rig();
    r.operator.pushState({ step: "exit_closed", exitOpen: false, stopReason: null });
    r.operator.onOtherCommand = (command) => {
      if (command.command.kind !== "restartBrowser") return { ok: false, detail: "not in this fake" };
      r.operator.pushState({ step: "ready", stopReason: null, exitOpen: true });
      return { ok: true, detail: "the start began" };
    };
    await testDb.pool.query("update sync_pages set paused_all = true where page_id = $1", [r.page.pageId]);
    await onBrowser(r);
    await startHost(r);
    await until(async () => (await browserRow(r.page.pageId)).lastStateAt !== null, 15_000, "the stand recorded");
    await new Promise((resolve) => setTimeout(resolve, 1_500));
    // Stands (never started), but the page is paused: nothing.
    expect(kindsOf(r)).toEqual([]);
    // The pause lifted: started, once.
    await testDb.pool.query("update sync_pages set paused_all = false where page_id = $1", [r.page.pageId]);
    await until(async () => kindsOf(r).includes("restartBrowser"), 10_000, "the browser started");
    await until(async () => (await browserRow(r.page.pageId)).step === "ready", 10_000, "ready recorded");
    await new Promise((resolve) => setTimeout(resolve, 1_500));
    expect(kindsOf(r)).toEqual(["restartBrowser"]);
    // Halted for the owner's decision (a changed exit IP), then standing as
    // an operator that started again — still holding it on its volume:
    // nothing starts it but the owner.
    const halt = { id: randomUUID(), reason: "exit_ip_changed" as const, atWall: Date.now() };
    r.operator.pushState({ step: "exit_closed", exitOpen: false, stopReason: "exit_ip_changed", halt });
    await until(async () => (await browserRow(r.page.pageId)).haltReason === "exit_ip_changed", 10_000, "the halt mirrored");
    r.operator.pushState({ step: "exit_closed", exitOpen: false, stopReason: null, halt });
    await new Promise((resolve) => setTimeout(resolve, 1_500));
    expect(kindsOf(r)).toEqual(["restartBrowser"]);
  }, 60_000);
});

describe("the drain of a stopped container's buffer, the page staying on Node", () => {
  it("Node's slot ends, a leave takes the buffer — the browser told to stand stopped — the mark is cleared and Node takes the page again", async (context) => {
    if (!testDb) return context.skip();
    const r = await rig();
    // The browser stopped by the owner's word before its buffer was taken.
    await markPageBrowserUndrained(db(), { pageId: r.page.pageId });
    r.operator.pushState({ step: "exit_closed", exitOpen: false, stopReason: null });
    r.operator.append({ kind: "gap", fromSeq: null, fromWall: null, reason: "operator_start" });
    const host = await startHost(r);
    await until(async () => r.server.arrivalsAt("/api/v1/polls").length >= 1, 20_000, "the page running on Node");
    const g1 = (host.state(r.page.pageId) as { generation: bigint }).generation;
    expect(r.operator.links).toEqual([]);
    const printed: string[] = [];
    await cli(r, printed).parseAsync(["browser", "drain", r.page.pageLabel, "--note", "container back up"], { from: "user" });
    expect(JSON.parse(printed.join("\n"))).toMatchObject({ page: r.page.pageLabel, leave: g1.toString() });
    expect(await audits(r.page.pageId, SYNC_BROWSER_AUDIT_EVENTS.drain)).toEqual([expect.objectContaining({ note: "container back up", leave: g1.toString() })]);
    await until(async () => (await browserRow(r.page.pageId)).bufferUndrainedSince === null, 30_000, "the buffer drained");
    await until(async () => {
      const state = host.state(r.page.pageId);
      return state.kind === "running" && state.generation > g1 + 1n;
    }, 30_000, "Node again");
    // The browser was told to stand stopped, never started; the page stayed on Node.
    expect(kindsOf(r)).toEqual(["stopPage"]);
    expect(r.operator.buffer.kept).toEqual([]);
    expect((await testDb.pool.query("select transport, browser_leave_generation from sync_pages where page_id = $1", [r.page.pageId])).rows[0])
      .toEqual({ transport: "node", browser_leave_generation: null });
    // Nothing to drain any more; a page on its browser drains itself.
    await expect(cli(r, printed).parseAsync(["browser", "drain", r.page.pageLabel], { from: "user" })).rejects.toThrow(/not marked undrained/);
  }, 90_000);
});
