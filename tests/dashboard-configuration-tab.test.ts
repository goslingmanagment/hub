import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ConfigItem, ConfigViewResponse } from "@agency_hub_core/contracts";

// Root tests cannot resolve @tanstack/react-query (it is a dashboard-local dep), so the
// api layer is mocked at module level — the same pattern as dashboard-sync-surfaces.test.ts.
const apiMocks = vi.hoisted(() => ({
  useAdminConfig: vi.fn(),
  useUpdateConfig: vi.fn(),
  useClearConfig: vi.fn(),
  useStagedConfig: vi.fn(),
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
  ConfigurationTab,
  booleanPatchBody,
  liveEditorKind,
  resolveBooleanToggle,
} from "../apps/dashboard/src/pages/settings/ConfigurationTab.tsx";

function configItem(overrides: Partial<ConfigItem> = {}): ConfigItem {
  return {
    key: "fanslyDeepBackfillIgnoreRetentionLimit",
    envName: "FANSLY_DEEP_BACKFILL_IGNORE_RETENTION_LIMIT",
    configField: "fanslyDeepBackfillIgnoreRetentionLimit",
    kind: "boolean",
    subsystem: "Fansly",
    label: "Fansly deep backfill: ignore retention cap",
    default: "false",
    editability: "editable",
    runtimeApply: "live",
    comparable: true,
    secret: false,
    note: null,
    costWarning: null,
    destructive: false,
    stagedGroup: null,
    stagedOrder: null,
    requires: [],
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

function view(items: ConfigItem[]): ConfigViewResponse {
  return {
    generatedAt: "2026-07-11T00:00:00.000Z",
    roleStatuses: [],
    instances: [],
    subsystems: [{ subsystem: "Fansly", items }],
  };
}

function renderTab(items: ConfigItem[]): string {
  apiMocks.useAdminConfig.mockReturnValue({ data: view(items), isLoading: false, isError: false });
  return renderToStaticMarkup(createElement(ConfigurationTab));
}

beforeEach(() => {
  apiMocks.useAdminConfig.mockReset();
  apiMocks.useUpdateConfig.mockReset();
  apiMocks.useClearConfig.mockReset();
  apiMocks.useStagedConfig.mockReset();
  const idleMutation = { mutate: vi.fn(), isPending: false, error: null };
  apiMocks.useUpdateConfig.mockReturnValue({ ...idleMutation });
  apiMocks.useClearConfig.mockReturnValue({ ...idleMutation });
  apiMocks.useStagedConfig.mockReturnValue({ ...idleMutation });
});

// The prod incident this pins: a boolean live key showed the editable status but had no
// editor at all, so the flag had to be flipped via psql. A boolean live key must render
// a real switch seeded from the effective value.
describe("ConfigurationTab boolean live editor rendering", () => {
  it("renders an on/off switch for a boolean live key, seeded from the running value", () => {
    const html = renderTab([configItem()]);
    expect(html).toContain('role="switch"');
    expect(html).toContain('aria-checked="false"');
    expect(html).toContain('aria-label="История без ограничения чата value"');
  });

  it("seeds the switch from the desired override when one exists", () => {
    const html = renderTab([
      configItem({ source: "override", desired: true, overrideVersion: 3, desiredEffective: true }),
    ]);
    expect(html).toContain('aria-checked="true"');
    // The override row also gets the revert-to-env button, like the numeric editor.
    expect(html).toContain("Вернуть настройку сервера");
  });

  it("renders a text input for string live keys", () => {
    const html = renderTab([
      configItem({
        key: "fanslyNewStreamPageAllowlist",
        envName: "FANSLY_NEW_STREAM_PAGE_ALLOWLIST",
        configField: "fanslyNewStreamPageAllowlist",
        kind: "string",
        label: "Fansly new-stream page allowlist",
        default: "",
        running: [
          {
            role: "api",
            instanceId: "api-1",
            value: "",
            masked: false,
            state: null,
            lastSeenAt: "2026-07-11T00:00:00.000Z",
          },
        ],
      }),
    ]);
    expect(html).not.toContain('role="switch"');
    expect(html).toContain('type="text"');
    expect(html).toContain('aria-label="Страницы доходов и покупок Fansly value"');
  });

  it("still renders the numeric input for number live keys", () => {
    const html = renderTab([
      configItem({
        key: "transactionLookbackDays",
        envName: "TRANSACTION_LOOKBACK_DAYS",
        configField: "transactionLookbackDays",
        kind: "number",
        label: "Transaction lookback (days)",
        default: "7",
        running: [
          {
            role: "api",
            instanceId: "api-1",
            value: 7,
            masked: false,
            state: null,
            lastSeenAt: "2026-07-11T00:00:00.000Z",
          },
        ],
      }),
    ]);
    expect(html).toContain('type="number"');
    expect(html).not.toContain('role="switch"');
  });
});

// Fansly Sync Engine plan §2.1: the Fansly pause turned live, so the console renders an
// editor for it, with copy that names the range and the 0–20 % jitter.
describe("ConfigurationTab Fansly pause", () => {
  it("renders the live numeric editor with the owner-facing copy and server note", () => {
    const html = renderTab([
      configItem({
        key: "fanslyDefaultDelayMs",
        envName: "FANSLY_DEFAULT_DELAY_MS",
        configField: "fanslyDefaultDelayMs",
        kind: "number",
        label: "Fansly pause between requests (ms)",
        default: "2500",
        note: "One pause for every Fansly page, 2000-60000 ms. A value outside the range is rejected, never clamped.",
        costWarning: "Lowering reduces politeness against Fansly's unofficial API; raises ban/throttle risk.",
        running: [
          {
            role: "api",
            instanceId: "api-1",
            value: 2500,
            masked: false,
            state: null,
            lastSeenAt: "2026-07-11T00:00:00.000Z",
          },
        ],
      }),
    ]);
    expect(html).toContain('type="number"');
    expect(html).toContain("Пауза между запросами Fansly");
    expect(html).toContain("Задаёт наименьшую паузу между двумя запросами одной страницы Fansly.");
    expect(html).toContain("Допустимо от 2000 до 60000 мс");
    expect(html).toContain("от 0 до 20 %");
    expect(html).toContain("A value outside the range is rejected, never clamped.");
  });
});

// Click behavior is pinned via the exported resolver (renderToStaticMarkup cannot
// dispatch events and the repo's root suite is node-env, no DOM): BooleanConfigEditor's
// onToggle delegates 1:1 to resolveBooleanToggle, so these ARE the click semantics.
describe("resolveBooleanToggle", () => {
  it("saves immediately for a key without costWarning, with a real boolean and expectedVersion 0 for env-sourced keys", () => {
    const action = resolveBooleanToggle({ item: configItem(), target: true, confirm: null });
    expect(action).toEqual({
      kind: "save",
      body: {
        patches: [
          { key: "fanslyDeepBackfillIgnoreRetentionLimit", value: true, expectedVersion: 0 },
        ],
      },
    });
    if (action.kind !== "save") throw new Error("expected save");
    // A REAL boolean — the server's validateConfigOverride rejects "true"/"false" strings.
    expect(typeof action.body.patches[0]!.value).toBe("boolean");
  });

  it("sends the override row's version as expectedVersion (optimistic concurrency)", () => {
    const action = resolveBooleanToggle({
      item: configItem({ source: "override", desired: true, overrideVersion: 4 }),
      target: false,
      confirm: null,
    });
    expect(action).toEqual({
      kind: "save",
      body: {
        patches: [
          { key: "fanslyDeepBackfillIgnoreRetentionLimit", value: false, expectedVersion: 4 },
        ],
      },
    });
  });

  it("only arms the confirm gate on the first click for a costWarning key", () => {
    const item = configItem({ costWarning: "The Stage 17 exhaustion crawl grows the hot table." });
    expect(resolveBooleanToggle({ item, target: true, confirm: null })).toEqual({ kind: "arm" });
  });

  it("saves a costWarning key once armed for the SAME target", () => {
    const item = configItem({ costWarning: "The Stage 17 exhaustion crawl grows the hot table." });
    const action = resolveBooleanToggle({
      item,
      target: true,
      confirm: { action: "save", target: true },
    });
    expect(action).toEqual({
      kind: "save",
      body: {
        patches: [
          { key: "fanslyDeepBackfillIgnoreRetentionLimit", value: true, expectedVersion: 0 },
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

describe("booleanPatchBody", () => {
  it("builds a single-key patch with the boolean literal", () => {
    expect(booleanPatchBody({ key: "k", overrideVersion: null }, false)).toEqual({
      patches: [{ key: "k", value: false, expectedVersion: 0 }],
    });
  });
});

describe("liveEditorKind", () => {
  it("routes scalar and boolean live keys to their editors and leaves the rest read-only", () => {
    expect(liveEditorKind({ runtimeApply: "live", kind: "number" })).toBe("number");
    expect(liveEditorKind({ runtimeApply: "live", kind: "boolean" })).toBe("boolean");
    expect(liveEditorKind({ runtimeApply: "live", kind: "string" })).toBe("string");
    // Boot-applied booleans belong to the staged ritual, never the inline editor.
    expect(liveEditorKind({ runtimeApply: "boot", kind: "boolean" })).toBeNull();
    expect(liveEditorKind({ runtimeApply: "none", kind: "number" })).toBeNull();
  });
});
