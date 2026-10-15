import { createHash, randomUUID } from "node:crypto";
import { readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Socket } from "node:net";

import { afterEach, describe, expect, it } from "vitest";

import { CdpError, type CdpPort, type EventHandler } from "../apps/page-browser/src/cdp/client.ts";
import { fanslyClientCheck, sessionFingerprint } from "../apps/page-browser/src/hub-requests/session.ts";
import { LoginDesk, marksOf } from "../apps/page-browser/src/login/desk.ts";
import { FOCUSED, HIT, locateExpression, PROBE, recognize, SCREEN_VERSION, type FormMarks, type PageMarks, type SessionMarks } from "../apps/page-browser/src/login/screens.ts";
import { loadConfig } from "../apps/page-browser/src/operator/config.ts";
import { Operator } from "../apps/page-browser/src/operator/operator.ts";
import { HaltStore } from "../apps/page-browser/src/state/halt-store.ts";
import { decodeBodyFrame, parseLoginRequest } from "../apps/page-browser/src/rpc/protocol.ts";
import { forgetSecrets } from "../apps/page-browser/src/shared/secrets.ts";
import { monoMs, setLogSink } from "../apps/page-browser/src/shared/util.ts";
import {
  BrowserModel,
  FakeChrome,
  FakeChromeControl,
  FakeEngine,
  fakeIpify,
  FakeSocks,
  hello,
  HolderUnderS6,
  proxyConnect,
  RPC_TOKEN,
  SOCKS_PASSWORD,
  SOCKS_USER,
  tempDir,
  tlsLikeServer,
  until,
  writeExtensionPackage,
  writeNetSelftest,
} from "./helpers/page-browser-fakes.ts";
import { BUTTON_CENTRE, FakeLoginSite } from "./helpers/page-browser-login-site.ts";

// The login form in the operator (Project Browser plan §4.8, §4.13; spec
// §6.1 `login.*`, §7; stage 3 PR 15): the API's calls on the RPC endpoint
// with their own token, the manual login switched by the engine's `setMode`
// of the current owner generation only, the screens recognized from the
// isolated world, the owner's input typed as a person types (DOM.focus,
// Input.insertText, a press at the button's centre), the site's own login
// requests under the engine's admission — and what was typed nowhere but in
// the browser: no log line, no journal, no file of the buffer.

const cleanups: Array<() => Promise<void> | void> = [];

/** Hang guards, not speed checks: one awaited event — a fake Chrome's start
 *  and self-test among them — on a loaded CI machine (the owner's PC took
 *  over 10 s for a start), and a test of several. */
const WAIT_MS = 30_000;
const LONG_TEST_MS = 120_000;
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
  setLogSink(null);
  forgetSecrets();
});

/** Markers: what the owner "types". Nothing else is a credential here. */
const LOGIN_MARKER = "pb15-login-marker-4d1e";
const PASSWORD_MARKER = "pb15-password-marker-9b7c2a";
const CODE_MARKER = "731948";
const API_TOKEN = "api-token-fedcba9876543210fedcba9876543210";
const SITE_TOKEN = "fansly-token-AfTeRlOgIn0123456789";
const SITE_CLIENT = "720167541418239001";

const form = (marks: Partial<FormMarks>): FormMarks => ({ password: 0, login: 0, code: 0, other: 0, submit: 1, error: null, newDevice: false, ...marks });
const page = (forms: FormMarks[], extra: Partial<PageMarks> = {}): PageMarks => ({ origin: "https://fansly.com", path: "/", readyState: "complete", captcha: false, forms, ...extra });

describe("the screens (spec §7; signs fansly-login/2)", () => {
  const none: SessionMarks = { live: null, atStart: null };
  it("knows the login, the code, the error, the success — and nothing else", () => {
    expect(recognize(page([form({ password: 1, login: 1 })]), none)).toMatchObject({ screen: "login", fields: ["login", "password"], siteError: null });
    expect(recognize(page([form({ code: 1 })]), none)).toMatchObject({ screen: "code", fields: ["code"] });
    expect(recognize(page([form({ password: 1, login: 1, error: "Invalid username or password" })]), none)).toMatchObject({ screen: "error", fields: ["login", "password"], siteError: "Invalid username or password" });
    expect(recognize(page([form({ code: 1, error: "Invalid code" })]), none)).toMatchObject({ screen: "error", fields: ["code"], siteError: "Invalid code" });
    expect(recognize(page([]), { live: "b".repeat(64), atStart: "a".repeat(64) })).toMatchObject({ screen: "success", fields: [] });
    expect(recognize(page([]), { live: "b".repeat(64), atStart: null })).toMatchObject({ screen: "success" });
    // The site's code accepted: its new session may not show yet.
    expect(recognize(page([]), { live: null, atStart: null, codeAccepted: true })).toMatchObject({ screen: "success" });
    // The site loaded the account under the live session (its interface's
    // read in the manual login, PR 15), though that session is the one at
    // the start: a page logged in already.
    expect(recognize(page([]), { live: "a".repeat(64), atStart: "a".repeat(64), accountLoaded: "a".repeat(64) })).toMatchObject({ screen: "success", why: expect.stringContaining("loaded the account") });
    // A form still shown wins: an accepted code with the code form again is no success.
    expect(recognize(page([form({ code: 1 })]), { live: null, atStart: null, codeAccepted: true })).toMatchObject({ screen: "code" });
  });

  it("the code form of a login from a new device asks for the code Fansly e-mailed — on its screen and its error; nothing else does (owner decision 2026-10-15)", () => {
    expect(SCREEN_VERSION).toBe("fansly-login/2");
    expect(recognize(page([form({ code: 1, newDevice: true })]), none)).toEqual({ screen: "code", fields: ["code"], siteError: null, codeFrom: "email", why: "the code form of a login from a new device" });
    expect(recognize(page([form({ code: 1, newDevice: true, error: "2FA code is invalid or already used." })]), none))
      .toMatchObject({ screen: "error", fields: ["code"], siteError: "2FA code is invalid or already used.", codeFrom: "email" });
    // The 2FA code: no notice of a new device.
    expect(recognize(page([form({ code: 1 })]), none)).toMatchObject({ screen: "code", codeFrom: null });
    expect(recognize(page([form({ code: 1, error: "Invalid code" })]), none)).toMatchObject({ screen: "error", codeFrom: null });
    // The notice beside the login form, or without a single code form, says nothing.
    expect(recognize(page([form({ password: 1, login: 1, newDevice: true })]), none)).toMatchObject({ screen: "login", codeFrom: null });
    expect(recognize(page([form({ code: 1, newDevice: true, other: 1 })]), none)).toMatchObject({ screen: "unknown", codeFrom: null });
    expect(recognize(page([form({ code: 1, newDevice: true })], { captcha: true }), none)).toMatchObject({ screen: "unknown", codeFrom: null });
    expect(recognize(page([]), { live: null, atStart: null, codeAccepted: true })).toMatchObject({ screen: "success", codeFrom: null });
    // The probe's answer without the mark is no page at all.
    const probed = { origin: "https://fansly.com", path: "/", readyState: "complete", captcha: false, forms: [{ password: 0, login: 0, code: 1, other: 0, submit: 1, error: null }] };
    expect(marksOf(probed)).toBeNull();
    expect(marksOf({ ...probed, forms: [{ ...probed.forms[0], newDevice: "yes" }] })).toBeNull();
    expect(marksOf({ ...probed, forms: [{ ...probed.forms[0], newDevice: true }] })?.forms[0]).toMatchObject({ code: 1, newDevice: true });
  });

  it("a page without a form after the login alone (an e-mail notice, say) is unknown, never a success", () => {
    expect(recognize(page([]), { live: null, atStart: null, codeAccepted: false }).screen).toBe("unknown");
    // An account loaded under another session than the live one, or none, is no sign.
    expect(recognize(page([]), { live: "a".repeat(64), atStart: "a".repeat(64), accountLoaded: "b".repeat(64) }).screen).toBe("unknown");
    expect(recognize(page([]), { live: null, atStart: null, accountLoaded: null }).screen).toBe("unknown");
    // A form still shown wins over the account loaded.
    expect(recognize(page([form({ password: 1, login: 1 })]), { live: "a".repeat(64), atStart: "a".repeat(64), accountLoaded: "a".repeat(64) }).screen).toBe("login");
  });

  it("the desk counts the account loaded only from a sent GET /account/me answered 2xx under the live session, in this manual login", async () => {
    const chrome = new DeskChrome();
    chrome.screen = "none";
    const live = "a".repeat(64);
    const d = new LoginDesk({ cdp: chrome, tab: () => "S1", world: () => Promise.resolve(7), session: () => live, discard: discarding(chrome), timings: { settleMs: 50, pollMs: 10 }, log: () => undefined });
    d.begin();
    d.readEnded({ route: "account.me", status: 200, sent: false, session: live });
    d.readEnded({ route: "account.me", status: null, sent: true, session: live });
    d.readEnded({ route: "account.me", status: 200, sent: true, session: "b".repeat(64) });
    d.readEnded({ route: "site.other", status: 200, sent: true, session: live });
    expect(await d.state()).toMatchObject({ screen: "unknown" });
    d.readEnded({ route: "account.me", status: 200, sent: true, session: live });
    expect(await d.state()).toMatchObject({ screen: "success" });
    // A 401 under it says the session no longer works.
    d.readEnded({ route: "account.me", status: 401, sent: true, session: live });
    expect(await d.state()).toMatchObject({ screen: "unknown" });
    d.readEnded({ route: "account.me", status: 200, sent: true, session: live });
    // A new manual login starts from nothing.
    d.begin();
    expect(await d.state()).toMatchObject({ screen: "unknown" });
  });

  it("the desk counts the code accepted only from a sent POST /login/twofa answered 2xx, in this manual login", async () => {
    const chrome = new DeskChrome();
    chrome.screen = "none";
    const d = desk(chrome);
    d.begin();
    d.loginEnded({ route: "auth.login", status: 200, sent: true });
    d.loginEnded({ route: "auth.twofa", status: 403, sent: true });
    d.loginEnded({ route: "auth.twofa", status: null, sent: true });
    d.loginEnded({ route: "auth.twofa", status: 200, sent: false });
    expect(await d.state()).toMatchObject({ screen: "unknown" });
    d.loginEnded({ route: "auth.twofa", status: 200, sent: true });
    expect(await d.state()).toMatchObject({ screen: "success" });
    // A new manual login starts from nothing.
    d.begin();
    expect(await d.state()).toMatchObject({ screen: "unknown" });
  });

  it("anything that does not match every sign is unknown: nothing is pressed there", () => {
    const unknown = (marks: PageMarks | null, session: SessionMarks = none) => recognize(marks, session).screen;
    expect(unknown(null)).toBe("unknown");
    expect(unknown(page([form({ password: 1, login: 1 })], { captcha: true }))).toBe("unknown");
    expect(unknown(page([form({ password: 1, login: 1 })], { origin: "https://evil.example" }))).toBe("unknown");
    expect(unknown(page([form({ password: 1, login: 1 }), form({ code: 1 })]))).toBe("unknown");
    // A consent box, a second field, two buttons, no button, a code beside a password.
    expect(unknown(page([form({ password: 1, login: 1, other: 1 })]))).toBe("unknown");
    expect(unknown(page([form({ password: 1, login: 1, submit: 2 })]))).toBe("unknown");
    expect(unknown(page([form({ password: 1, login: 1, submit: 0 })]))).toBe("unknown");
    expect(unknown(page([form({ password: 1, code: 1 })]))).toBe("unknown");
    expect(unknown(page([form({ password: 2, login: 1 })]))).toBe("unknown");
    // No form: the session from before the manual login says nothing.
    expect(unknown(page([]))).toBe("unknown");
    expect(unknown(page([]), { live: "a".repeat(64), atStart: "a".repeat(64) })).toBe("unknown");
    expect(unknown(page([], { readyState: "loading" }), { live: "b".repeat(64), atStart: null })).toBe("unknown");
  });

  it("the probe and the locator read no value of a field", () => {
    for (const source of [PROBE, locateExpression("password"), locateExpression("submit")]) {
      expect(source).not.toMatch(/\.value\b/);
      expect(source).not.toMatch(/selectionStart|selectionEnd|getSelection/);
    }
  });
});

describe("the API's token in the container (operator/config.ts)", () => {
  it("is its own: read when there, absent as none, never short, never the engine's", () => {
    const temp = tempDir();
    cleanups.push(temp.remove);
    const rpc = join(temp.dir, "rpc_token");
    const api = join(temp.dir, "api_token");
    writeFileSync(rpc, `${RPC_TOKEN}\n`);
    const env = { PB_RPC_TOKEN_FILE: rpc, PB_API_TOKEN_FILE: api };
    expect(loadConfig(env).apiToken).toBeNull();
    writeFileSync(api, `${API_TOKEN}\n`);
    expect(loadConfig(env).apiToken).toBe(API_TOKEN);
    writeFileSync(api, "short");
    expect(() => loadConfig(env)).toThrow(/shorter/);
    writeFileSync(api, RPC_TOKEN);
    expect(() => loadConfig(env)).toThrow(/each must be its own/);
  });
});

describe("the calls (spec §6.1 `login.*`)", () => {
  it("are read strictly, and an error names the field, never what was typed", () => {
    const base = { callId: "c-1", token: API_TOKEN };
    expect(parseLoginRequest({ ...base, type: "login.submit", login: LOGIN_MARKER, password: PASSWORD_MARKER })).toEqual({ ok: true, request: { ...base, type: "login.submit", login: LOGIN_MARKER, password: PASSWORD_MARKER } });
    for (const bad of [
      { ...base, type: "login.submit", login: LOGIN_MARKER, password: `${PASSWORD_MARKER}\n` },
      { ...base, type: "login.submit", login: LOGIN_MARKER, password: PASSWORD_MARKER.repeat(100) },
      { ...base, type: "login.submit", login: "", password: PASSWORD_MARKER },
      { ...base, type: "login.code", code: `${CODE_MARKER}${"9".repeat(40)}` },
      { ...base, type: "login.submit", login: LOGIN_MARKER },
      { ...base, callId: "bad id!", type: "login.state" },
      { ...base, type: "login.other" },
    ]) {
      const parsed = parseLoginRequest(bad);
      expect(parsed.ok).toBe(false);
      const error = parsed.ok ? "" : parsed.error;
      expect(error).not.toContain(PASSWORD_MARKER);
      expect(error).not.toContain(LOGIN_MARKER);
      expect(error).not.toContain(CODE_MARKER);
    }
  });
});

// ── the desk alone, on an in-process Chrome ─────────────────────────────────

class DeskChrome implements CdpPort {
  readonly commands: Array<{ method: string; params: Record<string, unknown> }> = [];
  screen: "login" | "code" | "other" | "none" = "login";
  hit = true;
  /** The field focused is the one the desk focused. */
  focused = true;
  /** The isolated world of the document now (a new document, a new one). */
  world = 7;
  /** What the page does when a command reaches it (before it answers). */
  react: ((method: string, params: Record<string, unknown>) => void) | null = null;
  /** The documents the desk had discarded, and why. */
  readonly discarded: string[] = [];
  /** A command Chrome does not answer well. */
  fail: ((method: string, params: Record<string, unknown>) => boolean) | null = null;
  send<T>(method: string, params: Record<string, unknown> = {}): Promise<T> {
    this.commands.push({ method, params });
    this.react?.(method, params);
    if (this.fail?.(method, params) === true) return Promise.reject(new CdpError(method, -32000, "no answer"));
    const value = ((): unknown => {
      switch (method) {
        case "Runtime.evaluate": {
          const expression = String(params.expression);
          if (expression.includes("pbLoginProbe")) {
            if (this.screen === "login") return { result: { value: page([form({ password: 1, login: 1 })]) } };
            if (this.screen === "code") return { result: { value: page([form({ code: 1 })]) } };
            if (this.screen === "none") return { result: { value: page([]) } };
            return { result: { value: page([form({ password: 1, login: 1, other: 1 })]) } };
          }
          return { result: { objectId: `o-${this.commands.length}` } };
        }
        case "DOM.getBoxModel":
          return { model: { content: [0, 0, 100, 0, 100, 40, 0, 40] } };
        case "Runtime.callFunctionOn": {
          const declaration = String(params.functionDeclaration);
          if (declaration === HIT) return { result: { value: this.hit } };
          if (declaration === FOCUSED) return { result: { value: this.focused } };
          return { result: { value: true } };
        }
        default:
          return {};
      }
    })();
    return Promise.resolve(value as T);
  }
  on(_method: string, _handler: EventHandler): void {}
  ack(): void {}
  holdAcks(): void {}
  of(method: string) {
    return this.commands.filter((command) => command.method === method);
  }
}

/** The operator's discard of the work tab's document, as the fake sees it. */
function discarding(chrome: DeskChrome): (why: string) => Promise<void> {
  return (why) => {
    chrome.discarded.push(why);
    return Promise.resolve();
  };
}

function desk(chrome: DeskChrome): LoginDesk {
  return new LoginDesk({ cdp: chrome, tab: () => "S1", world: () => Promise.resolve(chrome.world), session: () => null, discard: discarding(chrome), timings: { settleMs: 50, pollMs: 10 }, log: () => undefined });
}

/** A call that may act throughout. */
const acting = () => null;

describe("the desk (plan §4.8: input as a person's)", () => {
  it("focuses, replaces, inserts, and presses at the button's centre — reading the screen before each step", async () => {
    const chrome = new DeskChrome();
    const answer = await desk(chrome).submit(LOGIN_MARKER, PASSWORD_MARKER, acting);
    expect(answer).toMatchObject({ kind: "state", screen: "login", screenVersion: SCREEN_VERSION });
    expect(chrome.of("Input.insertText").map((command) => command.params.text)).toEqual([LOGIN_MARKER, PASSWORD_MARKER]);
    expect(chrome.of("DOM.focus")).toHaveLength(2);
    const presses = chrome.of("Input.dispatchMouseEvent").map((command) => command.params);
    expect(presses.map((event) => event.type)).toEqual(["mouseMoved", "mousePressed", "mouseReleased"]);
    expect(presses[1]).toMatchObject({ x: 50, y: 20, button: "left", clickCount: 1 });
    // Read before typing each field and before the press, then after.
    const probes = chrome.commands.filter((command) => command.method === "Runtime.evaluate" && String(command.params.expression).includes("pbLoginProbe"));
    expect(probes.length).toBeGreaterThanOrEqual(4);
    // Every reference it took is let go.
    expect(chrome.of("Runtime.releaseObjectGroup")).not.toHaveLength(0);
  });

  it("presses nothing on a screen that is not the form's, or when something lies over the button", async () => {
    const other = new DeskChrome();
    other.screen = "other";
    expect(await desk(other).submit(LOGIN_MARKER, PASSWORD_MARKER, acting)).toEqual({ kind: "refused", reason: "screen_changed" });
    expect(other.of("Input.insertText")).toHaveLength(0);
    expect(other.of("Input.dispatchMouseEvent")).toHaveLength(0);
    const code = new DeskChrome();
    expect(await desk(code).code(CODE_MARKER, acting)).toEqual({ kind: "refused", reason: "screen_changed" });
    const covered = new DeskChrome();
    covered.hit = false;
    expect(await desk(covered).submit(LOGIN_MARKER, PASSWORD_MARKER, acting)).toEqual({ kind: "refused", reason: "screen_changed" });
    expect(covered.of("Input.dispatchMouseEvent")).toHaveLength(0);
  });

  it("one step at a time", async () => {
    const chrome = new DeskChrome();
    const d = desk(chrome);
    const [first, second] = await Promise.all([d.submit(LOGIN_MARKER, PASSWORD_MARKER, acting), d.submit(LOGIN_MARKER, PASSWORD_MARKER, acting)]);
    expect(first.kind).toBe("state");
    expect(second).toEqual({ kind: "refused", reason: "busy" });
  });

  // Astra's review of PR 15, item 3: the guard is read before every input
  // step, not only when the call was taken.
  it("a call that may act no more stops at its next input step: nothing more is typed or pressed", async () => {
    const inputs = (chrome: DeskChrome) => chrome.of("Input.insertText").map((command) => command.params.text);
    const mouse = (chrome: DeskChrome) => chrome.of("Input.dispatchMouseEvent").map((command) => command.params.type);
    const cases: Array<{ over: (method: string, params: Record<string, unknown>, chrome: DeskChrome) => boolean; typed: unknown[]; pressed: unknown[]; selects: number }> = [
      // The login went in; the password's focus is not given.
      { over: (method) => method === "Input.insertText", typed: [LOGIN_MARKER], pressed: [], selects: 1 },
      // The password field focused: its content is not even selected.
      { over: (method, _params, chrome) => method === "DOM.focus" && chrome.of("DOM.focus").length === 2, typed: [LOGIN_MARKER], pressed: [], selects: 1 },
      // Both typed; the pointer is not moved onto the button.
      { over: (method, _params, chrome) => method === "Input.insertText" && chrome.of("Input.insertText").length === 2, typed: [LOGIN_MARKER, PASSWORD_MARKER], pressed: [], selects: 2 },
      // The pointer on the button: no press.
      { over: (method, params) => method === "Input.dispatchMouseEvent" && params.type === "mouseMoved", typed: [LOGIN_MARKER, PASSWORD_MARKER], pressed: ["mouseMoved"], selects: 2 },
      // Pressed: not let go at all — its document discarded (rounds 2, 3).
      { over: (method, params) => method === "Input.dispatchMouseEvent" && params.type === "mousePressed", typed: [LOGIN_MARKER, PASSWORD_MARKER], pressed: ["mouseMoved", "mousePressed"], selects: 2 },
    ];
    for (const [n, c] of cases.entries()) {
      const chrome = new DeskChrome();
      let over: string | null = null;
      chrome.react = (method, params) => {
        if (c.over(method, params, chrome)) over = "the manual login is over";
      };
      const answer = await desk(chrome).submit(LOGIN_MARKER, PASSWORD_MARKER, () => over);
      expect(answer, `case ${n}`).toEqual({ kind: "refused", reason: "not_manual_login" });
      expect(inputs(chrome), `case ${n}`).toEqual(c.typed);
      expect(mouse(chrome), `case ${n}`).toEqual(c.pressed);
      expect(chrome.of("Runtime.callFunctionOn").filter((command) => String(command.params.functionDeclaration).includes("select()")), `case ${n}`).toHaveLength(c.selects);
      // What it found is let go all the same.
      expect(chrome.of("Runtime.releaseObjectGroup"), `case ${n}`).not.toHaveLength(0);
    }
    // A call that may not act from the start does nothing at all.
    const idle = new DeskChrome();
    expect(await desk(idle).code(CODE_MARKER, () => "no engine link")).toEqual({ kind: "refused", reason: "not_manual_login" });
    expect(idle.commands.filter((command) => command.method.startsWith("Input.") || command.method === "DOM.focus")).toHaveLength(0);
  });

  // Astra's review of PR 15, rounds 2 and 3: a press is never left
  // unfinished — and never let go anywhere but on its button.
  it("a press not let go on its button gets nothing more — no release, no move, nothing in the page — and its document is discarded before the step ends", async () => {
    const cases: Array<{ what: string; set: (chrome: DeskChrome, cut: () => void) => void; answer: string }> = [
      { what: "the call may act no more after the press", answer: "not_manual_login", set: (chrome, cut) => {
        chrome.react = (method, params) => {
          if (method === "Input.dispatchMouseEvent" && params.type === "mousePressed") cut();
        };
      } },
      { what: "the release does not answer", answer: "screen_changed", set: (chrome) => (chrome.fail = (method, params) => method === "Input.dispatchMouseEvent" && params.type === "mouseReleased") },
      { what: "the press does not answer", answer: "screen_changed", set: (chrome) => (chrome.fail = (method, params) => method === "Input.dispatchMouseEvent" && params.type === "mousePressed") },
    ];
    for (const { what, set, answer } of cases) {
      const chrome = new DeskChrome();
      let over: string | null = null;
      set(chrome, () => (over = "the engine's link was lost"));
      let discardedAt = -1;
      const d = new LoginDesk({ cdp: chrome, tab: () => "S1", world: () => Promise.resolve(chrome.world), session: () => null, timings: { settleMs: 50, pollMs: 10 }, log: () => undefined,
        discard: (why) => {
          chrome.discarded.push(why);
          discardedAt = chrome.commands.length;
          return Promise.resolve();
        } });
      const step = d.submit(LOGIN_MARKER, PASSWORD_MARKER, () => over);
      await d.drain();
      // Discarded before the step ended.
      expect(chrome.discarded, what).toEqual(["a press of the login form was not let go on its button"]);
      expect(await step, what).toEqual({ kind: "refused", reason: answer });
      // From the press on, nothing went to the page but what it was sent
      // already: no release other than an unanswered one, no move, no
      // function in it — only the desk's own references let go after.
      const pressedAt = chrome.commands.findIndex((command) => command.method === "Input.dispatchMouseEvent" && command.params.type === "mousePressed");
      const after = chrome.commands.slice(pressedAt + 1);
      const sentBefore = what === "the release does not answer" ? ["Input.dispatchMouseEvent"] : [];
      expect(after.slice(0, discardedAt - pressedAt - 1).map((command) => command.method), what).toEqual(sentBefore);
      expect(after.slice(discardedAt - pressedAt - 1).map((command) => command.method), what).toEqual(["Runtime.releaseObjectGroup"]);
    }
  });

  it("a call that may act no more after its press waits for no screen, and its drain is over with it", async () => {
    const chrome = new DeskChrome();
    let over: string | null = null;
    chrome.react = (method, params) => {
      if (method === "Input.dispatchMouseEvent" && params.type === "mouseReleased") over = "a new owner of the page";
    };
    // The screen stays the login form: an acting call would read it again
    // every 10 ms for 10 s, waiting for the next one.
    const d = new LoginDesk({ cdp: chrome, tab: () => "S1", world: () => Promise.resolve(chrome.world), session: () => null, discard: discarding(chrome), timings: { settleMs: 10_000, pollMs: 10 }, log: () => undefined });
    const answer = d.submit(LOGIN_MARKER, PASSWORD_MARKER, () => over);
    await d.drain();
    expect(await answer).toMatchObject({ kind: "state", screen: "login" });
    // After the release the screen was read once — the answer — and no more.
    const released = chrome.commands.findIndex((command) => command.method === "Input.dispatchMouseEvent" && command.params.type === "mouseReleased");
    expect(chrome.commands.slice(released + 1).filter((command) => command.method === "Runtime.evaluate" && String(command.params.expression).includes("pbLoginProbe"))).toHaveLength(1);
    expect(chrome.of("Input.dispatchMouseEvent").map((command) => command.params.type)).toEqual(["mouseMoved", "mousePressed", "mouseReleased"]);
    // Nothing under way: the drain is over at once.
    await d.drain();
  });

  // Astra's review of PR 15, item 4: what is acted on is read again at the
  // moment of the act.
  it("the pointer goes onto the button first; a screen, a document or an overlay that comes with it stops the press", async () => {
    const changes: Array<{ what: string; change: (chrome: DeskChrome) => void }> = [
      { what: "an unknown screen", change: (chrome) => (chrome.screen = "other") },
      { what: "an overlay over the button", change: (chrome) => (chrome.hit = false) },
      { what: "a new document", change: (chrome) => (chrome.world = 8) },
    ];
    for (const { what, change } of changes) {
      const chrome = new DeskChrome();
      chrome.react = (method, params) => {
        if (method === "Input.dispatchMouseEvent" && params.type === "mouseMoved") change(chrome);
      };
      expect(await desk(chrome).submit(LOGIN_MARKER, PASSWORD_MARKER, acting), what).toEqual({ kind: "refused", reason: "screen_changed" });
      expect(chrome.of("Input.dispatchMouseEvent").map((command) => command.params.type), what).toEqual(["mouseMoved"]);
      // Read again after the move: the screen and the hit test, last.
      const afterMove = chrome.commands.slice(chrome.commands.findIndex((command) => command.method === "Input.dispatchMouseEvent") + 1);
      expect(afterMove.some((command) => command.method === "Runtime.evaluate" && String(command.params.expression).includes("pbLoginProbe")), what).toBe(true);
    }
  });

  it("the text goes in only into the field it was meant for, focused, on the same screen and document", async () => {
    const changes: Array<{ what: string; on: (method: string, params: Record<string, unknown>, chrome: DeskChrome) => boolean; change: (chrome: DeskChrome) => void }> = [
      { what: "the focus taken away", on: (method, _params, chrome) => method === "DOM.focus" && chrome.of("DOM.focus").length === 2, change: (chrome) => (chrome.focused = false) },
      { what: "another screen once focused", on: (method, _params, chrome) => method === "DOM.focus" && chrome.of("DOM.focus").length === 2, change: (chrome) => (chrome.screen = "code") },
      { what: "a new document once selected", on: (method, params, chrome) => method === "Runtime.callFunctionOn" && String(params.functionDeclaration).includes("select()") && chrome.of("Input.insertText").length === 1, change: (chrome) => (chrome.world = 9) },
    ];
    for (const { what, on, change } of changes) {
      const chrome = new DeskChrome();
      chrome.react = (method, params) => {
        if (on(method, params, chrome)) change(chrome);
      };
      expect(await desk(chrome).submit(LOGIN_MARKER, PASSWORD_MARKER, acting), what).toEqual({ kind: "refused", reason: "screen_changed" });
      // The login went in; the password never.
      expect(chrome.of("Input.insertText").map((command) => command.params.text), what).toEqual([LOGIN_MARKER]);
      expect(chrome.of("Input.dispatchMouseEvent"), what).toHaveLength(0);
    }
    // The check runs right before each text: the focus asked of the field itself.
    const chrome = new DeskChrome();
    await desk(chrome).submit(LOGIN_MARKER, PASSWORD_MARKER, acting);
    const order = chrome.commands.map((command) => command.method === "Runtime.callFunctionOn" && String(command.params.functionDeclaration).includes("activeElement") ? "focused?" : command.method);
    for (let at = 0; at < order.length; at++) if (order[at] === "Input.insertText") expect(order[at - 1]).toBe("focused?");
  });
});

// ── the operator end to end ────────────────────────────────────────────────

interface SetUp {
  dir: string;
  operator: Operator;
  engine: FakeEngine;
  chrome: FakeChrome;
  model: BrowserModel;
  socks: FakeSocks;
  site: FakeLoginSite;
  logDir: string;
  lines: string[];
  rpcPort: number;
}

async function setUp(options: { apiToken?: string | null; haltStore?: HaltStore } = {}): Promise<SetUp> {
  const temp = tempDir();
  cleanups.push(temp.remove);
  const lines: string[] = [];
  setLogSink((line) => lines.push(line));
  const chrome = new FakeChrome();
  await chrome.boot();
  await chrome.shutdown();
  cleanups.push(() => chrome.close());
  const model = new BrowserModel(chrome);
  const site = new FakeLoginSite(model, { login: LOGIN_MARKER, password: PASSWORD_MARKER, code: CODE_MARKER, token: SITE_TOKEN, clientId: SITE_CLIENT });
  const holder = new HolderUnderS6(join(temp.dir, "holder.sock"), chrome);
  await holder.start();
  cleanups.push(() => holder.stop());
  const socks = new FakeSocks(SOCKS_USER, SOCKS_PASSWORD);
  await socks.start();
  cleanups.push(() => socks.stop());
  const ipify = await fakeIpify(() => "203.0.113.7");
  cleanups.push(ipify.close);
  socks.routes.set("api.ipify.org:443", ipify.port);
  const server = await tlsLikeServer();
  cleanups.push(server.close);
  socks.routes.set("apiv3.fansly.com:443", server.port);
  const control = new FakeChromeControl(chrome);
  const chromeEnv = join(temp.dir, "chrome-env");
  control.onStart = () => model.chromeStarts(chromeEnv);
  const netSelftest = join(temp.dir, "net-selftest.json");
  writeNetSelftest(netSelftest);
  const logDir = join(temp.dir, "logs");
  const extensionDir = join(temp.dir, "extension");
  writeExtensionPackage(extensionDir);
  const operator = new Operator({
    config: {
      holderSock: holder.socketPath,
      proxyHost: "127.0.0.1",
      proxyPort: 0,
      rpcHost: "127.0.0.1",
      rpcPort: 0,
      rpcToken: RPC_TOKEN,
      apiToken: options.apiToken === undefined ? API_TOKEN : options.apiToken,
      netSelftestPath: netSelftest,
      chromeEnvPath: chromeEnv,
      logDir,
      stateDir: join(temp.dir, "state"),
      bufferDir: join(temp.dir, "buffer"),
      extensionDir,
      heartbeatPath: join(temp.dir, "alive"),
      operatorVersion: "test",
    },
    chrome: control,
    exitIpTarget: { host: "api.ipify.org", port: 443, path: "/", wrap: (socket: Socket) => socket },
    loginTimings: { settleMs: 3000, pollMs: 20 },
    ...(options.haltStore ? { haltStore: options.haltStore } : {}),
    timings: { replayWaitMs: 2000, chromeUpMs: 5000, attachMs: 3000, envCheckMs: 3000, stateEveryMs: 200, healthEveryMs: 100, healthAnswerMs: 300, selfTestProbeMs: 2000, exitIpTimeoutMs: 2000, quitWaitMs: 1000 },
  });
  const ports = await operator.start();
  cleanups.push(() => operator.stop());
  model.proxyPort = ports.proxyPort;
  await until(() => operator.cdp.linked, WAIT_MS, "the holder link");
  const engine = new FakeEngine();
  await engine.connect(ports.rpcPort);
  cleanups.push(() => engine.close());
  engine.send(hello({ socks5: { ip: "127.0.0.1", port: socks.port, username: SOCKS_USER, password: SOCKS_PASSWORD } }));
  await engine.waitFor("helloResult", undefined, WAIT_MS);
  return { dir: temp.dir, operator, engine, chrome, model, socks, site, logDir, lines, rpcPort: ports.rpcPort };
}

let commandN = 0;
function command(engine: FakeEngine, command: Record<string, unknown>, generation = engine.generation): Promise<Record<string, unknown>> {
  const commandId = `c-${++commandN}`;
  engine.send({ type: "command", ownerGeneration: generation, commandId, notAfterMono: monoMs() + 10_000, command });
  return engine.waitFor("commandResult", (message) => message.commandId === commandId, WAIT_MS);
}

/** The API's end of the login form: one WebSocket, calls by id. */
class Caller {
  readonly replies: Array<Record<string, unknown>> = [];
  readonly frames: Buffer[] = [];
  closed: number | null = null;
  #ws: WebSocket | null = null;

  static async open(port: number): Promise<Caller> {
    const caller = new Caller();
    await new Promise<void>((resolve, reject) => {
      const ws = new WebSocket(`ws://127.0.0.1:${port}/rpc`);
      ws.binaryType = "arraybuffer";
      caller.#ws = ws;
      ws.onopen = () => resolve();
      ws.onerror = () => reject(new Error("no connection"));
      ws.onclose = (event) => (caller.closed = event.code);
      ws.onmessage = (event) => {
        if (event.data instanceof ArrayBuffer) caller.frames.push(Buffer.from(event.data));
        else caller.replies.push(JSON.parse(String(event.data)) as Record<string, unknown>);
      };
    });
    return caller;
  }

  async call(type: string, fields: Record<string, unknown> = {}, token = API_TOKEN, timeoutMs = WAIT_MS): Promise<Record<string, unknown>> {
    const callId = randomUUID();
    this.#ws!.send(JSON.stringify({ type, callId, token, ...fields }));
    let found: Record<string, unknown> | undefined;
    await until(() => (found = this.replies.find((reply) => reply.callId === callId)) !== undefined || this.closed !== null, timeoutMs, `the answer to ${type}`);
    return found ?? { closed: this.closed };
  }

  close(): void {
    this.#ws?.close();
  }
}

/** The page started, the site loaded (step 8), the engine admitting every
 *  site request and every check. */
async function started(s: SetUp, generation = 1): Promise<void> {
  let attempt = 7000;
  s.engine.onMessage = (message) => {
    if (message.type === "siteAdmit") s.engine.send({ type: "siteAdmitResult", ownerGeneration: generation, siteRequestId: message.siteRequestId, admit: true, deadlineMono: monoMs() + 15_000, attemptId: ++attempt });
    if (message.type === "check") s.engine.send({ type: "checkResult", ownerGeneration: generation, attemptId: message.attemptId, admit: true, deadlineMono: monoMs() + 15_000 });
  };
  expect(await command(s.engine, { kind: "restartBrowser" })).toMatchObject({ ok: true });
  await until(() => s.operator.page.step === "site_loaded", WAIT_MS, "the site loaded");
  s.site.setTab(s.operator.control.workTab!.sessionId);
}

/** Every file under `dir`, as bytes (the buffer's SQLite and bodies). */
function filesUnder(dir: string): Buffer[] {
  const out: Buffer[] = [];
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) out.push(...filesUnder(path));
    else out.push(readFileSync(path));
  }
  return out;
}

describe("the login form through the operator (plan §4.8; PR 15)", { timeout: LONG_TEST_MS }, () => {
  it("takes no call before the engine's manual login, and none with a wrong token", async () => {
    const s = await setUp();
    await started(s);
    const api = await Caller.open(s.rpcPort);
    cleanups.push(() => api.close());
    expect(await api.call("login.state")).toMatchObject({ type: "login.refused", reason: "not_manual_login" });
    expect(await api.call("login.submit", { login: LOGIN_MARKER, password: PASSWORD_MARKER })).toMatchObject({ type: "login.refused", reason: "not_manual_login" });
    expect(s.site.inserted).toEqual([]);
    // The engine's token is not the API's.
    const wrong = await Caller.open(s.rpcPort);
    expect(await wrong.call("login.state", {}, RPC_TOKEN)).toMatchObject({ type: "login.refused", reason: "token" });
    await until(() => wrong.closed !== null, WAIT_MS, "the wrong token's connection to close");
    // An API connection is not the engine's: the engine's link stands.
    expect(s.operator.rpc.linkUp).toBe(true);
  });

  it("a container without an API token refuses every call", async () => {
    const s = await setUp({ apiToken: null });
    const api = await Caller.open(s.rpcPort);
    expect(await api.call("login.state")).toMatchObject({ type: "login.refused", reason: "token" });
  });

  it("the manual login only by the current owner: an earlier generation's setMode is refused, and a new owner ends it", async () => {
    const s = await setUp();
    await started(s);
    const api = await Caller.open(s.rpcPort);
    cleanups.push(() => api.close());
    // A second engine of a newer generation takes the page.
    const newer = new FakeEngine();
    newer.generation = 2;
    await newer.connect(s.rpcPort);
    cleanups.push(() => newer.close());
    newer.send(hello({ ownerGeneration: 2, socks5: { ip: "127.0.0.1", port: s.socks.port, username: SOCKS_USER, password: SOCKS_PASSWORD } }));
    await newer.waitFor("quiesced", undefined, WAIT_MS);
    // The old one's command never reaches the operator's mode.
    s.engine.send({ type: "command", ownerGeneration: 1, commandId: "old-1", notAfterMono: monoMs() + 10_000, command: { kind: "setMode", mode: "manual_login" } });
    // A negative check (no event comes of a superseded connection's command):
    // the wait only gives a wrong operator the time to take it.
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(s.operator.state.mode).toBe("automation");
    expect(await api.call("login.state")).toMatchObject({ reason: "not_manual_login" });
    // The current owner's does.
    expect(await command(newer, { kind: "setMode", mode: "manual_login" })).toMatchObject({ ok: true });
    expect(s.operator.state.mode).toBe("manual_login");
    await until(() => s.operator.page.step === "site_loaded", WAIT_MS, "the site loaded anew");
    expect(await api.call("login.state")).toMatchObject({ type: "login.stateResult", screen: "login", screenVersion: SCREEN_VERSION, fields: ["login", "password"], siteError: null });
    // Generation 3 comes: the manual login was generation 2's.
    const third = new FakeEngine();
    third.generation = 3;
    await third.connect(s.rpcPort);
    cleanups.push(() => third.close());
    third.send(hello({ ownerGeneration: 3, socks5: { ip: "127.0.0.1", port: s.socks.port, username: SOCKS_USER, password: SOCKS_PASSWORD } }));
    await third.waitFor("quiesced", undefined, WAIT_MS);
    expect(s.operator.state.mode).toBe("automation");
    expect(await api.call("login.state")).toMatchObject({ reason: "not_manual_login" });
  });

  it("end to end: the screen, its screenshot, the login and the code typed in, the site's own login under the engine's admission, the success; then the automation with its checks — and nothing typed anywhere but in the browser", async () => {
    const s = await setUp();
    await started(s);
    const api = await Caller.open(s.rpcPort);
    cleanups.push(() => api.close());
    s.engine.send({ type: "events.subscribe", ownerGeneration: 1, bufferId: s.operator.buffer.id, afterSeq: 0 });
    const loadsBefore = s.model.navigations.length;
    expect(await command(s.engine, { kind: "setMode", mode: "manual_login" })).toMatchObject({ ok: true, detail: expect.stringContaining("the manual login") });
    await s.engine.waitFor("state", (state) => state.mode === "manual_login", WAIT_MS);
    // The site is loaded anew for its login screen.
    await until(() => s.model.navigations.length > loadsBefore && s.operator.page.step === "site_loaded", WAIT_MS, "the site loaded anew");
    s.site.setTab(s.operator.control.workTab!.sessionId);

    // The screen, and the screenshot: its bytes as frames before the JSON.
    expect(await api.call("login.state")).toMatchObject({ type: "login.stateResult", screen: "login", fields: ["login", "password"] });
    const shot = await api.call("login.screenshot");
    expect(shot).toMatchObject({ type: "login.screenshotResult" });
    const ref = shot.jpeg as { bodyId: string; decodedBytes: number; sha256: string };
    const frame = decodeBodyFrame(api.frames.at(-1)!);
    expect(frame).toMatchObject({ bodyId: ref.bodyId, part: 0, last: true });
    expect(frame.data.toString()).toBe("FAKEJPEG:login");
    expect(createHash("sha256").update(frame.data).digest("hex")).toBe(ref.sha256);

    // A wrong password first: the site's error, the fields to try again.
    const wrong = await api.call("login.submit", { login: LOGIN_MARKER, password: "pb15-wrong-marker" });
    expect(wrong).toMatchObject({ type: "login.stateResult", screen: "error", fields: ["login", "password"], siteError: "Invalid username or password" });
    // The login and the password, typed in; the site's own POST of them.
    const asked = s.engine.of("siteAdmit").length;
    const afterSubmit = await api.call("login.submit", { login: LOGIN_MARKER, password: PASSWORD_MARKER });
    expect(afterSubmit).toMatchObject({ type: "login.stateResult", screen: "code", fields: ["code"], siteError: null });
    expect(s.site.fields.login).toBe(LOGIN_MARKER);
    expect(s.site.presses).toBe(2);
    const loginAsk = s.engine.of("siteAdmit").slice(asked).find((ask) => ask.path === "/api/v1/login")!;
    expect(loginAsk).toMatchObject({ method: "POST", host: "apiv3.fansly.com", route: "auth.login", operation: "login", sessionFingerprint: null });
    // The code, typed in; the site's own POST of it; the success.
    const afterCode = await api.call("login.code", { code: CODE_MARKER });
    expect(afterCode).toMatchObject({ type: "login.stateResult", screen: "success", fields: [], siteError: null });
    const codeAsk = s.engine.of("siteAdmit").find((ask) => ask.path === "/api/v1/login/twofa")!;
    expect(codeAsk).toMatchObject({ method: "POST", route: "auth.twofa", operation: "login" });
    await until(() => s.engine.of("siteDone").filter((done) => [loginAsk.siteRequestId, codeAsk.siteRequestId].includes(done.siteRequestId)).length === 2, WAIT_MS, "both logins' ends");
    for (const done of s.engine.of("siteDone").filter((end) => [loginAsk.siteRequestId, codeAsk.siteRequestId].includes(end.siteRequestId))) {
      // Its answer is not kept: a login's answer carries secrets.
      expect(done).toMatchObject({ sent: true, status: 200, body: "not_platform_data" });
    }
    // The site's read after the login, its interface's, passes in the manual
    // login too (plan §4.8; PR 15) under the engine's admission, under the
    // session that is the page's now; its answer goes to the buffer as any
    // site answer.
    const fingerprint = sessionFingerprint(SITE_TOKEN, SITE_CLIENT);
    await s.engine.waitFor("state", (state) => state.sessionFingerprint === fingerprint, WAIT_MS);
    const readAsk = s.engine.of("siteAdmit").find((ask) => ask.path === "/api/v1/account/me")!;
    expect(readAsk).toMatchObject({ method: "GET", route: "account.me", operation: "read", sessionFingerprint: fingerprint });
    const readDone = await s.engine.waitFor("siteDone", (done) => done.siteRequestId === readAsk.siteRequestId, WAIT_MS);
    expect(readDone).toMatchObject({ sent: true, status: 200 });
    const answered = await s.engine.waitFor("events", (message) => (message.events as Array<{ kind: string; route?: string }>).some((event) => event.kind === "site.response" && event.route === "account.me"), WAIT_MS);
    expect((answered.events as Array<Record<string, unknown>>).find((event) => event.kind === "site.response")).toMatchObject({ route: "account.me", status: 200, sessionFingerprint: fingerprint });
    // The account loaded under the live session: a success sign of its own.
    expect(await api.call("login.state")).toMatchObject({ screen: "success" });
    // No socket of the site while a person is in the page.
    expect(s.operator.page.step).toBe("site_loaded");

    // The automation is back: the exit IP checked, the site loaded anew.
    const loads = s.model.navigations.length;
    const back = await command(s.engine, { kind: "setMode", mode: "automation" });
    expect(back).toMatchObject({ ok: true });
    expect(String(back.detail)).toContain("the exit IP 203.0.113.7 is the pinned one");
    expect(s.operator.state.mode).toBe("automation");
    await until(() => s.model.navigations.length > loads, WAIT_MS, "the site loaded anew under the automation");
    expect(await api.call("login.state")).toMatchObject({ reason: "not_manual_login" });

    // What was typed reached the browser — and nothing else.
    expect(s.site.inserted).toEqual([LOGIN_MARKER, "pb15-wrong-marker", LOGIN_MARKER, PASSWORD_MARKER, CODE_MARKER]);
    await s.operator.journals.flushed();
    await s.operator.buffer.close();
    const written = [...filesUnder(s.logDir), ...filesUnder(join(s.dir, "buffer")), ...filesUnder(join(s.dir, "state"))];
    expect(written.length).toBeGreaterThan(0);
    for (const marker of [LOGIN_MARKER, PASSWORD_MARKER, CODE_MARKER, "pb15-wrong-marker"]) {
      expect(s.lines.join("\n"), marker).not.toContain(marker);
      for (const file of written) expect(file.includes(marker), marker).toBe(false);
      for (const message of s.engine.messages) expect(JSON.stringify(message), marker).not.toContain(marker);
    }
    // The facts are there: the steps, the login's path, its end.
    const log = s.lines.join("\n");
    expect(log).toContain('"e":"step.done"');
    expect(Buffer.concat(filesUnder(s.logDir)).toString()).toContain("/api/v1/login/twofa");
  });

  it("a press goes to the button's centre only (spec §7: nothing pressed where something else lies)", async () => {
    const s = await setUp();
    await started(s);
    expect(await command(s.engine, { kind: "setMode", mode: "manual_login" })).toMatchObject({ ok: true });
    await until(() => s.operator.page.step === "site_loaded", WAIT_MS, "the site loaded anew");
    s.site.setTab(s.operator.control.workTab!.sessionId);
    const api = await Caller.open(s.rpcPort);
    cleanups.push(() => api.close());
    s.site.covered = true;
    expect(await api.call("login.submit", { login: LOGIN_MARKER, password: PASSWORD_MARKER })).toMatchObject({ type: "login.refused", reason: "screen_changed" });
    expect(s.site.presses).toBe(0);
    expect(s.site.posts).toHaveLength(0);
    s.site.covered = false;
    s.site.screen = "captcha";
    expect(await api.call("login.state")).toMatchObject({ screen: "unknown", fields: [] });
    expect(await api.call("login.submit", { login: LOGIN_MARKER, password: PASSWORD_MARKER })).toMatchObject({ reason: "screen_changed" });
    expect(s.chrome.sent("Input.dispatchMouseEvent").filter((cmd) => cmd.params.x === BUTTON_CENTRE.x && cmd.params.type === "mousePressed")).toHaveLength(0);
  });

  /** The site's own read with a session (its headers as the site sets them). */
  function siteRead(s: SetUp, token: string, clientId: string): void {
    const path = "/api/v1/account/me";
    s.model.pause(`https://apiv3.fansly.com${path}?ngsw-bypass=true`, "GET", s.operator.control.workTab!.sessionId, "XHR", {
      Accept: "application/json, text/plain, */*",
      authorization: token,
      "fansly-client-check": fanslyClientCheck(path, clientId),
      "fansly-client-id": clientId,
      "fansly-client-ts": String(Date.now()),
      "fansly-session-id": "720167541418230022",
    });
  }

  it("a browser Fansly signed out (login_required held): started only for the owner's login, and that halt cleared by the operator once the expected account is confirmed after it (PR 17, Astra round 3)", async () => {
    const store = new HaltStore(null);
    const held = { id: randomUUID(), reason: "login_required" as const, atWall: Date.now() - 60_000 };
    store.write({ halt: held, lastClearedId: null });
    const s = await setUp({ haltStore: store });
    expect(s.operator.heldHalt).toEqual(held);
    let attempt = 7600;
    s.engine.onMessage = (message) => {
      if (message.type === "siteAdmit") s.engine.send({ type: "siteAdmitResult", ownerGeneration: 1, siteRequestId: message.siteRequestId, admit: true, deadlineMono: monoMs() + 15_000, attemptId: ++attempt });
      if (message.type === "check") s.engine.send({ type: "checkResult", ownerGeneration: 1, attemptId: message.attemptId, admit: true, deadlineMono: monoMs() + 15_000 });
    };
    // In the automation: no start for it.
    expect(await command(s.engine, { kind: "restartBrowser" })).toMatchObject({ ok: false, detail: expect.stringContaining("clearHalt first") });
    // The owner's login: its start is taken.
    expect(await command(s.engine, { kind: "setMode", mode: "manual_login" })).toMatchObject({ ok: true });
    expect(await command(s.engine, { kind: "restartBrowser" })).toMatchObject({ ok: true });
    await until(() => s.operator.page.step === "site_loaded", WAIT_MS, "the site loaded");
    s.site.setTab(s.operator.control.workTab!.sessionId);
    const token = "fansly-token-SiGnEdOuT0123456789ab";
    const fingerprint = sessionFingerprint(token, SITE_CLIENT);
    siteRead(s, token, SITE_CLIENT);
    await s.engine.waitFor("state", (state) => state.sessionFingerprint === fingerprint, WAIT_MS);
    // Still held while the person is in the page.
    expect(s.operator.heldHalt).toEqual(held);
    // The automation; the engine's identity read names the expected account: cleared.
    const loads = s.model.navigations.length;
    expect(await command(s.engine, { kind: "setMode", mode: "automation" })).toMatchObject({ ok: true });
    await until(() => s.model.navigations.length > loads && s.operator.page.step === "site_loaded", WAIT_MS, "the site loaded anew");
    s.model.hubBody = Buffer.from(JSON.stringify({ success: true, response: { account: { id: "123456789" } } }));
    s.engine.send({ type: "send", ownerGeneration: 1, attemptId: 9701, route: "account.me", credentialsGeneration: "c".repeat(64), sessionFingerprint: fingerprint, method: "GET", url: "https://apiv3.fansly.com/api/v1/account/me?ngsw-bypass=true", headers: {}, kind: "api", maxBodyBytes: 32 * 1024 * 1024, sendDeadlineMono: monoMs() + 15_000, requestDeadlineMono: monoMs() + 20_000 });
    await until(() => s.operator.page.step === "ready", WAIT_MS, "the page ready");
    expect(s.operator.heldHalt).toBeNull();
    expect(store.read()).toEqual({ halt: null, lastClearedId: held.id });
    await s.engine.waitFor("state", (state) => state.halt === null && state.step === "ready", WAIT_MS);
  });

  it("a ready page is not ready while a person is in it: back at the loaded site until the automation, and ready only once a fresh identity read confirms it", async () => {
    const s = await setUp();
    await started(s);
    const token = "fansly-token-ReAdYbEfOrE0123456789";
    const fingerprint = sessionFingerprint(token, SITE_CLIENT);
    siteRead(s, token, SITE_CLIENT);
    await s.engine.waitFor("state", (state) => state.sessionFingerprint === fingerprint, WAIT_MS);
    // The engine's identity read names the page's account: ready.
    s.model.hubBody = Buffer.from(JSON.stringify({ success: true, response: { account: { id: "123456789" } } }));
    const identity = (attemptId: number) => ({ type: "send", ownerGeneration: 1, attemptId, route: "account.me", credentialsGeneration: "c".repeat(64), sessionFingerprint: fingerprint, method: "GET", url: "https://apiv3.fansly.com/api/v1/account/me?ngsw-bypass=true", headers: {}, kind: "api", maxBodyBytes: 32 * 1024 * 1024, sendDeadlineMono: monoMs() + 15_000, requestDeadlineMono: monoMs() + 20_000 });
    await s.engine.waitFor("siteDone", () => true, WAIT_MS);
    s.engine.send(identity(9501));
    await until(() => s.operator.page.step === "ready", WAIT_MS, "the page ready");
    // The manual login: never ready while it lasts, though the session is
    // the one the identity named.
    expect(await command(s.engine, { kind: "setMode", mode: "manual_login" })).toMatchObject({ ok: true });
    expect(s.operator.page.step).not.toBe("ready");
    await until(() => s.operator.page.step === "site_loaded", WAIT_MS, "the site loaded anew");
    // The site's read again under that session: it passes (the interface's
    // read, PR 15), but the page is no readier for it.
    const ends = s.engine.of("siteDone").length;
    siteRead(s, token, SITE_CLIENT);
    await until(() => s.engine.of("siteDone").length > ends, WAIT_MS, "the site's read ended");
    expect(s.operator.page.step).toBe("site_loaded");
    expect(s.operator.admissionsOpen()).toBe(true);
    // Hub's request under the live session does not go while a person is in
    // the page: answered, not sent.
    const issued = s.model.hubRequests.length;
    s.engine.send(identity(9502));
    expect((await s.engine.waitFor("result", (message) => message.attemptId === 9502, WAIT_MS)).outcome).toMatchObject({ sent: false });
    expect(s.model.hubRequests).toHaveLength(issued);
    // The automation: the site loaded anew — and not ready on the identity
    // read from before the login, though the session is the same (Astra's
    // review of PR 15, item 6): a person was in the page meanwhile.
    const loads = s.model.navigations.length;
    expect(await command(s.engine, { kind: "setMode", mode: "automation" })).toMatchObject({ ok: true });
    // (Ready, if at all, at the moment it loaded: the session is confirmed
    // with the load's own step.)
    await until(() => s.model.navigations.length > loads && s.operator.page.step === "site_loaded", WAIT_MS, "the site loaded anew");
    expect(s.operator.page.step).toBe("site_loaded");
    expect(s.operator.state.accountId).toBeNull();
    // A fresh identity read under the live session: ready again.
    s.engine.send(identity(9503));
    await until(() => s.operator.page.step === "ready", WAIT_MS, "the page ready again");
    expect(s.operator.state.accountId).toBe("123456789");
  });

  // Whatever clock Chrome's own timing runs on: the freshness is judged by
  // the operator's (the gate's first bytes). CI's machine read the fake's
  // fixed Chrome timing (777 s) as later than its own monotonic clock — a
  // freshly started one — and took a read from before the login as fresh.
  it.for([
    { chrome: "the fake's fixed timing", timing: () => ({ requestTime: 777.125, sendStart: 1.5 }) },
    { chrome: "an hour ahead of the operator's clock", timing: () => ({ requestTime: monoMs() / 1000 + 3600, sendStart: 1.5 }) },
    { chrome: "an hour behind the operator's clock", timing: () => ({ requestTime: Math.max(0, monoMs() / 1000 - 3600), sendStart: 1.5 }) },
  ])("an identity read sent before the login and answered after it names nothing — Chrome's timing $chrome: the page waits for one sent after it", { timeout: LONG_TEST_MS }, async ({ timing }) => {
    const s = await setUp();
    s.model.hubTiming = timing();
    await started(s);
    const token = "fansly-token-StAlEiDeNtItY0123456789";
    const fingerprint = sessionFingerprint(token, SITE_CLIENT);
    siteRead(s, token, SITE_CLIENT);
    await s.engine.waitFor("state", (state) => state.sessionFingerprint === fingerprint, WAIT_MS);
    await s.engine.waitFor("siteDone", () => true, WAIT_MS);
    s.model.hubBody = Buffer.from(JSON.stringify({ success: true, response: { account: { id: "123456789" } } }));
    const identity = (attemptId: number) => ({ type: "send", ownerGeneration: 1, attemptId, route: "account.me", credentialsGeneration: "c".repeat(64), sessionFingerprint: fingerprint, method: "GET", url: "https://apiv3.fansly.com/api/v1/account/me?ngsw-bypass=true", headers: {}, kind: "api", maxBodyBytes: 32 * 1024 * 1024, sendDeadlineMono: monoMs() + 60_000, requestDeadlineMono: monoMs() + 90_000 });
    // The identity read's answer is held at its headers until the login is over.
    const answer = s.chrome.handlers.get("Fetch.continueResponse")!;
    let release: () => void = () => undefined;
    const held = new Promise<void>((resolve) => (release = resolve));
    let holding = false;
    s.chrome.handlers.set("Fetch.continueResponse", async (cmd) => {
      if (s.model.hubRequests.some((request) => request.interceptionId === cmd.params.requestId)) {
        holding = true;
        await held;
      }
      return answer(cmd);
    });
    s.engine.send(identity(9601));
    await until(() => holding, WAIT_MS, "the identity read sent, its answer held");
    // A person's login meanwhile.
    expect(await command(s.engine, { kind: "setMode", mode: "manual_login" })).toMatchObject({ ok: true });
    await until(() => s.operator.page.step === "site_loaded", WAIT_MS, "the site loaded anew");
    const loads = s.model.navigations.length;
    expect(await command(s.engine, { kind: "setMode", mode: "automation" })).toMatchObject({ ok: true });
    await until(() => s.model.navigations.length > loads && s.operator.page.step === "site_loaded", WAIT_MS, "the site loaded anew under the automation");
    // The earlier read's answer comes now: it names the account, under the
    // live session — and confirms nothing. The operator judged it before it
    // sent the engine the read's result.
    release();
    expect((await s.engine.waitFor("result", (message) => message.attemptId === 9601, WAIT_MS)).outcome).toMatchObject({ kind: "response", status: 200 });
    expect(s.lines.join("\n")).toContain("session.identity_stale");
    expect(s.operator.page.step).toBe("site_loaded");
    expect(s.operator.state.accountId).toBeNull();
    // One sent after the login does.
    s.engine.send(identity(9602));
    await until(() => s.operator.page.step === "ready", WAIT_MS, "the page ready");
    expect(s.operator.state.accountId).toBe("123456789");
    // What the engine was told of both sends is the gate's instant, the
    // operator's own clock — Chrome's timing never crosses (Astra's review
    // of PR 15, round 5): the result's instant is the `sent` one.
    const fresh = await s.engine.waitFor("result", (message) => message.attemptId === 9602, WAIT_MS);
    for (const [attemptId, result] of [[9601, await s.engine.waitFor("result", (message) => message.attemptId === 9601, WAIT_MS)], [9602, fresh]] as const) {
      const sent = s.engine.of("sent").find((message) => message.attemptId === attemptId)!;
      expect((result.outcome as { sentMono: number }).sentMono, String(attemptId)).toBe(sent.sentMono);
      expect(sent.sentMono as number, String(attemptId)).toBeLessThanOrEqual(monoMs());
    }
  });

  it("no socket of the site in the manual login: its CONNECT is refused before any admission is asked", async () => {
    const s = await setUp();
    await started(s);
    siteRead(s, SITE_TOKEN, SITE_CLIENT);
    await s.engine.waitFor("state", (state) => state.sessionFingerprint === sessionFingerprint(SITE_TOKEN, SITE_CLIENT), WAIT_MS);
    // In the automation the socket's CONNECT is asked of the engine.
    const asked = proxyConnect(s.model.proxyPort, "wsv3.fansly.com:443");
    await s.engine.waitFor("wsAdmit", undefined, WAIT_MS);
    const ask = s.engine.last("wsAdmit")!;
    s.engine.send({ type: "wsAdmitResult", ownerGeneration: 1, connectionId: ask.connectionId, admit: false, reason: "held", retryNotBeforeWall: null });
    (await asked).socket.destroy();
    expect(await command(s.engine, { kind: "setMode", mode: "manual_login" })).toMatchObject({ ok: true });
    const before = s.engine.of("wsAdmit").length;
    const refused = await proxyConnect(s.model.proxyPort, "wsv3.fansly.com:443");
    refused.socket.destroy();
    expect(refused.status).not.toBe(200);
    // A negative check: the wait only gives a wrong operator the time to ask.
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(s.engine.of("wsAdmit")).toHaveLength(before);
  });

  // Astra's review of PR 15, item 3: a step taken in one owner's manual
  // login does not go on in another's, nor after it.
  it("a step under way stops at its next input step when its owner, its manual login or its engine link goes — and what comes next waits for it", async () => {
    for (const what of ["a new owner", "the automation back", "the engine's link lost"] as const) {
      const s = await setUp();
      await started(s);
      expect(await command(s.engine, { kind: "setMode", mode: "manual_login" })).toMatchObject({ ok: true });
      await until(() => s.operator.page.step === "site_loaded", WAIT_MS, "the site loaded anew");
      s.site.setTab(s.operator.control.workTab!.sessionId);
      const api = await Caller.open(s.rpcPort);
      cleanups.push(() => api.close());
      // The password field's focus is held at the page: the step stands there.
      const focus = s.chrome.handlers.get("DOM.focus")!;
      let focuses = 0;
      let release: () => void = () => undefined;
      let reached = false;
      const held = new Promise<void>((resolve) => (release = resolve));
      s.chrome.handlers.set("DOM.focus", async (cmd) => {
        if (++focuses === 2) {
          reached = true;
          await held;
        }
        return focus(cmd);
      });
      const submitting = api.call("login.submit", { login: LOGIN_MARKER, password: PASSWORD_MARKER });
      await until(() => reached, WAIT_MS, "the password's focus at the page");
      let next: Promise<unknown>;
      const loads = s.model.navigations.length;
      if (what === "a new owner") {
        const newer = new FakeEngine();
        newer.generation = 2;
        await newer.connect(s.rpcPort);
        cleanups.push(() => newer.close());
        newer.send(hello({ ownerGeneration: 2, socks5: { ip: "127.0.0.1", port: s.socks.port, username: SOCKS_USER, password: SOCKS_PASSWORD } }));
        next = newer.waitFor("quiesced", () => true, WAIT_MS);
      } else if (what === "the automation back") {
        // Another tab of the dashboard finished the login: the engine's setMode.
        next = command(s.engine, { kind: "setMode", mode: "automation" });
      } else {
        s.engine.close();
        await until(() => !s.operator.rpc.linkUp, WAIT_MS, "the link lost");
        next = Promise.resolve();
      }
      // The hand-over's quiesced and the automation's answer wait for the step
      // (a negative check: nothing ends it but the release below — the wait
      // only gives a wrong operator the time to answer early); and when
      // they come, the step has ended (its log line is written before).
      let settled = false;
      let stepEndedFirst: boolean | null = null;
      void next.then(() => {
        settled = true;
        stepEndedFirst = s.lines.some((line) => line.includes('"e":"step.cancelled"'));
      });
      await new Promise((resolve) => setTimeout(resolve, 300));
      if (what !== "the engine's link lost") expect(settled, what).toBe(false);
      release();
      expect(await submitting, what).toMatchObject({ type: "login.refused", reason: "not_manual_login" });
      await next;
      if (what !== "the engine's link lost") expect(stepEndedFirst, what).toBe(true);
      // The login went in before; the password never, and nothing was pressed.
      expect(s.site.inserted, what).toEqual([LOGIN_MARKER]);
      expect(s.site.presses, what).toBe(0);
      expect(s.chrome.sent("Input.dispatchMouseEvent"), what).toHaveLength(0);
      expect(s.site.posts, what).toHaveLength(0);
      // The automation back loads the site anew: over before the operator goes
      // (a load cut by the teardown is an error of its own).
      if (what !== "the engine's link lost") await until(() => s.model.navigations.length > loads && s.operator.page.step === "site_loaded", WAIT_MS, "the site loaded under the automation");
      for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
    }
  }, LONG_TEST_MS);

  // Astra's review of PR 15, rounds 2 and 3: the press of a step cut
  // between the press and its release dies with its document before the
  // desk is drained; the next step works on the fresh one.
  it("a step cut between its press and its release: no release, its document discarded, nothing clicked later; the next step works", async () => {
    for (const blank of ["comes", "does not come"] as const) {
      const s = await setUp();
      await started(s);
      expect(await command(s.engine, { kind: "setMode", mode: "manual_login" })).toMatchObject({ ok: true });
      await until(() => s.operator.page.step === "site_loaded", WAIT_MS, "the site loaded anew");
      s.site.setTab(s.operator.control.workTab!.sessionId);
      if (blank === "does not come") s.model.blankLoads = "error";
      const api = await Caller.open(s.rpcPort);
      cleanups.push(() => api.close());
      // The engine's link goes while the button is pressed.
      const mouse = s.chrome.handlers.get("Input.dispatchMouseEvent")!;
      let cut = true;
      s.chrome.handlers.set("Input.dispatchMouseEvent", async (cmd) => {
        if (cmd.params.type === "mousePressed" && cut) {
          cut = false;
          s.engine.close();
          await until(() => !s.operator.rpc.linkUp, WAIT_MS, "the link lost");
        }
        return mouse(cmd);
      });
      const loads = s.model.navigations.length;
      expect(await api.call("login.submit", { login: LOGIN_MARKER, password: PASSWORD_MARKER }), blank).toMatchObject({ type: "login.refused", reason: "not_manual_login" });
      await s.operator.login.drain();
      // No release at all, no click, no POST; nothing pressed any more.
      expect(s.chrome.sent("Input.dispatchMouseEvent").filter((cmd) => cmd.params.type === "mouseReleased"), blank).toHaveLength(0);
      expect(s.site.presses, blank).toBe(0);
      expect(s.site.down, blank).toBe(false);
      expect(s.lines.join("\n"), blank).toContain("login.document_discarded");
      // A release over the button later — a person's, say — clicks nothing.
      // (The fake site clicks, and posts, within the release's own handling.)
      await mouse({ id: 0, method: "Input.dispatchMouseEvent", params: { type: "mouseReleased", x: BUTTON_CENTRE.x, y: BUTTON_CENTRE.y, button: "left", clickCount: 1 } } as never);
      expect(s.site.presses, blank).toBe(0);
      expect(s.site.posts, blank).toHaveLength(0);
      if (blank === "comes") {
        // A blank document, then the site anew.
        expect(s.model.navigations.slice(loads)).toEqual(["about:blank", "https://fansly.com/"]);
        await until(() => s.operator.page.step === "site_loaded", WAIT_MS, "the site loaded anew");
        // The engine comes back; the next step works on the fresh document.
        const again = new FakeEngine();
        await again.connect(s.rpcPort);
        cleanups.push(() => again.close());
        again.send(hello({ socks5: { ip: "127.0.0.1", port: s.socks.port, username: SOCKS_USER, password: SOCKS_PASSWORD } }));
        await again.waitFor("helloResult", undefined, WAIT_MS);
        again.onMessage = (message) => {
          if (message.type === "siteAdmit") again.send({ type: "siteAdmitResult", ownerGeneration: 1, siteRequestId: message.siteRequestId, admit: true, deadlineMono: monoMs() + 15_000, attemptId: 8000 + Math.floor(Math.random() * 1000) });
        };
        await until(() => s.operator.rpc.linkUp, WAIT_MS, "the link back");
        s.site.setTab(s.operator.control.workTab!.sessionId);
        expect(await api.call("login.submit", { login: LOGIN_MARKER, password: PASSWORD_MARKER })).toMatchObject({ type: "login.stateResult", screen: "code" });
        expect(s.site.presses).toBe(1);
      } else {
        // No blank document: the page's Chrome goes, and the press with it.
        await until(() => s.lines.some((line) => line.includes('"stopReason":"cdp_lost"') && line.includes("the browser goes with it")), WAIT_MS, "the browser gone");
        // It starts again (a failure's retry): over before the operator goes.
        await until(() => s.operator.page.step === "site_loaded", WAIT_MS, "the browser started again");
      }
      for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
    }
  }, LONG_TEST_MS);

  it("the login operations are the manual login's only: in the automation the map closes them", async () => {
    const s = await setUp();
    await started(s);
    const tab = s.operator.control.workTab!.sessionId;
    const request = s.model.pause("https://apiv3.fansly.com/api/v1/login", "POST", tab, "XHR", { "content-type": "application/json" }, JSON.stringify({ username: LOGIN_MARKER, password: PASSWORD_MARKER }));
    await until(() => request.outcome === "failed", WAIT_MS, "the login to be failed");
    expect(request.failReason).toBe("BlockedByClient");
    expect(s.engine.of("siteAdmit").some((ask) => ask.path === "/api/v1/login")).toBe(false);
    // The code of a new device's login, e-mailed by Fansly, is no exception
    // (owner decision 2026-10-15: open for the time of the login only).
    const code = s.model.pause("https://apiv3.fansly.com/api/v1/login/twofa", "POST", tab, "XHR", { "content-type": "application/json" }, JSON.stringify({ token: "twofa-step-token", code: CODE_MARKER }));
    await until(() => code.outcome === "failed", WAIT_MS, "the code to be failed");
    expect(code.failReason).toBe("BlockedByClient");
    expect(s.engine.of("siteAdmit").some((ask) => ask.path === "/api/v1/login/twofa")).toBe(false);
  });

  it("a login from a new device: the code Fansly e-mailed, asked for as such — its error, then the code typed in, the site's own POST /login/twofa under the engine's admission, the success; the e-mail's operations closed in the manual login too; nothing typed anywhere but in the browser (owner decision 2026-10-15)", async () => {
    const s = await setUp();
    await started(s);
    const api = await Caller.open(s.rpcPort);
    cleanups.push(() => api.close());
    s.site.newDevice = true;
    const loadsBefore = s.model.navigations.length;
    expect(await command(s.engine, { kind: "setMode", mode: "manual_login" })).toMatchObject({ ok: true });
    await until(() => s.model.navigations.length > loadsBefore && s.operator.page.step === "site_loaded", WAIT_MS, "the site loaded anew");
    s.site.setTab(s.operator.control.workTab!.sessionId);

    const afterSubmit = await api.call("login.submit", { login: LOGIN_MARKER, password: PASSWORD_MARKER });
    expect(afterSubmit).toEqual({ type: "login.stateResult", callId: expect.any(String), screen: "code", screenVersion: SCREEN_VERSION, fields: ["code"], siteError: null, codeFrom: "email" });
    expect(await api.call("login.state")).toMatchObject({ screen: "code", codeFrom: "email" });
    // A wrong code: the site's error at the same form, still the e-mail's code.
    const wrong = await api.call("login.code", { code: "pb-email-wrong-3f1a" });
    expect(wrong).toMatchObject({ type: "login.stateResult", screen: "error", fields: ["code"], siteError: "Invalid code", codeFrom: "email" });
    const afterCode = await api.call("login.code", { code: CODE_MARKER });
    expect(afterCode).toMatchObject({ type: "login.stateResult", screen: "success", fields: [], siteError: null });
    expect(afterCode).not.toHaveProperty("codeFrom");
    const codeAsks = s.engine.of("siteAdmit").filter((ask) => ask.path === "/api/v1/login/twofa");
    expect(codeAsks).toHaveLength(2);
    for (const ask of codeAsks) expect(ask).toMatchObject({ method: "POST", host: "apiv3.fansly.com", route: "auth.twofa", operation: "login" });
    await until(() => s.engine.of("siteDone").filter((done) => codeAsks.some((ask) => ask.siteRequestId === done.siteRequestId)).length === 2, WAIT_MS, "both codes' ends");
    for (const done of s.engine.of("siteDone").filter((end) => codeAsks.some((ask) => ask.siteRequestId === end.siteRequestId))) {
      // Its answer is not kept: a login's answer carries secrets.
      expect(done).toMatchObject({ sent: true, status: 200, body: "not_platform_data" });
    }
    // The bundle's e-mail operations change or confirm the account's address
    // — no login: closed in the manual login as every other write.
    const tab = s.operator.control.workTab!.sessionId;
    for (const path of ["/login/email", "/login/email/verify", "/login/email/verification", "/login/email/verification/token"]) {
      const write = s.model.pause(`https://apiv3.fansly.com/api/v1${path}`, "POST", tab, "XHR", { "content-type": "application/json" }, JSON.stringify({ code: CODE_MARKER }));
      await until(() => write.outcome === "failed", WAIT_MS, `${path} to be failed`);
      expect(write.failReason, path).toBe("BlockedByClient");
      expect(s.engine.of("siteAdmit").some((ask) => ask.path === `/api/v1${path}`), path).toBe(false);
    }

    // What was typed reached the browser — and nothing else.
    expect(s.site.inserted).toEqual([LOGIN_MARKER, PASSWORD_MARKER, "pb-email-wrong-3f1a", CODE_MARKER]);
    await s.operator.journals.flushed();
    await s.operator.buffer.close();
    const written = [...filesUnder(s.logDir), ...filesUnder(join(s.dir, "buffer")), ...filesUnder(join(s.dir, "state"))];
    expect(written.length).toBeGreaterThan(0);
    for (const marker of [LOGIN_MARKER, PASSWORD_MARKER, CODE_MARKER, "pb-email-wrong-3f1a"]) {
      expect(s.lines.join("\n"), marker).not.toContain(marker);
      for (const file of written) expect(file.includes(marker), marker).toBe(false);
      for (const message of s.engine.messages) expect(JSON.stringify(message), marker).not.toContain(marker);
    }
  });
});
