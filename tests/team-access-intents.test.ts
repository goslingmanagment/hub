import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  MutationObserver,
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
  // `adminIssueApiKey`) no longer exist on the SDK at all since Decision 370 —
  // asserting `not.toHaveBeenCalled` on a hand-made mock of a deleted operation
  // proves nothing, so they are gone from here too.
  adminAssignPage: vi.fn(),
}));
vi.mock("../apps/dashboard/src/api/sdk.ts", () => ({ kernel: sdk }));

import {
  revokeAllDevicesMutationOptions,
  revokeDeviceMutationOptions,
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
