import { create } from "zustand";

/**
 * Light, dark, or whatever the system uses. The choice lives in this browser
 * only; "system" is the absence of a choice. index.html reads the same key
 * before the first paint, so a dark choice never flashes light on load.
 */
export type ThemePreference = "system" | "light" | "dark";

export const THEME_STORAGE_KEY = "hub-theme";

export const THEME_OPTIONS: readonly { value: ThemePreference; label: string }[] = [
  { value: "system", label: "Как в системе" },
  { value: "light", label: "Светлая" },
  { value: "dark", label: "Тёмная" },
];

export function readThemePreference(): ThemePreference {
  try {
    const saved = localStorage.getItem(THEME_STORAGE_KEY);
    return saved === "light" || saved === "dark" ? saved : "system";
  } catch {
    return "system";
  }
}

function applyTheme(theme: ThemePreference) {
  if (typeof document === "undefined") return;
  if (theme === "system") document.documentElement.removeAttribute("data-theme");
  else document.documentElement.setAttribute("data-theme", theme);
}

export const useThemeStore = create<{ theme: ThemePreference; setTheme: (theme: ThemePreference) => void }>((set) => ({
  theme: readThemePreference(),
  setTheme: (theme) => {
    try {
      if (theme === "system") localStorage.removeItem(THEME_STORAGE_KEY);
      else localStorage.setItem(THEME_STORAGE_KEY, theme);
    } catch {
      /* Without storage the choice holds until the tab closes. */
    }
    applyTheme(theme);
    set({ theme });
  },
}));
