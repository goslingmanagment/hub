import { consoleFanHref } from "./links.js";

/**
 * A fan, the same way everywhere: their name, else @username, else «фан ·4821»
 * (the last digits; the full number on hover) — never an 18-digit id in the
 * text (spec §4.6). With `pageLabel` and `platform` it opens the fan's card in
 * the console.
 */
export function FanName({ name, username, fanRef, pageLabel, platform, className }: {
  name?: string | null;
  username?: string | null;
  fanRef: string;
  pageLabel?: string;
  platform?: string;
  className?: string;
}) {
  const text = name?.trim() || (username?.trim() ? `@${username.trim()}` : `фан ·${fanRef.slice(-4)}`);
  const title = name || username ? `${text} · ${fanRef}` : `Фан ${fanRef}`;
  if (pageLabel && platform) {
    return <a href={consoleFanHref(pageLabel, platform, fanRef)} className={["ui-quiet-link", className].filter(Boolean).join(" ")} title={title}>{text}</a>;
  }
  return <span className={className} title={title}>{text}</span>;
}
