import type * as ReactQuery from "../apps/dashboard/node_modules/@tanstack/react-query/build/modern/index.js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { QueryClient, type MutationObserverOptions } from "../apps/dashboard/node_modules/@tanstack/react-query/build/modern/index.js";

const hooks = vi.hoisted(() => ({ client: null as unknown }));
const api = vi.hoisted(() => ({ notificationsTestMessage: vi.fn(), notificationsReportSend: vi.fn() }));
vi.mock("../apps/dashboard/node_modules/@tanstack/react-query/build/modern/index.js", async original => {
  const actual = await original<typeof ReactQuery>();
  return { ...actual, useQueryClient: () => hooks.client,
    useQuery: ({ queryKey, initialData }: { queryKey: string[]; initialData?: () => unknown }) => {
      const client = hooks.client as QueryClient;
      if (!client.getQueryState(queryKey) && initialData) client.setQueryData(queryKey, initialData());
      return { data: client.getQueryData(queryKey) };
    },
    useIsMutating: (filters: ReactQuery.MutationFilters) => (hooks.client as QueryClient).isMutating(filters),
    useMutation: (options: MutationObserverOptions<unknown, Error, unknown>) => {
      const observer = new actual.MutationObserver(hooks.client as QueryClient, options);
      return { ...observer.getCurrentResult(), mutateAsync: observer.mutate.bind(observer) };
    },
  };
});
vi.mock("../apps/dashboard/src/api/sdk.ts", () => ({ kernel: api }));
import { useSendTestMessage, useSendReport, useUpdateNotificationsSettings } from "../apps/dashboard/src/api/adminNotifications.ts";

function remount<T>(hook: () => T) { return hook(); }
beforeEach(() => {
  hooks.client = new QueryClient({ defaultOptions: { mutations: { retry: false, gcTime: Infinity } } });
  (hooks.client as QueryClient).setQueryData(["auth", "me"], { user: { id: 7 } });
  (hooks.client as QueryClient).setQueryData(["notifications", "settings"], { chatId: "synthetic-recipient" });
  const values = new Map<string, string>();
  vi.stubGlobal("window", { sessionStorage: { getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => values.set(key, value) } });
  api.notificationsTestMessage.mockReset();
  api.notificationsReportSend.mockReset();
});
afterEach(() => { vi.unstubAllGlobals(); });
describe("notification delivery lifetime", () => {
  it.each(["success", "failure"])("keeps sending blocked after switching tabs until %s", async outcome => {
    let resolve!: (value: unknown) => void;
    let reject!: (error: Error) => void;
    api.notificationsTestMessage.mockReturnValue(new Promise((done, fail) => { resolve = done; reject = fail; }));
    const pending = remount(useSendTestMessage).mutateAsync().catch(() => undefined);
    await vi.waitFor(() => expect(api.notificationsTestMessage).toHaveBeenCalledTimes(1));
    expect(remount(useSendReport).isPending).toBe(true);
    expect(remount(useUpdateNotificationsSettings).isPending).toBe(true);
    if (outcome === "success") resolve({ status: "sent", error: null });
    else reject(new Error("Synthetic failure"));
    await pending;
    expect(remount(useSendReport).isPending).toBe(false);
    expect(remount(useSendReport).delivery?.phase).toBe(outcome === "success" ? "sent" : "unknown");
    expect(remount(useSendReport).deliveryBlocked).toBe(outcome === "failure");
    expect(api.notificationsTestMessage).toHaveBeenCalledTimes(1);
  });
  it("keeps an unknown outcome after a full cache reload and requires explicit reconciliation before a separate send", async () => {
    api.notificationsTestMessage.mockRejectedValueOnce(new Error("Synthetic network failure"));
    await remount(useSendTestMessage).mutateAsync().catch(() => undefined);
    const original = remount(useSendTestMessage).delivery!;
    (hooks.client as QueryClient).clear();
    (hooks.client as QueryClient).setQueryData(["auth", "me"], { user: { id: 7 } });
    const restored = remount(useSendReport);
    expect(restored.delivery).toMatchObject({ id: original.id, kind: "test", recipient: "synthetic-recipient", phase: "unknown" });
    await restored.mutateAsync().catch(() => undefined);
    expect(api.notificationsReportSend).not.toHaveBeenCalled();
    expect(restored.allowSeparateDelivery(false)).toBe(false);
    expect(restored.allowSeparateDelivery(true)).toBe(true);
    expect(remount(useSendReport).deliveryHistory).toMatchObject([{ id: original.id, phase: "unknown" }]);
    api.notificationsReportSend.mockResolvedValue({ status: "sent", error: null, reportDate: "2026-09-10" });
    await remount(useSendReport).mutateAsync();
    expect(api.notificationsReportSend).toHaveBeenCalledTimes(1);
    expect(remount(useSendTestMessage).delivery).toMatchObject({ kind: "report", phase: "sent", reportDate: "2026-09-10" });
  });
  it("restores a real in-flight send as unknown after reload and settles its archived receipt without overwriting a new request", async () => {
    let resolve!: (value: unknown) => void;
    api.notificationsTestMessage.mockReturnValue(new Promise(done => { resolve = done; }));
    const pending = remount(useSendTestMessage).mutateAsync();
    await vi.waitFor(() => expect(api.notificationsTestMessage).toHaveBeenCalledTimes(1));
    const original = remount(useSendTestMessage).delivery!;
    (hooks.client as QueryClient).clear();
    (hooks.client as QueryClient).setQueryData(["auth", "me"], { user: { id: 7 } });
    const reloaded = remount(useSendReport); expect(reloaded.delivery?.phase).toBe("unknown");
    expect(reloaded.allowSeparateDelivery(true)).toBe(true);
    api.notificationsReportSend.mockResolvedValue({ status: "sent", error: null, reportDate: "2026-09-10" });
    await remount(useSendReport).mutateAsync();
    const next = remount(useSendReport).delivery!;
    resolve({ status: "sent", error: null }); await pending;
    remount(useSendReport).recoverDelivery();
    expect(remount(useSendReport).delivery?.id).toBe(next.id);
    expect(remount(useSendReport).deliveryHistory).toMatchObject([{ id: original.id, phase: "sent" }]);
  });
});
