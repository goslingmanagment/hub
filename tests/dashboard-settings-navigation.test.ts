import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
// Root TypeScript cannot resolve this dashboard-only dependency; match the
// other dashboard routing tests while Vitest shares the same router instance.
import { MemoryRouter } from "../apps/dashboard/node_modules/react-router/dist/development/index.js";

vi.mock("../apps/dashboard/src/pages/settings/SyncTab.tsx", () => ({ SyncTab: () => "content:sync" }));
vi.mock("../apps/dashboard/src/pages/settings/engine/EngineTab.tsx", () => ({ EngineTab: () => "content:engine" }));
vi.mock("../apps/dashboard/src/pages/settings/CollectionTab.tsx", () => ({ CollectionTab: () => "content:collection" }));
vi.mock("../apps/dashboard/src/pages/settings/PagesTab.tsx", () => ({ PagesTab: () => "content:pages" }));
vi.mock("../apps/dashboard/src/pages/settings/AiPersonasTab.tsx", () => ({ AiPersonasTab: () => "content:personas" }));
vi.mock("../apps/dashboard/src/pages/settings/team/TeamTab.tsx", () => ({ TeamTab: () => "content:users" }));
vi.mock("../apps/dashboard/src/pages/settings/team/TechnicalTab.tsx", () => ({ TechnicalTab: () => "content:agentKeys" }));
vi.mock("../apps/dashboard/src/pages/settings/ConfigurationTab.tsx", () => ({ ConfigurationTab: () => "content:configuration" }));
vi.mock("../apps/dashboard/src/pages/settings/FeaturesTab.tsx", () => ({ FeaturesTab: () => "content:features" }));

vi.mock("../apps/dashboard/src/pages/settings/NotificationsSettingsSection.tsx", () => ({ NotificationsSettingsSection: () => "content:notifications" }));
vi.mock("../apps/dashboard/src/pages/settings/OfapiApiTab.tsx", () => ({ OfapiApiTab: () => "content:ofapi" }));

import { SettingsPage } from "../apps/dashboard/src/pages/SettingsPage.tsx";

// Owner settings and System share one screen and one URL scheme; the tab
// decides which side navigation surrounds it.
const settingsTabs = ["pages", "users", "personas", "collection", "notifications"];
const systemTabs = ["engine", "sync", "ofapi", "features", "configuration", "agentKeys"];
// Merged into «Модели и страницы»: their old links open the merged screen.
const aliasTabs = ["models", "credentials"];

function renderSettings(path: string) {
  return renderToStaticMarkup(createElement(
    MemoryRouter,
    { initialEntries: [path] },
    createElement(SettingsPage),
  ));
}

function currentLink(markup: string) {
  return markup.match(/<a\b[^>]*aria-current="page"[^>]*>/)?.[0];
}

describe("settings section navigation", () => {
  it.each([...settingsTabs, ...systemTabs])("keeps the existing %s deep link and identifies the current section", (tab) => {
    const markup = renderSettings(`/settings?tab=${tab}`);
    expect(markup.match(/content:[a-zA-Z]+/g)).toEqual([`content:${tab}`]);
    expect(markup.match(/aria-current="page"/g)).toHaveLength(1);
    expect(currentLink(markup)).toContain(`href="/settings?tab=${tab}"`);
    const selectedOption = markup.match(/<option\b[^>]*selected=""[^>]*>/)?.[0];
    expect(selectedOption).toContain(`value="/settings?tab=${tab}"`);
  });

  it.each(aliasTabs)("opens «Модели и страницы» from the old %s link", (tab) => {
    const markup = renderSettings(`/settings?tab=${tab}`);
    expect(markup.match(/content:[a-zA-Z]+/g)).toEqual(["content:pages"]);
    expect(currentLink(markup)).toContain('href="/settings?tab=pages"');
  });

  it.each(["/settings", "/settings?tab=unknown", "/settings?tab="])(
    "opens «Модели и страницы» for %s",
    (path) => {
      const markup = renderSettings(path);
      expect(markup.match(/content:[a-zA-Z]+/g)).toEqual(["content:pages"]);
      expect(markup.match(/<option\b[^>]*selected=""[^>]*>/)?.[0]).toContain('value="/settings?tab=pages"');
    },
  );

  it("offers the owner sections as links while preserving page context and other query parameters", () => {
    const markup = renderSettings("/settings?tab=users&page=lora%2Fof+%2B+1&filter=a&filter=b");
    const links = [...markup.matchAll(/href="([^"]+)"/g)].map((match) => (
      new URL(match[1]!.replaceAll("&amp;", "&"), "https://hub.invalid")
    ));

    expect(links.map((link) => link.searchParams.get("tab")).sort()).toEqual([...settingsTabs].sort());
    for (const link of links) {
      expect(link.pathname).toBe("/settings");
      expect(link.searchParams.get("page")).toBe("lora/of + 1");
      expect(link.searchParams.getAll("filter")).toEqual(["a", "b"]);
    }
    expect(markup).toContain('aria-label="Разделы настроек"');
    expect(markup).toContain('aria-labelledby="settings-section-title"');
    expect(markup).toContain(">Настройки<");
    expect(markup).not.toContain("content:engine");
  });

  it("keeps the page selected on one sync screen when the other is opened from System", () => {
    const markup = renderSettings("/settings?tab=sync&page=lora%2Fof+%2B+1");
    const engine = [...markup.matchAll(/href="([^"]+)"/g)]
      .map((match) => new URL(match[1]!.replaceAll("&amp;", "&"), "https://hub.invalid"))
      .find((link) => link.searchParams.get("tab") === "engine");
    expect(engine?.searchParams.get("page")).toBe("lora/of + 1");
    expect(markup).toContain('aria-label="Разделы системы"');
    expect(markup).toContain(">Система<");
    // System's own screens outside Settings are plain links.
    expect(markup).toContain('href="/dev/log"');
  });

  it("offers the same sections in a labeled native selector with meaningful groups", () => {
    const markup = renderSettings("/settings?tab=users");
    expect(markup).toMatch(/<label[^>]*>.*Разделы настроек.*<select/s);
    expect([...markup.matchAll(/<optgroup label="([^"]+)"/g)].map((match) => match[1])).toEqual([
      "Агентство", "Работа",
    ]);
    const options = [...markup.matchAll(/<option value="([^"]+)"/g)].map((match) => match[1]);
    expect(options.sort()).toEqual(settingsTabs.map((tab) => `/settings?tab=${tab}`).sort());
  });

  it("groups System by what the machine does", () => {
    const markup = renderSettings("/settings?tab=configuration");
    expect([...markup.matchAll(/<optgroup label="([^"]+)"/g)].map((match) => match[1])).toEqual([
      "Сбор данных", "Конфигурация", "Наблюдение",
    ]);
  });
});
