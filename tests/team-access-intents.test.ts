import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  MutationObserver,
  QueryObserver,
  QueryClient,
  type MutationObserverOptions,
} from "../apps/dashboard/node_modules/@tanstack/react-query/build/modern/index.js";

/**
 * Decision 350 §4.4 — which route each button of the Team card actually fires.
 *
 * The labels are the promise the owner acts on ("завершить все входы" when
 * firing someone), and a label wired to the wrong route is the one bug in this
 * tab that loses money or leaves access alive. The rendering tests pin the
 * words; this one pins the call under each word, driving the real mutation
 * options through the installed MutationObserver with only the SDK boundary
 * mocked — the same pattern as tests/adversarial-mutation-intents.test.ts.
 *
 * The labels come from the same constants the card renders, so the two halves
 * cannot drift apart silently.
 */

const sdk = vi.hoisted(() => ({
  adminCreateInvite: vi.fn(),
  adminCreateAccountLink: vi.fn(),
  adminRevokeAccountLink: vi.fn(),
  adminRevokeDeviceToken: vi.fn(),
  adminRevokeDeviceTokens: vi.fn(),
  adminTerminateAllAccess: vi.fn(),
  adminSetDeviceTokenHarvestCapability: vi.fn(),
  adminDeactivateUser: vi.fn(),
  adminDeleteUser: vi.fn(),
  adminReactivateUser: vi.fn(),
  adminListUsers: vi.fn(),
  // The one survivor of the old three-call provisioning: assigning a page is
  // still a real operation, and the invite test proves the atomic invite does
  // NOT fall back to it. The other three (`adminCreateUser`, `adminSetPassword`,
  // `adminIssueApiKey`) no longer exist on the SDK at all since Decision 369 —
  // asserting `not.toHaveBeenCalled` on a hand-made mock of a deleted operation
  // proves nothing, so they are gone from here too.
  adminAssignPage: vi.fn(),
}));
vi.mock("../apps/dashboard/src/api/sdk.ts", () => ({ kernel: sdk }));

import {
  createAccountLinkMutationOptions,
  createInviteMutationOptions,
  deleteUserMutationOptions,
  revokeAllDevicesMutationOptions,
  revokeDeviceMutationOptions,
  revokeLinkMutationOptions,
  setHarvestCapabilityMutationOptions,
  terminateAccessMutationOptions,
} from "../apps/dashboard/src/api/adminUsers.ts";
import { REVOCATION_LABEL } from "../apps/dashboard/src/pages/settings/team/teamView.ts";

const USER = 17;
const clients: QueryClient[] = [];

function makeClient() {
  const client = new QueryClient({ defaultOptions: { mutations: { gcTime: Infinity } } });
  clients.push(client);
  return client;
}

async function run<TData, TVariables>(
  client: QueryClient,
  options: MutationObserverOptions<TData, Error, TVariables, unknown>,
  variables: TVariables,
) {
  const observer = new MutationObserver(client, options);
  const unsubscribe = observer.subscribe(() => {});
  try {
    await observer.mutate(variables);
  } finally {
    unsubscribe();
  }
}

beforeEach(() => {
  for (const fn of Object.values(sdk)) fn.mockReset().mockResolvedValue({ ok: true });
});
afterEach(() => {
  for (const client of clients.splice(0)) client.clear();
  vi.useRealTimers();
});

async function verifySecretLifetime<TData, TVariables>(
  client: QueryClient,
  options: MutationObserverOptions<TData, Error, TVariables, unknown>,
  variables: TVariables,
  result: TData,
) {
  const observer = new MutationObserver(client, options);
  const unsubscribe = observer.subscribe(() => {});
  const reveal = vi.fn();
  try {
    await observer.mutate(variables, { onSuccess: reveal });
    await vi.runOnlyPendingTimersAsync();
    // The tab still owns the observer while the reveal is open. A short
    // cache lifetime must not lose the only copy of the issued secret.
    expect(reveal).toHaveBeenCalledOnce();
    expect(reveal.mock.calls[0]?.[0]).toEqual(result);
    expect(observer.getCurrentResult().data).toEqual(result);
    expect(client.getMutationCache().getAll().map((mutation) => mutation.state.data)).toEqual([result]);

    observer.reset();
    await vi.runOnlyPendingTimersAsync();

    expect(observer.getCurrentResult().data).toBeUndefined();
    // This checks the actual cache, not just the detached observer's result:
    // reset alone otherwise leaves the secret in a retained mutation.
    expect(client.getMutationCache().getAll()).toEqual([]);
  } finally {
    unsubscribe();
  }
}

describe("issued links leave the mutation cache when their reveal closes", () => {
  const link = {
    id: 42,
    kind: "invite" as const,
    keyPrefix: "test-only",
    token: "one-time-test-secret",
    expiresAt: "2026-09-22T12:00:00.000Z",
  };

  it("keeps a new account invitation available until reset, then evicts its secret", async () => {
    vi.useFakeTimers();
    const client = makeClient();
    const result = {
      user: {
        id: USER,
        username: "Nikita",
        role: "chatter" as const,
        mustChangePassword: false,
        assignedPages: [],
        apiKeyStatus: null,
        disabledAt: null,
        deletedAt: null,
        lastActiveAt: null,
        registrationState: "invited" as const,
      },
      link,
    };
    sdk.adminCreateInvite.mockResolvedValueOnce(result);
    await verifySecretLifetime(client, createInviteMutationOptions(client), {
      username: "Nikita", pageLabels: [],
    }, result);
  });

  it("keeps a replacement link available until reset, then evicts its secret", async () => {
    vi.useFakeTimers();
    const client = makeClient();
    sdk.adminCreateAccountLink.mockResolvedValueOnce(link);
    await verifySecretLifetime(client, createAccountLinkMutationOptions(client), {
      userId: USER, kind: "invite",
    }, link);
  });
});

describe("the three revocations fire the three routes (§4.4)", () => {
  it(`«${REVOCATION_LABEL.device}» revokes exactly that one sign-in`, async () => {
    const client = makeClient();
    client.setQueryData(["admin", "users", USER, "devices"], []);
    client.setQueryData(["admin", "users", 999, "devices"], []);

    await run(client, revokeDeviceMutationOptions(client, USER), 7);

    expect(sdk.adminRevokeDeviceToken).toHaveBeenCalledExactlyOnceWith({
      params: { userId: USER, tokenId: 7 },
    });
    expect(sdk.adminRevokeDeviceTokens).not.toHaveBeenCalled();
    expect(sdk.adminTerminateAllAccess).not.toHaveBeenCalled();
    expect(client.getQueryState(["admin", "users", USER, "devices"])?.isInvalidated).toBe(true);
    expect(client.getQueryState(["admin", "users", 999, "devices"])?.isInvalidated).toBe(false);
  });

  it(`«${REVOCATION_LABEL.allDevices}» revokes every device and nothing else`, async () => {
    const client = makeClient();
    client.setQueryData(["admin", "users", USER, "links"], []);

    await run(client, revokeAllDevicesMutationOptions(client, USER), undefined);

    expect(sdk.adminRevokeDeviceTokens).toHaveBeenCalledExactlyOnceWith({ params: { userId: USER } });
    expect(sdk.adminRevokeDeviceToken).not.toHaveBeenCalled();
    expect(sdk.adminTerminateAllAccess).not.toHaveBeenCalled();
    // Links are untouched by this one, so their cache entry stays valid.
    expect(client.getQueryState(["admin", "users", USER, "links"])?.isInvalidated).toBe(false);
  });

  it(`«${REVOCATION_LABEL.allAccess}» terminates access and refreshes devices and links`, async () => {
    const client = makeClient();
    client.setQueryData(["admin", "users", USER, "devices"], []);
    client.setQueryData(["admin", "users", USER, "links"], []);

    await run(client, terminateAccessMutationOptions(client, USER), undefined);

    expect(sdk.adminTerminateAllAccess).toHaveBeenCalledExactlyOnceWith({ params: { userId: USER } });
    expect(sdk.adminRevokeDeviceToken).not.toHaveBeenCalled();
    expect(sdk.adminRevokeDeviceTokens).not.toHaveBeenCalled();
    expect(sdk.adminDeactivateUser).not.toHaveBeenCalled();
    expect(client.getQueryState(["admin", "users", USER, "devices"])?.isInvalidated).toBe(true);
    expect(client.getQueryState(["admin", "users", USER, "links"])?.isInvalidated).toBe(true);
  });
});

describe("inviting is one call", () => {
  it("creates the account, its pages and the link with a single adminCreateInvite", async () => {
    const client = makeClient();
    client.setQueryData(["admin", "users"], []);

    await run(client, createInviteMutationOptions(client), {
      username: "sveta",
      role: "chatter" as const,
      pageLabels: ["lora", "lora-of"],
      expiresInHours: 168,
    });

    expect(sdk.adminCreateInvite).toHaveBeenCalledExactlyOnceWith({
      body: {
        username: "sveta",
        role: "chatter",
        pageLabels: ["lora", "lora-of"],
        expiresInHours: 168,
      },
    });
    // The provisioning dance this replaced (#116) was three calls that could
    // leave a half-made account behind. The invite is ONE call: no separate
    // page assignment rides along behind it.
    expect(sdk.adminAssignPage).not.toHaveBeenCalled();
    expect(client.getQueryState(["admin", "users"])?.isInvalidated).toBe(true);
  });
});

describe("links", () => {
  it("«Сбросить пароль ссылкой» asks for a password_reset link for that person", async () => {
    const client = makeClient();
    await run(client, createAccountLinkMutationOptions(client), { userId: USER, kind: "password_reset" as const });

    expect(sdk.adminCreateAccountLink).toHaveBeenCalledExactlyOnceWith({
      params: { userId: USER },
      body: { kind: "password_reset" },
    });
  });

  it("«Отправить приглашение заново» asks for an invite link for that person", async () => {
    const client = makeClient();
    await run(client, createAccountLinkMutationOptions(client), { userId: USER, kind: "invite" as const });

    expect(sdk.adminCreateAccountLink).toHaveBeenCalledExactlyOnceWith({
      params: { userId: USER },
      body: { kind: "invite" },
    });
  });

  it("«Отозвать ссылку» revokes exactly that link", async () => {
    const client = makeClient();
    client.setQueryData(["admin", "users", USER, "links"], []);

    await run(client, revokeLinkMutationOptions(client, USER), 42);

    expect(sdk.adminRevokeAccountLink).toHaveBeenCalledExactlyOnceWith({
      params: { userId: USER, linkId: 42 },
    });
    expect(client.getQueryState(["admin", "users", USER, "links"])?.isInvalidated).toBe(true);
  });
});

describe("harvest binding", () => {
  it("binds and removes a machine on one sign-in", async () => {
    const client = makeClient();
    await run(client, setHarvestCapabilityMutationOptions(client, USER), {
      tokenId: 3,
      machineId: "3f2504e0-4f89-11d3-9a0c-0305e82c3301",
    });
    expect(sdk.adminSetDeviceTokenHarvestCapability).toHaveBeenCalledExactlyOnceWith({
      params: { userId: USER, tokenId: 3 },
      body: { machineId: "3f2504e0-4f89-11d3-9a0c-0305e82c3301" },
    });

    sdk.adminSetDeviceTokenHarvestCapability.mockClear();
    await run(client, setHarvestCapabilityMutationOptions(client, USER), { tokenId: 3, machineId: null });
    expect(sdk.adminSetDeviceTokenHarvestCapability).toHaveBeenCalledExactlyOnceWith({
      params: { userId: USER, tokenId: 3 },
      body: { machineId: null },
    });
  });
});


describe("account ID ownership when a login is reused", () => {
  it.for(["lost response", "stale target"])("reconciles a deleted identity after %s without touching its replacement", async (failure) => {
    const client = makeClient();
    const original = { id: 17, username: "Nikita" };
    const replacement = { id: 29, username: "Nikita" };
    client.setQueryData(["admin", "users"], [original]);
    client.setQueryData(["admin", "users", 17, "devices"], [{ id: 170 }]);
    client.setQueryData(["admin", "users", 29, "devices"], [{ id: 290 }]);
    const observer = new QueryObserver(client, {
      queryKey: ["admin", "users"], queryFn: () => sdk.adminListUsers(), staleTime: Infinity, retry: false,
    });
    const unsubscribe = observer.subscribe(() => {});
    sdk.adminListUsers.mockResolvedValue([replacement]);
    sdk.adminDeleteUser.mockRejectedValueOnce(Object.assign(new Error(failure), {
      status: failure === "stale target" ? 404 : undefined,
    }));
    try {
      await expect(run(client, deleteUserMutationOptions(client, 17), undefined)).rejects.toThrow(failure);
      expect(sdk.adminListUsers).toHaveBeenCalledOnce();
      expect(client.getQueryData(["admin", "users"])).toEqual([replacement]);
      expect(client.getQueryData(["admin", "users", 17, "devices"])).toBeUndefined();
      expect(client.getQueryData(["admin", "users", 29, "devices"])).toEqual([{ id: 290 }]);
      expect(sdk.adminDeleteUser).toHaveBeenCalledExactlyOnceWith({ params: { userId: 17 } });
    } finally {
      unsubscribe();
    }
  });

  it("retains an account when a failed deletion is confirmed not to have committed", async () => {
    const client = makeClient();
    const original = { id: 17, username: "Nikita" };
    client.setQueryData(["admin", "users"], [original]);
    const observer = new QueryObserver(client, {
      queryKey: ["admin", "users"], queryFn: () => sdk.adminListUsers(), staleTime: Infinity, retry: false,
    });
    const unsubscribe = observer.subscribe(() => {});
    sdk.adminListUsers.mockResolvedValue([original]);
    sdk.adminDeleteUser.mockRejectedValueOnce(new Error("Request failed"));
    try {
      await expect(run(client, deleteUserMutationOptions(client, 17), undefined)).rejects.toThrow("Request failed");
      expect(sdk.adminListUsers).toHaveBeenCalledOnce();
      expect(client.getQueryData(["admin", "users"])).toEqual([original]);
    } finally {
      unsubscribe();
    }
  });

  it("keeps the original error and cached identity if reconciliation also fails", async () => {
    const client = makeClient();
    const original = { id: 17, username: "Nikita" };
    client.setQueryData(["admin", "users"], [original]);
    client.setQueryData(["admin", "users", 17, "devices"], [{ id: 170 }]);
    const observer = new QueryObserver(client, {
      queryKey: ["admin", "users"], queryFn: () => sdk.adminListUsers(), staleTime: Infinity, retry: false,
    });
    const unsubscribe = observer.subscribe(() => {});
    sdk.adminListUsers.mockRejectedValue(new Error("Still offline"));
    sdk.adminDeleteUser.mockRejectedValueOnce(new Error("Lost deletion response"));
    try {
      await expect(run(client, deleteUserMutationOptions(client, 17), undefined)).rejects.toThrow("Lost deletion response");
      expect(client.getQueryData(["admin", "users"])).toEqual([original]);
      expect(client.getQueryData(["admin", "users", 17, "devices"])).toEqual([{ id: 170 }]);
      expect(observer.getCurrentResult().isError).toBe(true);
    } finally {
      unsubscribe();
    }
  });

  it("deletes only the old ID and removes only its private caches", async () => {
    const client = makeClient();
    const oldId = 17;
    const replacementId = 29;
    client.setQueryData(["admin", "users"], [
      { id: oldId, username: "Nikita" },
      { id: replacementId, username: "Nikita" },
    ]);
    for (const id of [oldId, replacementId]) {
      client.setQueryData(["admin", "users", id, "devices"], [{ id: id * 10 }]);
      client.setQueryData(["admin", "users", id, "links"], [{ id: id * 100 }]);
    }

    await run(client, deleteUserMutationOptions(client, oldId), undefined);

    expect(sdk.adminDeleteUser).toHaveBeenCalledExactlyOnceWith({ params: { userId: oldId } });
    expect(client.getQueryData(["admin", "users"])).toEqual([{ id: replacementId, username: "Nikita" }]);
    expect(client.getQueryData(["admin", "users", oldId, "devices"])).toBeUndefined();
    expect(client.getQueryData(["admin", "users", oldId, "links"])).toBeUndefined();
    expect(client.getQueryData(["admin", "users", replacementId, "devices"])).toEqual([{ id: 290 }]);
    expect(client.getQueryState(["admin", "users", replacementId, "links"])?.isInvalidated).toBe(false);
  });

  it("a failed stale deletion never changes the replacement account or its caches", async () => {
    const client = makeClient();
    const replacement = { id: 29, username: "Nikita" };
    client.setQueryData(["admin", "users"], [replacement]);
    client.setQueryData(["admin", "users", replacement.id, "devices"], [{ id: 290 }]);
    sdk.adminDeleteUser.mockRejectedValueOnce(new Error("Account no longer exists"));

    await expect(run(client, deleteUserMutationOptions(client, 17), undefined)).rejects.toThrow("Account no longer exists");

    expect(sdk.adminDeleteUser).toHaveBeenCalledExactlyOnceWith({ params: { userId: 17 } });
    expect(client.getQueryData(["admin", "users"])).toEqual([replacement]);
    expect(client.getQueryData(["admin", "users", replacement.id, "devices"])).toEqual([{ id: 290 }]);
  });

  it("a pending link retains its original identity when the tab's observer options change", async () => {
    const client = makeClient();
    client.setQueryData(["admin", "users", 17, "links"], []);
    client.setQueryData(["admin", "users", 29, "links"], []);
    let release!: (value: { token: string }) => void;
    sdk.adminCreateAccountLink.mockImplementationOnce(() => new Promise((resolve) => { release = resolve; }));
    const observer = new MutationObserver(client, createAccountLinkMutationOptions(client));
    const unsubscribe = observer.subscribe(() => {});
    try {
      const pending = observer.mutate({ userId: 17, kind: "password_reset" });
      await vi.waitFor(() => expect(sdk.adminCreateAccountLink).toHaveBeenCalled());
      // Re-rendering the long-lived Team tab updates options without changing
      // the account captured in this mutation's variables.
      observer.setOptions(createAccountLinkMutationOptions(client));
      release({ token: "one-time-secret" });
      await pending;
      expect(sdk.adminCreateAccountLink).toHaveBeenCalledExactlyOnceWith({
        params: { userId: 17 }, body: { kind: "password_reset" },
      });
      expect(client.getQueryState(["admin", "users", 17, "links"])?.isInvalidated).toBe(true);
      expect(client.getQueryState(["admin", "users", 29, "links"])?.isInvalidated).toBe(false);
    } finally {
      unsubscribe();
    }
  });
});
