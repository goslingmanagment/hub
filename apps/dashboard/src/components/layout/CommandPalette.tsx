import { useEffect, useId, useMemo, useRef, useState, type KeyboardEvent } from "react";
import { useLocation, useNavigate } from "react-router";
import { Search } from "lucide-react";
import { useQuery } from "@tanstack/react-query";
import { useFansSearch } from "@/api/fansSearch";
import { kernel } from "@/api/sdk";
import { buildCommands, fanCommands, groupCommands, searchCommands, type Command, type CommandSetting } from "@/lib/commands";
import { PALETTE_SHORTCUT } from "@/lib/paletteShortcut";
import { useThemeStore } from "@/lib/theme";
import { CONFIG_COPY_RU } from "@/pages/settings/configCopyRu";
import { useDashboardShell } from "./DashboardShellContext.js";

/** One field to reach anything: a section, a page or one of its views, a fan, a
 *  setting. Opens with Ctrl/⌘K or the search button; ↑↓ pick, Enter opens. It
 *  only navigates and changes the theme. */
export function CommandPalette({ role, onClose }: { role: string; onClose: () => void }) {
  const { pages } = useDashboardShell();
  const navigate = useNavigate();
  const location = useLocation();
  const setTheme = useThemeStore((state) => state.setTheme);
  const dialog = useRef<HTMLDialogElement>(null);
  const list = useRef<HTMLUListElement>(null);
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(0);
  const id = useId();
  const typing = query.trim().length > 0;
  const config = useQuery({
    queryKey: ["admin", "config"],
    queryFn: () => kernel.adminConfig(),
    enabled: role === "owner" && typing,
    meta: { suppressGlobalError: true },
  });
  const settings = useMemo<CommandSetting[]>(() => (config.data?.subsystems ?? [])
    .flatMap((subsystem) => subsystem.items)
    .filter((item) => !item.secret && CONFIG_COPY_RU[item.key])
    .map((item) => ({ key: item.key, title: CONFIG_COPY_RU[item.key]!.title, subsystem: item.subsystem })), [config.data]);
  const commands = useMemo(() => buildCommands({ role, pages, settings }), [role, pages, settings]);
  const fans = useFansSearch(query);
  const backTo = `${location.pathname}${location.search}`;
  const fanResults = useMemo(() => fanCommands(fans.items, backTo), [backTo, fans.items]);
  const groups = useMemo(() => groupCommands([...searchCommands(commands, query), ...fanResults]), [commands, fanResults, query]);
  const results = groups.flatMap((group) => group.items);
  const optionId = (index: number) => `${id}-option-${index}`;

  useEffect(() => {
    const element = dialog.current!;
    const trigger = document.activeElement as HTMLElement | null;
    element.showModal();
    return () => {
      element.close();
      if (trigger?.isConnected) trigger.focus();
    };
  }, []);

  useEffect(() => {
    list.current?.querySelector(`[id="${optionId(active)}"]`)?.scrollIntoView({ block: "nearest" });
  });

  function open(command: Command) {
    onClose();
    if (command.theme) setTheme(command.theme);
    else navigate(command.to, command.state ? { state: command.state } : undefined);
  }

  function onKeyDown(event: KeyboardEvent<HTMLInputElement>) {
    const count = results.length;
    if (event.key === "ArrowDown" && count) {
      event.preventDefault();
      setActive((index) => (index + 1) % count);
    } else if (event.key === "ArrowUp" && count) {
      event.preventDefault();
      setActive((index) => (index - 1 + count) % count);
    } else if (event.key === "Enter") {
      const command = results[active];
      if (command) {
        event.preventDefault();
        open(command);
      }
    }
  }

  let index = -1;
  return (
    <dialog
      ref={dialog}
      aria-label="Поиск"
      className="palette"
      onCancel={(event) => {
        event.preventDefault();
        onClose();
      }}
      onClick={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <div className="palette-field">
        <Search size={18} className="shrink-0 text-text-muted" aria-hidden="true" />
        <input
          autoFocus
          role="combobox"
          aria-expanded="true"
          aria-controls={`${id}-list`}
          aria-autocomplete="list"
          aria-activedescendant={results.length ? optionId(active) : undefined}
          aria-label="Найти: раздел, страницу, фана"
          placeholder="Найти: раздел, страницу, фана"
          className="palette-input"
          value={query}
          onChange={(event) => {
            setQuery(event.target.value);
            setActive(0);
          }}
          onKeyDown={onKeyDown}
        />
        <kbd className="kbd hidden sm:inline-flex">Esc</kbd>
      </div>
      <ul ref={list} id={`${id}-list`} role="listbox" aria-label="Найдено" className="palette-list">
        {groups.map((group) => (
          <li key={group.group} role="presentation">
            <div id={`${id}-${group.group}`} className="palette-group" aria-hidden="true">{group.group}</div>
            <ul role="group" aria-labelledby={`${id}-${group.group}`}>
              {group.items.map((command) => {
                index += 1;
                const position = index;
                return (
                  <li
                    key={command.id}
                    id={optionId(position)}
                    role="option"
                    aria-selected={position === active}
                    className="palette-option"
                    onMouseMove={() => {
                      if (position !== active) setActive(position);
                    }}
                    onClick={() => open(command)}
                  >
                    <span className="min-w-0 truncate">{command.label}</span>
                    {command.hint && <span className="palette-hint">{command.hint}</span>}
                  </li>
                );
              })}
            </ul>
          </li>
        ))}
      </ul>
      {fans.failed && <p className="palette-note" role="status">Поиск фанов не ответил.</p>}
      {results.length === 0 && !fans.pending && !fans.failed && (
        <p className="palette-note" role="status">
          Ничего не нашлось. Ищите по названию раздела, страницы, модели, по имени фана.
        </p>
      )}
      <div className="palette-footer" aria-hidden="true">
        <span><kbd className="kbd">↑</kbd><kbd className="kbd">↓</kbd> выбрать</span>
        <span><kbd className="kbd">Enter</kbd> открыть</span>
        <span><kbd className="kbd">{PALETTE_SHORTCUT}</kbd> поиск отовсюду</span>
      </div>
    </dialog>
  );
}
