// The page's environment as the browser shows it (plan §4.1, step 2: after
// every restart and every Chrome update the operator compares the actual
// values; spec §10 "Окружение"). It runs on every start, once control is
// attached and before the self-test; a difference of the time zone or the
// languages fails the start (`env_mismatch`), with what was seen in its
// reason.
//
// In the work tab, from an isolated world (the page's own code never sees
// it): Intl's time zone, navigator.languages and navigator.language,
// screen.width × screen.height. The zone is equal when it is the page's, or
// what Chrome's own ICU calls the page's (it names aliases its own way:
// Europe/Kyiv is Europe/Kiev in Chrome 155). The screen is read for the
// operator, which alarms on one that is not the image's and goes on (it is
// no difference of the page's settings). No position is read: none is set
// (cdp/control.ts), and the hello's is not used.
//
// Nothing the check reads is a secret; it goes to the log and the states
// journal. The protocol's `state` has no place for it (spec §6.1).

import type { Cdp } from "../cdp/client.ts";
import type { BrowserControl } from "../cdp/control.ts";
import { errorMessage } from "../shared/util.ts";
import type { PageEnv } from "./rules.ts";

export interface SeenEnv {
  timeZone: string | null;
  /** Chrome's own name of the page's zone; null when Chrome does not know it. */
  settingsTimeZone: string | null;
  languages: string[];
  language: string | null;
  screen: { width: number; height: number };
}

export interface EnvCheckResult {
  ok: boolean;
  /** Each difference in words; empty when all is equal. */
  mismatches: string[];
  seen: SeenEnv | null;
  durationMs: number;
}

/** In an isolated world of the work tab: what the browser shows. */
const READ = (zone: string) => `(function pbEnvShown(zone) {
  var settings = null;
  try { settings = new Intl.DateTimeFormat("en-US", { timeZone: zone }).resolvedOptions().timeZone; } catch (e) {}
  return {
    timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
    settingsTimeZone: settings,
    languages: Array.from(navigator.languages),
    language: navigator.language,
    screen: { width: screen.width, height: screen.height }
  };
})(${JSON.stringify(zone)})`;

const list = (values: readonly string[]) => (values.length === 0 ? "(none)" : values.join(", "));

/** Every way what Chrome shows differs from the page's settings (its time
 *  zone and languages; the screen is not one of them). */
export function compareEnv(expected: PageEnv, seen: SeenEnv): string[] {
  const mismatches: string[] = [];
  if (seen.timeZone !== expected.timeZone && (seen.settingsTimeZone === null || seen.timeZone !== seen.settingsTimeZone)) {
    mismatches.push(`time zone ${seen.timeZone ?? "(none)"}, not ${expected.timeZone}${seen.settingsTimeZone === null ? " (Chrome does not know that zone)" : ""}`);
  }
  const languagesEqual = seen.languages.length === expected.languages.length && seen.languages.every((tag, index) => tag === expected.languages[index]);
  if (!languagesEqual) {
    const extended = seen.languages.length > expected.languages.length && expected.languages.every((tag, index) => tag === seen.languages[index]);
    mismatches.push(
      `navigator.languages ${list(seen.languages)}, not ${list(expected.languages)}` +
        (extended ? " (Chrome adds its UI language's defaults after the page's list: the page's settings must list them too)" : ""),
    );
  }
  if (seen.language !== expected.languages[0]) mismatches.push(`navigator.language ${seen.language ?? "(none)"}, not ${expected.languages[0]}`);
  return mismatches;
}

function text(value: unknown, max = 128): string | null {
  return typeof value === "string" ? value.slice(0, max) : null;
}

function count(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : -1;
}

/** What the page answered, as plain values whatever it sent. */
function asRead(value: unknown): SeenEnv {
  const read = (value ?? {}) as Record<string, unknown>;
  const screen = (read.screen ?? {}) as Record<string, unknown>;
  return {
    timeZone: text(read.timeZone),
    settingsTimeZone: text(read.settingsTimeZone),
    languages: Array.isArray(read.languages) ? read.languages.slice(0, 32).map((tag) => text(tag, 64) ?? "?") : [],
    language: text(read.language, 64),
    screen: { width: count(screen.width), height: count(screen.height) },
  };
}

export class EnvCheck {
  readonly #cdp: Cdp;
  readonly #control: BrowserControl;

  constructor(cdp: Cdp, control: BrowserControl) {
    this.#cdp = cdp;
    this.#control = control;
  }

  /** Reads the environment in the browser and compares it with `env`. */
  async run(env: PageEnv, timeoutMs: number): Promise<EnvCheckResult> {
    const started = Date.now();
    let seen: SeenEnv | null = null;
    try {
      const tab = this.#control.workTab;
      if (!tab) throw new Error("no work tab");
      const world = await this.#control.isolatedWorld(tab, "pb-env");
      seen = asRead(await this.#evaluate(tab.sessionId, READ(env.timeZone), world, Math.max(1, started + timeoutMs - Date.now())));
    } catch (error) {
      return { ok: false, mismatches: [`the check could not run: ${errorMessage(error)}`], seen, durationMs: Date.now() - started };
    }
    const mismatches = compareEnv(env, seen);
    return { ok: mismatches.length === 0, mismatches, seen, durationMs: Date.now() - started };
  }

  async #evaluate(sessionId: string, expression: string, contextId: number, timeoutMs: number): Promise<unknown> {
    const answer = await this.#cdp.send<{ result?: { value?: unknown }; exceptionDetails?: { text?: string; exception?: { description?: string } } }>(
      "Runtime.evaluate",
      { expression, returnByValue: true, awaitPromise: true, contextId },
      sessionId,
      timeoutMs,
    );
    if (answer.exceptionDetails) throw new Error(`the page threw: ${(answer.exceptionDetails.exception?.description ?? answer.exceptionDetails.text ?? "?").slice(0, 200)}`);
    return answer.result?.value;
  }
}
