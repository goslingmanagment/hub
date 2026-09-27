import { hotkeyDef, isMacKeys, type HotkeyAction, type HotkeyLevel, type HotkeyPlatform } from "./scheme.ts";

/** Modifier prefixes as printed, per platform and level. */
export const HOTKEY_MODIFIER_LABELS: Readonly<Record<HotkeyPlatform, Readonly<Record<HotkeyLevel, string>>>> = {
  mac: { text: "⌘", panel: "⌘⇧" },
  win: { text: "Ctrl+", panel: "Ctrl+Alt+" },
};

/** The full combo: "⌘E", "⌘⇧H", "Ctrl+E", "Ctrl+Alt+H". */
export function hotkeyLabel(action: HotkeyAction, platform: HotkeyPlatform): string {
  const def = hotkeyDef(action);
  return `${HOTKEY_MODIFIER_LABELS[platform][def.level]}${def.key}`;
}

/** The compact chip for a toolbar button: the bare key for the text level
 * (every text combo shares one modifier), "⇧H" / "Alt+H" for the panel level. */
export function hotkeyChip(action: HotkeyAction, platform: HotkeyPlatform): string {
  const def = hotkeyDef(action);
  if (def.level === "text") return def.key;
  return isMacKeys(platform) ? `⇧${def.key}` : `Alt+${def.key}`;
}

/** The value for the aria-keyshortcuts attribute (WAI-ARIA key names). */
export function hotkeyAriaShortcut(action: HotkeyAction, platform: HotkeyPlatform): string {
  const def = hotkeyDef(action);
  const modifiers = isMacKeys(platform)
    ? (def.level === "text" ? ["Meta"] : ["Meta", "Shift"])
    : (def.level === "text" ? ["Control"] : ["Control", "Alt"]);
  return [...modifiers, def.key].join("+");
}
