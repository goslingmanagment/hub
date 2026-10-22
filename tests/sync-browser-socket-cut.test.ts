import { describe, expect, it } from "vitest";

import type { PageBrowserRow } from "@agency_hub_core/db";

import { incidentTitleForKind, syncEngineBrowserSubKey } from "../apps/runtime/src/services/notification-incidents.ts";
import { notificationPagingPolicyFor } from "../apps/runtime/src/services/notification-paging-policy.ts";
import { evaluateBrowserAlerts, type BrowserAlertFacts } from "../apps/runtime/src/sync/engine/browser-alerts.ts";

// The socket gate's refusal (page-browser ws/sockets.ts): one cuts its
// tunnel alone — the operator's `unknown_ws_message` alarm of `scope:
// "tunnel"`, the page goes on — and only the third within its window stops
// the page. A latch pages once an episode, so the stop must not land in the
// latch the cuts before it opened: the cut is `socket_cut`, the stop
// `protocol_changed`, each its own latch and its own page.

const NOW = new Date("2026-10-22T12:00:00.000Z");
const at = (ms: number) => new Date(NOW.getTime() + ms);
const MINUTE = 60_000;
const REFUSED = { at: "proxy", recordBytes: 30, why: "a message of no allowed size", left: false };

function browser(overrides: Partial<PageBrowserRow>): PageBrowserRow {
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
    egressFailures: null,
    egressFailuresSince: null,
    ...overrides,
  };
}

function kinds(overrides: Partial<PageBrowserRow>): Record<string, string> {
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
  } as BrowserAlertFacts["page"];
  return Object.fromEntries(evaluateBrowserAlerts({ page, browser: browser(overrides), now: NOW }).map((condition) => [condition.kind, condition.detail]));
}

describe("a socket the gate cut is not the page it stopped (unknown_ws_message)", () => {
  it("a tunnel cut alone holds socket_cut for the clean window, never protocol_changed", () => {
    const cut = { alarmKind: "unknown_ws_message", alarmDetail: { ...REFUSED, refusals: 1, scope: "tunnel" } };
    expect(kinds({ ...cut, alarmAt: at(-2 * MINUTE) })).toEqual({ socket_cut: "alarm_unknown_ws_message" });
    expect(kinds({ ...cut, alarmAt: at(-11 * MINUTE) })).toEqual({});
  });

  it("the stop after the cuts holds protocol_changed: a latch of its own, which pages while the cuts' latch is still open", () => {
    // The third refusal: the operator stops the page, holds the halt, and
    // alarms without a scope — a minute after the cut before it.
    const stopped = kinds({
      step: "stopped",
      stopReason: "unknown_ws_message",
      stopSince: at(-MINUTE),
      haltReason: "unknown_ws_message",
      haltAt: at(-MINUTE),
      haltId: "h1",
      exitOpen: false,
      alarmKind: "unknown_ws_message",
      alarmAt: at(-MINUTE),
      alarmDetail: { ...REFUSED, refusals: 3 },
    });
    expect(stopped).toMatchObject({ protocol_changed: "unknown_ws_message" });
    expect(stopped).not.toHaveProperty("socket_cut");
    const cutLatch = syncEngineBrowserSubKey("socket_cut");
    const stopLatch = syncEngineBrowserSubKey("protocol_changed");
    expect(stopLatch).not.toBe(cutLatch);
    expect(incidentTitleForKind({ kind: "fansly_sync_engine", subKey: stopLatch })).not.toBe(incidentTitleForKind({ kind: "fansly_sync_engine", subKey: cutLatch }));
    // Both page at once (the engine's latches carry their own delays).
    for (const subKey of [cutLatch, stopLatch]) expect(notificationPagingPolicyFor("fansly_sync_engine", subKey)).toEqual(notificationPagingPolicyFor("fansly_sync_engine", null));
  });
});
