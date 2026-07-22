import { createServer, type Server } from "node:http";

import { afterEach, describe, expect, it } from "vitest";

import { createOfapiClient } from "../apps/runtime/src/services/ofapi.ts";

const ACCOUNT = "acct_01000000000000000000000000000000";

let server: Server | null = null;

afterEach(() => {
  server?.close();
  server = null;
});

async function listenOnLocalhost(serverToStart: Server): Promise<string> {
  return new Promise((resolve, reject) => {
    serverToStart.once("error", reject);
    serverToStart.listen(0, "127.0.0.1", () => {
      const address = serverToStart.address();
      if (address === null || typeof address === "string") {
        reject(new Error("test server did not bind to a TCP port"));
        return;
      }
      resolve(`http://127.0.0.1:${address.port}`);
    });
  });
}

describe("OFAPI stored link-list client methods", () => {
  it("hits the stored paths, clamps limit to 1000, parses data.list/hasMore, reports zero spend", async () => {
    const urls: string[] = [];
    server = createServer((request, response) => {
      urls.push(request.url ?? "");
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({
        data: {
          list: [{ id: 2117449, campaignName: "waptap" }],
          hasMore: true,
        },
        _meta: {
          _credits: { used: 0, balance: 1000 },
          _cache: { is_cached: true },
        },
      }));
    });
    const baseUrl = await listenOnLocalhost(server);
    const spend: Array<{ operation: string; credits: number }> = [];
    const client = createOfapiClient({
      baseUrl,
      apiKey: "test-key",
      restDelayMs: 0,
      onCreditSpend: (observation) => {
        spend.push({ operation: observation.operation, credits: observation.credits });
      },
    });

    const trackingPage = await client.listStoredTrackingLinks!(
      { pageId: 1, dispatcher: null, egressKey: null, creditBudgetScope: "link_stats" },
      ACCOUNT,
      { limit: 5000, offset: 1000 },
    );
    expect(urls[0]).toBe(
      `/${ACCOUNT}/stored/tracking-links?limit=1000&offset=1000`,
    );
    expect(trackingPage.items).toEqual([{ id: 2117449, campaignName: "waptap" }]);
    expect(trackingPage.hasNextPage).toBe(true);
    expect(trackingPage.meta).toMatchObject({ creditsUsed: 0 });

    const trialPage = await client.listStoredTrialLinks!(
      { pageId: 1, dispatcher: null, egressKey: null, creditBudgetScope: "link_stats" },
      ACCOUNT,
      {},
    );
    expect(urls[1]).toBe(`/${ACCOUNT}/stored/trial-links?limit=1000`);
    expect(trialPage.hasNextPage).toBe(true);

    expect(spend.map((entry) => entry.operation)).toEqual([
      "ofapi_stored_tracking_links",
      "ofapi_stored_trial_links",
    ]);
    expect(spend.every((entry) => entry.credits === 0)).toBe(true);
  });
});
