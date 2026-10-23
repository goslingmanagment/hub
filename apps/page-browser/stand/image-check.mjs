// The stand check of the page browser image (plan §5, stage 3, PR 2): run
// inside a page container as pb-operator — the operator's user, with the
// operator's rights — by stand/image-check.sh. It checks:
//  1. the kernel check of the egress rules passed (net-selftest);
//  2. pb-operator starts Chrome through s6 (the operator's way, plan §3.1);
//  3. Chrome applied every policy of hub.json and of the page's policy
//     (page.json: ForcedLanguages, written by Chrome's run script), with its
//     value, as a mandatory machine policy, and nothing reports it invalid;
//  4. Chrome's sandbox is on: namespaces and seccomp-BPF (chrome://sandbox);
//  5. no automation shows: navigator.webdriver is false;
//  6. pb-operator stops Chrome, and it is gone within its 5 s.
// The policy page is read by its row structure; its status words follow
// Chrome's language, so the container runs with PB_LANG=en-US here.
//
// Prints one JSON object; exits 1 if anything failed.

import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";

const CDP = "http://127.0.0.1:9222";
const SVC = "/run/service/chrome";
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const report = { checks: {} };
const check = (name, pass, detail = {}) => {
  report.checks[name] = { pass, ...detail };
};

function svc(flag) {
  execFileSync("/command/s6-svc", [flag, SVC]);
}
function svstat() {
  return execFileSync("/command/s6-svstat", [SVC], { encoding: "utf8" }).trim();
}

async function cdpVersion() {
  for (let i = 0; i < 100; i++) {
    try {
      return await (await fetch(`${CDP}/json/version`)).json();
    } catch {
      await sleep(100);
    }
  }
  throw new Error("no CDP after 10 s");
}

class Cdp {
  #ws;
  #id = 0;
  #pending = new Map();
  static async open(url) {
    const cdp = new Cdp();
    cdp.#ws = new globalThis.WebSocket(url);
    cdp.#ws.onmessage = (event) => {
      const message = JSON.parse(event.data);
      const done = cdp.#pending.get(message.id);
      if (done) {
        cdp.#pending.delete(message.id);
        done(message);
      }
    };
    await new Promise((resolve, reject) => {
      cdp.#ws.onopen = resolve;
      cdp.#ws.onerror = reject;
    });
    return cdp;
  }
  send(method, params = {}, sessionId = undefined) {
    const id = ++this.#id;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`${method}: no answer in 10 s`)), 10_000);
      this.#pending.set(id, (message) => {
        clearTimeout(timer);
        if (message.error) reject(new Error(`${method}: ${message.error.message}`));
        else resolve(message.result);
      });
      this.#ws.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
    });
  }
  /** The value of `expression` in a new tab at `url`. */
  async evaluateAt(url, expression) {
    const { targetId } = await this.send("Target.createTarget", { url });
    const { sessionId } = await this.send("Target.attachToTarget", { targetId, flatten: true });
    try {
      await sleep(2_000);
      const { result } = await this.send("Runtime.evaluate", { expression, returnByValue: true }, sessionId);
      return result.value;
    } finally {
      await this.send("Target.closeTarget", { targetId });
    }
  }
  close() {
    this.#ws.close();
  }
}

try {
  const selftest = JSON.parse(readFileSync("/run/pb/net-selftest.json", "utf8"));
  check("net_selftest", selftest.ok === true, { failed: selftest.results.filter((result) => !result.pass) });

  svc("-u");
  const version = await cdpVersion();
  check("chrome_started_by_operator", /^up /.test(svstat()), { browser: version.Browser });
  const cdp = await Cdp.open(version.webSocketDebuggerUrl);

  // 3. The policies, row by row: name, value, source, level, status.
  const rows = await cdp.evaluateAt("chrome://policy/", `(() => {
    const rows = [];
    const walk = (node) => {
      if (node.shadowRoot) walk(node.shadowRoot);
      for (const child of node.children ?? []) {
        if (child.classList?.contains("policy") && child.classList.contains("row")) {
          const cell = (name) => child.querySelector("." + name)?.textContent.trim() ?? null;
          rows.push({ name: cell("name"), value: cell("value"), source: cell("source"), level: cell("level"), status: cell("messages") });
        }
        walk(child);
      }
    };
    walk(document.body);
    return rows;
  })()`);
  const wanted = {
    ...JSON.parse(readFileSync("/etc/opt/chrome/policies/managed/hub.json", "utf8")),
    ...JSON.parse(readFileSync("/etc/opt/chrome/policies/managed/page.json", "utf8")),
  };
  const byName = new Map(rows.map((row) => [row.name, row]));
  const misses = [];
  // Applied, but Chrome will drop it in a later version (Chrome 156:
  // AutofillAddressEnabled, AutofillCreditCardEnabled): it passes, and is
  // named, so a replacement is found before it stops working.
  const deprecated = [];
  for (const [name, value] of Object.entries(wanted)) {
    const row = byName.get(name);
    let applied = null;
    try {
      applied = row ? JSON.parse(row.value) : null;
    } catch {
      applied = row?.value ?? null;
    }
    const ok = row !== undefined && JSON.stringify(applied) === JSON.stringify(value) && row.source === "Platform" && row.level === "Mandatory" && (row.status === "OK" || row.status === "Deprecated");
    if (!ok) misses.push({ name, row: row ?? null });
    else if (row.status === "Deprecated") deprecated.push(name);
  }
  // Set by anything else: a row with a value whose name hub.json lacks.
  const extra = rows.filter((row) => !(row.name in wanted) && row.value !== "" && row.status !== "Not set");
  check("policies_applied", misses.length === 0 && extra.length === 0, { wanted: Object.keys(wanted).length, misses, extra, deprecated });

  // 4. The sandbox (chrome://sandbox is not translated).
  const sandbox = await cdp.evaluateAt("chrome://sandbox/", "document.body.innerText");
  check("sandbox_on", /PID namespaces\s+Yes/.test(sandbox) && /Network namespaces\s+Yes/.test(sandbox) && /Seccomp-BPF sandbox\s+Yes/.test(sandbox) && sandbox.includes("You are adequately sandboxed."), {
    text: sandbox.replace(/\s+/g, " ").slice(0, 400),
  });

  // 5. No automation flag shows.
  const webdriver = await cdp.evaluateAt("about:blank", "navigator.webdriver");
  check("no_webdriver", webdriver === false, { webdriver });
  cdp.close();

  // 6. The operator stops Chrome.
  svc("-d");
  let gone = false;
  for (let i = 0; i < 70 && !gone; i++) {
    await sleep(100);
    gone = /^down /.test(svstat()) && execFileSync("sh", ["-c", "pgrep -u pb-chrome -f '^/opt/google/chrome/chrome' || true"], { encoding: "utf8" }).trim() === "";
  }
  check("chrome_stopped_by_operator", gone, { status: svstat() });
} catch (error) {
  check("ran", false, { error: String(error) });
}

report.pass = Object.values(report.checks).every((result) => result.pass);
console.log(JSON.stringify(report, null, 2));
process.exit(report.pass ? 0 : 1);
