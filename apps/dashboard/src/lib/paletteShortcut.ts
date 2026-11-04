export const IS_MAC = typeof navigator !== "undefined" && /Mac|iPhone|iPad/.test(navigator.userAgent);
export const PALETTE_SHORTCUT = IS_MAC ? "⌘K" : "Ctrl K";
export const PALETTE_ARIA_SHORTCUT = IS_MAC ? "Meta+K" : "Control+K";

/** Ctrl/⌘K — by the key's place, so it works in the Russian layout too. */
export function isPaletteShortcut(event: { code: string; key: string; metaKey: boolean; ctrlKey: boolean; altKey: boolean; shiftKey: boolean }) {
  return (event.metaKey || event.ctrlKey) && !event.altKey && !event.shiftKey
    && (event.code === "KeyK" || event.key.toLowerCase() === "k");
}
