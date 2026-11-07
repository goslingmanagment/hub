import { Check, MoreHorizontal } from "lucide-react";
import { useCallback, useId, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { Button, IconButton, type ButtonSize, type IconComponent } from "./Button.js";
import { cx } from "./cx.js";
import { useAnchoredPosition, useDismiss } from "./popover.js";

export interface MenuAction {
  label: ReactNode;
  onSelect: () => void;
  icon?: IconComponent;
  /** Removes, switches off: red words. Its confirmation is the caller's. */
  danger?: boolean;
  disabled?: boolean;
  /** Why it is off, or what it does: on hover. */
  title?: string;
  /** Quiet words at the end: a key, a count. */
  hint?: ReactNode;
  /** A choice of several: a tick in front. */
  checked?: boolean;
}

export type MenuEntry = MenuAction | { separator: true } | { group: string };

function isAction(entry: MenuEntry): entry is MenuAction {
  return "onSelect" in entry;
}

export interface MenuProps {
  items: readonly MenuEntry[];
  /** The trigger's name: «Ещё», «Действия с alex.k». */
  label?: string;
  /** `icon` (default): «…»; `button`: the label in words with the icon. */
  trigger?: "icon" | "button";
  triggerIcon?: IconComponent;
  size?: ButtonSize;
  align?: "start" | "end";
  /** A trigger of one's own: gets the props to spread on a button. */
  renderTrigger?: (props: TriggerProps) => ReactNode;
}

export interface TriggerProps {
  ref: (element: HTMLButtonElement | null) => void;
  onClick: () => void;
  onKeyDown: (event: KeyboardEvent<HTMLButtonElement>) => void;
  "aria-haspopup": "menu";
  "aria-expanded": boolean;
  "aria-controls": string | undefined;
}

/**
 * Secondary actions behind one button («Ещё»): the screen shows one primary
 * action, the rest wait here. Arrows move, Enter picks, Escape closes and gives
 * the focus back. Dangerous actions are red and still ask before they run.
 */
export function Menu({ items, label = "Ещё", trigger = "icon", triggerIcon = MoreHorizontal, size = "md", align = "end", renderTrigger }: MenuProps) {
  const [open, setOpen] = useState(false);
  const anchor = useRef<HTMLButtonElement | null>(null);
  const box = useRef<HTMLDivElement | null>(null);
  const id = useId();
  const close = useCallback(() => setOpen(false), []);
  const style = useAnchoredPosition(anchor, box, open, { align });
  useDismiss(open, close, [box, anchor], anchor);

  function focusItem(which: "first" | "last" | 1 | -1) {
    const buttons = [...(box.current?.querySelectorAll<HTMLButtonElement>(".ui-menu__item:not([aria-disabled='true'])") ?? [])];
    if (buttons.length === 0) return;
    const at = buttons.indexOf(document.activeElement as HTMLButtonElement);
    const index = which === "first" ? 0 : which === "last" ? buttons.length - 1 : at < 0 ? 0 : (at + which + buttons.length) % buttons.length;
    buttons[index]?.focus();
  }

  function openAndFocus(which: "first" | "last") {
    setOpen(true);
    requestAnimationFrame(() => focusItem(which));
  }

  const triggerProps: TriggerProps = {
    ref: (element) => {
      anchor.current = element;
    },
    onClick: () => (open ? setOpen(false) : openAndFocus("first")),
    onKeyDown: (event) => {
      if (event.key === "ArrowDown") {
        event.preventDefault();
        openAndFocus("first");
      } else if (event.key === "ArrowUp") {
        event.preventDefault();
        openAndFocus("last");
      }
    },
    "aria-haspopup": "menu",
    "aria-expanded": open,
    "aria-controls": open ? id : undefined,
  };

  const { ref: triggerRef, ...triggerRest } = triggerProps;
  return (
    <>
      {renderTrigger ? renderTrigger(triggerProps) : trigger === "icon" ? (
        <IconButton ref={triggerRef} icon={triggerIcon} label={label} size={size} {...triggerRest} />
      ) : (
        <Button ref={triggerRef} icon={triggerIcon} size={size} {...triggerRest}>{label}</Button>
      )}
      {open && createPortal(
        <div
          ref={box}
          id={id}
          role="menu"
          aria-label={label}
          className="ui-popover ui-menu"
          style={style}
          onKeyDown={(event) => {
            if (event.key === "ArrowDown") {
              event.preventDefault();
              focusItem(1);
            } else if (event.key === "ArrowUp") {
              event.preventDefault();
              focusItem(-1);
            } else if (event.key === "Home") {
              event.preventDefault();
              focusItem("first");
            } else if (event.key === "End") {
              event.preventDefault();
              focusItem("last");
            } else if (event.key === "Tab") {
              close();
            }
          }}
        >
          {items.map((entry, index) => {
            if ("separator" in entry) return <div key={index} role="separator" className="ui-menu__sep" />;
            if ("group" in entry) return <div key={index} className="ui-menu__group">{entry.group}</div>;
            if (!isAction(entry)) return null;
            const Icon = entry.icon;
            const checkable = items.some((item) => isAction(item) && item.checked !== undefined);
            return (
              <button
                key={index}
                type="button"
                role={entry.checked === undefined ? "menuitem" : "menuitemradio"}
                aria-checked={entry.checked}
                aria-disabled={entry.disabled || undefined}
                title={entry.title}
                tabIndex={-1}
                className={cx("ui-menu__item", entry.danger && "ui-menu__item--danger")}
                onClick={() => {
                  if (entry.disabled) return;
                  close();
                  anchor.current?.focus();
                  entry.onSelect();
                }}
              >
                {checkable && <span className="ui-menu__check">{entry.checked ? <Check size={16} strokeWidth={2} aria-hidden /> : null}</span>}
                {Icon && <Icon size={16} strokeWidth={1.75} aria-hidden className="ui-menu__icon" />}
                <span className="ui-menu__label">{entry.label}</span>
                {entry.hint !== undefined && <span className="ui-menu__hint">{entry.hint}</span>}
              </button>
            );
          })}
        </div>,
        document.body,
      )}
    </>
  );
}
