import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
// Root TypeScript cannot resolve this dashboard-only dependency; match the
// other dashboard routing tests while Vitest shares the same router instance.
import { MemoryRouter } from "../apps/dashboard/node_modules/react-router/dist/development/index.js";

vi.mock("../apps/dashboard/src/pages/settings/CredentialsTab.tsx", () => ({ CredentialsTab: () => "content:credentials" }));
vi.mock("../apps/dashboard/src/pages/settings/SyncTab.tsx", () => ({ SyncTab: () => "content:sync" }));
vi.mock("../apps/dashboard/src/pages/settings/engine/EngineTab.tsx", () => ({ EngineTab: () => "content:engine" }));
vi.mock("../apps/dashboard/src/pages/settings/CollectionTab.tsx", () => ({ CollectionTab: () => "content:collection" }));
vi.mock("../apps/dashboard/src/pages/settings/ModelsTab.tsx", () => ({ ModelsTab: () => "content:models" }));
vi.mock("../apps/dashboard/src/pages/settings/PagesTab.tsx", () => ({ PagesTab: () => "content:pages" }));
vi.mock("../apps/dashboard/src/pages/settings/AiPersonasTab.tsx", () => ({ AiPersonasTab: () => "content:personas" }));
vi.mock("../apps/dashboard/src/pages/settings/team/TeamTab.tsx", () => ({ TeamTab: () => "content:users" }));
vi.mock("../apps/dashboard/src/pages/settings/team/TechnicalTab.tsx", () => ({ TechnicalTab: () => "content:agentKeys" }));
vi.mock("../apps/dashboard/src/pages/settings/ConfigurationTab.tsx", () => ({ ConfigurationTab: () => "content:configuration" }));
vi.mock("../apps/dashboard/src/pages/settings/FeaturesTab.tsx", () => ({ FeaturesTab: () => "content:features" }));

import { SettingsPage } from "../apps/dashboard/src/pages/SettingsPage.tsx";

const tabs = ["credentials", "engine", "sync", "collection", "models", "personas", "pages", "users", "agentKeys", "configuration", "features"];

function renderSettings(path: string) {
  return renderToStaticMarkup(createElement(
    MemoryRouter,
    { initialEntries: [path] },
    createElement(SettingsPage),
  ));
}

describe("settings section navigation", () => {
  it.each(tabs)("keeps the existing %s deep link and identifies the current section", (tab) => {
    const markup = renderSettings(`/settings?tab=${tab}`);
    expect(markup.match(/content:[a-zA-Z]+/g)).toEqual([`content:${tab}`]);
    expect(markup.match(/aria-current="page"/g)).toHaveLength(1);
    const currentLink = markup.match(/<a\b[^>]*aria-current="page"[^>]*>/)?.[0];
    expect(currentLink).toContain(`href="/settings?tab=${tab}"`);
    const selectedOption = markup.match(/<option\b[^>]*selected=""[^>]*>/)?.[0];
    expect(selectedOption).toContain(`value="${tab}"`);
  });

  it.each(["/settings", "/settings?tab=unknown", "/settings?tab="])(
    "keeps credentials as the fallback for %s",
    (path) => {
      const markup = renderSettings(path);
      expect(markup.match(/content:[a-zA-Z]+/g)).toEqual(["content:credentials"]);
      expect(markup.match(/<option\b[^>]*selected=""[^>]*>/)?.[0]).toContain('value="credentials"');
    },
  );

  it("offers all sections as links while preserving page context and other query parameters", () => {
    const markup = renderSettings("/settings?tab=sync&page=lora%2Fof+%2B+1&filter=a&filter=b");
    const links = [...markup.matchAll(/href="([^"]+)"/g)].map((match) => (
      new URL(match[1]!.replaceAll("&amp;", "&"), "https://hub.invalid")
    ));

    expect(links).toHaveLength(tabs.length);
    expect(links.map((link) => link.searchParams.get("tab")).sort()).toEqual([...tabs].sort());
    for (const link of links) {
      expect(link.pathname).toBe("/settings");
      expect(link.searchParams.get("page")).toBe("lora/of + 1");
      expect(link.searchParams.getAll("filter")).toEqual(["a", "b"]);
    }
    expect(markup).toContain('aria-label="Разделы настроек"');
    expect(markup).toContain('aria-labelledby="settings-section-title"');
    expect(markup).toContain("Система");
    expect(markup).toContain("Аккаунты и AI");
    expect(markup).toContain("Доступ");
  });

  it("offers the same sections in a labeled native selector with meaningful groups", () => {
    const markup = renderSettings("/settings?tab=configuration");
    expect(markup).toMatch(/<label[^>]*>.*Раздел настроек.*<select/s);
    expect([...markup.matchAll(/<optgroup label="([^"]+)"/g)].map((match) => match[1])).toEqual([
      "Система", "Аккаунты и AI", "Доступ",
    ]);
    const options = [...markup.matchAll(/<option value="([^"]+)"/g)].map((match) => match[1]);
    expect(options.sort()).toEqual([...tabs].sort());
  });
});
