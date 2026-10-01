import { readFileSync } from "node:fs";
import path from "node:path";

import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";


import {
  captureEvents,
  cleanupAdapterHarness,
  loadAdapters,
  toJsonResponse,
} from "./helpers/adapter-harness.ts";
import { createTestFanslySendGuard } from "./helpers/fansly-send-guard.ts";

// ONE harness for the whole file. `loadAdapters` resets the module registry and
// re-spies `undici.fetch`; calling it per test leaves the adapter bound to a
// module instance the new spy no longer covers, and the calls escape to the
// real network. Every other adapter suite in this tree has exactly one `it` for
// the same reason — this file keeps its cases separate and shares the harness.
let harness: Awaited<ReturnType<typeof loadAdapters>>;

beforeAll(async () => {
  harness = await loadAdapters();
  // No wall clock in a unit test: a 5xx without Retry-After would otherwise
  // sleep the real 2.5-5s exponential backoff before its retry. No case here
  // asserts the delay (the ladder is pinned in tests/http-client.test.ts), so
  // only the fallback is zeroed; an explicit Retry-After keeps its meaning.
  // Spied on the module from the same registry `loadAdapters` just built;
  // `cleanupAdapterHarness` restores it.
  const httpClient = await import("../packages/shared/src/http-client.ts");
  vi.spyOn(httpClient, "resolveRetryDelayMs").mockImplementation(
    (retryAfterHeader, _attemptNumber, now) =>
      httpClient.parseRetryAfterDelayMs(retryAfterHeader, now) ?? 0,
  );
});

beforeEach(() => {
  harness.fetchMock.mockReset();
});

afterAll(() => {
  cleanupAdapterHarness();
});

const SESSION = {
  authorization: "token-abc",
  fanslyClientId: "client-1",
  fanslyClientCheck: "check-1",
  fanslySessionId: "session-1",
  routeChecks: {
    earnings: "check-earnings",
    message: "check-message",
  },
};

function context(overrides: Record<string, unknown> = {}) {
  return {
    sendGuard: createTestFanslySendGuard(),
    session: SESSION,
    // FANSLY PAGES MUST GO THROUGH THEIR OWN PROXY. A direct-IP request to
    // Fansly risks a model ban, which is why the dispatcher assertion below is
    // not a formality.
    proxy: { url: "socks5://proxy.example:1080" },
    rateLimitWaiter: vi.fn(async () => 0),
    ...overrides,
  };
}

describe("WP-F1 adapter methods", () => {
  it("builds the exact method, path and query for every stats-lane call", async () => {
    const { FanslyAdapter, fetchMock, proxyDispatchers } = harness;
    for (let index = 0; index < 6; index += 1) {
      fetchMock.mockResolvedValueOnce(toJsonResponse({ success: true, response: [] }));
    }
    const adapter = new FanslyAdapter({ baseUrl: "https://fansly.example" });
    const beforeDate = new Date("2026-08-19T00:00:00.000Z");
    const afterDate = new Date("2026-07-20T00:00:00.000Z");

    await adapter.getAccountStats(context(), { beforeDate, afterDate, periodMs: 86_400_000 });
    await adapter.getMediaOfferStats(context(), {
      mediaOfferId: "media-offer-1",
      beforeDate,
      afterDate,
      periodMs: 3_600_000,
    });
    await adapter.getEarningsStatsWindow(context(), {
      before: beforeDate,
      after: afterDate,
      limit: 100,
      offset: 200,
    });
    await adapter.getEarningsMonthlyStats(context(), { before: beforeDate, after: afterDate });
    // Optional params omitted entirely — the all-time form.
    await adapter.getEarningsMonthlyStats(context());
    await adapter.getDiscoveryMediaSuggestions(context(), { limit: 10, offset: 0 });
    await adapter.close();

    const methods = fetchMock.mock.calls.map(([, init]) => (init as RequestInit).method);
    // READ-ONLY, ALWAYS. There is no POST to the platform anywhere in this
    // initiative — not even the `/postreply/verify` the browser sends.
    expect(new Set(methods)).toEqual(new Set(["GET"]));

    const urls = fetchMock.mock.calls.map(([input]) => new URL(String(input)));

    expect(urls[0]?.pathname).toBe("/it/amoie/stats");
    expect(urls[0]?.searchParams.get("beforeDate")).toBe(String(beforeDate.getTime()));
    expect(urls[0]?.searchParams.get("afterDate")).toBe(String(afterDate.getTime()));
    expect(urls[0]?.searchParams.get("period")).toBe("86400000");
    // year/month 0/0 is the "read the explicit bounds" form — the one the daily
    // and hourly TRAILING sweeps send. The named-month form is pinned below,
    // because the bounds are honoured only inside the trailing window and every
    // window older than it is asked for by month.
    expect(urls[0]?.searchParams.get("year")).toBe("0");
    expect(urls[0]?.searchParams.get("month")).toBe("0");
    // Every URL carries the service-worker bypass the adapter appends.
    expect(urls[0]?.searchParams.get("ngsw-bypass")).toBe("true");

    expect(urls[1]?.pathname).toBe("/it/moie/statsnew");
    expect(urls[1]?.searchParams.get("mediaOfferId")).toBe("media-offer-1");
    expect(urls[1]?.searchParams.get("period")).toBe("3600000");
    expect(urls[1]?.searchParams.has("year")).toBe(false);

    expect(urls[2]?.pathname).toBe("/account/wallets/earnings/stats");
    expect(urls[2]?.searchParams.get("limit")).toBe("100");
    expect(urls[2]?.searchParams.get("offset")).toBe("200");

    expect(urls[3]?.pathname).toBe("/account/wallets/earnings/monthlystats");
    expect(urls[3]?.searchParams.get("before")).toBe(String(beforeDate.getTime()));
    expect(urls[4]?.pathname).toBe("/account/wallets/earnings/monthlystats");
    expect(urls[4]?.searchParams.has("before")).toBe(false);
    expect(urls[4]?.searchParams.has("after")).toBe(false);

    expect(urls[5]?.pathname).toBe("/contentdiscovery/media/suggestionsnew");
    expect(urls[5]?.searchParams.get("before")).toBe("0");
    expect(urls[5]?.searchParams.get("after")).toBe("0");
    expect(urls[5]?.searchParams.get("tagIds")).toBe("");
    expect(urls[5]?.searchParams.get("limit")).toBe("10");

    const headers = fetchMock.mock.calls.map(
      ([, init]) => (init as RequestInit).headers as Record<string, string>,
    );
    for (const header of headers) {
      expect(header.authorization).toBe("token-abc");
      expect(header["fansly-session-id"]).toBe("session-1");
    }
    expect(headers.map((header) => header["fansly-client-check"])).toEqual([
      undefined,
      undefined,
      "check-earnings",
      "check-earnings",
      "check-earnings",
      undefined,
    ]);
    // One proxy dispatcher, and every call used it.
    expect(proxyDispatchers).toHaveLength(1);
    for (const [, init] of fetchMock.mock.calls) {
      expect((init as { dispatcher?: unknown }).dispatcher).toBe(proxyDispatchers[0]);
    }
  });

  it("sends the app's OWN month form when a year and month are named", async () => {
    // PRODUCTION 2026-08-22 (lora-2): `afterDate 2026-06-21 / beforeDate
    // 2026-07-22` — 31 days, historical — was answered with `dateAfter
    // 2026-07-21 / dateBefore 2026-08-21`, the trailing 31 days, 200 and all;
    // halving the span to 15 changed nothing. The date bounds only work INSIDE
    // the trailing window. The app's past-month view sends `year`/`month` and
    // lets the server resolve the month, with the trailing bounds riding along
    // unchanged (bundle main.pretty.js :280600, :196337) — so this is the exact
    // request, not an invented one.
    const { FanslyAdapter, fetchMock } = harness;
    fetchMock.mockResolvedValueOnce(toJsonResponse({ success: true, response: {} }));
    const adapter = new FanslyAdapter({ baseUrl: "https://fansly.example" });
    const beforeDate = new Date("2026-08-22T09:00:00.000Z");
    const afterDate = new Date("2026-07-23T09:00:00.000Z");
    await adapter.getAccountStats(context(), {
      beforeDate,
      afterDate,
      periodMs: 86_400_000,
      year: 2026,
      month: 6,
    });
    await adapter.close();

    const url = new URL(String(fetchMock.mock.calls[0]?.[0]));
    expect(url.pathname).toBe("/it/amoie/stats");
    expect(url.searchParams.get("year")).toBe("2026");
    expect(url.searchParams.get("month")).toBe("6");
    // THE BOUNDS STILL RIDE ALONG. The app sends them with every month preset;
    // dropping them here would be a request the client never makes.
    expect(url.searchParams.get("beforeDate")).toBe(String(beforeDate.getTime()));
    expect(url.searchParams.get("afterDate")).toBe(String(afterDate.getTime()));
    expect(url.searchParams.get("period")).toBe("86400000");
  });

  it("returns the envelope's response verbatim, additive fields included", async () => {
    const { FanslyAdapter, fetchMock } = harness;
    const body = {
      dataset: { period: 86_400_000, datapoints: [], profileDatapoints: [] },
      aggregationData: { tags: [] },
      // A field no parser knows. The adapter is a transport: it hands the whole
      // response through so `persistRawPayload` can journal it verbatim, and a
      // shape assertion here would refuse bytes DP 7 requires us to keep.
      someFutureKey: { nested: true },
    };
    fetchMock.mockResolvedValueOnce(toJsonResponse({ success: true, response: body }));
    const adapter = new FanslyAdapter({ baseUrl: "https://fansly.example" });
    const result = await adapter.getAccountStats(context(), {
      beforeDate: new Date(),
      afterDate: new Date(),
      periodMs: 86_400_000,
    });
    await adapter.close();
    expect(result.raw).toEqual(body);
    expect(result.items).toEqual(body);
  });

  it("treats 401/403 as terminal — no retry, and a typed failure", async () => {
    const { FanslyAdapter, fetchMock } = harness;
    fetchMock.mockResolvedValue(
      toJsonResponse({ success: false, error: { code: 401, message: "unauthorized" } }, {
        status: 401,
      }),
    );
    const adapter = new FanslyAdapter({ baseUrl: "https://fansly.example" });
    const { events, requestObserver } = captureEvents();
    // The envelope's own message wins when the platform sends one; the STATUS
    // is what makes the failure terminal, so that is what is pinned.
    const failure = await adapter.getAccountStats(context({ requestObserver }), {
      beforeDate: new Date(),
      afterDate: new Date(),
      periodMs: 86_400_000,
    }).then(() => null, (error: unknown) => error as { status?: number; message?: string });
    expect(failure?.status).toBe(401);
    expect(failure?.message).toBe("unauthorized");
    await adapter.close();
    // Terminal means ONE attempt: an auth-dead session that retried three times
    // would triple the egress that is already failing.
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const started = events.filter((event) => event.state === "started");
    expect(started).toHaveLength(1);
  });

  it("counts every ATTEMPT, including retries, on the observer the cap reads", async () => {
    const { FanslyAdapter, fetchMock } = harness;
    fetchMock
      .mockResolvedValueOnce(toJsonResponse({ success: false }, { status: 500 }))
      .mockResolvedValueOnce(toJsonResponse({ success: true, response: [] }));
    const adapter = new FanslyAdapter({ baseUrl: "https://fansly.example" });
    const { events, requestObserver } = captureEvents();
    await adapter.getTrackingLinks(context({ requestObserver }));
    await adapter.close();
    // The per-lane daily cap is counted in attempts precisely because a retry
    // storm on a logical-call cap would multiply real egress.
    expect(events.filter((event) => event.state === "started")).toHaveLength(2);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("does not start a retry beyond the lane's remaining durable allowance", async () => {
    const { FanslyAdapter, fetchMock } = harness;
    fetchMock
      .mockResolvedValueOnce(toJsonResponse({ success: false }, { status: 500 }))
      .mockResolvedValueOnce(toJsonResponse({ success: false }, { status: 500 }))
      .mockResolvedValueOnce(toJsonResponse({ success: true, response: [] }));
    const adapter = new FanslyAdapter({ baseUrl: "https://fansly.example" });
    const { events, requestObserver } = captureEvents();

    await expect(adapter.getTrackingLinks(context({
      requestObserver,
      remainingAttempts: () => 2,
    }))).rejects.toMatchObject({ status: 500 });
    await adapter.close();

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(events.filter((event) => event.state === "started")).toHaveLength(2);
  });

  it("keeps the tracking-links route wired and contract-checked", async () => {
    const { FanslyAdapter, fetchMock } = harness;
    fetchMock.mockResolvedValueOnce(toJsonResponse({
      success: true,
      response: [{ id: "link-1", totalGross: 1000, totalNet: 0 }],
    }));
    const adapter = new FanslyAdapter({ baseUrl: "https://fansly.example" });
    const result = await adapter.getTrackingLinks(context());
    await adapter.close();
    expect(new URL(String(fetchMock.mock.calls[0]![0])).pathname).toBe("/trackinglinks");
    expect(result.items).toHaveLength(1);
    // 0 is what the platform served on every observed link. The adapter passes
    // it through UNCHANGED; deciding it means "unpopulated" is the parser's job
    // and is asserted there.
    expect((result.items as Array<Record<string, unknown>>)[0]!.totalNet).toBe(0);
  });

  it("sends the broadcast/poll/recap extras unchanged from the probe wiring", async () => {
    const { FanslyAdapter, fetchMock } = harness;
    for (let index = 0; index < 5; index += 1) {
      fetchMock.mockResolvedValueOnce(toJsonResponse({ success: true, response: [] }));
    }
    const adapter = new FanslyAdapter({ baseUrl: "https://fansly.example" });
    await adapter.getBroadcastStatsPage(context(), { before: null, limit: null, deleted: false });
    await adapter.getBroadcastStatsPage(context(), {
      before: "970000000000000001",
      limit: null,
      deleted: true,
    });
    await adapter.getBroadcastScheduled(context());
    await adapter.getPolls(context());
    await adapter.getRecapStats(context());
    await adapter.close();
    const urls = fetchMock.mock.calls.map(([input]) => new URL(String(input)));
    expect(urls.map((url) => url.pathname)).toEqual([
      "/message/broadcast/stats",
      "/message/broadcast/stats/deleted",
      "/message/broadcast/scheduled",
      "/polls",
      "/recapstats",
    ]);
    expect(urls[0]?.searchParams.has("before")).toBe(false);
    expect(urls[1]?.searchParams.get("before")).toBe("970000000000000001");
  });
});

describe("WP-F2 adapter method: /notifications", () => {
  it("sends `before` as an ID cursor, and omits `type` on the unfiltered form", async () => {
    const { FanslyAdapter, fetchMock, proxyDispatchers } = harness;
    for (let index = 0; index < 3; index += 1) {
      fetchMock.mockResolvedValueOnce(toJsonResponse({
        success: true,
        response: { notifications: [] },
      }));
    }
    const adapter = new FanslyAdapter({ baseUrl: "https://fansly.example" });
    // The head.
    await adapter.getNotificationsPage(context(), {});
    // A page older than a specific notification. THE CURSOR IS A NOTIFICATION
    // ID, NOT A TIMESTAMP — read as an epoch it would ask for 1970 and get an
    // empty page that looks exactly like a retention floor.
    await adapter.getNotificationsPage(context(), { before: "945239851786067977" });
    // The declared-CSV fallback form.
    await adapter.getNotificationsPage(context(), {
      before: "0",
      types: [24001, 1002, 32007, 45012],
    });
    await adapter.close();

    const methods = fetchMock.mock.calls.map(([, init]) => (init as RequestInit).method);
    // READ-ONLY, ALWAYS. There is no POST to Fansly anywhere in this initiative.
    expect(new Set(methods)).toEqual(new Set(["GET"]));

    const urls = fetchMock.mock.calls.map(([input]) => new URL(String(input)));
    for (const url of urls) {
      expect(url.pathname).toBe("/notifications");
      expect(url.searchParams.get("after")).toBe("0");
      expect(url.searchParams.get("ngsw-bypass")).toBe("true");
    }
    expect(urls[0]?.searchParams.get("before")).toBe("0");
    // A1: the FIRST call carries no `type` at all. An empty `type=` would be a
    // filter for nothing, not the absence of a filter — and a filtered call can
    // only ever return codes we already knew to ask for.
    expect(urls[0]?.searchParams.has("type")).toBe(false);
    expect(urls[1]?.searchParams.get("before")).toBe("945239851786067977");
    expect(urls[1]?.searchParams.has("type")).toBe(false);
    expect(urls[2]?.searchParams.get("type")).toBe("24001,1002,32007,45012");

    // This route is absent from the extension's captured route map, so the
    // legacy global check must not be replayed as if it belonged here.
    const headers = fetchMock.mock.calls.map(
      ([, init]) => (init as RequestInit).headers as Record<string, string>,
    );
    for (const header of headers) {
      expect(header.authorization).toBe("token-abc");
      expect(header).not.toHaveProperty("fansly-client-check");
    }
    // FANSLY PAGES MUST GO THROUGH THEIR OWN PROXY: a direct-IP request risks a
    // model ban, which is why this assertion is not a formality. (The harness
    // is shared across this file, so the dispatcher LIST accumulates — what is
    // pinned is that all three calls rode one proxy dispatcher and none rode
    // the default one.)
    const dispatchers = new Set(
      fetchMock.mock.calls.map(([, init]) => (init as { dispatcher?: unknown }).dispatcher),
    );
    expect(dispatchers.size).toBe(1);
    expect(dispatchers.has(undefined)).toBe(false);
    expect(proxyDispatchers).toContain([...dispatchers][0]);
  });

  it("returns the envelope's response verbatim, sidecars and unknown keys included", async () => {
    const { FanslyAdapter, fetchMock } = harness;
    const body = {
      notifications: [{ id: "1", type: 99999, metadata: "{}" }],
      tips: [],
      accountMedia: [],
      accountMediaBundles: [],
      subscriptions: [],
      subscriptionHistory: [],
      accounts: [{ id: "2", lastSeenAt: 17 }],
      // The adapter is a TRANSPORT: it hands the whole response through so the
      // handler can journal it. The [A20] allowlist runs at the journaling
      // site, not here.
      someFutureKey: { nested: true },
    };
    fetchMock.mockResolvedValueOnce(toJsonResponse({ success: true, response: body }));
    const adapter = new FanslyAdapter({ baseUrl: "https://fansly.example" });
    const result = await adapter.getNotificationsPage(context(), { before: "0" });
    await adapter.close();
    expect(result.raw).toEqual(body);
  });

  it("treats 401/403 as terminal — one attempt, a typed failure, no type fork", async () => {
    const { FanslyAdapter, fetchMock } = harness;
    fetchMock.mockResolvedValue(
      toJsonResponse({ success: false, error: { code: 403, message: "forbidden" } }, {
        status: 403,
      }),
    );
    const adapter = new FanslyAdapter({ baseUrl: "https://fansly.example" });
    const { events, requestObserver } = captureEvents();
    const failure = await adapter.getNotificationsPage(context({ requestObserver }), {})
      .then(() => null, (error: unknown) => error as { status?: number });
    await adapter.close();
    expect(failure?.status).toBe(403);
    // A dead session that retried three times would triple egress that is
    // already failing — and it must reach the executor's auth pause unchanged,
    // never the handler's widen-the-filter path.
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(events.filter((event) => event.state === "started")).toHaveLength(1);
  });

  it("surfaces a 4xx refusal as a typed error the handler can fork on", async () => {
    const { FanslyAdapter, fetchMock } = harness;
    fetchMock.mockResolvedValue(
      toJsonResponse({ success: false, error: { code: 400, message: "bad type" } }, {
        status: 400,
      }),
    );
    const adapter = new FanslyAdapter({ baseUrl: "https://fansly.example" });
    const failure = await adapter.getNotificationsPage(context(), {})
      .then(() => null, (error: unknown) => error as { status?: number });
    await adapter.close();
    // 400 is NOT retried (only 429/5xx are), so the fork costs one attempt.
    expect(failure?.status).toBe(400);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

describe("WP-F3 adapter methods", () => {
  it("builds the exact method, path and query for every catalog-lane call", async () => {
    const { FanslyAdapter, fetchMock, proxyDispatchers } = harness;
    for (let index = 0; index < 9; index += 1) {
      fetchMock.mockResolvedValueOnce(toJsonResponse({ success: true, response: [] }));
    }
    const adapter = new FanslyAdapter({ baseUrl: "https://fansly.example" });

    await adapter.getVaultAlbums(context());
    await adapter.getUserVaultAlbums(context(), { accountId: "account-1" });
    await adapter.getSubscriptionTiers(context());
    await adapter.getGiftCodes(context());
    await adapter.getAutomatedMessages(context());
    await adapter.getAccountWalls(context(), { correlationPostIds: "" });
    // THE FIRST PAGE of an album walk, in the app's own form.
    await adapter.getVaultMediaPage(context(), {
      albumId: "album-1",
      mediaType: "",
      search: "",
      before: "0",
      after: "0",
    });
    // THE SECOND PAGE: `before` carries the last albumMedia row's id.
    await adapter.getVaultMediaPage(context(), {
      albumId: "album-1",
      mediaType: "",
      search: "",
      before: "member-99",
      after: "0",
    });
    await adapter.getAccountMediaByIds(context(), { ids: "a,b,c" });
    await adapter.close();

    const methods = fetchMock.mock.calls.map(([, init]) => (init as RequestInit).method);
    // READ-ONLY, ALWAYS. There is no POST to the platform in this lane.
    expect(new Set(methods)).toEqual(new Set(["GET"]));

    const urls = fetchMock.mock.calls.map(([input]) => new URL(String(input)));

    expect(urls[0]?.pathname).toBe("/vault/albumsnew");
    expect(urls[1]?.pathname).toBe("/uservault/albumsnew");
    expect(urls[1]?.searchParams.get("accountId")).toBe("account-1");
    expect(urls[2]?.pathname).toBe("/subscriptions/tiers");
    expect(urls[3]?.pathname).toBe("/subscriptions/giftcodes");
    expect(urls[4]?.pathname).toBe("/message/automated");
    expect(urls[5]?.pathname).toBe("/account/walls");
    // Present and EMPTY, exactly as the app sends the bare form.
    expect(urls[5]?.searchParams.get("correlationPostIds")).toBe("");

    // ── THE `/media/vaultnew` FORM, and it is the load-bearing assertion in
    // this file. The 2026-08-22 probe sent `before=&after=` for a 4 760-item
    // album and got `{albumMedia: [], media: []}` — an empty page that looks
    // exactly like an exhausted album. The app sends the LITERAL "0".
    expect(urls[6]?.pathname).toBe("/media/vaultnew");
    expect(urls[6]?.searchParams.get("albumId")).toBe("album-1");
    expect(urls[6]?.searchParams.get("before")).toBe("0");
    expect(urls[6]?.searchParams.get("after")).toBe("0");
    // Present and EMPTY when unfiltered — the app's own getMediaTypeFilter()
    // returns "" when neither images nor video are hidden. Omitting the key is
    // a different request.
    expect(urls[6]?.searchParams.has("mediaType")).toBe(true);
    expect(urls[6]?.searchParams.get("mediaType")).toBe("");
    expect(urls[6]?.searchParams.get("search")).toBe("");
    // PAGINATION: `before` is the last albumMedia row's own id.
    expect(urls[7]?.searchParams.get("before")).toBe("member-99");
    expect(urls[7]?.searchParams.get("after")).toBe("0");

    expect(urls[8]?.pathname).toBe("/account/media");
    expect(urls[8]?.searchParams.get("ids")).toBe("a,b,c");

    for (const url of urls) {
      // Every URL carries the service-worker bypass the adapter appends.
      expect(url.searchParams.get("ngsw-bypass")).toBe("true");
    }

    const headers = fetchMock.mock.calls.map(
      ([, init]) => (init as RequestInit).headers as Record<string, string>,
    );
    for (const header of headers) {
      expect(header.authorization).toBe("token-abc");
      expect(header["fansly-session-id"]).toBe("session-1");
    }
    expect(headers.map((header) => header["fansly-client-check"])).toEqual([
      undefined,
      undefined,
      undefined,
      undefined,
      "check-message",
      undefined,
      undefined,
      undefined,
      undefined,
    ]);
    // FANSLY PAGES MUST GO THROUGH THEIR OWN PROXY — a direct-IP request risks
    // a model ban. (The harness is shared, so the dispatcher LIST accumulates;
    // what is pinned is that these calls rode ONE proxy dispatcher and none
    // rode the default.)
    const dispatchers = new Set(
      fetchMock.mock.calls.map(([, init]) => (init as { dispatcher?: unknown }).dispatcher),
    );
    expect(dispatchers.size).toBe(1);
    expect(dispatchers.has(undefined)).toBe(false);
    expect(proxyDispatchers).toContain([...dispatchers][0]);
  });

  it("sends the by-TYPE vault form without the album-only keys", async () => {
    const { FanslyAdapter, fetchMock } = harness;
    fetchMock.mockResolvedValueOnce(toJsonResponse({ success: true, response: {} }));
    const adapter = new FanslyAdapter({ baseUrl: "https://fansly.example" });
    // The app's second variant: `?type=<vaultType>&before&after`. Kept because
    // the app has it; the catalog walk does not use it.
    await adapter.getVaultMediaPage(context(), { type: 1000 });
    await adapter.close();
    const url = new URL(String(fetchMock.mock.calls[0]?.[0]));
    expect(url.searchParams.get("type")).toBe("1000");
    expect(url.searchParams.has("albumId")).toBe(false);
    expect(url.searchParams.has("mediaType")).toBe(false);
    expect(url.searchParams.get("before")).toBe("0");
  });

  it("batches ids for the bundle route the same way", async () => {
    const { FanslyAdapter, fetchMock } = harness;
    fetchMock.mockResolvedValueOnce(toJsonResponse({ success: true, response: [] }));
    const adapter = new FanslyAdapter({ baseUrl: "https://fansly.example" });
    await adapter.getAccountMediaBundlesByIds(context(), { ids: "b1,b2" });
    await adapter.close();
    const url = new URL(String(fetchMock.mock.calls[0]?.[0]));
    expect(url.pathname).toBe("/account/media/bundle");
    expect(url.searchParams.get("ids")).toBe("b1,b2");
  });

  it("returns the envelope's response verbatim, signed locations and all", async () => {
    const { FanslyAdapter, fetchMock } = harness;
    const body = {
      albums: [{ id: "1", title: null, type: 38000 }],
      aggregationData: {
        // The adapter is a TRANSPORT. It hands the raw media sidecar through —
        // signed locations included — so `persistRawPayload` can journal it
        // verbatim (DP 7). Nothing downstream reads these keys.
        media: [{ id: "2", location: "https://cdn.example/signed", variants: [] }],
      },
      someFutureKey: { nested: true },
    };
    fetchMock.mockResolvedValueOnce(toJsonResponse({ success: true, response: body }));
    const adapter = new FanslyAdapter({ baseUrl: "https://fansly.example" });
    const result = await adapter.getVaultAlbums(context());
    await adapter.close();
    expect(result.raw).toEqual(body);
  });

  it("treats 401/403 as terminal on a catalog call — one attempt, typed failure", async () => {
    const { FanslyAdapter, fetchMock } = harness;
    fetchMock.mockResolvedValue(
      toJsonResponse({ success: false, error: { code: 401, message: "unauthorized" } }, {
        status: 401,
      }),
    );
    const adapter = new FanslyAdapter({ baseUrl: "https://fansly.example" });
    const { events, requestObserver } = captureEvents();
    const failure = await adapter.getSubscriptionTiers(context({ requestObserver }))
      .then(() => null, (error: unknown) => error as { status?: number });
    await adapter.close();
    expect(failure?.status).toBe(401);
    // A dead session that retried three times would triple egress that is
    // already failing, and it must reach the executor's auth pause unchanged.
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(events.filter((event) => event.state === "started")).toHaveLength(1);
  });

  it("surfaces a 4xx on the vault walk as a typed error, unretried", async () => {
    const { FanslyAdapter, fetchMock } = harness;
    fetchMock.mockResolvedValue(
      toJsonResponse({ success: false, error: { code: 400, message: "bad album" } }, {
        status: 400,
      }),
    );
    const adapter = new FanslyAdapter({ baseUrl: "https://fansly.example" });
    const failure = await adapter.getVaultMediaPage(context(), { albumId: "album-1" })
      .then(() => null, (error: unknown) => error as { status?: number });
    await adapter.close();
    expect(failure?.status).toBe(400);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

describe("WP-F5 adapter method: /post/{postId}/replies", () => {
  it("issues the BARE GET on the first call — path, no query, proxy, bypass", async () => {
    const { FanslyAdapter, fetchMock, proxyDispatchers } = harness;
    fetchMock.mockResolvedValueOnce(toJsonResponse({
      success: true,
      response: { posts: [], accounts: [], tips: [], tipGoals: [], stories: [], polls: [] },
    }));
    const adapter = new FanslyAdapter({ baseUrl: "https://fansly.example" });
    await adapter.getPostRepliesPage(context(), { postId: "942662601546936320" });
    await adapter.close();

    const [input, init] = fetchMock.mock.calls[0] ?? [];
    // GET. [E1] proved the bare GET works, so the browser's preceding
    // `POST /postreply/verify` is never issued — §1 excludes write-shaped calls
    // to the platform.
    expect((init as RequestInit).method).toBe("GET");
    const url = new URL(String(input));
    expect(url.pathname).toBe("/post/942662601546936320/replies");
    // NO `before` on the first call. The bare form is the only one five live
    // responses prove; a cursor is sent only once a page looks suspiciously
    // full.
    expect(url.searchParams.has("before")).toBe(false);
    expect(url.searchParams.get("ngsw-bypass")).toBe("true");
    // FANSLY PAGES MUST GO THROUGH THEIR OWN PROXY — a direct-IP request risks
    // a model ban.
    expect(proxyDispatchers.length).toBeGreaterThan(0);
    expect((init as { dispatcher?: { label?: string } }).dispatcher?.label)
      .toMatch(/^proxy-/);
  });

  it("sends `before=<last reply id>` when the caller has a reason to page", async () => {
    const { FanslyAdapter, fetchMock } = harness;
    fetchMock.mockResolvedValueOnce(toJsonResponse({ success: true, response: { posts: [] } }));
    const adapter = new FanslyAdapter({ baseUrl: "https://fansly.example" });
    await adapter.getPostRepliesPage(context(), {
      postId: "942662601546936320",
      before: "939669652286492672",
    });
    await adapter.close();
    const url = new URL(String(fetchMock.mock.calls[0]?.[0]));
    expect(url.pathname).toBe("/post/942662601546936320/replies");
    expect(url.searchParams.get("before")).toBe("939669652286492672");
  });

  it("percent-encodes the post id into the PATH rather than a query", async () => {
    const { FanslyAdapter, fetchMock } = harness;
    fetchMock.mockResolvedValueOnce(toJsonResponse({ success: true, response: { posts: [] } }));
    const adapter = new FanslyAdapter({ baseUrl: "https://fansly.example" });
    await adapter.getPostRepliesPage(context(), { postId: "a/b" });
    await adapter.close();
    const url = new URL(String(fetchMock.mock.calls[0]?.[0]));
    expect(url.pathname).toBe("/post/a%2Fb/replies");
    expect(url.searchParams.has("postId")).toBe(false);
  });

  it("treats a 204 as an EMPTY ANSWER on this method — `{__empty, httpStatus}`", async () => {
    const { FanslyAdapter, fetchMock } = harness;
    // Explicitly SYNTHETIC: no GET anywhere in the 2026-08-19 HAR returned 204
    // (all 197 are OPTIONS preflights), so this is the honest handling of a
    // case nobody has ever observed, not an observed contract.
    fetchMock.mockResolvedValueOnce(new Response(null, { status: 204 }));
    const adapter = new FanslyAdapter({ baseUrl: "https://fansly.example" });
    const result = await adapter.getPostRepliesPage(context(), { postId: "p-1" });
    await adapter.close();
    expect(result.raw).toEqual({ __empty: true, httpStatus: 204 });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("treats an ok response with an EMPTY BODY the same way", async () => {
    const { FanslyAdapter, fetchMock } = harness;
    fetchMock.mockResolvedValueOnce(new Response("", { status: 200 }));
    const adapter = new FanslyAdapter({ baseUrl: "https://fansly.example" });
    const result = await adapter.getPostRepliesPage(context(), { postId: "p-1" });
    await adapter.close();
    expect(result.raw).toEqual({ __empty: true, httpStatus: 200 });
  });

  it("does NOT soften an empty body on any other method", async () => {
    const { FanslyAdapter, fetchMock } = harness;
    // `emptyStatuses` is opt-in per method for exactly this reason: everywhere
    // else an envelope-less body IS a failure, and a global softening would let
    // a truncated response read as "no data" on every lane at once.
    fetchMock.mockResolvedValue(new Response(null, { status: 204 }));
    const adapter = new FanslyAdapter({ baseUrl: "https://fansly.example" });
    const failure = await adapter.getSubscriptionTiers(context())
      .then(() => null, (error: unknown) => error as Error);
    await adapter.close();
    expect(failure).toBeInstanceOf(Error);
  });

  it("returns a populated reply page verbatim, sidecars and all", async () => {
    const { FanslyAdapter, fetchMock } = harness;
    const body = {
      posts: [{
        id: "c-1",
        accountId: "a-1",
        content: "",
        inReplyTo: "p-1",
        inReplyToRoot: "p-1",
        createdAt: 1786535102,
        attachments: [],
        likeCount: 0,
        mediaLikeCount: 0,
        totalTipAmount: 0,
        attachmentTipAmount: 0,
      }],
      // The adapter is a TRANSPORT: the [A20] trim runs in the capture handler,
      // which is the ONE place a test can pin it.
      accounts: [{ id: "a-1", username: "fan", lastSeenAt: 1787000123 }],
      tips: [],
      tipGoals: [],
      stories: [],
      polls: [],
    };
    fetchMock.mockResolvedValueOnce(toJsonResponse({ success: true, response: body }));
    const adapter = new FanslyAdapter({ baseUrl: "https://fansly.example" });
    const result = await adapter.getPostRepliesPage(context(), { postId: "p-1" });
    await adapter.close();
    expect(result.raw).toEqual(body);
  });

  it("treats 401/403 as terminal — one attempt, typed failure, never an empty answer", async () => {
    const { FanslyAdapter, fetchMock } = harness;
    fetchMock.mockResolvedValue(
      toJsonResponse({ success: false, error: { code: 401, message: "unauthorized" } }, {
        status: 401,
      }),
    );
    const adapter = new FanslyAdapter({ baseUrl: "https://fansly.example" });
    const { events, requestObserver } = captureEvents();
    const failure = await adapter.getPostRepliesPage(context({ requestObserver }), { postId: "p-1" })
      .then(() => null, (error: unknown) => error as { status?: number });
    await adapter.close();
    expect(failure?.status).toBe(401);
    // A dead session that retried three times would triple egress that is
    // already failing, and it must reach the executor's auth pause unchanged.
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(events.filter((event) => event.state === "started")).toHaveLength(1);
  });

  it("CONTAINS NO WRITE-SHAPED CALL TO FANSLY — the grep pin", () => {
    // The law this package is built on, checked rather than promised. Every
    // observed reply GET in the capture was preceded by
    // `POST /api/v1/postreply/verify`; [E1] proved that POST is a client-side
    // affordance, and §1 excludes write-shaped calls to the platform. If the
    // string ever appears in the adapter — as a route, a comment, or a
    // half-finished idea — this fails.
    const source = readFileSync(
      path.resolve("packages/fansly/src/adapter.ts"),
      "utf8",
    );
    expect(source).not.toMatch(/postreply\/verify/);
    // And no method anywhere in this adapter sends anything but GET.
    expect(source).not.toMatch(/method: *"(POST|PUT|PATCH|DELETE)"/);
  });
});

describe("WP-F6 adapter method: GET /post?ids=", () => {
  it("builds the exact method, path and CSV query, through the page's own proxy", async () => {
    const { FanslyAdapter, fetchMock, proxyDispatchers } = harness;
    fetchMock.mockResolvedValueOnce(toJsonResponse({
      success: true,
      response: {
        posts: [{ id: "935652730221907968", likeCount: 30, mediaLikeCount: 159, wallIds: [] }],
        accounts: [{ id: "737077689877278720" }],
      },
    }));
    const adapter = new FanslyAdapter({ baseUrl: "https://fansly.example" });
    const batch = await adapter.getPostsByIds(context(), [
      "935652730221907968",
      "935652730221907969",
    ]);
    await adapter.close();

    const [input, init] = fetchMock.mock.calls[0] ?? [];
    expect((init as RequestInit).method).toBe("GET");
    const url = new URL(String(input));
    expect(url.pathname).toBe("/post");
    // CSV in the order asked — the app's own `getPosts` joins with a comma.
    expect(url.searchParams.get("ids")).toBe("935652730221907968,935652730221907969");
    expect(url.searchParams.get("ngsw-bypass")).toBe("true");
    // FANSLY PAGES MUST GO THROUGH THEIR OWN PROXY — a direct-IP read of a
    // creator account risks a model ban.
    expect(proxyDispatchers.length).toBeGreaterThan(0);
    expect((init as { dispatcher?: { label?: string } }).dispatcher?.label).toMatch(/^proxy-/);

    expect(batch.contractAccepted).toBe(true);
    expect(batch.items).toHaveLength(1);
    // The route neither pages nor scopes to an account or a wall; the shared
    // response shape keeps those inert rather than inventing values for them.
    expect(batch).toMatchObject({ done: true, nextBefore: null, accountId: "", wallId: null });
    // The whole envelope is retained for the journal, sidecars included.
    expect(batch.raw).toMatchObject({ accounts: [{ id: "737077689877278720" }] });
  });

  it("hands back a drifted envelope for the journal instead of throwing", async () => {
    const { FanslyAdapter, fetchMock } = harness;
    fetchMock.mockResolvedValueOnce(toJsonResponse({
      success: true,
      response: { timelineItems: [] },
    }));
    const adapter = new FanslyAdapter({ baseUrl: "https://fansly.example" });
    const drifted = await adapter.getPostsByIds(context(), ["935652730221907968"]);
    await adapter.close();
    // JOURNAL BEFORE ASSERT: the body comes back so the lane can store it, and
    // only then is it refused as an answer.
    expect(drifted).toMatchObject({ contractAccepted: false, items: [] });
    expect(drifted.raw).toEqual({ timelineItems: [] });
  });

  it("refuses a batch shape the server has never been seen to accept", async () => {
    const { FanslyAdapter, POST_BATCH_SIZE } = harness;
    const adapter = new FanslyAdapter({ baseUrl: "https://fansly.example" });
    await expect(adapter.getPostsByIds(context(), [])).rejects.toThrow(/at least one id/);
    await expect(adapter.getPostsByIds(
      context(),
      Array.from({ length: POST_BATCH_SIZE + 1 }, (_, index) => `post-${index}`),
    )).rejects.toThrow(/at most 100 ids/);
    await expect(adapter.getPostsByIds(context(), [" "])).rejects.toThrow(/nonblank/);
    await adapter.close();
    expect(POST_BATCH_SIZE).toBe(100);
  });
});

describe("WP-F7 adapter methods: the two payout routes", () => {
  it("builds the exact method, path and query for both, through the page's own proxy", async () => {
    const { FanslyAdapter, fetchMock, proxyDispatchers } = harness;
    fetchMock.mockResolvedValueOnce(toJsonResponse({ success: true, response: [] }));
    fetchMock.mockResolvedValueOnce(
      toJsonResponse({ success: true, response: { total: 0, data: [] } }),
    );
    const adapter = new FanslyAdapter({ baseUrl: "https://fansly.example" });
    await adapter.getPayoutMethods(context());
    await adapter.getPayoutRequestsPage(context(), {
      before: "",
      after: "",
      limit: 10,
      offset: 20,
    });
    await adapter.close();

    const methods = fetchMock.mock.calls.map(([, init]) => (init as RequestInit).method);
    // READ-ONLY, ALWAYS. There is no POST to the platform anywhere in this
    // initiative, and least of all on the lane that reads payout credentials.
    expect(new Set(methods)).toEqual(new Set(["GET"]));

    const urls = fetchMock.mock.calls.map(([input]) => new URL(String(input)));
    expect(urls[0]?.pathname).toBe("/payments/payoutmethods");
    // No query but the service-worker bypass every Fansly request carries.
    expect([...urls[0]!.searchParams.keys()]).toEqual(["ngsw-bypass"]);

    expect(urls[1]?.pathname).toBe("/payments/payout/requests");
    // PRESENT AND EMPTY, both of them — the form the app sends on all nine
    // observed calls. An omitted parameter is a different request, and only the
    // empty one has ever been answered.
    expect(urls[1]?.searchParams.has("before")).toBe(true);
    expect(urls[1]?.searchParams.get("before")).toBe("");
    expect(urls[1]?.searchParams.has("after")).toBe(true);
    expect(urls[1]?.searchParams.get("after")).toBe("");
    expect(urls[1]?.searchParams.get("limit")).toBe("10");
    expect(urls[1]?.searchParams.get("offset")).toBe("20");
    expect(urls[1]?.searchParams.get("ngsw-bypass")).toBe("true");

    // FANSLY PAGES MUST GO THROUGH THEIR OWN PROXY — a direct-IP request risks
    // a model ban.
    expect(proxyDispatchers.length).toBeGreaterThan(0);
    for (const [, init] of fetchMock.mock.calls) {
      expect((init as { dispatcher?: { label?: string } }).dispatcher?.label).toMatch(/^proxy-/);
    }
  });

  it("keeps `before` and `after` present-and-empty when the caller omits them", async () => {
    const { FanslyAdapter, fetchMock } = harness;
    fetchMock.mockResolvedValueOnce(
      toJsonResponse({ success: true, response: { total: 0, data: [] } }),
    );
    const adapter = new FanslyAdapter({ baseUrl: "https://fansly.example" });
    await adapter.getPayoutRequestsPage(context(), { limit: 10, offset: 0 });
    await adapter.close();
    const url = new URL(String(fetchMock.mock.calls[0]?.[0]));
    expect(url.searchParams.get("before")).toBe("");
    expect(url.searchParams.get("after")).toBe("");
    expect(url.searchParams.get("offset")).toBe("0");
  });

  it("hands the body through VERBATIM — nothing is decoded in transport", async () => {
    const { FanslyAdapter, fetchMock } = harness;
    // `metadata` is a JSON-ENCODED STRING carrying a plaintext address. The
    // adapter is a TRANSPORT: it must not decode it, must not mask it, and must
    // not drop it. Journal-before-parse is the whole capture rule, and the mask
    // lives one layer up where a fixture can bite it.
    const body = [{
      id: "000900000000009001",
      accountId: "000900000000000001",
      providerId: "2",
      type: 1,
      flags: 0,
      status: 3,
      metadata: "{\"email\":\"fixture.creator@example.invalid\"}",
      version: 0,
    }];
    fetchMock.mockResolvedValueOnce(toJsonResponse({ success: true, response: body }));
    const adapter = new FanslyAdapter({ baseUrl: "https://fansly.example" });
    const result = await adapter.getPayoutMethods(context());
    await adapter.close();
    expect(result.raw).toEqual(body);
  });

  it("treats 403 on the method listing as terminal — one attempt, typed failure", async () => {
    const { FanslyAdapter, fetchMock } = harness;
    fetchMock.mockResolvedValue(
      toJsonResponse({ success: false, error: { code: 403, message: "forbidden" } }, {
        status: 403,
      }),
    );
    const adapter = new FanslyAdapter({ baseUrl: "https://fansly.example" });
    const { events, requestObserver } = captureEvents();
    const failure = await adapter.getPayoutMethods(context({ requestObserver }))
      .then(() => null, (error: unknown) => error as { status?: number });
    await adapter.close();

    expect(failure?.status).toBe(403);
    // A dead session that retried three times would triple egress that is
    // already failing, and it must reach the executor's auth pause unchanged.
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(events.filter((event) => event.state === "started")).toHaveLength(1);
  });

  it("treats 401 on the request walk as terminal — never an empty page", async () => {
    const { FanslyAdapter, fetchMock } = harness;
    fetchMock.mockResolvedValue(
      toJsonResponse({ success: false, error: { code: 401, message: "unauthorized" } }, {
        status: 401,
      }),
    );
    const adapter = new FanslyAdapter({ baseUrl: "https://fansly.example" });
    const { events, requestObserver } = captureEvents();
    const failure = await adapter
      .getPayoutRequestsPage(context({ requestObserver }), { limit: 10, offset: 0 })
      .then(() => null, (error: unknown) => error as { status?: number });
    await adapter.close();

    // LOAD-BEARING: the walk stops when a page comes back SHORT, so an auth
    // failure that surfaced as an empty page would end the walk and record the
    // history as exhausted at whatever offset the session died on.
    expect(failure?.status).toBe(401);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(events.filter((event) => event.state === "started")).toHaveLength(1);
  });

  it("does NOT soften an empty body on either payout route", async () => {
    const { FanslyAdapter, fetchMock } = harness;
    // `emptyStatuses` is WP-F5's opt-in and it is scoped to that one method.
    // Here an envelope-less body IS a failure: "no payout history" arrives as
    // `{total, data: []}`, and letting a truncated response read as "no data"
    // would make an empty walk indistinguishable from a broken one.
    fetchMock.mockResolvedValue(new Response(null, { status: 204 }));
    const adapter = new FanslyAdapter({ baseUrl: "https://fansly.example" });
    const failure = await adapter.getPayoutMethods(context())
      .then(() => null, (error: unknown) => error as Error);
    await adapter.close();
    expect(failure).toBeInstanceOf(Error);
  });
});

describe("WP-F4 adapter method: /it/moie/statsnew", () => {
  it("sends the exact query per tier, through the page's own proxy", async () => {
    const { FanslyAdapter, fetchMock, proxyDispatchers } = harness;
    for (let index = 0; index < 3; index += 1) {
      fetchMock.mockResolvedValueOnce(toJsonResponse({
        success: true,
        response: { dataset: { period: 86_400_000, datapoints: [] }, aggregationData: {} },
      }));
    }
    const adapter = new FanslyAdapter({ baseUrl: "https://fansly.example" });
    const now = new Date("2026-08-22T12:00:00.000Z");

    // FRESH — trailing 31 d, daily: an item that young is covered from its
    // publication day on.
    await adapter.getMediaOfferStats(context(), {
      mediaOfferId: "000900000000004001",
      beforeDate: now,
      afterDate: new Date(now.getTime() - 31 * 24 * 60 * 60_000),
      periodMs: 86_400_000,
    });
    // MID — trailing 30 d, daily.
    await adapter.getMediaOfferStats(context(), {
      mediaOfferId: "000900000000004001",
      beforeDate: now,
      afterDate: new Date(now.getTime() - 30 * 24 * 60 * 60_000),
      periodMs: 86_400_000,
    });
    // BACKFILL — the HISTORICAL 31-day window the HAR proves is honoured
    // exactly: `beforeDate 2026-08-01 / afterDate 2026-07-01` came back
    // `dateBefore 2026-07-31 / dateAfter 2026-06-30`. NOT the plan's 100 days,
    // which is the span `/it/amoie/stats` answered with its own default
    // trailing window on production and looped a whole day's cap on.
    const backfillBefore = new Date("2026-08-01T00:00:00.000Z");
    const backfillAfter = new Date("2026-07-01T00:00:00.000Z");
    await adapter.getMediaOfferStats(context(), {
      mediaOfferId: "000900000000004001",
      beforeDate: backfillBefore,
      afterDate: backfillAfter,
      periodMs: 86_400_000,
    });
    await adapter.close();

    const methods = fetchMock.mock.calls.map(([, init]) => (init as RequestInit).method);
    // READ-ONLY, ALWAYS. This is the highest-volume lane in the initiative and
    // there is still no POST to the platform anywhere in it.
    expect(new Set(methods)).toEqual(new Set(["GET"]));

    const urls = fetchMock.mock.calls.map(([input]) => new URL(String(input)));
    for (const url of urls) {
      expect(url.pathname).toBe("/it/moie/statsnew");
      expect(url.searchParams.get("mediaOfferId")).toBe("000900000000004001");
      expect(url.searchParams.get("ngsw-bypass")).toBe("true");
      // The per-media route takes NO `year`/`month`: those are the account
      // route's named-month affordance and this one has never been observed
      // carrying them.
      expect(url.searchParams.has("year")).toBe(false);
      expect(url.searchParams.has("month")).toBe(false);
      // Exactly the five keys the app sends.
      expect([...url.searchParams.keys()].sort()).toEqual([
        "afterDate",
        "beforeDate",
        "mediaOfferId",
        "ngsw-bypass",
        "period",
      ]);
    }

    // THE PERIOD PER TIER, in epoch milliseconds, as strings on the wire.
    expect(urls[0]?.searchParams.get("period")).toBe("86400000");
    expect(urls[1]?.searchParams.get("period")).toBe("86400000");
    expect(urls[2]?.searchParams.get("period")).toBe("86400000");

    expect(urls[0]?.searchParams.get("beforeDate")).toBe(String(now.getTime()));
    expect(urls[0]?.searchParams.get("afterDate")).toBe(
      String(now.getTime() - 31 * 24 * 60 * 60_000),
    );
    expect(urls[2]?.searchParams.get("beforeDate")).toBe(String(backfillBefore.getTime()));
    expect(urls[2]?.searchParams.get("afterDate")).toBe(String(backfillAfter.getTime()));
    // 31 days, not 100: the span, not the age, is what the provider refuses.
    const spanDays = (backfillBefore.getTime() - backfillAfter.getTime()) / (24 * 60 * 60_000);
    expect(spanDays).toBe(31);

    // FANSLY PAGES MUST GO THROUGH THEIR OWN PROXY — a direct-IP request risks
    // a model ban, and this lane makes 300 requests a page a day.
    expect(proxyDispatchers.length).toBeGreaterThan(0);
    for (const [, init] of fetchMock.mock.calls) {
      expect((init as { dispatcher?: { label?: string } }).dispatcher?.label).toMatch(/^proxy-/);
    }
  });

  it("hands the response through VERBATIM, seven stat keys and no video fields", async () => {
    const { FanslyAdapter, fetchMock } = harness;
    // The live shape (HAR 2026-08-19, 6/6 responses): the media offer id is
    // `dataset.datasetMediaOfferId`, and every `stats[]` row carries EXACTLY
    // seven keys with NO video fields — even for `media.type = 2,
    // mimetype = video/mp4`. [E5] is what would change that; until it does,
    // nothing may promise per-media watch metrics.
    const response = {
      dataset: {
        period: 21_600_000,
        dateBefore: 1_787_140_800_000,
        dateAfter: 1_786_536_000_000,
        datapointLimit: 100,
        datapoints: [{
          timestamp: 1_787_140_800_000,
          stats: [{
            type: 0,
            views: 2,
            previewViews: 0,
            interactionTime: 11_856,
            previewInteractionTime: 0,
            uniqueViewers: 2,
            previewUniqueViewers: 0,
          }],
        }],
        topFypTags: [{
          tagId: "000900000000004101",
          views: 1,
          previewViews: 0,
          interactionTime: 5_636,
          previewInteractionTime: 0,
        }],
        datasetMediaOfferId: "000900000000004001",
      },
      aggregationData: { accountMedia: [], accountMediaBundles: [], tags: [] },
    };
    fetchMock.mockResolvedValueOnce(toJsonResponse({ success: true, response }));
    const adapter = new FanslyAdapter({ baseUrl: "https://fansly.example" });
    const result = await adapter.getMediaOfferStats(context(), {
      mediaOfferId: "000900000000004001",
      beforeDate: new Date(1_787_155_800_000),
      afterDate: new Date(1_786_551_000_000),
      periodMs: 21_600_000,
    });
    await adapter.close();

    expect(result.raw).toEqual(response);
    const stats = (result.raw as typeof response).dataset.datapoints[0]?.stats[0] ?? {};
    expect(Object.keys(stats).sort()).toEqual([
      "interactionTime",
      "previewInteractionTime",
      "previewUniqueViewers",
      "previewViews",
      "type",
      "uniqueViewers",
      "views",
    ]);
  });

  it("treats 403 as terminal — one attempt, typed failure, no retry storm", async () => {
    const { FanslyAdapter, fetchMock } = harness;
    fetchMock.mockResolvedValue(
      toJsonResponse({ success: false, error: { code: 403, message: "forbidden" } }, {
        status: 403,
      }),
    );
    const adapter = new FanslyAdapter({ baseUrl: "https://fansly.example" });
    const { events, requestObserver } = captureEvents();
    const failure = await adapter
      .getMediaOfferStats(context({ requestObserver }), {
        mediaOfferId: "media-1",
        beforeDate: new Date("2026-08-22T00:00:00.000Z"),
        afterDate: new Date("2026-07-22T00:00:00.000Z"),
        periodMs: 86_400_000,
      })
      .then(() => null, (error: unknown) => error as { status?: number });
    await adapter.close();

    expect(failure?.status).toBe(403);
    // LOAD-BEARING ON THIS LANE ABOVE ALL: the cap is counted in ATTEMPTS, so a
    // dead session that retried three times per media would triple the egress
    // of the highest-volume lane in the system while failing.
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(events.filter((event) => event.state === "started")).toHaveLength(1);
  });

  it("treats 401 as terminal — never a silently empty window", async () => {
    const { FanslyAdapter, fetchMock } = harness;
    fetchMock.mockResolvedValue(
      toJsonResponse({ success: false, error: { code: 401, message: "unauthorized" } }, {
        status: 401,
      }),
    );
    const adapter = new FanslyAdapter({ baseUrl: "https://fansly.example" });
    const { events, requestObserver } = captureEvents();
    const failure = await adapter
      .getMediaOfferStats(context({ requestObserver }), {
        mediaOfferId: "media-1",
        beforeDate: new Date("2026-08-22T00:00:00.000Z"),
        afterDate: new Date("2026-07-22T00:00:00.000Z"),
        periodMs: 86_400_000,
      })
      .then(() => null, (error: unknown) => error as { status?: number });
    await adapter.close();

    // The backfill's stop rule is TWO consecutive all-empty windows. An auth
    // failure surfacing as an empty body would record a retention floor that
    // does not exist, per media, for as long as the session stayed dead.
    expect(failure?.status).toBe(401);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(events.filter((event) => event.state === "started")).toHaveLength(1);
  });

  const STATS_WINDOW = {
    mediaOfferId: "media-1",
    beforeDate: new Date("2026-08-22T00:00:00.000Z"),
    afterDate: new Date("2026-07-22T00:00:00.000Z"),
    periodMs: 86_400_000,
  };
  /** Fansly's own answer for a refused span (production, every attempt of the
   *  90-day window since 2026-09-05) and for a gone item. */
  const errorEnvelope = (details: string) => ({ success: false, error: { code: 500, details } });
  const bodyResponse = (body: string, init: ResponseInit) =>
    new Response(body, { headers: { "content-type": "application/json" }, ...init });

  for (const details of ["error getting graph", "error getting media offer"]) {
    it(`fails a 500 carrying Fansly's error envelope on the FIRST attempt (${details})`, async () => {
      const { FanslyAdapter, fetchMock } = harness;
      // A fresh Response per call: were it retried, every attempt would answer.
      fetchMock.mockImplementation(async () =>
        toJsonResponse(errorEnvelope(details), { status: 500 }));
      const adapter = new FanslyAdapter({ baseUrl: "https://fansly.example" });
      const { events, requestObserver } = captureEvents();
      const failure = await adapter.getMediaOfferStats(context({ requestObserver }), STATS_WINDOW)
        .then(() => null, (error: unknown) => error as {
          status?: number;
          code?: number;
          message?: string;
          retryAfterAt?: Date | null;
        });
      await adapter.close();

      // Deterministic on this route: no retry has ever recovered one, and each
      // would be one more attempt against the lane's daily cap.
      expect(fetchMock).toHaveBeenCalledTimes(1);
      expect(events.filter((event) => event.state === "started")).toHaveLength(1);
      expect(failure).toMatchObject({ status: 500, code: 500, retryAfterAt: null });
      // The reason is in `error.details`, and now in the message too.
      expect(failure?.message).toBe(`Fansly request failed (500): ${details}`);
      expect(events.find((event) => event.state === "failed")?.errorMessage)
        .toBe(`Fansly request failed (500): ${details}`);
    });
  }

  for (
    const [label, response] of [
      ["an HTML 500", () => bodyResponse("<html>Internal Server Error</html>", { status: 500 })],
      ["a bare {success:false} 500", () => toJsonResponse({ success: false }, { status: 500 })],
      ["an envelope 500 with a Retry-After", () =>
        toJsonResponse(errorEnvelope("error getting graph"), {
          status: 500,
          headers: { "content-type": "application/json", "retry-after": "0" },
        })],
      ["an envelope 429", () =>
        toJsonResponse(errorEnvelope("rate limited"), {
          status: 429,
          headers: { "content-type": "application/json", "retry-after": "0" },
        })],
    ] as const
  ) {
    it(`still retries ${label} on this route`, async () => {
      const { FanslyAdapter, fetchMock } = harness;
      fetchMock
        .mockResolvedValueOnce(response())
        .mockResolvedValueOnce(toJsonResponse({ success: true, response: { dataset: {} } }));
      const adapter = new FanslyAdapter({ baseUrl: "https://fansly.example" });
      const result = await adapter.getMediaOfferStats(context(), STATS_WINDOW);
      await adapter.close();

      expect(fetchMock).toHaveBeenCalledTimes(2);
      expect(result.raw).toEqual({ dataset: {} });
    });
  }

  it("keeps retrying the same envelope 500 on every OTHER route", async () => {
    const { FanslyAdapter, fetchMock } = harness;
    fetchMock
      .mockResolvedValueOnce(toJsonResponse(errorEnvelope("error getting graph"), { status: 500 }))
      .mockResolvedValueOnce(toJsonResponse({ success: true, response: { dataset: {} } }));
    const adapter = new FanslyAdapter({ baseUrl: "https://fansly.example" });
    await adapter.getAccountStats(context(), {
      beforeDate: STATS_WINDOW.beforeDate,
      afterDate: STATS_WINDOW.afterDate,
      periodMs: 86_400_000,
    });
    await adapter.close();

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(new URL(String(fetchMock.mock.calls[0]![0])).pathname).toBe("/it/amoie/stats");
  });

  it("puts Fansly's error details in the message on every route, after the provider's own message", async () => {
    const { FanslyAdapter, fetchMock } = harness;
    fetchMock
      .mockResolvedValueOnce(toJsonResponse(errorEnvelope("error getting graph"), { status: 500 }))
      .mockResolvedValueOnce(toJsonResponse(
        { success: false, error: { code: 1, message: "bad request", details: "missing id" } },
        { status: 400 },
      ));
    const adapter = new FanslyAdapter({ baseUrl: "https://fansly.example" });
    // One attempt left today: the route's own retries cannot run.
    const lastAttempt = context({ remainingAttempts: () => 1 });
    const accountStats = await adapter.getAccountStats(lastAttempt, {
      beforeDate: STATS_WINDOW.beforeDate,
      afterDate: STATS_WINDOW.afterDate,
      periodMs: 86_400_000,
    }).then(() => null, (error: unknown) => error as { status?: number; message?: string });
    const withMessage = await adapter.getTrackingLinks(lastAttempt)
      .then(() => null, (error: unknown) => error as { status?: number; message?: string });
    await adapter.close();

    expect(accountStats).toMatchObject({
      status: 500,
      message: "Fansly request failed (500): error getting graph",
    });
    // A provider `message` is still the message, verbatim.
    expect(withMessage).toMatchObject({ status: 400, message: "bad request" });
  });

  it("redacts a failed response body BEFORE slicing it, so a credential cut at the 400-char edge cannot leak (decision #248)", async () => {
    const { FanslyAdapter, fetchMock } = harness;
    // Lay the body out so the 400-char boundary falls INSIDE the proxy password:
    // sliced first, the fragment `socks5://user:supersecretpassw` is no longer a
    // URL the redactor recognises and the secret survives into the snippet.
    const head = '{"success":false,"error":{"code":1,"message":"';
    const secretUrl = "socks5://user:supersecretpassword@proxy.example:1080";
    const cutInsidePassword = "socks5://user:supersecretpassw".length;
    const pad = "x".repeat(400 - head.length - cutInsidePassword);
    const body = `${head}${pad}${secretUrl} refused"}}`;
    expect(body.slice(0, 400).endsWith("supersecretpassw")).toBe(true);
    // 403 is terminal on the adapter (one attempt, no backoff), so the test does not
    // wait out a retry ladder; a fresh Response per call anyway — a body can be read once and a retried
    // must not turn into a "body already used" failure that hides the point.
    fetchMock.mockImplementation(async () =>
      new Response(body, { status: 403, headers: { "content-type": "application/json" } }));
    const adapter = new FanslyAdapter({ baseUrl: "https://fansly.example" });

    // No static import of the fansly package here: the harness installs the
    // undici fetch spy BEFORE it loads the adapters, and an import at module
    // top would bind the adapter to the real fetch for every test in the file.
    const failure = await adapter.getSubscriptionTiers(context())
      .then(() => null, (error: unknown) => error as { status?: number; responseSnippet?: string | null });
    await adapter.close();

    expect(failure?.status).toBe(403);
    expect(failure?.responseSnippet).toBeTruthy();
    expect(failure?.responseSnippet?.length).toBeLessThanOrEqual(400);
    expect(failure?.responseSnippet).not.toContain("supersecret");
    expect(failure?.responseSnippet).not.toContain("passw");
  });

});
