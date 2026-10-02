import { afterEach, describe, expect, it } from "vitest";

import type * as FanslyPackage from "@agency_hub_core/fansly";
import type {
  FanslyAdapter,
  FanslyRequestContext,
  FanslyWireId,
  FanslyWireParams,
} from "@agency_hub_core/fansly";

import {
  captureEvents,
  cleanupAdapterHarness,
  loadAdapters,
  toJsonResponse,
} from "./helpers/adapter-harness.ts";
import { createTestFanslySendGuard } from "./helpers/fansly-send-guard.ts";

// Every wire spec sends exactly the request the adapter method of the same
// route sends today — the same URL (path, keys, order, present-and-empty
// values) and the same headers — and names the adapter's operation and
// endpoint template, so the shadow report can map legacy volume onto wire ids.
//
// The package is imported only after the harness has mocked undici's fetch
// (a value import of it at the top of this file would bind the real one).

afterEach(() => {
  cleanupAdapterHarness();
});

type Wire = typeof FanslyPackage;
type AdapterCall = (adapter: FanslyAdapter, context: FanslyRequestContext) => Promise<unknown>;
interface ParityCase {
  id: FanslyWireId;
  label: string;
  url: string;
  headers: Record<string, string>;
  call: AdapterCall;
}

const BASE_URL = "https://apiv3.fansly.example/api/v1";
const SESSION = {
  authorization: "token",
  fanslyClientId: "client-1",
  fanslySessionId: "session-1",
  routeChecks: {
    earnings: "check-earnings",
    subscribers: "check-subscribers",
    media: "check-media",
    messagingGroups: "check-groups",
    group: "check-group",
    message: "check-message",
    account: "check-account",
  },
};
const AFTER = Date.UTC(2026, 8, 1);
const BEFORE = Date.UTC(2026, 8, 8);
// The legacy lanes' own values (pinned against their constants in
// tests/fansly-wire-contracts.test.ts).
const ORDER_HISTORY_LIMIT = 100;
const EARNINGS_ROW_LIMIT = 100;

function parityCases(wire: Wire): ParityCase[] {
  function parity<I extends FanslyWireId>(
    id: I,
    params: FanslyWireParams<I>,
    call: AdapterCall,
    label = "",
  ): ParityCase {
    const request = wire.buildFanslyWireRequest(id, params, { baseUrl: BASE_URL, session: SESSION, timeoutMs: 20_000 });
    return { id, label: `${id}${label}`, url: request.url, headers: request.headers, call };
  }

  return [
    parity("account.me", {}, (a, c) => a.getAccountMe(c)),
    parity("accounts.by_ids", { ids: ["1", "2"] }, (a, c) => a.getAccountsByIdsPage(c, ["1", "2"])),
    parity("messaging.groups", { offset: 200 }, (a, c) =>
      a.getMessagingGroupsPage(c, { limit: 100, offset: 200, sortOrder: 1, flags: 0 })),
    parity("group.detail", { groupId: "451" }, (a, c) => a.getGroupDetail(c, "451")),
    parity("messages.page", { groupId: "451", before: null }, (a, c) =>
      a.getMessagesPage(c, { groupId: "451", limit: 25 }), " (head)"),
    parity("messages.page", { groupId: "451", before: "9001" }, (a, c) =>
      a.getMessagesPage(c, { groupId: "451", limit: 25, before: "9001" }), " (before)"),
    parity("transactions.page", { limit: 20, offset: 40 }, (a, c) =>
      a.getTransactionsPage(c, { limit: 20, offset: 40 })),
    parity("earnings.accounts", { afterMs: AFTER, beforeMs: BEFORE }, (a, c) =>
      a.getEarningsAccountsPage(c, { after: new Date(AFTER), before: new Date(BEFORE) })),
    parity("earnings.stats_accounts", { correlationAccountId: "77", afterMs: 0, beforeMs: BEFORE }, (a, c) =>
      a.getEarningsStatsAccountsPage(c, { correlationAccountId: "77", after: new Date(0), before: new Date(BEFORE) })),
    parity("earnings.monthly_accounts", { correlationAccountId: "77", afterMs: 0, beforeMs: BEFORE }, (a, c) =>
      a.getEarningsMonthlyStatsAccountsPage(c, {
        correlationAccountId: "77", after: new Date(0), before: new Date(BEFORE),
      })),
    parity("media.order_history", { target: { kind: "media", id: "m-1" }, before: null }, (a, c) =>
      a.getMediaOrderHistoryPage(c, { accountMediaId: "m-1", before: null, limit: ORDER_HISTORY_LIMIT }),
    " (media head)"),
    parity("media.order_history", { target: { kind: "bundle", id: "b-1" }, before: "o-9" }, (a, c) =>
      a.getMediaOrderHistoryPage(c, { accountMediaBundleId: "b-1", before: "o-9", limit: ORDER_HISTORY_LIMIT }),
    " (bundle before)"),
    parity("payouts.methods", {}, (a, c) => a.getPayoutMethods(c)),
    parity("payouts.requests", { offset: 10 }, (a, c) =>
      a.getPayoutRequestsPage(c, { before: "", after: "", limit: 10, offset: 10 })),
    parity("subscribers.page", { status: "3,4", offset: 0 }, (a, c) =>
      a.getSubscribersPage(c, { limit: 100, offset: 0, status: "3,4" }), " (active)"),
    parity("subscribers.page", { status: "5", offset: 300 }, (a, c) =>
      a.getSubscribersPage(c, { limit: 100, offset: 300, status: "5" }), " (expired)"),
    parity("followers.page", { accountId: "page-acct", offset: 100 }, (a, c) =>
      a.getFollowersPage(c, "page-acct", { offset: 100, limit: 100 })),
    parity("notifications.page", { before: "0", types: null }, (a, c) =>
      a.getNotificationsPage(c, { before: "0", after: "0", types: null }), " (unfiltered)"),
    parity("notifications.page", { before: "n-5", types: [32007, 45012] }, (a, c) =>
      a.getNotificationsPage(c, { before: "n-5", after: "0", types: [32007, 45012] }), " (filtered)"),
    parity("posts.timeline", { accountId: "page-acct", before: "0" }, (a, c) =>
      a.getPostsPage(c, "page-acct", { before: "0", pageIndex: 0 })),
    parity("posts.tips", { targetIds: ["p-1", "p-2"] }, (a, c) => a.getTipsByTargetIds(c, ["p-1", "p-2"])),
    parity("posts.by_ids", { ids: ["p-1", "p-2"] }, (a, c) => a.getPostsByIds(c, ["p-1", "p-2"])),
    parity("post.replies", { postId: "p-1", before: null }, (a, c) =>
      a.getPostRepliesPage(c, { postId: "p-1", before: null }), " (bare)"),
    parity("post.replies", { postId: "p-1", before: "r-20" }, (a, c) =>
      a.getPostRepliesPage(c, { postId: "p-1", before: "r-20" }), " (before)"),
    parity("vault.albums", {}, (a, c) => a.getVaultAlbums(c)),
    parity("uservault.albums", { accountId: "page-acct" }, (a, c) =>
      a.getUserVaultAlbums(c, { accountId: "page-acct" })),
    parity("subscriptions.tiers", {}, (a, c) => a.getSubscriptionTiers(c)),
    parity("subscriptions.giftcodes", {}, (a, c) => a.getGiftCodes(c)),
    parity("message.automated", {}, (a, c) => a.getAutomatedMessages(c)),
    parity("account.walls", {}, (a, c) => a.getAccountWalls(c, { correlationPostIds: "" })),
    parity("vault.media", { albumId: "al-1", before: "0" }, (a, c) =>
      a.getVaultMediaPage(c, { albumId: "al-1", mediaType: "", search: "", before: "0", after: "0" }), " (head)"),
    parity("vault.media", { albumId: "al-1", before: "am-77" }, (a, c) =>
      a.getVaultMediaPage(c, { albumId: "al-1", mediaType: "", search: "", before: "am-77", after: "0" }),
    " (before)"),
    parity("account.media_by_ids", { ids: ["m-1", "m-2"] }, (a, c) => a.getAccountMediaByIds(c, { ids: "m-1,m-2" })),
    parity("account.bundles_by_ids", { ids: ["b-1"] }, (a, c) => a.getAccountMediaBundlesByIds(c, { ids: "b-1" })),
    parity("media.offer_stats", { mediaOfferId: "mo-1", beforeMs: BEFORE, afterMs: AFTER, periodMs: 86_400_000 },
      (a, c) => a.getMediaOfferStats(c, {
        mediaOfferId: "mo-1", beforeDate: new Date(BEFORE), afterDate: new Date(AFTER), periodMs: 86_400_000,
      })),
    parity("account.stats", { beforeMs: BEFORE, afterMs: AFTER, periodMs: 3_600_000 }, (a, c) =>
      a.getAccountStats(c, { beforeDate: new Date(BEFORE), afterDate: new Date(AFTER), periodMs: 3_600_000 }),
    " (bounds)"),
    parity("account.stats", { beforeMs: BEFORE, afterMs: AFTER, periodMs: 86_400_000, year: 2026, month: 7 }, (a, c) =>
      a.getAccountStats(c, {
        beforeDate: new Date(BEFORE), afterDate: new Date(AFTER), periodMs: 86_400_000, year: 2026, month: 7,
      }), " (named month)"),
    parity("earnings.stats_window", { beforeMs: BEFORE, afterMs: AFTER, limit: EARNINGS_ROW_LIMIT }, (a, c) =>
      a.getEarningsStatsWindow(c, { before: new Date(BEFORE), after: new Date(AFTER), limit: EARNINGS_ROW_LIMIT })),
    parity("earnings.monthly", { beforeMs: BEFORE, afterMs: Date.UTC(2015, 0, 1) }, (a, c) =>
      a.getEarningsMonthlyStats(c, { before: new Date(BEFORE), after: new Date(Date.UTC(2015, 0, 1)) })),
    parity("trackinglinks", {}, (a, c) => a.getTrackingLinks(c)),
    parity("discovery.suggestions", { limit: 10, offset: 10 }, (a, c) =>
      a.getDiscoveryMediaSuggestions(c, { limit: 10, offset: 10 })),
    parity("broadcast.stats", { before: null }, (a, c) =>
      a.getBroadcastStatsPage(c, { before: null, limit: null, deleted: false })),
    parity("broadcast.stats_deleted", { before: "bc-3" }, (a, c) =>
      a.getBroadcastStatsPage(c, { before: "bc-3", limit: null, deleted: true })),
    parity("broadcast.scheduled", {}, (a, c) => a.getBroadcastScheduled(c)),
    parity("polls", {}, (a, c) => a.getPolls(c)),
    parity("recapstats", {}, (a, c) => a.getRecapStats(c)),
  ];
}

function withoutTimestamp(headers: Record<string, string>) {
  const { "fansly-client-ts": _timestamp, ...rest } = headers;
  return rest;
}

describe("Fansly wire specs against the adapter", () => {
  it("send the adapter's exact URL and headers, under its operation and endpoint template", async () => {
    const { FanslyAdapter, fetchMock } = await loadAdapters();
    const wire: Wire = await import("@agency_hub_core/fansly");
    const cases = parityCases(wire);
    // Every API route; the socket's Upgrade and a CDN hop have no adapter twin.
    expect(new Set(cases.map((entry) => entry.id))).toEqual(new Set(wire.FANSLY_WIRE_IDS.filter((id) => wire.isFanslyApiWireId(id))));

    fetchMock.mockImplementation(async () => toJsonResponse({ success: true, response: [] }));
    const adapter = new FanslyAdapter({ baseUrl: BASE_URL });
    const { events, requestObserver } = captureEvents();
    const context: FanslyRequestContext = {
      session: SESSION,
      proxy: { url: "http://proxy.example:8080" },
      sendGuard: createTestFanslySendGuard(),
      requestObserver,
      remainingAttempts: () => 1,
    };
    const urlMismatches: string[] = [];
    try {
      for (const entry of cases) {
        const callsBefore = fetchMock.mock.calls.length;
        const eventsBefore = events.length;
        try {
          await entry.call(adapter as unknown as FanslyAdapter, context);
        } catch {
          // The adapter may refuse the synthetic body; only its request matters.
        }
        const calls = fetchMock.mock.calls.slice(callsBefore);
        expect(calls, entry.label).toHaveLength(1);
        const [url, init] = calls[0]! as unknown as [string, { headers: Record<string, string> }];
        if (url !== entry.url) urlMismatches.push(`${entry.label}: adapter ${url} ≠ wire ${entry.url}`);
        expect(withoutTimestamp(entry.headers), entry.label).toEqual(withoutTimestamp(init.headers));
        const started = events.slice(eventsBefore).find((event) => event.state === "started");
        const spec = wire.fanslyWireSpec(entry.id);
        expect(started?.operation, entry.label).toBe(spec.legacyOperation);
        expect(started?.endpointTemplate, entry.label).toBe(spec.endpointTemplate);
      }
    } finally {
      await adapter.close();
    }
    expect(urlMismatches).toEqual([]);
  });
});
