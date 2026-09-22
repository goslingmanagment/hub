import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { QueryClient, QueryClientProvider, QueryObserver } from "../apps/dashboard/node_modules/@tanstack/react-query/build/modern/index.js";

const mocks = vi.hoisted(() => ({ collectionGet: vi.fn() }));
vi.mock("../apps/dashboard/src/api/sdk.ts", () => ({ kernel: { ofapiCollectionGet: mocks.collectionGet } }));

import { OFAPI_COLLECTION_QUERY_KEY, useAdminOfapiCollection } from "../apps/dashboard/src/api/adminOfapiCollection.ts";
import { useOfapiExportPages } from "../apps/dashboard/src/api/ofapiExports.ts";
import { ofapiCollectionQueryOptions } from "../apps/dashboard/src/api/ofapiCollection.ts";

function SnapshotReadback() {
  const controls = useAdminOfapiCollection();
  const exports = useOfapiExportPages();
  return createElement("output", null, `${controls.data?.revision}:${exports.data?.revision}`);
}

function snapshot(revision: number) {
  return { revision, backgroundPaused: false, catalog: [], pages: [], policies: [], jobs: [], audit: [], limitDescription: "" };
}

describe("OFAPI collection cache", () => {
  it("refreshes both controls and export revisions after the collection mutation invalidation", async () => {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: 30_000, gcTime: Infinity } } });
    const render = () => renderToStaticMarkup(createElement(QueryClientProvider, { client }, createElement(SnapshotReadback)));
    mocks.collectionGet.mockResolvedValueOnce(snapshot(1)).mockResolvedValueOnce(snapshot(2));
    const observer = new QueryObserver(client, ofapiCollectionQueryOptions());
    const unsubscribe = observer.subscribe(() => {});
    try {
      await client.fetchQuery(ofapiCollectionQueryOptions());
      expect(render()).toContain("1:1");
      expect(mocks.collectionGet).toHaveBeenCalledTimes(1);

      // This is the key invalidated by collection apply/resume/finish hooks.
      await client.invalidateQueries({ queryKey: OFAPI_COLLECTION_QUERY_KEY });
      expect(render()).toContain("2:2");
      expect(mocks.collectionGet).toHaveBeenCalledTimes(2);
      expect(client.getQueryCache().getAll()).toHaveLength(1);
    } finally {
      unsubscribe();
      client.clear();
    }
  });
});
