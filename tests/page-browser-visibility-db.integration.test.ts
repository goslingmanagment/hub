import { randomUUID } from "node:crypto";
import { setTimeout as sleep } from "node:timers/promises";

import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import {
  endSyncPageManualLogin,
  isOwnerDecisionHalt,
  setSyncPageManualLogin,
  SyncPageManualLoginOpenError,
  liftBrowserStopPause,
  pausePageForBrowserStop,
  setPagePause,
  listSyncPages,
  clearPageBrowserHaltMirror,
  clearPageBrowserOwnerStop,
  expirePageBrowserCommands,
  markPageBrowserCommandSent,
  releasePageBrowserCommand,
  findPageBrowser,
  finishPageBrowserCommand,
  getPageBrowserCommand,
  insertPageBrowser,
  insertPageBrowserCommand,
  listPageBrowsersOfPages,
  listPageBrowserTransitions,
  readPageBrowserControl,
  recordPageBrowserAlarm,
  recordPageBrowserDelivery,
  recordPageBrowserState,
  recordPageBrowserTransition,
  requestBrowserDrain,
  setPageBrowserOwnerStop,
  setSyncPageTransport,
  takePageBrowserCommand,
  type Database,
  type PageBrowserStateInput,
} from "@agency_hub_core/db";

import { sealPageBrowserSecrets } from "../apps/runtime/src/services/egress/page-browser-link.ts";
import { readPageBrowserHistory } from "../apps/runtime/src/sync/browser-levers.ts";
import { readPageBrowserStatuses } from "../apps/runtime/src/sync/browser-status.ts";
import { samplePageBrowserMetrics } from "../apps/runtime/src/sync/engine/metrics.ts";
import { resetIntegrationDatabase, startIntegrationTestDatabase, type StartedTestDatabase } from "./helpers/db.ts";
import { harnessConfig, seedHarnessPage } from "./helpers/sync-engine.ts";

// The data of PR 17 (Project Browser plan §4.11; 0281): what the engine keeps
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

describe("the operator's state as the engine keeps it (0281)", () => {
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

describe("the browser's telemetry for audits (0288, protocol minor 5)", () => {
  it("whether a Hub request can go and Chrome's crash dumps, written with every state; an operator that says nothing of them leaves them unknown", async (context) => {
    if (!testDb) return context.skip();
    const { profileId, pageId } = await browserPage();
    const since = new Date(Date.now() - 12 * 3_600_000);
    const countedAt = new Date(Date.now() - 60_000);
    await recordPageBrowserState(db(), state(profileId, {
      hubSend: { allowed: false, reason: "header_parity", since },
      crashDumps: { completed: { count: 25, newestAt: new Date(Date.now() - 3_600_000) }, pending: { count: 1, newestAt: null }, countedAt },
    }));
    expect(await findPageBrowser(db(), profileId)).toMatchObject({
      hubSendAllowed: false, hubSendBlockedReason: "header_parity", hubSendBlockedSince: since,
      crashDumpsCompleted: 25, crashDumpsPending: 1, crashDumpsPendingNewestAt: null, crashDumpsCountedAt: countedAt,
    });
    // The status says it, the last alarm apart with its age.
    await recordPageBrowserAlarm(db(), { profileId, kind: "cdp_lost", at: new Date(Date.now() - 12 * 3_600_000), detail: {} });
    const page = (await listSyncPages(db())).find((row) => row.pageId === pageId)!;
    const view = (await readPageBrowserStatuses(db(), [page])).get(pageId)!;
    expect(view.hubSend).toMatchObject({ allowed: false, reason: "header_parity", since: since.toISOString() });
    expect(view.hubSend.forMs!).toBeGreaterThan(11 * 3_600_000);
    expect(view.crashDumps).toMatchObject({ completed: { count: 25 }, pending: { count: 1, newestAt: null } });
    expect(view.lastAlarm).toMatchObject({ kind: "cdp_lost" });
    expect(view.lastAlarm!.ageMs).toBeGreaterThan(11 * 3_600_000);
    // Allowed again: no reason; an older operator: unknown.
    await recordPageBrowserState(db(), state(profileId, { hubSend: { allowed: true, reason: null, since: null }, crashDumps: null }));
    expect(await findPageBrowser(db(), profileId)).toMatchObject({ hubSendAllowed: true, hubSendBlockedReason: null, hubSendBlockedSince: null, crashDumpsCompleted: null, crashDumpsCountedAt: null });
    await recordPageBrowserState(db(), state(profileId));
    expect(await findPageBrowser(db(), profileId)).toMatchObject({ hubSendAllowed: null, hubSendBlockedReason: null });
  });

  it("the exit's refusals (0289): kept as the last state said them, shown in the status; an operator that says nothing of them leaves them unknown", async (context) => {
    if (!testDb) return context.skip();
    const { profileId, pageId } = await browserPage();
    const since = new Date(Date.now() - 3_600_000);
    const egressFailures = {
      since,
      socks: [{ kind: "refused", step: "connect", rep: 2, cls: "api", count: 3, lastAt: new Date(Date.now() - 60_000).toISOString(), lastHost: "apiv3.fansly.com" }],
      dnr: [{ cls: "api", probe: true, count: 2, lastAt: new Date(Date.now() - 50_000).toISOString(), lastHost: "apiv3.fansly.com" }],
    };
    await recordPageBrowserState(db(), state(profileId, { egressFailures }));
    const { since: _since, ...kept } = egressFailures;
    expect(await findPageBrowser(db(), profileId)).toMatchObject({ egressFailures: kept, egressFailuresSince: since });
    const page = (await listSyncPages(db())).find((row) => row.pageId === pageId)!;
    const view = (await readPageBrowserStatuses(db(), [page])).get(pageId)!;
    expect(view.egressFailures).toEqual({ since: since.toISOString(), ...kept });
    await recordPageBrowserState(db(), state(profileId));
    expect(await findPageBrowser(db(), profileId)).toMatchObject({ egressFailures: null, egressFailuresSince: null });
  });

  it("every transition once, by its buffer and number; a window's history sums its stops and Chrome's starts", async (context) => {
    if (!testDb) return context.skip();
    const { profileId, pageId, label } = await browserPage();
    const bufferId = randomUUID();
    const base = { profileId, pageId, bufferId, halted: false, retryAt: null, note: "", chromeVersion: "155.0.8059.84", operatorVersion: "73c9667ba89c" };
    const t0 = Date.now() - 600_000;
    const rows = [
      { seq: 1, at: new Date(t0), from: "exit_closed", to: "env_applied", stopReason: null, crashDumps: 24 },
      { seq: 2, at: new Date(t0 + 1_000), from: "env_applied", to: "chrome_started", stopReason: null, crashDumps: 24 },
      { seq: 3, at: new Date(t0 + 60_000), from: "ready", to: "exit_closed", stopReason: "cdp_lost", crashDumps: 25, note: "control lost: <ip>", retryAt: new Date(t0 + 70_000) },
      { seq: 4, at: new Date(t0 + 70_000), from: "exit_closed", to: "env_applied", stopReason: null, crashDumps: 25 },
      { seq: 5, at: new Date(t0 + 71_000), from: "env_applied", to: "chrome_started", stopReason: null, crashDumps: null },
    ];
    for (const row of rows) expect(await recordPageBrowserTransition(db(), { ...base, ...row })).toBe(true);
    // Delivered again (an ack lost): no second row.
    expect(await recordPageBrowserTransition(db(), { ...base, ...rows[2]! })).toBe(false);
    const listed = await listPageBrowserTransitions(db(), { profileId, since: new Date(t0 - 1) });
    expect(listed.map((row) => row.seq)).toEqual([1, 2, 3, 4, 5]);
    expect(listed[2]).toMatchObject({ stopReason: "cdp_lost", note: "control lost: <ip>", crashDumps: 25, retryAt: new Date(t0 + 70_000) });
    // The newest within a limit, still oldest first.
    expect((await listPageBrowserTransitions(db(), { profileId, since: new Date(t0 - 1), limit: 2 })).map((row) => row.seq)).toEqual([4, 5]);
    const history = await readPageBrowserHistory(db(), { pageLabel: label, since: new Date(t0 - 1) });
    expect(history.summary).toEqual({ transitions: 5, stopsByReason: { cdp_lost: 1 }, chromeStarts: 2, readies: 0, crashDumps: { first: 24, last: 25 } });
  });
});

describe("the owner's stop, the halt the operator holds as Hub mirrors it, and the pause the stop owns (0281)", () => {
  it("keeps its first mark; the start lifts it and says the halt the operator holds — a mirror, written with every state and never cleared by Hub", async (context) => {
    if (!testDb) return context.skip();
    const { pageId, profileId } = await browserPage();
    const first = await setPageBrowserOwnerStop(db(), { pageId, by: "cli@a" });
    expect(first).toMatchObject({ profileId, already: false });
    const second = await setPageBrowserOwnerStop(db(), { pageId, by: "cli@b" });
    expect(second).toMatchObject({ already: true, stoppedAt: first!.stoppedAt });
    expect(await findPageBrowser(db(), profileId)).toMatchObject({ ownerStopBy: "cli@a" });
    expect(await readPageBrowserControl(db(), { profileId })).toMatchObject({ pageId, ownerStopAt: first!.stoppedAt, pausedAll: false, transport: "node", leaveGeneration: null });
    // The operator holds a halt: mirrored with its state.
    const at = new Date(Date.now() - 60_000);
    const halt = { id: "22222222-2222-4222-8222-222222222222", reason: "header_mismatch", at };
    await recordPageBrowserState(db(), state(profileId, { step: "exit_closed", exitOpen: false, stopReason: "header_mismatch", halt }));
    expect(await findPageBrowser(db(), profileId)).toMatchObject({ haltReason: "header_mismatch", haltAt: at, haltId: halt.id });
    // The start lifts the owner's stop and names the mirrored halt; Hub clears nothing of it.
    expect(await clearPageBrowserOwnerStop(db(), { pageId })).toEqual({ profileId, wasStopped: true, halt: { id: halt.id, reason: "header_mismatch", at } });
    expect(await findPageBrowser(db(), profileId)).toMatchObject({ haltId: halt.id });
    expect(await clearPageBrowserOwnerStop(db(), { pageId })).toEqual({ profileId, wasStopped: false, halt: { id: halt.id, reason: "header_mismatch", at } });
    // A state without it (an operator that restarted after a full disk lost
    // it): the mirror keeps it (Astra round 4) — and when it names another
    // halt cleared.
    await recordPageBrowserState(db(), state(profileId, { step: "exit_closed", exitOpen: false, stopReason: null, halt: null }));
    expect(await findPageBrowser(db(), profileId)).toMatchObject({ haltReason: "header_mismatch", haltId: halt.id });
    await recordPageBrowserState(db(), state(profileId, { step: "exit_closed", exitOpen: false, stopReason: null, halt: null, lastClearedHaltId: "99999999-9999-4999-8999-999999999999" }));
    expect(await findPageBrowser(db(), profileId)).toMatchObject({ haltId: halt.id });
    // The operator says it cleared that very halt: gone from the mirror.
    await recordPageBrowserState(db(), state(profileId, { step: "exit_closed", exitOpen: false, stopReason: null, halt: null, lastClearedHaltId: halt.id }));
    expect(await findPageBrowser(db(), profileId)).toMatchObject({ haltReason: null, haltAt: null, haltId: null });
    // Astra round 5: a stricter halt held is never replaced by an older
    // login_required said (no word that it was cleared); a login_required held
    // is replaced by a stricter one said.
    const strict = { id: "cccccccc-cccc-4ccc-8ccc-cccccccccccc", reason: "header_mismatch", at };
    const signedOut = { id: "dddddddd-dddd-4ddd-8ddd-dddddddddddd", reason: "login_required", at };
    await recordPageBrowserState(db(), state(profileId, { step: "exit_closed", exitOpen: false, stopReason: "header_mismatch", halt: strict }));
    await recordPageBrowserState(db(), state(profileId, { step: "exit_closed", exitOpen: false, stopReason: "login_required", halt: signedOut }));
    expect(await findPageBrowser(db(), profileId)).toMatchObject({ haltReason: "header_mismatch", haltId: strict.id });
    await recordPageBrowserState(db(), state(profileId, { step: "exit_closed", exitOpen: false, stopReason: "login_required", halt: signedOut, lastClearedHaltId: strict.id }));
    expect(await findPageBrowser(db(), profileId)).toMatchObject({ haltReason: "login_required", haltId: signedOut.id });
    await recordPageBrowserState(db(), state(profileId, { step: "exit_closed", exitOpen: false, stopReason: "header_mismatch", halt: strict }));
    expect(await findPageBrowser(db(), profileId)).toMatchObject({ haltReason: "header_mismatch", haltId: strict.id });
    await recordPageBrowserState(db(), state(profileId, { step: "exit_closed", exitOpen: false, stopReason: null, halt: null, lastClearedHaltId: strict.id }));
    // Said again, then cleared by the owner's decision in Hub.
    await recordPageBrowserState(db(), state(profileId, { step: "exit_closed", exitOpen: false, stopReason: "header_mismatch", halt }));
    expect(await clearPageBrowserHaltMirror(db(), { profileId, haltId: "99999999-9999-4999-8999-999999999999" })).toBe(false);
    expect(await clearPageBrowserHaltMirror(db(), { profileId, haltId: halt.id })).toBe(true);
    expect(await findPageBrowser(db(), profileId)).toMatchObject({ haltReason: null, haltId: null });
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
});

describe("the page row lock (Astra PR 17 round 2)", () => {
  const tx = <T>(body: (tx: Database) => Promise<T>) => db().transaction(async (raw) => body(raw as unknown as Database));

  // Every writer of the page's pause, its login's pause and the owner's stop
  // waits for the page row (sync_pages, FOR NO KEY UPDATE) — whether or not it
  // finds anything to change: one row lock, one order. (The halt is the
  // operator's; Hub's mirror of it decides nothing.)
  const WRITERS: Array<[string, (page: { pageId: number; profileId: string }) => Promise<unknown>]> = [
    ["liftBrowserStopPause, with no pause of the stop's to lift", ({ pageId }) => tx((t) => liftBrowserStopPause(t, { pageId }))],
    ["pausePageForBrowserStop", ({ pageId }) => tx((t) => pausePageForBrowserStop(t, { pageId, note: "stop" }))],
    ["setPageBrowserOwnerStop", ({ pageId }) => setPageBrowserOwnerStop(db(), { pageId, by: "cli" })],
    ["clearPageBrowserOwnerStop", ({ pageId }) => clearPageBrowserOwnerStop(db(), { pageId })],
    ["setPagePause", ({ pageId }) => setPagePause(db(), { pageId, all: true, note: "mine" })],
    ["setSyncPageManualLogin", ({ pageId }) => tx((t) => setSyncPageManualLogin(t, { pageId, to: "wanted", by: "owner:test" }))],
  ];

  for (const [name, write] of WRITERS) {
    it(`${name} waits for the page row lock`, async (context) => {
      if (!testDb) return context.skip();
      const page = await browserPage();
      const holder = await testDb.pool.connect();
      let released = false;
      try {
        await holder.query("begin");
        await holder.query("select page_id from sync_pages where page_id = $1 for no key update", [page.pageId]);
        const writing = write(page).then(() => "done" as const);
        // Not done while the page row is held (a loaded machine only makes a
        // writer that does not wait look like one that does).
        expect(await Promise.race([writing, sleep(400).then(() => "waiting" as const)])).toBe("waiting");
        await holder.query("commit");
        released = true;
        expect(await writing).toBe("done");
      } finally {
        if (!released) await holder.query("rollback").catch(() => undefined);
        holder.release();
      }
    });
  }

  it("a start racing a stop: the start holds the page row to its end — never a stop's pause with no stop (Astra round 2, P1-4)", async (context) => {
    if (!testDb) return context.skip();
    const { pageId } = await browserPage();
    let startLifted!: () => void;
    const lifted = new Promise<void>((resolve) => (startLifted = resolve));
    let goOn!: () => void;
    const proceed = new Promise<void>((resolve) => (goOn = resolve));
    // The owner's start, in the lever's order: the stop's pause (none yet),
    // then the stop's mark — a stop is asked between the two.
    const start = tx(async (t) => {
      expect(await liftBrowserStopPause(t, { pageId })).toBeNull();
      startLifted();
      await proceed;
      await clearPageBrowserOwnerStop(t, { pageId });
    });
    await lifted;
    // The owner's stop, in the lever's order: the pause, then the mark.
    const stop = tx(async (t) => {
      await pausePageForBrowserStop(t, { pageId, note: "stop" });
      await setPageBrowserOwnerStop(t, { pageId, by: "cli" });
    });
    // The stop waits for the start (or, without the lock, it is done by now).
    await Promise.race([stop, sleep(400)]);
    goOn();
    await start;
    await stop;
    const row = (await testDb.pool.query<{ pausedAll: boolean; stopPaused: boolean; ownerStopAt: Date | null }>(
      `select sp.paused_all as "pausedAll", sp.browser_stop_paused as "stopPaused", b.owner_stop_at as "ownerStopAt"
         from sync_pages sp join page_browsers b on b.page_id = sp.page_id where sp.page_id = $1`, [pageId],
    )).rows[0]!;
    // The stop came after the start: it stands, with its pause.
    expect(row).toMatchObject({ pausedAll: true, stopPaused: true });
    expect(row.ownerStopAt).not.toBeNull();
  });
});

describe("the owner's commands (0281)", () => {
  it("taken by the page's owner, ended once by it; a newer owner takes one nothing was sent of — never one that was sent", async (context) => {
    if (!testDb) return context.skip();
    const { pageId, profileId } = await browserPage();
    const asked = (await insertPageBrowserCommand(db(), { pageId, kind: "selfTest", requestedBy: "cli", note: "n", ttlMs: 60_000 }))!;
    expect(asked).toMatchObject({ profileId, pageId, kind: "selfTest", takenAt: null, sentAt: null, doneAt: null, outcome: null, haltId: null });
    const taken = await takePageBrowserCommand(db(), { pageId, profileId, generation: 5n });
    expect(taken).toMatchObject({ id: asked.id, takenGeneration: 5n });
    // Not twice by the same owner, nor by an older one.
    expect(await takePageBrowserCommand(db(), { pageId, profileId, generation: 5n })).toBeNull();
    expect(await takePageBrowserCommand(db(), { pageId, profileId, generation: 4n })).toBeNull();
    // Its owner went before sending anything: the next owner takes it.
    expect(await takePageBrowserCommand(db(), { pageId, profileId, generation: 6n })).toMatchObject({ id: asked.id, commandId: asked.commandId, takenGeneration: 6n });
    // Only the owner that holds it marks it sent and ends it, once.
    expect(await markPageBrowserCommandSent(db(), { id: asked.id, generation: 5n })).toBe(false);
    expect(await markPageBrowserCommandSent(db(), { id: asked.id, generation: 6n })).toBe(true);
    // Sent: a newer owner never takes it again (its outcome is unknown, never sent twice).
    expect(await takePageBrowserCommand(db(), { pageId, profileId, generation: 7n })).toBeNull();
    expect(await finishPageBrowserCommand(db(), { id: asked.id, generation: 5n, outcome: "ok", detail: "late" })).toBe(false);
    expect(await finishPageBrowserCommand(db(), { id: asked.id, generation: 6n, outcome: "failed", detail: "x".repeat(900) })).toBe(true);
    expect(await finishPageBrowserCommand(db(), { id: asked.id, generation: 6n, outcome: "ok", detail: "again" })).toBe(false);
    const done = (await getPageBrowserCommand(db(), asked.id))!;
    expect(done).toMatchObject({ outcome: "failed", ok: false });
    expect(done.detail).toHaveLength(500);
    // Unknown: ended without an ok.
    const other = (await insertPageBrowserCommand(db(), { pageId, kind: "stopPage", requestedBy: "cli", ttlMs: 60_000 }))!;
    await takePageBrowserCommand(db(), { pageId, profileId, generation: 8n });
    await markPageBrowserCommandSent(db(), { id: other.id, generation: 8n });
    expect(await finishPageBrowserCommand(db(), { id: other.id, generation: 8n, outcome: "unknown", detail: "no answer" })).toBe(true);
    expect(await getPageBrowserCommand(db(), other.id)).toMatchObject({ outcome: "unknown", ok: null });
  });

  it("a command taken, then given back by an owner superseded before sending it, is the newer owner's (Astra round 3)", async (context) => {
    if (!testDb) return context.skip();
    const { pageId, profileId } = await browserPage();
    const asked = (await insertPageBrowserCommand(db(), { pageId, kind: "restartBrowser", requestedBy: "cli", ttlMs: 60_000, haltId: "h-1" }))!;
    expect(asked.haltId).toBe("h-1");
    await takePageBrowserCommand(db(), { pageId, profileId, generation: 5n });
    expect(await releasePageBrowserCommand(db(), { id: asked.id, generation: 5n })).toBe(true);
    expect(await getPageBrowserCommand(db(), asked.id)).toMatchObject({ takenAt: null, takenGeneration: null, doneAt: null });
    expect(await takePageBrowserCommand(db(), { pageId, profileId, generation: 6n })).toMatchObject({ id: asked.id, takenGeneration: 6n });
    // One sent is never given back.
    await markPageBrowserCommandSent(db(), { id: asked.id, generation: 6n });
    expect(await releasePageBrowserCommand(db(), { id: asked.id, generation: 6n })).toBe(false);
  });

  it("past its expiry every command ends: never taken — or taken and not sent — expired; sent and not answered — unknown, once its answer can no longer come (Astra round 3)", async (context) => {
    if (!testDb) return context.skip();
    const { pageId, profileId } = await browserPage();
    const untaken = (await insertPageBrowserCommand(db(), { pageId, kind: "restartBrowser", requestedBy: "cli", ttlMs: 60_000 }))!;
    expect(await expirePageBrowserCommands(db(), { id: untaken.id })).toBe(0);
    const taken = (await insertPageBrowserCommand(db(), { pageId, kind: "stopPage", requestedBy: "cli", ttlMs: 60_000 }))!;
    const sent = (await insertPageBrowserCommand(db(), { pageId, kind: "selfTest", requestedBy: "cli", ttlMs: 60_000 }))!;
    await testDb.pool.query("update page_browser_commands set taken_generation = 5, taken_at = clock_timestamp() where id = any($1)", [[taken.id, sent.id]]);
    await testDb.pool.query("update page_browser_commands set sent_at = clock_timestamp() where id = $1", [sent.id]);
    await testDb.pool.query("update page_browser_commands set expires_at = clock_timestamp() - interval '1 second' where page_id = $1", [pageId]);
    // Never taken past its expiry, by anyone.
    expect(await takePageBrowserCommand(db(), { pageId, profileId, generation: 9n })).toBeNull();
    expect(await getPageBrowserCommand(db(), untaken.id)).toMatchObject({ outcome: "expired", ok: false, detail: expect.stringContaining("no owner") });
    expect(await getPageBrowserCommand(db(), taken.id)).toMatchObject({ outcome: "expired", ok: false, detail: expect.stringContaining("went before sending") });
    // Sent: its answer may still come within the grace.
    expect(await getPageBrowserCommand(db(), sent.id)).toMatchObject({ doneAt: null, outcome: null });
    await testDb.pool.query("update page_browser_commands set expires_at = clock_timestamp() - interval '61 seconds' where id = $1", [sent.id]);
    expect(await expirePageBrowserCommands(db(), { pageId })).toBe(1);
    expect(await getPageBrowserCommand(db(), sent.id)).toMatchObject({ outcome: "unknown", ok: null, detail: expect.stringContaining("never sent again") });
    const { pageId: bare } = await seedHarnessPage({ db: db(), pool: testDb.pool }, { mode: "live", proxyUrl: null, label: "no-browser-2", ownRef: "300000000000000778" });
    expect(await insertPageBrowserCommand(db(), { pageId: bare, kind: "selfTest", requestedBy: "cli", ttlMs: 1_000 })).toBeNull();
    await expect(testDb.pool.query("insert into page_browser_commands (profile_id, page_id, kind, requested_by, expires_at) values ($1, $2, 'profileSnapshot', 'x', now())", [profileId, pageId]))
      .rejects.toThrow(/page_browser_commands_kind_check/);
    await expect(testDb.pool.query("update page_browser_commands set done_at = now(), outcome = 'ok', ok = null where id = $1", [untaken.id]))
      .rejects.toThrow(/page_browser_commands_done_check/);
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
