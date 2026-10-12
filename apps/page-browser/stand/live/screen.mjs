// The login on the owner's behalf (at his request): a headless browser on
// the Mac opens the page's KasmVNC screen — the same path the owner's own
// browser takes — and types into Fansly's form there. Fansly's Chrome on the
// server gets ordinary X input from KasmVNC; nothing controls it but the
// operator.
//
// Secrets: one JSON line on stdin — {"email", "password", "vnc"} — read once
// and kept in memory only. Never printed, never in an argument or the
// environment. No tracing, video, HAR or Playwright debug log: the driver
// refuses to start if DEBUG or PWDEBUG is set.
//
// Commands come over a Unix socket in a fresh private directory (0700; its
// path is printed at the start) — no TCP port, so no other user and no web
// page can reach it — one at a time, in order. Screenshots are refused from
// the first typed character until the driver exits; the earlier ones are
// deleted at the exit (Astra review 14, finding 1).
//
//   <secrets> | PLAYWRIGHT_MODULE=… CHROMIUM_PATH=… node stand/live/screen.mjs
//   curl -s --unix-socket <socket> http://x/shot
// Commands:
//   /shot                 → path of a screenshot (refused once typing began)
//   /click?x=…&y=…        a click at screen coordinates (1920×1080, 1:1)
//   /key?k=Tab            a key (Playwright names)
//   /type?name=email      types that secret, 80–170 ms per character
//   /quit
// The order of the login (RUNBOOK): check the screen; click the e-mail
// field; Tab and a screenshot — the password field holds the focus, the
// form is still empty; Shift+Tab and a screenshot — back on the e-mail
// field; type the e-mail, Tab, type the password, Enter. The identity read
// confirms the login; no screenshot after the first character.

import { createServer } from "node:http";
import { mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

if (process.env.DEBUG || process.env.PWDEBUG) throw new Error("DEBUG/PWDEBUG set: the driver would log its input");
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE ?? "playwright");

const input = await new Promise((resolve) => {
  let s = "";
  process.stdin.on("data", (d) => (s += d));
  process.stdin.on("end", () => resolve(s));
});
const secrets = JSON.parse(input);
for (const key of ["email", "password", "vnc"]) if (typeof secrets[key] !== "string" || secrets[key] === "") throw new Error(`no ${key} on stdin`);

const DIR = mkdtempSync(join(tmpdir(), "pb-screen-"));
if ((statSync(DIR).mode & 0o077) !== 0) throw new Error("the driver's directory is not private");
const SOCKET = join(DIR, "control.sock");
const browser = await chromium.launch({ headless: true, ...(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {}) });
const context = await browser.newContext({ viewport: { width: 1920, height: 1080 }, httpCredentials: { username: "owner", password: secrets.vnc } });
const page = await context.newPage();
await page.goto(process.env.SCREEN_URL ?? "http://127.0.0.1:16901/", { waitUntil: "load" });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let shots = 0;
let typing = false;
async function handle(url) {
  const q = (k) => url.searchParams.get(k);
  switch (url.pathname) {
    case "/shot": {
      if (typing) return [403, "no screenshots once typing began"];
      const path = join(DIR, `${String(++shots).padStart(2, "0")}.png`);
      await page.screenshot({ path });
      return [200, path];
    }
    case "/click":
      await page.mouse.click(Number(q("x")), Number(q("y")));
      return [200, "ok"];
    case "/key":
      await page.keyboard.press(String(q("k")));
      return [200, "ok"];
    case "/type": {
      const name = q("name");
      if (name !== "email" && name !== "password") return [400, "no such field"];
      typing = true;
      for (const ch of secrets[name]) {
        await page.keyboard.type(ch);
        await sleep(80 + Math.random() * 90);
      }
      return [200, `typed ${secrets[name].length} characters`];
    }
    case "/quit":
      return [200, "bye"];
    default:
      return [404, "?"];
  }
}

// One command at a time, in the order they came.
let queue = Promise.resolve();
const server = createServer((req, res) => {
  const url = new URL(req.url, "http://x");
  queue = queue.then(async () => {
    let status = 500;
    let text = "";
    try {
      [status, text] = await handle(url);
    } catch (error) {
      text = String(error).slice(0, 200);
    }
    res.statusCode = status;
    res.end(text);
    if (url.pathname === "/quit") {
      await browser.close();
      server.close();
      rmSync(DIR, { recursive: true, force: true });
      process.exit(0);
    }
  });
});
server.listen(SOCKET, () => console.log(`screen ready ${SOCKET}`));
