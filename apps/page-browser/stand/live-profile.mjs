// The stand's look into a page's profile (Project Browser PR 18, the stand
// check of a Chrome update — stand/chrome-update.sh): run inside a page's
// container as pb-operator, on a page that stands (Chrome down, the exit
// closed). It starts the page's Chrome once, as the operator would (s6),
// and through CDP:
//
//   node --no-warnings live-profile.mjs list
//       the names of the profile's cookies of .fansly.com — never a value;
//   node --no-warnings live-profile.mjs set <name> <value>
//       a cookie of .fansly.com, for 30 days (a stand profile's own marks:
//       what a rollback must take back);
//
// then Chrome quits as on a user's quit (its profile written) and stays
// down. Nothing reaches any network: the exit stays closed. Prints one JSON
// line {chrome, cookies: [names]}.

import { execFileSync } from "node:child_process";

const [op, name, value] = process.argv.slice(2);
const CHROME = "/run/service/chrome";
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const isUp = () => execFileSync("/command/s6-svstat", ["-o", "up", CHROME], { encoding: "utf8" }).trim() === "true";

if (op !== "list" && !(op === "set" && name && value)) {
  console.error("usage: live-profile.mjs list | set <name> <value>");
  process.exit(2);
}
if (isUp()) {
  console.error("Chrome is running: this runs only on a page that stands");
  process.exit(2);
}
execFileSync("/command/s6-svc", ["-o", CHROME]);
try {
  let version;
  for (let i = 0; i < 150 && version === undefined; i++) {
    try {
      version = await (await fetch("http://127.0.0.1:9222/json/version")).json();
    } catch {
      await sleep(100);
    }
  }
  if (version === undefined) throw new Error("no CDP after 15 s");
  const ws = new globalThis.WebSocket(version.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => {
    ws.onopen = resolve;
    ws.onerror = reject;
  });
  let id = 0;
  const pending = new Map();
  ws.onmessage = (event) => {
    const message = JSON.parse(event.data);
    pending.get(message.id)?.(message);
  };
  const send = (method, params = {}) =>
    new Promise((resolve) => {
      const call = ++id;
      pending.set(call, resolve);
      ws.send(JSON.stringify({ id: call, method, params }));
    });
  if (op === "set") {
    await send("Storage.setCookies", { cookies: [{ name, value, domain: ".fansly.com", path: "/", secure: true, expires: Math.floor(Date.now() / 1000) + 30 * 86400 }] });
  }
  // Chrome writes its cookies within seconds; a quit writes the rest.
  await sleep(op === "set" ? 12_000 : 3000);
  const got = await send("Storage.getCookies", {});
  const cookies = (got.result?.cookies ?? []).filter((cookie) => cookie.domain.endsWith("fansly.com")).map((cookie) => cookie.name).sort();
  console.log(JSON.stringify({ chrome: version.Browser, cookies }));
  await send("Browser.close");
} finally {
  for (let i = 0; i < 150 && isUp(); i++) await sleep(100);
  execFileSync("/command/s6-svc", ["-d", CHROME]);
}
