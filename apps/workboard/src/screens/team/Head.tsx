import type { ReactNode } from "react";

/**
 * A table header in two set lines, so a narrow number column never breaks
 * its label word by word: «Без ответа / к концу». With `sub`, the second line
 * is a quiet qualifier under the whole label: «Ответ, медиана / в среднем за
 * смену» (D1: a period's average says so in its label).
 */
export function Head({ lines, sub }: { lines: readonly [string, string?]; sub?: string | readonly string[] }): ReactNode {
  const [first, second] = lines;
  const subs = sub === undefined ? [] : typeof sub === "string" ? [sub] : sub;
  return (
    <span className="people-head">
      {first}
      {/* On a wide screen a split label stands in one line again. */}
      {second !== undefined && <>{" "}<br className="people-head__break" />{second}</>}
      {subs.map((line) => <span key={line}><br /><span className="people-head__sub">{line}</span></span>)}
    </span>
  );
}
