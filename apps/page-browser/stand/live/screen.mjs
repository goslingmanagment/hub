// The login on the owner's behalf (at his request): a headless browser on
// the Mac opens the page's KasmVNC screen — the same path the owner's own
// browser takes — and types into Fansly's form there. Fansly's Chrome on the
// server gets ordinary X input from KasmVNC; nothing controls it but the
// operator.
//
// Secrets: one JSON line on stdin — {"email", "password", "vnc"} — read once
// and kept in memory only. Never printed, never in an argument or the
// environment. No tracing, video, HAR or Playwright debug log: the driver
// refuses to start if DEBUG or PWDEBUG is set. Screenshots are taken only
// when no secret is on the screen (before typing and after the form is
// gone) and deleted after the login.
//
//   <secrets> | PLAYWRIGHT_MODULE=… CHROMIUM_PATH=… node stand/live/screen.mjs
// Commands on 127.0.0.1:7811:
//   GET /shot                 → path of a screenshot (/tmp/pb-screen/…)
//   GET /click?x=…&y=…        a click at screen coordinates (1920×1080, 1:1)
//   GET /key?k=Tab            a key (Playwright names)
//   GET /type?name=email      types that secret, 80–170 ms per character
//   GET /quit
// The order of the login (RUNBOOK): check the screen; click the e-mail
// field; Tab and a screenshot — the password field holds the focus, the
// form is still empty; Shift+Tab and a screenshot — back on the e-mail
// field; type the e-mail, Tab, type the password, Enter. No screenshot
// between the first character and the form's end.

import { createServer } from "node:http";
import { mkdirSync, rmSync } from "node:fs";

if (process.env.DEBUG || process.env.PWDEBUG) throw new Error("DEBUG/PWDEBUG set: the driver would log its input");
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE ?? "playwright");

const input = await new Promise((resolve) => {
  let s = "";
  process.stdin.on("data", (d) => (s += d));
  process.stdin.on("end", () => resolve(s));
});
const secrets = JSON.parse(input);
for (const key of ["email", "password", "vnc"]) if (typeof secrets[key] !== "string" || secrets[key] === "") throw new Error(`no ${key} on stdin`);

const SHOTS = "/tmp/pb-screen";
rmSync(SHOTS, { recursive: true, force: true });
mkdirSync(SHOTS, { recursive: true });
const browser = await chromium.launch({ headless: true, ...(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {}) });
const context = await browser.newContext({ viewport: { width: 1920, height: 1080 }, httpCredentials: { username: "owner", password: secrets.vnc } });
const page = await context.newPage();
await page.goto(process.env.SCREEN_URL ?? "http://127.0.0.1:16901/", { waitUntil: "load" });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let shots = 0;
createServer(async (req, res) => {
  const url = new URL(req.url, "http://x");
  const q = (k) => url.searchParams.get(k);
  try {
    switch (url.pathname) {
      case "/shot": {
        const path = `${SHOTS}/${String(++shots).padStart(2, "0")}.png`;
        await page.screenshot({ path });
        return res.end(path);
      }
      case "/click":
        await page.mouse.click(Number(q("x")), Number(q("y")));
        return res.end("ok");
      case "/key":
        await page.keyboard.press(String(q("k")));
        return res.end("ok");
      case "/type": {
        const name = q("name");
        if (name !== "email" && name !== "password") throw new Error("no such field");
        for (const ch of secrets[name]) {
          await page.keyboard.type(ch);
          await sleep(80 + Math.random() * 90);
        }
        return res.end(`typed ${secrets[name].length} characters`);
      }
      case "/quit":
        res.end("bye");
        await browser.close();
        rmSync(SHOTS, { recursive: true, force: true });
        return process.exit(0);
      default:
        res.statusCode = 404;
        return res.end("?");
    }
  } catch (error) {
    res.statusCode = 500;
    res.end(String(error).slice(0, 200));
  }
}).listen(7811, "127.0.0.1", () => console.log("screen ready"));
