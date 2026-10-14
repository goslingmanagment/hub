// The page's environment as the browser shows it (plan §4.1, step 2: after
// every restart and every Chrome update the operator compares the actual
// values; spec §10 "Окружение"). It runs on every start, once control is
// attached and before the self-test; any difference fails the start
// (`env_mismatch`), with what was seen in its reason.
//
// - In the work tab, from an isolated world (the page's own code never sees
//   it): Intl's time zone, navigator.languages and navigator.language,
//   screen.width × screen.height. The zone is equal when it is the page's,
//   or what Chrome's own ICU calls the page's (it names aliases its own
//   way: Europe/Kyiv is Europe/Kiev in Chrome 155).
// - The position: the work tab is about:blank — not a secure context, and
//   Chrome answers "Only secure origins are allowed" whatever is granted.
//   So a check page is opened in a throwaway browser context
//   (Target.createBrowserContext: nothing of it stays in the profile), at
//   http://127.0.0.1/pb-env-check — loopback is a secure context. Its one
//   document is answered by the operator at the interception
//   (Fetch.fulfillRequest): no connection is made, nothing leaves. The tab
//   is set up by the control like any other (cdp/control.ts: the override
//   before it runs), granted geolocation for its origin in its context, and
//   navigator.geolocation.getCurrentPosition must give the page's position.
//   The context is disposed with the tab.
//
// Nothing the check reads is a secret; it goes to the log and the states
// journal. The protocol's `state` has no place for it (spec §6.1).

import { randomBytes } from "node:crypto";

import { CdpUnanswered, type Cdp } from "../cdp/client.ts";
import type { BrowserControl } from "../cdp/control.ts";
import type { PausedDecision, PausedRequest } from "../cdp/paused.ts";
import { errorMessage, makeLog, sleep, type Logger } from "../shared/util.ts";
import { SCREEN, type PageEnv } from "./rules.ts";

export const CHECK_ORIGIN = "http://127.0.0.1";
export const CHECK_PATH = "/pb-env-check";
const CHECK_PAGE = '<!doctype html><meta charset="utf-8"><link rel="icon" href="data:,"><title>pb-env</title>';

export type SeenPosition = { latitude: number; longitude: number; accuracy: number } | { error: string };

export interface SeenEnv {
  timeZone: string | null;
  /** Chrome's own name of the page's zone; null when Chrome does not know it. */
  settingsTimeZone: string | null;
  languages: string[];
  language: string | null;
  screen: { width: number; height: number };
  geolocation: SeenPosition;
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

const READY = (url: string) => `(function pbEnvReady(url) { return location.href === url && document.readyState === "complete"; })(${JSON.stringify(url)})`;

const POSITION = `(function pbEnvPosition() {
  return new Promise(function (resolve) {
    if (!navigator.geolocation) { resolve({ error: "no navigator.geolocation" }); return; }
    navigator.geolocation.getCurrentPosition(
      function (p) { resolve({ latitude: p.coords.latitude, longitude: p.coords.longitude, accuracy: p.coords.accuracy }); },
      function (e) { resolve({ error: e.code + " " + e.message }); },
      { maximumAge: 0, timeout: 3000 }
    );
  });
})()`;

const near = (a: number, b: number) => Math.abs(a - b) <= 1e-9;
const list = (values: readonly string[]) => (values.length === 0 ? "(none)" : values.join(", "));

/** Every way what Chrome shows differs from the page's settings. */
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
  if (seen.screen.width !== SCREEN.width || seen.screen.height !== SCREEN.height) mismatches.push(`screen ${seen.screen.width}×${seen.screen.height}, not ${SCREEN.width}×${SCREEN.height}`);
  const position = seen.geolocation;
  const { latitude, longitude, accuracyM } = expected.geolocation;
  if ("error" in position) mismatches.push(`no position: ${position.error}`);
  else if (!near(position.latitude, latitude) || !near(position.longitude, longitude) || !near(position.accuracy, accuracyM)) {
    mismatches.push(`position ${position.latitude}, ${position.longitude} ±${position.accuracy} m, not ${latitude}, ${longitude} ±${accuracyM} m`);
  }
  return mismatches;
}

function text(value: unknown, max = 128): string | null {
  return typeof value === "string" ? value.slice(0, max) : null;
}

function count(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : -1;
}

/** What the page answered, as plain values whatever it sent. */
function asRead(value: unknown): Omit<SeenEnv, "geolocation"> {
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

function asPosition(value: unknown): SeenPosition {
  const position = (value ?? {}) as Record<string, unknown>;
  if (typeof position.error === "string") return { error: position.error.slice(0, 200) };
  const { latitude, longitude, accuracy } = position;
  if (typeof latitude !== "number" || typeof longitude !== "number" || typeof accuracy !== "number") return { error: "no coordinates in the answer" };
  return { latitude, longitude, accuracy };
}

export interface EnvCheckOptions {
  log?: Logger;
}

export class EnvCheck {
  readonly #cdp: Cdp;
  readonly #control: BrowserControl;
  readonly #log: Logger;
  /** The marker of the check page the interception may answer now. */
  #waiting: string | null = null;

  constructor(cdp: Cdp, control: BrowserControl, options: EnvCheckOptions = {}) {
    this.#cdp = cdp;
    this.#control = control;
    this.#log = options.log ?? makeLog("env");
  }

  /** The interception's question for the check page's origin: its one
   *  document, while a check waits for it, is answered here; any other
   *  request there is failed. Null for every other request. */
  onPaused(request: PausedRequest): PausedDecision | null {
    if (!request.url.startsWith(`${CHECK_ORIGIN}/`)) return null;
    const marker = /^#pb-env-([0-9a-f]{16})$/.exec(request.urlFragment)?.[1];
    if (marker === undefined || marker !== this.#waiting || request.url !== `${CHECK_ORIGIN}${CHECK_PATH}` || request.method !== "GET" || request.resourceType !== "Document") {
      return { action: "fail", reason: "BlockedByClient", why: "the environment check's origin, outside its check" };
    }
    // Once: a second document for the same check is refused.
    this.#waiting = null;
    return {
      action: "fulfill",
      status: 200,
      headers: [
        { name: "content-type", value: "text/html; charset=utf-8" },
        { name: "cache-control", value: "no-store" },
      ],
      body: CHECK_PAGE,
      why: "the environment check's page, answered by the operator",
    };
  }

  /** Is this the check page's own origin (what `onPaused` decides)? */
  isCheckPage(request: Pick<PausedRequest, "url">): boolean {
    return request.url.startsWith(`${CHECK_ORIGIN}/`);
  }

  /** Reads the environment in the browser and compares it with `env`. */
  async run(env: PageEnv, timeoutMs: number): Promise<EnvCheckResult> {
    const started = Date.now();
    const deadline = started + timeoutMs;
    const left = () => Math.max(1, deadline - Date.now());
    let seen: SeenEnv | null = null;
    try {
      const tab = this.#control.workTab;
      if (!tab) throw new Error("no work tab");
      const world = await this.#control.isolatedWorld(tab, "pb-env");
      const read = asRead(await this.#evaluate(tab.sessionId, READ(env.timeZone), world, left()));
      seen = { ...read, geolocation: await this.#position(deadline) };
    } catch (error) {
      return { ok: false, mismatches: [`the check could not run: ${errorMessage(error)}`], seen, durationMs: Date.now() - started };
    }
    const mismatches = compareEnv(env, seen);
    return { ok: mismatches.length === 0, mismatches, seen, durationMs: Date.now() - started };
  }

  async #position(deadline: number): Promise<SeenPosition> {
    const left = () => Math.max(1, deadline - Date.now());
    const marker = randomBytes(8).toString("hex");
    const url = `${CHECK_ORIGIN}${CHECK_PATH}#pb-env-${marker}`;
    let context: string | null = null;
    this.#waiting = marker;
    try {
      context = (await this.#cdp.send<{ browserContextId: string }>("Target.createBrowserContext", { disposeOnDetach: true }, undefined, left())).browserContextId;
      await this.#cdp.send("Browser.grantPermissions", { permissions: ["geolocation"], origin: CHECK_ORIGIN, browserContextId: context }, undefined, left());
      const created = await this.#cdp.send<{ targetId: string }>("Target.createTarget", { url, browserContextId: context }, undefined, left());
      const page = await this.#control.waitForTarget(created.targetId, left(), "the check page");
      // Until its document is in: a context replaced by the navigation
      // answers with an error, which is only "not yet".
      const ready = () =>
        this.#evaluate(page.sessionId, READY(url), undefined, left()).then(
          (value) => value === true,
          (error: unknown) => {
            if (error instanceof CdpUnanswered) throw error;
            return false;
          },
        );
      while (!(await ready())) {
        if (Date.now() >= deadline) throw new Error("the check page did not load");
        await sleep(25);
      }
      return asPosition(await this.#evaluate(page.sessionId, POSITION, undefined, left()));
    } finally {
      if (this.#waiting === marker) this.#waiting = null;
      if (context !== null) {
        await this.#cdp.send("Target.disposeBrowserContext", { browserContextId: context }, undefined, 3000).catch((error: unknown) => this.#log("check_context.dispose_failed", { error: errorMessage(error) }));
      }
    }
  }

  async #evaluate(sessionId: string, expression: string, contextId: number | undefined, timeoutMs: number): Promise<unknown> {
    const params: Record<string, unknown> = { expression, returnByValue: true, awaitPromise: true };
    if (contextId !== undefined) params.contextId = contextId;
    const answer = await this.#cdp.send<{ result?: { value?: unknown }; exceptionDetails?: { text?: string; exception?: { description?: string } } }>("Runtime.evaluate", params, sessionId, timeoutMs);
    if (answer.exceptionDetails) throw new Error(`the page threw: ${(answer.exceptionDetails.exception?.description ?? answer.exceptionDetails.text ?? "?").slice(0, 200)}`);
    return answer.result?.value;
  }
}
