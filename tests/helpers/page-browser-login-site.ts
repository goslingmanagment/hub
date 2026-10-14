// A fake Fansly login site behind the scripted browser (page-browser-fakes.ts
// BrowserModel): the screens of spec §7 as the operator's login desk sees
// them through CDP — its probe and locator in the isolated world, DOM.focus,
// Input.insertText, DOM.getBoxModel, Input.dispatchMouseEvent at the
// button's centre, Page.captureScreenshot — and what pressing the button
// does: the site's own POST of the login or of the code, paused in Fetch
// like any request of the site (with its body, as Chrome carries it), and
// the next screen once it ended. No real site, no real credential: the
// values a test types are markers.

import { FOCUSED, HIT, SELECT_ALL, type FormMarks, type PageMarks } from "../../apps/page-browser/src/login/screens.ts";
import { fanslyClientCheck } from "../../apps/page-browser/src/hub-requests/session.ts";
import type { BrowserModel, CdpCommand, ModelRequest } from "./page-browser-fakes.ts";

export type FakeScreen = "landing" | "login" | "code" | "success" | "captcha" | "consent";

export interface FakeLoginOptions {
  /** The login and password the site takes. */
  login: string;
  password: string;
  /** The code the site takes; null: no second step. */
  code: string | null;
  /** The session the site holds once logged in (its token and client id). */
  token: string;
  clientId: string;
}

/** The button's box on the fake page, and its centre. */
export const BUTTON_QUAD = [100, 200, 300, 200, 300, 240, 100, 240];
export const BUTTON_CENTRE = { x: 200, y: 220 };

export class FakeLoginSite {
  screen: FakeScreen = "login";
  error: string | null = null;
  /** What the fields hold (the site's, not the operator's). */
  readonly fields = { login: "", password: "", code: "" };
  /** Something lies over the button: the hit test fails. */
  covered = false;
  /** Every text the browser was given by Input.insertText, in order. */
  readonly inserted: string[] = [];
  /** The site's own POSTs of the login. */
  readonly posts: ModelRequest[] = [];
  /** Mouse presses that reached the button. */
  presses = 0;
  readonly #model: BrowserModel;
  readonly #options: FakeLoginOptions;
  readonly #objects = new Map<string, string>();
  #focused: string | null = null;
  #objectN = 0;

  constructor(model: BrowserModel, options: FakeLoginOptions) {
    this.#model = model;
    this.#options = options;
    const chrome = model.chrome;
    const chain = (method: string, mine: (command: CdpCommand) => Record<string, unknown> | undefined) => {
      const previous = chrome.handlers.get(method);
      chrome.handlers.set(method, (command) => mine(command) ?? (previous ? previous(command) : {}));
    };
    chain("Runtime.evaluate", (command) => {
      const expression = String(command.params.expression ?? "");
      if (expression.includes("pbLoginProbe")) return { result: { type: "object", value: this.marks() } };
      if (expression.includes("pbLoginLocate")) {
        const role = JSON.parse(/\}\)\((".*")\)$/.exec(expression)![1]!) as string;
        const found = this.#locate(role);
        if (found === null) return { result: { type: "object", subtype: "null", value: null } };
        const objectId = `obj-${++this.#objectN}`;
        this.#objects.set(objectId, found);
        return { result: { type: "object", subtype: "node", objectId } };
      }
      return undefined;
    });
    chain("Runtime.callFunctionOn", (command) => {
      if (command.params.functionDeclaration === SELECT_ALL) return { result: { type: "boolean", value: true } };
      if (command.params.functionDeclaration === FOCUSED) {
        const role = this.#objects.get(String(command.params.objectId));
        return { result: { type: "boolean", value: role !== undefined && role === this.#focused } };
      }
      if (command.params.functionDeclaration === HIT) {
        const [x, y] = (command.params.arguments as Array<{ value: number }>).map((arg) => arg.value);
        const role = this.#objects.get(String(command.params.objectId));
        return { result: { type: "boolean", value: role === "submit" && !this.covered && x === BUTTON_CENTRE.x && y === BUTTON_CENTRE.y } };
      }
      return undefined;
    });
    chain("DOM.focus", (command) => {
      this.#focused = this.#objects.get(String(command.params.objectId)) ?? null;
      return {};
    });
    chain("DOM.scrollIntoViewIfNeeded", () => ({}));
    chain("DOM.getBoxModel", (command) => {
      if (this.#objects.get(String(command.params.objectId)) !== "submit") return { model: { content: [0, 0, 10, 0, 10, 10, 0, 10] } };
      return { model: { content: BUTTON_QUAD, width: 200, height: 40 } };
    });
    chain("Input.insertText", (command) => {
      const text = String(command.params.text ?? "");
      this.inserted.push(text);
      // The field's former content was selected: the text replaces it.
      if (this.#focused === "login" || this.#focused === "password" || this.#focused === "code") this.fields[this.#focused] = text;
      return {};
    });
    chain("Input.dispatchMouseEvent", (command) => {
      const { type, x, y, button } = command.params as { type: string; x: number; y: number; button: string };
      if (type === "mouseReleased" && button === "left" && x === BUTTON_CENTRE.x && y === BUTTON_CENTRE.y && !this.covered) {
        this.presses += 1;
        void this.#pressed();
      }
      return {};
    });
    chain("Page.captureScreenshot", () => ({ data: Buffer.from(`FAKEJPEG:${this.screen}`).toString("base64") }));
    chain("Runtime.releaseObjectGroup", () => {
      this.#objects.clear();
      return {};
    });
  }

  /** What the probe reads now. */
  marks(): PageMarks {
    const form = (marks: Partial<FormMarks>): FormMarks => ({ password: 0, login: 0, code: 0, other: 0, submit: 1, error: this.error, ...marks });
    const base = { origin: "https://fansly.com", path: "/", readyState: "complete" };
    switch (this.screen) {
      case "landing":
        return { ...base, captcha: false, forms: [] };
      case "login":
        return { ...base, captcha: false, forms: [form({ password: 1, login: 1 })] };
      case "code":
        return { ...base, captcha: false, forms: [form({ code: 1 })] };
      case "success":
        return { ...base, path: "/home", captcha: false, forms: [] };
      case "captcha":
        return { ...base, captcha: true, forms: [form({ password: 1, login: 1 })] };
      case "consent":
        return { ...base, captcha: false, forms: [form({ password: 1, login: 1, other: 1 })] };
    }
  }

  #locate(role: string): string | null {
    if (this.screen === "login" && (role === "login" || role === "password" || role === "submit")) return role;
    if (this.screen === "code" && (role === "code" || role === "submit")) return role;
    return null;
  }

  #lastTab = "S1";

  /** The tab the site lives in. */
  #tab(): string {
    return this.#lastTab;
  }

  /** The site's work tab (the operator's). */
  setTab(sessionId: string): void {
    this.#lastTab = sessionId;
  }

  async #pressed(): Promise<void> {
    if (this.screen === "login") {
      const body = JSON.stringify({ username: this.fields.login, password: this.fields.password, deviceId: "fake-device-1" });
      const request = this.#model.pause("https://apiv3.fansly.com/api/v1/login", "POST", this.#tab(), "XHR", { Accept: "application/json, text/plain, */*", "content-type": "application/json" }, body);
      this.posts.push(request);
      if (!(await this.#ended(request))) {
        this.error = "Could not reach Fansly";
        return;
      }
      if (this.fields.login !== this.#options.login || this.fields.password !== this.#options.password) {
        this.error = "Invalid username or password";
        return;
      }
      this.error = null;
      this.fields.password = "";
      if (this.#options.code === null) this.#loggedIn();
      else this.screen = "code";
      return;
    }
    if (this.screen === "code") {
      const body = JSON.stringify({ token: "twofa-step-token", code: this.fields.code });
      const request = this.#model.pause("https://apiv3.fansly.com/api/v1/login/twofa", "POST", this.#tab(), "XHR", { Accept: "application/json, text/plain, */*", "content-type": "application/json" }, body);
      this.posts.push(request);
      if (!(await this.#ended(request))) {
        this.error = "Could not reach Fansly";
        return;
      }
      if (this.fields.code !== this.#options.code) {
        this.error = "Invalid code";
        return;
      }
      this.error = null;
      this.#loggedIn();
    }
  }

  /** Logged in: no form, and the site's own reads carry the new session. */
  #loggedIn(): void {
    this.screen = "success";
    const path = "/api/v1/account/me";
    const { token, clientId } = this.#options;
    this.#model.pause(`https://apiv3.fansly.com${path}`, "GET", this.#tab(), "XHR", {
      Accept: "application/json, text/plain, */*",
      authorization: token,
      "fansly-client-check": fanslyClientCheck(path, clientId),
      "fansly-client-id": clientId,
      "fansly-client-ts": String(Date.now()),
      "fansly-session-id": "720167541418239999",
    });
  }

  async #ended(request: ModelRequest): Promise<boolean> {
    const deadline = Date.now() + 15_000;
    while (Date.now() < deadline) {
      if (request.outcome === "failed" || request.outcome === "blocked_by_extension") return false;
      if (request.api?.ended === true) return true;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    return false;
  }
}
