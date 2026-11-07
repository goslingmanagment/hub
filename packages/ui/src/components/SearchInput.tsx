import { Search, X } from "lucide-react";
import { forwardRef, useEffect, useImperativeHandle, useRef, type InputHTMLAttributes } from "react";
import { cx } from "./cx.js";
import { Kbd } from "./Kbd.js";

export interface SearchInputProps extends Omit<InputHTMLAttributes<HTMLInputElement>, "value" | "onChange" | "type"> {
  value: string;
  onChange: (value: string) => void;
  /** What is searched, said in the field and to a screen reader: «Фан или текст». */
  placeholder: string;
  /** «/» focuses the field from anywhere on the screen (not while typing elsewhere). */
  slashShortcut?: boolean;
  /** Width of the field; full by default. */
  width?: number | string;
}

/** A search field: icon, words, a cross to clear; Escape clears too. */
export const SearchInput = forwardRef<HTMLInputElement, SearchInputProps>(function SearchInput(
  { value, onChange, placeholder, slashShortcut = false, width, className, onKeyDown, ...rest },
  ref,
) {
  const input = useRef<HTMLInputElement>(null);
  useImperativeHandle(ref, () => input.current as HTMLInputElement);

  useEffect(() => {
    if (!slashShortcut) return;
    function onKey(event: KeyboardEvent) {
      if (event.key !== "/" || event.metaKey || event.ctrlKey || event.altKey) return;
      const target = event.target as HTMLElement | null;
      if (target?.closest("input, textarea, select, [contenteditable='true']")) return;
      event.preventDefault();
      input.current?.focus();
    }
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [slashShortcut]);

  return (
    <span className={cx("ui-search", className)} style={width !== undefined ? { width } : undefined}>
      <Search size={16} strokeWidth={1.75} aria-hidden className="ui-search__icon" />
      <input
        ref={input}
        type="search"
        className="ui-input"
        value={value}
        placeholder={placeholder}
        aria-label={rest["aria-label"] ?? placeholder}
        onChange={(event) => onChange(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === "Escape" && value) {
            event.preventDefault();
            event.stopPropagation();
            onChange("");
          }
          onKeyDown?.(event);
        }}
        {...rest}
      />
      <span className="ui-search__end">
        {value ? (
          <button type="button" className="ui-search__clear" aria-label="Очистить поиск" title="Очистить поиск" onClick={() => { onChange(""); input.current?.focus(); }}>
            <X size={14} strokeWidth={2} aria-hidden />
          </button>
        ) : slashShortcut ? <Kbd title="Нажмите «/», чтобы искать">/</Kbd> : null}
      </span>
    </span>
  );
});
