import { describe, expect, it } from "vitest";

import type { PageBrowserRow, SyncPageRow } from "@agency_hub_core/db";

import {
  incidentTitleForKind,
  resolveMessageForIncident,
  SYNC_ENGINE_BROWSER_KINDS,
  syncEngineBrowserSubKey,
  syncEngineIncidentKey,
} from "../apps/runtime/src/services/notification-incidents.ts";
import { notificationPagingPolicyFor } from "../apps/runtime/src/services/notification-paging-policy.ts";
import {
  browserBufferPercent,
  evaluateBrowserAlerts,
  SYNC_BROWSER_ALARM_HOLD_MS,
  SYNC_BROWSER_BUFFER_CAP,
  SYNC_BROWSER_DOWN_MS,
  SYNC_BROWSER_SITE_UNCONFIRMED_MS,
  SYNC_BROWSER_STATE_SILENT_MS,
  type BrowserAlertFacts,
} from "../apps/runtime/src/sync/engine/browser-alerts.ts";

import { pageHoldRow } from "./helpers/sync-holds.ts";

// A page browser's alerts (Project Browser plan §4.9, §4.11; PR 17): the
// plan's kinds judged from what the operator said (its last state and alarm)
// — a stop that waits for the owner pages at once, a failure the operator
// retries pages once the browser stayed down, an alarm holds its kind for the
// clean window, and what the owner does himself explains a browser that is
// down (never a guard that failed).

const NOW = new Date("2026-10-14T12:00:00.000Z");
const at = (ms: number) => new Date(NOW.getTime() + ms);
const MINUTE = 60_000;

function browser(overrides: Partial<PageBrowserRow> = {}): PageBrowserRow {
  return {
    profileId: "11111111-1111-4111-8111-111111111111",
    pageId: 7,
    container: "page-browser-lilly-1",
    step: "ready",
    stopReason: null,
    mode: "automation",
    exitOpen: true,
    sessionFingerprint: "a".repeat(64),
    accountId: "123",
    exitIp: "203.0.113.7",
    chromeVersion: "155.0.0.0",
    operatorVersion: "abc",
    selftestOk: true,
    selftestAt: at(-30 * MINUTE),
    selftestFailed: null,
    bufferBytes: 1024,
    bufferOldestAgeMs: 100,
    lastStateAt: at(-5_000),
    linkError: null,
    encryptedEngineToken: "",
    encryptedApiToken: "",
    encryptedVncPassword: "",
    keyVersion: 1,
    pinnedExitIp: "203.0.113.7",
    pinnedExitIpAt: at(-60 * MINUTE),
    env: null,
    handoverGeneration: 3n,
    handoverQuiescedAt: at(-30 * MINUTE),
    handoverLastSendAt: null,
    bufferUndrainedSince: null,
    retryAt: null,
    downSince: null,
    stopSince: null,
    deliveryP50Ms: 40,
    deliveryP95Ms: 90,
    deliveryAt: at(-30_000),
    alarmKind: null,
    alarmAt: null,
    alarmDetail: null,
    ownerStopAt: null,
    ownerStopBy: null,
    haltReason: null,
    haltAt: null,
    haltId: null,
    hubSendAllowed: true,
    hubSendBlockedReason: null,
    hubSendBlockedSince: null,
    crashDumpsCompleted: 0,
    crashDumpsCompletedNewestAt: null,
    crashDumpsPending: 0,
    crashDumpsPendingNewestAt: null,
    crashDumpsCountedAt: at(-30 * MINUTE),
    siteObservedUnconfirmed: 0,
    siteObservedOldestAt: null,
    siteObservedDropped: 0,
    ...overrides,
  };
}

function facts(input: { browser?: Partial<PageBrowserRow> | null; page?: Partial<SyncPageRow> } = {}): BrowserAlertFacts {
  const page = {
    pageId: 7,
    mode: "live",
    pausedAll: false,
    holds: [],
    owner: {
      generation: 3n, instance: "i", host: "sync", pid: 1, pidStart: null, pidNs: null, bootId: null,
      acquiredAt: at(-60 * MINUTE), heartbeatAt: at(-5_000), releasedAt: null, releaseGeneration: null,
      stopConfirmedAt: null, stopConfirmedBy: null,
    },
    ...input.page,
  } as BrowserAlertFacts["page"];
  return { page, browser: input.browser === null ? null : browser(input.browser ?? {}), now: NOW };
}

function kinds(input: Parameters<typeof facts>[0] = {}): Record<string, string> {
  return Object.fromEntries(evaluateBrowserAlerts(facts(input)).map((condition) => [condition.kind, condition.detail]));
}

describe("a page browser's alerts (Project Browser PR 17)", () => {
  it("a ready browser that speaks holds nothing; a page without a browser has no condition", () => {
    expect(kinds()).toEqual({});
    expect(kinds({ browser: null })).toEqual({});
  });

  it("no state for 2 min while the page's owner runs: browser_down no_state — not while the owner itself is silent", () => {
    expect(kinds({ browser: { lastStateAt: at(-SYNC_BROWSER_STATE_SILENT_MS + 1_000) } })).toEqual({});
    expect(kinds({ browser: { lastStateAt: at(-SYNC_BROWSER_STATE_SILENT_MS - 1_000) } })).toEqual({ browser_down: "no_state" });
    // Never heard since the slot began: counted from the slot.
    expect(kinds({ browser: { lastStateAt: null }, page: { owner: { ...facts().page.owner, acquiredAt: at(-MINUTE) } } })).toEqual({});
    expect(kinds({ browser: { lastStateAt: null }, page: { owner: { ...facts().page.owner, acquiredAt: at(-3 * MINUTE) } } }))
      .toEqual({ browser_down: "no_state" });
    // The owner is silent itself (alert 1's): no browser_down for it.
    expect(kinds({ browser: { lastStateAt: at(-10 * MINUTE) }, page: { owner: { ...facts().page.owner, heartbeatAt: at(-5 * MINUTE) } } }))
      .toEqual({});
  });

  it("a link the operator refused, or broken by the protocol, is browser_down at once", () => {
    expect(kinds({ browser: { linkError: "protocol_version" } })).toEqual({ browser_down: "link_protocol_version" });
    expect(kinds({ browser: { linkError: "token" } })).toEqual({ browser_down: "link_token" });
  });

  it("a stop that waits for the owner, or a guard that did not hold, pages at once, each its kind", () => {
    const stopped = (reason: string) => ({ step: "exit_closed", exitOpen: false, stopReason: reason, stopSince: at(-1_000), downSince: at(-1_000) });
    expect(kinds({ browser: stopped("login_required") })).toEqual({ login_required: "login_required" });
    expect(kinds({ browser: stopped("exit_ip_changed") })).toEqual({ exit_ip_changed: "exit_ip_changed" });
    expect(kinds({ browser: { ...stopped("selftest_failed"), retryAt: at(10_000) } })).toEqual({ selftest_failed: "selftest_failed" });
    expect(kinds({ browser: stopped("header_mismatch") })).toEqual({ protocol_changed: "header_mismatch" });
    expect(kinds({ browser: stopped("unknown_ws_message") })).toEqual({ protocol_changed: "unknown_ws_message" });
    expect(kinds({ browser: { ...stopped("cdp_lost"), retryAt: at(10_000) } })).toEqual({ cdp_lost: "cdp_lost" });
    expect(kinds({ browser: { ...stopped("holder_overflow"), retryAt: at(10_000) } })).toEqual({ cdp_lost: "holder_overflow" });
    for (const reason of ["buffer_full", "disk_full", "buffer_unavailable"]) expect(kinds({ browser: stopped(reason) })).toEqual({ buffer: reason });
    // Since the operator first said it.
    expect(evaluateBrowserAlerts(facts({ browser: stopped("exit_ip_changed") }))[0]!.since).toEqual(at(-1_000));
  });

  it("a proxy the operator retries pages once the browser stayed down 2 min", () => {
    const failing = (downMs: number) => ({ step: "exit_closed", exitOpen: false, stopReason: "proxy_unavailable", retryAt: at(30_000), downSince: at(-downMs) });
    expect(kinds({ browser: failing(SYNC_BROWSER_DOWN_MS - 1_000) })).toEqual({});
    expect(kinds({ browser: failing(SYNC_BROWSER_DOWN_MS + 1_000) })).toEqual({ proxy: "proxy_unavailable" });
    expect(kinds({ browser: { ...failing(SYNC_BROWSER_DOWN_MS + 1_000), stopReason: "proxy_auth" } })).toEqual({ proxy: "proxy_auth" });
  });

  it("a browser down for another reason, or a start that hangs, is browser_down after 2 min", () => {
    expect(kinds({ browser: { step: "exit_closed", exitOpen: false, stopReason: "chrome_crashed", retryAt: at(5_000), downSince: at(-MINUTE) } })).toEqual({});
    expect(kinds({ browser: { step: "exit_closed", exitOpen: false, stopReason: "chrome_crashed", retryAt: at(5_000), downSince: at(-3 * MINUTE) } }))
      .toEqual({ browser_down: "chrome_crashed" });
    expect(kinds({ browser: { step: "site_loaded", stopReason: null, downSince: at(-3 * MINUTE) } })).toEqual({ browser_down: "not_up:site_loaded" });
    expect(kinds({ browser: { step: "site_loaded", stopReason: null, sessionFingerprint: null, downSince: at(-3 * MINUTE) } })).toEqual({ browser_down: "session_unknown" });
  });

  it("what the owner does himself explains a browser that is down — never a guard that failed", () => {
    const down = { step: "exit_closed", exitOpen: false, stopReason: "proxy_unavailable", retryAt: at(30_000), downSince: at(-10 * MINUTE) };
    expect(kinds({ browser: down })).toEqual({ proxy: "proxy_unavailable" });
    expect(kinds({ browser: { ...down, ownerStopAt: at(-MINUTE), ownerStopBy: "cli" } })).toEqual({});
    expect(kinds({ browser: down, page: { pausedAll: true } })).toEqual({});
    expect(kinds({ browser: { ...down, mode: "manual_login" } })).toEqual({});
    expect(kinds({ browser: down, page: { holds: [pageHoldRow("auth")] } })).toEqual({});
    // Stopped by the owner: the operator's own word, no alert at all.
    expect(kinds({ browser: { step: "exit_closed", exitOpen: false, stopReason: "owner_stop", downSince: at(-10 * MINUTE) } })).toEqual({});
    // A guard that failed pages whatever the owner does.
    expect(kinds({ browser: { step: "exit_closed", exitOpen: false, stopReason: "header_mismatch", downSince: at(-10 * MINUTE) }, page: { pausedAll: true } }))
      .toEqual({ protocol_changed: "header_mismatch" });
    // A person at the login is no login_required page.
    expect(kinds({ browser: { step: "exit_closed", exitOpen: false, stopReason: "login_required", mode: "manual_login" } })).toEqual({});
  });

  it("a halt the operator holds for the owner's decision (Hub's mirror) holds its kind whatever its step says now (Astra PR 17, P1-1)", () => {
    const latched = { haltReason: "header_mismatch", haltAt: at(-5 * MINUTE) };
    // An operator that started again: it stands with no reason, down for long.
    const restarted = { ...latched, step: "exit_closed", exitOpen: false, stopReason: null, downSince: at(-5 * MINUTE) };
    expect(kinds({ browser: restarted })).toEqual({ protocol_changed: "header_mismatch" });
    expect(evaluateBrowserAlerts(facts({ browser: restarted }))[0]).toMatchObject({ since: at(-5 * MINUTE), context: { latched: true } });
    // Paused by the owner: a halt still pages (it waits for his decision).
    expect(kinds({ browser: restarted, page: { pausedAll: true } })).toEqual({ protocol_changed: "header_mismatch" });
    // A reason this build does not know: browser_down.
    expect(kinds({ browser: { ...restarted, haltReason: "a_newer_halt" } })).toEqual({ browser_down: "a_newer_halt" });
  });

  it("Hub's requests refused while the page says ready (protocol minor 5): the transport's own as protocol_changed for as long as it lives, any other once it lasted 2 min", () => {
    const blocked = (reason: string, msAgo: number) => ({ hubSendAllowed: false, hubSendBlockedReason: reason, hubSendBlockedSince: at(-msAgo) });
    // The audit's case: the parity broke 12 h ago, its alarm is long past its
    // clean window, the page is ready — the condition holds still.
    const parity = { ...blocked("header_parity", 12 * 60 * MINUTE), alarmKind: "header_mismatch", alarmAt: at(-12 * 60 * MINUTE), alarmDetail: {} };
    expect(kinds({ browser: parity })).toEqual({ protocol_changed: "hub_send_blocked:header_parity" });
    expect(evaluateBrowserAlerts(facts({ browser: parity }))[0]).toMatchObject({ since: at(-12 * 60 * MINUTE), context: { reason: "header_parity", step: "ready" } });
    expect(kinds({ browser: blocked("client_check", MINUTE) })).toEqual({ protocol_changed: "hub_send_blocked:client_check" });
    // Within the alarm's window the state's word names it, not the alarm.
    expect(kinds({ browser: { ...blocked("header_parity", MINUTE), alarmKind: "header_mismatch", alarmAt: at(-MINUTE), alarmDetail: {} } }))
      .toEqual({ protocol_changed: "hub_send_blocked:header_parity" });
    // Gone with the reason: Chrome started anew.
    expect(kinds({ browser: { hubSendAllowed: true, alarmKind: "header_mismatch", alarmAt: at(-12 * 60 * MINUTE), alarmDetail: {} } })).toEqual({});
    // Any other reason: only a ready page, after 2 min, and not what the owner does.
    expect(kinds({ browser: blocked("no_template", SYNC_BROWSER_DOWN_MS - 1_000) })).toEqual({});
    expect(kinds({ browser: blocked("no_template", SYNC_BROWSER_DOWN_MS + 1_000) })).toEqual({ browser_down: "hub_send_blocked:no_template" });
    expect(kinds({ browser: { ...blocked("no_template", SYNC_BROWSER_DOWN_MS + 1_000) }, page: { pausedAll: true } })).toEqual({});
    expect(kinds({ browser: { ...blocked("page_not_up", 10 * MINUTE), step: "exit_ip_verified", downSince: at(-MINUTE) } })).toEqual({});
    // An operator before minor 5 says nothing of it.
    expect(kinds({ browser: { hubSendAllowed: null } })).toEqual({});
  });

  it("the site's observations Hub has not confirmed (protocol minor 6): site_unconfirmed once the oldest waited 2 min, while the state saying it is fresh", () => {
    const waiting = (ms: number) => ({ siteObservedUnconfirmed: 3, siteObservedOldestAt: at(-ms), siteObservedDropped: 0 });
    expect(kinds({ browser: waiting(SYNC_BROWSER_SITE_UNCONFIRMED_MS - 1_000) })).toEqual({});
    expect(kinds({ browser: waiting(SYNC_BROWSER_SITE_UNCONFIRMED_MS + 1_000) })).toEqual({ site_unconfirmed: "site_unconfirmed" });
    expect(evaluateBrowserAlerts(facts({ browser: { ...waiting(10 * MINUTE), siteObservedDropped: 7 } }))[0])
      .toMatchObject({ kind: "site_unconfirmed", since: at(-10 * MINUTE), context: { unconfirmed: 3, dropped: 7 } });
    // A silent operator is browser_down's: its last word is old.
    expect(kinds({ browser: { ...waiting(10 * MINUTE), lastStateAt: at(-SYNC_BROWSER_STATE_SILENT_MS - 1_000) } })).toEqual({ browser_down: "no_state" });
    // Nothing kept, or an operator before minor 6.
    expect(kinds({ browser: { siteObservedUnconfirmed: 0, siteObservedOldestAt: null } })).toEqual({});
    expect(kinds({ browser: { siteObservedUnconfirmed: null, siteObservedOldestAt: null, siteObservedDropped: null } })).toEqual({});
  });

  it("the last self-test failed: selftest_failed, with the mechanism", () => {
    expect(kinds({ browser: { selftestOk: false, selftestFailed: "dnr_never" } })).toEqual({ selftest_failed: "dnr_never" });
  });

  it("a buffer past 50 % or 80 % of either cap pages buffer", () => {
    const half = SYNC_BROWSER_BUFFER_CAP.bytes / 2;
    expect(kinds({ browser: { bufferBytes: half - 1 } })).toEqual({});
    expect(kinds({ browser: { bufferBytes: half } })).toEqual({ buffer: "buffer_50" });
    expect(kinds({ browser: { bufferOldestAgeMs: SYNC_BROWSER_BUFFER_CAP.ageMs * 0.81 } })).toEqual({ buffer: "buffer_80" });
    expect(browserBufferPercent(browser({ bufferBytes: SYNC_BROWSER_BUFFER_CAP.bytes / 4, bufferOldestAgeMs: 0 }))).toBe(25);
    expect(browserBufferPercent(browser({ bufferBytes: null, bufferOldestAgeMs: null }))).toBeNull();
  });

  it("an alarm holds its kind for the clean window after it, as of the alarm", () => {
    const alarm = (kind: string, msAgo: number, detail: Record<string, string | number | boolean> = {}) =>
      ({ alarmKind: kind, alarmAt: at(-msAgo), alarmDetail: detail });
    expect(kinds({ browser: alarm("cdp_lost", MINUTE) })).toEqual({ cdp_lost: "alarm_cdp_lost" });
    expect(kinds({ browser: alarm("fallback_release", MINUTE) })).toEqual({ cdp_lost: "alarm_fallback_release" });
    expect(kinds({ browser: alarm("unknown_ws_message", MINUTE) })).toEqual({ protocol_changed: "alarm_unknown_ws_message" });
    expect(kinds({ browser: alarm("selftest_failed", MINUTE) })).toEqual({ selftest_failed: "alarm_selftest_failed" });
    expect(kinds({ browser: alarm("late_send", MINUTE) })).toEqual({ browser_down: "alarm_late_send" });
    expect(kinds({ browser: alarm("cdp_lost", SYNC_BROWSER_ALARM_HOLD_MS + 1_000) })).toEqual({});
    // A buffer alarm below the lowest threshold says nothing; its fill does.
    expect(kinds({ browser: alarm("buffer", MINUTE, { percent: 10 }) })).toEqual({});
    expect(kinds({ browser: alarm("buffer", MINUTE, { percent: 50 }) })).toEqual({ buffer: "alarm_buffer" });
    expect(kinds({ browser: alarm("buffer", MINUTE, { full: true, percent: 100 }) })).toEqual({ buffer: "alarm_buffer" });
    const [held] = evaluateBrowserAlerts(facts({ browser: alarm("cdp_lost", MINUTE) }));
    expect(held!.seenAt).toEqual(at(-MINUTE));
  });

  it("each kind is its own latch, with its own title and resolve line, paged at once", () => {
    expect(SYNC_ENGINE_BROWSER_KINDS).toEqual([
      "browser_down", "login_required", "proxy", "exit_ip_changed", "buffer", "selftest_failed", "protocol_changed", "cdp_lost", "site_unconfirmed",
    ]);
    const titles = new Set<string>();
    for (const kind of SYNC_ENGINE_BROWSER_KINDS) {
      const subKey = syncEngineBrowserSubKey(kind);
      expect(subKey).toBe(`browser:${kind}`);
      expect(syncEngineIncidentKey({ subKey, pageId: 7 })).toBe(`fansly_sync_engine:7:browser:${kind}`);
      const title = incidentTitleForKind({ kind: "fansly_sync_engine", subKey });
      expect(title).toMatch(/^Page browser /);
      titles.add(title);
      expect(resolveMessageForIncident({ kind: "fansly_sync_engine", pageLabel: "lilly-1", platform: "fansly", subKey })).toContain("Page browser");
      expect(notificationPagingPolicyFor("fansly_sync_engine", subKey).openHoldMs).toBe(0);
    }
    expect(titles.size).toBe(SYNC_ENGINE_BROWSER_KINDS.length);
  });
});
