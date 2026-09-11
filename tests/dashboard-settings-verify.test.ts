import type * as TanstackReactQuery from "../apps/dashboard/node_modules/@tanstack/react-query/build/modern/index.js";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { QueryClient, type MutationFilters, type MutationObserver, type MutationObserverOptions } from "../apps/dashboard/node_modules/@tanstack/react-query/build/modern/index.js";

// Replace only the React lifecycle adapter, keeping real TanStack observers
// and the mutation cache. Fresh observer slots model a remounted tab; no test
// manufactures pending flags, and the client remains shared across instances.
const hooks = vi.hoisted(() => ({ values: [] as unknown[], cursor: 0, client: null as unknown }));
const api = vi.hoisted(() => ({ adminVerifyPage: vi.fn(), adminUpdateModel: vi.fn() }));
vi.mock("../apps/dashboard/node_modules/@tanstack/react-query/build/modern/index.js", async (importOriginal) => {
  const actual = await importOriginal<typeof TanstackReactQuery>();
  return {
    ...actual,
    useQueryClient: () => hooks.client,
    useIsMutating: (filters: MutationFilters) => (hooks.client as QueryClient).isMutating(filters),
    useMutation: (options: MutationObserverOptions<unknown, Error, unknown>) => {
      const index = hooks.cursor++;
      let observer = hooks.values[index] as MutationObserver<unknown, Error, unknown> | undefined;
      if (!observer) {
        observer = new actual.MutationObserver<unknown, Error, unknown>(hooks.client as QueryClient, options);
        hooks.values[index] = observer;
      } else observer.setOptions(options);
      return { ...observer.getCurrentResult(), mutateAsync: observer.mutate.bind(observer) };
    },
  };
});
vi.mock("../apps/dashboard/src/api/sdk.ts", () => ({ kernel: api }));

import { useAdminReorderModels, useAdminVerifyPage } from "../apps/dashboard/src/api/adminPages.ts";

function render(label = "synthetic-page", id = 1) {
  hooks.cursor = 0;
  return useAdminVerifyPage(label, id);
}

describe("page verification request lifetime", () => {
  beforeEach(() => {
    hooks.values = [];
    hooks.cursor = 0;
    hooks.client = new QueryClient({ defaultOptions: { mutations: { retry: false, gcTime: Infinity } } });
    api.adminVerifyPage.mockReset();
    api.adminUpdateModel.mockReset();
  });

  it.each(["success", "failure"])("keeps the original flight across a remount and releases it after %s", async (outcome) => {
    let resolve!: (value: unknown) => void;
    let reject!: (error: Error) => void;
    api.adminVerifyPage.mockReturnValue(new Promise((res, rej) => { resolve = res; reject = rej; }));
    const pending = render().mutateAsync().catch(() => undefined);
    // Await the real MutationObserver's dispatch, not a fabricated pending flag.
    await vi.waitFor(() => expect(api.adminVerifyPage).toHaveBeenCalledTimes(1));
    expect(api.adminVerifyPage).toHaveBeenCalledWith({ params: { pageLabel: "synthetic-page" } });
    hooks.values = [];
    expect(render("renamed-synthetic-page", 1).isPending).toBe(true);
    hooks.values = [];
    expect(render("other-page", 2).isPending).toBe(false);
    if (outcome === "success") resolve({ verified: true });
    else reject(new Error("Synthetic verification failure"));
    await pending;
    hooks.values = [];
    expect(render("renamed-synthetic-page", 1).isPending).toBe(false);
  });

  it("waits for both reorder writes before reporting a partial failure to the catalog", async () => {
    let rejectFirst!: (error: Error) => void;
    let resolveSecond!: (value: unknown) => void;
    api.adminUpdateModel
      .mockReturnValueOnce(new Promise((_resolve, reject) => { rejectFirst = reject; }))
      .mockReturnValueOnce(new Promise((resolve) => { resolveSecond = resolve; }));
    const mutation = useAdminReorderModels();
    const settled = vi.fn();
    const pending = mutation.mutateAsync([{ slug: "first", sortOrder: 1 }, { slug: "second", sortOrder: 0 }]).catch(settled);
    await vi.waitFor(() => expect(api.adminUpdateModel).toHaveBeenCalledTimes(2));
    const error = new Error("First reorder rejected");
    rejectFirst(error);
    await Promise.resolve();
    await Promise.resolve();
    expect(settled).not.toHaveBeenCalled();
    resolveSecond({ id: 2, slug: "second", name: "Second" });
    await pending;
    expect(settled).toHaveBeenCalledWith(error);
    expect(api.adminUpdateModel).toHaveBeenCalledTimes(2);
  });
});
