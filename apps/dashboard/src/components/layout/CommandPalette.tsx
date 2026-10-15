import { useEffect, useId, useMemo, useRef, useState, type KeyboardEvent } from "react";
import { useNavigate } from "react-router";
import { Search } from "lucide-react";
import { buildCommands, groupCommands, searchCommands, type Command } from "@/lib/commands";
import { useDashboardShell } from "./DashboardShellContext.js";

export const IS_MAC = typeof navigator !== "undefined" && /Mac|iPhone|iPad/.test(navigator.userAgent);
export const PALETTE_SHORTCUT = IS_MAC ? "⌘K" : "Ctrl K";
export const PALETTE_ARIA_SHORTCUT = IS_MAC ? "Meta+K" : "Control+K";

/** Ctrl/⌘K — by the key's place, so it works in the Russian layout too. */
export function isPaletteShortcut(event: { code: string; key: string; metaKey: boolean; ctrlKey: boolean; altKey: boolean; shiftKey: boolean }) {
  return (event.metaKey || event.ctrlKey) && !event.altKey && !event.shiftKey
    && (event.code === "KeyK" || event.key.toLowerCase() === "k");
}

/** One field to reach any screen: a section, a page or one of its views, a
 *  setting. Opens with Ctrl/⌘K or the search button; ↑↓ pick, Enter opens. */
export function CommandPalette({ role, onClose }: { role: string; onClose: () => void }) {
  const { pages } = useDashboardShell();
  const navigate = useNavigate();
  const dialog = useRef<HTMLDialogElement>(null);
  const list = useRef<HTMLUListElement>(null);
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(0);
  const id = useId();
  const commands = useMemo(() => buildCommands({ role, pages }), [role, pages]);
  const groups = useMemo(() => groupCommands(searchCommands(commands, query)), [commands, query]);
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
    navigate(command.to);
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
      aria-label="Поиск по разделам"
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
          aria-label="Раздел, страница или настройка"
          placeholder="Раздел, страница, модель или настройка"
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
      {results.length === 0 && (
        <p className="px-4 pb-5 pt-1 text-sm text-text-secondary" role="status">
          Ничего не нашлось. Ищите по названию раздела, страницы, модели или настройки.
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
