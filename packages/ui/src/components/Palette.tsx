import { useEffect, useId, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import { Search } from "lucide-react";
import { Kbd } from "./Kbd.js";
import { PALETTE_SHORTCUT } from "../paletteShortcut.js";

export interface PaletteEntry {
  id: string;
  label: string;
  hint?: string | undefined;
}

export interface CommandPaletteProps<T extends PaletteEntry> {
  /** What the query found, under its group headings (palette.ts `searchCommands`, `groupCommands`). */
  groups: readonly { group: string; items: readonly T[] }[];
  query: string;
  onQueryChange: (query: string) => void;
  onPick: (entry: T) => void;
  onClose: () => void;
  /** The field's words: what can be found here. */
  placeholder: string;
  /** Under the list: «ничего не нашлось», a search that did not answer. */
  note?: ReactNode;
}

/**
 * The search of the owner's place (Ctrl/⌘K), one look in both apps: a field,
 * the entries under their group headings, ↑↓ pick, Enter opens, Escape or a
 * click beside it closes. The app decides what is found and what opening does.
 */
export function CommandPalette<T extends PaletteEntry>({ groups, query, onQueryChange, onPick, onClose, placeholder, note }: CommandPaletteProps<T>) {
  const dialog = useRef<HTMLDialogElement>(null);
  const list = useRef<HTMLUListElement>(null);
  const [active, setActive] = useState(0);
  const id = useId();
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

  function onKeyDown(event: KeyboardEvent<HTMLInputElement>) {
    const count = results.length;
    if (event.key === "ArrowDown" && count) {
      event.preventDefault();
      setActive((index) => (index + 1) % count);
    } else if (event.key === "ArrowUp" && count) {
      event.preventDefault();
      setActive((index) => (index - 1 + count) % count);
    } else if (event.key === "Enter") {
      const entry = results[active];
      if (entry) {
        event.preventDefault();
        onPick(entry);
      }
    }
  }

  let index = -1;
  return (
    <dialog
      ref={dialog}
      aria-label="Поиск"
      className="ui-palette"
      onCancel={(event) => {
        event.preventDefault();
        onClose();
      }}
      onClick={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <div className="ui-palette__field">
        <Search size={18} strokeWidth={1.75} className="ui-palette__glyph" aria-hidden />
        <input
          autoFocus
          role="combobox"
          aria-expanded="true"
          aria-controls={`${id}-list`}
          aria-autocomplete="list"
          aria-activedescendant={results.length ? optionId(active) : undefined}
          aria-label={placeholder}
          placeholder={placeholder}
          className="ui-palette__input"
          value={query}
          onChange={(event) => {
            onQueryChange(event.target.value);
            setActive(0);
          }}
          onKeyDown={onKeyDown}
        />
        <span className="ui-palette__esc"><Kbd>Esc</Kbd></span>
      </div>
      <ul ref={list} id={`${id}-list`} role="listbox" aria-label="Найдено" className="ui-palette__list">
        {groups.map((group) => (
          <li key={group.group} role="presentation">
            <div id={`${id}-${group.group}`} className="ui-palette__group" aria-hidden="true">{group.group}</div>
            <ul role="group" aria-labelledby={`${id}-${group.group}`}>
              {group.items.map((entry) => {
                index += 1;
                const position = index;
                return (
                  <li
                    key={entry.id}
                    id={optionId(position)}
                    role="option"
                    aria-selected={position === active}
                    className="ui-palette__option"
                    onMouseMove={() => {
                      if (position !== active) setActive(position);
                    }}
                    onClick={() => onPick(entry)}
                  >
                    <span className="ui-palette__label">{entry.label}</span>
                    {entry.hint && <span className="ui-palette__hint">{entry.hint}</span>}
                  </li>
                );
              })}
            </ul>
          </li>
        ))}
      </ul>
      {note && <p className="ui-palette__note" role="status">{note}</p>}
      <div className="ui-palette__footer" aria-hidden="true">
        <span><Kbd>↑</Kbd><Kbd>↓</Kbd> выбрать</span>
        <span><Kbd>Enter</Kbd> открыть</span>
        <span><Kbd>{PALETTE_SHORTCUT}</Kbd> поиск отовсюду</span>
      </div>
    </dialog>
  );
}
