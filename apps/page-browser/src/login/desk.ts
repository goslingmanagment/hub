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
// - Each step is the call's that asked for it, and only for as long as that
//   call may act (Astra's review of PR 15, item 3): its guard — the manual
//   login it was taken in, under the owner generation that switched it on,
//   with that engine heard (operator.ts) — is read before every input step
//   (the focus, the selection, the text, the scroll, the pointer's move, the
//   press, the release). A guard that fails stops the step there
//   (`not_manual_login`): nothing more is typed or pressed. The operator
//   waits for a stopped step to end (`drain`) before the automation comes
//   back or a new owner takes the page.
// - What is acted on is checked last, at the moment of the act (Astra's
//   review of PR 15, item 4): the text goes in only once the screen was read
//   again after the focus, in the same document, and the field to type into
//   is the focused one; the pointer is moved onto the button first, then the
//   screen, the document and the hit test at that point are read again, and
//   only then is it pressed — an overlay or a screen that comes with the
//   pointer stops the step before the press.
// - A press is never left unfinished (Astra's review of PR 15, rounds 2
//   and 3). Once `mousePressed` was sent there are two ways out, and the
//   step ends (so the desk is drained) only after one of them: the call
//   may still act — the release on the button, as a person's; anything
//   else (the call may act no more, the press or the release unanswered) —
//   nothing more goes to the page, no release, no move, nothing installed
//   in it: its document is discarded (`discard`, the operator's: a blank
//   document, the site loaded anew after it; or, if not even that, the
//   page's Chrome goes), and the press dies with it.
// - Secrets: the login, the password and the code live in this call's
//   arguments for the time of the hand-over and nowhere else — never in a
//   log line, a journal, an error message or a field of this object. The
//   CDP client never logs a command's parameters (cdp/client.ts). The
//   screenshot is the site's own rendering — its password field shows
//   dots — kept in memory for the answer only.

import { CdpError, type CdpPort } from "../cdp/client.ts";
import { errorMessage, makeLog, sleep, type Logger } from "../shared/util.ts";
import { FOCUSED, HIT, locateExpression, PROBE, recognize, SCREEN_VERSION, SELECT_ALL, type CodeFrom, type LoginField, type LoginScreen, type PageMarks, type Recognized } from "./screens.ts";

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
  /** The work tab's document goes, and the press in it (the operator's: a
   *  blank document and the site loaded anew after it, or the page's
   *  Chrome stopped) — for a press not let go on its button. Never leaves
   *  the document as it was. */
  discard: (why: string) => Promise<void>;
  timings?: Partial<LoginTimings>;
  log?: Logger;
}

/** What a call comes to: the screen, a screenshot, or a refusal. */
export type LoginOutcome =
  | { kind: "state"; screen: LoginScreen; screenVersion: string; fields: LoginField[]; siteError: string | null; codeFrom: CodeFrom }
  | { kind: "screenshot"; jpeg: Buffer }
  | { kind: "refused"; reason: "screen_changed" | "busy" | "not_manual_login" };

/** The asking call's claim on the browser (operator.ts): null while it may
 *  still act, else why not. Read before every input step. */
export type LoginGuard = () => string | null;

class ScreenChanged extends Error {}

/** The call's guard failed: it may act no more. */
class Cancelled extends Error {}

/** The element a step acts on, in the document it was found in. */
interface Located {
  tab: string;
  /** The isolated world of the document it was found in (a new document
   *  has a new one). */
  world: number;
  objectId: string;
}

export class LoginDesk {
  readonly #deps: LoginDeskDeps;
  readonly #timings: LoginTimings;
  readonly #log: Logger;
  /** The step under way (one at a time). */
  #current: Promise<LoginOutcome> | null = null;
  /** The live session when the manual login began (the success's sign). */
  #sessionAtStart: string | null = null;
  /** The site's code went and was answered 2xx in this manual login. */
  #codeAccepted = false;
  /** The session the site's account read was last answered 2xx under. */
  #accountLoaded: string | null = null;

  constructor(deps: LoginDeskDeps) {
    this.#deps = deps;
    this.#timings = { ...DEFAULT_TIMINGS, ...deps.timings };
    this.#log = deps.log ?? makeLog("login");
  }

  /** A manual login begins: the session it starts from is remembered. */
  begin(): void {
    this.#sessionAtStart = this.#deps.session();
    this.#codeAccepted = false;
    this.#accountLoaded = null;
  }

  /** A read of the site ended (intercept/site.ts): the account loaded is a
   *  sign of the success; a refused one says the session no longer works. */
  readEnded(end: { route: string; status: number | null; sent: boolean; session: string | null }): void {
    if (end.route !== "account.me" || !end.sent || end.status === null) return;
    if (end.status >= 200 && end.status < 300) this.#accountLoaded = end.session;
    else if (end.status === 401 || end.status === 403) this.#accountLoaded = null;
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

  /** The login and the password into the login form, then its button —
   *  for as long as `guard` lets the call act. */
  submit(login: string, password: string, guard: LoginGuard): Promise<LoginOutcome> {
    return this.#step("submit", ["login", "password"], guard, async () => {
      await this.#type("login", ["login", "password"], login, guard);
      await this.#type("password", ["login", "password"], password, guard);
    });
  }

  /** The code into the code form, then its button — for as long as `guard`
   *  lets the call act. The 2FA code and the e-mail code of a new device go
   *  the same way: one field, one button, the site's `POST /login/twofa`. */
  code(code: string, guard: LoginGuard): Promise<LoginOutcome> {
    return this.#step("code", ["code"], guard, async () => {
      await this.#type("code", ["code"], code, guard);
    });
  }

  /** The step under way, if any, has ended — one whose guard failed stops at
   *  its next input step, and waits for no screen. Never rejects. */
  async drain(): Promise<void> {
    await this.#current?.catch(() => undefined);
  }

  #step(name: "submit" | "code", needs: LoginField[], guard: LoginGuard, typeIn: () => Promise<void>): Promise<LoginOutcome> {
    if (this.#current !== null) return Promise.resolve({ kind: "refused", reason: "busy" });
    const run = this.#run(name, needs, guard, typeIn).finally(() => {
      if (this.#current === run) this.#current = null;
    });
    this.#current = run;
    return run;
  }

  async #run(name: "submit" | "code", needs: LoginField[], guard: LoginGuard, typeIn: () => Promise<void>): Promise<LoginOutcome> {
    let acted: LoginScreen;
    try {
      allowed(guard);
      const before = await this.#recognize();
      if (!sameFields(before.fields, needs)) {
        this.#log("step.refused", { step: name, screen: before.screen, why: before.why });
        return { kind: "refused", reason: "screen_changed" };
      }
      acted = before.screen;
      await typeIn();
      await this.#press(needs, guard);
      this.#log("step.done", { step: name, from: acted });
    } catch (error) {
      if (error instanceof Cancelled) {
        this.#log("step.cancelled", { step: name, why: error.message });
        return { kind: "refused", reason: "not_manual_login" };
      }
      // Never the error of a command that carried what was typed: its
      // message is the command's method and Chrome's words (cdp/client.ts).
      this.#log("step.stopped", { step: name, why: error instanceof ScreenChanged ? error.message : errorMessage(error) });
      return { kind: "refused", reason: "screen_changed" };
    } finally {
      await this.#release();
    }
    // The site's answer: the next screen it shows — one the desk knows,
    // other than the one it acted on (a form that went for a moment is
    // no answer) — or the screen as it is when the wait is over, or when
    // the call may no longer act (nothing waits for it then).
    const deadline = Date.now() + this.#timings.settleMs;
    let seen = await this.#recognize();
    while ((seen.screen === acted || seen.screen === "unknown") && Date.now() < deadline && guard() === null) {
      await sleep(this.#timings.pollMs);
      seen = await this.#recognize();
    }
    return this.#stateOf(seen);
  }

  #stateOf(seen: Recognized): LoginOutcome {
    return { kind: "state", screen: seen.screen, screenVersion: SCREEN_VERSION, fields: seen.fields, siteError: seen.siteError, codeFrom: seen.codeFrom };
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
    return recognize(await this.#marks(), { live: this.#deps.session(), atStart: this.#sessionAtStart, codeAccepted: this.#codeAccepted, accountLoaded: this.#accountLoaded });
  }

  /** The element of `role` in the one form shown, by reference; the screen
   *  read again first, and it must still show `needs`. */
  async #locate(role: LoginField | "submit", needs: LoginField[]): Promise<Located> {
    const seen = await this.#recognize();
    if (!sameFields(seen.fields, needs)) throw new ScreenChanged(`the screen is now ${seen.screen} (${seen.why})`);
    const tab = this.#deps.tab();
    if (tab === null) throw new ScreenChanged("no work tab");
    const world = await this.#deps.world();
    const reply = await this.#deps.cdp.send<{ result?: { objectId?: string; subtype?: string } }>(
      "Runtime.evaluate",
      { expression: locateExpression(role), contextId: world, returnByValue: false, objectGroup: GROUP },
      tab,
      this.#timings.commandMs,
    );
    const objectId = reply.result?.objectId;
    if (typeof objectId !== "string" || reply.result?.subtype === "null") throw new ScreenChanged(`no single ${role} on the screen`);
    return { tab, world, objectId };
  }

  /** Right before an act on `at`: the screen still shows `needs`, in the
   *  same work tab and the same document `at` was found in. */
  async #still(at: Located, needs: LoginField[]): Promise<void> {
    const seen = await this.#recognize();
    if (!sameFields(seen.fields, needs)) throw new ScreenChanged(`the screen is now ${seen.screen} (${seen.why})`);
    if (this.#deps.tab() !== at.tab) throw new ScreenChanged("the work tab changed");
    if ((await this.#deps.world()) !== at.world) throw new ScreenChanged("the document changed");
  }

  /** A boolean the element's function answers (`Runtime.callFunctionOn`). */
  async #ask(at: Located, functionDeclaration: string, args: Array<{ value: unknown }> = []): Promise<boolean> {
    const reply = await this.#deps.cdp.send<{ result?: { value?: unknown } }>(
      "Runtime.callFunctionOn",
      { objectId: at.objectId, functionDeclaration, arguments: args, returnByValue: true },
      at.tab,
      this.#timings.commandMs,
    );
    return reply.result?.value === true;
  }

  /** `text` into the field of `role`: focused, its content selected, then —
   *  the screen and the document read again, the field the focused one —
   *  the text inserted as typed. */
  async #type(role: LoginField, needs: LoginField[], text: string, guard: LoginGuard): Promise<void> {
    const field = await this.#locate(role, needs);
    const cdp = this.#deps.cdp;
    allowed(guard);
    await cdp.send("DOM.focus", { objectId: field.objectId }, field.tab, this.#timings.commandMs);
    allowed(guard);
    await cdp.send("Runtime.callFunctionOn", { objectId: field.objectId, functionDeclaration: SELECT_ALL, returnByValue: true }, field.tab, this.#timings.commandMs);
    await this.#still(field, needs);
    if (!(await this.#ask(field, FOCUSED))) throw new ScreenChanged(`the ${role} field is not the focused one`);
    allowed(guard);
    await cdp.send("Input.insertText", { text }, field.tab, this.#timings.commandMs);
  }

  /** The form's one button, pressed at its centre: the pointer moved there
   *  first, then — the screen and the document read again, the point still
   *  hitting the button — pressed and let go. */
  async #press(needs: LoginField[], guard: LoginGuard): Promise<void> {
    const button = await this.#locate("submit", needs);
    const { tab, objectId } = button;
    const cdp = this.#deps.cdp;
    allowed(guard);
    await cdp.send("DOM.scrollIntoViewIfNeeded", { objectId }, tab, this.#timings.commandMs).catch((error: unknown) => {
      if (!(error instanceof CdpError)) throw error;
    });
    const box = await cdp.send<{ model?: { content?: number[] } }>("DOM.getBoxModel", { objectId }, tab, this.#timings.commandMs);
    const quad = box.model?.content;
    if (!Array.isArray(quad) || quad.length !== 8 || !quad.every((n) => typeof n === "number" && Number.isFinite(n))) throw new ScreenChanged("the button has no box");
    const x = (quad[0]! + quad[2]! + quad[4]! + quad[6]!) / 4;
    const y = (quad[1]! + quad[3]! + quad[5]! + quad[7]!) / 4;
    const point = [{ value: x }, { value: y }];
    if (!(await this.#ask(button, HIT, point))) throw new ScreenChanged("something else is over the button");
    allowed(guard);
    await cdp.send("Input.dispatchMouseEvent", { type: "mouseMoved", x, y, button: "none" }, tab, this.#timings.commandMs);
    // What the pointer's coming may have changed: read again, last.
    await this.#still(button, needs);
    if (!(await this.#ask(button, HIT, point))) throw new ScreenChanged("something else is over the button once the pointer is on it");
    const mouse = { x, y, button: "left", clickCount: 1 };
    allowed(guard);
    // From the press on, two ways out: let go on the button while the call
    // may still act — or nothing more to the page, its document discarded
    // with the press in it.
    let released = false;
    try {
      await cdp.send("Input.dispatchMouseEvent", { type: "mousePressed", ...mouse, buttons: 1 }, tab, this.#timings.commandMs);
      allowed(guard);
      await cdp.send("Input.dispatchMouseEvent", { type: "mouseReleased", ...mouse, buttons: 0 }, tab, this.#timings.commandMs);
      released = true;
    } finally {
      if (!released) {
        const why = "a press of the login form was not let go on its button";
        this.#log("press.discard", { why });
        await this.#deps.discard(why).catch((error: unknown) => this.#log("press.discard_failed", { error: errorMessage(error) }));
      }
    }
  }

  async #release(): Promise<void> {
    const tab = this.#deps.tab();
    if (tab === null) return;
    await this.#deps.cdp.send("Runtime.releaseObjectGroup", { objectGroup: GROUP }, tab, this.#timings.commandMs).catch(() => undefined);
  }
}

/** The call may act now, or the step stops here. */
function allowed(guard: LoginGuard): void {
  const why = guard();
  if (why !== null) throw new Cancelled(why);
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
  if (typeof v.origin !== "string" || typeof v.path !== "string" || typeof v.readyState !== "string" || typeof v.captcha !== "boolean" || typeof v.outside !== "boolean" || !Array.isArray(v.forms)) return null;
  const forms: PageMarks["forms"] = [];
  for (const raw of v.forms) {
    if (raw === null || typeof raw !== "object") return null;
    const f = raw as Record<string, unknown>;
    if (typeof f.newDevice !== "boolean") return null;
    const form = { password: count(f.password), login: count(f.login), code: count(f.code), other: count(f.other), submit: count(f.submit), error: typeof f.error === "string" && f.error !== "" ? f.error.slice(0, 300) : null, newDevice: f.newDevice };
    if ([form.password, form.login, form.code, form.other, form.submit].some((n) => n < 0)) return null;
    forms.push(form);
  }
  return { origin: v.origin, path: v.path, readyState: v.readyState, captcha: v.captcha, outside: v.outside, forms };
}
