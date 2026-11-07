import { ChevronDown, X } from "lucide-react";
import { Menu, type MenuEntry } from "@agency_hub_core/ui";
import { usePageFilter } from "./usePageFilter.js";
import { groupPagesByModel, usePages } from "./usePages.js";

const PLATFORM_WORD: Record<string, string> = { fansly: "Fansly", onlyfans: "OnlyFans", telegram: "Telegram" };

/**
 * The header's page filter: «Все страницы» or one page. A chosen page is an ink
 * chip with a cross, so a forgotten filter cannot pass unseen. The list: every
 * page under its model, the platform in quiet words. It narrows what is shown
 * and nothing else (usePageFilter).
 */
export function PageFilter() {
  const { page, setPage } = usePageFilter();
  const pages = usePages();
  const groups = groupPagesByModel(pages.data ?? []);

  const items: MenuEntry[] = [
    { label: "Все страницы", checked: page === null, onSelect: () => setPage(null) },
    ...groups.flatMap((group): MenuEntry[] => [
      { separator: true },
      { group: group.modelName },
      ...group.pages.map((item): MenuEntry => ({
        label: item.label,
        hint: PLATFORM_WORD[item.platform] ?? item.platform,
        checked: page === item.label,
        onSelect: () => setPage(item.label),
      })),
    ]),
  ];

  return (
    <Menu
      label="Страница"
      items={items}
      align="end"
      renderTrigger={({ ref, ...trigger }) => page === null ? (
        <button ref={ref} type="button" className="ui-chip ui-chip--md" {...trigger}>
          <span className="ui-chip__text">Все страницы</span>
          <ChevronDown size={16} strokeWidth={1.75} aria-hidden />
        </button>
      ) : (
        <span className="ui-chip ui-chip--md ui-chip--selected">
          <button ref={ref} type="button" className="ui-chip__main" aria-label={`Страница: ${page}. Выбрать другую`} {...trigger}>
            <span className="ui-chip__text">{page}</span>
            <ChevronDown size={16} strokeWidth={1.75} aria-hidden />
          </button>
          <button type="button" className="ui-chip__remove" aria-label="Показать все страницы" title="Показать все страницы" onClick={() => setPage(null)}>
            <X size={14} strokeWidth={2} aria-hidden />
          </button>
        </span>
      )}
    />
  );
}
