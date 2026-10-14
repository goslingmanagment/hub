import { randomUUID } from "node:crypto";

import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import {
  clearPageBrowserLoginRequiredHalt,
  endSyncPageManualLogin,
  getSyncPageManualLogin,
  isOwnerDecisionHalt,
  latchPageBrowserHalt,
  setSyncPageManualLogin,
  SyncPageManualLoginOpenError,
  liftBrowserStopPause,
  pausePageForBrowserStop,
  setPagePause,
  listSyncPages,
  clearPageBrowserOwnerStop,
  expirePageBrowserCommand,
  findPageBrowser,
  finishPageBrowserCommand,
  getPageBrowserCommand,
  insertPageBrowser,
  insertPageBrowserCommand,
  listPageBrowsersOfPages,
  readPageBrowserControl,
  recordPageBrowserAlarm,
  recordPageBrowserDelivery,
  recordPageBrowserState,
  requestBrowserDrain,
  setPageBrowserOwnerStop,
  setSyncPageTransport,
  takePageBrowserCommand,
  type Database,
  type PageBrowserStateInput,
} from "@agency_hub_core/db";

import { sealPageBrowserSecrets } from "../apps/runtime/src/services/egress/page-browser-link.ts";
import { samplePageBrowserMetrics } from "../apps/runtime/src/sync/engine/metrics.ts";
import { resetIntegrationDatabase, startIntegrationTestDatabase, type StartedTestDatabase } from "./helpers/db.ts";
import { harnessConfig, seedHarnessPage } from "./helpers/sync-engine.ts";

// The data of PR 17 (Project Browser plan §4.11; 0280): what the engine keeps
// of what a page's operator says (its start as it goes, its alarm, the
// delivery of its events), the owner's stop, and his one-shot commands —
// taken by the page's owner, run once, never past their expiry.

let testDb: StartedTestDatabase | null = null;

beforeAll(async () => {
  testDb = await startIntegrationTestDatabase();
}, 120_000);

afterAll(async () => {
  await testDb?.stop();
});

beforeEach(async () => {
  if (testDb) await resetIntegrationDatabase(testDb.pool);
});

function db(): Database {
  return testDb!.db as unknown as Database;
}

const SECRETS = { engineToken: "engine-token-91c2", apiToken: "api-token-0d7e", vncPassword: "vnc-password-55f1" };

async function browserPage(label = `pb-${randomUUID().slice(0, 8)}`) {
  const { pageId } = await seedHarnessPage({ db: db(), pool: testDb!.pool }, { mode: "live", proxyUrl: null, label });
  const profileId = randomUUID();
  await insertPageBrowser(db(), { profileId, container: `page-browser-${label}`, pageId, ...sealPageBrowserSecrets(harnessConfig(testDb!.connectionString), SECRETS) });
  return { pageId, profileId, label };
}

function state(profileId: string, patch: Partial<PageBrowserStateInput> = {}): PageBrowserStateInput {
  return {
    profileId, step: "ready", stopReason: null, mode: "automation", exitOpen: true, sessionFingerprint: null, accountId: null,
    exitIp: "203.0.113.7", chromeVersion: "155", operatorVersion: "op", selfTest: null, buffer: { bytes: 0, oldestAgeMs: 0 }, retryAt: null, ...patch,
  };
}

describe("the operator's state as the engine keeps it (0280)", () => {
  it("since when it is not up, and since when it says its stop reason, kept across states; its next retry", async (context) => {
    if (!testDb) return context.skip();
    const { profileId } = await browserPage();
    await recordPageBrowserState(db(), state(profileId));
    expect(await findPageBrowser(db(), profileId)).toMatchObject({ downSince: null, stopSince: null, retryAt: null });

    const retryAt = new Date(Date.now() + 30_000);
    await recordPageBrowserState(db(), state(profileId, { step: "exit_closed", exitOpen: false, stopReason: "proxy_unavailable", retryAt }));
    const down = await findPageBrowser(db(), profileId);
    expect(down!.downSince).not.toBeNull();
    expect(down!.stopSince).not.toBeNull();
    expect(down!.retryAt).toEqual(retryAt);
    // Starting again (no reason), then failing again for the same reason: down since the first, the reason's since anew.
    await recordPageBrowserState(db(), state(profileId, { step: "chrome_started", exitOpen: false, retryAt: null }));
    const starting = await findPageBrowser(db(), profileId);
    expect(starting).toMatchObject({ downSince: down!.downSince, stopSince: null, retryAt: null });
    await recordPageBrowserState(db(), state(profileId, { step: "exit_closed", exitOpen: false, stopReason: "proxy_unavailable" }));
    const again = await findPageBrowser(db(), profileId);
    expect(again!.downSince).toEqual(down!.downSince);
    expect(again!.stopSince!.getTime()).toBeGreaterThan(down!.stopSince!.getTime());
    // The same reason said again keeps its since; a state without retryAt keeps it.
    await recordPageBrowserState(db(), state(profileId, { step: "exit_closed", exitOpen: false, stopReason: "proxy_unavailable", retryAt }));
    const { retryAt: _omitted, ...withoutRetry } = state(profileId, { step: "exit_closed", exitOpen: false, stopReason: "proxy_unavailable" });
    await recordPageBrowserState(db(), withoutRetry);
    expect(await findPageBrowser(db(), profileId)).toMatchObject({ stopSince: again!.stopSince, retryAt });
    // Up again: both cleared.
    await recordPageBrowserState(db(), state(profileId));
    expect(await findPageBrowser(db(), profileId)).toMatchObject({ downSince: null, stopSince: null, retryAt: null });
  });

  it("its alarm: the newest wins, its scalar details only; the delivery's figures", async (context) => {
    if (!testDb) return context.skip();
    const { profileId } = await browserPage();
    const at = new Date(Date.now() - 60_000);
    expect(await recordPageBrowserAlarm(db(), { profileId, kind: "cdp_lost", at, detail: { detail: "gone", exitOpenAtLoss: true, nested: { a: 1 } } })).toBe(true);
    // An older alarm written late changes nothing.
    expect(await recordPageBrowserAlarm(db(), { profileId, kind: "buffer", at: new Date(at.getTime() - 1_000), detail: {} })).toBe(false);
    // One from the future is kept at the database's clock.
    expect(await recordPageBrowserAlarm(db(), { profileId, kind: "header_mismatch", at: new Date(Date.now() + 3_600_000), detail: { route: "x" } })).toBe(true);
    const row = await findPageBrowser(db(), profileId);
    expect(row).toMatchObject({ alarmKind: "header_mismatch", alarmDetail: { route: "x" } });
    expect(row!.alarmAt!.getTime()).toBeLessThanOrEqual(Date.now() + 5_000);
    await recordPageBrowserAlarm(db(), { profileId, kind: "cdp_lost", at: new Date(), detail: { detail: "gone", nested: { a: 1 } } });
    expect((await findPageBrowser(db(), profileId))!.alarmDetail).toEqual({ detail: "gone" });
    await recordPageBrowserDelivery(db(), { profileId, p50Ms: 12.4, p95Ms: 340.6 });
    expect(await findPageBrowser(db(), profileId)).toMatchObject({ deliveryP50Ms: 12, deliveryP95Ms: 341 });
  });

  it("the status read of every page's browser carries no secret", async (context) => {
    if (!testDb) return context.skip();
    const { pageId } = await browserPage();
    const [row] = await listPageBrowsersOfPages(db(), { pageIds: [pageId] });
    expect(row!.browser).toMatchObject({ encryptedEngineToken: "", encryptedApiToken: "", encryptedVncPassword: "" });
    expect(row).toMatchObject({ pageId, transport: "node", leaveSince: null, intake: { lastEventAt: null, lastCommitAt: null, halted: null } });
  });
});

describe("the owner's stop, the halt latched for his decision, and the pause the stop owns (0280)", () => {
  it("keeps its first mark; the start lifts it and a latched halt, and says what they were", async (context) => {
    if (!testDb) return context.skip();
    const { pageId, profileId } = await browserPage();
    const first = await setPageBrowserOwnerStop(db(), { pageId, by: "cli@a" });
    expect(first).toMatchObject({ profileId, already: false });
    const second = await setPageBrowserOwnerStop(db(), { pageId, by: "cli@b" });
    expect(second).toMatchObject({ already: true, stoppedAt: first!.stoppedAt });
    expect(await findPageBrowser(db(), profileId)).toMatchObject({ ownerStopBy: "cli@a" });
    expect(await latchPageBrowserHalt(db(), { profileId, reason: "header_mismatch" })).toBe(true);
    // The first reason and instant are kept.
    expect(await latchPageBrowserHalt(db(), { profileId, reason: "exit_ip_changed" })).toBe(true);
    const latched = await findPageBrowser(db(), profileId);
    expect(latched).toMatchObject({ haltReason: "header_mismatch" });
    expect(await readPageBrowserControl(db(), { profileId })).toMatchObject({
      pageId, ownerStopAt: first!.stoppedAt, pausedAll: false, transport: "node", haltReason: "header_mismatch", leaveGeneration: null,
    });
    // No state of the operator lifts the latch: one that started again stands with no reason.
    await recordPageBrowserState(db(), state(profileId, { step: "exit_closed", exitOpen: false, stopReason: null }));
    expect((await findPageBrowser(db(), profileId))!.haltReason).toBe("header_mismatch");
    expect(await clearPageBrowserOwnerStop(db(), { pageId })).toEqual({ profileId, wasStopped: true, halt: { reason: "header_mismatch", at: latched!.haltAt } });
    expect(await clearPageBrowserOwnerStop(db(), { pageId })).toEqual({ profileId, wasStopped: false, halt: null });
    const { pageId: bare } = await seedHarnessPage({ db: db(), pool: testDb.pool }, { mode: "live", proxyUrl: null, label: "no-browser", ownRef: "300000000000000777" });
    expect(await setPageBrowserOwnerStop(db(), { pageId: bare, by: "cli" })).toBeNull();
  });

  it("which stop reasons stand for the owner's decision", () => {
    expect(isOwnerDecisionHalt({ stopReason: "header_mismatch", retryAtWall: null })).toBe(true);
    expect(isOwnerDecisionHalt({ stopReason: "exit_ip_changed", retryAtWall: null })).toBe(true);
    expect(isOwnerDecisionHalt({ stopReason: "a_reason_of_a_newer_operator", retryAtWall: null })).toBe(true);
    // Retried by the operator itself, the owner's own stop, a buffer that does not open, a stand.
    expect(isOwnerDecisionHalt({ stopReason: "proxy_unavailable", retryAtWall: Date.now() })).toBe(false);
    expect(isOwnerDecisionHalt({ stopReason: "owner_stop", retryAtWall: null })).toBe(false);
    expect(isOwnerDecisionHalt({ stopReason: "buffer_unavailable", retryAtWall: null })).toBe(false);
    expect(isOwnerDecisionHalt({ stopReason: null, retryAtWall: null })).toBe(false);
  });

  it("the stop's pause is the stop's until the owner changes the whole pause himself (Astra PR 17, P1-4)", async (context) => {
    if (!testDb) return context.skip();
    const { pageId } = await browserPage();
    const pauseOf = async () => (await testDb!.pool.query<{ pausedAll: boolean; mine: boolean; note: string | null }>(
      `select paused_all as "pausedAll", browser_stop_paused as mine, pause_note as note from sync_pages where page_id = $1`, [pageId],
    )).rows[0]!;
    const tx = <T>(body: (tx: Database) => Promise<T>) => db().transaction(async (raw) => body(raw as unknown as Database));
    // Stop → the owner's own pause → start: his pause stays.
    expect(await tx((t) => pausePageForBrowserStop(t, { pageId, note: "stop" }))).toEqual({ pausedByStop: true, fromLogin: false });
    expect(await pauseOf()).toEqual({ pausedAll: true, mine: true, note: "stop" });
    await setPagePause(db(), { pageId, all: true, note: "maintenance" });
    expect(await pauseOf()).toEqual({ pausedAll: true, mine: false, note: "maintenance" });
    expect(await tx((t) => liftBrowserStopPause(t, { pageId }))).toBeNull();
    expect(await pauseOf()).toEqual({ pausedAll: true, mine: false, note: "maintenance" });
    // Stop of a page paused already: not the stop's.
    expect(await tx((t) => pausePageForBrowserStop(t, { pageId, note: "stop" }))).toEqual({ pausedByStop: false, fromLogin: false });
    expect(await pauseOf()).toEqual({ pausedAll: true, mine: false, note: "maintenance" });
    // Resumed by the owner: nothing is the stop's any more; a later pause of his stays too.
    await setPagePause(db(), { pageId, all: false, note: null });
    await tx((t) => pausePageForBrowserStop(t, { pageId, note: "stop" }));
    await setPagePause(db(), { pageId, all: false, note: null });
    await setPagePause(db(), { pageId, all: true, note: "later" });
    expect(await tx((t) => liftBrowserStopPause(t, { pageId }))).toBeNull();
    expect(await pauseOf()).toEqual({ pausedAll: true, mine: false, note: "later" });
    // The stop's own pause, untouched: lifted.
    await setPagePause(db(), { pageId, all: false, note: null });
    await tx((t) => pausePageForBrowserStop(t, { pageId, note: "stop" }));
    // A pause of resources or of the requests keeps the whole pause the stop's.
    await setPagePause(db(), { pageId, requests: true });
    expect(await tx((t) => liftBrowserStopPause(t, { pageId }))).toBe("lifted");
    expect(await pauseOf()).toEqual({ pausedAll: false, mine: false, note: null });
  });
});

describe("the owner's browser stop and the owner's login of the browser (PR 17 with PR 15)", () => {
  const tx = <T>(body: (tx: Database) => Promise<T>) => db().transaction(async (raw) => body(raw as unknown as Database));
  const pauseOf = async (pageId: number) => (await testDb!.pool.query<{ pausedAll: boolean; stop: boolean; login: boolean; manualLogin: string }>(
    `select paused_all as "pausedAll", browser_stop_paused as stop, manual_login_paused as login, manual_login as "manualLogin" from sync_pages where page_id = $1`,
    [pageId],
  )).rows[0]!;
  const loginTo = (pageId: number, to: "wanted" | "ending") => tx((t) => setSyncPageManualLogin(t, { pageId, to, by: "owner:test" }));
  const loginEnds = (pageId: number) => tx((t) => endSyncPageManualLogin(t, { pageId, by: "engine" }));

  it("a stop during an open login takes over the login's pause: the login's end does not lift it, the owner's start does", async (context) => {
    if (!testDb) return context.skip();
    const { pageId } = await browserPage();
    await loginTo(pageId, "wanted");
    expect(await pauseOf(pageId)).toEqual({ pausedAll: true, stop: false, login: true, manualLogin: "wanted" });
    expect(await tx((t) => pausePageForBrowserStop(t, { pageId, note: "stop" }))).toEqual({ pausedByStop: true, fromLogin: true });
    expect(await pauseOf(pageId)).toEqual({ pausedAll: true, stop: true, login: false, manualLogin: "wanted" });
    await loginTo(pageId, "ending");
    expect(await loginEnds(pageId)).toBe(true);
    expect(await pauseOf(pageId)).toEqual({ pausedAll: true, stop: true, login: false, manualLogin: "off" });
    expect(await tx((t) => liftBrowserStopPause(t, { pageId }))).toBe("lifted");
    expect(await pauseOf(pageId)).toEqual({ pausedAll: false, stop: false, login: false, manualLogin: "off" });
  });

  it("the owner's start during an open login gives the pause back to the login, which lifts it at its end; a login opened under the stop's pause leaves it the stop's", async (context) => {
    if (!testDb) return context.skip();
    const { pageId } = await browserPage();
    // Stopped first, then the login: the pause stays the stop's.
    await tx((t) => pausePageForBrowserStop(t, { pageId, note: "stop" }));
    await loginTo(pageId, "wanted");
    expect(await pauseOf(pageId)).toEqual({ pausedAll: true, stop: true, login: false, manualLogin: "wanted" });
    // Started while the login is open: still paused, the login's pause now.
    expect(await tx((t) => liftBrowserStopPause(t, { pageId }))).toBe("to_login");
    expect(await pauseOf(pageId)).toEqual({ pausedAll: true, stop: false, login: true, manualLogin: "wanted" });
    await loginTo(pageId, "ending");
    await loginEnds(pageId);
    expect(await pauseOf(pageId)).toEqual({ pausedAll: false, stop: false, login: false, manualLogin: "off" });
  });

  it("setPagePause: the owner's own pause during a login and a stop is his alone; his resume is refused while the login is open", async (context) => {
    if (!testDb) return context.skip();
    const { pageId } = await browserPage();
    await loginTo(pageId, "wanted");
    await tx((t) => pausePageForBrowserStop(t, { pageId, note: "stop" }));
    // A resume while the login is open: refused, nothing changed.
    await expect(setPagePause(db(), { pageId, all: false, note: null })).rejects.toBeInstanceOf(SyncPageManualLoginOpenError);
    expect(await pauseOf(pageId)).toEqual({ pausedAll: true, stop: true, login: false, manualLogin: "wanted" });
    // His own pause: neither the stop's nor the login's any more.
    await setPagePause(db(), { pageId, all: true, note: "mine" });
    expect(await pauseOf(pageId)).toEqual({ pausedAll: true, stop: false, login: false, manualLogin: "wanted" });
    expect(await tx((t) => liftBrowserStopPause(t, { pageId }))).toBeNull();
    await loginTo(pageId, "ending");
    await loginEnds(pageId);
    expect(await pauseOf(pageId)).toMatchObject({ pausedAll: true, manualLogin: "off" });
    // The login's pause alone, and the owner pauses during it: his.
    await setPagePause(db(), { pageId, all: false, note: null });
    await loginTo(pageId, "wanted");
    expect(await pauseOf(pageId)).toMatchObject({ pausedAll: true, login: true });
    await setPagePause(db(), { pageId, all: true, note: "mine again" });
    expect(await pauseOf(pageId)).toMatchObject({ pausedAll: true, login: false, stop: false });
  });

  it("the control read names the login; a drain is refused while it is open", async (context) => {
    if (!testDb) return context.skip();
    const { pageId, profileId } = await browserPage();
    expect(await readPageBrowserControl(db(), { profileId })).toMatchObject({ manualLogin: "off" });
    await loginTo(pageId, "wanted");
    expect(await readPageBrowserControl(db(), { profileId })).toMatchObject({ manualLogin: "wanted" });
    expect(await tx((t) => requestBrowserDrain(t, { pageId }))).toEqual({ kind: "login_open" });
    await loginTo(pageId, "ending");
    expect(await readPageBrowserControl(db(), { profileId })).toMatchObject({ manualLogin: "ending" });
    expect(await tx((t) => requestBrowserDrain(t, { pageId }))).toEqual({ kind: "login_open" });
    await loginEnds(pageId);
    expect(await tx((t) => requestBrowserDrain(t, { pageId }))).toMatchObject({ kind: "requested" });
  });

  it("a latched login_required is lifted by a login that ended after it, not before; no other halt is", async (context) => {
    if (!testDb) return context.skip();
    const { pageId, profileId } = await browserPage();
    // A login that ended before the latch proves nothing of it.
    await loginTo(pageId, "wanted");
    await loginTo(pageId, "ending");
    await loginEnds(pageId);
    await latchPageBrowserHalt(db(), { profileId, reason: "login_required" });
    expect(await clearPageBrowserLoginRequiredHalt(db(), { profileId })).toBe(false);
    // Open: not yet.
    await loginTo(pageId, "wanted");
    expect(await clearPageBrowserLoginRequiredHalt(db(), { profileId })).toBe(false);
    await loginTo(pageId, "ending");
    await loginEnds(pageId);
    expect((await getSyncPageManualLogin(db(), pageId))?.value).toBe("off");
    expect(await clearPageBrowserLoginRequiredHalt(db(), { profileId })).toBe(true);
    expect(await findPageBrowser(db(), profileId)).toMatchObject({ haltReason: null, haltAt: null });
    // Another halt stays for the owner's start.
    await latchPageBrowserHalt(db(), { profileId, reason: "exit_ip_changed" });
    await loginTo(pageId, "wanted");
    await loginTo(pageId, "ending");
    await loginEnds(pageId);
    expect(await clearPageBrowserLoginRequiredHalt(db(), { profileId })).toBe(false);
    expect(await findPageBrowser(db(), profileId)).toMatchObject({ haltReason: "exit_ip_changed" });
  });
});

describe("the owner's commands (0280)", () => {
  it("taken by the page's owner, run once, the answer kept once; a newer owner takes one never finished", async (context) => {
    if (!testDb) return context.skip();
    const { pageId, profileId } = await browserPage();
    const asked = (await insertPageBrowserCommand(db(), { pageId, kind: "selfTest", requestedBy: "cli", note: "n", ttlMs: 60_000 }))!;
    expect(asked).toMatchObject({ profileId, pageId, kind: "selfTest", takenAt: null, doneAt: null });
    const taken = await takePageBrowserCommand(db(), { pageId, profileId, generation: 5n });
    expect(taken).toMatchObject({ id: asked.id, takenGeneration: 5n });
    // Not twice by the same owner, nor by an older one.
    expect(await takePageBrowserCommand(db(), { pageId, profileId, generation: 5n })).toBeNull();
    expect(await takePageBrowserCommand(db(), { pageId, profileId, generation: 4n })).toBeNull();
    // The owner's process went before it finished: the next owner takes it (the operator runs its id once).
    expect(await takePageBrowserCommand(db(), { pageId, profileId, generation: 6n })).toMatchObject({ id: asked.id, commandId: asked.commandId, takenGeneration: 6n });
    // Only the owner that holds it finishes it, once.
    expect(await finishPageBrowserCommand(db(), { id: asked.id, generation: 5n, ok: true, detail: "late" })).toBe(false);
    expect(await finishPageBrowserCommand(db(), { id: asked.id, generation: 6n, ok: false, detail: "x".repeat(900) })).toBe(true);
    expect(await finishPageBrowserCommand(db(), { id: asked.id, generation: 6n, ok: true, detail: "again" })).toBe(false);
    const done = (await getPageBrowserCommand(db(), asked.id))!;
    expect(done).toMatchObject({ ok: false });
    expect(done.detail).toHaveLength(500);
    expect(await takePageBrowserCommand(db(), { pageId, profileId, generation: 7n })).toBeNull();
  });

  it("a command nobody took is never taken past its expiry, and is closed as not run then — not before", async (context) => {
    if (!testDb) return context.skip();
    const { pageId, profileId } = await browserPage();
    const asked = (await insertPageBrowserCommand(db(), { pageId, kind: "restartBrowser", requestedBy: "cli", ttlMs: 60_000 }))!;
    expect(await expirePageBrowserCommand(db(), { id: asked.id })).toBe(false);
    await testDb.pool.query("update page_browser_commands set expires_at = clock_timestamp() - interval '1 second' where id = $1", [asked.id]);
    expect(await takePageBrowserCommand(db(), { pageId, profileId, generation: 9n })).toBeNull();
    expect(await expirePageBrowserCommand(db(), { id: asked.id })).toBe(true);
    expect(await getPageBrowserCommand(db(), asked.id)).toMatchObject({ ok: false, detail: expect.stringContaining("not run") });
    const { pageId: bare } = await seedHarnessPage({ db: db(), pool: testDb.pool }, { mode: "live", proxyUrl: null, label: "no-browser-2", ownRef: "300000000000000778" });
    expect(await insertPageBrowserCommand(db(), { pageId: bare, kind: "selfTest", requestedBy: "cli", ttlMs: 1_000 })).toBeNull();
    await expect(testDb.pool.query("insert into page_browser_commands (profile_id, page_id, kind, requested_by, expires_at) values ($1, $2, 'profileSnapshot', 'x', now())", [profileId, pageId]))
      .rejects.toThrow(/page_browser_commands_kind_check/);
  });
});

describe("the drain of a stopped browser's buffer (PR 17)", () => {
  it("a pending leave for a page on Node only, one at a time", async (context) => {
    if (!testDb) return context.skip();
    const { pageId } = await browserPage();
    await testDb.pool.query("update sync_pages set owner_generation = 4 where page_id = $1", [pageId]);
    const drain = await db().transaction(async (raw) => requestBrowserDrain(raw as unknown as Database, { pageId }));
    expect(drain).toEqual({ kind: "requested", leave: 4n });
    expect(await db().transaction(async (raw) => requestBrowserDrain(raw as unknown as Database, { pageId }))).toEqual({ kind: "pending" });
    await testDb.pool.query("update sync_pages set browser_leave_generation = null, browser_leave_requested_at = null where page_id = $1", [pageId]);
    await db().transaction(async (raw) => setSyncPageTransport(raw as unknown as Database, { pageId, to: "browser" }));
    expect(await db().transaction(async (raw) => requestBrowserDrain(raw as unknown as Database, { pageId }))).toEqual({ kind: "not_node" });
  });
});

describe("the page browsers' metrics (PR 17)", () => {
  it("none while every page is on Node; over the pages on their browser, the buffer, the delivery, the self-tests and the alerts", async (context) => {
    if (!testDb) return context.skip();
    const { pageId, profileId } = await browserPage();
    await recordPageBrowserState(db(), state(profileId, { buffer: { bytes: 4_096, oldestAgeMs: 1_500 }, selfTest: { ok: false, at: new Date(), failed: "dnr_never" } }));
    await recordPageBrowserDelivery(db(), { profileId, p50Ms: 30, p95Ms: 250 });
    const pages = () => listSyncPages(db());
    expect(await samplePageBrowserMetrics(db(), await pages(), new Date())).toEqual([]);
    await db().transaction(async (raw) => setSyncPageTransport(raw as unknown as Database, { pageId, to: "browser" }));
    const now = (await pages())[0]!.dbNow;
    const samples = await samplePageBrowserMetrics(db(), await pages(), now);
    const value = (metric: string, quantile: "p50" | "p95") => samples.find((sample) => sample.metric === metric && sample.quantile === quantile)?.valueMs;
    expect(value("page_browser_buffer_bytes", "p95")).toBe(4_096);
    expect(value("page_browser_buffer_age_ms", "p95")).toBe(1_500);
    expect(value("page_browser_delivery_ms", "p50")).toBe(30);
    expect(value("page_browser_delivery_ms", "p95")).toBe(250);
    expect(value("page_browser_selftest_failed", "p95")).toBe(1);
    // The failed self-test holds (`browser:selftest_failed`).
    expect(value("page_browser_alerts", "p95")).toBeGreaterThanOrEqual(1);
  });
});
