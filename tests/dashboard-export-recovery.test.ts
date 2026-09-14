import { beforeEach, describe, expect, it, vi } from "vitest";
import { QueryClient } from "../apps/dashboard/node_modules/@tanstack/react-query/build/modern/index.js";

const sdk = vi.hoisted(() => ({ list: vi.fn() }));
vi.mock("../apps/dashboard/src/api/sdk.ts", () => ({ kernel: { ofapiTypedExportList: sdk.list } }));

import { ofapiExportJobsQueryOptions, readOfapiExportJobsForRecovery } from "../apps/dashboard/src/api/ofapiExports.ts";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((finish) => { resolve = finish; });
  return { promise, resolve };
}

beforeEach(() => { sdk.list.mockReset(); });

describe("export quote recovery reads", () => {
  it("replaces an initial in-flight GET without cached data and ignores its late reply", async () => {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: Infinity } } });
    const older = deferred<{ jobs: Array<{ jobId: string }> }>();
    const recovery = deferred<{ jobs: Array<{ jobId: string }> }>();
    sdk.list.mockReturnValueOnce(older.promise).mockReturnValueOnce(recovery.promise);
    const options = ofapiExportJobsQueryOptions(1);
    const originalRead = client.fetchQuery(options).catch(() => undefined);
    expect(client.getQueryState(options.queryKey)?.data).toBeUndefined();

    const readback = readOfapiExportJobsForRecovery(client, 1);
    await vi.waitFor(() => expect(sdk.list).toHaveBeenCalledTimes(2));
    expect(sdk.list.mock.calls).toEqual([[{ query: { pageId: 1 } }], [{ query: { pageId: 1 } }]]);
    expect(client.getQueryState(options.queryKey)?.fetchStatus).toBe("fetching");

    const savedJobs = { jobs: [{ jobId: "accepted-quote" }] };
    recovery.resolve(savedJobs);
    expect(await readback).toMatchObject({ pageId: 1 });
    expect(client.getQueryData(options.queryKey)).toEqual(savedJobs);
    const successfulRead = client.getQueryState(options.queryKey)?.dataUpdatedAt;
    older.resolve({ jobs: [{ jobId: "older-snapshot" }] });
    await originalRead;
    expect(client.getQueryState(options.queryKey)?.dataUpdatedAt).toBe(successfulRead);
    expect(client.getQueryData(options.queryKey)).toEqual(savedJobs);
    client.clear();
  });

  it("reads the original page anew despite cached data, failure and another page's active read", async () => {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: Infinity } } });
    const firstPage = ofapiExportJobsQueryOptions(1);
    const otherPage = ofapiExportJobsQueryOptions(2);
    client.setQueryData(firstPage.queryKey, { jobs: [] });
    const otherRead = deferred<{ jobs: [] }>();
    sdk.list.mockReturnValueOnce(otherRead.promise).mockRejectedValueOnce(new Error("Read failed"));
    const otherPending = client.fetchQuery(otherPage);

    await expect(readOfapiExportJobsForRecovery(client, 1)).rejects.toThrow("Read failed");
    expect(client.getQueryState(firstPage.queryKey)?.status).toBe("error");
    expect(client.getQueryState(otherPage.queryKey)?.fetchStatus).toBe("fetching");
    sdk.list.mockResolvedValueOnce({ jobs: [] });
    expect(await readOfapiExportJobsForRecovery(client, 1)).toMatchObject({ pageId: 1 });
    expect(sdk.list.mock.calls).toEqual([
      [{ query: { pageId: 2 } }],
      [{ query: { pageId: 1 } }],
      [{ query: { pageId: 1 } }],
    ]);
    otherRead.resolve({ jobs: [] });
    await otherPending;
    client.clear();
  });
});
