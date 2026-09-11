import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ConfigItem, ConfigViewResponse } from "@agency_hub_core/contracts";
import { MemoryRouter } from "../apps/dashboard/node_modules/react-router/dist/development/index.js";
import { CONFIG_DESCRIPTORS } from "../packages/shared/src/config-registry.ts";
import { validateConfigOverride } from "../packages/shared/src/config-settings.ts";
import { HUB_FEATURES, findHubFeature } from "../apps/dashboard/src/pages/settings/featureCatalog.ts";
import { featureState } from "../apps/dashboard/src/pages/settings/featuresView.ts";
import { CONFIG_MODE_CHOICES, selectedConfigPages, serializeConfigPages, humanConfigValue } from "../apps/dashboard/src/pages/settings/configurationChoices.ts";

const mocks = vi.hoisted(() => ({ useAdminConfig: vi.fn(), useConfigPages: vi.fn(), useUpdateConfig: vi.fn(), useClearConfig: vi.fn(), useStagedConfig: vi.fn() }));
vi.mock("../apps/dashboard/src/api/adminConfig.ts", () => mocks);
vi.mock("../apps/dashboard/src/api/sdk.ts", () => ({ KernelApiError: class extends Error {} }));
import { FeaturesTab } from "../apps/dashboard/src/pages/settings/FeaturesTab.tsx";
import { ConfigurationTab } from "../apps/dashboard/src/pages/settings/ConfigurationTab.tsx";

const roles = ["api", "worker", "scheduler"];
function view(values: Record<string, string | number | boolean>): ConfigViewResponse {
  const items: ConfigItem[] = Object.entries(values).map(([key, value]) => {
    const descriptor = CONFIG_DESCRIPTORS.find((item) => item.key === key)!;
    return {
      ...descriptor, secret: false, note: descriptor.note ?? null, costWarning: descriptor.costWarning ?? null,
      destructive: false, stagedGroup: descriptor.stagedGroup ?? null, stagedOrder: descriptor.stagedOrder ?? null,
      requires: descriptor.requires ?? [], source: "env", desired: null, desiredEffective: typeof value === "boolean" ? value : null,
      overrideVersion: null, pendingApply: false, drift: false, live: descriptor.runtimeApply === "live",
      runningState: value === true ? "on" : "off",
      running: roles.map((role) => ({ role, instanceId: role, value, state: null, masked: false, lastSeenAt: "2026-09-11T19:00:00Z" })),
    };
  });
  return { generatedAt: "2026-09-11T19:00:00Z", roleStatuses: roles.map((role) => ({ role, status: "active" })), instances: [], subsystems: [{ subsystem: "Test", items }] };
}
function state(id: string, data: ConfigViewResponse) { return featureState(findHubFeature(id)!, data); }
function render(component: typeof FeaturesTab | typeof ConfigurationTab, path: string) {
  return renderToStaticMarkup(createElement(MemoryRouter, { initialEntries: [path] }, createElement(component)));
}

beforeEach(() => {
  for (const mock of Object.values(mocks)) mock.mockReset();
  mocks.useConfigPages.mockReturnValue({ data: [{ label: "lora-1", platform: "fansly" }, { label: "lora-of", platform: "onlyfans" }], isError: false });
  for (const name of ["useUpdateConfig", "useClearConfig", "useStagedConfig"] as const) mocks[name].mockReturnValue({ mutate: vi.fn(), isPending: false, error: null });
});

describe("feature configuration truth", () => {
  it("uses real registry keys and accepts every offered mode in the server validator", () => {
    const keys = new Set(CONFIG_DESCRIPTORS.map((item) => item.key));
    expect(new Set(HUB_FEATURES.map((feature) => feature.id)).size).toBe(HUB_FEATURES.length);
    for (const feature of HUB_FEATURES) {
      for (const key of [...feature.keys, ...feature.gates.map((entry) => entry.key), ...(feature.scope ? [feature.scope.key] : [])]) expect(keys.has(key), key).toBe(true);
    }
    for (const [key, choices] of Object.entries(CONFIG_MODE_CHOICES)) for (const choice of choices) expect(validateConfigOverride(key, choice.value), `${key}:${choice.value}`).toEqual({ ok: true, value: choice.value });
  });
  it("does not confuse a true gate with any enabled pages", () => {
    expect(state("voice", view({ voiceNotesEnabled: true, voiceNotesPageAllowlist: "" })).label).toBe("Нет выбранных страниц");
    expect(state("earnings", view({ fanslyFanEarningsSyncEnabled: true, fanslyNewStreamPageAllowlist: "" })).detail).toContain("Все страницы");
    expect(state("dm-shadow", view({ fanslyDmShadowPageAllowlist: "none" })).kind).toBe("off");
  });
  it("never promotes saved intent to applied state", () => {
    const data = view({ chatMuseAiPromptDebugEchoEnabled: false });
    Object.assign(data.subsystems[0]!.items[0]!, { desired: true, source: "override", overrideVersion: 1 });
    expect(state("prompt-debug", data).kind).toBe("off");
    data.subsystems[0]!.items[0]!.pendingApply = true;
    expect(state("prompt-debug", data).kind).toBe("pending");
  });
  it("honors the server's staged state even if a visible instance reports true", () => {
    const data = view({ chatMuseAiGatewayEnabled: true });
    data.subsystems[0]!.items[0]!.runningState = "off";
    expect(state("ai-core", data).kind).toBe("off");
  });
  it("shows unknown for a missing/stale role, drift, masked value or unknown snapshot", () => {
    const cases: ((data: ConfigViewResponse) => void)[] = [
      (data) => { data.roleStatuses.shift(); },
      (data) => { data.roleStatuses[0]!.status = "stale"; },
      (data) => { data.subsystems[0]!.items[0]!.running.pop(); },
      (data) => { data.subsystems[0]!.items[0]!.drift = true; },
      (data) => { data.subsystems[0]!.items[0]!.running[0]!.masked = true; },
      (data) => { data.subsystems[0]!.items[0]!.running[0]!.state = "unknown"; },
      (data) => { data.subsystems[0]!.items[0]!.running[0]!.value = false; },
    ];
    for (const mutate of cases) { const data = view({ chatMuseAiPromptDebugEchoEnabled: true }); mutate(data); expect(state("prompt-debug", data).kind).toBe("unknown"); }
  });
  it("keeps missing server capabilities distinct from disabled functions", () => {
    expect(state("voice", view({})).kind).toBe("unavailable");
  });
  it("does not label non-serving modes as ordinary enablement", () => {
    expect(state("fresh-context", view({ aiTranscriptFreshUnionMode: "shadow" })).kind).toBe("limited");
    expect(state("hydration", view({ agentHydrationMode: "request_only", agentReadPlaneMode: "full" })).label).toBe("Только заявки");
    expect(state("hydration", view({ agentHydrationMode: "dispatch", agentReadPlaneMode: "off" })).kind).toBe("off");
  });
  it("does not conflate the CAS read preference with capture enablement", () => {
    expect(state("storage", view({ captureCasDualWritePages: "*", captureCasReadMode: "inline" })).kind).toBe("on");
  });
});

describe("page and mode choices", () => {
  it("keeps the opposite empty-list meanings, including an unsaved empty selection", () => {
    expect(selectedConfigPages("", "fanslyNewStreamPageAllowlist", ["lora-1"], false)).toEqual(["lora-1"]);
    expect(selectedConfigPages("", "fanslyNewStreamPageAllowlist", ["lora-1"], true)).toEqual([]);
    expect(selectedConfigPages("", "voiceNotesPageAllowlist", ["lora-1"], false)).toEqual([]);
    expect(humanConfigValue("voiceNotesPageAllowlist", "")).toBe("Ни одной страницы");
  });
  it("retains unknown labels and disables diagnostics with the supported sentinel", () => {
    expect(selectedConfigPages("old-page,lora-1", "voiceNotesPageAllowlist", ["lora-1"], true)).toEqual(["old-page", "lora-1"]);
    expect(serializeConfigPages("fanslyDmShadowPageAllowlist", [])).toBe("none");
    expect(serializeConfigPages("voiceNotesPageAllowlist", [])).toBe("");
    expect(validateConfigOverride("voiceNotesPageAllowlist", "").ok).toBe(false);
  });
});

describe("features surface", () => {
  it("explains the recommendation without claiming measured savings", () => {
    mocks.useAdminConfig.mockReturnValue({ data: view({ chatMuseAiPromptDebugEchoEnabled: true }), isError: false });
    const html = render(FeaturesTab, "/settings?tab=features&feature=prompt-debug");
    expect(html).toContain("бизнес-эффект ещё не измерен");
    expect(html).toContain("Генерация ответов продолжит работать");
    expect(html).toContain("tab=configuration&amp;feature=prompt-debug");
    expect(mocks.useUpdateConfig).not.toHaveBeenCalled();
  });
  it("shows a refresh failure with the previous snapshot rather than a false empty result", () => {
    mocks.useAdminConfig.mockReturnValue({ data: view({ chatMuseAiPromptDebugEchoEnabled: true }), isError: true });
    const html = render(FeaturesTab, "/settings?tab=features");
    expect(html).toContain('role="alert"');
    expect(html).toContain("текущее состояние может отличаться");
    expect(html).toContain("Показ полного запроса AI");
  });
  it("keeps initial failure and zero results separate", () => {
    mocks.useAdminConfig.mockReturnValue({ isError: true });
    const html = render(FeaturesTab, "/settings?tab=features");
    expect(html).toContain("Не удалось получить настройки");
    expect(html).not.toContain("Выключено: 0");
  });
  it("opens scoped settings with checkbox selection and the original write flow", () => {
    mocks.useAdminConfig.mockReturnValue({ data: view({ voiceNotesEnabled: true, voiceNotesPageAllowlist: "lora-1" }), isError: false });
    const html = render(ConfigurationTab, "/settings?tab=configuration&feature=voice");
    expect(html).toContain("К возможностям");
    expect(html).toContain('type="checkbox"');
    expect(html).toContain("lora-1");
    expect(html).not.toContain("lora-of");
    expect(html).toContain("Сохранить");
  });
});
