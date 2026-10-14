import { describe, expect, it } from "vitest";

import {
  ANY_METHOD,
  API_BASE,
  API_HOST,
  API_ROWS,
  CATALOGUE_ROWS,
  classifyHost,
  CLOSED_ROWS,
  closedRowOf,
  closedSegments,
  decide,
  GENERAL_CLOSURES,
  HOST_ROWS,
  isLocalAddress,
  isLocalHost,
  LOGIN_ROWS,
  LOGIN_SCREEN_ROWS,
  OPEN_ROWS,
  parseTemplate,
  readRouteOf,
  SITE_OTHER_ROUTE,
  templateMatches,
  type MapDecision,
} from "../apps/page-browser/src/policy/operations.ts";
import { NEVER_PATH } from "../apps/page-browser/src/selftest/selftest.ts";
import { LOGIN_SCREEN_READS } from "../apps/runtime/src/sync/engine/site-admission.ts";
import { matchSiteRequest } from "../apps/runtime/src/sync/fansly/route-match.ts";
import { FANSLY_ROUTES } from "../apps/runtime/src/sync/fansly/routes.ts";

// The map of operations (Project Browser plan §4.6, spec §2, owner decision
// №2; stage 3, PR 6): one table for the operator and the rules extension.
// Here: the table itself, held to the engine's catalogue, and the operator's
// decisions from it. The extension's rules and the identity of the two
// layers: tests/page-browser-rules.test.ts.

const api = (path: string) => `https://${API_HOST}${API_BASE}${path}`;
const sample = (template: string) => template.replace(/(:[A-Za-z_]\w*|\{[A-Za-z_]\w*\})/g, "123");
const both = (method: string, url: string, resourceType?: string): [MapDecision, MapDecision] => [
  decide({ method, url, ...(resourceType ? { resourceType } : {}) }, "automation"),
  decide({ method, url, ...(resourceType ? { resourceType } : {}) }, "manual_login"),
];

describe("hosts (spec §2.1, decision №2)", () => {
  it("gives Fansly's hosts their roles, lets every other host the site loads through, and closes the second socket and the upload API", () => {
    expect(classifyHost("fansly.com")).toBe("site");
    expect(classifyHost("apiv3.fansly.com")).toBe("api");
    expect(classifyHost("APIV3.Fansly.com.")).toBe("api");
    expect(classifyHost("wsv3.fansly.com")).toBe("ws");
    expect(classifyHost("cdn3.fansly.com")).toBe("cdn");
    expect(classifyHost("cdn.fansly.com")).toBe("cdn");
    expect(classifyHost("chatws.fansly.com")).toBe("closed");
    expect(classifyHost("mediav2.fansly.com")).toBe("closed");
    // Any other host under fansly.com is Fansly's: through, writes closed.
    for (const host of ["www.fansly.com", "leaderboard.fansly.com", "evil-apiv3.fansly.com", "x.chatws.fansly.com"]) expect(classifyHost(host), host).toBe("site");
    // Not Fansly's: through the page's SOCKS5, journaled.
    for (const host of ["www.googletagmanager.com", "fonts.gstatic.com", "widget.intercom.io", "update.googleapis.com", "apiv3.fansly.com.evil.net", "notfansly.com", "1.1.1.1", "2606:4700:4700::1111"]) {
      expect(classifyHost(host), host).toBe("third_party");
    }
  });

  it("refuses local, private and special-use names — the placeholder of Hub's requests among them", () => {
    for (const host of ["localhost", "a.localhost", "printer.local", "db.internal", "router.home.arpa", "intranet", "127.0.0.1", "10.0.0.1", "172.16.5.4", "172.31.0.1", "192.168.1.1", "169.254.169.254", "100.64.0.1", "0.0.0.0", "224.0.0.1", "255.255.255.255", "::1", "[::1]", "::", "fd00::1", "fe80::1", "::ffff:7f00:1", "ff02::1", "", "192.0.0.8", "192.0.2.10", "198.18.0.1", "198.19.255.255", "198.51.100.9", "203.0.113.7", "2001:db8::1", "[2001:db8:85a3::8a2e:370:7334]", "100::1", "100::", "100:0:0:1::1", "2001:2::1", "3fff::1", "5f00::1", "2002:a00:1::1", "64:ff9b:1::a00:1", "192.88.99.2"]) {
      expect(isLocalAddress(host), host).toBe(true);
      expect(classifyHost(host), host).toBe("denied");
    }
    for (const host of ["apiv3.fansly.com.pb-hold.invalid", "x.test", "x.example", "x.onion", "x.alt"]) {
      expect(isLocalAddress(host), host).toBe(false);
      expect(isLocalHost(host), host).toBe(true);
      expect(classifyHost(host), host).toBe("denied");
    }
    for (const host of ["172.15.0.1", "172.32.0.1", "100.63.0.1", "100.128.0.1", "11.0.0.1", "223.255.255.1", "example.com", "local.example.com", "fe00::1", "192.0.1.1", "192.0.3.1", "198.17.0.1", "198.20.0.1", "198.51.101.1", "203.0.114.1", "2001:db9::1", "64:ff9b::808:808", "3fff:1000::1", "2001:200::1", "2606:4700:4700::1111"]) expect(isLocalHost(host), host).toBe(false);
  });

  it("has one row per host with a role, each with its source", () => {
    expect(HOST_ROWS.map((row) => `${row.host}=${row.cls}/${row.mode}`)).toEqual([
      "fansly.com=site/both",
      "apiv3.fansly.com=api/both",
      "wsv3.fansly.com=ws/automation",
      "cdn*.fansly.com=cdn/both",
      "chatws.fansly.com=closed/closed",
      "mediav2.fansly.com=closed/closed",
    ]);
    for (const row of HOST_ROWS) expect(row.source, row.host).not.toBe("");
  });
});

describe("the API rows and the engine's catalogue (spec §2.2–2.4)", () => {
  const engineReads = [...FANSLY_ROUTES.values()].filter((spec) => spec.host === "api" && spec.method === "GET" && !spec.template.startsWith("<"));

  it("are one set of (method, template, route) with the catalogue's API reads", () => {
    const ours = CATALOGUE_ROWS.map((row) => `${row.methods.join("|")} ${row.template} → ${row.route}`).sort();
    const theirs = engineReads.map((spec) => `${spec.method} ${spec.template} → ${spec.route}`).sort();
    expect(ours).toEqual(theirs);
    expect(ours).toHaveLength(59);
    expect(new Set(CATALOGUE_ROWS.map((row) => row.route)).size).toBe(59);
    // Both modes: the manual login lets the interface's reads through too (plan §4.8, PR 15).
    for (const row of CATALOGUE_ROWS) expect(row, row.template).toMatchObject({ mode: "both", platformData: true });
  });

  it("carry the login operations and the reads of the login screens the engine admits in the manual login", () => {
    const engineLogins = [...FANSLY_ROUTES.values()].filter((spec) => spec.method === "POST").map((spec) => `${spec.template} → ${spec.route}`).sort();
    expect(LOGIN_ROWS.map((row) => `${row.template} → ${row.route}`).sort()).toEqual(engineLogins);
    for (const row of LOGIN_ROWS) expect(row).toMatchObject({ methods: ["POST"], mode: "manual_login", platformData: false });
    expect(LOGIN_SCREEN_ROWS.map((row) => row.template).sort()).toEqual([...LOGIN_SCREEN_READS].sort());
    for (const row of LOGIN_SCREEN_ROWS) expect(row).toMatchObject({ methods: ["GET"], mode: "both", route: SITE_OTHER_ROUTE });
    expect(FANSLY_ROUTES.has(SITE_OTHER_ROUTE as never)).toBe(true);
    expect(OPEN_ROWS.map((row) => `${row.methods.join("|")} ${row.template} ${row.mode} ${row.route}`)).toEqual(["GET /** both site.other", "OPTIONS /** both null"]);
  });

  it("give every request the route the engine's own matcher gives it", () => {
    const paths = [
      ...engineReads.map((spec) => sample(spec.template)),
      ...engineReads.map((spec) => `${sample(spec.template)}/`),
      ...engineReads.map((spec) => `${sample(spec.template)}?ngsw-bypass=true&limit=10`),
      "/",
      "",
      "/account/me/extra",
      "/Account/Me",
      "/account//me",
      "//account/me",
      "/group",
      "/group/1/2",
      "/account/123/followersnew",
      "/account/me/followersnew",
      "/account/stats/media/top",
      "/post/9/replies",
      "/mediastories/following",
      "/versioning",
      "/device/id",
      "/timeline/home",
      "/login",
      "/login/twofa",
    ];
    for (const path of paths) {
      const engine = matchSiteRequest("api", "GET", `${API_BASE}${path}`);
      const route = engine.kind === "route" || engine.kind === "site_other" ? engine.route : null;
      expect(route, path).not.toBeNull();
      expect(readRouteOf(path || "/"), path).toBe(route);
      const decision = decide({ method: "GET", url: api(path) }, "automation");
      expect(decision, path).toMatchObject({ action: "admit", route, operation: "read" });
    }
    // A literal goes before a parameter: /account/me is not a followers page.
    expect(readRouteOf("/account/me")).toBe("account.me");
    expect(readRouteOf("/account/stats/media")).toBe("stats.media");
  });

  it("refuse and admit writes exactly as the engine's matcher does", () => {
    const paths = ["/login", "/login/", "/login/twofa", "/login/twofa/", "//login", "/login//", "/LOGIN", "/login/twofa/x", "/login/password", "/message", "/message/ack", "/status", "/account/me", "/post/1/delete", ""];
    for (const method of ["POST", "PUT", "PATCH", "DELETE", "HEAD", "TRACE"]) {
      for (const path of paths) {
        const engine = matchSiteRequest("api", method, `${API_BASE}${path}`);
        const decision = decide({ method, url: api(path) }, "manual_login");
        const what = `${method} ${path}`;
        if (engine.kind === "login") expect(decision, what).toMatchObject({ action: "admit", operation: "login", route: engine.route, platformData: false });
        else {
          expect(engine.kind, what).toBe("refused");
          expect(decision, what).toMatchObject({ action: "refuse", refusal: "closed" });
        }
      }
    }
    // Paths outside the API are no route for the engine, and closed here.
    for (const path of ["/", "/api/v2/account/me", "/api/v1x", "/API/V1/account/me"]) {
      expect(matchSiteRequest("api", "GET", path)).toEqual({ kind: "refused", reason: "not_api_path" });
      expect(decide({ method: "GET", url: `https://${API_HOST}${path}` }, "automation"), path).toMatchObject({ action: "refuse", refusal: "closed", rule: "api_writes" });
    }
  });
});

describe("the rows closed one by one (spec §2.5)", () => {
  const writes = ["POST", "PUT", "PATCH", "DELETE"];
  /** The methods a row closes, an "every method" row by these. */
  const methodsOf = (row: (typeof CLOSED_ROWS)[number]) => (row.methods.includes(ANY_METHOD) ? ["GET", "HEAD", "OPTIONS", "POST", "PUT", "PATCH", "DELETE", "PROPFIND"] : [...row.methods]);

  it("are the prototype's \"never\" list without the payouts: the writes by their four methods, four reads by every method", () => {
    expect(CLOSED_ROWS.map((row) => `${row.methods.join("|")} ${row.template}`)).toEqual([
      "POST|PUT|PATCH|DELETE /message/ack",
      "POST|PUT|PATCH|DELETE /message/ack/all",
      "POST|PUT|PATCH|DELETE /notifications/ack",
      "POST|PUT|PATCH|DELETE /groups/users/readreceipts",
      "POST|PUT|PATCH|DELETE /message/typing",
      "POST|PUT|PATCH|DELETE /status",
      "POST|PUT|PATCH|DELETE /message/like",
      "POST|PUT|PATCH|DELETE /message/like/remove",
      "POST|PUT|PATCH|DELETE /account/emailchange/**",
      "POST|PUT|PATCH|DELETE /account/disable",
      "POST|PUT|PATCH|DELETE /payments/payoutmethods/**",
      "POST|PUT|PATCH|DELETE /account/wallets/transaction/refund",
      "POST|PUT|PATCH|DELETE /payments/wallets*/**",
      "POST|PUT|PATCH|DELETE /login/password*/**",
      "POST|PUT|PATCH|DELETE /twofa/**",
      "POST|PUT|PATCH|DELETE /session/close",
      "POST|PUT|PATCH|DELETE /logout",
      "POST|PUT|PATCH|DELETE /management/**",
      "POST|PUT|PATCH|DELETE /webpush/delete",
      "POST|PUT|PATCH|DELETE /thirdpartyconnect/**",
      "* /emails/unsubscribe",
      "* /account/verifynsfw",
      "* /intercom/authorize",
      "* /zendesk/authorize",
    ]);
    expect(ANY_METHOD).toBe("*");
    for (const row of CLOSED_ROWS) {
      expect(row, row.template).toMatchObject({ mode: "closed", route: null, platformData: false });
      expect(row.example, row.template).toMatch(/^\//);
      expect(templateMatches(parseTemplate(row.template), closedSegments(row.example!), true), row.template).toBe(true);
      expect(row.source, row.template).not.toBe("");
      expect(row.what, row.template).not.toBe("");
    }
    // Every entry of the prototype's rules (extension/build-rules.mjs on
    // proto/project-browser), by an example of each — but the payouts.
    const prototype = ["message/ack", "message/ack/all", "message/typing", "message/like", "message/like/remove", "status", "notifications/ack", "groups/users/readreceipts", "account/disable", "account/emailchange/x", "account/wallets/transaction/refund", "login/password", "login/passwordreset", "twofa", "twofa/x", "session/close", "management/x", "webpush/delete", "payments/wallets", "payments/walletsx/y", "thirdpartyconnect/x", "logout"];
    for (const path of prototype) for (const method of writes) expect(closedRowOf(method, `/${path}`), `${method} ${path}`).not.toBeNull();
    for (const path of ["emails/unsubscribe", "account/verifynsfw", "intercom/authorize", "zendesk/authorize"]) {
      for (const method of ["GET", "HEAD", "OPTIONS", ...writes, "PROPFIND"]) expect(closedRowOf(method, `/${path}`)?.methods, `${method} ${path}`).toEqual([ANY_METHOD]);
    }
    // No permanent "never": the payouts left the list (decision №2) — only
    // the general rule for writes holds them — and reading the payout
    // methods and requests stays a read of the catalogue.
    for (const path of ["/payments/payout", "/payments/payout/requests", "/payments/payouts", "/payouts", "/payouts/request", "/payouts/1/cancel"]) {
      for (const method of writes) {
        expect(closedRowOf(method, path), `${method} ${path}`).toBeNull();
        expect(decide({ method, url: api(path) }, "automation"), `${method} ${path}`).toMatchObject({ action: "refuse", refusal: "closed", rule: "api_writes" });
      }
    }
    expect(closedRowOf("POST", "/payments/payoutmethods")?.what).toMatch(/payout details/);
    expect(decide({ method: "GET", url: api("/payments/payoutmethods") }, "automation")).toMatchObject({ action: "admit", route: "payouts.methods" });
    expect(decide({ method: "GET", url: api("/payments/payout/requests") }, "automation")).toMatchObject({ action: "admit", route: "payouts.requests" });
  });

  it("are refused in both modes, by every method of the row and in every spelling", () => {
    for (const row of CLOSED_ROWS) {
      for (const method of methodsOf(row)) {
        for (const decision of both(method, api(row.example!))) expect(decision, `${method} ${row.example}`).toMatchObject({ action: "refuse", refusal: "closed", rule: `closed: ${row.methods.join("|")} ${row.template}` });
      }
    }
    const spellings = ["/message/ack", "/message/ack/", "/message//ack", "//message/ack", "/MESSAGE/Ack", "/message/%61ck", "/message%2Fack", "/message/ack?x=1", "/message/ack#f"];
    for (const path of spellings) expect(closedRowOf("POST", path)?.template, path).toBe("/message/ack");
    expect(decide({ method: "post", url: `https://${API_HOST}//api//v1//message//ack` }, "automation")).toMatchObject({ action: "refuse", refusal: "closed", rule: "closed: POST|PUT|PATCH|DELETE /message/ack" });
    // A prefix segment and a rest.
    for (const path of ["/login/password", "/login/passwordreset", "/login/password/change/now", "/twofa", "/twofa/disable", "/account/emailchange", "/account/emailchange/a/b", "/payments/payoutmethods/9", "/payments/wallets", "/payments/wallets/1/withdraw", "/management", "/management/a/b"]) {
      expect(closedRowOf("POST", path), path).not.toBeNull();
    }
    // Not closed by a row: the login operations, and other paths.
    for (const path of ["/login", "/login/twofa", "/message/acknowledge", "/statuses", "/message", "/account/emailchanges", "/message/likes", "/logouts", "/sessions/close", "/payments/wallet"]) expect(closedRowOf("POST", path), path).toBeNull();
    // A read is not a closed write.
    for (const row of CLOSED_ROWS.filter((entry) => !entry.methods.includes(ANY_METHOD))) expect(closedRowOf("GET", row.example!), row.template).toBeNull();
  });

  it("the four closed reads are the only reads the map does not open — and a read of the login screens next to a closed write stays open", () => {
    const closedReads = CLOSED_ROWS.filter((row) => row.methods.includes(ANY_METHOD)).map((row) => row.template);
    expect(closedReads).toEqual(["/emails/unsubscribe", "/account/verifynsfw", "/intercom/authorize", "/zendesk/authorize"]);
    for (const path of closedReads) {
      for (const spelling of [path, `${path}/`, `${path}?token=abc&ngsw-bypass=true`, `${path}#x`, path.toUpperCase(), path.replace("/", "//")]) {
        for (const method of ["GET", "HEAD", "OPTIONS", "POST"]) {
          for (const decision of both(method, api(spelling))) expect(decision, `${method} ${spelling}`).toMatchObject({ action: "refuse", refusal: "closed", rule: `closed: * ${path}` });
        }
      }
    }
    // Every other read: the catalogue's and the site's own, in automation.
    for (const row of CATALOGUE_ROWS) expect(decide({ method: "GET", url: api(sample(row.template)) }, "automation"), row.template).toMatchObject({ action: "admit", operation: "read" });
    for (const path of ["/emails", "/emails/unsubscribed", "/emails/unsubscribe/extra", "/xemails/unsubscribe", "/account/verify", "/intercom", "/zendesk/authorized", "/message/like", "/logout", "/session/close", "/management/list", "/status"]) {
      expect(decide({ method: "GET", url: api(path) }, "automation"), path).toMatchObject({ action: "admit", route: "site.other", operation: "read" });
    }
    // The providers of the login screens: a read, in both modes; a write
    // under the same path is closed by its row.
    for (const decision of both("GET", api("/thirdpartyconnect/providers"))) expect(decision).toMatchObject({ action: "admit", route: "site.other", operation: "read" });
    for (const decision of both("POST", api("/thirdpartyconnect/providers"))) expect(decision).toMatchObject({ action: "refuse", refusal: "closed", rule: "closed: POST|PUT|PATCH|DELETE /thirdpartyconnect/**" });
  });

  it("an API path with an escape of a plain character or of a slash is closed by every method: no closed row can be spelled around", () => {
    for (const path of ["/emails/%75nsubscribe", "/emails/%55NSUBSCRIBE", "/emails%2Funsubscribe", "/emails%2funsubscribe", "/intercom/authori%7ae", "/account/%6De", "/account/me%2E", "/%61ccount/me", "/account/stats%5Fx", "/x%7Ey", "/x%2Dy", "/x%30"]) {
      for (const method of ["GET", "OPTIONS", "POST"]) {
        for (const decision of both(method, api(path))) expect(decision, `${method} ${path}`).toMatchObject({ action: "refuse", refusal: "closed", rule: "api_spelling" });
      }
    }
    expect(decide({ method: "GET", url: `https://${API_HOST}/%61pi/v1/account/me` }, "automation")).toMatchObject({ action: "refuse", refusal: "closed", rule: "api_spelling" });
    // An escape a client does write — a space, a non-ASCII letter, a
    // reserved character — is no such spelling; nor is one in the query.
    for (const path of ["/tag/%D0%B0%D0%B1", "/search/a%20b", "/x%2Cy", "/x%40y", "/x%25y", "/x%3Ay", "/account?usernames=%61bc&q=%2F"]) {
      expect(decide({ method: "GET", url: api(path) }, "automation"), path).toMatchObject({ action: "admit", route: expect.any(String), operation: "read" });
    }
    // Not the API's: Fansly's static files and third-party hosts spell their paths as they like.
    expect(decide({ method: "GET", url: "https://fansly.com/%61ssets/x.js" }, "automation")).toMatchObject({ action: "pass" });
    expect(decide({ method: "GET", url: "https://cdn.example.net/%61.js" }, "automation")).toMatchObject({ action: "pass" });
  });

  it("has the self-test's probe among them", () => {
    expect(NEVER_PATH.startsWith(`${API_BASE}/`)).toBe(true);
    expect(closedRowOf("POST", NEVER_PATH.slice(API_BASE.length))?.what).toBe("a read mark");
  });

  it("every row is in the table once, closed rows first", () => {
    expect(API_ROWS).toHaveLength(CLOSED_ROWS.length + LOGIN_ROWS.length + LOGIN_SCREEN_ROWS.length + CATALOGUE_ROWS.length + OPEN_ROWS.length);
    expect(API_ROWS.slice(0, CLOSED_ROWS.length).every((row) => row.mode === "closed")).toBe(true);
    for (const row of API_ROWS) expect(() => parseTemplate(row.template), row.template).not.toThrow();
  });
});

describe("the operator's decisions (plan §4.3)", () => {
  it("automation: reads by the engine's admission, static and third-party hosts at once, the socket by its own admission", () => {
    expect(decide({ method: "GET", url: api("/account/me?ngsw-bypass=true") }, "automation")).toEqual({ action: "admit", route: "account.me", operation: "read", platformData: true, mode: "both", rule: "api: GET /account/me → account.me" });
    expect(decide({ method: "GET", url: api("/mediastories/following") }, "automation")).toMatchObject({ action: "admit", route: "site.other", operation: "read", platformData: true });
    expect(decide({ method: "OPTIONS", url: api("/message") }, "automation")).toMatchObject({ action: "preflight" });
    expect(decide({ method: "GET", url: "https://fansly.com/main.js" }, "automation")).toMatchObject({ action: "pass", cls: "site" });
    expect(decide({ method: "GET", url: "https://cdn3.fansly.com/a/b.jpg?sig=1" }, "automation")).toMatchObject({ action: "pass", cls: "cdn" });
    expect(decide({ method: "POST", url: "https://www.google-analytics.com/g/collect" }, "automation")).toMatchObject({ action: "pass", cls: "third_party" });
    expect(decide({ method: "GET", url: "wss://wsv3.fansly.com/?v=3", resourceType: "WebSocket" }, "automation")).toMatchObject({ action: "socket", route: "ws.upgrade" });
    // A login operation belongs to the manual login only.
    expect(decide({ method: "POST", url: api("/login") }, "automation")).toMatchObject({ action: "refuse", refusal: "mode" });
  });

  it("manual login: the login operations and every read the map opens (the interface's, PR 15); the closed reads and other writes closed, no socket", () => {
    expect(decide({ method: "POST", url: api("/login") }, "manual_login")).toMatchObject({ action: "admit", route: "auth.login", operation: "login", platformData: false });
    expect(decide({ method: "POST", url: api("/login/twofa") }, "manual_login")).toMatchObject({ action: "admit", route: "auth.twofa", operation: "login" });
    for (const row of LOGIN_SCREEN_ROWS) {
      for (const decision of both("GET", api(row.template))) expect(decision, row.template).toMatchObject({ action: "admit", route: "site.other", operation: "read", platformData: row.platformData });
    }
    expect(decide({ method: "GET", url: api("/device/id") }, "manual_login")).toMatchObject({ platformData: false });
    // The interface's reads: the catalogue's and those outside it, as in the automation.
    expect(decide({ method: "GET", url: api("/account/me") }, "manual_login")).toMatchObject({ action: "admit", route: "account.me", operation: "read", platformData: true, mode: "both" });
    expect(decide({ method: "GET", url: api("/timeline/home") }, "manual_login")).toMatchObject({ action: "admit", route: "site.other", operation: "read", platformData: true });
    // The reads that are no reads stay closed, and the writes but the login.
    expect(decide({ method: "GET", url: api("/emails/unsubscribe") }, "manual_login")).toMatchObject({ action: "refuse", refusal: "closed" });
    expect(decide({ method: "GET", url: api("/intercom/authorize") }, "manual_login")).toMatchObject({ action: "refuse", refusal: "closed" });
    expect(decide({ method: "POST", url: api("/message") }, "manual_login")).toMatchObject({ action: "refuse", refusal: "closed" });
    expect(decide({ method: "POST", url: api("/message/ack") }, "manual_login")).toMatchObject({ action: "refuse", refusal: "closed" });
    expect(decide({ method: "GET", url: "wss://wsv3.fansly.com/?v=3", resourceType: "WebSocket" }, "manual_login")).toMatchObject({ action: "refuse", refusal: "mode" });
    // What is not the API's passes in both modes.
    for (const decision of both("GET", "https://fansly.com/")) expect(decision).toMatchObject({ action: "pass" });
    for (const decision of both("GET", "https://widget.intercom.io/widget/x")) expect(decision).toMatchObject({ action: "pass", cls: "third_party" });
    for (const decision of both("OPTIONS", api("/login"))) expect(decision).toMatchObject({ action: "preflight" });
  });

  it("refuses every general closure's example in both modes, and names the rule", () => {
    expect(GENERAL_CLOSURES.map((closure) => closure.rule)).toEqual(["api_writes", "api_spelling", "fansly_writes", "closed_hosts", "socket_host", "local"]);
    for (const closure of GENERAL_CLOSURES) {
      expect(closure.examples.length, closure.rule).toBeGreaterThan(2);
      for (const example of closure.examples) {
        const type = example.type === "websocket" ? "WebSocket" : undefined;
        for (const decision of both(example.method, example.url, type)) {
          expect(decision, `${example.method} ${example.url}`).toMatchObject({ action: "refuse", refusal: closure.rule === "local" ? "denied" : "closed", rule: closure.rule });
        }
      }
    }
  });

  it("opens the API in one spelling only, and Hub's placeholder host not at all", () => {
    for (const url of [`https://${API_HOST}.${API_BASE}/account/me`, `https://user@${API_HOST}${API_BASE}/account/me`, `https://user:pass@${API_HOST}${API_BASE}/account/me`, `https://${API_HOST}:444${API_BASE}/account/me`, `http://${API_HOST}${API_BASE}/account/me`, `wss://${API_HOST}${API_BASE}/account/me`]) {
      expect(decide({ method: "GET", url }, "automation"), url).toMatchObject({ action: "refuse", refusal: "closed", rule: "api_writes" });
    }
    for (const url of ["wss://wsv3.fansly.com/other", "wss://wsv3.fansly.com:444/?v=3", "ws://wsv3.fansly.com/?v=3", "wss://user@wsv3.fansly.com/?v=3", "wss://wsv3.fansly.com./?v=3"]) {
      expect(decide({ method: "GET", url, resourceType: "WebSocket" }, "automation"), url).toMatchObject({ action: "refuse", refusal: "closed", rule: "socket_host" });
    }
    // The socket host serves no other request (stage 1, §3.2).
    expect(decide({ method: "GET", url: "https://wsv3.fansly.com/?v=3", resourceType: "XHR" }, "automation")).toMatchObject({ action: "refuse", rule: "socket_host" });
    // Hub's own requests are decided by their own path, never by the map.
    expect(decide({ method: "GET", url: `https://${API_HOST}.pb-hold.invalid${API_BASE}/account/me` }, "automation")).toMatchObject({ action: "refuse", refusal: "denied" });
    expect(decide({ method: "GET", url: "not a url" }, "automation")).toMatchObject({ action: "refuse", refusal: "denied" });
    expect(decide({ method: "GET", url: "file:///etc/passwd" }, "automation")).toMatchObject({ action: "refuse", refusal: "denied" });
  });
});

describe("templates", () => {
  it("match segment by segment: a parameter one segment, a prefix a segment's start, a rest any further segments", () => {
    const matches = (template: string, path: string) => templateMatches(parseTemplate(template), path.split("/").filter(Boolean));
    expect(matches("/group/:groupId", "/group/1")).toBe(true);
    expect(matches("/group/:groupId", "/group")).toBe(false);
    expect(matches("/group/:groupId", "/group/1/2")).toBe(false);
    expect(matches("/post/{postId}/replies", "/post/7/replies")).toBe(true);
    expect(matches("/login/password*/**", "/login/passwordreset")).toBe(true);
    expect(matches("/login/password*/**", "/login/pass")).toBe(false);
    expect(matches("/twofa/**", "/twofa")).toBe(true);
    expect(matches("/twofa/**", "/twofa/a/b")).toBe(true);
    expect(matches("/twofa/**", "/twofactor")).toBe(false);
    expect(matches("/**", "/")).toBe(true);
    for (const bad of ["x", "/a//b", "/a/**/b", "/a/*", "/a/b*c*", "/a/:", "/a/{b"]) expect(() => parseTemplate(bad), bad).toThrow();
  });
});
