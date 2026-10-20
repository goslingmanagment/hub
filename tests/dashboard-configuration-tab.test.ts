import { describe, expect, it, vi } from "vitest";
import type { ConfigItem } from "@agency_hub_core/contracts";

// Root tests cannot resolve @tanstack/react-query (it is a dashboard-local dep), so the
// api layer is mocked at module level — the same pattern as dashboard-sync-surfaces.test.ts.
const apiMocks = vi.hoisted(() => ({
  useAdminConfig: vi.fn(),
  useUpdateConfig: vi.fn(),
  useClearConfig: vi.fn(),
}));

vi.mock("../apps/dashboard/src/api/adminConfig.ts", () => apiMocks);

// sdk.ts drags in @/lib/queryClient (→ @tanstack/react-query); ConfigurationTab only
// needs KernelApiError from it for 409-conflict instanceof checks.
vi.mock("../apps/dashboard/src/api/sdk.ts", () => ({
  KernelApiError: class KernelApiError extends Error {
    status: number;
    constructor(message: string, status: number) {
      super(message);
      this.status = status;
    }
  },
}));

import {
  resolveBooleanToggle,
} from "../apps/dashboard/src/pages/settings/ConfigurationTab.tsx";

function configItem(overrides: Partial<ConfigItem> = {}): ConfigItem {
  return {
    key: "accountLinksEnabled",
    envName: "ACCOUNT_LINKS_ENABLED",
    configField: "accountLinksEnabled",
    kind: "boolean",
    subsystem: "Security",
    label: "Account links (invite / password reset)",
    default: "true",
    editability: "editable",
    runtimeApply: "live",
    comparable: true,
    secret: false,
    note: null,
    costWarning: null,
    destructive: false,
    source: "env",
    desired: null,
    runningState: "off",
    desiredEffective: false,
    overrideVersion: null,
    pendingApply: false,
    drift: false,
    live: true,
    running: [
      {
        role: "api",
        instanceId: "api-1",
        value: false,
        masked: false,
        state: null,
        lastSeenAt: "2026-07-11T00:00:00.000Z",
      },
    ],
    ...overrides,
  };
}

// Click behavior is pinned via the exported resolver (renderToStaticMarkup cannot
// dispatch events and the repo's root suite is node-env, no DOM): BooleanConfigEditor's
// onToggle delegates 1:1 to resolveBooleanToggle, so these ARE the click semantics.
describe("resolveBooleanToggle", () => {
  it("only arms the confirm gate on the first click for a costWarning key", () => {
    const item = configItem({ costWarning: "Enabling it costs something." });
    expect(resolveBooleanToggle({ item, target: true, confirm: null })).toEqual({ kind: "arm" });
  });

  it("saves a costWarning key once armed for the SAME target", () => {
    const item = configItem({ costWarning: "Enabling it costs something." });
    const action = resolveBooleanToggle({
      item,
      target: true,
      confirm: { action: "save", target: true },
    });
    expect(action).toEqual({
      kind: "save",
      body: {
        patches: [
          { key: "accountLinksEnabled", value: true, expectedVersion: 0 },
        ],
      },
    });
  });

  it("re-arms instead of saving when the armed target differs", () => {
    const item = configItem({ costWarning: "warn" });
    expect(
      resolveBooleanToggle({ item, target: false, confirm: { action: "save", target: true } }),
    ).toEqual({ kind: "arm" });
  });

  it("treats destructive keys like costWarning keys (two-click confirm)", () => {
    const item = configItem({ destructive: true });
    expect(resolveBooleanToggle({ item, target: true, confirm: null })).toEqual({ kind: "arm" });
  });
});
