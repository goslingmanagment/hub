import type * as TanstackReactQuery from "../apps/dashboard/node_modules/@tanstack/react-query/build/modern/index.js";
import { QueryClient, type MutationFilters, type MutationObserver, type MutationObserverOptions } from "../apps/dashboard/node_modules/@tanstack/react-query/build/modern/index.js";
import { beforeEach, describe, expect, it, vi } from "vitest";

// Real TanStack mutation/cache lifecycle with a small React adapter, matching
// dashboard-settings-verify.test.ts. Fresh hook slots simulate tab remounts.
const hooks = vi.hoisted(() => ({ values: [] as unknown[], cursor: 0, client: null as unknown }));
const api = vi.hoisted(() => ({ adminIssueApiKey: vi.fn(), agentKeyCreate: vi.fn(), adminSetPassword: vi.fn(), adminAssignPage: vi.fn(), adminUnassignPage: vi.fn() }));
type CachedMutation = ReturnType<ReturnType<QueryClient["getMutationCache"]>["getAll"]>[number];
vi.mock("../apps/dashboard/node_modules/@tanstack/react-query/build/modern/index.js", async (importOriginal) => {
  const actual = await importOriginal<typeof TanstackReactQuery>();
  return {
    ...actual,
    useQueryClient: () => hooks.client,
    useIsMutating: (filters: MutationFilters) => (hooks.client as QueryClient).isMutating(filters),
    useMutationState: (options: { filters: MutationFilters; select: (mutation: CachedMutation) => unknown }) => (hooks.client as QueryClient).getMutationCache().findAll(options.filters).map(options.select),
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
import { useAdminIssueApiKey, useIssuedUserApiKeys, useAdminSetPassword, useAdminAssignPage, useAdminUnassignPage } from "../apps/dashboard/src/api/adminUsers.ts";
import { useCreateAgentKey, useIssuedAgentKeys } from "../apps/dashboard/src/api/agentKeys.ts";

const userResponse = { key: "SYNTHETIC_USER_SECRET", keyPrefix: "SYNTHETIC_USER", assignedPages: [] };
const agentResponse = {
  token: "SYNTHETIC_AGENT_SECRET",
  key: { id: 1, name: "Synthetic Agent", keyPrefix: "SYNTHETIC_AGENT", capabilities: ["read:messages"], pageLabels: ["synthetic"], dailyRequestBudget: 5000, dailyRowBudget: 500000, expiresAt: "2026-12-01T00:00:00Z", createdAt: "2026-09-11T00:00:00Z", revokedAt: null, lastUsedAt: null, isActive: true },
};
function begin(kind: string) {
  hooks.cursor = 0;
  return kind === "user"
    ? useAdminIssueApiKey("synthetic-user").mutateAsync({})
    : useCreateAgentKey().mutateAsync({ name: "Synthetic Agent", capabilities: ["read:messages"], pageLabels: ["synthetic"], dailyRequestBudget: 5000, dailyRowBudget: 500000, expiresInDays: 90 });
}
function pending(kind: string) {
  hooks.cursor = 0;
  return kind === "user" ? useAdminIssueApiKey("synthetic-user").isPending : useCreateAgentKey().isPending;
}
function receipts(kind: string) {
  hooks.cursor = 0;
  return kind === "user" ? useIssuedUserApiKeys() : useIssuedAgentKeys();
}
function remount() { hooks.values = []; hooks.cursor = 0; }
function deferred() {
  let resolve!: (value: unknown) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

beforeEach(() => {
  remount(); hooks.client = new QueryClient({ defaultOptions: { mutations: { retry: false, gcTime: Infinity } } });
  vi.resetAllMocks();
});

describe.each(["user", "agent"])("one-time %s key response custody", (kind) => {
  it("restores the in-flight state and successful response across remounts until acknowledgement", async () => {
    const request = deferred(); const method = kind === "user" ? api.adminIssueApiKey : api.agentKeyCreate;
    const response = kind === "user" ? userResponse : agentResponse;
    method.mockReturnValue(request.promise);
    const submitted = begin(kind);
    await vi.waitFor(() => expect(method).toHaveBeenCalledTimes(1));
    remount(); expect(pending(kind)).toBe(true); expect(receipts(kind).issued).toHaveLength(0);
    request.resolve(response); await submitted;
    remount(); expect(pending(kind)).toBe(false);
    const recovered = receipts(kind);
    expect(recovered.issued).toHaveLength(1);
    expect(recovered.issued[0]!.result).toEqual(response);
    if (kind === "user") expect(useIssuedUserApiKeys().issued[0]!.username).toBe("synthetic-user");
    recovered.acknowledge(recovered.issued[0]!.id);
    remount(); expect(receipts(kind).issued).toHaveLength(0);
    expect(method).toHaveBeenCalledTimes(1);
  });

  it("retains no secret receipt after session clear, including a response arriving after logout", async () => {
    const request = deferred(); const method = kind === "user" ? api.adminIssueApiKey : api.agentKeyCreate;
    method.mockReturnValue(request.promise);
    const submitted = begin(kind);
    await vi.waitFor(() => expect(method).toHaveBeenCalledTimes(1));
    (hooks.client as QueryClient).clear(); remount();
    request.resolve(kind === "user" ? userResponse : agentResponse); await submitted;
    expect(receipts(kind).issued).toHaveLength(0);
    expect(pending(kind)).toBe(false);
    method.mockResolvedValue(kind === "user" ? userResponse : agentResponse);
    await begin(kind); expect(receipts(kind).issued).toHaveLength(1);
    (hooks.client as QueryClient).clear(); remount();
    expect(receipts(kind).issued).toHaveLength(0);
  });

  it("releases a failed request after remount without inventing a successful key", async () => {
    const request = deferred(); const method = kind === "user" ? api.adminIssueApiKey : api.agentKeyCreate;
    method.mockReturnValue(request.promise);
    const submitted = begin(kind).catch(() => undefined);
    await vi.waitFor(() => expect(method).toHaveBeenCalledTimes(1));
    remount(); expect(pending(kind)).toBe(true);
    request.reject(new Error("Synthetic key rejected")); await submitted;
    remount(); expect(pending(kind)).toBe(false); expect(receipts(kind).issued).toHaveLength(0);
    expect(method).toHaveBeenCalledTimes(1);
  });
});

// Password writes revoke sessions; an older request must not race a newer
// password after Browser Back unmounts the original form. Assignment controls
// need the same request lifetime across a settings-tab remount.
describe.each(["password", "assign", "unassign"])("%s access write lifetime", (action) => {
  function state() {
    hooks.cursor = 0;
    if (action === "password") return useAdminSetPassword("synthetic-user").isPending;
    if (action === "assign") return useAdminAssignPage("synthetic-user").isPending;
    return useAdminUnassignPage("synthetic-user").isPending;
  }
  function write() {
    hooks.cursor = 0;
    if (action === "password") return useAdminSetPassword("synthetic-user").mutateAsync({ password: "SYNTHETIC_ONLY", mustChangePassword: false });
    if (action === "assign") return useAdminAssignPage("synthetic-user").mutateAsync({ pageLabel: "synthetic-page" });
    return useAdminUnassignPage("synthetic-user").mutateAsync("synthetic-page");
  }
  it.each(["success", "failure"])("restores pending after remount and releases it on %s", async (outcome) => {
    const request = deferred();
    const method = action === "password" ? api.adminSetPassword : action === "assign" ? api.adminAssignPage : api.adminUnassignPage;
    method.mockReturnValue(request.promise);
    const submitted = write().catch(() => undefined);
    await vi.waitFor(() => expect(method).toHaveBeenCalledTimes(1));
    remount(); expect(state()).toBe(true);
    hooks.cursor = 0;
    expect(useAdminSetPassword("other-user").isPending).toBe(false);
    if (outcome === "success") request.resolve({}); else request.reject(new Error("Synthetic access write rejected"));
    await submitted;
    remount(); expect(state()).toBe(false);
    expect(method).toHaveBeenCalledTimes(1);
  });
});
