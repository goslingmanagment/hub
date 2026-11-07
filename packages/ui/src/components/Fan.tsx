import type { ReactNode } from "react";
import { cx } from "./cx.js";
import { Tooltip } from "./Tooltip.js";

/** What the app knows of a fan: a name and a login when the platform gave them, always the reference. */
export interface FanLike {
  name?: string | null;
  username?: string | null;
  /** The platform's id of the fan (an 18-digit number on Fansly): never shown whole in the text. */
  fanRef: string;
}

/** «фан ·0120»: a fan with neither a name nor a login, by the last digits of the id. */
export function fanFallback(fanRef: string): string {
  return `фан ·${fanRef.slice(-4)}`;
}

/**
 * A fan as plain words (a subtitle, a confirmation's fact, a toast): the name,
 * else @login, else «фан ·0120». `withLogin` adds the login after the name
 * («Sir Lancelot @lance_77») — for two fans of the same name side by side.
 */
export function fanText(fan: FanLike, options: { withLogin?: boolean } = {}): string {
  const name = fan.name?.trim();
  const login = fan.username?.trim();
  if (name) return options.withLogin && login ? `${name} @${login}` : name;
  if (login) return `@${login}`;
  return fanFallback(fan.fanRef);
}

/**
 * The names shown for more than one fan in a list: give those fans
 * `showLogin`, so two «Sir Lancelot» are told apart (spec r2).
 */
export function collidingFanNames(fans: Iterable<FanLike>): ReadonlySet<string> {
  const refsByName = new Map<string, Set<string>>();
  for (const fan of fans) {
    const name = fan.name?.trim();
    if (!name) continue;
    const key = name.toLocaleLowerCase("ru");
    const refs = refsByName.get(key) ?? new Set<string>();
    refs.add(fan.fanRef);
    refsByName.set(key, refs);
  }
  const names = new Set<string>();
  for (const [key, refs] of refsByName) if (refs.size > 1) names.add(key);
  return names;
}

/** Whether this fan's name is among the colliding ones (`collidingFanNames`). */
export function fanNameCollides(fan: FanLike, colliding: ReadonlySet<string>): boolean {
  const name = fan.name?.trim();
  return !!name && colliding.has(name.toLocaleLowerCase("ru"));
}

export interface FanProps extends FanLike {
  /** Show @login next to the name: two fans of one name in a list (`collidingFanNames`). Otherwise the login is on hover. */
  showLogin?: boolean;
  /** Opens the fan's card (in the console): the name becomes a quiet link. */
  href?: string;
  /** Extra words for the hint, after the login: the page, «платил $120». */
  hint?: ReactNode;
  className?: string;
}

/**
 * One way to show a fan (spec r2): the name; @login when two fans share a
 * name (`showLogin`) or on hover; «фан ·0120» when the platform gave neither —
 * never the 18-digit id in the text.
 */
export function Fan({ name, username, fanRef, showLogin = false, href, hint, className }: FanProps) {
  const cleanName = name?.trim() || null;
  const login = username?.trim() || null;
  const main = cleanName ?? (login ? `@${login}` : fanFallback(fanRef));
  const known = cleanName !== null || login !== null;
  const inline = showLogin && cleanName !== null && login !== null;
  const words = (
    <>
      <span className={cx("ui-fan__name", !known && "ui-fan__name--unknown")}>{main}</span>
      {inline && <span className="ui-fan__login">@{login}</span>}
    </>
  );
  const body = href
    ? <a href={href} className={cx("ui-fan ui-quiet-link", className)}>{words}</a>
    : <span className={cx("ui-fan", className)}>{words}</span>;
  const tipParts: ReactNode[] = [];
  if (cleanName !== null && login !== null && !inline) tipParts.push(`@${login}`);
  if (!known) tipParts.push("Площадка не дала ни имени, ни логина");
  if (hint !== undefined && hint !== null && hint !== "") tipParts.push(hint);
  if (tipParts.length === 0) return body;
  return (
    <Tooltip content={tipParts.map((part, index) => <span key={index} className="ui-fan__tip-line">{part}</span>)} align="start">
      {body}
    </Tooltip>
  );
}
