import type { ReactNode } from "react";

/** A key to press: «J», «K», «↑», «Esc». 13 px, the only place besides axes. */
export function Kbd({ children, title }: { children: ReactNode; title?: string }) {
  return <kbd className="ui-kbd" title={title}>{children}</kbd>;
}
