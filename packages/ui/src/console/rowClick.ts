import type { MouseEvent } from "react";

const NESTED_CONTROL = "a, button, input, select, textarea, [role='button'], [role='menu'], [tabindex], [contenteditable]:not([contenteditable='false'])";

/**
 * A list row that opens the fan on click behaves like its fan link: a plain
 * left click on an ordinary cell opens it once; a modified or middle click, a
 * click already handled, and a click on a control inside the row (a link, a
 * button, a focusable mark) are left to the browser or that control.
 */
export function isPlainRowClick(event: MouseEvent<HTMLElement>): boolean {
  if (event.defaultPrevented || event.button !== 0 || event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) {
    return false;
  }
  return !(event.target as Element | null)?.closest?.(NESTED_CONTROL);
}
