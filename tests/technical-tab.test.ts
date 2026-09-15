import { createElement, type ComponentType } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

/**
 * Decision 348 — "Техническое": agent read-plane keys (moved here unchanged
 * from the old Ключи агентов tab) and the Desktop harvest binding.
 *
 * This is the only console screen allowed to name the machinery, so it is
 * also the only one excluded from the §2 vocabulary gate. What matters here
 * is that the binding cannot be aimed at a person who is gone, or at a
 * sign-in nobody picked, and that a mistyped machineId is refused locally.
 */

const queries = vi.hoisted(() => ({
  useAgentKeys: vi.fn(),
  useCreateAgentKey: vi.fn(),
  useRevokeAgentKey: vi.fn(),
  useAdminPages: vi.fn(),
  useAdminUsers: vi.fn(),
  useUserDevices: vi.fn(),
  useSetHarvestCapability: vi.fn(),
}));
vi.mock("../apps/dashboard/src/api/queries.ts", () => queries);

import {
  HarvestBindingSection,
  isMachineId,
  TechnicalTab,
} from "../apps/dashboard/src/pages/settings/team/TechnicalTab.tsx";

function query<T>(data: T | undefined, overrides: Record<string, unknown> = {}) {
  return { data, isLoading: false, isError: false, error: null, isFetching: false, refetch: vi.fn(), ...overrides };
}

function mutation() {
  return { mutate: vi.fn(), isPending: false };
}

function person(username: string, disabledAt: string | null = null) {
  return {
    id: username.length,
    username,
    role: "chatter" as const,
    mustChangePassword: false,
    assignedPages: [],
    apiKeyStatus: null,
    disabledAt,
    lastActiveAt: null,
    registrationState: "active" as const,
  };
}

function mockAll() {
  queries.useAgentKeys.mockReturnValue(query([]));
  queries.useCreateAgentKey.mockReturnValue(mutation());
  queries.useRevokeAgentKey.mockReturnValue(mutation());
  queries.useAdminPages.mockReturnValue(query([]));
  queries.useAdminUsers.mockReturnValue(query([person("grisha")]));
  queries.useUserDevices.mockReturnValue(query([]));
  queries.useSetHarvestCapability.mockReturnValue(mutation());
}

function render(component: ComponentType) {
  return renderToStaticMarkup(createElement(component));
}

describe("TechnicalTab", () => {
  it("carries both machine-facing surfaces under one roof", () => {
    mockAll();
    const markup = render(TechnicalTab);
    expect(markup).toContain("Ключи агентов");
    expect(markup).toContain("Привязка сбора данных");
    expect(markup).toContain("Issue key");
  });

  it("keeps the agent-key list honest when its permissions are stale", () => {
    mockAll();
    queries.useAgentKeys.mockReturnValue(query([], { isError: true, error: new Error("offline") }));
    expect(render(TechnicalTab)).toContain("Showing cached data");
  });
});

describe("harvest binding", () => {
  it("offers only people who are still in the team", () => {
    mockAll();
    queries.useAdminUsers.mockReturnValue(query([
      person("grisha"),
      person("ivan", "2026-09-01T00:00:00.000Z"),
    ]));

    const markup = render(HarvestBindingSection);
    expect(markup).toContain("grisha");
    expect(markup).not.toContain("ivan");
  });

  it("points the owner at the app's own Diagnostics screen for the machineId", () => {
    mockAll();
    expect(render(HarvestBindingSection)).toContain("Диагностика приложения");
  });

  it("cannot pick a sign-in before a person is chosen", () => {
    mockAll();
    const markup = render(HarvestBindingSection);
    expect(markup).toMatch(/<select[^>]*disabled=""/);
    // Nothing is bindable until both a person and a sign-in are selected.
    expect(markup).not.toContain("Remove binding");
    expect(markup).not.toContain('aria-label="machineId"');
  });

  it("refuses a machineId that is not a UUID before any request is made", () => {
    expect(isMachineId("3f2504e0-4f89-11d3-9a0c-0305e82c3301")).toBe(true);
    expect(isMachineId("  3F2504E0-4F89-11D3-9A0C-0305E82C3301  ")).toBe(true);
    expect(isMachineId("3f2504e0-4f89-11d3-9a0c")).toBe(false);
    expect(isMachineId("MacBook-Air.local")).toBe(false);
    expect(isMachineId("")).toBe(false);
  });
});
