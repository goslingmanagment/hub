import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import {
  captureEvents,
  cleanupAdapterHarness,
  loadAdapters,
  toJsonResponse,
} from "./helpers/adapter-harness.ts";

// ONE harness for the whole file. `loadAdapters` resets the module registry and
// re-spies `undici.fetch`; calling it per test leaves the adapter bound to a
// module instance the new spy no longer covers, and the calls escape to the
// real network. Every other adapter suite in this tree has exactly one `it` for
// the same reason — this file keeps its cases separate and shares the harness.
let harness: Awaited<ReturnType<typeof loadAdapters>>;

beforeAll(async () => {
  harness = await loadAdapters();
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
};

function context(overrides: Record<string, unknown> = {}) {
  return {
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
    const adapter = new FanslyAdapter({ baseUrl: "https://fansly.example", globalDelayMs: 0 });
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
    // year/month 0/0 is the "use the explicit bounds" form; the named-month
    // variant is a UI affordance this lane never sends.
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
      expect(header["fansly-client-check"]).toBe("check-1");
      expect(header["fansly-session-id"]).toBe("session-1");
    }
    // One proxy dispatcher, and every call used it.
    expect(proxyDispatchers).toHaveLength(1);
    for (const [, init] of fetchMock.mock.calls) {
      expect((init as { dispatcher?: unknown }).dispatcher).toBe(proxyDispatchers[0]);
    }
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
    const adapter = new FanslyAdapter({ baseUrl: "https://fansly.example", globalDelayMs: 0 });
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
    const adapter = new FanslyAdapter({ baseUrl: "https://fansly.example", globalDelayMs: 0 });
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
    const adapter = new FanslyAdapter({ baseUrl: "https://fansly.example", globalDelayMs: 0 });
    const { events, requestObserver } = captureEvents();
    await adapter.getTrackingLinks(context({ requestObserver }));
    await adapter.close();
    // The per-lane daily cap is counted in attempts precisely because a retry
    // storm on a logical-call cap would multiply real egress.
    expect(events.filter((event) => event.state === "started")).toHaveLength(2);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("keeps the tracking-links route wired and contract-checked", async () => {
    const { FanslyAdapter, fetchMock } = harness;
    fetchMock.mockResolvedValueOnce(toJsonResponse({
      success: true,
      response: [{ id: "link-1", totalGross: 1000, totalNet: 0 }],
    }));
    const adapter = new FanslyAdapter({ baseUrl: "https://fansly.example", globalDelayMs: 0 });
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
    const adapter = new FanslyAdapter({ baseUrl: "https://fansly.example", globalDelayMs: 0 });
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
    const adapter = new FanslyAdapter({ baseUrl: "https://fansly.example", globalDelayMs: 0 });
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

    // Same headers, same per-page proxy, same everything as the F1 lane.
    const headers = fetchMock.mock.calls.map(
      ([, init]) => (init as RequestInit).headers as Record<string, string>,
    );
    for (const header of headers) {
      expect(header.authorization).toBe("token-abc");
      expect(header["fansly-client-check"]).toBe("check-1");
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
    const adapter = new FanslyAdapter({ baseUrl: "https://fansly.example", globalDelayMs: 0 });
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
    const adapter = new FanslyAdapter({ baseUrl: "https://fansly.example", globalDelayMs: 0 });
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
    const adapter = new FanslyAdapter({ baseUrl: "https://fansly.example", globalDelayMs: 0 });
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
    const adapter = new FanslyAdapter({ baseUrl: "https://fansly.example", globalDelayMs: 0 });

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
      expect(header["fansly-client-check"]).toBe("check-1");
      expect(header["fansly-session-id"]).toBe("session-1");
    }
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
    const adapter = new FanslyAdapter({ baseUrl: "https://fansly.example", globalDelayMs: 0 });
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
    const adapter = new FanslyAdapter({ baseUrl: "https://fansly.example", globalDelayMs: 0 });
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
    const adapter = new FanslyAdapter({ baseUrl: "https://fansly.example", globalDelayMs: 0 });
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
    const adapter = new FanslyAdapter({ baseUrl: "https://fansly.example", globalDelayMs: 0 });
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
    const adapter = new FanslyAdapter({ baseUrl: "https://fansly.example", globalDelayMs: 0 });
    const failure = await adapter.getVaultMediaPage(context(), { albumId: "album-1" })
      .then(() => null, (error: unknown) => error as { status?: number });
    await adapter.close();
    expect(failure?.status).toBe(400);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
