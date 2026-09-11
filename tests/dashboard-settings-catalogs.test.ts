import { createElement, type ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AdminAiPersona, AssignedPage } from "@agency_hub_core/contracts";
import { MemoryRouter } from "../apps/dashboard/node_modules/react-router/dist/development/index.js";

const queries = vi.hoisted(() => ({
  useAdminModels: vi.fn(), useAdminPages: vi.fn(), useAdminConnections: vi.fn(),
  useAdminReorderModels: vi.fn(), useAdminVerifyPage: vi.fn(), useAdminAiPersonas: vi.fn(),
}));
vi.mock("../apps/dashboard/src/api/queries.ts", () => queries);
vi.mock("../apps/dashboard/src/api/sdk.ts", () => ({ KernelApiError: class extends Error {} }));

import { ModelsTab } from "../apps/dashboard/src/pages/settings/ModelsTab.tsx";
import { PagesTab } from "../apps/dashboard/src/pages/settings/PagesTab.tsx";
import { AiPersonasTab, ViewPersonaModal } from "../apps/dashboard/src/pages/settings/AiPersonasTab.tsx";

const model = { id: 1, slug: "model/one + two", name: "First Model", pageCount: 1, sortOrder: 0 };
const page: AssignedPage = {
  id: 1, label: "page/one + two", platform: "fansly", modelSlug: model.slug, modelName: model.name,
  username: null, displayName: null, lastLightSyncAt: null, lastFollowerSyncAt: null,
  subscriberCount: { value: 0, available: true }, followerCount: { value: null, available: false },
};
const persona: AdminAiPersona = {
  key: "custom:first", displayName: "First Persona", status: "active", version: 7,
  updatedAt: "2026-09-11T09:00:00Z", systemBlock: "SYNTHETIC: сохраняйте исходный текст.\n\n<script>raw text</script>",
};
const ready = (data: unknown) => ({ data, isLoading: false, isError: false, refetch: vi.fn() });
function render(element: ReactElement, query = "") {
  return renderToStaticMarkup(createElement(MemoryRouter, { initialEntries: [`/settings?${query}`] }, element));
}
function links(html: string) {
  return [...html.matchAll(/href="([^"]+)"/g)].map((match) => new URL(match[1]!.replaceAll("&amp;", "&"), "http://test.local"));
}

describe("settings catalogs", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    queries.useAdminModels.mockReturnValue(ready([model, { id: 2, slug: "second", name: "Second Model", pageCount: 1, sortOrder: 1 }]));
    queries.useAdminPages.mockReturnValue(ready([page, { ...page, id: 2, label: "second-page", modelSlug: "second", modelName: "Second Model" }]));
    queries.useAdminConnections.mockReturnValue(ready([]));
    queries.useAdminAiPersonas.mockReturnValue(ready({ personas: [persona, { ...persona, key: "archived:second", displayName: "Second Persona", status: "archived" }] }));
    queries.useAdminReorderModels.mockReturnValue({ isPending: false, mutateAsync: vi.fn() });
    queries.useAdminVerifyPage.mockReturnValue({ isPending: false, mutateAsync: vi.fn() });
  });

  it("links a model to its exact pages and disables reordering during search", () => {
    const html = render(createElement(ModelsTab), `modelQuery=${encodeURIComponent(model.slug)}`);
    const target = links(html).find((link) => link.searchParams.get("tab") === "pages");
    expect(target?.searchParams.get("model")).toBe(model.slug);
    expect(html).toContain("First Model");
    expect(html).not.toContain("Second Model");
    expect(html.match(/<button[^>]*disabled=""[^>]*aria-label="(?:Поднять|Опустить) модель/g)).toHaveLength(2);
    expect(html).toContain("сбросьте поиск");
  });

  it("restores the model filter and uses real page and model links with encoded identifiers", () => {
    const html = render(createElement(PagesTab), `model=${encodeURIComponent(model.slug)}&pageQuery=one`);
    expect(html).not.toContain("second-page");
    const targets = links(html);
    expect(targets.some((link) => link.pathname === `/pages/${encodeURIComponent(page.label)}`)).toBe(true);
    expect(targets.find((link) => link.searchParams.get("tab") === "models")?.searchParams.get("modelQuery")).toBe(model.slug);
    expect(html).toContain("Нет данных");
    expect(html).toContain(">0</td>");
    expect(html).not.toContain("@unknown");
  });

  it("keeps cached persona results and offers retry when refresh fails", () => {
    queries.useAdminAiPersonas.mockReturnValue({ ...ready({ personas: [persona] }), isError: true, error: new Error("Catalog timeout") });
    const html = render(createElement(AiPersonasTab));
    expect(html).toContain("First Persona");
    expect(html).toContain("Показан последний загруженный каталог персон");
    expect(html).toContain("Catalog timeout");
    expect(html).toContain("Повторить загрузку");
  });

  it("distinguishes an initial persona error, a confirmed empty catalog and no search matches", () => {
    queries.useAdminAiPersonas.mockReturnValue({ ...ready(undefined), isError: true, error: new Error("Catalog unavailable") });
    const failed = render(createElement(AiPersonasTab));
    expect(failed).toContain("Не удалось загрузить AI-персоны");
    expect(failed).toContain("Повторить загрузку");
    expect(failed).not.toContain("Персон пока нет");
    queries.useAdminAiPersonas.mockReturnValue(ready({ personas: [] }));
    expect(render(createElement(AiPersonasTab))).toContain("Персон пока нет");
    queries.useAdminAiPersonas.mockReturnValue(ready({ personas: [persona] }));
    expect(render(createElement(AiPersonasTab), "personaQuery=missing")).toContain("Персоны не найдены");
  });

  it("filters archived personas without exposing gated mutation actions", () => {
    const html = render(createElement(AiPersonasTab), "personaStatus=archived");
    expect(html).toContain("Second Persona");
    expect(html).not.toContain("First Persona");
    expect(html).toContain("Посмотреть персону Second Persona");
    expect(html).not.toContain(">Архивировать</button>");
    expect(html).not.toContain(">Изменить</button>");
    expect(html).not.toContain("Добавить персону");
  });

  it("shows the full saved persona text as read-only content with its version", () => {
    const html = render(createElement(ViewPersonaModal, { persona, onClose: vi.fn() }));
    expect(html).toContain("role=\"dialog\"");
    expect(html).toMatch(/<textarea[^>]*\breadonly=""/i);
    expect(html).toContain("Версия 7");
    expect(html).toContain("&lt;script&gt;raw text&lt;/script&gt;");
    expect(html).not.toContain("<script>");
    expect(html).not.toContain("Сохранить");
  });
});
