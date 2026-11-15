import { useState, type ReactNode } from "react";

/**
 * The words a folded explanation may wear: «Как это считается», where a number comes
 * from; «Подробнее», everything technical; «Числа таблицей», under a chart. At the
 * very bottom of a screen, closed. `lazy`: the body is built at the first opening.
 * A folded card with a heading of its own is `DisclosureCard`.
 */
export function Disclosure({ label = "Как это считается", children, open, id, className = "", lazy = false, onToggle }: {
  label?: "Как это считается" | "Подробнее" | "Числа таблицей" | (string & {});
  children: ReactNode;
  open?: boolean | undefined;
  /** An anchor: `#authors` scrolls to it and the caller opens it. */
  id?: string | undefined;
  className?: string;
  lazy?: boolean;
  onToggle?: ((open: boolean) => void) | undefined;
}) {
  const [opened, setOpened] = useState(open === true);
  return (
    <details
      id={id}
      className={`help ${className}`.trim()}
      open={open}
      onToggle={(event) => {
        if (event.currentTarget.open) setOpened(true);
        onToggle?.(event.currentTarget.open);
      }}
    >
      <summary>{label}</summary>
      {(!lazy || opened || open) && <div className="help-body">{children}</div>}
    </details>
  );
}
