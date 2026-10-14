// The login form's desk in the operator (plan §4.8; spec §6.1 `login.*`,
// §7): what the API asks on the owner's behalf — the screen now, a
// screenshot of it, the login and password typed in, the 2FA code typed in.
// The operator decides whether it is asked at all (operator.ts: only in the
// manual login that the engine of the current owner generation switched
// on); this desk reads the screen and acts on it.
//
// - Input is the browser's own, as a person's (plan §4.8): the field gets
//   the focus by DOM.focus, the text goes in by Input.insertText, the button
//   is pressed by Input.dispatchMouseEvent at the centre of its box
//   (DOM.getBoxModel) — and only if the point hits the button itself. A
//   field's former content is selected first, so the text replaces it;
//   nothing writes `value` from JavaScript, nothing reads it.
// - The screen is read again before every step (spec §7): a screen that is
//   no longer the one the step is for stops it there (`screen_changed`).
//   One step at a time (`busy`).
// - Secrets: the login, the password and the code live in this call's
//   arguments for the time of the hand-over and nowhere else — never in a
//   log line, a journal, an error message or a field of this object. The
//   CDP client never logs a command's parameters (cdp/client.ts). The
//   screenshot is the site's own rendering — its password field shows
//   dots — kept in memory for the answer only.

import { CdpError, type CdpPort } from "../cdp/client.ts";
import { errorMessage, makeLog, sleep, type Logger } from "../shared/util.ts";
import { HIT, locateExpression, PROBE, recognize, SCREEN_VERSION, SELECT_ALL, type LoginField, type LoginScreen, type PageMarks, type Recognized } from "./screens.ts";

export interface LoginTimings {
  /** One CDP command of the desk. */
  commandMs: number;
  /** After the press: how long the desk waits for the screen to change
   *  before it answers with the screen as it is. */
  settleMs: number;
  /** Between reads while it waits. */
  pollMs: number;
}

const DEFAULT_TIMINGS: LoginTimings = { commandMs: 5000, settleMs: 10_000, pollMs: 250 };

/** The CDP object group of the desk's element references. */
const GROUP = "pb-login";

export interface LoginDeskDeps {
  cdp: CdpPort;
  /** The work tab's CDP session (null: none). */
  tab: () => string | null;
  /** The operator's isolated world in the work tab's current document. */
  world: () => Promise<number>;
  /** The site's live session (hub-requests/session.ts), null: none seen. */
  session: () => string | null;
  timings?: Partial<LoginTimings>;
  log?: Logger;
}

/** What a call comes to: the screen, a screenshot, or a refusal. */
export type LoginOutcome =
  | { kind: "state"; screen: LoginScreen; screenVersion: string; fields: LoginField[]; siteError: string | null }
  | { kind: "screenshot"; jpeg: Buffer }
  | { kind: "refused"; reason: "screen_changed" | "busy" };

class ScreenChanged extends Error {}

export class LoginDesk {
  readonly #deps: LoginDeskDeps;
  readonly #timings: LoginTimings;
  readonly #log: Logger;
  #busy = false;
  /** The live session when the manual login began (the success's sign). */
  #sessionAtStart: string | null = null;
  /** The site's code went and was answered 2xx in this manual login. */
  #codeAccepted = false;

  constructor(deps: LoginDeskDeps) {
    this.#deps = deps;
    this.#timings = { ...DEFAULT_TIMINGS, ...deps.timings };
    this.#log = deps.log ?? makeLog("login");
  }

  /** A manual login begins: the session it starts from is remembered. */
  begin(): void {
    this.#sessionAtStart = this.#deps.session();
    this.#codeAccepted = false;
  }

  /** A login operation of the site ended (intercept/site.ts): the code's
   *  2xx is a sign of the success. */
  loginEnded(end: { route: string; status: number | null; sent: boolean }): void {
    if (end.route === "auth.twofa" && end.sent && end.status !== null && end.status >= 200 && end.status < 300) this.#codeAccepted = true;
  }

  /** The screen now. */
  async state(): Promise<LoginOutcome> {
    const seen = await this.#recognize();
    return this.#stateOf(seen);
  }

  /** The work tab as the site renders it: JPEG, in memory. */
  async screenshot(): Promise<LoginOutcome> {
    const tab = this.#deps.tab();
    if (tab === null) return { kind: "refused", reason: "screen_changed" };
    try {
      const shot = await this.#deps.cdp.send<{ data?: string }>("Page.captureScreenshot", { format: "jpeg", quality: 70, optimizeForSpeed: true }, tab, this.#timings.commandMs);
      if (typeof shot.data !== "string" || shot.data === "") return { kind: "refused", reason: "screen_changed" };
      return { kind: "screenshot", jpeg: Buffer.from(shot.data, "base64") };
    } catch (error) {
      this.#log("screenshot.failed", { error: errorMessage(error) });
      return { kind: "refused", reason: "screen_changed" };
    }
  }

  /** The login and the password into the login form, then its button. */
  submit(login: string, password: string): Promise<LoginOutcome> {
    return this.#step("submit", ["login", "password"], async () => {
      await this.#type("login", ["login", "password"], login);
      await this.#type("password", ["login", "password"], password);
    });
  }

  /** The 2FA code into the code form, then its button. */
  code(code: string): Promise<LoginOutcome> {
    return this.#step("code", ["code"], async () => {
      await this.#type("code", ["code"], code);
    });
  }

  async #step(name: "submit" | "code", needs: LoginField[], typeIn: () => Promise<void>): Promise<LoginOutcome> {
    if (this.#busy) return { kind: "refused", reason: "busy" };
    this.#busy = true;
    try {
      let acted: LoginScreen;
      try {
        const before = await this.#recognize();
        if (!sameFields(before.fields, needs)) {
          this.#log("step.refused", { step: name, screen: before.screen, why: before.why });
          return { kind: "refused", reason: "screen_changed" };
        }
        acted = before.screen;
        await typeIn();
        await this.#press(needs);
        this.#log("step.done", { step: name, from: acted });
      } catch (error) {
        // Never the error of a command that carried what was typed: its
        // message is the command's method and Chrome's words (cdp/client.ts).
        this.#log("step.stopped", { step: name, why: error instanceof ScreenChanged ? error.message : errorMessage(error) });
        return { kind: "refused", reason: "screen_changed" };
      } finally {
        await this.#release();
      }
      // The site's answer: the next screen it shows — one the desk knows,
      // other than the one it acted on (a form that went for a moment is
      // no answer) — or the screen as it is when the wait is over.
      const deadline = Date.now() + this.#timings.settleMs;
      let seen = await this.#recognize();
      while ((seen.screen === acted || seen.screen === "unknown") && Date.now() < deadline) {
        await sleep(this.#timings.pollMs);
        seen = await this.#recognize();
      }
      return this.#stateOf(seen);
    } finally {
      this.#busy = false;
    }
  }

  #stateOf(seen: Recognized): LoginOutcome {
    return { kind: "state", screen: seen.screen, screenVersion: SCREEN_VERSION, fields: seen.fields, siteError: seen.siteError };
  }

  async #marks(): Promise<PageMarks | null> {
    const tab = this.#deps.tab();
    if (tab === null) return null;
    try {
      const contextId = await this.#deps.world();
      const reply = await this.#deps.cdp.send<{ result?: { value?: unknown }; exceptionDetails?: unknown }>(
        "Runtime.evaluate",
        { expression: PROBE, contextId, returnByValue: true },
        tab,
        this.#timings.commandMs,
      );
      if (reply.exceptionDetails !== undefined) return null;
      return marksOf(reply.result?.value);
    } catch (error) {
      this.#log("read.failed", { error: errorMessage(error) });
      return null;
    }
  }

  async #recognize(): Promise<Recognized> {
    return recognize(await this.#marks(), { live: this.#deps.session(), atStart: this.#sessionAtStart, codeAccepted: this.#codeAccepted });
  }

  /** The element of `role` in the one form shown, by reference; the screen
   *  read again first, and it must still show `needs`. */
  async #locate(role: LoginField | "submit", needs: LoginField[]): Promise<{ tab: string; objectId: string }> {
    const seen = await this.#recognize();
    if (!sameFields(seen.fields, needs)) throw new ScreenChanged(`the screen is now ${seen.screen} (${seen.why})`);
    const tab = this.#deps.tab();
    if (tab === null) throw new ScreenChanged("no work tab");
    const contextId = await this.#deps.world();
    const reply = await this.#deps.cdp.send<{ result?: { objectId?: string; subtype?: string } }>(
      "Runtime.evaluate",
      { expression: locateExpression(role), contextId, returnByValue: false, objectGroup: GROUP },
      tab,
      this.#timings.commandMs,
    );
    const objectId = reply.result?.objectId;
    if (typeof objectId !== "string" || reply.result?.subtype === "null") throw new ScreenChanged(`no single ${role} on the screen`);
    return { tab, objectId };
  }

  /** `text` into the field of `role`: focused, its content selected, the
   *  text inserted as typed. */
  async #type(role: LoginField, needs: LoginField[], text: string): Promise<void> {
    const { tab, objectId } = await this.#locate(role, needs);
    const cdp = this.#deps.cdp;
    await cdp.send("DOM.focus", { objectId }, tab, this.#timings.commandMs);
    await cdp.send("Runtime.callFunctionOn", { objectId, functionDeclaration: SELECT_ALL, returnByValue: true }, tab, this.#timings.commandMs);
    await cdp.send("Input.insertText", { text }, tab, this.#timings.commandMs);
  }

  /** The form's one button, pressed at its centre — if that point hits it. */
  async #press(needs: LoginField[]): Promise<void> {
    const { tab, objectId } = await this.#locate("submit", needs);
    const cdp = this.#deps.cdp;
    await cdp.send("DOM.scrollIntoViewIfNeeded", { objectId }, tab, this.#timings.commandMs).catch((error: unknown) => {
      if (!(error instanceof CdpError)) throw error;
    });
    const box = await cdp.send<{ model?: { content?: number[] } }>("DOM.getBoxModel", { objectId }, tab, this.#timings.commandMs);
    const quad = box.model?.content;
    if (!Array.isArray(quad) || quad.length !== 8 || !quad.every((n) => typeof n === "number" && Number.isFinite(n))) throw new ScreenChanged("the button has no box");
    const x = (quad[0]! + quad[2]! + quad[4]! + quad[6]!) / 4;
    const y = (quad[1]! + quad[3]! + quad[5]! + quad[7]!) / 4;
    const hit = await cdp.send<{ result?: { value?: unknown } }>(
      "Runtime.callFunctionOn",
      { objectId, functionDeclaration: HIT, arguments: [{ value: x }, { value: y }], returnByValue: true },
      tab,
      this.#timings.commandMs,
    );
    if (hit.result?.value !== true) throw new ScreenChanged("something else is over the button");
    const mouse = { x, y, button: "left", clickCount: 1 };
    await cdp.send("Input.dispatchMouseEvent", { type: "mouseMoved", x, y, button: "none" }, tab, this.#timings.commandMs);
    await cdp.send("Input.dispatchMouseEvent", { type: "mousePressed", ...mouse }, tab, this.#timings.commandMs);
    await cdp.send("Input.dispatchMouseEvent", { type: "mouseReleased", ...mouse }, tab, this.#timings.commandMs);
  }

  async #release(): Promise<void> {
    const tab = this.#deps.tab();
    if (tab === null) return;
    await this.#deps.cdp.send("Runtime.releaseObjectGroup", { objectGroup: GROUP }, tab, this.#timings.commandMs).catch(() => undefined);
  }
}

function sameFields(seen: readonly LoginField[], needs: readonly LoginField[]): boolean {
  return seen.length === needs.length && needs.every((field) => seen.includes(field));
}

function count(value: unknown): number {
  return typeof value === "number" && Number.isInteger(value) && value >= 0 ? value : -1;
}

/** The probe's answer, checked: anything malformed reads as no page. */
export function marksOf(value: unknown): PageMarks | null {
  if (value === null || typeof value !== "object") return null;
  const v = value as Record<string, unknown>;
  if (typeof v.origin !== "string" || typeof v.path !== "string" || typeof v.readyState !== "string" || typeof v.captcha !== "boolean" || !Array.isArray(v.forms)) return null;
  const forms: PageMarks["forms"] = [];
  for (const raw of v.forms) {
    if (raw === null || typeof raw !== "object") return null;
    const f = raw as Record<string, unknown>;
    const form = { password: count(f.password), login: count(f.login), code: count(f.code), other: count(f.other), submit: count(f.submit), error: typeof f.error === "string" && f.error !== "" ? f.error.slice(0, 300) : null };
    if ([form.password, form.login, form.code, form.other, form.submit].some((n) => n < 0)) return null;
    forms.push(form);
  }
  return { origin: v.origin, path: v.path, readyState: v.readyState, captcha: v.captcha, forms };
}
