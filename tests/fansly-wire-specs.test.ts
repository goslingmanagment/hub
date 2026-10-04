import { describe, expect, it } from "vitest";

import {
  buildFanslyWireRequest,
  FANSLY_WIRE_IDS,
  fanslyWireSpec,
  isFanslyApiWireId,
  type FanslyWireId,
  type FanslyWireParams,
} from "@agency_hub_core/fansly";
import type { FanslyClientCheckRoute } from "@agency_hub_core/shared";

// The request of every API wire route, pinned: its URL (path, keys, their
// order, present-and-empty values), its headers and their order, and the
// legacy operation and endpoint template it is journaled and budgeted under.
//
// The values are the legacy adapter's. Until step 4 (S4-20) this test sent
// each route through the adapter and through its wire spec and compared the
// two; the table below is what the adapter sent in that comparison's last run
// (base 16567c31), frozen when the adapter's HTTP was deleted. A spec that
// drifts from it sends something production has never sent.

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

/** The headers of every request, in the order they are written. The client
 *  check is sent only on the routes of a check family, with that family's
 *  value; the timestamp is the send's own. */
const HEADERS_BEFORE_CHECK: ReadonlyArray<readonly [string, string]> = [
  ["user-agent", "Mozilla/5.0 (Macintosh; Intel Mac OS X 10.15; rv:153.0) Gecko/20100101 Firefox/153.0"],
  ["accept", "application/json, text/plain, */*"],
  ["accept-language", "en-US,en;q=0.9"],
  ["accept-encoding", "gzip, deflate, br, zstd"],
  ["referer", "https://fansly.com/"],
  ["fansly-client-id", "client-1"],
  ["fansly-client-ts", "<send time>"],
  ["fansly-session-id", "session-1"],
];
const HEADERS_AFTER_CHECK: ReadonlyArray<readonly [string, string]> = [
  ["origin", "https://fansly.com"],
  ["dnt", "1"],
  ["sec-gpc", "1"],
  ["sec-fetch-dest", "empty"],
  ["sec-fetch-mode", "cors"],
  ["sec-fetch-site", "same-site"],
  ["authorization", "token"],
];

interface FrozenRequest {
  id: FanslyWireId;
  label: string;
  /** The request the wire spec builds today. */
  built: { url: string; headers: Record<string, string> };
  /** What the adapter sent: the URL after the base, the journal's operation
   *  and endpoint template, and the check family whose value rode along. */
  url: string;
  operation: string;
  template: string;
  check: FanslyClientCheckRoute | null;
}

function sent<I extends FanslyWireId>(
  id: I,
  params: FanslyWireParams<I>,
  frozen: { label?: string; url: string; operation: string; template: string; check: FanslyClientCheckRoute | null },
): FrozenRequest {
  const request = buildFanslyWireRequest(id, params, { baseUrl: BASE_URL, session: SESSION, timeoutMs: 20_000 });
  return {
    id,
    label: `${id}${frozen.label ?? ""}`,
    built: { url: request.url, headers: request.headers },
    url: frozen.url,
    operation: frozen.operation,
    template: frozen.template,
    check: frozen.check,
  };
}

const FROZEN: readonly FrozenRequest[] = [
  sent("account.me", {}, {
    url: "/account/me?ngsw-bypass=true",
    operation: "account_me",
    template: "/account/me",
    check: null,
  }),
  sent("accounts.by_ids", { ids: ["1", "2"] }, {
    url: "/account?ngsw-bypass=true&ids=1%2C2",
    operation: "account_lookup",
    template: "/account",
    check: "account",
  }),
  sent("messaging.groups", { offset: 200 }, {
    url: "/messaging/groups?ngsw-bypass=true&offset=200&limit=100&sortOrder=1&flags=0",
    operation: "messaging_groups",
    template: "/messaging/groups",
    check: "messagingGroups",
  }),
  sent("group.detail", { groupId: "451" }, {
    url: "/group/451?ngsw-bypass=true",
    operation: "group_detail",
    template: "/group/:groupId",
    check: "group",
  }),
  sent("messages.page", { groupId: "451", before: null }, {
    label: " (head)",
    url: "/message?ngsw-bypass=true&groupId=451&limit=25",
    operation: "messages",
    template: "/message",
    check: "message",
  }),
  sent("messages.page", { groupId: "451", before: "9001" }, {
    label: " (before)",
    url: "/message?ngsw-bypass=true&groupId=451&limit=25&before=9001",
    operation: "messages",
    template: "/message",
    check: "message",
  }),
  sent("transactions.page", { limit: 20, offset: 40 }, {
    url: "/account/wallets/earnings/transactions?ngsw-bypass=true&limit=20&offset=40",
    operation: "earnings_transactions",
    template: "/account/wallets/earnings/transactions",
    check: "earnings",
  }),
  sent("earnings.accounts", { afterMs: AFTER, beforeMs: BEFORE }, {
    url: "/account/wallets/earnings/accounts?ngsw-bypass=true&after=1788220800000&before=1788825600000",
    operation: "earnings_accounts",
    template: "/account/wallets/earnings/accounts",
    check: "earnings",
  }),
  sent("earnings.stats_accounts", { correlationAccountId: "77", afterMs: 0, beforeMs: BEFORE }, {
    url: "/account/wallets/earnings/stats/accounts?ngsw-bypass=true&correlationAccountId=77&after=0&before=1788825600000",
    operation: "earnings_stats_accounts",
    template: "/account/wallets/earnings/stats/accounts",
    check: "earnings",
  }),
  sent("earnings.monthly_accounts", { correlationAccountId: "77", afterMs: 0, beforeMs: BEFORE }, {
    url: "/account/wallets/earnings/monthlystats/accounts?ngsw-bypass=true&correlationAccountId=77&after=0&before=1788825600000",
    operation: "earnings_monthlystats_accounts",
    template: "/account/wallets/earnings/monthlystats/accounts",
    check: "earnings",
  }),
  sent("media.order_history", { target: { kind: "media", id: "m-1" }, before: null }, {
    label: " (media head)",
    url: "/media/orderhistory?ngsw-bypass=true&accountMediaId=m-1&limit=100",
    operation: "media_orderhistory",
    template: "/media/orderhistory",
    check: "media",
  }),
  sent("media.order_history", { target: { kind: "bundle", id: "b-1" }, before: "o-9" }, {
    label: " (bundle before)",
    url: "/media/orderhistory?ngsw-bypass=true&accountMediaBundleId=b-1&before=o-9&limit=100",
    operation: "media_orderhistory",
    template: "/media/orderhistory",
    check: "media",
  }),
  sent("payouts.methods", {}, {
    url: "/payments/payoutmethods?ngsw-bypass=true",
    operation: "payout_methods",
    template: "/payments/payoutmethods",
    check: null,
  }),
  sent("payouts.requests", { offset: 10 }, {
    url: "/payments/payout/requests?ngsw-bypass=true&before=&after=&limit=10&offset=10",
    operation: "payout_requests",
    template: "/payments/payout/requests",
    check: null,
  }),
  sent("subscribers.page", { status: "3,4", offset: 0 }, {
    label: " (active)",
    url: "/subscribers?ngsw-bypass=true&offset=0&limit=100&status=3%2C4",
    operation: "subscribers",
    template: "/subscribers",
    check: "subscribers",
  }),
  sent("subscribers.page", { status: "5", offset: 300 }, {
    label: " (expired)",
    url: "/subscribers?ngsw-bypass=true&offset=300&limit=100&status=5",
    operation: "subscribers",
    template: "/subscribers",
    check: "subscribers",
  }),
  sent("followers.page", { accountId: "page-acct", offset: 100 }, {
    url: "/account/page-acct/followersnew?ngsw-bypass=true&offset=100&limit=100",
    operation: "followers",
    template: "/account/:accountId/followersnew",
    check: null,
  }),
  sent("notifications.page", { before: "0", types: null }, {
    label: " (unfiltered)",
    url: "/notifications?ngsw-bypass=true&before=0&after=0",
    operation: "notifications_page",
    template: "/notifications",
    check: null,
  }),
  sent("notifications.page", { before: "n-5", types: [32007, 45012] }, {
    label: " (filtered)",
    url: "/notifications?ngsw-bypass=true&before=n-5&after=0&type=32007%2C45012",
    operation: "notifications_page",
    template: "/notifications",
    check: null,
  }),
  sent("posts.timeline", { accountId: "page-acct", before: "0" }, {
    url: "/timelinenew/page-acct?ngsw-bypass=true&before=0&after=0",
    operation: "timeline_posts",
    template: "/timelinenew/:accountId",
    check: null,
  }),
  sent("posts.tips", { targetIds: ["p-1", "p-2"] }, {
    url: "/tips?ngsw-bypass=true&targetIds=p-1%2Cp-2",
    operation: "post_tips",
    template: "/tips",
    check: null,
  }),
  sent("posts.by_ids", { ids: ["p-1", "p-2"] }, {
    url: "/post?ngsw-bypass=true&ids=p-1%2Cp-2",
    operation: "post_lookup",
    template: "/post",
    check: null,
  }),
  sent("post.replies", { postId: "p-1", before: null }, {
    label: " (bare)",
    url: "/post/p-1/replies?ngsw-bypass=true",
    operation: "post_replies",
    template: "/post/{postId}/replies",
    check: null,
  }),
  sent("post.replies", { postId: "p-1", before: "r-20" }, {
    label: " (before)",
    url: "/post/p-1/replies?ngsw-bypass=true&before=r-20",
    operation: "post_replies",
    template: "/post/{postId}/replies",
    check: null,
  }),
  sent("vault.albums", {}, {
    url: "/vault/albumsnew?ngsw-bypass=true",
    operation: "vault_albums",
    template: "/vault/albumsnew",
    check: null,
  }),
  sent("uservault.albums", { accountId: "page-acct" }, {
    url: "/uservault/albumsnew?ngsw-bypass=true&accountId=page-acct",
    operation: "uservault_albums",
    template: "/uservault/albumsnew",
    check: null,
  }),
  sent("subscriptions.tiers", {}, {
    url: "/subscriptions/tiers?ngsw-bypass=true",
    operation: "subscription_tiers",
    template: "/subscriptions/tiers",
    check: null,
  }),
  sent("subscriptions.giftcodes", {}, {
    url: "/subscriptions/giftcodes?ngsw-bypass=true",
    operation: "gift_codes",
    template: "/subscriptions/giftcodes",
    check: null,
  }),
  sent("message.automated", {}, {
    url: "/message/automated?ngsw-bypass=true",
    operation: "automated_messages",
    template: "/message/automated",
    check: "message",
  }),
  sent("account.walls", {}, {
    url: "/account/walls?ngsw-bypass=true&correlationPostIds=",
    operation: "account_walls_probe",
    template: "/account/walls",
    check: null,
  }),
  sent("vault.media", { albumId: "al-1", before: "0" }, {
    label: " (head)",
    url: "/media/vaultnew?ngsw-bypass=true&albumId=al-1&mediaType=&search=&before=0&after=0",
    operation: "vault_media",
    template: "/media/vaultnew",
    check: null,
  }),
  sent("vault.media", { albumId: "al-1", before: "am-77" }, {
    label: " (before)",
    url: "/media/vaultnew?ngsw-bypass=true&albumId=al-1&mediaType=&search=&before=am-77&after=0",
    operation: "vault_media",
    template: "/media/vaultnew",
    check: null,
  }),
  sent("account.media_by_ids", { ids: ["m-1", "m-2"] }, {
    url: "/account/media?ngsw-bypass=true&ids=m-1%2Cm-2",
    operation: "account_media_by_ids_probe",
    template: "/account/media",
    check: null,
  }),
  sent("account.bundles_by_ids", { ids: ["b-1"] }, {
    url: "/account/media/bundle?ngsw-bypass=true&ids=b-1",
    operation: "account_media_bundles_by_ids_probe",
    template: "/account/media/bundle",
    check: null,
  }),
  sent("media.offer_stats", { mediaOfferId: "mo-1", beforeMs: BEFORE, afterMs: AFTER, periodMs: 86_400_000 }, {
    url: "/it/moie/statsnew?ngsw-bypass=true&mediaOfferId=mo-1&beforeDate=1788825600000&afterDate=1788220800000&period=86400000",
    operation: "media_offer_stats",
    template: "/it/moie/statsnew",
    check: null,
  }),
  sent("account.stats", { beforeMs: BEFORE, afterMs: AFTER, periodMs: 3_600_000 }, {
    label: " (bounds)",
    url: "/it/amoie/stats?ngsw-bypass=true&beforeDate=1788825600000&afterDate=1788220800000&period=3600000&year=0&month=0",
    operation: "account_stats",
    template: "/it/amoie/stats",
    check: null,
  }),
  sent("account.stats", { beforeMs: BEFORE, afterMs: AFTER, periodMs: 86_400_000, year: 2026, month: 7 }, {
    label: " (named month)",
    url: "/it/amoie/stats?ngsw-bypass=true&beforeDate=1788825600000&afterDate=1788220800000&period=86400000&year=2026&month=7",
    operation: "account_stats",
    template: "/it/amoie/stats",
    check: null,
  }),
  sent("earnings.stats_window", { beforeMs: BEFORE, afterMs: AFTER, limit: 100 }, {
    url: "/account/wallets/earnings/stats?ngsw-bypass=true&before=1788825600000&after=1788220800000&limit=100",
    operation: "earnings_stats_window",
    template: "/account/wallets/earnings/stats",
    check: "earnings",
  }),
  sent("earnings.monthly", { beforeMs: BEFORE, afterMs: Date.UTC(2015, 0, 1) }, {
    url: "/account/wallets/earnings/monthlystats?ngsw-bypass=true&before=1788825600000&after=1420070400000",
    operation: "earnings_monthly_stats",
    template: "/account/wallets/earnings/monthlystats",
    check: "earnings",
  }),
  sent("trackinglinks", {}, {
    url: "/trackinglinks?ngsw-bypass=true",
    operation: "tracking_links",
    template: "/trackinglinks",
    check: null,
  }),
  sent("discovery.suggestions", { limit: 10, offset: 10 }, {
    url: "/contentdiscovery/media/suggestionsnew?ngsw-bypass=true&before=0&after=0&tagIds=&limit=10&offset=10",
    operation: "discovery_media_suggestions",
    template: "/contentdiscovery/media/suggestionsnew",
    check: null,
  }),
  sent("broadcast.stats", { before: null }, {
    url: "/message/broadcast/stats?ngsw-bypass=true",
    operation: "broadcast_stats_probe",
    template: "/message/broadcast/stats",
    check: "message",
  }),
  sent("broadcast.stats_deleted", { before: "bc-3" }, {
    url: "/message/broadcast/stats/deleted?ngsw-bypass=true&before=bc-3",
    operation: "broadcast_stats_deleted_probe",
    template: "/message/broadcast/stats/deleted",
    check: "message",
  }),
  sent("broadcast.scheduled", {}, {
    url: "/message/broadcast/scheduled?ngsw-bypass=true",
    operation: "broadcast_scheduled_probe",
    template: "/message/broadcast/scheduled",
    check: "message",
  }),
  sent("polls", {}, {
    url: "/polls?ngsw-bypass=true",
    operation: "polls_probe",
    template: "/polls",
    check: null,
  }),
  sent("recapstats", {}, {
    url: "/recapstats?ngsw-bypass=true",
    operation: "recapstats_probe",
    template: "/recapstats",
    check: null,
  }),
];

function expectedHeaders(check: FanslyClientCheckRoute | null): Array<readonly [string, string]> {
  return [
    ...HEADERS_BEFORE_CHECK,
    ...(check === null ? [] : [["fansly-client-check", SESSION.routeChecks[check]] as const]),
    ...HEADERS_AFTER_CHECK,
  ];
}

const cases = FROZEN.map((entry) => [entry.label, entry] as const);

describe("Fansly wire specs against the requests the legacy adapter sent", () => {
  it("cover every API route; the socket's Upgrade and a CDN hop never had an adapter twin", () => {
    expect(new Set(FROZEN.map((entry) => entry.id))).toEqual(new Set(FANSLY_WIRE_IDS.filter((id) => isFanslyApiWireId(id))));
    expect(FROZEN).toHaveLength(46);
  });

  it.each(cases)("%s sends the adapter's exact URL", (_label, entry) => {
    expect(entry.built.url).toBe(`${BASE_URL}${entry.url}`);
  });

  it.each(cases)("%s sends the adapter's headers, in its order", (_label, entry) => {
    const built = Object.entries(entry.built.headers).map(([name, value]) =>
      [name, name === "fansly-client-ts" ? "<send time>" : value] as const);
    expect(built).toEqual(expectedHeaders(entry.check));
    expect(entry.built.headers["fansly-client-ts"]).toMatch(/^\d{13}$/);
  });

  it.each(cases)("%s is journaled under the adapter's operation and endpoint template", (_label, entry) => {
    const spec = fanslyWireSpec(entry.id);
    expect(spec.legacyOperation).toBe(entry.operation);
    expect(spec.endpointTemplate).toBe(entry.template);
  });
});
