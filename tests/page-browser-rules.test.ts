import { describe, expect, it } from "vitest";

import { PLACEHOLDER_SUFFIX } from "../apps/page-browser/src/hub-requests/page.ts";
import { ANY_METHOD, API_BASE, API_HOST, CATALOGUE_ROWS, CLOSED_ROWS, decide, GENERAL_CLOSURES, isLocalHost, LOGIN_ROWS, LOGIN_SCREEN_ROWS, PLAIN_ESCAPES, type ApiRow, type MapDecision } from "../apps/page-browser/src/policy/operations.ts";
import { buildRules, PRIORITY, REGEX_BUDGET, regexCost, RESOURCE_TYPES, rulesJson, type DnrRule } from "../apps/page-browser/src/policy/rules.ts";
import { NEVER_PATH, UNKNOWN_WRITE_PATH } from "../apps/page-browser/src/selftest/selftest.ts";
import { dnrBlocks, dnrMatches, dnrRule, type DnrRequest } from "./helpers/page-browser-dnr.ts";

// The rules extension's rules (Project Browser plan §4.6, spec §2.7; stage
// 3, PR 6), built from the map of operations, and the identity test: the
// extension and the operator's table close one set — no request the map
// closes leaves the browser, without the operator too. The model of Chrome's
// matching is tests/helpers/page-browser-dnr.ts; the real Chrome is asked on
// the stand (apps/page-browser/stand/rules-check.mjs).

const rules = buildRules();
const level = (priority: number) => rules.filter((rule) => rule.priority === priority);
const api = (path: string) => `https://${API_HOST}${API_BASE}${path}`;
const placeholder = (path: string) => `https://${API_HOST}${PLACEHOLDER_SUFFIX}${API_BASE}${path}`;
const sample = (template: string) => template.replace(/(:[A-Za-z_]\w*|\{[A-Za-z_]\w*\})/g, "123");
/** The methods a row closes, an "every method" row by these. */
const methodsOf = (row: ApiRow) => (row.methods.includes(ANY_METHOD) ? ["GET", "HEAD", "OPTIONS", "POST", "PUT", "PATCH", "DELETE", "PROPFIND"] : [...row.methods]);
const closedReads = CLOSED_ROWS.filter((row) => row.methods.includes(ANY_METHOD));
const cdpType = (type: string | undefined) => (type === "websocket" ? "WebSocket" : type === "main_frame" ? "Document" : "XHR");
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
    expect([...new Set(rules.map((rule) => rule.priority))]).toEqual([400, 350, 300, 250, 200, 100]);
    expect(PRIORITY).toEqual({ closed: 400, spelling: 350, login: 300, open: 250, general: 200, local: 100 });
    // At equal priority DNR prefers allow: no level mixes the two.
    for (const priority of new Set(rules.map((rule) => rule.priority))) expect(new Set(level(priority).map((rule) => rule.action.type)).size, String(priority)).toBe(1);
    expect(level(400).every((rule) => rule.action.type === "block")).toBe(true);
    expect(level(350).every((rule) => rule.action.type === "block")).toBe(true);
    expect(level(300).every((rule) => rule.action.type === "allow")).toBe(true);
    expect(level(250).every((rule) => rule.action.type === "allow")).toBe(true);
    expect(level(200).every((rule) => rule.action.type === "block")).toBe(true);
    expect(level(100).every((rule) => rule.action.type === "block")).toBe(true);
    expect(level(400)).toHaveLength(CLOSED_ROWS.length * 2);
    expect(level(300)).toHaveLength(LOGIN_ROWS.length);
  });

  it("name every resource type themselves — a posted form is a main frame, which DNR skips by default", () => {
    for (const rule of rules) {
      const socketOnly = rule.priority === PRIORITY.open && rule.condition.regexFilter.startsWith("^wss:");
      expect(rule.condition.resourceTypes, String(rule.id)).toEqual(socketOnly ? ["websocket"] : [...RESOURCE_TYPES]);
    }
    expect(RESOURCE_TYPES).toContain("main_frame");
    expect(dnrBlocks(rules, { method: "POST", url: api("/message/ack"), type: "main_frame" })).toBe(true);
    expect(dnrBlocks(rules, { method: "POST", url: api("/message/ack"), type: "ping" })).toBe(true);
  });

  it("open exactly: allow rules are case-sensitive and anchored to HTTPS, the host as it is, no port, no user; the login only on the real host", () => {
    for (const rule of [...level(300), ...level(250)]) {
      expect(rule.condition.isUrlFilterCaseSensitive, String(rule.id)).toBe(true);
      expect(rule.condition.regexFilter, String(rule.id)).toMatch(/^\^(https|wss):\/\/[a-z0-9\\.-]+\/.*\$$/);
    }
    for (const rule of [...level(400), ...level(350), ...level(200), ...level(100)]) expect(rule.condition.isUrlFilterCaseSensitive, String(rule.id)).toBe(false);
    expect(level(300).map((rule) => rule.condition.regexFilter)).toEqual(["^https://apiv3\\.fansly\\.com/api/v1/login/?([?#].*)?$", "^https://apiv3\\.fansly\\.com/api/v1/login/twofa/?([?#].*)?$"]);
    expect(level(300).every((rule) => JSON.stringify(rule.condition.requestMethods) === '["post"]')).toBe(true);
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

  it("give Hub's placeholder host what the API has: its reads, and every closed row", () => {
    expect(dnrBlocks(rules, { method: "GET", url: `${placeholder("/account/me")}?ngsw-bypass=true#hub-77` })).toBe(false);
    expect(dnrBlocks(rules, { method: "OPTIONS", url: placeholder("/account/me") })).toBe(false);
    for (const row of CLOSED_ROWS) for (const method of methodsOf(row)) expect(dnrRule(rules, { method, url: placeholder(row.example!) })?.priority, row.template).toBe(PRIORITY.closed);
    expect(dnrBlocks(rules, { method: "POST", url: placeholder("/anything") })).toBe(true);
    expect(dnrBlocks(rules, { method: "POST", url: `https://cdn3.fansly.com${PLACEHOLDER_SUFFIX}/x` })).toBe(true);
    expect(dnrBlocks(rules, { method: "GET", url: `https://cdn3.fansly.com${PLACEHOLDER_SUFFIX}/x.jpg` })).toBe(false);
  });

  it("cancel the self-test's two probes and let its permitted one through to the interception", () => {
    expect(dnrRule(rules, { method: "POST", url: `https://${API_HOST}${NEVER_PATH}?pbst=r1-never0#pb-selftest-r1-never0` })).toMatchObject({ priority: PRIORITY.closed, action: { type: "block" } });
    expect(dnrRule(rules, { method: "POST", url: `https://${API_HOST}${UNKNOWN_WRITE_PATH}?pbst=r1-write0#pb-selftest-r1-write0` })).toMatchObject({ priority: PRIORITY.general, action: { type: "block" } });
    expect(dnrBlocks(rules, { method: "GET", url: `https://${API_HOST}/api/v1/pb-selftest?pbst=r1-exit#pb-selftest-r1-exit` })).toBe(false);
  });

  it("are rules.json as Chrome reads it: an array of rules with nothing of ours in them", () => {
    const parsed = JSON.parse(rulesJson()) as DnrRule[];
    expect(parsed).toEqual(rules);
    for (const rule of parsed) {
      expect(Object.keys(rule).sort()).toEqual(["action", "condition", "id", "priority"]);
      for (const key of Object.keys(rule.condition)) expect(["regexFilter", "isUrlFilterCaseSensitive", "requestMethods", "excludedRequestMethods", "resourceTypes"]).toContain(key);
      expect(rule.condition.regexFilter).toMatch(/^[\x20-\x7e]+$/);
    }
    expect(rulesJson()).toBe(rulesJson());
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

  it("what the map opens the extension lets through: reads, preflights, the login, the socket, static and third-party hosts", () => {
    const open: DnrRequest[] = [
      ...CATALOGUE_ROWS.map((row) => ({ method: "GET", url: api(sample(row.template)) })),
      ...CATALOGUE_ROWS.map((row) => ({ method: "GET", url: `${api(sample(row.template))}?ngsw-bypass=true&limit=20` })),
      ...LOGIN_SCREEN_ROWS.map((row) => ({ method: "GET", url: api(row.template) })),
      ...LOGIN_ROWS.map((row) => ({ method: "POST", url: api(row.template) })),
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
      { method: "GET", url: "https://203.0.113.7/" },
      { method: "GET", url: "https://[2001:db8::1]/" },
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

  it("the two layers close one set over every spelling of host, scheme, method and path", () => {
    const hosts = [
      "apiv3.fansly.com",
      "apiv3.fansly.com.",
      "APIV3.FANSLY.COM",
      "user@apiv3.fansly.com",
      "user:pw@apiv3.fansly.com",
      "apiv3.fansly.com:444",
      "apiv3.fansly.com:443",
      "x.apiv3.fansly.com",
      "fansly.com",
      "fansly.com.",
      "www.fansly.com",
      "user@fansly.com",
      "fansly.com:8443",
      "cdn3.fansly.com",
      "wsv3.fansly.com",
      "wsv3.fansly.com.",
      "wsv3.fansly.com:444",
      "user@wsv3.fansly.com",
      "chatws.fansly.com",
      "chatws.fansly.com.",
      "x.chatws.fansly.com",
      "mediav2.fansly.com",
      "mediav2.fansly.com:8080",
      "notfansly.com",
      "fansly.com.evil.net",
      "apiv3.fansly.com.evil.net",
      "www.googletagmanager.com",
      "localhost",
      "localhost:9222",
      "a.localhost",
      "user@localhost",
      "printer.local",
      "db.internal",
      "intranet",
      "127.0.0.1",
      "127.0.0.1:3128",
      "10.230.0.2:7700",
      "172.16.0.1",
      "172.32.0.1",
      "192.168.0.1",
      "169.254.169.254",
      "100.64.0.1",
      "100.128.0.1",
      "0.0.0.0",
      "224.0.0.251",
      "203.0.113.7",
      "[::1]",
      "[::1]:3128",
      "[fd00::1]",
      "[fe80::1]",
      "[::ffff:127.0.0.1]",
      "[2001:db8::1]",
    ];
    const schemes = ["https", "http", "wss", "ws"];
    const methods = ["GET", "HEAD", "OPTIONS", "POST", "PUT", "PATCH", "DELETE", "PROPFIND"];
    const paths = [
      "/",
      "",
      "/?v=3",
      "/other",
      "/api/v1",
      "/api/v1/",
      "/api/v1/account/me",
      "/api/v1/account/me?ngsw-bypass=true",
      "/api/v1/account/me#f",
      "/api/v1//account/me",
      "/api/v1/mediastories/following",
      "/API/V1/account/me",
      "/api/v2/account/me",
      "/api/v1x",
      "/api/v1/login",
      "/api/v1/login/",
      "/api/v1/login//",
      "/api/v1/LOGIN",
      "/api/v1//login",
      "/api/v1/login/twofa",
      "/api/v1/login/twofa?x=1",
      "/api/v1/login/twofa/x",
      "/api/v1/login/password",
      "/api/v1/message/ack",
      "/api/v1/message/ack/",
      "/api/v1/MESSAGE/ACK",
      "//api//v1//message//ack",
      "/api/v1/message/typing",
      "/api/v1/status",
      "/api/v1/twofa/disable",
      "/api/v1/message",
      "/api/v1/message/like",
      "/api/v1/logout",
      "/api/v1/management/x",
      "/api/v1/thirdpartyconnect/providers",
      "/api/v1/payments/wallets",
      "/api/v1/payments/payout/requests",
      "/api/v1/emails/unsubscribe",
      "/api/v1/emails/unsubscribe/",
      "/api/v1/emails/unsubscribe?token=abc",
      "/api/v1/EMAILS/Unsubscribe",
      "/api/v1//emails//unsubscribe",
      "/api/v1/emails/%75nsubscribe",
      "/api/v1/emails%2Funsubscribe",
      "/api/v1/emails/unsubscribe;x=1",
      "/api/v1/emails/unsubscribed",
      "/api/v1/account/verifynsfw",
      "/api/v1/intercom/authorize",
      "/api/v1/zendesk/authorize#x",
      "/api/v1/account/%6De",
      "/api/v1/tag/%D0%B0",
      "/%61pi/v1/account/me",
      "/upload",
    ];
    let compared = 0;
    let closed = 0;
    for (const scheme of schemes) {
      for (const host of hosts) {
        for (const path of paths) {
          const url = `${scheme}://${host}${path}`;
          for (const method of methods) {
            const types = scheme.startsWith("ws") ? ["websocket"] : ["xmlhttprequest", "main_frame"];
            for (const type of types) {
              // A socket is a GET.
              if (type === "websocket" && method !== "GET") continue;
              const request = { method, url, type };
              const map = mapCloses(request);
              expect(dnrBlocks(rules, request), `${method} ${url} (${type}): the extension ${map ? "lets through what the map closes" : "cancels what the map opens"}`).toBe(map);
              compared += 1;
              if (map) closed += 1;
            }
          }
        }
      }
    }
    expect(compared).toBeGreaterThan(50_000);
    expect(closed).toBeGreaterThan(20_000);
    expect(compared - closed).toBeGreaterThan(10_000);
  });

  it("special-use names are the proxy's to refuse: the extension leaves them, so Hub's placeholder can be issued", () => {
    for (const host of ["x.invalid", "stand.test", "a.example", "x.onion"]) {
      expect(isLocalHost(host)).toBe(true);
      expect(mapCloses({ method: "GET", url: `https://${host}/` }), host).toBe(true);
      expect(dnrBlocks(rules, { method: "GET", url: `https://${host}/` }), host).toBe(false);
    }
  });
});
