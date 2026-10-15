import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { MemoryRouter } from "../apps/dashboard/node_modules/react-router/dist/development/index.js";

vi.mock("../apps/dashboard/src/components/layout/DashboardShellContext.tsx", () => ({
  useDashboardShell: () => ({ pages: [lora, mia] }),
}));

import { buildCommands, groupCommands, searchCommands } from "../apps/dashboard/src/lib/commands.ts";
import { CommandPalette, isPaletteShortcut } from "../apps/dashboard/src/components/layout/CommandPalette.tsx";

const lora = { label: "lora-1", platform: "fansly", modelName: "Lora", username: "lorafans" };
const mia = { label: "mia-of", platform: "onlyfans", modelName: "Mia", username: null };
const owner = buildCommands({ role: "owner", pages: [lora, mia] });
const lead = buildCommands({ role: "team_lead", pages: [lora, mia] });
const labels = (query: string, commands = owner) => searchCommands(commands, query).map((command) => command.label);

describe("command palette entries", () => {
  it("lists sections, pages, settings and system, but no page views until something is typed", () => {
    const empty = labels("");
    expect(empty).toEqual(expect.arrayContaining(["Обзор", "Аналитика", "Медиа", "Инциденты", "lora-1", "mia-of", "Команда", "Все параметры", "Журнал"]));
    expect(empty).not.toContain("lora-1 — Топ фанов");
    expect(groupCommands(searchCommands(owner, "")).map((group) => group.group)).toEqual(["Разделы", "Страницы", "Настройки", "Система"]);
  });

  it("offers a team lead only the screens a team lead can open", () => {
    const empty = labels("", lead);
    expect(empty).toEqual(expect.arrayContaining(["Обзор", "Медиа", "Выгрузки", "Зависшие отправки", "lora-1"]));
    for (const ownerOnly of ["Аналитика", "Ссылки", "Инциденты", "Команда", "Все параметры", "Журнал", "AI"]) {
      expect(empty).not.toContain(ownerOnly);
    }
  });

  it("finds a page's view by page, model or platform, and Followers on Fansly pages only", () => {
    expect(labels("топ lora")).toEqual(["lora-1 — Топ фанов"]);
    expect(labels("mia подписчики")).toEqual(["mia-of — Подписчики"]);
    expect(labels("фолловеры")).toEqual(["lora-1 — Фолловеры"]);
    expect(labels("onlyfans mia")[0]).toBe("mia-of");
    expect(searchCommands(owner, "топ lora")[0]?.to).toBe("/pages/lora-1/top-supporters");
  });

  it("puts a name that starts with the query first and ignores ё and case", () => {
    expect(labels("жур")[0]).toBe("Журнал");
    expect(labels("ЗАВИСШИЕ")).toEqual(["Зависшие отправки"]);
    expect(labels("уведомления")).toEqual(labels("уведомлёния"));
  });

  it("matches words from their start, and a fragment only when nothing starts with it", () => {
    expect(labels("тема")).toEqual(["Тема: как в системе", "Тема: светлая", "Тема: тёмная"]);
    expect(labels("тёмн")).toEqual(["Тема: тёмная"]);
    expect(labels("ведомл")).toEqual(["Уведомления"]);
    expect(searchCommands(owner, "тёмная")[0]).toMatchObject({ theme: "dark" });
  });

  it("understands a query typed in the wrong keyboard layout", () => {
    expect(labels("edtljvktybz")).toEqual(["Уведомления"]);
    expect(labels("дщкф")[0]).toBe("lora-1");
    expect(labels("qqqqzzz")).toEqual([]);
  });
});

describe("command palette shortcut", () => {
  const key = (patch: Partial<{ code: string; key: string; metaKey: boolean; ctrlKey: boolean; altKey: boolean; shiftKey: boolean }>) =>
    ({ code: "KeyK", key: "k", metaKey: false, ctrlKey: false, altKey: false, shiftKey: false, ...patch });
  it("opens on Ctrl/⌘K in any layout, not on K alone or with other modifiers", () => {
    expect(isPaletteShortcut(key({ ctrlKey: true }))).toBe(true);
    expect(isPaletteShortcut(key({ metaKey: true }))).toBe(true);
    expect(isPaletteShortcut(key({ ctrlKey: true, key: "л" }))).toBe(true);
    expect(isPaletteShortcut(key({}))).toBe(false);
    expect(isPaletteShortcut(key({ ctrlKey: true, shiftKey: true }))).toBe(false);
    expect(isPaletteShortcut(key({ ctrlKey: true, code: "KeyJ", key: "j" }))).toBe(false);
  });
});

describe("command palette markup", () => {
  it("is a labelled combobox over a grouped listbox with the first entry active", () => {
    const html = renderToStaticMarkup(createElement(MemoryRouter, undefined, createElement(CommandPalette, { role: "owner", onClose: () => {} })));
    expect(html).toMatch(/<dialog[^>]*aria-label="Поиск по разделам"/);
    expect(html).toMatch(/role="combobox"[^>]*aria-expanded="true"/);
    expect(html).toMatch(/role="listbox"/);
    expect(html).toMatch(/role="option" aria-selected="true"[^>]*><span[^>]*>Обзор<\/span>/);
    expect(html.match(/aria-selected="true"/g)).toHaveLength(1);
    expect(html).toContain(">lora-1<");
  });
});
