import { describe, expect, it } from "vitest";
import {
  FORBIDDEN_CODES,
  HOTKEYS,
  MAC_SHIFT_ALIASES,
  MAC_SHIFT_SWALLOWED,
  createHotkeyEngine,
  detectHotkeyPlatform,
  hotkeyAriaShortcut,
  hotkeyChip,
  hotkeyLabel,
  hotkeyName,
  hotkeyDef,
  hotkeysForClient,
  type HotkeyClient,
  type HotkeyKeyEvent,
  type HotkeyPlatform,
} from "../packages/chatgoose-hotkeys/src/index.ts";

type Mods = Partial<Pick<HotkeyKeyEvent, "metaKey" | "ctrlKey" | "altKey" | "shiftKey" | "repeat" | "isComposing">>;

function ev(code: string, key: string, mods: Mods = {}): HotkeyKeyEvent {
  return { code, key, metaKey: false, ctrlKey: false, altKey: false, shiftKey: false, ...mods };
}

const META = ev("MetaLeft", "Meta", { metaKey: true });
const CTRL = ev("ControlLeft", "Control", { ctrlKey: true });

/** Press the primary modifier, then the combo (a fresh press). */
function press(platform: HotkeyPlatform, client: HotkeyClient, event: HotkeyKeyEvent) {
  const engine = createHotkeyEngine({ platform, client });
  engine.keydown(platform === "mac" ? META : CTRL);
  if (event.shiftKey) engine.keydown(ev("ShiftLeft", "Shift", { metaKey: event.metaKey, ctrlKey: event.ctrlKey, shiftKey: true }));
  if (event.altKey && platform === "win") engine.keydown(ev("AltLeft", "Alt", { ctrlKey: true, altKey: true }));
  return engine.keydown(event);
}

function comboFor(platform: HotkeyPlatform, level: "text" | "panel"): Mods {
  if (platform === "mac") return level === "text" ? { metaKey: true } : { metaKey: true, shiftKey: true };
  return level === "text" ? { ctrlKey: true } : { ctrlKey: true, altKey: true };
}

describe("chatgoose hotkey scheme", () => {
  it("assigns one physical key per level and never a forbidden one", () => {
    for (const level of ["text", "panel"] as const) {
      const codes = HOTKEYS.filter((def) => def.level === level).map((def) => def.code);
      expect(new Set(codes).size).toBe(codes.length);
      for (const code of codes) expect(FORBIDDEN_CODES[level][code], `${level}:${code}`).toBeUndefined();
    }
  });

  it("keeps text-level letters out of the panel level so Shift never changes the action", () => {
    const text = new Set(HOTKEYS.filter((def) => def.level === "text").map((def) => def.code));
    for (const def of HOTKEYS.filter((d) => d.level === "panel")) expect(text.has(def.code)).toBe(false);
    for (const code of [...Object.keys(MAC_SHIFT_ALIASES), ...MAC_SHIFT_SWALLOWED]) {
      expect(HOTKEYS.some((def) => def.level === "panel" && def.code === code)).toBe(false);
    }
  });

  it("names every action in both locales and scopes Coach to the extension", () => {
    for (const def of HOTKEYS) {
      expect(def.name.ru.length).toBeGreaterThan(0);
      expect(def.name.en.length).toBeGreaterThan(0);
      expect(def.ruKey).toMatch(/^[А-ЯЁ]$/);
    }
    expect(hotkeysForClient("desktop").map((def) => def.action)).not.toContain("coach");
    expect(hotkeysForClient("extension").map((def) => def.action)).toContain("coach");
    expect(hotkeyName(hotkeyDef("fix"), "desktop")).toBe("Improve");
    expect(hotkeyName(hotkeyDef("recap"), "desktop")).toBe("Scan");
    expect(hotkeyName(hotkeyDef("recap"), "extension", "en")).toBe("Recap");
  });

  it("only Cancel skips the roll-over guard among text actions", () => {
    expect(HOTKEYS.filter((def) => def.level === "text" && !def.guarded).map((def) => def.action)).toEqual(["cancel"]);
  });

  it("detects the platform", () => {
    expect(detectHotkeyPlatform("MacIntel")).toBe("mac");
    expect(detectHotkeyPlatform("darwin")).toBe("mac");
    expect(detectHotkeyPlatform("Win32")).toBe("win");
    expect(detectHotkeyPlatform("Linux x86_64")).toBe("win");
    expect(detectHotkeyPlatform(undefined)).toBe("win");
  });
});

describe("chatgoose hotkey engine — matching", () => {
  for (const platform of ["mac", "win"] as const) {
    for (const def of HOTKEYS) {
      it(`${platform}: ${def.action} fires on its physical key in EN and RU layouts`, () => {
        const mods = comboFor(platform, def.level);
        for (const key of [def.key.toLowerCase(), def.ruKey.toLowerCase()]) {
          const decision = press(platform, "extension", ev(def.code, key, mods));
          expect(decision).toEqual({ kind: "action", action: def.action, repeat: false });
        }
      });
    }
  }

  it("keeps Coach reserved (swallowed, no action) in the desktop", () => {
    expect(press("mac", "desktop", ev("KeyC", "c", { metaKey: true, shiftKey: true }))).toEqual({ kind: "swallow", reason: "reserved" });
  });

  it("is strict about modifiers", () => {
    const misses: Array<[HotkeyPlatform, HotkeyKeyEvent]> = [
      ["mac", ev("KeyE", "e", { ctrlKey: true })],
      ["mac", ev("KeyE", "e", { metaKey: true, ctrlKey: true })],
      ["mac", ev("KeyE", "e", { metaKey: true, altKey: true })],
      ["mac", ev("KeyH", "h", { metaKey: true })],
      ["mac", ev("KeyH", "h", { metaKey: true, altKey: true, shiftKey: true })],
      ["win", ev("KeyE", "e", { ctrlKey: true, shiftKey: true })],
      ["win", ev("KeyE", "e", { altKey: true, shiftKey: true })],
      ["win", ev("KeyE", "e", { ctrlKey: true, metaKey: true })],
      ["win", ev("KeyH", "h", { ctrlKey: true, shiftKey: true })],
      ["win", ev("KeyH", "h", { ctrlKey: true, altKey: true, shiftKey: true })],
      ["win", ev("KeyE", "e", { metaKey: true })],
    ];
    for (const [platform, event] of misses) expect(press(platform, "extension", event), JSON.stringify(event)).toBeNull();
  });

  it("leaves the old desktop and extension combos unbound", () => {
    for (const [code, key] of [["KeyR", "r"], ["KeyT", "t"], ["KeyH", "h"], ["KeyS", "s"], ["KeyF", "f"], ["KeyV", "v"]]) {
      expect(press("mac", "desktop", ev(code!, key!, { metaKey: true }))).toBeNull();
      expect(press("win", "desktop", ev(code!, key!, { ctrlKey: true }))).toBeNull();
    }
    for (const code of ["KeyE", "KeyF", "KeyG", "KeyD", "KeyX"]) {
      expect(press("win", "extension", ev(code, code.slice(3).toLowerCase(), { altKey: true, shiftKey: true }))).toBeNull();
    }
  });

  it("honours the macOS legacy Cmd+Shift habits and nothing else", () => {
    expect(press("mac", "extension", ev("KeyE", "e", { metaKey: true, shiftKey: true }))).toEqual({ kind: "action", action: "reply", repeat: false });
    expect(press("mac", "extension", ev("KeyI", "i", { metaKey: true, shiftKey: true }))).toEqual({ kind: "action", action: "fix", repeat: false });
    expect(press("mac", "extension", ev("KeyG", "g", { metaKey: true, shiftKey: true }))).toEqual({ kind: "action", action: "hi", repeat: false });
    expect(press("mac", "extension", ev("KeyX", "x", { metaKey: true, shiftKey: true }))).toEqual({ kind: "action", action: "cancel", repeat: false });
    expect(press("mac", "extension", ev("KeyD", "d", { metaKey: true, shiftKey: true }))).toEqual({ kind: "swallow", reason: "legacy" });
    expect(press("mac", "extension", ev("KeyF", "f", { metaKey: true, shiftKey: true }))).toEqual({ kind: "swallow", reason: "legacy" });
    expect(press("mac", "extension", ev("KeyP", "p", { metaKey: true, shiftKey: true }))).toBeNull();
    expect(press("mac", "extension", ev("KeyV", "v", { metaKey: true, shiftKey: true }))).toBeNull();
    expect(press("mac", "extension", ev("KeyT", "t", { metaKey: true, shiftKey: true }))).toBeNull();
  });

  it("ignores composition and plain typing", () => {
    expect(press("mac", "extension", ev("KeyE", "e", { metaKey: true, isComposing: true }))).toBeNull();
    const engine = createHotkeyEngine({ platform: "mac", client: "extension" });
    expect(engine.keydown(ev("KeyE", "e"))).toBeNull();
    expect(engine.keydown(ev("ShiftLeft", "Shift", { shiftKey: true }))).toBeNull();
  });
});

describe("chatgoose hotkey engine — repeat and roll-over guard", () => {
  it("returns auto-repeat as a swallow-only repeat, never a second run", () => {
    const engine = createHotkeyEngine({ platform: "mac", client: "extension" });
    engine.keydown(META);
    expect(engine.keydown(ev("KeyE", "e", { metaKey: true }))).toEqual({ kind: "action", action: "reply", repeat: false });
    expect(engine.keydown(ev("KeyE", "e", { metaKey: true, repeat: true }))).toEqual({ kind: "action", action: "reply", repeat: true });
  });

  it("rejects Windows Ctrl+Shift language switch → release Shift → E", () => {
    const engine = createHotkeyEngine({ platform: "win", client: "extension" });
    engine.keydown(CTRL);
    engine.keydown(ev("ShiftLeft", "Shift", { ctrlKey: true, shiftKey: true }));
    engine.keyup(ev("ShiftLeft", "Shift", { ctrlKey: true }));
    expect(engine.keydown(ev("KeyE", "у", { ctrlKey: true }))).toEqual({ kind: "swallow", reason: "rollover" });
    engine.keyup(ev("ControlLeft", "Control"));
    engine.keydown(CTRL);
    expect(engine.keydown(ev("KeyE", "e", { ctrlKey: true }))).toEqual({ kind: "action", action: "reply", repeat: false });
  });

  it("rejects the same switch when Shift went down first", () => {
    const engine = createHotkeyEngine({ platform: "win", client: "desktop" });
    engine.keydown(ev("ShiftLeft", "Shift", { shiftKey: true }));
    engine.keydown(ev("ControlLeft", "Control", { ctrlKey: true, shiftKey: true }));
    engine.keyup(ev("ShiftLeft", "Shift", { ctrlKey: true }));
    expect(engine.keydown(ev("KeyI", "ш", { ctrlKey: true }))).toEqual({ kind: "swallow", reason: "rollover" });
  });

  it("rejects macOS Cmd+Space → E and Cmd+V → e", () => {
    const space = createHotkeyEngine({ platform: "mac", client: "extension" });
    space.keydown(META);
    expect(space.keydown(ev("Space", " ", { metaKey: true }))).toBeNull();
    expect(space.keydown(ev("KeyE", "e", { metaKey: true }))).toEqual({ kind: "swallow", reason: "rollover" });

    const paste = createHotkeyEngine({ platform: "mac", client: "extension" });
    paste.keydown(META);
    expect(paste.keydown(ev("KeyV", "v", { metaKey: true }))).toBeNull();
    expect(paste.keydown(ev("KeyE", "e", { metaKey: true }))).toEqual({ kind: "swallow", reason: "rollover" });
  });

  it("needs a fresh press for a second guarded command, but lets Cancel through", () => {
    const engine = createHotkeyEngine({ platform: "mac", client: "extension" });
    engine.keydown(META);
    expect(engine.keydown(ev("KeyG", "g", { metaKey: true }))).toMatchObject({ kind: "action", action: "hi" });
    expect(engine.keydown(ev("KeyE", "e", { metaKey: true }))).toEqual({ kind: "swallow", reason: "rollover" });
    expect(engine.keydown(ev("Period", ".", { metaKey: true }))).toEqual({ kind: "action", action: "cancel", repeat: false });
  });

  it("does not guard the panel level", () => {
    const engine = createHotkeyEngine({ platform: "mac", client: "extension" });
    engine.keydown(META);
    engine.keydown(ev("KeyV", "v", { metaKey: true }));
    expect(engine.keydown(ev("KeyH", "h", { metaKey: true, shiftKey: true }))).toMatchObject({ kind: "action", action: "help" });
  });

  it("treats a modifier held across focus as unknown until pressed again", () => {
    const engine = createHotkeyEngine({ platform: "mac", client: "extension" });
    expect(engine.keydown(ev("KeyE", "e", { metaKey: true }))).toEqual({ kind: "swallow", reason: "rollover" });
    engine.keydown(META);
    engine.reset();
    expect(engine.keydown(ev("KeyE", "e", { metaKey: true }))).toEqual({ kind: "swallow", reason: "rollover" });
    engine.keyup(ev("MetaLeft", "Meta"));
    engine.keydown(META);
    expect(engine.keydown(ev("KeyE", "e", { metaKey: true }))).toMatchObject({ kind: "action", action: "reply" });
  });

  it("recovers when the modifier keyup was never delivered", () => {
    const engine = createHotkeyEngine({ platform: "win", client: "extension" });
    engine.keydown(CTRL);
    engine.keydown(ev("KeyA", "a")); // Ctrl is already up: a keyup we never saw
    engine.keydown(CTRL);
    expect(engine.keydown(ev("KeyE", "e", { ctrlKey: true }))).toMatchObject({ kind: "action", action: "reply" });
  });
});

describe("chatgoose hotkey labels", () => {
  it("prints the combos per platform", () => {
    expect(hotkeyLabel("reply", "mac")).toBe("⌘E");
    expect(hotkeyLabel("cancel", "mac")).toBe("⌘.");
    expect(hotkeyLabel("help", "mac")).toBe("⌘⇧H");
    expect(hotkeyLabel("reply", "win")).toBe("Ctrl+E");
    expect(hotkeyLabel("help", "win")).toBe("Ctrl+Alt+H");
  });

  it("prints compact chips and aria-keyshortcuts values", () => {
    expect(hotkeyChip("reply", "mac")).toBe("E");
    expect(hotkeyChip("recap", "mac")).toBe("⇧S");
    expect(hotkeyChip("recap", "win")).toBe("Alt+S");
    expect(hotkeyAriaShortcut("reply", "mac")).toBe("Meta+E");
    expect(hotkeyAriaShortcut("tone", "mac")).toBe("Meta+Shift+O");
    expect(hotkeyAriaShortcut("reply", "win")).toBe("Control+E");
    expect(hotkeyAriaShortcut("tone", "win")).toBe("Control+Alt+O");
  });
});
