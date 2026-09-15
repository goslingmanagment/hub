import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  MutationObserver,
  QueryClient,
  type MutationObserverOptions,
} from "../apps/dashboard/node_modules/@tanstack/react-query/build/modern/index.js";

/**
 * Decision 348 §4.4 — which route each button of the Team card actually fires.
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
  adminReactivateUser: vi.fn(),
  adminListUsers: vi.fn(),
  // Everything the old three-call provisioning used. Present so the invite
  // test can prove they are NOT reached any more.
  adminCreateUser: vi.fn(),
  adminSetPassword: vi.fn(),
  adminAssignPage: vi.fn(),
  adminIssueApiKey: vi.fn(),
  adminRevokeApiKeys: vi.fn(),
}));
vi.mock("../apps/dashboard/src/api/sdk.ts", () => ({ kernel: sdk }));

import {
  createAccountLinkMutationOptions,
  createInviteMutationOptions,
  revokeAllDevicesMutationOptions,
  revokeDeviceMutationOptions,
  revokeLinkMutationOptions,
  setHarvestCapabilityMutationOptions,
  terminateAccessMutationOptions,
} from "../apps/dashboard/src/api/adminUsers.ts";
import { REVOCATION_LABEL } from "../apps/dashboard/src/pages/settings/team/teamView.ts";

const USER = "grisha";
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
});

describe("the three revocations fire the three routes (§4.4)", () => {
  it(`«${REVOCATION_LABEL.device}» revokes exactly that one sign-in`, async () => {
    const client = makeClient();
    client.setQueryData(["admin", "users", USER, "devices"], []);
    client.setQueryData(["admin", "users", "someone-else", "devices"], []);

    await run(client, revokeDeviceMutationOptions(client, USER), 7);

    expect(sdk.adminRevokeDeviceToken).toHaveBeenCalledExactlyOnceWith({
      params: { username: USER, tokenId: 7 },
    });
    expect(sdk.adminRevokeDeviceTokens).not.toHaveBeenCalled();
    expect(sdk.adminTerminateAllAccess).not.toHaveBeenCalled();
    expect(client.getQueryState(["admin", "users", USER, "devices"])?.isInvalidated).toBe(true);
    expect(client.getQueryState(["admin", "users", "someone-else", "devices"])?.isInvalidated).toBe(false);
  });

  it(`«${REVOCATION_LABEL.allDevices}» revokes every device and nothing else`, async () => {
    const client = makeClient();
    client.setQueryData(["admin", "users", USER, "links"], []);

    await run(client, revokeAllDevicesMutationOptions(client, USER), undefined);

    expect(sdk.adminRevokeDeviceTokens).toHaveBeenCalledExactlyOnceWith({ params: { username: USER } });
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

    expect(sdk.adminTerminateAllAccess).toHaveBeenCalledExactlyOnceWith({ params: { username: USER } });
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
    // The provisioning dance this replaced (#116): three calls, a dictated
    // password and a half-made account whenever a later step failed.
    expect(sdk.adminCreateUser).not.toHaveBeenCalled();
    expect(sdk.adminSetPassword).not.toHaveBeenCalled();
    expect(sdk.adminAssignPage).not.toHaveBeenCalled();
    expect(sdk.adminIssueApiKey).not.toHaveBeenCalled();
    expect(client.getQueryState(["admin", "users"])?.isInvalidated).toBe(true);
  });
});

describe("links", () => {
  it("«Сбросить пароль ссылкой» asks for a password_reset link for that person", async () => {
    const client = makeClient();
    await run(client, createAccountLinkMutationOptions(client, USER), { kind: "password_reset" as const });

    expect(sdk.adminCreateAccountLink).toHaveBeenCalledExactlyOnceWith({
      params: { username: USER },
      body: { kind: "password_reset" },
    });
    expect(sdk.adminSetPassword).not.toHaveBeenCalled();
  });

  it("«Отправить приглашение заново» asks for an invite link for that person", async () => {
    const client = makeClient();
    await run(client, createAccountLinkMutationOptions(client, USER), { kind: "invite" as const });

    expect(sdk.adminCreateAccountLink).toHaveBeenCalledExactlyOnceWith({
      params: { username: USER },
      body: { kind: "invite" },
    });
  });

  it("«Отозвать ссылку» revokes exactly that link", async () => {
    const client = makeClient();
    client.setQueryData(["admin", "users", USER, "links"], []);

    await run(client, revokeLinkMutationOptions(client, USER), 42);

    expect(sdk.adminRevokeAccountLink).toHaveBeenCalledExactlyOnceWith({
      params: { username: USER, linkId: 42 },
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
      params: { username: USER, tokenId: 3 },
      body: { machineId: "3f2504e0-4f89-11d3-9a0c-0305e82c3301" },
    });

    sdk.adminSetDeviceTokenHarvestCapability.mockClear();
    await run(client, setHarvestCapabilityMutationOptions(client, USER), { tokenId: 3, machineId: null });
    expect(sdk.adminSetDeviceTokenHarvestCapability).toHaveBeenCalledExactlyOnceWith({
      params: { username: USER, tokenId: 3 },
      body: { machineId: null },
    });
  });
});
