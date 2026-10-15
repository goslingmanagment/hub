import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { marksOf } from "../apps/page-browser/src/login/desk.ts";
import { locateExpression, PROBE, recognize, type PageMarks } from "../apps/page-browser/src/login/screens.ts";

// The login desk's probe and locator (spec §7; signs fansly-login/2) in a
// real Chrome, over Fansly's login modal as its public bundle builds it
// (main.2e6b96097a4bb73b.js, `app-login-modal`: its classes, ids and
// attributes; its texts in en_US): the login, the 2FA code, the code Fansly
// e-mails for a login from a new device (owner decision 2026-10-15), the
// site's error. Static pages, no network. Runs where a Chrome is present
// (Playwright's own, or the machine's); skips where none is.

type Page = { setContent(html: string): Promise<void>; evaluate<T>(expression: string): Promise<T>; fill(selector: string, value: string): Promise<void> };
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

/** The modal's frame; `content` is `.modal-content`'s. */
const modal = (content: string) => `<!doctype html><html><body>
<div class="modal login-modal-v2">
  <div class="modal-header"><div class="brand"></div><i class="fa-fw fal fa-xmark pointer blue-1-hover-only close-x"></i></div>
  <div class="modal-content">${content}</div>
</div></body></html>`;

/** The notice above the code field when `/login` answered `twofa` of type 2. */
const NEW_DEVICE = `<div>
  <div class="text-center margin-top-1"><xd-localization-string class="bold">Login from a new device </xd-localization-string></div>
  <div class="tooltip margin-top-2"><i class="fa-fw fal fa-circle-question dark-blue-1"></i>
    <div class="tooltiptext right-0"><xd-localization-string> Its important to verify new device logins to make sure the purchased media and your payment information stays secured.</xd-localization-string></div></div>
  <div class="text-center margin-top-2"><xd-localization-string>In order to verify your identity, we have sent a verification code to the following email address:</xd-localization-string><br> owner@example.com </div>
</div>`;

/** The modal's second state: the code. */
const codeState = (options: { newDevice: boolean; error?: string }) => modal(`
<div class="login-form">
  ${options.newDevice ? NEW_DEVICE : ""}
  <div class="material-input margin-top-2">
    <input autocapitalize="none" autocomplete="one-time-code" autocorrect="off" spellcheck="false" type="text" placeholder="Enter 2FA code" id="fansly_twofa">
    <div class="label"> 2FA Code </div>
    <div class="placeholder"><xd-localization-string>Enter 2FA Code </xd-localization-string></div>
  </div>
  ${options.error ? `<div class="auth-field-error"><xd-localization-string>${options.error}</xd-localization-string></div>` : ""}
</div>
<app-button data-menu-item="login" clickonenter="true" class="btn v2 solid-blue auth-submit"><div><xd-localization-string>Verify</xd-localization-string></div></app-button>`);

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

beforeAll(async () => {
  browser = await launch();
  page = (await browser?.newPage()) ?? null;
}, 60_000);

afterAll(async () => {
  await browser?.close();
});

async function probe(html: string): Promise<PageMarks> {
  await page!.setContent(html);
  return marksOf(await page!.evaluate<unknown>(PROBE))!;
}

/** The tag of the element the locator finds for `role` (null: none). */
async function located(role: "login" | "password" | "code" | "submit"): Promise<string | null> {
  return page!.evaluate<string | null>(`(() => { const el = ${locateExpression(role)}; return el ? el.tagName.toLowerCase() + (el.id ? "#" + el.id : "") : null; })()`);
}

const none = { live: null, atStart: null };

describe("the probe over Fansly's login modal, in Chrome (signs fansly-login/2)", () => {
  it("the code of a new device's login: the code form, its source the e-mail — and Fansly's app-button its one button", async (context) => {
    if (page === null) return context.skip();
    const marks = await probe(codeState({ newDevice: true }));
    expect(marks.forms).toEqual([{ password: 0, login: 0, code: 1, other: 0, submit: 1, error: null, newDevice: true }]);
    expect(recognize({ ...marks, origin: "https://fansly.com" }, none)).toMatchObject({ screen: "code", fields: ["code"], codeFrom: "email" });
    expect(await located("code")).toBe("input#fansly_twofa");
    expect(await located("submit")).toBe("app-button");
    // Nothing of the notice comes out: a yes or a no, never the address.
    expect(JSON.stringify(marks)).not.toContain("example.com");
  });

  it("its wrong code: the site's error at the form, still the e-mail's code", async (context) => {
    if (page === null) return context.skip();
    const marks = await probe(codeState({ newDevice: true, error: "2FA code is invalid or already used. " }));
    expect(marks.forms).toEqual([{ password: 0, login: 0, code: 1, other: 0, submit: 1, error: "2FA code is invalid or already used.", newDevice: true }]);
    expect(recognize({ ...marks, origin: "https://fansly.com" }, none)).toMatchObject({ screen: "error", siteError: "2FA code is invalid or already used.", codeFrom: "email" });
  });

  it("the 2FA code: no notice — and what is typed in the field counts for nothing, nor comes out", async (context) => {
    if (page === null) return context.skip();
    await page!.setContent(codeState({ newDevice: false }));
    await page!.fill("#fansly_twofa", "someone@example.org");
    const marks = marksOf(await page!.evaluate<unknown>(PROBE))!;
    expect(marks.forms).toEqual([{ password: 0, login: 0, code: 1, other: 0, submit: 1, error: null, newDevice: false }]);
    expect(recognize({ ...marks, origin: "https://fansly.com" }, none)).toMatchObject({ screen: "code", codeFrom: null });
    expect(JSON.stringify(marks)).not.toContain("example.org");
  });

  it("the login: its two fields and «Sign in»; while the site waits its button is disabled — no button, an unknown screen", async (context) => {
    if (page === null) return context.skip();
    const marks = await probe(loginState({ loading: false }));
    expect(marks.forms).toEqual([{ password: 1, login: 1, code: 0, other: 0, submit: 1, error: null, newDevice: false }]);
    expect(recognize({ ...marks, origin: "https://fansly.com" }, none)).toMatchObject({ screen: "login", fields: ["login", "password"], codeFrom: null });
    expect(await located("submit")).toBe("app-button");
    const waiting = await probe(loginState({ loading: true }));
    expect(waiting.forms[0]).toMatchObject({ submit: 0 });
    expect(recognize({ ...waiting, origin: "https://fansly.com" }, none).screen).toBe("unknown");
  });
});
