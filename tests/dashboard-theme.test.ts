import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";

import { readThemePreference, THEME_STORAGE_KEY, useThemeStore } from "../apps/dashboard/src/lib/theme.ts";

const css = readFileSync(new URL("../apps/dashboard/src/globals.css", import.meta.url), "utf8");
const tokens = (block: string) => new Set([...block.matchAll(/--(color-[\w-]+):/g)].map((match) => match[1]));
const between = (start: string, end: string) => {
  const from = css.indexOf(start);
  return css.slice(from, css.indexOf(end, from + start.length));
};

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("dark theme tokens", () => {
  it("gives every colour token a dark value, for the system choice and for an explicit one", () => {
    const light = tokens(between("@theme {", "\n}"));
    const system = tokens(between('@media (prefers-color-scheme: dark)', "\n}\n"));
    const explicit = tokens(between(':root[data-theme="dark"] {', "\n}"));
    expect(light.size).toBeGreaterThan(30);
    expect([...light].filter((token) => !system.has(token))).toEqual([]);
    expect([...light].filter((token) => !explicit.has(token))).toEqual([]);
    expect(css).toContain(':root:not([data-theme="light"])');
  });

  it("names the pre-paint key the theme store writes", () => {
    const html = readFileSync(new URL("../apps/dashboard/index.html", import.meta.url), "utf8");
    expect(html).toContain(`localStorage.getItem("${THEME_STORAGE_KEY}")`);
    expect(html).toContain('<meta name="color-scheme" content="light dark" />');
  });
});

describe("theme preference", () => {
  it("follows the system when nothing or something unknown is stored, or storage is unavailable", () => {
    vi.stubGlobal("localStorage", { getItem: () => null });
    expect(readThemePreference()).toBe("system");
    vi.stubGlobal("localStorage", { getItem: () => "sepia" });
    expect(readThemePreference()).toBe("system");
    vi.stubGlobal("localStorage", { getItem: () => { throw new Error("blocked"); } });
    expect(readThemePreference()).toBe("system");
    vi.stubGlobal("localStorage", { getItem: () => "dark" });
    expect(readThemePreference()).toBe("dark");
  });

  it("stores an explicit choice on the root element and forgets it for the system choice", () => {
    const storage = new Map<string, string>();
    const attributes = new Map<string, string>();
    vi.stubGlobal("localStorage", {
      setItem: (key: string, value: string) => storage.set(key, value),
      removeItem: (key: string) => storage.delete(key),
    });
    vi.stubGlobal("document", {
      documentElement: {
        setAttribute: (name: string, value: string) => attributes.set(name, value),
        removeAttribute: (name: string) => attributes.delete(name),
      },
    });
    useThemeStore.getState().setTheme("dark");
    expect(storage.get(THEME_STORAGE_KEY)).toBe("dark");
    expect(attributes.get("data-theme")).toBe("dark");
    expect(useThemeStore.getState().theme).toBe("dark");
    useThemeStore.getState().setTheme("system");
    expect(storage.has(THEME_STORAGE_KEY)).toBe(false);
    expect(attributes.has("data-theme")).toBe(false);
  });
});
