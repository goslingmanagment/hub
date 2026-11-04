import { useEffect, useId, useMemo, useRef, useState, type KeyboardEvent, type ReactNode, type RefObject } from "react";
import { Check, ChevronDown, X } from "lucide-react";
import { Link, useNavigate } from "react-router";
import { PLATFORM_WORD } from "@/components/shared/PlatformBadge";
import { buildPageRoute } from "@/lib/navigation";
import type { Screen } from "@/lib/sections";
import { useDashboardShell } from "./DashboardShellContext.js";
import { usePageFilter } from "./usePageFilter.js";

type ShellPage = ReturnType<typeof useDashboardShell>["pages"][number];

/** Pages under their models, in the catalog's order. */
function groupByModel(pages: readonly ShellPage[]): { modelName: string; pages: ShellPage[] }[] {
  const groups = new Map<string, { modelName: string; pages: ShellPage[] }>();
  for (const page of pages) {
    const group = groups.get(page.modelSlug);
    if (group) group.pages.push(page);
    else groups.set(page.modelSlug, { modelName: page.modelName, pages: [page] });
  }
  return [...groups.values()];
}

/** Why a page is grey in the list: this screen has nothing of it. */
function outOfScopeNote(page: ShellPage, screen: Screen | null): string | null {
  if (!screen?.platforms || screen.platforms.includes(page.platform)) return null;
  if (page.platform === "telegram" && !screen.platformsShort) return "нет данных";
  return screen.platformsShort ?? "нет данных";
}

/** A list that opens over the header and closes on Esc and on a click elsewhere. */
function useOverlay(open: boolean, close: () => void, wrap: RefObject<HTMLElement | null>) {
  useEffect(() => {
    if (!open) return;
    function onPointer(event: MouseEvent) {
      if (!wrap.current?.contains(event.target as Node)) close();
    }
    window.addEventListener("mousedown", onPointer);
    return () => window.removeEventListener("mousedown", onPointer);
  }, [close, open, wrap]);
}

/** The chip's list: search from ten pages, «Все страницы», pages by model.
 *  Arrows, Enter, Esc. */
function PageList({ rows, selected, onPick, noteOf, footer, allowAll, allReason, searchable, label }: {
  rows: readonly ShellPage[];
  selected: string | null;
  onPick: (page: string | null) => void;
  noteOf: (page: ShellPage) => string | null;
  footer?: ReactNode;
  allowAll: boolean;
  allReason?: string | undefined;
  searchable: boolean;
  label: string;
}) {
  const [query, setQuery] = useState("");
  const listId = useId();
  const list = useRef<HTMLDivElement>(null);
  const filtered = useMemo(() => {
    const needle = query.trim().toLowerCase();
    if (!needle) return rows;
    return rows.filter((page) => `${page.label} ${page.modelName} ${page.username ?? ""} ${PLATFORM_WORD[page.platform]}`.toLowerCase().includes(needle));
  }, [query, rows]);

  function focusRow(delta: 1 | -1) {
    const buttons = [...(list.current?.querySelectorAll<HTMLButtonElement>("button.menu-item:not(:disabled)") ?? [])];
    if (buttons.length === 0) return;
    const at = buttons.indexOf(document.activeElement as HTMLButtonElement);
    const next = at < 0 ? (delta === 1 ? 0 : buttons.length - 1) : (at + delta + buttons.length) % buttons.length;
    buttons[next]?.focus();
  }

  function onKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    if (event.key === "ArrowDown") {
      event.preventDefault();
      focusRow(1);
    } else if (event.key === "ArrowUp") {
      event.preventDefault();
      focusRow(-1);
    }
  }

  useEffect(() => {
    list.current?.querySelector<HTMLElement>("input, button.menu-item[aria-selected='true'], button.menu-item:not(:disabled)")?.focus();
  }, []);

  return (
    <div ref={list} id={listId} className="menu menu-floating" role="listbox" aria-label={label} onKeyDown={onKeyDown}>
      {searchable && (
        <div className="menu-search">
          <input
            className="input"
            type="search"
            placeholder="Найти страницу"
            aria-label="Найти страницу"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
          />
        </div>
      )}
      {!query && (
        <>
          <button
            type="button"
            role="option"
            className="menu-item"
            aria-selected={selected === null}
            disabled={!allowAll}
            title={allowAll ? undefined : allReason}
            onClick={() => onPick(null)}
          >
            <span className="menu-check">{selected === null && <Check size={16} aria-hidden="true" />}</span>
            Все страницы
            {!allowAll && allReason && <span className="menu-item-note">{allReason}</span>}
          </button>
          <div className="menu-rule" />
        </>
      )}
      {groupByModel(filtered).map((group) => (
        <div key={group.modelName} role="group" aria-label={group.modelName}>
          <div className="menu-group">{group.modelName}</div>
          {group.pages.map((page) => <PageRow key={page.label} page={page} note={noteOf(page)} selected={selected === page.label} onPick={onPick} />)}
        </div>
      ))}
      {filtered.length === 0 && <p className="menu-group">Такой страницы нет</p>}
      {footer}
    </div>
  );
}

function PageRow({ page, note, selected, onPick }: { page: ShellPage; note: string | null; selected: boolean; onPick: (page: string) => void }) {
  return (
    <button
      type="button"
      role="option"
      className="menu-item"
      aria-selected={selected}
      disabled={note !== null}
      title={note ?? undefined}
      onClick={() => onPick(page.label)}
    >
      <span className="menu-check">{selected && <Check size={16} aria-hidden="true" />}</span>
      <span className="min-w-0 truncate">{page.label}</span>
      <span className="menu-item-note">{note ?? PLATFORM_WORD[page.platform]}</span>
    </button>
  );
}

/**
 * The page filter, first thing in the header's reach and in one place on every
 * screen. Off, it is a plain button. On, it is filled with the ink, names the
 * page and has a cross: a filter left on cannot be missed. A screen about every
 * page says so instead, and a screen with no pages shows nothing: a chip that
 * filters nothing is not drawn.
 */
export function PageFilterChip() {
  const filter = usePageFilter();
  const { pages } = useDashboardShell();
  const [open, setOpen] = useState(false);
  const wrap = useRef<HTMLDivElement>(null);
  const button = useRef<HTMLButtonElement>(null);
  useOverlay(open, () => setOpen(false), wrap);

  if (filter.mode === "none") return null;
  if (filter.mode === "all") {
    return (
      <span className="page-scope">
        Все страницы{filter.remembered ? ` · фильтр ${filter.remembered} здесь не действует` : ""}
      </span>
    );
  }

  const substitutes = filter.mode === "one" && filter.onePageWay === "substitute";
  const label = filter.page ?? "Все страницы";
  const toggle = (
    <button
      ref={button}
      type="button"
      className={filter.page ? "chip-open" : "chip"}
      aria-haspopup="listbox"
      aria-expanded={open}
      aria-label={`Страница: ${label}`}
      onClick={() => setOpen((value) => !value)}
    >
      {filter.page && filter.item ? `${filter.page} · ${PLATFORM_WORD[filter.item.platform]}` : label}
      <ChevronDown size={16} aria-hidden="true" />
    </button>
  );

  return (
    <div
      ref={wrap}
      className="chip-wrap"
      onKeyDown={(event) => {
        if (event.key === "Escape" && open) {
          event.stopPropagation();
          setOpen(false);
          button.current?.focus();
        }
      }}
    >
      {filter.page ? (
        <span className="chip chip-on">
          {toggle}
          {!substitutes && (
            <button type="button" className="chip-clear" aria-label="Показать все страницы" title="Показать все страницы" onClick={() => filter.select(null)}>
              <X size={16} aria-hidden="true" />
            </button>
          )}
        </span>
      ) : toggle}
      {open && (
        <PageList
          label="Страницы"
          rows={pages}
          selected={filter.page}
          noteOf={(page) => outOfScopeNote(page, filter.screen)}
          searchable={pages.length >= 10}
          allowAll={!substitutes}
          allReason={substitutes ? "только одна страница" : undefined}
          onPick={(page) => {
            setOpen(false);
            button.current?.focus();
            filter.select(page);
          }}
          footer={filter.page ? (
            <>
              <div className="menu-rule" />
              <Link className="menu-item" to={buildPageRoute(filter.page)} onClick={() => setOpen(false)}>
                <span className="menu-check" />
                Открыть карточку {filter.page}
              </Link>
            </>
          ) : undefined}
        />
      )}
    </div>
  );
}

/**
 * On a page's card and other screens with the page in the path: the same look,
 * another job. It opens another page's card and leaves the filter alone.
 */
export function OtherPageChip({ current, to }: { current: string; to: (pageLabel: string) => string }) {
  const { pages } = useDashboardShell();
  const navigate = useNavigate();
  const [open, setOpen] = useState(false);
  const wrap = useRef<HTMLDivElement>(null);
  const button = useRef<HTMLButtonElement>(null);
  useOverlay(open, () => setOpen(false), wrap);

  return (
    <div
      ref={wrap}
      className="chip-wrap"
      onKeyDown={(event) => {
        if (event.key === "Escape" && open) {
          event.stopPropagation();
          setOpen(false);
          button.current?.focus();
        }
      }}
    >
      <button ref={button} type="button" className="chip" aria-haspopup="listbox" aria-expanded={open} onClick={() => setOpen((value) => !value)}>
        Другая страница
        <ChevronDown size={16} aria-hidden="true" />
      </button>
      {open && (
        <div className="menu menu-floating" role="listbox" aria-label="Другая страница">
          {groupByModel(pages).map((group) => (
            <div key={group.modelName} role="group" aria-label={group.modelName}>
              <div className="menu-group">{group.modelName}</div>
              {group.pages.map((page) => (
                <PageRow
                  key={page.label}
                  page={page}
                  note={null}
                  selected={page.label === current}
                  onPick={(label) => {
                    setOpen(false);
                    navigate(to(label));
                  }}
                />
              ))}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
