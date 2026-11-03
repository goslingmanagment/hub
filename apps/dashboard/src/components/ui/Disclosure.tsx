import type { ReactNode } from "react";

/** The two words a folded explanation may wear: where a number comes from, and
 *  everything technical. At the very bottom of a screen, closed. */
export function Disclosure({ label = "Как это считается", children, open, className = "" }: {
  label?: "Как это считается" | "Подробнее" | "Числа таблицей" | (string & {});
  children: ReactNode;
  open?: boolean;
  className?: string;
}) {
  return (
    <details className={`help ${className}`.trim()} open={open}>
      <summary>{label}</summary>
      <div className="help-body">{children}</div>
    </details>
  );
}
