import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ConfigItem, ConfigViewResponse } from "@agency_hub_core/contracts";
import { MemoryRouter } from "../apps/dashboard/node_modules/react-router/dist/development/index.js";
import { CONFIG_DESCRIPTORS } from "../packages/shared/src/config-registry.ts";
import { validateConfigOverride } from "../packages/shared/src/config-settings.ts";
import { fanslyNewStreamAllowed, isPageAllowlisted } from "../apps/runtime/src/services/sync/fansly-stream-gate.ts";
import { HUB_FEATURES, findHubFeature, featureSettingsHref, featureReturnHref } from "../apps/dashboard/src/pages/settings/featureCatalog.ts";
import { featureState } from "../apps/dashboard/src/pages/settings/featuresView.ts";
import { CONFIG_MODE_CHOICES, selectedConfigPages, serializeConfigPages, humanConfigValue } from "../apps/dashboard/src/pages/settings/configurationChoices.ts";

const mocks = vi.hoisted(() => ({ useAdminConfig: vi.fn(), useConfigPages: vi.fn(), useUpdateConfig: vi.fn(), useClearConfig: vi.fn(), useStagedConfig: vi.fn() }));
vi.mock("../apps/dashboard/src/api/adminConfig.ts", () => mocks);
vi.mock("../apps/dashboard/src/api/sdk.ts", () => ({ KernelApiError: class extends Error {} }));
import { FeaturesTab } from "../apps/dashboard/src/pages/settings/FeaturesTab.tsx";
import { ConfigurationTab } from "../apps/dashboard/src/pages/settings/ConfigurationTab.tsx";

const roles = ["api", "worker", "scheduler", "sync"];
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
  it.each(["", "   ", ",", " , , "])("matches the runtime's opposite empty-CSV gates for %j", (value) => {
    expect(fanslyNewStreamAllowed(value, "future-page")).toBe(true);
    expect(isPageAllowlisted(value, "future-page")).toBe(false);
    expect(state("earnings", view({ fanslyFanEarningsSyncEnabled: true, fanslyNewStreamPageAllowlist: value })).detail).toContain("Все страницы");
    expect(state("voice", view({ voiceNotesEnabled: true, voiceNotesPageAllowlist: value })).kind).toBe("off");
    expect(state("dm-shadow", view({ fanslyDmShadowPageAllowlist: value })).kind).toBe("off");
  });
  it("never promotes saved intent to applied state", () => {
    const data = view({ chatMuseAiPromptDebugEchoEnabled: false });
    Object.assign(data.subsystems[0]!.items[0]!, { desired: true, source: "override", overrideVersion: 1 });
    expect(state("prompt-debug", data).kind).toBe("off");
    data.subsystems[0]!.items[0]!.pendingApply = true;
    expect(state("prompt-debug", data).kind).toBe("pending");
  });
  it("includes pending limits in the feature's application state", () => {
    const data = view({ voiceNotesEnabled: true, voiceNotesPageAllowlist: "lora-1", voiceNotesDailyCharBudget: 2000 });
    data.subsystems[0]!.items.find((item) => item.key === "voiceNotesDailyCharBudget")!.pendingApply = true;
    expect(state("voice", data).kind).toBe("pending");
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
  it.each([
    { value: "", draftPages: [] },
    { value: "   ", draftPages: ["lora-1"] },
    { value: ",", draftPages: ["lora-1"] },
    { value: " , , ", draftPages: ["lora-1"] },
  ])("keeps saved and draft empty-list meanings for $value", ({ value, draftPages }) => {
    expect(selectedConfigPages(value, "fanslyNewStreamPageAllowlist", ["lora-1"], false)).toEqual(["lora-1"]);
    expect(selectedConfigPages(value, "fanslyNewStreamPageAllowlist", ["lora-1"], true)).toEqual(draftPages);
    expect(selectedConfigPages(value, "voiceNotesPageAllowlist", ["lora-1"], false)).toEqual([]);
    expect(humanConfigValue("fanslyNewStreamPageAllowlist", value)).toBe("Все страницы Fansly");
    expect(humanConfigValue("voiceNotesPageAllowlist", value)).toBe("Ни одной страницы");
  });
  it.each([",", " , , "])("recognizes separator-only CSV as a server-valid override: %j", (value) => {
    expect(validateConfigOverride("fanslyNewStreamPageAllowlist", value)).toEqual({ ok: true, value: value.trim() });
    expect(validateConfigOverride("voiceNotesPageAllowlist", value)).toEqual({ ok: true, value: value.trim() });
  });
  it.each(["", "   "])("keeps blank raw drafts invalid for saving despite their runtime CSV meaning: %j", (value) => {
    expect(validateConfigOverride("fanslyNewStreamPageAllowlist", value).ok).toBe(false);
    expect(validateConfigOverride("voiceNotesPageAllowlist", value).ok).toBe(false);
  });
  it("retains unknown labels and disables diagnostics with the supported sentinel", () => {
    expect(selectedConfigPages("old-page,lora-1", "voiceNotesPageAllowlist", ["lora-1"], true)).toEqual(["old-page", "lora-1"]);
    expect(serializeConfigPages("fanslyDmShadowPageAllowlist", [])).toBe("none");
    expect(serializeConfigPages("voiceNotesPageAllowlist", [])).toBe("");
    expect(validateConfigOverride("voiceNotesPageAllowlist", "").ok).toBe(false);
  });
});

describe("features surface", () => {
  it("keeps search and filter when visiting a feature's settings and returning", () => {
    const feature = findHubFeature("voice")!;
    const source = new URLSearchParams({ view: "all", q: "голос & текст" });
    const settings = new URL(featureSettingsHref(feature, source), "https://hub.invalid");
    const returned = new URL(featureReturnHref(feature, settings.searchParams), "https://hub.invalid");
    expect(returned.searchParams.get("tab")).toBe("features");
    expect(returned.searchParams.get("feature")).toBe("voice");
    expect(returned.searchParams.get("view")).toBe("all");
    expect(returned.searchParams.get("q")).toBe("голос & текст");
  });
  it("finds the common feature name even when the card groups several AI tools", () => {
    mocks.useAdminConfig.mockReturnValue({ data: view({ chatMuseAiGatewayEnabled: true }), isError: false });
    expect(render(FeaturesTab, "/settings?tab=features&q=Fast+Reply")).toContain("AI для сотрудников");
  });
  it("shows pending core functions in the attention view", () => {
    const data = view({ chatMuseAiGatewayEnabled: true });
    data.subsystems[0]!.items[0]!.pendingApply = true;
    mocks.useAdminConfig.mockReturnValue({ data, isError: false });
    const html = render(FeaturesTab, "/settings?tab=features&view=attention");
    expect(html).toContain("AI для сотрудников");
    expect(html).toContain("Ждёт применения");
  });
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
  it("explains that a separator-only saved legacy scope includes future pages", () => {
    mocks.useAdminConfig.mockReturnValue({ data: view({ fanslyFanEarningsSyncEnabled: true, fanslyNewStreamPageAllowlist: ", ," }), isError: false });
    const html = render(ConfigurationTab, "/settings?tab=configuration&feature=earnings");
    expect(html).toContain("Все страницы Fansly");
    expect(html).toContain("включая будущие");
    expect(html).toContain('checked=""');
  });
  it("keeps numeric storage scopes in the raw editor", () => {
    mocks.useAdminConfig.mockReturnValue({ data: view({ captureCasDualWritePages: "12, 34" }), isError: false });
    const html = render(ConfigurationTab, "/settings?tab=configuration&feature=storage");
    expect(html).toContain('type="text"');
    expect(html).toContain('value="12, 34"');
    expect(html).not.toContain('type="checkbox"');
  });
  it("provides a direct full-editor link for custom CSV without switching settings sections", () => {
    mocks.useAdminConfig.mockReturnValue({ data: view({ voiceNotesEnabled: true, voiceNotesPageAllowlist: "old-page,lora-1" }), isError: false });
    const focused = render(ConfigurationTab, "/settings?tab=configuration&feature=voice&view=all&q=voice&page=lora-1");
    const link = focused.match(/<a[^>]+href="([^"]+)"[^>]*>Все настройки<\/a>/);
    expect(link).not.toBeNull();
    const href = link![1]!.replaceAll("&amp;", "&");
    expect(href).toBe("/settings?tab=configuration&page=lora-1");

    const full = render(ConfigurationTab, href);
    expect(full).toContain('type="text"');
    expect(full).toContain('value="old-page,lora-1"');
    expect(full).not.toContain('type="checkbox"');
  });
});
