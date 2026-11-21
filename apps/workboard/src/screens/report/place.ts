/** A floating box's margin from the window's edges. */
const MARGIN = 8;
const GAP = 6;

/**
 * Put a floating box (`position: fixed`) by its anchor, inside the window: under the anchor, or over it when it does not
 * fit there (`prefer: "above"` the other way round), its right edge at the anchor's right and never past the margins;
 * taller than the window, it scrolls inside itself. No React here.
 */
export function placeBy(box: HTMLElement, anchor: Element, prefer: "below" | "above" = "below"): void {
  const at = anchor.getBoundingClientRect();
  const width = document.documentElement.clientWidth;
  const height = document.documentElement.clientHeight;
  box.style.maxHeight = `${height - 2 * MARGIN}px`;
  const tall = box.offsetHeight;
  const wide = box.offsetWidth;
  const fitsBelow = at.bottom + GAP + tall <= height - MARGIN;
  const fitsAbove = at.top - GAP - tall >= MARGIN;
  const below = prefer === "below" ? fitsBelow || !fitsAbove : fitsBelow && !fitsAbove;
  const top = below ? Math.min(at.bottom + GAP, height - MARGIN - tall) : Math.max(MARGIN, at.top - GAP - tall);
  box.style.top = `${Math.round(Math.max(MARGIN, top))}px`;
  box.style.left = `${Math.round(Math.max(MARGIN, Math.min(at.right - wide, width - MARGIN - wide)))}px`;
}
