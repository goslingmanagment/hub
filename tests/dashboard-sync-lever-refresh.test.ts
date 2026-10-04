import { beforeEach, describe, expect, it, vi } from "vitest";

// Step 4, S4-35: after a block button the «Синк» tab showed the blocks at once
// and the engine's own status — the queue by why it waits, the holds — only at
// its next 10 s poll. Every block lever refreshes the engine's queries with
// the block queries.
//
// The hooks are run against a stand-in for @tanstack/react-query (mocked at
// the file the dashboard resolves it to, as the other dashboard tests mock
// sonner): a mutation is its options, a query client records what it was
// asked to refresh.

const client = vi.hoisted(() => ({ invalidateQueries: vi.fn(async (_filter: { queryKey: readonly unknown[] }) => {}) }));
const sdk = vi.hoisted(() => ({
  adminSyncBlockTrigger: vi.fn(),
  adminSyncBlockPause: vi.fn(),
  adminSyncBlockResume: vi.fn(),
  adminSyncBlockReset: vi.fn(),
}));

vi.mock("../apps/dashboard/node_modules/@tanstack/react-query/build/modern/index.js", () => ({
  useMutation: (options: unknown) => options,
  useQuery: (options: unknown) => options,
  useQueryClient: () => client,
}));
vi.mock("../apps/dashboard/src/api/sdk.ts", () => ({ kernel: sdk }));

import {
  useAdminSyncBlockPause,
  useAdminSyncBlockReset,
  useAdminSyncBlockResume,
  useAdminSyncBlockTrigger,
  useSyncEnginePages,
  useSyncHistoryRequests,
} from "../apps/dashboard/src/api/adminSync.ts";

type Lever = { mutationFn(body: unknown): unknown; onSuccess(): void };
type Query = { queryKey: readonly unknown[] };

const LEVERS = [
  ["trigger", useAdminSyncBlockTrigger, sdk.adminSyncBlockTrigger],
  ["pause", useAdminSyncBlockPause, sdk.adminSyncBlockPause],
  ["resume", useAdminSyncBlockResume, sdk.adminSyncBlockResume],
  ["reset", useAdminSyncBlockReset, sdk.adminSyncBlockReset],
] as const;

describe("a block lever of the «Синк» tab", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it.each(LEVERS)("%s refreshes the engine's status and requests with the blocks", (_name, useLever, call) => {
    const lever = useLever() as unknown as Lever;
    const body = { pageLabel: "lilly-1", block: "messages_live" };
    void lever.mutationFn(body);
    expect(call).toHaveBeenCalledWith({ body });
    lever.onSuccess();
    const refreshed = client.invalidateQueries.mock.calls.map(([filter]) => filter.queryKey);
    expect(refreshed).toEqual([["syncBlocks"], ["syncEngine"], ["admin", "connections"], ["overview"]]);
  });

  it("the engine's queries live under the key the levers refresh", () => {
    const prefix = (query: unknown) => (query as Query).queryKey[0];
    expect(prefix(useSyncEnginePages())).toBe("syncEngine");
    expect(prefix(useSyncHistoryRequests({ pageLabel: "lilly-1", state: "open", limit: 200 }))).toBe("syncEngine");
  });
});
