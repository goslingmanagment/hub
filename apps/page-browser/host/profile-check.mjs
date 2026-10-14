// Project Browser — the profile check of a Chrome update (plan §4.10;
// spec §10 «Профиль и буфер», «Политики, расширение»; stage 3, PR 18).
// scripts/page-browser-update.sh copies it into a page's container and runs
// it there as pb-operator, on a page that stands — Chrome down, the exit
// closed — right after the page moved to a new image, before the page goes
// back to its engine:
//
//   node --no-warnings pb-profile-check.mjs
//
//  1. Chrome starts once (`s6-svc -o`: s6 does not start it again) on the
//     page's own profile, as the operator would start it (the run script's
//     flags, about:blank, no automation flag).
//  2. Its version, from Chrome itself.
//  3. The image's rules extension is installed by policy — the only one
//     besides Chrome's own, the image's ID (a new image brings a new ID, the
//     old one goes: PR 6), enabled — and Chrome enabled as many static rules
//     as the image's rules.json has.
//  4. Every policy of the image's hub.json is applied.
//  5. Chrome quits as on a user's quit (Browser.close: its profile is
//     written), and stays down: the page stands as it was found.
//
// Nothing reaches any network: the exit stays closed (the operator's proxy
// refuses everything but the extension's own package on its port), and the
// kernel lets Chrome reach nothing but that port. The profile is opened by
// the new Chrome here for the first time — which is why the update takes
// its snapshot before.
//
// Prints one JSON line {ok, failed (the names of the checks that did not
// pass), chrome, extension, rules, policies, stopped, checks, error}; exits
// 0 when every check passed, 1 when one did not, 2 when it could not run
// (Chrome already up).

import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";

const CHROME = "/run/service/chrome";
const OPERATOR = "/run/service/operator";
const CDP = "http://127.0.0.1:9222";
const DIST = process.env.PB_EXTENSION_DIR ?? "/opt/page-browser/extension/dist";
const POLICY = "/etc/opt/chrome/policies/managed/hub.json";
/** Chrome's pool of static rules (30 000 guaranteed and 300 000 shared):
 *  what is left of it tells how many rules it enabled. */
const STATIC_RULE_POOL = 330_000;
/** Chrome records a force-installed extension in its preferences about
 *  10 s after the install (stage 1, amendment 24): it quits no sooner. */
const MIN_RUN_MS = 12_000;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const report = { ok: false, failed: [], chrome: null, extension: null, rules: null, policies: null, stopped: null, checks: {} };
const check = (name, pass, detail = {}) => {
  report.checks[name] = { pass, ...detail };
};

const svc = (flag) => execFileSync("/command/s6-svc", [flag, CHROME]);
const isUp = (service) => execFileSync("/command/s6-svstat", ["-o", "up", service], { encoding: "utf8" }).trim() === "true";
const upFor = (service) => {
  const [up, seconds] = execFileSync("/command/s6-svstat", ["-o", "up,updownfor", service], { encoding: "utf8" }).trim().split(/\s+/);
  return up === "true" ? Number(seconds) : -1;
};
const chromeGone = () => !isUp(CHROME) && execFileSync("sh", ["-c", "pgrep -u pb-chrome -f '^/opt/google/chrome/chrome' || true"], { encoding: "utf8" }).trim() === "";
async function waitFor(predicate, ms, step = 200) {
  for (const end = Date.now() + ms; Date.now() < end; await sleep(step)) if (await predicate()) return true;
  return false;
}

async function cdpVersion() {
  for (let i = 0; i < 150; i++) {
    try {
      return await (await fetch(`${CDP}/json/version`)).json();
    } catch {
      await sleep(100);
    }
  }
  throw new Error("no CDP after 15 s");
}

class Cdp {
  #ws;
  #id = 0;
  #pending = new Map();
  #listeners = new Set();
  static async open(url) {
    const cdp = new Cdp();
    cdp.#ws = new globalThis.WebSocket(url);
    cdp.#ws.onmessage = (event) => {
      const message = JSON.parse(event.data);
      const done = message.id === undefined ? undefined : cdp.#pending.get(message.id);
      if (done) {
        cdp.#pending.delete(message.id);
        done(message);
      } else for (const listener of cdp.#listeners) listener(message);
    };
    await new Promise((resolve, reject) => {
      cdp.#ws.onopen = resolve;
      cdp.#ws.onerror = reject;
    });
    return cdp;
  }
  send(method, params = {}, sessionId = undefined, timeoutMs = 10_000) {
    const id = ++this.#id;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.#pending.delete(id);
        reject(new Error(`${method}: no answer in ${timeoutMs} ms`));
      }, timeoutMs);
      this.#pending.set(id, (message) => {
        clearTimeout(timer);
        if (message.error) reject(new Error(`${method}: ${message.error.message}`));
        else resolve(message.result);
      });
      this.#ws.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
    });
  }
  /** A new tab at a Chrome page or the extension's own, once it loaded. */
  async tab(url) {
    const { targetId } = await this.send("Target.createTarget", { url: "about:blank" });
    const { sessionId } = await this.send("Target.attachToTarget", { targetId, flatten: true });
    await this.send("Page.enable", {}, sessionId);
    const loaded = new Promise((resolve) => {
      const done = (message) => {
        if (message !== null && (message.sessionId !== sessionId || message.method !== "Page.loadEventFired")) return;
        this.#listeners.delete(done);
        resolve();
      };
      this.#listeners.add(done);
      setTimeout(() => done(null), 8000);
    });
    await this.send("Page.navigate", { url }, sessionId);
    await loaded;
    return { targetId, sessionId };
  }
  async evaluate(sessionId, expression) {
    const result = await this.send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true }, sessionId, 8000);
    if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description ?? result.exceptionDetails.text);
    return result.result.value;
  }
  async evaluateUntil(sessionId, expression, ready, ms = 12_000) {
    let last;
    for (const end = Date.now() + ms; Date.now() < end; await sleep(200)) {
      try {
        last = await this.evaluate(sessionId, expression);
        if (ready(last)) return last;
      } catch (error) {
        last = error;
      }
    }
    throw new Error(`not ready in ${ms} ms (${last instanceof Error ? last.message : JSON.stringify(last)})`);
  }
  close() {
    this.#ws.close();
  }
}

/** Chrome's own account of its extensions (chrome://extensions-internals). */
async function extensions(cdp) {
  const { targetId, sessionId } = await cdp.tab("chrome://extensions-internals/");
  try {
    const text = await cdp.evaluateUntil(sessionId, "document.body.innerText", (value) => typeof value === "string" && value.trim().startsWith("[") && value.trim().endsWith("]"));
    return JSON.parse(text).map((entry) => ({ id: entry.id, location: entry.location, status: entry.registry_status, disabled: entry.disable_reasons }));
  } finally {
    await cdp.send("Target.closeTarget", { targetId }).catch(() => undefined);
  }
}

/** The names of the policies chrome://policy shows applied. */
async function appliedPolicies(cdp) {
  const { targetId, sessionId } = await cdp.tab("chrome://policy/");
  try {
    const rows = await cdp.evaluateUntil(sessionId, `(() => {
      const rows = [];
      const walk = (node) => {
        if (node.shadowRoot) walk(node.shadowRoot);
        for (const child of node.children ?? []) {
          if (child.classList?.contains("policy") && child.classList.contains("row")) rows.push(child.querySelector(".name")?.textContent.trim() ?? "");
          walk(child);
        }
      };
      walk(document.body);
      return rows;
    })()`, (value) => Array.isArray(value) && value.length > 0);
    return new Set(rows);
  } finally {
    await cdp.send("Target.closeTarget", { targetId }).catch(() => undefined);
  }
}

let started = false;
let exit = 1;
try {
  if (!chromeGone()) {
    exit = 2;
    throw new Error("Chrome is running: the profile check runs only on a page that stands");
  }
  // An operator that has only just started takes a Chrome it finds for a
  // previous instance's and kills it: it must have settled; and it serves
  // the extension's package for the install.
  if (!(await waitFor(() => upFor(OPERATOR) >= 5, 20_000, 250))) throw new Error("the operator is not up (for 5 s): it serves the extension's package");
  const imageId = readFileSync(`${DIST}/id`, "utf8").trim();
  const rules = JSON.parse(readFileSync(`${DIST}/rules.json`, "utf8")).length;
  const policyNames = Object.keys(JSON.parse(readFileSync(POLICY, "utf8")));

  started = true;
  const startedAt = Date.now();
  svc("-o");
  const version = await cdpVersion();
  report.chrome = String(version.Browser ?? "");
  check("chrome_started", /^Chrome\/\d+\.\d+\.\d+\.\d+$/.test(report.chrome), { chrome: report.chrome });
  const cdp = await Cdp.open(version.webSocketDebuggerUrl);
  try {
    let installed = [];
    const ours = () => installed.filter((entry) => entry.location !== "COMPONENT");
    const ready = await waitFor(async () => {
      installed = await extensions(cdp).catch(() => []);
      return ours().length === 1 && ours()[0].id === imageId && ours()[0].status === "ENABLED";
    }, 30_000, 250);
    report.extension = { id: imageId, found: ours() };
    check("extension_installed_by_policy", ready && ours()[0].location === "EXTERNAL_POLICY_DOWNLOAD" && ours()[0].disabled.length === 0, { afterMs: Date.now() - startedAt });

    // Chrome's word on the rules, from a page of the extension itself; right
    // after a start its API may not answer, so the question is asked again.
    let answer = null;
    let lastError = null;
    for (const end = Date.now() + 40_000; ready && answer === null && Date.now() < end; ) {
      const { targetId, sessionId } = await cdp.tab(`chrome-extension://${imageId}/manifest.json`);
      try {
        await cdp.evaluateUntil(sessionId, "typeof chrome !== 'undefined' && !!chrome.declarativeNetRequest", (value) => value === true, 6000);
        const got = await cdp.evaluate(sessionId, `Promise.race([(async () => ({ rulesets: await chrome.declarativeNetRequest.getEnabledRulesets(), available: await chrome.declarativeNetRequest.getAvailableStaticRuleCount() }))(), new Promise((resolve) => setTimeout(() => resolve("late"), 3000))])`);
        if (got !== "late") answer = got;
      } catch (error) {
        lastError = error;
      } finally {
        await cdp.send("Target.closeTarget", { targetId }).catch(() => undefined);
      }
      if (answer === null) await sleep(500);
    }
    report.rules = answer === null ? { error: lastError?.message ?? "no answer" } : { rulesets: answer.rulesets, enabled: STATIC_RULE_POOL - answer.available, inRulesJson: rules };
    check("rules_enabled", answer !== null && JSON.stringify(answer.rulesets) === JSON.stringify(["hub"]) && STATIC_RULE_POOL - answer.available === rules, report.rules);

    const applied = await appliedPolicies(cdp).catch(() => new Set());
    const missing = policyNames.filter((name) => !applied.has(name));
    report.policies = { inHubJson: policyNames.length, missing };
    check("policies_applied", missing.length === 0, report.policies);

    // A quit as the user's: the profile written. Not before the extension's
    // install is in the preferences.
    await sleep(Math.max(0, MIN_RUN_MS - (Date.now() - startedAt)));
    await cdp.send("Browser.close", {}, undefined, 5000).catch(() => undefined);
  } finally {
    cdp.close();
  }
  const quit = await waitFor(chromeGone, 15_000);
  report.stopped = quit ? "quit" : "stopped by s6";
  exit = Object.values(report.checks).every((entry) => entry.pass) ? 0 : 1;
} catch (error) {
  report.error = error instanceof Error ? error.message : String(error);
} finally {
  if (started) {
    // Down, as the page was found: s6 makes sure.
    try {
      svc("-d");
      await waitFor(chromeGone, 10_000);
    } catch {
      // reported below
    }
    check("left_standing", chromeGone());
    if (!report.checks.left_standing.pass) exit = 1;
  }
  report.ok = exit === 0;
  report.failed = [...Object.entries(report.checks).filter(([, entry]) => !entry.pass).map(([name]) => name), ...(report.error === undefined ? [] : ["error"])];
  console.log(JSON.stringify(report));
  process.exit(exit);
}
