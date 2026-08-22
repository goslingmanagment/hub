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
