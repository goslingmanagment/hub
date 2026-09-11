import type * as ReactQuery from "../apps/dashboard/node_modules/@tanstack/react-query/build/modern/index.js";
import { QueryClient, type MutationObserver, type MutationObserverOptions } from "../apps/dashboard/node_modules/@tanstack/react-query/build/modern/index.js";
import { beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({ client: null as unknown, observer: null as unknown }));
const api = vi.hoisted(() => ({ workboardV2UndoContact: vi.fn(), workboardV2Unsnooze: vi.fn(), workboardV2Contact: vi.fn(), workboardV2AiSettings: vi.fn() }));
vi.mock("../apps/dashboard/src/api/sdk.ts", () => ({ kernel: api }));
vi.mock("../apps/dashboard/node_modules/@tanstack/react-query/build/modern/index.js", async importOriginal => {
  const actual = await importOriginal<typeof ReactQuery>();
  return { ...actual, useQueryClient: () => state.client,
    useIsMutating: (filters: ReactQuery.MutationFilters) => (state.client as QueryClient).isMutating(filters),
    useMutation: (options: MutationObserverOptions<unknown, Error, unknown>) => {
      let observer = state.observer as MutationObserver<unknown, Error, unknown> | null;
      if (!observer) { observer = new actual.MutationObserver(state.client as QueryClient, options); state.observer = observer; }
      else observer.setOptions(options);
      return { ...observer.getCurrentResult(), mutateAsync: observer.mutate.bind(observer) };
    },
  };
});
import { useWorkboardV2Contact, useWorkboardV2UndoContact, useWorkboardV2Unsnooze, useWorkboardV2AiSettings } from "../apps/dashboard/src/api/workboard.ts";

beforeEach(() => { state.client = new QueryClient({ defaultOptions: { mutations: { retry: false } } }); state.observer = null; vi.clearAllMocks(); });

describe("Workboard mutation account custody", () => {
  it.each([[useWorkboardV2UndoContact, api.workboardV2UndoContact], [useWorkboardV2Unsnooze, api.workboardV2Unsnooze]] as const)("keeps a toast's original target after observer options change", async (hook, request) => {
    const undo = hook().mutateAsync;
    hook(); // The route has rendered again; the observer now has the latest options.
    await undo({ pageLabel: "original-account", fanId: 7 });
    expect(request).toHaveBeenCalledExactlyOnceWith({ params: { pageLabel: "original-account", fanId: 7 } });
  });
  it("invalidates the original account after a pending contact finishes on another page", async () => {
    let resolve!: (value: unknown) => void;
    api.workboardV2Contact.mockReturnValue(new Promise(r => { resolve = r; }));
    const invalidate = vi.spyOn(state.client as QueryClient, "invalidateQueries");
    const pending = useWorkboardV2Contact("original-account").mutateAsync({ fanId: 7 });
    await vi.waitFor(() => expect(api.workboardV2Contact).toHaveBeenCalledTimes(1));
    useWorkboardV2Contact("other-account");
    resolve({ ok: true });
    await pending;
    expect(invalidate).toHaveBeenCalledWith({ queryKey: ["workboard-v2", "original-account"] });
    expect(invalidate).not.toHaveBeenCalledWith({ queryKey: ["workboard-v2", "other-account"] });
  });
  it("shows a pending AI settings save after leaving and returning to the account", async () => {
    let resolve!: (value: unknown) => void;
    api.workboardV2AiSettings.mockReturnValue(new Promise(r => { resolve = r; }));
    const pending = useWorkboardV2AiSettings("original-account").mutateAsync({ enabled: null, dailyCapMax: 100, model: null });
    await vi.waitFor(() => expect(api.workboardV2AiSettings).toHaveBeenCalledTimes(1));
    state.observer = null;
    expect(useWorkboardV2AiSettings("original-account").isPending).toBe(true);
    state.observer = null;
    expect(useWorkboardV2AiSettings("other-account").isPending).toBe(false);
    resolve({ settings: {} }); await pending;
  });
  it("does not repopulate an AI report after logout and a new session", async () => {
    const client = state.client as QueryClient;
    client.setQueryData(["auth", "me"], { user: { id: 1 } });
    let resolve!: (value: unknown) => void;
    api.workboardV2AiSettings.mockReturnValue(new Promise(r => { resolve = r; }));
    const pending = useWorkboardV2AiSettings("original-account").mutateAsync({ enabled: null, dailyCapMax: 100, model: null });
    await vi.waitFor(() => expect(api.workboardV2AiSettings).toHaveBeenCalledTimes(1));
    client.clear();
    client.setQueryData(["auth", "me"], { user: { id: 2 } });
    resolve({ privateOriginalReport: true });
    await pending;
    expect(client.getQueryData(["workboard-v2-ai", "original-account"])).toBeUndefined();
  });

});
