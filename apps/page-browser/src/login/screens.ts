// The login screens (plan §4.8; spec §7): what the work tab shows, read from
// the operator's isolated world — the DOM the site's page shares, a JS realm
// its code never sees — and what it is: the login, the code (the 2FA code,
// or the one Fansly e-mailed for a login from a new device), an error, the
// success, or a screen the operator does not know.
//
// - The signs are versioned (`SCREEN_VERSION`): a change of them is a new
//   version, and the form says which version read the screen. A screen whose
//   signs do not all match is unknown: the operator presses nothing on it and
//   the owner opens the screen (KasmVNC).
// - What is read never includes what a field holds: no `value`, no
//   selection, no text of an input — only whether fields are there, what
//   kind they are, whether one button would submit them, the text the site
//   shows as its error, and whether the code form says it was sent to an
//   e-mail address (a yes or a no: never the address). A captcha anywhere on
//   the page makes it unknown.
// - The same scan finds the elements the operator acts on (`LOCATE`): the
//   form it found unique, and in it the login or code field, the password
//   field, the one button that submits it. Before every press the screen is
//   read again (spec §7).
//
// Signs of version fansly-login/2, from the site's public bundle
// (main.2e6b96097a4bb73b.js, the login modal `app-login-modal`; 8-docs
// stage1/fansly-bundle-notes.md) and Angular's forms, not from the live login
// screen: stage 1, item 12 recorded the screens Fansly showed the test
// account (§9), not their DOM. They are checked on the test account before
// the pilot; until then a screen they miss is unknown — the owner's way in is
// the screen, never a guess.
//
// - The login: `POST /login {username, password, deviceId}` from the
//   modal's form (`#fansly_login`, `#fansly_password`, «Sign in»).
// - The code: the same modal, its second state — one field `#fansly_twofa`
//   (`autocomplete="one-time-code"`), «Verify» — sent by `POST /login/twofa
//   {token, code}`. `/login` answers it with `twofa` instead of a session,
//   and its type 2 is the e-mail code of a login from a new device (owner
//   decision 2026-10-15: open in the manual login only): above the field the
//   site says «Login from a new device … we have sent a verification code to
//   the following email address: <the address>». The same field, the same
//   button, the same request: what differs is where the owner finds the
//   code, so the screen is the code with `codeFrom: "email"`.
// - Fansly's buttons are `app-button`: its template is a `div` with the click
//   handler, no `<button>`; the one shown while the site waits has the class
//   `disabled`. The site's error at its form is `.auth-field-error`.
//
// The success is not read from the DOM alone: no form of the login is shown
// and either the site loaded the account — its own `GET /account/me` under
// the live session answered 2xx (the manual login lets the interface's reads
// through, PR 15) — or its own API requests carry a session the page did not
// have when the manual login began (hub-requests/session.ts learns it from
// them as they stop), or its `POST /login/twofa` of this manual login was
// answered 2xx (the last step of a login with a code: the 2FA code, or the
// e-mail code of a new device). A page without a form after `POST /login`
// alone and no account loaded is unknown, never a success.

/** The version of the signs below. */
export const SCREEN_VERSION = "fansly-login/2";

/** The site whose screens these are. */
export const LOGIN_ORIGIN = "https://fansly.com";

export type LoginScreen = "login" | "code" | "error" | "success" | "unknown";
export type LoginField = "login" | "password" | "code";
/** Where the code the site asks for comes from: "email" — Fansly e-mailed it
 *  for a login from a new device; null — the page's 2FA code. */
export type CodeFrom = "email" | null;

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
  /** It shows the site's notice of a login from a new device: an e-mail
   *  address (where the code went) or the notice's title. Never the text. */
  newDevice: boolean;
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
  /** The code's source on a code form (its screen or its error). */
  codeFrom: CodeFrom;
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
  // Fansly's own button is an app-button: a div with the click handler in it.
  const submitsIn = (root) => [...root.querySelectorAll("button, input[type=submit], [role=button], app-button")].filter((el) => {
    if (!visible(el) || el.disabled || el.getAttribute("aria-disabled") === "true" || el.classList.contains("disabled")) return false;
    // A submit input's label is its own attribute, never something typed.
    const label = el.tagName === "INPUT" ? (el.getAttribute("value") || "") : text(el);
    return SUBMIT_TEXT.test(label);
  });
  const ERRORS = "[role=alert], .error, .error-message, .errors, .text-danger, .alert-danger, .invalid-feedback, .form-error, mat-error, .auth-field-error";
  const errorOf = (root) => {
    const near = [...root.querySelectorAll(ERRORS)];
    if (root.parentElement) near.push(...[...root.parentElement.querySelectorAll(ERRORS)].filter((el) => !root.contains(el)));
    const shown = near.filter(visible).map(text).filter((t) => t.length > 0);
    return shown.length === 0 ? null : shown.join(" ").slice(0, 300);
  };
  // The notice of a login from a new device: the address the code went to
  // (something@something), or its title as the site's en_US and ru say it.
  const NEW_DEVICE = /[^\s@]@[^\s@]|login from a new device|вход в систему с нового устройства/i;
  const newDevice = (root) => NEW_DEVICE.test(text(root));
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
      newDevice: newDevice(form.root),
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
  const unknown = (why: string): Recognized => ({ screen: "unknown", fields: [], siteError: null, codeFrom: null, why });
  if (marks === null) return unknown("the work tab could not be read");
  if (marks.origin !== LOGIN_ORIGIN) return unknown("the work tab is not at the site");
  if (marks.captcha) return unknown("a captcha or a challenge is shown");
  if (marks.forms.length > 1) return unknown("more than one form of the login is shown");
  const form = marks.forms[0];
  if (form === undefined) {
    if (marks.readyState !== "complete") return unknown("the site is still loading");
    if (session.live !== null && session.accountLoaded === session.live) {
      return { screen: "success", fields: [], siteError: null, codeFrom: null, why: "no form of the login, and the site loaded the account under the live session" };
    }
    if (session.live !== null && session.live !== session.atStart) {
      return { screen: "success", fields: [], siteError: null, codeFrom: null, why: "no form of the login, and the site's requests carry a new session" };
    }
    if (session.codeAccepted === true) return { screen: "success", fields: [], siteError: null, codeFrom: null, why: "no form of the login, and the site's code was accepted" };
    return unknown(session.live === null ? "no form of the login and no new session" : "no form of the login, and the session is the one from before the manual login");
  }
  const loginForm = form.password === 1 && form.login === 1 && form.code === 0 && form.other === 0 && form.submit === 1;
  const codeForm = form.password === 0 && form.login === 0 && form.code === 1 && form.other === 0 && form.submit === 1;
  if (!loginForm && !codeForm) return unknown("a form whose fields are not those of the login or the code");
  const fields: LoginField[] = loginForm ? ["login", "password"] : ["code"];
  // The code form under the notice of a new device: the code Fansly e-mailed.
  const codeFrom: CodeFrom = codeForm && form.newDevice ? "email" : null;
  if (form.error !== null) return { screen: "error", fields, siteError: form.error, codeFrom, why: "the site shows an error at its form" };
  if (loginForm) return { screen: "login", fields, siteError: null, codeFrom, why: "the login form" };
  return { screen: "code", fields, siteError: null, codeFrom, why: codeFrom === "email" ? "the code form of a login from a new device" : "the code form" };
}
