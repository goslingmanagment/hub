// The screen driver (screen.mjs) with dummy secrets against a local page:
// no TCP port, a private directory, one command at a time, no screenshot
// once typing began, everything removed at the exit (Astra review 14).
//   PLAYWRIGHT_MODULE=… CHROMIUM_PATH=… node stand/live/screen-check.mjs
// Exit 0 = every check held.

import { spawn } from "node:child_process";
import { request } from "node:http";
import { createConnection } from "node:net";
import { existsSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const failures = [];
function check(name, ok, detail) {
  console.log(JSON.stringify({ check: name, ok, ...(detail === undefined ? {} : { detail }) }));
  if (!ok) failures.push(name);
}

const page = "data:text/html,<input id=e autofocus><input id=p type=password>";
const driver = spawn(process.execPath, [join(dirname(fileURLToPath(import.meta.url)), "screen.mjs")], {
  env: { ...process.env, SCREEN_URL: page, DEBUG: "", PWDEBUG: "" },
  stdio: ["pipe", "pipe", "inherit"],
});
driver.stdin.end(JSON.stringify({ email: "dummy@example.test", password: "dummy-password-1", vnc: "dummy-vnc" }));
const socket = await new Promise((resolve, reject) => {
  let out = "";
  driver.stdout.on("data", (d) => {
    out += d;
    const m = out.match(/screen ready (\S+)/);
    if (m) resolve(m[1]);
  });
  driver.on("exit", (code) => reject(new Error(`driver exited ${code}`)));
});

const call = (path) =>
  new Promise((resolve) => {
    const started = Date.now();
    const req = request({ socketPath: socket, path, method: "GET" }, (res) => {
      let body = "";
      res.on("data", (d) => (body += d));
      res.on("end", () => resolve({ status: res.statusCode, body, started, ended: Date.now() }));
    });
    req.on("error", (error) => resolve({ status: 0, body: String(error), started, ended: Date.now() }));
    req.end();
  });

const tcp = await new Promise((resolve) => {
  const conn = createConnection({ host: "127.0.0.1", port: 7811 });
  conn.on("connect", () => {
    conn.destroy();
    resolve("open");
  });
  conn.on("error", () => resolve("refused"));
});
check("no TCP port", tcp === "refused", tcp);
check("the directory is private", (statSync(dirname(socket)).mode & 0o077) === 0);

const before = await call("/shot");
check("a screenshot before typing", before.status === 200 && existsSync(before.body), before.status);

// Sent together: the screenshot waits for the typing and is then refused.
const [typed, during] = await Promise.all([call("/type?name=email"), call("/shot")]);
check("commands run one at a time", typed.status === 200 && during.ended >= typed.ended, { typed: typed.body, shotStatus: during.status });
check("no screenshot once typing began", during.status === 403);
const after = await call("/shot");
check("still none later", after.status === 403);
const other = await call("/type?name=vnc");
check("only the login fields can be typed", other.status === 400);

const quit = await call("/quit");
await new Promise((resolve) => driver.on("exit", resolve));
check("the directory is removed at the exit", quit.status === 200 && !existsSync(dirname(socket)));
process.exit(failures.length === 0 ? 0 : 1);
