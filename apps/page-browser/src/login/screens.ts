// The login screens (plan §4.8; spec §7): what the work tab shows, read from
// the operator's isolated world — the DOM the site's page shares, a JS realm
// its code never sees — and what it is: the login, the 2FA code, an error,
// the success, or a screen the operator does not know.
//
// - The signs are versioned (`SCREEN_VERSION`): a change of them is a new
//   version, and the form says which version read the screen. A screen whose
//   signs do not all match is unknown: the operator presses nothing on it and
//   the owner opens the screen (KasmVNC).
// - What is read never includes what a field holds: no `value`, no
//   selection, no text of an input — only whether fields are there, what
//   kind they are, whether one button would submit them, and the text the
//   site shows as its error. A captcha anywhere on the page makes it
//   unknown.
// - The same scan finds the elements the operator acts on (`LOCATE`): the
//   form it found unique, and in it the login or code field, the password
//   field, the one button that submits it. Before every press the screen is
//   read again (spec §7).
//
// Signs of version fansly-login/1. They were written from the site's public
// bundle (`POST /login {username, password, deviceId}`, `POST /login/twofa
// {token, code}`; 8-docs stage1/fansly-bundle-notes.md) and Angular's forms,
// not from the live login screen: stage 1, item 12 recorded the screens
// Fansly showed the test account (§9), not their DOM. They are checked on
// the test account before the pilot; until then a screen they miss is
// unknown — the owner's way in is the screen, never a guess.
//
// The success is not read from the DOM alone: no form of the login is shown
// and either the site loaded the account — its own `GET /account/me` under
// the live session answered 2xx (the manual login lets the interface's reads
// through, PR 15) — or its own API requests carry a session the page did not
// have when the manual login began (hub-requests/session.ts learns it from
// them as they stop), or its `POST /login/twofa` of this manual login was
// answered 2xx (the last step of the login of a page with 2FA, which all the
// agency's pages have). A page without a form after `POST /login` alone (a
// notice to check the e-mail, say) and no account loaded is unknown, never a
// success.

/** The version of the signs below. */
export const SCREEN_VERSION = "fansly-login/1";

/** The site whose screens these are. */
export const LOGIN_ORIGIN = "https://fansly.com";

export type LoginScreen = "login" | "code" | "error" | "success" | "unknown";
export type LoginField = "login" | "password" | "code";

/** One visible form of the page that holds a password or a code field. */
export interface FormMarks {
  /** Visible password fields. */
  password: number;
  /** Visible text-like fields that read as a login (user, e-mail). */
  login: number;
  /** Visible text-like fields that read as a code (one-time code, 2FA). */
  code: number;
  /** Other visible fields (not a checkbox, radio or button). */
  other: number;
  /** Visible, enabled buttons that would submit it. */
  submit: number;
  /** The text of the site's error in or next to it (trimmed, ≤ 300). */
  error: string | null;
}

/** What the probe reads of the page: never what a field holds. */
export interface PageMarks {
  /** The work tab's origin and path (no query, no fragment). */
  origin: string;
  path: string;
  readyState: string;
  /** A visible captcha or challenge frame anywhere on the page. */
  captcha: boolean;
  forms: FormMarks[];
}

export interface Recognized {
  screen: LoginScreen;
  fields: LoginField[];
  siteError: string | null;
  /** Why it is what it is (for the log; never a field's content). */
  why: string;
}

/** What the operator knows beside the page: the session
 *  (hub-requests/session.ts), the login operations' ends (intercept/). */
export interface SessionMarks {
  /** The site's live session now (null: none seen). */
  live: string | null;
  /** The live session when the manual login began. */
  atStart: string | null;
  /** The site's `POST /login/twofa` of this manual login went and was
   *  answered 2xx. */
  codeAccepted?: boolean;
  /** The session under which the site's own `GET /account/me` of this
   *  manual login was last answered 2xx (null: none). */
  accountLoaded?: string | null;
}

// The in-page scan, shared by the probe and the locator. Runs in the
// operator's isolated world: the page's DOM, none of its script.
const SCAN = String.raw`
  const doc = document;
  const visible = (el) => {
    if (!el || !el.isConnected) return false;
    const style = getComputedStyle(el);
    if (style.display === "none" || style.visibility === "hidden" || Number(style.opacity) === 0) return false;
    const box = el.getBoundingClientRect();
    return box.width > 0 && box.height > 0;
  };
  const kind = (el) => (el.getAttribute("type") || "").toLowerCase();
  const words = (el) => [el.getAttribute("name"), el.id, el.getAttribute("placeholder"), el.getAttribute("aria-label"), el.getAttribute("autocomplete"), el.getAttribute("formcontrolname")]
    .filter(Boolean).join(" ").toLowerCase();
  const TEXTLIKE = ["", "text", "email", "tel", "number"];
  const SKIPPED = ["hidden", "checkbox", "radio", "submit", "button", "image", "reset", "file"];
  const isCode = (el) => el.tagName === "INPUT" && TEXTLIKE.includes(kind(el))
    && (el.getAttribute("autocomplete") === "one-time-code" || /(^|[^a-z])(code|otp|2fa|twofa|two.?factor|authenticator|verification)([^a-z]|$)|код/.test(words(el)));
  const isLogin = (el) => el.tagName === "INPUT" && TEXTLIKE.includes(kind(el)) && !isCode(el)
    && /(^|[^a-z])(user(name)?|e-?mail|login|username_or_email)([^a-z]|$)|логин|почт/.test(words(el));
  const isPassword = (el) => el.tagName === "INPUT" && kind(el) === "password";
  const SUBMIT_TEXT = /^(log ?in|sign ?in|submit|verify|confirm|continue|next|войти|подтвердить|продолжить|отправить|далее)$/i;
  const text = (el) => (el.innerText || el.textContent || "").replace(/\s+/g, " ").trim();
  const containerOf = (el) => el.closest("form, [role=dialog], [role=alertdialog], .modal-content, .modal, mat-dialog-container") || doc.body;
  const fieldsIn = (root) => [...root.querySelectorAll("input, textarea, select")].filter((el) => !SKIPPED.includes(kind(el)) && visible(el));
  const submitsIn = (root) => [...root.querySelectorAll("button, input[type=submit], [role=button]")].filter((el) => {
    if (!visible(el) || el.disabled || el.getAttribute("aria-disabled") === "true") return false;
    // A submit input's label is its own attribute, never something typed.
    const label = el.tagName === "INPUT" ? (el.getAttribute("value") || "") : text(el);
    return SUBMIT_TEXT.test(label);
  });
  const ERRORS = "[role=alert], .error, .error-message, .errors, .text-danger, .alert-danger, .invalid-feedback, .form-error, mat-error";
  const errorOf = (root) => {
    const near = [...root.querySelectorAll(ERRORS)];
    if (root.parentElement) near.push(...[...root.parentElement.querySelectorAll(ERRORS)].filter((el) => !root.contains(el)));
    const shown = near.filter(visible).map(text).filter((t) => t.length > 0);
    return shown.length === 0 ? null : shown.join(" ").slice(0, 300);
  };
  const forms = () => {
    const roots = [];
    for (const el of doc.querySelectorAll("input")) {
      if (!visible(el) || !(isPassword(el) || isCode(el))) continue;
      const root = containerOf(el);
      if (!roots.includes(root)) roots.push(root);
    }
    return roots.map((root) => {
      const fields = fieldsIn(root);
      return {
        root,
        fields,
        password: fields.filter(isPassword),
        login: fields.filter(isLogin),
        code: fields.filter(isCode),
        other: fields.filter((el) => !isPassword(el) && !isLogin(el) && !isCode(el)),
        submit: submitsIn(root),
      };
    });
  };
  const CAPTCHA = /recaptcha|hcaptcha|challenges\.cloudflare\.com|turnstile|arkoselabs|funcaptcha|geetest/i;
  const captcha = () => [...doc.querySelectorAll("iframe")].some((frame) => visible(frame) && CAPTCHA.test(frame.getAttribute("src") || ""))
    || [...doc.querySelectorAll("[class*=captcha], [id*=captcha], [class*=challenge-], [data-sitekey]")].some(visible);
`;

/** The probe: the page's marks (`Runtime.evaluate`, returnByValue). */
export const PROBE = `(function pbLoginProbe() {
${SCAN}
  return {
    origin: location.origin,
    path: location.pathname,
    readyState: doc.readyState,
    captcha: captcha(),
    forms: forms().map((form) => ({
      password: form.password.length,
      login: form.login.length,
      code: form.code.length,
      other: form.other.length,
      submit: form.submit.length,
      error: errorOf(form.root),
    })),
  };
})()`;

/** The element of `role` in the one form the screen shows (null: not one
 *  such form, or not one such element): `Runtime.evaluate`, by reference. */
export function locateExpression(role: LoginField | "submit"): string {
  return `(function pbLoginLocate(role) {
${SCAN}
  const all = forms();
  if (captcha() || all.length !== 1) return null;
  const form = all[0];
  const one = (list) => (list.length === 1 ? list[0] : null);
  if (role === "submit") return one(form.submit);
  return one(form[role]);
})(${JSON.stringify(role)})`;
}

/** (x, y) → whether the element at that point of the viewport is this one
 *  or inside it (`Runtime.callFunctionOn` on the button). */
export const HIT = `function (x, y) {
  const hit = document.elementFromPoint(x, y);
  return !!hit && (hit === this || this.contains(hit));
}`;

// A press whose call may act no more between the press and its release
// (Astra's review of PR 15, round 2): let go where it clicks nothing, with
// every click and submit of the page stopped meanwhile, then checked.

/** The page's elements a click would act on. */
const CONTROL = `"a[href], button, input, select, textarea, label, summary, option, [role=button], [role=link], [role=checkbox], [role=radio], [role=menuitem], [role=tab], [role=switch], [onclick], [contenteditable]:not([contenteditable=false])"`;

/** A point of the viewport to let the press of this button go: its element
 *  is not the button nor in it, and neither it nor the nearest element
 *  around both (where the click of a press let go elsewhere goes) is in a
 *  control. Null: no such point (`Runtime.callFunctionOn` on the button). */
export const RELEASE_POINT = `function () {
  const CONTROL = ${CONTROL};
  const doc = this.ownerDocument;
  const view = doc.defaultView;
  const width = view.innerWidth;
  const height = view.innerHeight;
  const points = [[2, 2], [width - 3, 2], [2, height - 3], [width - 3, height - 3], [Math.floor(width / 2), 2], [Math.floor(width / 2), height - 3], [2, Math.floor(height / 2)], [width - 3, Math.floor(height / 2)]];
  for (const [x, y] of points) {
    const at = doc.elementFromPoint(x, y);
    if (!at || at === this || this.contains(at) || at.closest(CONTROL)) continue;
    let around = at;
    while (around && !around.contains(this)) around = around.parentElement;
    if (around && around.closest(CONTROL)) continue;
    return { x, y };
  }
  return null;
}`;

/** From now until `PRESS_UNDONE`: every click and submit of the page is
 *  stopped in its window's capture phase — its default (a button's submit)
 *  prevented, no listener after it — and counted, those on the button
 *  apart (`Runtime.callFunctionOn` on the button, in the isolated world:
 *  the page's script never sees it). */
export const HOLD_CLICKS = `function () {
  const view = this.ownerDocument.defaultView;
  const button = this;
  const seen = { clicks: 0, onButton: 0, submits: 0 };
  const stop = (event) => {
    if (event.type === "submit") seen.submits += 1;
    else {
      seen.clicks += 1;
      const target = event.target;
      if (target === button || (target instanceof Node && button.contains(target))) seen.onButton += 1;
    }
    event.preventDefault();
    event.stopImmediatePropagation();
  };
  const types = ["click", "auxclick", "dblclick", "submit"];
  for (const type of types) view.addEventListener(type, stop, true);
  globalThis.pbPressUndo = { seen, end: () => { for (const type of types) view.removeEventListener(type, stop, true); } };
  return true;
}`;

/** The press let go: the stop of `HOLD_CLICKS` ended, and what it saw —
 *  whether the button is still pressed (`:active`), the clicks that
 *  reached it, the submits. Null: nothing was held. */
export const PRESS_UNDONE = `function () {
  const undo = globalThis.pbPressUndo;
  globalThis.pbPressUndo = undefined;
  if (!undo) return null;
  undo.end();
  return { active: this.matches(":active"), onButton: undo.seen.onButton, submits: undo.seen.submits, clicks: undo.seen.clicks };
}`;

/** Whether this field is in the document and its focused element now
 *  (`Runtime.callFunctionOn` on the field, right before the text goes in). */
export const FOCUSED = `function () {
  return this.isConnected && this.ownerDocument.activeElement === this;
}`;

/** Selects what the field holds, so the text inserted next replaces it —
 *  read by nobody (`Runtime.callFunctionOn` on the field). */
export const SELECT_ALL = `function () {
  if (typeof this.select === "function") this.select();
  return true;
}`;

/** What the marks are: the screen, the fields the form shows, the site's
 *  error text. */
export function recognize(marks: PageMarks | null, session: SessionMarks): Recognized {
  const unknown = (why: string): Recognized => ({ screen: "unknown", fields: [], siteError: null, why });
  if (marks === null) return unknown("the work tab could not be read");
  if (marks.origin !== LOGIN_ORIGIN) return unknown("the work tab is not at the site");
  if (marks.captcha) return unknown("a captcha or a challenge is shown");
  if (marks.forms.length > 1) return unknown("more than one form of the login is shown");
  const form = marks.forms[0];
  if (form === undefined) {
    if (marks.readyState !== "complete") return unknown("the site is still loading");
    if (session.live !== null && session.accountLoaded === session.live) {
      return { screen: "success", fields: [], siteError: null, why: "no form of the login, and the site loaded the account under the live session" };
    }
    if (session.live !== null && session.live !== session.atStart) {
      return { screen: "success", fields: [], siteError: null, why: "no form of the login, and the site's requests carry a new session" };
    }
    if (session.codeAccepted === true) return { screen: "success", fields: [], siteError: null, why: "no form of the login, and the site's code was accepted" };
    return unknown(session.live === null ? "no form of the login and no new session" : "no form of the login, and the session is the one from before the manual login");
  }
  const loginForm = form.password === 1 && form.login === 1 && form.code === 0 && form.other === 0 && form.submit === 1;
  const codeForm = form.password === 0 && form.login === 0 && form.code === 1 && form.other === 0 && form.submit === 1;
  if (!loginForm && !codeForm) return unknown("a form whose fields are not those of the login or the code");
  const fields: LoginField[] = loginForm ? ["login", "password"] : ["code"];
  if (form.error !== null) return { screen: "error", fields, siteError: form.error, why: "the site shows an error at its form" };
  return { screen: loginForm ? "login" : "code", fields, siteError: null, why: loginForm ? "the login form" : "the code form" };
}
