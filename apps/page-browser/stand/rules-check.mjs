// The stand check of the rules extension (plan §5, stage 3, PR 6: "read
// mark, typing, status and an unknown write are cancelled without the
// operator"), on the image's real Chrome. Run inside a page container as
// pb-operator by stand/rules-check.sh (or by image-check.sh):
//
//   node --no-warnings rules-check.mjs [--take-over]
//
// It stops the page's operator and restarts its Chrome, so it refuses a
// container whose Chrome is running unless --take-over is given; at the end
// Chrome is down and the operator is up again, as a standing page is.
//
//  1. With the operator (its proxy serves the package): Chrome starts and
//     its policy installs the extension — the only one besides Chrome's
//     own, with the image's ID, from the policy. Chrome itself confirms that
//     it compiles every rule's expression, with room to spare (a rule over
//     its memory limit is dropped without a word), and that it enabled as
//     many rules as rules.json has.
//  2. Without the operator: the operator is stopped, Chrome restarted, and
//     this script listens on the proxy's port in its place, answering 403
//     and writing down every request Chrome brings — what would have left.
//     Nothing here reaches any network: the kernel lets Chrome reach only
//     that port, and the listener connects nowhere.
//  3. From a page of the site's own origin (https://fansly.com, answered
//     here, never fetched), every example of the map of operations the
//     image carries (src/policy/operations.ts):
//       closed  each row closed one by one, by each of its methods — the
//               four closed reads by a GET too, from a script, opened as a
//               page (a link in an e-mail) and in other spellings of their
//               paths; each general closure (API writes, an escaped plain
//               character in an API path, Fansly writes, the closed hosts,
//               the socket host, local addresses); a form posted as a click
//               would post it (a main frame)
//               → Chrome reports ERR_BLOCKED_BY_CLIENT (for a socket it
//                 gives no reason: it only fails) and brings the listener
//                 nothing for that host;
//       open    API reads, a preflight, the login operations, the site's
//               socket, Fansly's static hosts, a third-party host, Hub's
//               placeholder host — and a write opened by its body (the
//               delivered mark, owner decision 2026-10-23) in its exact
//               spelling from a script, whose body the operator checks: its
//               other spellings, methods, a posted form and Hub's
//               placeholder are closed (`checked: …`)
//               → the listener gets the request's CONNECT: the extension
//                 let it through (the operator and the engine decide those).
//  4. With an interception in place, as the operator's own: the self-test's
//     probes the extension cancels never reach it; its permitted probe does.
//  5. No window without the extension, and TLS only (spec §8.1): the
//     policies applied; Ctrl+Shift+N opens nothing (Incognito would run
//     without extensions); the environment check's page still works under
//     them; an http:// navigation is upgraded to https, and when that
//     fails no plain request leaves.
//
// Prints one JSON object; exits 1 if anything failed.

import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { createServer } from "node:net";

const SRC = process.env.PB_SRC ?? "/opt/page-browser/src";
const DIST = process.env.PB_EXTENSION_DIR ?? "/opt/page-browser/extension/dist";
const POLICY = "/etc/opt/chrome/policies/managed/hub.json";
const CDP = "http://127.0.0.1:9222";
const PROXY_PORT = 3128;
const CHROME = "/run/service/chrome";
const OPERATOR = "/run/service/operator";
/** Chrome's pool of static rules (30 000 guaranteed and 300 000 shared):
 *  what is left of it tells how many rules it enabled. */
const STATIC_RULE_POOL = 330_000;
/** Instructions added to an expression to see it compiles with room. */
const REGEX_HEADROOM = 25;

const takeOver = process.argv.includes("--take-over");
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const report = { checks: {} };
const check = (name, pass, detail = {}) => {
  report.checks[name] = { pass, ...detail };
};

const svc = (flag, service) => execFileSync("/command/s6-svc", [flag, service]);
const isUp = (service) => /^up /.test(execFileSync("/command/s6-svstat", [service], { encoding: "utf8" }));
/** Seconds a service has been up; -1 when it is down. */
const upFor = (service) => {
  const [up, seconds] = execFileSync("/command/s6-svstat", ["-o", "up,updownfor", service], { encoding: "utf8" }).trim().split(/\s+/);
  return up === "true" ? Number(seconds) : -1;
};
async function waitFor(predicate, ms, step = 100) {
  for (const end = Date.now() + ms; Date.now() < end; await sleep(step)) if (await predicate()) return true;
  return false;
}
const chromeGone = () => !isUp(CHROME) && execFileSync("sh", ["-c", "pgrep -u pb-chrome -f '^/opt/google/chrome/chrome' || true"], { encoding: "utf8" }).trim() === "";

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
  listeners = new Set();
  static async open(url) {
    const cdp = new Cdp();
    cdp.#ws = new globalThis.WebSocket(url);
    cdp.#ws.onmessage = (event) => {
      const message = JSON.parse(event.data);
      const done = message.id === undefined ? undefined : cdp.#pending.get(message.id);
      if (done) {
        cdp.#pending.delete(message.id);
        done(message);
      } else for (const listener of cdp.listeners) listener(message);
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
  /** A new tab, at `url` once its document has loaded: a tab starts blank
   *  and is attached before it goes anywhere, so no command is lost to the
   *  change of its process. */
  async tab(url) {
    const { targetId } = await this.send("Target.createTarget", { url: "about:blank" });
    const { sessionId } = await this.send("Target.attachToTarget", { targetId, flatten: true });
    if (url !== "about:blank") {
      await this.send("Page.enable", {}, sessionId);
      const loaded = new Promise((resolve) => {
        const done = (message) => {
          if (message !== null && (message.sessionId !== sessionId || message.method !== "Page.loadEventFired")) return;
          this.listeners.delete(done);
          resolve();
        };
        this.listeners.add(done);
        setTimeout(() => done(null), 8000);
      });
      await this.send("Page.navigate", { url }, sessionId);
      await loaded;
    }
    return { targetId, sessionId };
  }
  async evaluate(sessionId, expression) {
    const result = await this.send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true }, sessionId, 6000);
    if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description ?? result.exceptionDetails.text);
    return result.result.value;
  }
  /** The value once `ready` takes it: a page that has just loaded may not
   *  answer the first time. */
  async evaluateUntil(sessionId, expression, ready, ms = 12_000) {
    let last;
    for (const end = Date.now() + ms; Date.now() < end; await sleep(150)) {
      try {
        last = await this.evaluate(sessionId, expression);
        if (ready(last)) return last;
      } catch (error) {
        last = error;
      }
    }
    throw new Error(`${expression.slice(0, 80)}: not ready in ${ms} ms (${last instanceof Error ? last.message : JSON.stringify(last)})`);
  }
  close() {
    this.#ws.close();
  }
}

/** Chrome's policies as chrome://policy shows them: name → value text. */
async function policyRows(cdp) {
  const { targetId, sessionId } = await cdp.tab("chrome://policy/");
  try {
    const rows = await cdp.evaluateUntil(sessionId, `(() => {
      const rows = [];
      const walk = (node) => {
        if (node.shadowRoot) walk(node.shadowRoot);
        for (const child of node.children ?? []) {
          if (child.classList?.contains("policy") && child.classList.contains("row")) rows.push([child.querySelector(".name")?.textContent.trim() ?? "", child.querySelector(".value")?.textContent.trim() ?? ""]);
          walk(child);
        }
      };
      walk(document.body);
      return rows;
    })()`, (value) => Array.isArray(value) && value.length > 0);
    return new Map(rows);
  } finally {
    await cdp.send("Target.closeTarget", { targetId }).catch(() => undefined);
  }
}

/** Chrome's own account of its extensions (chrome://extensions-internals). */
async function extensions(cdp) {
  const { targetId, sessionId } = await cdp.tab("chrome://extensions-internals/");
  try {
    const text = await cdp.evaluateUntil(sessionId, "document.body.innerText", (value) => typeof value === "string" && value.trim().startsWith("[") && value.trim().endsWith("]"));
    return JSON.parse(text).map((entry) => ({ id: entry.id, version: entry.version, location: entry.location, status: entry.registry_status, disabled: entry.disable_reasons }));
  } finally {
    await cdp.send("Target.closeTarget", { targetId });
  }
}

/** In place of the operator's proxy: every request Chrome brings is written
 *  down and refused. */
function listen() {
  const lines = [];
  const sockets = new Set();
  const server = createServer((socket) => {
    let head = "";
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
    socket.on("error", () => undefined);
    socket.on("data", (chunk) => {
      if (head.includes("\n")) return;
      head += chunk.toString("latin1");
      if (!head.includes("\n")) return;
      lines.push(head.split(/\r?\n/, 1)[0]);
      socket.end("HTTP/1.1 403 Forbidden\r\nContent-Length: 0\r\nConnection: close\r\n\r\n");
    });
  });
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(PROXY_PORT, "127.0.0.1", () =>
      resolve({
        lines,
        close: () =>
          new Promise((done) => {
            for (const socket of sockets) socket.destroy();
            server.close(done);
          }),
      }),
    );
  });
}

/** What the listener would get for a URL: a tunnel to its host, or — plain
 *  HTTP — the request itself. */
function leftFor(lines, url) {
  const { protocol, hostname, port } = new URL(url);
  const host = hostname.toLowerCase();
  const tls = protocol === "https:" || protocol === "wss:";
  const at = port || (tls ? "443" : "80");
  return lines.filter((line) => (tls ? line.startsWith(`CONNECT ${host}:${at} `) : line.includes(`://${host}${port ? `:${port}` : ""}/`) || line.startsWith(`CONNECT ${host}:${at} `)));
}

let chromeStarted = false;
let operatorStopped = false;
let listener = null;
try {
  const { ANY_METHOD, CHECKED_ROWS, CLOSED_ROWS, GENERAL_CLOSURES, CATALOGUE_ROWS, LOGIN_ROWS, LOGIN_SCREEN_ROWS, API_HOST, API_BASE, SOCKET_HOST } = await import(`${SRC}/policy/operations.ts`);
  const { PLACEHOLDER_SUFFIX } = await import(`${SRC}/hub-requests/page.ts`);
  const { NEVER_PATH, UNKNOWN_WRITE_PATH } = await import(`${SRC}/selftest/selftest.ts`);
  const imageId = readFileSync(`${DIST}/id`, "utf8").trim();
  const rules = JSON.parse(readFileSync(`${DIST}/rules.json`, "utf8"));
  report.image = { id: imageId, rules: rules.length, closedRows: CLOSED_ROWS.length };

  if (!chromeGone() && !takeOver) throw new Error("Chrome is running: this check stops the operator and restarts Chrome — run it on a page that stands, or pass --take-over");
  // An operator that has only just started takes a Chrome it finds for a
  // previous instance's and kills it: it must have settled (the container's
  // health check waits the same 5 s).
  if (!(await waitFor(() => upFor(OPERATOR) >= 5, 20_000, 250))) throw new Error("the operator is not up (for 5 s): it serves the extension's package for the install");
  svc("-d", CHROME);
  if (!(await waitFor(chromeGone, 8000))) throw new Error("Chrome did not stop");

  // ── 1. with the operator: the install ──────────────────────────────────
  chromeStarted = true;
  svc("-u", CHROME);
  let cdp = await Cdp.open((await cdpVersion()).webSocketDebuggerUrl);
  const startedAt = Date.now();
  let installed = [];
  const ours = () => installed.filter((entry) => entry.location !== "COMPONENT");
  const ready = await waitFor(async () => {
    installed = await extensions(cdp).catch(() => []);
    return ours().length === 1 && ours()[0].id === imageId && ours()[0].status === "ENABLED";
  }, 30_000, 250);
  check("installed_by_policy", ready && ours()[0].location === "EXTERNAL_POLICY_DOWNLOAD" && ours()[0].disabled.length === 0, { afterMs: Date.now() - startedAt, extensions: ours() });

  // Chrome's word on the rules, from a page of the extension itself: one
  // question for everything. Right after Chrome's start a call of the
  // extension's API may never be answered, so the question has its own time
  // limit in the page and is asked again, in a new tab.
  {
    const asked = rules.map((rule) => ({ id: rule.id, regex: rule.condition.regexFilter, isCaseSensitive: rule.condition.isUrlFilterCaseSensitive }));
    const question = `(async () => {
      const dnr = chrome.declarativeNetRequest;
      const supported = async (regex, isCaseSensitive) => { const answer = await dnr.isRegexSupported({ regex, isCaseSensitive }); return answer.isSupported === true ? null : (answer.reason ?? "unsupported"); };
      const support = [];
      for (const rule of ${JSON.stringify(asked)}) support.push({ id: rule.id, plain: await supported(rule.regex, rule.isCaseSensitive), padded: await supported(rule.regex + ${JSON.stringify("[0-9]".repeat(REGEX_HEADROOM))}, rule.isCaseSensitive) });
      return { rulesets: await dnr.getEnabledRulesets(), available: await dnr.getAvailableStaticRuleCount(), support };
    })()`;
    let answer = null;
    let lastError = null;
    for (const end = Date.now() + 40_000; answer === null && Date.now() < end; ) {
      const { targetId, sessionId } = await cdp.tab(`chrome-extension://${imageId}/manifest.json`);
      try {
        await cdp.evaluateUntil(sessionId, "typeof chrome !== 'undefined' && !!chrome.declarativeNetRequest", (value) => value === true, 6000);
        const got = await cdp.evaluate(sessionId, `Promise.race([${question}, new Promise((resolve) => setTimeout(() => resolve("late"), 3000))])`);
        if (got !== "late") answer = got;
      } catch (error) {
        lastError = error;
      } finally {
        await cdp.send("Target.closeTarget", { targetId }).catch(() => undefined);
      }
      if (answer === null) await sleep(500);
    }
    if (answer === null) throw new Error(`Chrome did not answer for the extension's rules in 40 s (${lastError?.message ?? "its API never answered"})`);
    const unsupported = answer.support.filter((entry) => entry.plain !== null).map((entry) => ({ id: entry.id, reason: entry.plain }));
    const tight = answer.support.filter((entry) => entry.plain === null && entry.padded !== null).map((entry) => entry.id);
    check("rules_enabled", JSON.stringify(answer.rulesets) === JSON.stringify(["hub"]) && STATIC_RULE_POOL - answer.available === rules.length, { rulesets: answer.rulesets, enabled: STATIC_RULE_POOL - answer.available, inRulesJson: rules.length });
    check("expressions_compiled", answer.support.length === rules.length && unsupported.length === 0 && tight.length === 0, { asked: answer.support.length, unsupported, withoutHeadroom: tight, headroom: REGEX_HEADROOM });
  }
  cdp.close();

  // ── 2. without the operator ────────────────────────────────────────────
  svc("-d", OPERATOR);
  operatorStopped = true;
  svc("-d", CHROME);
  if (!(await waitFor(() => !isUp(OPERATOR) && chromeGone(), 10_000))) throw new Error("the operator or Chrome did not stop");
  listener = await listen();
  svc("-u", CHROME);
  cdp = await Cdp.open((await cdpVersion()).webSocketDebuggerUrl);
  const again = await extensions(cdp);
  check("loaded_without_the_operator", again.some((entry) => entry.id === imageId && entry.status === "ENABLED") && again.filter((entry) => entry.location !== "COMPONENT").length === 1, { operatorUp: isUp(OPERATOR) });

  // ── 3. the probes ──────────────────────────────────────────────────────
  // A page of the site's origin, answered here.
  const site = await cdp.tab("about:blank");
  const SITE_PAGE = "https://fansly.com/pb-rules-check";
  await cdp.send("Fetch.enable", { patterns: [{ urlPattern: SITE_PAGE }] }, site.sessionId);
  const answer = (message) => {
    if (message.method !== "Fetch.requestPaused" || message.sessionId !== site.sessionId) return;
    void cdp.send("Fetch.fulfillRequest", { requestId: message.params.requestId, responseCode: 200, responseHeaders: [{ name: "content-type", value: "text/html" }], body: Buffer.from("<!doctype html><title>pb rules check</title>").toString("base64") }, site.sessionId);
  };
  cdp.listeners.add(answer);
  await cdp.send("Page.enable", {}, site.sessionId);
  await cdp.send("Page.navigate", { url: SITE_PAGE }, site.sessionId);
  await cdp.evaluateUntil(site.sessionId, "location.origin + ' ' + document.readyState", (value) => value === "https://fansly.com complete");
  await cdp.send("Fetch.disable", {}, site.sessionId);
  cdp.listeners.delete(answer);
  // A page of no origin, for plain-HTTP addresses (the site's page may not
  // load them: mixed content).
  const blank = await cdp.tab("about:blank");
  for (const tab of [site, blank]) await cdp.send("Network.enable", {}, tab.sessionId);

  const seen = new Map();
  cdp.listeners.add((message) => {
    const params = message.params ?? {};
    const mark = /[?&]pbrc=(\d+)/.exec(String(params.request?.url ?? params.url ?? ""))?.[1];
    if (mark !== undefined && typeof params.requestId === "string" && (message.method === "Network.requestWillBeSent" || message.method === "Network.webSocketCreated")) {
      seen.set(params.requestId, { mark, ended: null });
      return;
    }
    const entry = seen.get(params.requestId);
    if (!entry) return;
    // The first end counts: a blocked navigation fails, and then its error
    // page loads under the same id. Chrome does not say why a socket failed
    // — for a socket the listener alone tells.
    if (message.method === "Network.loadingFailed") entry.ended ??= params.errorText;
    else if (message.method === "Network.loadingFinished") entry.ended ??= "finished";
    else if (message.method === "Network.webSocketHandshakeResponseReceived") entry.ended ??= "socket: handshake answered";
    else if (message.method === "Network.webSocketFrameError" || message.method === "Network.webSocketClosed") entry.ended ??= "socket: failed";
  });

  let n = 0;
  const results = [];
  /** One request, the way `how` makes it: "fetch" from the site's page,
   *  "plain" (fetch from the page of no origin), "socket", "form" — a form
   *  posted in a tab of its own, as a click would — or "page": the address
   *  opened in a tab of its own, as a link would. What Chrome said of its
   *  end, and what it brought the listener for its host. */
  async function request(method, url, how, fragment = "") {
    const mark = String(++n);
    const marked = `${url}${url.includes("?") ? "&" : "?"}pbrc=${mark}${fragment}`;
    const from = listener.lines.length;
    let closeTab = null;
    if (how === "socket") {
      // An insecure socket only from the page of no origin (mixed content).
      await cdp.evaluate((url.startsWith("ws:") ? blank : site).sessionId, `void new WebSocket(${JSON.stringify(marked)})`);
    } else if (how === "form") {
      const tab = await cdp.tab("about:blank");
      closeTab = tab.targetId;
      await cdp.send("Network.enable", {}, tab.sessionId);
      await cdp.evaluate(tab.sessionId, `(() => { const form = document.createElement("form"); form.method = ${JSON.stringify(method)}; form.action = ${JSON.stringify(marked)}; document.documentElement.appendChild(form); form.submit(); })()`);
    } else if (how === "page") {
      const tab = await cdp.tab("about:blank");
      closeTab = tab.targetId;
      await cdp.send("Network.enable", {}, tab.sessionId);
      await cdp.send("Page.navigate", { url: marked }, tab.sessionId).catch(() => undefined);
    } else {
      const body = method === "GET" || method === "HEAD" || method === "OPTIONS" ? "" : `, headers: { "content-type": "application/json" }, body: "{}"`;
      const init = how === "plain" ? `{ method: ${JSON.stringify(method)}, mode: "no-cors" }` : `{ method: ${JSON.stringify(method)}, credentials: "include"${body} }`;
      await cdp.evaluate((how === "plain" ? blank : site).sessionId, `void fetch(${JSON.stringify(marked)}, ${init}).catch(() => {})`);
    }
    const mine = () => [...seen.values()].filter((entry) => entry.mark === mark);
    await waitFor(() => mine().length > 0 && mine().every((entry) => entry.ended !== null), 4000, 20);
    await sleep(120);
    if (closeTab) await cdp.send("Target.closeTarget", { targetId: closeTab }).catch(() => undefined);
    const errors = mine().map((entry) => entry.ended ?? "no end in 4 s");
    const left = leftFor(listener.lines.slice(from), url);
    const cancelled = how === "socket" ? "socket: failed" : "ERR_BLOCKED_BY_CLIENT";
    return { mark, errors, left, blocked: errors.length > 0 && errors.every((error) => String(error).includes(cancelled)) && left.length === 0 };
  }
  async function probe(name, expect, method, url, how, fragment = "") {
    const { errors, left, blocked } = await request(method, url, how, fragment);
    const pass = expect === "closed" ? blocked : left.length > 0;
    results.push({ name, expect, method, url: `${url}${fragment}`, how, errors, left, pass });
    return pass;
  }

  const api = (path) => `https://${API_HOST}${API_BASE}${path}`;
  const sample = (template) => template.replace(/(:[A-Za-z_]\w*|\{[A-Za-z_]\w*\})/g, "123");
  // Closed one by one (spec §2.5), by every method of the row: a row of
  // every method by a read too.
  const methodsOf = (row) => (row.methods.includes(ANY_METHOD) ? ["GET", "HEAD", "OPTIONS", "POST", "PUT", "PATCH", "DELETE"] : row.methods);
  for (const row of CLOSED_ROWS) for (const method of methodsOf(row)) await probe(`closed: ${method} ${row.template} (${row.what})`, "closed", method, api(row.example), "fetch");
  // The closed reads — nothing but their own rules stands before a GET:
  // opened as a page, in other spellings of the path, on Hub's placeholder.
  for (const row of CLOSED_ROWS.filter((entry) => entry.methods.includes(ANY_METHOD))) {
    const path = row.example;
    await probe(`closed read, opened as a page: ${path}`, "closed", "GET", `${api(path)}?token=abc`, "page");
    for (const spelling of [`${path}/`, path.toUpperCase(), path.replaceAll("/", "//"), `${path.slice(0, -1)}%${path.charCodeAt(path.length - 1).toString(16)}`, path.replace(/\/(?=[^/]*$)/, "%2F")]) {
      await probe(`closed read, spelled ${spelling}`, "closed", "GET", api(spelling), "fetch");
    }
    await probe(`closed read, spelled ${path.toUpperCase()}, opened as a page`, "closed", "GET", api(path.toUpperCase()), "page");
    await probe(`closed read, on the placeholder host: ${path}`, "closed", "GET", `https://${API_HOST}${PLACEHOLDER_SUFFIX}${API_BASE}${path}`, "fetch");
    // Another path is a read like any other.
    await probe(`open: not the closed read ${path}d`, "open", "GET", api(`${path}d`), "fetch");
  }
  // The same from a click, and on Hub's placeholder host.
  for (const row of CLOSED_ROWS.slice(0, 6)) await probe(`closed, a posted form: ${row.template}`, "closed", "POST", api(row.example), "form");
  await probe("closed, on the placeholder host", "closed", "POST", `https://${API_HOST}${PLACEHOLDER_SUFFIX}${API_BASE}${CLOSED_ROWS[0].example}`, "fetch");
  // The general closures (spec §2.4, §2.1).
  for (const closure of GENERAL_CLOSURES) {
    for (const example of closure.examples) {
      const how = example.type === "websocket" ? "socket" : example.type === "main_frame" ? "form" : example.url.startsWith("http:") || closure.rule === "local" ? "plain" : "fetch";
      // Chrome makes no-cors requests only with GET, HEAD and POST.
      await probe(`${closure.rule}: ${example.method} ${example.url}`, "closed", example.method, example.url, how);
    }
  }
  await probe("api_writes: an unknown write, a posted form", "closed", "POST", api("/pb-unknown-write"), "form");
  // What the extension lets through.
  const reads = ["messaging.groups", "group.detail", "account.me", "followers.page", "post.replies"].map((route) => CATALOGUE_ROWS.find((row) => row.route === route));
  for (const row of [...reads, ...LOGIN_SCREEN_ROWS]) await probe(`open: GET ${row.template} → ${row.route}`, "open", "GET", api(sample(row.template)), "fetch");
  await probe("open: an API read outside the catalogue", "open", "GET", api("/mediastories/following"), "fetch");
  await probe("open: an API read with an escape a client writes (a non-ASCII letter)", "open", "GET", api("/pb-check/%D0%B0"), "fetch");
  await probe("open: an API read opened as a page", "open", "GET", api("/account/me"), "page");
  await probe("open: a preflight", "open", "OPTIONS", api("/account/me"), "fetch");
  for (const row of LOGIN_ROWS) await probe(`open: POST ${row.template} → ${row.route}`, "open", "POST", api(row.template), "fetch");
  // A write opened by its body: through to the operator in its exact
  // spelling from a script (with the site's query, and with this check's
  // mark: any query goes to the operator, which judges it); nothing else.
  for (const row of CHECKED_ROWS) {
    const path = row.example;
    await probe(`open: POST ${path} to the operator's check (${row.check})`, "open", "POST", api(path), "fetch");
    await probe(`open: POST ${path}?ngsw-bypass=true to the operator's check (${row.check})`, "open", "POST", `${api(path)}?ngsw-bypass=true`, "fetch");
    for (const spelling of [`${path}/`, path.toUpperCase(), path.replaceAll("/", "//"), `${path.slice(0, -1)}%${path.charCodeAt(path.length - 1).toString(16)}`]) {
      await probe(`checked: POST, spelled ${spelling}`, "closed", "POST", api(spelling), "fetch");
    }
    for (const method of ["PUT", "PATCH", "DELETE"]) await probe(`checked: ${method} ${path}`, "closed", method, api(path), "fetch");
    await probe(`checked: POST ${path}, a posted form`, "closed", "POST", api(path), "form");
    await probe(`checked: POST ${path}, on the placeholder host`, "closed", "POST", `https://${API_HOST}${PLACEHOLDER_SUFFIX}${API_BASE}${path}`, "fetch");
  }
  await probe("open: the site's socket", "open", "GET", `wss://${SOCKET_HOST}/?v=3`, "socket");
  await probe("open: the site's own host", "open", "GET", "https://fansly.com/assets/pb-check.js", "fetch");
  await probe("open: the media CDN", "open", "GET", "https://cdn3.fansly.com/pb-check.jpg", "fetch");
  await probe("open: a third-party host, a read", "open", "GET", "https://www.googletagmanager.com/gtm.js", "fetch");
  await probe("open: a third-party host, a write", "open", "POST", "https://www.google-analytics.com/g/collect", "fetch");
  await probe("open: plain HTTP to a public host reaches the proxy", "open", "GET", "http://pb-check.example.com/", "plain");
  await probe("open: Hub's request on the placeholder host, with its mark", "open", "GET", `https://${API_HOST}${PLACEHOLDER_SUFFIX}${API_BASE}/account/me`, "fetch", "#hub-77");
  // The self-test's own probes, as the operator sends them (src/selftest/):
  // a fragment marks each.
  await probe("closed: the self-test's read mark", "closed", "POST", `https://${API_HOST}${NEVER_PATH}`, "fetch", "#pb-selftest-check-never0");
  await probe("api_writes: the self-test's unknown write", "closed", "POST", `https://${API_HOST}${UNKNOWN_WRITE_PATH}`, "fetch", "#pb-selftest-check-write0");
  await probe("open: the self-test's permitted probe", "open", "GET", api("/pb-selftest"), "fetch", "#pb-selftest-check-exit");

  // With an interception in place, as the operator's: what the extension
  // cancels never reaches it — the self-test tells the two layers apart by
  // that — and what the extension lets through does.
  const paused = [];
  const intercept = (message) => {
    if (message.method !== "Fetch.requestPaused" || message.sessionId !== site.sessionId) return;
    paused.push(message.params.request.url);
    void cdp.send("Fetch.failRequest", { requestId: message.params.requestId, errorReason: "Failed" }, site.sessionId).catch(() => undefined);
  };
  cdp.listeners.add(intercept);
  await cdp.send("Fetch.enable", { patterns: [{ urlPattern: "*" }] }, site.sessionId);
  const reached = async (method, url) => {
    const sent = await request(method, url, "fetch", "#pb-selftest-check");
    return { ...sent, paused: paused.some((seenUrl) => new RegExp(`[?&]pbrc=${sent.mark}($|&)`).test(seenUrl)) };
  };
  const never = await reached("POST", `https://${API_HOST}${NEVER_PATH}`);
  const write = await reached("POST", `https://${API_HOST}${UNKNOWN_WRITE_PATH}`);
  const read = await reached("GET", api("/pb-selftest"));
  await cdp.send("Fetch.disable", {}, site.sessionId);
  cdp.listeners.delete(intercept);
  check("cancelled_before_the_interception", never.blocked && !never.paused && write.blocked && !write.paused && read.paused && read.left.length === 0, {
    never: { paused: never.paused, errors: never.errors, left: never.left },
    write: { paused: write.paused, errors: write.errors, left: write.left },
    read: { paused: read.paused, errors: read.errors, left: read.left },
  });

  const failed = results.filter((result) => !result.pass);
  const named = (pattern) => results.filter((result) => pattern.test(result.name));
  check("closed_one_by_one", named(/^closed/).every((result) => result.pass), { probes: named(/^closed/).length });
  const closedReads = named(/^closed(: (GET|HEAD|OPTIONS) | read)/);
  check("closed_reads", closedReads.length >= 40 && closedReads.every((result) => result.pass), {
    probes: closedReads.length,
    // One row's probes in full, as a sample of what each showed.
    sample: closedReads.filter((result) => result.url.includes("/emails/") || result.url.includes("/EMAILS/")).map((result) => ({ name: result.name, how: result.how, errors: result.errors, left: result.left })),
  });
  // The read mark by a row of its own is every chat's: `/message/ack` itself
  // goes to the operator's check of its body (owner decision 2026-10-23).
  check("row_6_read_typing_status_unknown_write", [/^closed: POST \/message\/ack\/all /, /^closed: POST \/message\/typing /, /^closed: POST \/status /, /^api_writes: POST .*pb-unknown-write$/].every((pattern) => named(pattern).length === 1 && named(pattern)[0].pass), {
    probes: [/^closed: POST \/message\/ack\/all /, /^closed: POST \/message\/typing /, /^closed: POST \/status /, /^api_writes: POST .*pb-unknown-write$/].flatMap((pattern) => named(pattern)).map((result) => ({ name: result.name, errors: result.errors, left: result.left })),
  });
  check("checked_exact_only", named(/to the operator's check/).length === CHECKED_ROWS.length * 2 && named(/to the operator's check|^checked: /).every((result) => result.pass), {
    probes: named(/to the operator's check|^checked: /).map((result) => ({ name: result.name, errors: result.errors, left: result.left })),
  });
  check("general_closures", named(/^(api_writes|api_spelling|fansly_writes|closed_hosts|socket_host|local)/).every((result) => result.pass), { probes: named(/^(api_writes|api_spelling|fansly_writes|closed_hosts|socket_host|local)/).length });
  check("open_left_open", named(/^open/).every((result) => result.pass), { probes: named(/^open/).length });
  report.probes = { total: results.length, failed };
  // Everything Chrome brought the listener, besides the probes' own: its
  // own service traffic (journaled by the proxy in production).
  // ── 5. no window without the extension; TLS only (spec §8.1) ──────────
  // The policies as Chrome applied them: by name and value (the words of
  // the other columns follow the page's language).
  const policyFile = JSON.parse(readFileSync(POLICY, "utf8"));
  const shown = await policyRows(cdp);
  const wanted = ["IncognitoModeAvailability", "BrowserGuestModeEnabled", "BrowserAddPersonEnabled", "HttpsOnlyMode"];
  const applied = Object.fromEntries(wanted.map((name) => [name, shown.get(name) ?? null]));
  const appliedOk = wanted.every((name) => name in policyFile && applied[name] !== null && applied[name] === JSON.stringify(policyFile[name]).replace(/^"|"$/g, ""));
  // Ctrl+Shift+N, as a person on the owner's screen presses it: no new
  // window may open, in no other browser context (Incognito runs without
  // extensions). Without the policy it opens one (seen on Chrome 155).
  const { targetInfos: before } = await cdp.send("Target.getTargets");
  const home = before.find((target) => target.targetId === site.targetId);
  await cdp.send("Page.bringToFront", {}, site.sessionId);
  for (const type of ["rawKeyDown", "keyUp"]) await cdp.send("Input.dispatchKeyEvent", { type, modifiers: 2 | 8, key: "N", code: "KeyN", windowsVirtualKeyCode: 78, nativeVirtualKeyCode: 78 }, site.sessionId);
  await sleep(2000);
  const { targetInfos: after } = await cdp.send("Target.getTargets");
  const opened = after.filter((target) => target.type === "page" && !before.some((known) => known.targetId === target.targetId));
  check("no_window_without_the_extension", appliedOk && opened.length === 0, {
    applied,
    opened: opened.map((target) => ({ url: target.url, otherContext: target.browserContextId !== home?.browserContextId })),
  });

  // An http:// navigation to a public host is upgraded to https; when
  // https fails, Chrome stops on its warning — no plain request leaves.
  {
    const tab = await cdp.tab("about:blank");
    const from = listener.lines.length;
    await cdp.send("Page.navigate", { url: "http://pb-check-http.example.com/start" }, tab.sessionId).catch(() => undefined);
    await waitFor(() => listener.lines.slice(from).some((line) => line.includes("pb-check-http.example.com")), 5000, 50);
    await sleep(1500);
    const lines = listener.lines.slice(from).filter((line) => line.includes("pb-check-http.example.com"));
    const location = await cdp.evaluate(tab.sessionId, "location.href").catch((error) => String(error));
    await cdp.send("Target.closeTarget", { targetId: tab.targetId }).catch(() => undefined);
    check("http_navigation_upgraded", lines.length > 0 && lines.every((line) => line.startsWith("CONNECT pb-check-http.example.com:443 ")), { lines, location });
  }

  report.listener = { lines: listener.lines.length, hosts: [...new Set(listener.lines.map((line) => line.split(" ")[1]))].sort() };
  cdp.close();
} catch (error) {
  check("ran", false, { error: String(error?.stack ?? error) });
} finally {
  // As a standing page is: Chrome down, the operator up.
  try {
    if (chromeStarted) {
      svc("-d", CHROME);
      await waitFor(chromeGone, 8000);
    }
    if (listener) await listener.close();
    if (operatorStopped) svc("-u", OPERATOR);
    check("left_as_found", chromeGone() && (!operatorStopped || (await waitFor(() => isUp(OPERATOR), 5000))), {});
  } catch (error) {
    check("left_as_found", false, { error: String(error) });
  }
}

report.pass = Object.values(report.checks).every((result) => result.pass);
console.log(JSON.stringify(report, null, 2));
process.exit(report.pass ? 0 : 1);
