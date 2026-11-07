import type { ReactNode } from "react";
import { cx } from "./cx.js";

/**
 * - `working`: on a shift now — a green dot;
 * - `away`: not on a shift — no dot;
 * - `disabled`: access switched off — a hollow ring, the name greyed;
 * - `invited`: has not signed up yet — a grey dot.
 */
export type PersonStatus = "working" | "away" | "disabled" | "invited";

const STATUS_WORD: Record<PersonStatus, string> = {
  working: "На смене",
  away: "Не на смене",
  disabled: "Отключён",
  invited: "Ждёт регистрации",
};

/** The first letter of a login, for the circle: «alex.k» → «A». */
function initialOf(name: string): string {
  const letter = name.trim().match(/\p{L}|\p{N}/u)?.[0];
  return letter ?? "?";
}

/**
 * One way to show a person everywhere: a circle with the initial, the name and
 * a status dot. `hint` is a quiet second line («5 смен, 41 ч»). Wrap it in a
 * link outside (Workboard's PersonLink); it is not a link itself.
 */
export function Person({ name, status = "away", hint, size = "md", className, title }: {
  name: string;
  status?: PersonStatus;
  hint?: ReactNode;
  size?: "md" | "lg";
  className?: string;
  title?: string;
}) {
  const word = STATUS_WORD[status];
  return (
    <span className={cx("ui-person", size === "lg" && "ui-person--lg", status === "disabled" && "ui-person--disabled", className)} title={title}>
      <span className="ui-person__avatar" aria-hidden>
        {initialOf(name)}
        {status !== "away" && <span className={cx("ui-person__dot", `ui-person__dot--${status}`)} />}
      </span>
      <span className="ui-person__text">
        <span className="ui-person__name">{name}</span>
        {hint !== undefined && hint !== null && <span className="ui-person__hint">{hint}</span>}
      </span>
      {status !== "away" && <span className="ui-sr-only">, {word.toLowerCase()}</span>}
    </span>
  );
}

export { STATUS_WORD as PERSON_STATUS_WORD };
