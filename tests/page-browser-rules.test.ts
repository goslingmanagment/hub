import { describe, expect, it, vi } from "vitest";

import { FETCH_PATTERNS } from "../apps/page-browser/src/cdp/control.ts";
import { PLACEHOLDER_SUFFIX } from "../apps/page-browser/src/hub-requests/page.ts";
import { ANY_METHOD, API_BASE, API_HOST, CATALOGUE_ROWS, CHECKED_ROWS, checkedRowAt, CLOSED_ROWS, decide, GENERAL_CLOSURES, LOGIN_ROWS, LOGIN_SCREEN_ROWS, PLAIN_ESCAPES, SECRET_READ_ROWS, type ApiRow, type MapDecision } from "../apps/page-browser/src/policy/operations.ts";
import { buildRules, PRIORITY, REGEX_BUDGET, regexCost } from "../apps/page-browser/src/policy/rules.ts";
import { dnrBlocks, dnrMatches, dnrRule, fetchPatternMatches, type DnrRequest } from "./helpers/page-browser-dnr.ts";

// The rules extension's rules (Project Browser plan §4.6, spec §2.7; stage
// 3, PR 6), built from the map of operations, and the identity test: the
// extension and the operator's table close one set — no request the map
// closes leaves the browser, without the operator too. The model of Chrome's
// matching is tests/helpers/page-browser-dnr.ts; the real Chrome is asked on
// the stand (apps/page-browser/stand/rules-check.mjs).

/** A hang guard, not a speed check: the identity tests compare the two
 *  layers over tens of thousands of requests — about 6 s of CPU on an idle
 *  machine, past the default 30 s on a loaded CI one (the owner's PC). */
vi.setConfig({ testTimeout: 120_000 });

const rules = buildRules();
const level = (priority: number) => rules.filter((rule) => rule.priority === priority);
const api = (path: string) => `https://${API_HOST}${API_BASE}${path}`;
const placeholder = (path: string) => `https://${API_HOST}${PLACEHOLDER_SUFFIX}${API_BASE}${path}`;
const sample = (template: string) => template.replace(/(:[A-Za-z_]\w*|\{[A-Za-z_]\w*\})/g, "123");
/** The methods a row closes, an "every method" row by these. */
const methodsOf = (row: ApiRow) => (row.methods.includes(ANY_METHOD) ? ["GET", "HEAD", "OPTIONS", "POST", "PUT", "PATCH", "DELETE", "PROPFIND"] : [...row.methods]);
const closedReads = CLOSED_ROWS.filter((row) => row.methods.includes(ANY_METHOD));
/** CDP's resource type of a request of DNR's type (a script's by default). */
const cdpType = (type: string | undefined) => ({ websocket: "WebSocket", main_frame: "Document", sub_frame: "Document", ping: "Ping", other: "Other", script: "Script", image: "Image" })[type ?? "xmlhttprequest"] ?? "XHR";
/** Whether Fetch stops the request for the operator (FETCH_PATTERNS). */
const fetchStops = (url: string) => FETCH_PATTERNS.some((pattern) => fetchPatternMatches(pattern.urlPattern, url));
/** The map closes it: in both modes, whatever the operator's mode. */
const mapCloses = (request: DnrRequest): boolean => {
  const decisions = (["automation", "manual_login"] as const).map((mode) => decide({ method: request.method, url: request.url, resourceType: cdpType(request.type) }, mode));
  const closed = (decision: MapDecision) => decision.action === "refuse" && decision.refusal !== "mode";
  expect(closed(decisions[0]!), `${request.method} ${request.url}: closed the same in both modes`).toBe(closed(decisions[1]!));
  return closed(decisions[0]!);
};

describe("the rules", () => {
  it("are the levels of the spec, strictly apart, ids from 1", () => {
    expect(rules.map((rule) => rule.id)).toEqual(rules.map((_, index) => index + 1));
    expect([...new Set(rules.map((rule) => rule.priority))]).toEqual([400, 350, 300, 275, 250, 200, 100]);
    expect(PRIORITY).toEqual({ closed: 400, spelling: 350, login: 300, checked: 275, open: 250, general: 200, local: 100 });
    // At equal priority DNR prefers allow: no level mixes the two.
    for (const priority of new Set(rules.map((rule) => rule.priority))) expect(new Set(level(priority).map((rule) => rule.action.type)).size, String(priority)).toBe(1);
    expect(level(400).every((rule) => rule.action.type === "block")).toBe(true);
    expect(level(350).every((rule) => rule.action.type === "block")).toBe(true);
    expect(level(300).every((rule) => rule.action.type === "allow")).toBe(true);
    expect(level(275).every((rule) => rule.action.type === "allow")).toBe(true);
    expect(level(250).every((rule) => rule.action.type === "allow")).toBe(true);
    expect(level(200).every((rule) => rule.action.type === "block")).toBe(true);
    expect(level(100).every((rule) => rule.action.type === "block")).toBe(true);
    expect(level(400)).toHaveLength(CLOSED_ROWS.length * 2);
    expect(level(300)).toHaveLength(LOGIN_ROWS.length);
    expect(level(275)).toHaveLength(CHECKED_ROWS.length);
  });

  it("open exactly: allow rules are case-sensitive and anchored to HTTPS, the host as it is, no port, no user; the login and the delivered mark only on the real host", () => {
    for (const rule of [...level(300), ...level(275), ...level(250)]) {
      expect(rule.condition.isUrlFilterCaseSensitive, String(rule.id)).toBe(true);
      expect(rule.condition.regexFilter, String(rule.id)).toMatch(/^\^(https|wss):\/\/[a-z0-9\\.-]+\/.*\$$/);
    }
    for (const rule of [...level(400), ...level(350), ...level(200), ...level(100)]) expect(rule.condition.isUrlFilterCaseSensitive, String(rule.id)).toBe(false);
    expect(level(300).map((rule) => rule.condition.regexFilter)).toEqual(["^https://apiv3\\.fansly\\.com/api/v1/login/?([?#].*)?$", "^https://apiv3\\.fansly\\.com/api/v1/login/twofa/?([?#].*)?$"]);
    expect(level(300).every((rule) => JSON.stringify(rule.condition.requestMethods) === '["post"]')).toBe(true);
    // The delivered mark: no trailing slash — Fetch stops the path as it is —
    // a script's POST only.
    expect(level(275).map((rule) => [rule.condition.regexFilter, rule.condition.requestMethods, rule.condition.resourceTypes])).toEqual([["^https://apiv3\\.fansly\\.com/api/v1/message/ack([?#].*)?$", ["post"], ["xmlhttprequest"]]]);
    for (const row of CHECKED_ROWS) {
      expect(dnrBlocks(rules, { method: "POST", url: api(row.template) }), row.template).toBe(false);
      expect(dnrBlocks(rules, { method: "POST", url: placeholder(row.template) }), row.template).toBe(true);
    }
    expect(level(250).map((rule) => [rule.condition.regexFilter, rule.condition.requestMethods])).toEqual([
      ["^https://apiv3\\.fansly\\.com/api/v1(/[^?#]*)?([?#].*)?$", ["get", "options"]],
      ["^https://apiv3\\.fansly\\.com\\.pb-hold\\.invalid/api/v1(/[^?#]*)?([?#].*)?$", ["get", "options"]],
      ["^wss://wsv3\\.fansly\\.com/([?#].*)?$", undefined],
    ]);
    // Hub never logs in: its placeholder host gets no login.
    for (const row of LOGIN_ROWS) {
      expect(dnrBlocks(rules, { method: "POST", url: api(row.template) }), row.template).toBe(false);
      expect(dnrBlocks(rules, { method: "POST", url: placeholder(row.template) }), row.template).toBe(true);
    }
  });
});

describe("the cost of an expression (Chrome drops a rule over its memory limit, without a word)", () => {
  it("keeps every rule within the budget, well under what Chrome 155 takes", () => {
    // Measured on the image's Chrome with isRegexSupported (stage 3, PR 6):
    // each of these is the longest of its kind Chrome compiles.
    const atTheLimit: Array<[string, string]> = [
      ["a digit class ×112", `^${"[0-9]".repeat(112)}$`],
      ["[^/?#@] ×16", `^${"[^/?#@]".repeat(16)}$`],
      ["[^/] ×37", `^${"[^/]".repeat(37)}$`],
      ["a dot ×37", `^${".".repeat(37)}$`],
      ["an optional letter ×56", `^${"a?".repeat(56)}$`],
      ["a literal with no anchor ×112", "a".repeat(112)],
    ];
    const limit = Math.min(...atTheLimit.map(([, regex]) => regexCost(regex, false)));
    for (const [name, regex] of atTheLimit) expect(regexCost(regex, false) - limit, name).toBeLessThanOrEqual(2);
    expect(limit).toBeGreaterThanOrEqual(114);
    expect(REGEX_BUDGET).toBeLessThanOrEqual(Math.floor(limit * 0.75));
    for (const rule of rules) expect(regexCost(rule.condition.regexFilter, rule.condition.isUrlFilterCaseSensitive), `${rule.id}: ${rule.condition.regexFilter}`).toBeLessThanOrEqual(REGEX_BUDGET);
    // The expressions Chrome did drop from this file's first rules (a closed
    // row with its hosts and their spellings in one expression): each is far
    // over the budget, so the build would have refused it.
    const origin = "^(https?|wss?)://([^/?#@]*@)?(apiv3\\.fansly\\.com|apiv3\\.fansly\\.com\\.pb-hold\\.invalid)\\.?(:[0-9]+)?";
    for (const dropped of ["/+api/+v1/+account/+emailchange(/[^?#]*)?/*([?#].*)?$", "/+api/+v1/+payments/+payoutmethods(/[^?#]*)?/*([?#].*)?$", "/+api/+v1/+login/+password[^/?#]*(/[^?#]*)?/*([?#].*)?$"]) {
      expect(regexCost(`${origin}${dropped}`, false), dropped).toBeGreaterThan(limit);
    }
    // A literal right after ^ is free (RE2 checks it apart); with an
    // alternative beside it, or after a repetition, it is not.
    expect(regexCost(`^${"a".repeat(300)}$`, false)).toBeLessThan(10);
    expect(regexCost(`^${"a".repeat(50)}|b`, false)).toBeGreaterThan(50);
    expect(regexCost(`^x+${"a".repeat(50)}$`, false)).toBeGreaterThan(50);
    // Case folding widens a class of letters.
    expect(regexCost("^x[a-z]", true)).toBeLessThan(regexCost("^x[a-z]", false));
  });

  it("is refused for what the estimate does not know, rather than guessed", () => {
    for (const regex of ["^a{2,3}$", "^(?:a)$", "^a**$", "^\\d+$", "^[a$", "^(a$", "^a)$", "^[]$"]) expect(() => regexCost(regex, false), regex).toThrow();
  });
});

describe("the identity of the two layers (spec §2.7)", () => {
  it("level 1 and the rows closed one by one are one set: each row's own two rules — the API host's and its placeholder's — by the row's methods", () => {
    const closedLevel = level(PRIORITY.closed);
    const hosts = [api, placeholder];
    const pairs: Array<[number, number]> = [];
    CLOSED_ROWS.forEach((row, rowIndex) => {
      hosts.forEach((on, hostIndex) => {
        closedLevel.forEach((rule, ruleIndex) => {
          if (dnrMatches(rule, { method: methodsOf(row)[0]!, url: on(row.example!) })) pairs.push([rowIndex * 2 + hostIndex, ruleIndex]);
        });
      });
    });
    // A bijection: every row on each host has exactly one rule, every rule
    // one row and one host.
    expect(pairs).toEqual(closedLevel.map((_, index) => [index, index]));
    expect(closedLevel).toHaveLength(CLOSED_ROWS.length * 2);
    CLOSED_ROWS.forEach((row, index) => {
      const every = row.methods.includes(ANY_METHOD);
      hosts.forEach((on, hostIndex) => {
        const rule = closedLevel[index * 2 + hostIndex]!;
        // A row of every method names none: DNR then takes them all.
        expect(rule.condition.requestMethods, row.template).toEqual(every ? undefined : row.methods.map((method) => method.toLowerCase()));
        expect(rule.condition.excludedRequestMethods, row.template).toBeUndefined();
        // The host as it is, right after the scheme: no other host's path.
        expect(rule.condition.regexFilter.startsWith(hostIndex === 0 ? "^https://apiv3\\.fansly\\.com/+api/+v1/+" : "^https://apiv3\\.fansly\\.com\\.pb-hold\\.invalid/+api/+v1/+"), rule.condition.regexFilter).toBe(true);
        for (const method of methodsOf(row)) expect(dnrMatches(rule, { method, url: on(row.example!) }), `${method} ${row.template}`).toBe(true);
        // Not by a method the row does not close, not on another host.
        expect(dnrMatches(rule, { method: "GET", url: on(row.example!) }), row.template).toBe(every);
        for (const other of [`https://fansly.com${API_BASE}${row.example!}`, `https://x.${API_HOST}${API_BASE}${row.example!}`, `https://${API_HOST}.evil.net${API_BASE}${row.example!}`]) {
          expect(dnrMatches(rule, { method: "POST", url: other }), other).toBe(false);
        }
      });
    });
    expect(closedReads.map((row) => row.template)).toEqual(["/emails/unsubscribe", "/account/verifynsfw", "/intercom/authorize", "/zendesk/authorize"]);
  });

  it("no login rule matches a closed row, and no closed rule a login operation", () => {
    for (const row of CLOSED_ROWS) {
      for (const method of [...row.methods, "GET", "OPTIONS"]) {
        for (const rule of level(PRIORITY.login)) expect(dnrMatches(rule, { method, url: api(row.example!) }), `${method} ${row.example}`).toBe(false);
      }
    }
    for (const row of LOGIN_ROWS) {
      for (const rule of level(PRIORITY.closed)) expect(dnrMatches(rule, { method: "POST", url: api(row.template) }), row.template).toBe(false);
      expect(dnrRule(rules, { method: "POST", url: api(row.template) })).toMatchObject({ priority: PRIORITY.login, action: { type: "allow" } });
    }
  });

  describe("the writes opened by their body (owner decision 2026-10-23): the extension lets through only what the operator stops and checks", () => {
    const row = CHECKED_ROWS[0]!;
    const path = row.example!;
    const exact = [api(path), `${api(path)}?ngsw-bypass=true`, `${api(path)}#x`, `${api(path)}?ngsw-bypass=true#x`];
    /** Paths the extension must cancel for a write: other spellings, an escape. */
    const spellings = [`${path}/`, `${path}//`, path.toUpperCase(), path.replace("ack", "Ack"), path.replaceAll("/", "//"), `/${path}`, `${path.slice(0, -1)}%6B`, `${path.slice(0, -1)}%6b`, path.replace(/\/(?=[^/]*$)/, "%2F"), `${path}%2F`];

    it("its exact spelling, from a script, goes to the operator — with the site's query, none, or any other, which the operator judges — and every such URL stops in Fetch", () => {
      for (const url of [...exact, `${api(path)}?type=3`, `${api(path)}?x=1&ngsw-bypass=true`, `${api(path)}?`]) {
        const request = { method: "POST", url };
        expect(dnrRule(rules, request), url).toMatchObject({ priority: PRIORITY.checked, action: { type: "allow" } });
        expect(fetchStops(url), `Fetch stops ${url}`).toBe(true);
        expect(checkedRowAt(url), url).toBe(row);
      }
      for (const url of exact) {
        for (const mode of ["automation", "manual_login"] as const) {
          for (const resourceType of ["XHR", "Fetch"]) expect(decide({ method: "POST", url, resourceType }, mode), `${mode} ${url} ${resourceType}`).toMatchObject({ action: "check", check: row.check });
        }
      }
      // A query the site never writes: through the extension, refused by the map.
      for (const url of [`${api(path)}?type=3`, `${api(path)}?x=1&ngsw-bypass=true`, `${api(path)}?`]) expect(mapCloses({ method: "POST", url }), url).toBe(true);
    });

    it("a write to its path in any other spelling, by another method, from a click, a frame or a beacon, or on Hub's placeholder is cancelled by the extension and refused by the map, in both modes", () => {
      const cancelled: DnrRequest[] = [
        ...spellings.flatMap((spelling) => ["POST", "PUT", "PATCH", "DELETE"].map((method) => ({ method, url: api(spelling) }))),
        ...["PUT", "PATCH", "DELETE"].flatMap((method) => exact.map((url) => ({ method, url }))),
        ...["main_frame", "sub_frame", "ping", "other"].flatMap((type) => exact.map((url) => ({ method: "POST", url, type }))),
        ...exact.map((url) => ({ method: "POST", url: url.replace(API_HOST, `${API_HOST}${PLACEHOLDER_SUFFIX}`) })),
        { method: "POST", url: `http://${API_HOST}${API_BASE}${path}` },
        { method: "POST", url: `https://${API_HOST}:8443${API_BASE}${path}` },
        { method: "POST", url: `https://user@${API_HOST}${API_BASE}${path}` },
        { method: "POST", url: `https://${API_HOST}.${API_BASE}${path}` },
        { method: "POST", url: `https://${API_HOST}/API/v1${path}` },
        { method: "POST", url: `https://${API_HOST}//api/v1${path}` },
      ];
      for (const request of cancelled) {
        const what = `${request.method} ${request.url} (${request.type ?? "xmlhttprequest"})`;
        expect(dnrBlocks(rules, request), what).toBe(true);
        expect([PRIORITY.spelling, PRIORITY.general]).toContain(dnrRule(rules, request)!.priority);
        expect(mapCloses(request), what).toBe(true);
      }
      // The read mark of every chat stays a closed row of its own.
      for (const method of ["POST", "PUT", "PATCH", "DELETE"]) expect(dnrRule(rules, { method, url: api(`${path}/all`) }), method).toMatchObject({ priority: PRIORITY.closed, action: { type: "block" } });
    });

    it("its reads stay reads and its preflight a preflight; no closed, login or other rule opens or closes its exact spelling, and it opens nothing else", () => {
      for (const method of ["GET", "OPTIONS"]) {
        for (const url of exact) {
          expect(dnrRule(rules, { method, url }), `${method} ${url}`).toMatchObject({ priority: PRIORITY.open, action: { type: "allow" } });
          expect(mapCloses({ method, url }), `${method} ${url}`).toBe(false);
        }
      }
      expect(dnrBlocks(rules, { method: "HEAD", url: exact[0]! })).toBe(true);
      for (const url of exact) {
        for (const rule of [...level(PRIORITY.closed), ...level(PRIORITY.spelling), ...level(PRIORITY.login)]) expect(dnrMatches(rule, { method: "POST", url }), `${rule.id} ${url}`).toBe(false);
      }
      for (const rule of level(PRIORITY.checked)) {
        for (const closedRow of CLOSED_ROWS) {
          for (const method of [...closedRow.methods, "GET", "OPTIONS", "POST"].filter((one) => one !== ANY_METHOD)) expect(dnrMatches(rule, { method, url: api(closedRow.example!) }), `${method} ${closedRow.example}`).toBe(false);
        }
        for (const loginRow of LOGIN_ROWS) expect(dnrMatches(rule, { method: "POST", url: api(loginRow.template) }), loginRow.template).toBe(false);
        for (const other of ["/message/acks", "/message/acknowledge", "/message/ack.json", "/message", "/message/typing", "/notifications/ack"]) expect(dnrMatches(rule, { method: "POST", url: api(other) }), other).toBe(false);
      }
    });

    it("Fetch stops nothing of the site's but what is on the checked path: the rest goes as a browser's", () => {
      const ours = FETCH_PATTERNS.filter((pattern) => !pattern.urlPattern.includes(PLACEHOLDER_SUFFIX) && pattern.urlPattern !== "*?pbst=*");
      expect(ours.map((pattern) => pattern.urlPattern)).toEqual(["https://apiv3.fansly.com/api/v1/message/ack", "https://apiv3.fansly.com/api/v1/message/ack\\?*"]);
      expect(FETCH_PATTERNS.every((pattern) => pattern.requestStage === "Request")).toBe(true);
      const elsewhere = [
        api(`${path}/`),
        api(`${path}/all`),
        api(`${path}/all?ngsw-bypass=true`),
        api(`${path}s`),
        api(`${path}X?q=1`),
        api(path.toUpperCase()),
        api("/message?ngsw-bypass=true"),
        api("/account/me?ngsw-bypass=true"),
        `https://${API_HOST}//api/v1${path}`,
        `https://fansly.com${API_BASE}${path}`,
        `https://x.${API_HOST}${API_BASE}${path}`,
        "https://fansly.com/",
        "https://cdn3.fansly.com/a.jpg?ack=1",
      ];
      for (const url of elsewhere) {
        expect(ours.some((pattern) => fetchPatternMatches(pattern.urlPattern, url)), url).toBe(false);
        expect(checkedRowAt(url), url).toBeNull();
      }
    });
  });

  it("every closed row has an example, and both layers cancel it in both modes — by every method, from a script and from a click", () => {
    for (const row of CLOSED_ROWS) {
      expect(row.example, row.template).toBeTruthy();
      for (const method of methodsOf(row)) {
        for (const type of ["xmlhttprequest", "main_frame", "sub_frame", "ping", "other"]) {
          const request = { method, url: api(row.example!), type };
          expect(dnrRule(rules, request), `${method} ${row.example} ${type}`).toMatchObject({ priority: PRIORITY.closed, action: { type: "block" } });
          expect(mapCloses(request), `${method} ${row.example}`).toBe(true);
        }
        for (const mode of ["automation", "manual_login"] as const) {
          expect(decide({ method, url: api(row.example!) }, mode), `${mode} ${method} ${row.example}`).toMatchObject({ action: "refuse", refusal: "closed" });
        }
      }
    }
  });

  it("every general closure's example is cancelled by both layers in both modes", () => {
    for (const closure of GENERAL_CLOSURES) {
      for (const example of closure.examples) {
        const request: DnrRequest = { method: example.method, url: example.url, ...(example.type ? { type: example.type } : {}) };
        const what = `${closure.rule}: ${example.method} ${example.url}`;
        expect(dnrBlocks(rules, request), what).toBe(true);
        expect(dnrRule(rules, request)?.priority, what).toBe(closure.rule === "local" ? PRIORITY.local : closure.rule === "api_spelling" ? PRIORITY.spelling : PRIORITY.general);
        expect(mapCloses(request), what).toBe(true);
      }
    }
  });

  it("what the map opens the extension lets through: reads, preflights, the login, the delivered mark to its check, the socket, static and third-party hosts", () => {
    const open: DnrRequest[] = [
      ...CATALOGUE_ROWS.map((row) => ({ method: "GET", url: api(sample(row.template)) })),
      ...CATALOGUE_ROWS.map((row) => ({ method: "GET", url: `${api(sample(row.template))}?ngsw-bypass=true&limit=20` })),
      ...LOGIN_SCREEN_ROWS.map((row) => ({ method: "GET", url: api(row.template) })),
      // The secret reads: the site's settings screens read them (their
      // answers are not kept, which is the operator's, not the extension's).
      ...SECRET_READ_ROWS.map((row) => ({ method: "GET", url: api(row.example!) })),
      ...LOGIN_ROWS.map((row) => ({ method: "POST", url: api(row.template) })),
      // On to the operator's check of its body.
      ...CHECKED_ROWS.map((row) => ({ method: "POST", url: `${api(row.template)}?ngsw-bypass=true` })),
      { method: "GET", url: api("/mediastories/following") },
      { method: "GET", url: api("") },
      { method: "OPTIONS", url: api("/message") },
      { method: "GET", url: "wss://wsv3.fansly.com/?v=3", type: "websocket" },
      { method: "GET", url: "https://fansly.com/", type: "main_frame" },
      { method: "GET", url: "https://fansly.com/main.abc.js", type: "script" },
      { method: "HEAD", url: "https://cdn3.fansly.com/a.jpg" },
      { method: "GET", url: "https://leaderboard.fansly.com/x" },
      { method: "GET", url: "https://www.googletagmanager.com/gtm.js", type: "script" },
      { method: "POST", url: "https://www.google-analytics.com/g/collect", type: "ping" },
      { method: "PUT", url: "https://api-iam.intercom.io/messenger/web/ping" },
      { method: "GET", url: "wss://nexus-websocket-a.intercom.io/pubsub/x", type: "websocket" },
      { method: "GET", url: "https://update.googleapis.com/service/update2/json" },
      { method: "GET", url: "https://1.1.1.1/" },
      { method: "GET", url: "https://[2606:4700:4700::1111]/" },
      { method: "GET", url: "https://198.20.0.1/" },
      { method: "GET", url: "https://[64:ff9b::808:808]/" },
    ];
    for (const request of open) {
      const what = `${request.method} ${request.url}`;
      expect(dnrBlocks(rules, request), what).toBe(false);
      expect(mapCloses(request), what).toBe(false);
    }
  });

  it("a closed read is closed in every spelling Chrome can issue of it — level 250 would open any other — and no other read is", () => {
    // Level 250 opens a GET under /api/v1 whatever its path: nothing but
    // level 1 and the escapes' level stands before a closed read.
    expect(level(PRIORITY.spelling).map((rule) => rule.condition.regexFilter)).toEqual([`^https://apiv3\\.fansly\\.com/[^?#]*%(${PLAIN_ESCAPES})`, `^https://apiv3\\.fansly\\.com\\.pb-hold\\.invalid/[^?#]*%(${PLAIN_ESCAPES})`]);
    // Every method, every type: nothing in the condition but the expression.
    for (const rule of level(PRIORITY.spelling)) expect(Object.keys(rule.condition).sort()).toEqual(["isUrlFilterCaseSensitive", "regexFilter", "resourceTypes"]);
    const hex = (char: string, upper: boolean) => `%${char.charCodeAt(0).toString(16)[upper ? "toUpperCase" : "toLowerCase"]()}`;
    for (const row of closedReads) {
      const path = row.example!;
      const letters = [...path].map((char, index) => ({ char, index })).filter(({ char }) => /[a-z]/.test(char));
      const spellings = [
        path,
        `${path}/`,
        `${path}//`,
        `${path}?token=abc`,
        `${path}?ngsw-bypass=true#x`,
        `${path}#x`,
        path.toUpperCase(),
        path.replace(/[aeiou]/g, (vowel) => vowel.toUpperCase()),
        path.replaceAll("/", "//"),
        path.replaceAll("/", "///"),
        // Each letter of the path escaped in turn, in either case of the
        // letter and of the hex digits; each slash escaped.
        ...letters.flatMap(({ char, index }) => [false, true].flatMap((upper) => [char, char.toUpperCase()].map((letter) => `${path.slice(0, index)}${hex(letter, upper)}${path.slice(index + 1)}`))),
        path.replace(/\/(?=[^/]*$)/, "%2F"),
        path.replace(/\/(?=[^/]*$)/, "%2f"),
        `${path}%2F`,
        [...path].map((char) => (char === "/" ? char : hex(char, true))).join(""),
      ];
      expect(spellings.length).toBeGreaterThan(60);
      for (const spelling of spellings) {
        for (const method of ["GET", "HEAD", "OPTIONS", "POST"]) {
          for (const [type, url] of [["xmlhttprequest", api(spelling)], ["main_frame", api(spelling)], ["xmlhttprequest", placeholder(spelling)]] as const) {
            const request = { method, url, type };
            expect(dnrBlocks(rules, request), `the extension: ${method} ${url} (${type})`).toBe(true);
            expect([PRIORITY.closed, PRIORITY.spelling, PRIORITY.general]).toContain(dnrRule(rules, request)!.priority);
            if (url.startsWith(`https://${API_HOST}/`)) expect(mapCloses(request), `the map: ${method} ${url}`).toBe(true);
          }
        }
      }
      // In its plain spellings it is its own row's rule that cancels a GET.
      for (const spelling of [path, `${path}/`, path.toUpperCase(), path.replaceAll("/", "//"), `${path}?token=abc`]) expect(dnrRule(rules, { method: "GET", url: api(spelling), type: "main_frame" })?.priority, spelling).toBe(PRIORITY.closed);
      // What is another path stays a read for both layers: a longer or a
      // shorter name, a segment more, a `;` suffix (to a server that drops
      // one it would be the closed path: Fansly's is not known to).
      for (const other of [`${path}d`, `${path}/extra`, `/x${path}`, path.slice(0, path.lastIndexOf("/")), `${path};x=1`, `${path}.json`]) {
        const request = { method: "GET", url: api(other) };
        expect(dnrBlocks(rules, request), other).toBe(false);
        expect(mapCloses(request), other).toBe(false);
      }
    }
    // An escape a client does write is no closed spelling, nor is an escape in the query.
    for (const path of ["/tag/%D0%B0%D0%B1", "/search/a%20b", "/x%2Cy", "/x%40y", "/x%25y", "/account?usernames=%61bc&next=%2Femails%2Funsubscribe"]) {
      const request = { method: "GET", url: api(path) };
      expect(dnrBlocks(rules, request), path).toBe(false);
      expect(mapCloses(request), path).toBe(false);
    }
  });
});
