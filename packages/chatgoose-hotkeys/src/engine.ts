import { HOTKEYS, MAC_SHIFT_ALIASES, MAC_SHIFT_SWALLOWED, type HotkeyAction, type HotkeyClient, type HotkeyDef, type HotkeyPlatform } from "./scheme.ts";

/** The fields of a DOM KeyboardEvent the engine reads. */
export interface HotkeyKeyEvent {
  readonly code: string;
  readonly key: string;
  readonly metaKey: boolean;
  readonly ctrlKey: boolean;
  readonly altKey: boolean;
  readonly shiftKey: boolean;
  readonly repeat?: boolean;
  readonly isComposing?: boolean;
}

/**
 * - "action": run it — unless `repeat` is true, in which case the client
 *   swallows the key (preventDefault) and does NOT run the action again.
 * - "swallow": the combo belongs to ChatGoose but must do nothing now —
 *   a retired habit ("legacy"), a roll-over after an input-language switch
 *   ("rollover"), or a letter reserved in this client ("reserved"). Inside
 *   the ChatGoose context the client calls preventDefault and stops.
 */
export type HotkeyDecision =
  | { readonly kind: "action"; readonly action: HotkeyAction; readonly repeat: boolean }
  | { readonly kind: "swallow"; readonly reason: "legacy" | "rollover" | "reserved" };

export interface HotkeyEngine {
  /** Feed EVERY keydown (modifiers included) in capture order. */
  keydown(event: HotkeyKeyEvent): HotkeyDecision | null;
  /** Feed every keyup. */
  keyup(event: HotkeyKeyEvent): void;
  /** Call on window blur / visibility loss. */
  reset(): void;
}

export interface HotkeyEngineOptions {
  readonly platform: HotkeyPlatform;
  readonly client: HotkeyClient;
}

const META_CODES = new Set(["MetaLeft", "MetaRight", "OSLeft", "OSRight"]);
const CONTROL_CODES = new Set(["ControlLeft", "ControlRight"]);
const SHIFT_CODES = new Set(["ShiftLeft", "ShiftRight"]);
const ALT_CODES = new Set(["AltLeft", "AltRight"]);

function isMeta(event: HotkeyKeyEvent): boolean {
  return META_CODES.has(event.code) || event.key === "Meta" || event.key === "OS";
}
function isControl(event: HotkeyKeyEvent): boolean {
  return CONTROL_CODES.has(event.code) || event.key === "Control";
}
function isShift(event: HotkeyKeyEvent): boolean {
  return SHIFT_CODES.has(event.code) || event.key === "Shift";
}
function isModifier(event: HotkeyKeyEvent): boolean {
  return isMeta(event) || isControl(event) || isShift(event) || ALT_CODES.has(event.code)
    || event.key === "Alt" || event.key === "AltGraph" || event.key === "CapsLock" || event.key === "Fn";
}

type Chord = "text" | "shifted" | "panel" | null;

/** Which modifier chord the event carries, strictly (extra modifiers → null). */
function chordOf(event: HotkeyKeyEvent, platform: HotkeyPlatform): Chord {
  const { metaKey: meta, ctrlKey: ctrl, altKey: alt, shiftKey: shift } = event;
  if (platform === "mac") {
    if (!meta || ctrl || alt) return null;
    return shift ? "shifted" : "text";
  }
  if (!ctrl || meta || shift) return null;
  return alt ? "panel" : "text";
}

/** The fresh-press roll-over guard, as a small state machine.
 *
 * A guarded (text-level) command fires only if, since the primary modifier
 * (Cmd on macOS, Ctrl on Windows) went down, no other non-modifier key was
 * pressed and Shift or Space was not pressed-and-released. A held Shift does
 * not spoil freshness (Cmd+Shift+E must still reply). This rejects:
 * - Windows: Ctrl+Shift (language switch) → release Shift → keep Ctrl → E;
 * - macOS: Cmd+Space (input switch) → E; Cmd+V → e typed before Cmd is up.
 * Consequence, chosen on purpose: a second command under the same held
 * modifier (Cmd+G, then E) needs Cmd pressed again. A modifier already held
 * when the page gained focus is an unknown state and does not fire. */
class FreshPressGuard {
  private primaryDown = false;
  private fresh = false;

  constructor(private readonly platform: HotkeyPlatform) {}

  private isPrimary(event: HotkeyKeyEvent): boolean {
    return this.platform === "mac" ? isMeta(event) : isControl(event);
  }

  private primaryFlag(event: HotkeyKeyEvent): boolean {
    return this.platform === "mac" ? event.metaKey : event.ctrlKey;
  }

  /** Update state for a keydown; returns whether a non-modifier key on this
   * event may count as a fresh press (read BEFORE the key spoils freshness). */
  keydown(event: HotkeyKeyEvent): boolean {
    if (!this.primaryFlag(event) && !this.isPrimary(event)) {
      // The modifier is up — a keyup we never saw (blur, OS-level switch).
      this.primaryDown = false;
      this.fresh = false;
      return false;
    }
    if (this.isPrimary(event)) {
      if (!this.primaryDown) {
        this.primaryDown = true;
        this.fresh = true;
      }
      return false;
    }
    if (isModifier(event)) return false;
    const wasFresh = this.primaryDown && this.fresh;
    if (!event.repeat) this.fresh = false;
    return wasFresh;
  }

  keyup(event: HotkeyKeyEvent): void {
    if (this.isPrimary(event)) {
      this.primaryDown = false;
      this.fresh = false;
      return;
    }
    if (this.primaryDown && (isShift(event) || event.code === "Space")) this.fresh = false;
  }

  reset(): void {
    this.primaryDown = false;
    this.fresh = false;
  }
}

export function createHotkeyEngine(options: HotkeyEngineOptions): HotkeyEngine {
  const { platform, client } = options;
  const guard = new FreshPressGuard(platform);
  const byCode = new Map<string, HotkeyDef>();
  for (const def of HOTKEYS) byCode.set(`${def.level}:${def.code}`, def);

  function decide(def: HotkeyDef, event: HotkeyKeyEvent, fresh: boolean): HotkeyDecision {
    if (!def.clients.includes(client)) return { kind: "swallow", reason: "reserved" };
    if (event.repeat) return { kind: "action", action: def.action, repeat: true };
    if (def.guarded && !fresh) return { kind: "swallow", reason: "rollover" };
    return { kind: "action", action: def.action, repeat: false };
  }

  return {
    keydown(event) {
      const fresh = guard.keydown(event);
      if (event.isComposing || isModifier(event)) return null;
      const chord = chordOf(event, platform);
      if (chord === null) return null;
      if (chord === "text") {
        const def = byCode.get(`text:${event.code}`);
        return def ? decide(def, event, fresh) : null;
      }
      if (chord === "panel" || chord === "shifted") {
        const def = byCode.get(`panel:${event.code}`);
        if (def) return decide(def, event, true);
      }
      if (chord === "shifted") {
        const alias = MAC_SHIFT_ALIASES[event.code];
        if (alias) {
          const def = HOTKEYS.find((candidate) => candidate.action === alias);
          if (def) return decide(def, event, fresh);
        }
        if (MAC_SHIFT_SWALLOWED.includes(event.code)) return { kind: "swallow", reason: "legacy" };
      }
      return null;
    },
    keyup(event) {
      guard.keyup(event);
    },
    reset() {
      guard.reset();
    },
  };
}
