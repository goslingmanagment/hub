import { afterAll, beforeAll, describe, expect, it } from "vitest";

import type { CdpPort } from "../apps/page-browser/src/cdp/client.ts";
import { LoginDesk, marksOf } from "../apps/page-browser/src/login/desk.ts";
import { locateExpression, PROBE, recognize, type PageMarks } from "../apps/page-browser/src/login/screens.ts";

// The login desk's probe and locator (spec §7; signs fansly-login/2) in a
// real Chrome, over Fansly's login modal as its public bundle builds it
// (main.2e6b96097a4bb73b.js, `app-login-modal`: its classes, ids and
// attributes; its texts in en_US): the login, the 2FA code, the code Fansly
// e-mails for a login from a new device (owner decision 2026-10-15), the
// site's error — and the site's other windows that ask for a password or a
// code, which are no login (Astra's review of the e-mail code, P1): the
// login desk itself, over CDP, types and presses nothing there. Static
// pages served at the site's origin by the test (Playwright's route): no
// network. Runs where a Chrome is present (Playwright's own, or the
// machine's); skips where none is.

type CdpSession = { send(method: string, params?: Record<string, unknown>): Promise<unknown> };
type Route = { fulfill(response: { status: number; contentType: string; body: string }): Promise<void> };
type Page = {
  route(url: string, handler: (route: Route) => Promise<void>): Promise<void>;
  goto(url: string): Promise<unknown>;
  evaluate<T>(expression: string): Promise<T>;
  fill(selector: string, value: string): Promise<void>;
  context(): { newCDPSession(page: Page): Promise<CdpSession> };
};
type Browser = { newPage(): Promise<Page>; close(): Promise<void> };

const RUNTIME_PLAYWRIGHT = "../apps/runtime/node_modules/playwright/index.mjs";

async function launch(): Promise<Browser | null> {
  let chromium: { launch(options?: Record<string, unknown>): Promise<Browser> };
  try {
    ({ chromium } = await import(RUNTIME_PLAYWRIGHT) as { chromium: typeof chromium });
  } catch {
    return null;
  }
  for (const options of [{}, { channel: "chrome" }]) {
    try {
      return await chromium.launch({ headless: true, ...options });
    } catch (error) {
      if (!/Executable doesn't exist|playwright install|Chromium distribution 'chrome' is not found/i.test(String(error))) throw error;
    }
  }
  return null;
}

/** A page: what is clicked and typed in it counted by the page itself. */
const pageOf = (body: string) => `<!doctype html><html><body>${body}
<script>window.clicks = 0; document.addEventListener("click", () => { window.clicks += 1; }, true);</script></body></html>`;

/** The login modal as the modal service makes it: its host element
 *  (`createComponent`, the selector's tag), its frame; `content` is
 *  `.modal-content`'s. `host: false` — the same markup in no login window. */
const modalMarkup = (content: string, host = true) => `${host ? "<app-login-modal>" : "<div>"}<div class="modal login-modal-v2">
  <div class="modal-header"><div class="brand"></div><i class="fa-fw fal fa-xmark pointer blue-1-hover-only close-x"></i></div>
  <div class="modal-content">${content}</div>
</div>${host ? "</app-login-modal>" : "</div>"}`;
const modal = (content: string) => pageOf(modalMarkup(content));

/** The notice above the code field when `/login` answered `twofa` of type 2. */
const NEW_DEVICE = `<div>
  <div class="text-center margin-top-1"><xd-localization-string class="bold">Login from a new device </xd-localization-string></div>
  <div class="tooltip margin-top-2"><i class="fa-fw fal fa-circle-question dark-blue-1"></i>
    <div class="tooltiptext right-0"><xd-localization-string> Its important to verify new device logins to make sure the purchased media and your payment information stays secured.</xd-localization-string></div></div>
  <div class="text-center margin-top-2"><xd-localization-string>In order to verify your identity, we have sent a verification code to the following email address:</xd-localization-string><br> owner@example.com </div>
</div>`;

/** The modal's second state: the code. */
const codeContent = (options: { newDevice: boolean; error?: string }) => `
<div class="login-form">
  ${options.newDevice ? NEW_DEVICE : ""}
  <div class="material-input margin-top-2">
    <input autocapitalize="none" autocomplete="one-time-code" autocorrect="off" spellcheck="false" type="text" placeholder="Enter 2FA code" id="fansly_twofa">
    <div class="label"> 2FA Code </div>
    <div class="placeholder"><xd-localization-string>Enter 2FA Code </xd-localization-string></div>
  </div>
  ${options.error ? `<div class="auth-field-error"><xd-localization-string>${options.error}</xd-localization-string></div>` : ""}
</div>
<app-button data-menu-item="login" clickonenter="true" class="btn v2 solid-blue auth-submit"><div><xd-localization-string>Verify</xd-localization-string></div></app-button>`;
const codeState = (options: { newDevice: boolean; error?: string }) => modal(codeContent(options));

/** 2FA for an account action (`app-twofa-session-create-modal`): the same
 *  field and button as the login's code, no login. */
const TWOFA_SESSION = `<app-twofa-session-create-modal><div class="modal v2">
  <div class="modal-header"><div class="title">2FA Verification Required</div><div class="actions"><app-icon class="pointer blue-1-hover-only"></app-icon></div></div>
  <div class="modal-body">
    <div class="twofa-intro"> Certain account actions require 2FA authentication for increased security. We have sent you a verification code to o•••@example.com. </div>
    <div class="material-input v2">
      <input autocapitalize="none" autocomplete="one-time-code" autocorrect="off" spellcheck="false" type="text" id="fansly_twofa" required>
      <div class="label"><xd-localization-string>Enter 2FA Code</xd-localization-string></div>
      <div class="placeholder"><xd-localization-string>Enter 2FA Code</xd-localization-string></div>
    </div>
  </div>
  <div class="modal-footer"><div class="btn v2 text"><xd-localization-string>Cancel</xd-localization-string></div>
    <app-button clickonenter="true"><div class="btn v2 solid-blue"><xd-localization-string>Verify</xd-localization-string></div></app-button></div>
</div></app-twofa-session-create-modal>`;

/** The address change in the settings (`app-email-change-new-modal`), its
 *  first step and its second (the code from the old address, the new one). */
const emailChange = (step: 1 | 2) => `<app-email-change-new-modal><div class="modal v2">
  <div class="modal-header"><div class="title"><xd-localization-string>Change Email</xd-localization-string></div></div>
  <div class="modal-body">${step === 1
    ? `<div class="modal-intro"><xd-localization-string>Please enter your password.</xd-localization-string></div>
    <div class="material-input v2"><input type="password" required><div class="placeholder">Enter Current Password</div><div class="label">Current Password</div></div>`
    : `<div class="modal-intro"><xd-localization-string>We have sent you a verification email to your current email, please enter the code and your new email below.</xd-localization-string></div>
    <div class="material-input v2"><input type="number" placeholder="Enter Code"><div class="label">Verification Code</div></div>
    <div class="material-input v2"><input type="text" required><div class="placeholder">Enter New Email</div><div class="label">New Email</div></div>`}</div>
  <div class="modal-footer"><div class="btn v2 text">Cancel</div><app-button clickonenter="true"><div class="btn v2 solid-blue"><xd-localization-string>Next</xd-localization-string></div></app-button></div>
</div></app-email-change-new-modal>`;

/** The modal's first state: the login (`loading` — the button while it waits). */
const loginState = (options: { loading: boolean }) => modal(`
<div class="login-form">
  <div class="user-name"><div class="material-input">
    <input autocapitalize="none" autocomplete="username" autocorrect="off" spellcheck="false" type="text" required id="fansly_login">
    <div class="placeholder"><xd-localization-string>Enter username or email </xd-localization-string></div>
    <div class="label"><xd-localization-string>Username or email </xd-localization-string></div>
  </div></div>
  <div class="password"><div class="material-input">
    <input autocapitalize="none" autocomplete="password" autocorrect="off" spellcheck="false" type="password" required id="fansly_password">
  </div></div>
  <div class="remember-forget noselect"><div class="forgot pointer"><xd-localization-string>Forgot password? </xd-localization-string></div></div>
  ${options.loading
    ? `<app-button data-menu-item="login" class="btn v2 solid-blue auth-submit disabled"><div><i class="fa-fw fas fa-circle-notch fa-spin margin-right-text"></i><xd-localization-string>Sign In</xd-localization-string></div></app-button>`
    : `<app-button data-menu-item="login" clickonenter="true" class="btn v2 solid-blue auth-submit"><div><xd-localization-string>Sign in</xd-localization-string></div></app-button>`}
  <div class="or-divider social-seperator"><xd-localization-string>Or</xd-localization-string></div>
  <div class="oauth-row"><div data-menu-item="login" class="oauth-btn login-provider Google" title="Sign in with Google"></div></div>
  <div class="disclaimer"><xd-localization-string>By logging in, you agree to our</xd-localization-string> <a href="#">Terms &amp; Conditions</a></div>
</div>`);

let browser: Browser | null = null;
let page: Page | null = null;

/** What https://fansly.com/ answers now: the test's page, nothing else. */
let shown = "";

beforeAll(async () => {
  browser = await launch();
  page = (await browser?.newPage()) ?? null;
  await page?.route("**/*", async (route) => route.fulfill({ status: 200, contentType: "text/html", body: shown }));
}, 60_000);

/** The work tab at the site, showing `html`. */
async function show(html: string): Promise<void> {
  shown = html;
  await page!.goto("https://fansly.com/");
}

afterAll(async () => {
  await browser?.close();
});

async function probe(html: string): Promise<PageMarks> {
  await show(html);
  const marks = marksOf(await page!.evaluate<unknown>(PROBE))!;
  expect(marks.origin).toBe("https://fansly.com");
  return marks;
}

/** The tag of the element the locator finds for `role` (null: none). */
async function located(role: "login" | "password" | "code" | "submit" | "open"): Promise<string | null> {
  return page!.evaluate<string | null>(`(() => { const el = ${locateExpression(role)}; return el ? el.tagName.toLowerCase() + (el.id ? "#" + el.id : "") : null; })()`);
}

const none = { live: null, atStart: null };

describe("the probe over Fansly's login modal, in Chrome (signs fansly-login/2)", () => {
  it("the code of a new device's login: the code form, its source the e-mail — and Fansly's app-button its one button", async (context) => {
    if (page === null) return context.skip();
    const marks = await probe(codeState({ newDevice: true }));
    expect(marks.forms).toEqual([{ password: 0, login: 0, code: 1, other: 0, submit: 1, error: null, newDevice: true }]);
    expect(recognize(marks, none)).toMatchObject({ screen: "code", fields: ["code"], codeFrom: "email" });
    expect(await located("code")).toBe("input#fansly_twofa");
    expect(await located("submit")).toBe("app-button");
    // Nothing of the notice comes out: a yes or a no, never the address.
    expect(JSON.stringify(marks)).not.toContain("example.com");
  });

  it("its wrong code: the site's error at the form, still the e-mail's code", async (context) => {
    if (page === null) return context.skip();
    const marks = await probe(codeState({ newDevice: true, error: "2FA code is invalid or already used. " }));
    expect(marks.forms).toEqual([{ password: 0, login: 0, code: 1, other: 0, submit: 1, error: "2FA code is invalid or already used.", newDevice: true }]);
    expect(recognize(marks, none)).toMatchObject({ screen: "error", siteError: "2FA code is invalid or already used.", codeFrom: "email" });
  });

  it("the 2FA code: no notice — and what is typed in the field counts for nothing, nor comes out", async (context) => {
    if (page === null) return context.skip();
    await show(codeState({ newDevice: false }));
    await page!.fill("#fansly_twofa", "someone@example.org");
    const marks = marksOf(await page!.evaluate<unknown>(PROBE))!;
    expect(marks.forms).toEqual([{ password: 0, login: 0, code: 1, other: 0, submit: 1, error: null, newDevice: false }]);
    expect(recognize(marks, none)).toMatchObject({ screen: "code", codeFrom: null });
    expect(JSON.stringify(marks)).not.toContain("example.org");
  });

  it("the login: its two fields and «Sign in»; while the site waits its button is disabled — no button, an unknown screen", async (context) => {
    if (page === null) return context.skip();
    const marks = await probe(loginState({ loading: false }));
    expect(marks.forms).toEqual([{ password: 1, login: 1, code: 0, other: 0, submit: 1, error: null, newDevice: false }]);
    expect(recognize(marks, none)).toMatchObject({ screen: "login", fields: ["login", "password"], codeFrom: null });
    expect(await located("submit")).toBe("app-button");
    const waiting = await probe(loginState({ loading: true }));
    expect(waiting.forms[0]).toMatchObject({ submit: 0 });
    expect(recognize(waiting, none).screen).toBe("unknown");
  });

  it("another window that asks for a code or a password is no screen of the login: unknown, nothing located — alone, beside the login window, or the login's markup out of it (Astra's review, P1)", async (context) => {
    if (page === null) return context.skip();
    const foreign = {
      "2FA of an account action": pageOf(TWOFA_SESSION),
      "the address change, its password": pageOf(emailChange(1)),
      "the address change, its code": pageOf(emailChange(2)),
      "the login's code beside the 2FA of an account action": pageOf(`${modalMarkup(codeContent({ newDevice: false }))}${TWOFA_SESSION}`),
      "the login's code out of the login window": pageOf(modalMarkup(codeContent({ newDevice: true }), false)),
    };
    for (const [what, html] of Object.entries(foreign)) {
      const marks = await probe(html);
      expect(recognize(marks, none).screen, what).toBe("unknown");
      for (const role of ["login", "password", "code", "submit"] as const) expect(await located(role), `${what}: ${role}`).toBeNull();
    }
    // Beside another window the login window's own form is still read, and
    // the other window's field is what makes the screen unknown.
    const beside = await probe(foreign["the login's code beside the 2FA of an account action"]);
    expect(beside).toMatchObject({ outside: true, forms: [{ code: 1, submit: 1 }] });
  });
});

/** The login desk over this Chrome's CDP (cdp/client.ts's port): the
 *  operator's isolated world in the page's document, its real steps. */
async function deskOver(): Promise<LoginDesk> {
  const client = await page!.context().newCDPSession(page!);
  const tree = await client.send("Page.getFrameTree") as { frameTree: { frame: { id: string } } };
  const world = (await client.send("Page.createIsolatedWorld", { frameId: tree.frameTree.frame.id, worldName: "pb-login-test" }) as { executionContextId: number }).executionContextId;
  const cdp: CdpPort = {
    send: <T>(method: string, params: Record<string, unknown> = {}) => client.send(method, params) as Promise<T>,
    on: () => undefined,
    ack: () => undefined,
    holdAcks: () => undefined,
  };
  return new LoginDesk({ cdp, tab: () => "work-tab", world: () => Promise.resolve(world), session: () => null, discard: () => Promise.resolve(), timings: { settleMs: 200, pollMs: 50 }, log: () => undefined });
}

describe("the login desk over Fansly's windows, in Chrome (Astra's review of the e-mail code, P1)", () => {
  const typed = () => page!.evaluate<string[]>(`[...document.querySelectorAll("input")].map((el) => el.value)`);
  const clicks = () => page!.evaluate<number>("window.clicks");

  it("types the e-mail's code into the login window and presses its «Verify» — once", async (context) => {
    if (page === null) return context.skip();
    await show(codeState({ newDevice: true }));
    const desk = await deskOver();
    desk.begin();
    expect(await desk.code("482913", () => null)).toMatchObject({ kind: "state", screen: "code", codeFrom: "email" });
    expect(await typed()).toEqual(["482913"]);
    expect(await clicks()).toBe(1);
  });

  it("types and presses nothing in another window that asks for a code or a password", async (context) => {
    if (page === null) return context.skip();
    for (const html of [pageOf(TWOFA_SESSION), pageOf(emailChange(2)), pageOf(`${modalMarkup(codeContent({ newDevice: false }))}${TWOFA_SESSION}`)]) {
      await show(html);
      const desk = await deskOver();
      desk.begin();
      expect(await desk.code("482913", () => null)).toEqual({ kind: "refused", reason: "screen_changed" });
      expect(await desk.submit("someone", "pw-marker", () => null)).toEqual({ kind: "refused", reason: "screen_changed" });
      expect((await typed()).every((value) => value === "")).toBe(true);
      expect(await clicks()).toBe(0);
    }
  });
});


// Public main.1c19146fbffb67a3.js (2026-10-15): the two div.btn actions in
// .right-content call openLoginModal(0) and openLoginModal(1). The Login
// action has no input field. Render locally; every request is fulfilled.
const LANDING = `<app-landing-page-new style="display:flex;width:100%;min-height:500px">
  <div class="right-content"><div class="btn solid-blue large" data-menu-item="login"><xd-localization-string>Sign up</xd-localization-string></div>
  <div class="btn solid-blue large" data-menu-item="login" id="open-login"><xd-localization-string>Login</xd-localization-string></div></div>
</app-landing-page-new>`;

describe("the current public landing, before the login modal", () => {
  it("recognizes and locates only Login, then re-probes the locally opened modal", async (context) => {
    if (!page) { context.skip(); return; }
    const marks = await probe(pageOf(LANDING));
    expect(marks.landing).toEqual({ roots: 1, login: 1, windows: 0 });
    expect(recognize(marks, { live: null, atStart: null }).screen).toBe("landing");
    expect(await located("open")).toBe("div#open-login");
    for (const role of ["login", "password", "code", "submit"] as const) expect(await located(role)).toBeNull();
    await show(pageOf(LANDING + `<script>document.getElementById("open-login").addEventListener("click", () => { document.body.innerHTML = ${JSON.stringify(loginState({ loading: false })).replace(/</g, "\\u003c")}; });</script>`));
    const desk = await deskOver(); desk.begin();
    expect(await desk.open(() => null)).toMatchObject({ kind: "state", screen: "login", fields: ["login", "password"] });
    expect(await page!.evaluate("window.clicks")).toBe(1);
    expect(await page!.evaluate('[...document.querySelectorAll("input")].map((el) => el.value)')).toEqual(["", ""]);
  });
  it("refuses duplicate Login actions, a modal or challenge, and a Login button outside the landing", async (context) => {
    if (!page) { context.skip(); return; }
    for (const html of [
      LANDING.replace('</div></div>', '<div class="btn" data-menu-item="login">Login</div></div>'),
      LANDING + '<div class="modal">Another modal</div>',
      LANDING + '<div class="captcha">Challenge</div>',
      '<div class="right-content"><div class="btn" data-menu-item="login">Login</div></div>',
    ]) {
      const marks = await probe(pageOf(html));
      expect(recognize(marks, { live: null, atStart: null }).screen).toBe("unknown");
      expect(await located("open")).toBeNull();
    }
  });
});
