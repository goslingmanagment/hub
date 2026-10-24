// The rules extension's rules (plan §4.6; spec §2.7), built from the map of
// operations (policy/operations.ts) when the image is built
// (extension/build.ts): static declarativeNetRequest rules Chrome applies
// before any request leaves — without the operator, during the owner's
// manual access too. Strictly different priorities, since at equal priority
// DNR prefers allow:
//
//   400 block  the rows closed one by one (spec §2.5): method and path —
//              four of them by every method, the only closed reads
//   350 block  an API path with an escape of a plain character or of a
//              slash: no client writes one, and behind it a closed read
//              would pass level 250
//   300 allow  the login operations: POST and their exact paths
//   275 allow  the writes the map opens by their body (the site's delivered
//              marks, owner decision 2026-10-23): a script's POST and the
//              exact path — on to the operator, which stops every request
//              on that path in Fetch and lets it go only when its body
//              passes (cdp/control.ts, intercept/checked.ts). The extension
//              cannot read a body: without the operator's check this rule
//              would let a read mark through on the same path
//   256 block  a PUT to the placeholder of one of Fansly's role hosts (the
//              API, the sockets, metrics, the upload API, the CDN, www):
//              never a storage host of an upload's part (wall posts PR 8)
//   255 allow  Hub's own publishing writes (wall posts PR 7; operations.ts
//              `HUB_PUBLISH_ROWS`): a script's POST of each exact path, with
//              the engine's query, on its placeholder host only — the API's
//              and the upload API's — the GET of an upload's status there
//              (PR 8), and the preflights under the upload API's
//              placeholder; a script's PUT of an upload's part to the
//              placeholder of a storage host directly under fansly.com (PR
//              8: a third party's placeholder no rule closes). On to the
//              operator, which stops every request to a placeholder in
//              Fetch and lets a write go only under the engine's admission,
//              the page's permission and the command's fingerprint over the
//              bytes Chrome holds — a part's over the bytes it hands Chrome
//              itself (hub-requests/hub.ts). The site's own writes on the
//              real hosts stay closed, in the manual login too
//   250 allow  API reads and their preflights (GET, OPTIONS under /api/v1),
//              and the site's socket (wss://wsv3.fansly.com/)
//   200 block  everything else on the API host; any write to Fansly's other
//              hosts; the closed hosts and their placeholders; anything else
//              on the socket host
//   150 block  the trackers the common blockers cut (operations.ts
//              `TRACKER_ROWS`, owner decision 2026-10-23): their hosts and
//              every name under them, or a host's path — any method, any
//              type, any spelling of the host
//   100 block  local and private addresses
//
// Level 250 is the spec's level 3 made exact: "what is not in the map among
// API paths is closed" (spec §2) — a HEAD, a path outside /api/v1, another
// port or scheme — the way the operator's table decides it. Hub's requests
// start from a placeholder host (`<host>.pb-hold.invalid`, hub-requests/
// page.ts) the operator turns into the real one before they go: the rules
// see the placeholder, so every API and Fansly rule covers it too — but not
// the login nor the delivered marks, which Hub never sends; and only there
// are Hub's publishing writes open (level 255).
//
// Level 275 stands below every closed row, so no closed row opens by it; a
// write to its path in another spelling (a case, a run or a trailing slash,
// an escape) or from a click, a frame or a beacon is cancelled by levels 350
// and 200, and the operator's table refuses it as the closed rows read a
// path (operations.ts `checkedRowOf`).
//
// How the rules read a URL (Chrome matches its canonical form: an authority
// always ends at a `/`):
// - allow rules are exact and case-sensitive — scheme, host, no port, no
//   user — so a spelling the operator would not open is not opened here;
// - the blocks of level 200 take a host in any spelling (a user, a port, a
//   trailing dot, any scheme): they may close more, never less;
// - a closed row's block needs to hold only where an allow rule could open:
//   HTTPS and the host as it is — one rule for the API host and one for its
//   placeholder; its path in any case, with runs of slashes. Level 250
//   opens a read in any spelling of its path, so
//   a closed read's rule must hold every spelling Chrome can issue that a
//   server may take for the row's path: any case and runs of slashes it
//   reads itself, an escaped plain character or slash level 350 closes for
//   every path — which is also how the operator's table reads a path
//   (operations.ts `closedSegments`, `PLAIN_ESCAPES`).
// A resource type list is explicit: without one DNR skips main_frame, and a
// form posted by a click is a main frame.
//
// The stand's publish capture (wall posts plan, PR 0.1) adds two levels, and
// only to an image built with `--capture publish` (extension/build.ts): a
// production image's rules are these levels and nothing more (the tests hold
// it):
//
//   265 block  a PUT to Fansly's role hosts (operations.ts
//              `CAPTURE_PUT_CLOSED_HOSTS`): never a storage host
//   260 allow  the site's own publishing requests (`PUBLISH_CAPTURE_ROWS`):
//              a script's request, by its method and exact path on the real
//              host — the upload host's and the API's —; the preflights
//              under the upload host's API path; a script's PUT of a part to
//              a host under fansly.com
//
// Both stand below the closed rows and the escapes' level, so no closed row
// opens by them, and above level 200, which they open.
//
// Chrome compiles each expression under a small memory limit and silently
// drops a rule whose expression is over it (measured on Chrome 155: about
// 112 instructions of RE2; a literal right after `^` is free). `regexCost`
// estimates an expression from above, `buildRules` refuses one over
// `REGEX_BUDGET` — so the image does not build with a rule Chrome would
// drop — and the stand asks Chrome itself (stand/rules-check.mjs).

import { ANY_METHOD, API_BASE, API_HOST, CAPTURE_PART_METHOD, CAPTURE_PUT_CLOSED_HOSTS, CHECKED_ROWS, CLOSED_ROWS, FANSLY_DOMAIN, HOST_ROWS, HUB_PUBLISH_ROWS, HUB_WRITE_QUERY, LOCAL, LOGIN_ROWS, parseTemplate, PLAIN_ESCAPES, PUBLISH_CAPTURE_ROWS, SOCKET_HOST, TRACKER_ROWS, UPLOAD_HOST, type ApiRow, type CaptureRow, type CheckedRow, type HubPublishRow } from "./operations.ts";
import { PLACEHOLDER_SUFFIX } from "../hub-requests/page.ts";

export const PRIORITY = { closed: 400, spelling: 350, login: 300, checked: 275, hubPartRoles: 256, hubWrite: 255, open: 250, general: 200, tracker: 150, local: 100 } as const;

/** The labels under fansly.com an upload's part never goes to (their
 *  placeholders closed to a PUT at level 256): Fansly's role hosts and www —
 *  the operator's `hubPartHost` and the engine's `isFanslyStorageHost` say
 *  the same. */
const PART_CLOSED_LABELS = ["apiv3", "wsv3", "chatws", "metrics", "mediav2", "cdn[^./]*", "www"];
/** The publish capture's levels: in the stand's image only. */
export const CAPTURE_PRIORITY = { closed: 265, open: 260 } as const;

export interface RulesOptions {
  /** The stand's publish capture (wall posts plan, PR 0.1): never in a
   *  production image. */
  publishCapture?: boolean;
}

/** Every resource type of DNR (Chrome 155). */
export const RESOURCE_TYPES = ["main_frame", "sub_frame", "stylesheet", "script", "image", "font", "object", "xmlhttprequest", "ping", "csp_report", "media", "websocket", "webtransport", "webbundle", "other"] as const;

export type DnrMethod = "connect" | "delete" | "get" | "head" | "options" | "patch" | "post" | "put" | "other";

export interface DnrCondition {
  regexFilter: string;
  isUrlFilterCaseSensitive: boolean;
  requestMethods?: DnrMethod[];
  excludedRequestMethods?: DnrMethod[];
  resourceTypes: string[];
}

export interface DnrRule {
  id: number;
  priority: number;
  action: { type: "block" | "allow" };
  condition: DnrCondition;
}

/** What an expression may cost (`regexCost`): Chrome 155 takes about 112. */
export const REGEX_BUDGET = 80;

export function escapeRegex(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Any scheme DNR sees, an optional user, before a host. */
const ANY_ORIGIN = "^[a-z]+://([^/@]*@)?";
/** The same for a host that is not Fansly's: the web's schemes only. */
const WEB_ORIGIN = "^(http|ws)s?://([^/@]*@)?";
/** After a host: a trailing dot, a port, the path's slash. */
const HOST_END = "\\.?(:[0-9]+)?/";

/** The API host and its placeholder. */
const API_HOSTS = [API_HOST, `${API_HOST}${PLACEHOLDER_SUFFIX}`];

function method(name: string): DnrMethod {
  const lower = name.toLowerCase();
  return (["connect", "delete", "get", "head", "options", "patch", "post", "put"] as const).find((known) => known === lower) ?? "other";
}

/** A template's path as a tolerant block expression: runs of slashes, any
 *  case (the rule's flag), a trailing slash, then a query or fragment. */
function tolerantPath(template: string): string {
  const parsed = parseTemplate(template);
  const segments = parsed.segments.map((segment) => {
    switch (segment.kind) {
      case "literal":
        return `/+${escapeRegex(segment.text)}`;
      case "param":
        return "/+[^/?#]+";
      case "prefix":
        return `/+${escapeRegex(segment.text)}[^/?#]*`;
    }
  });
  return `${segments.join("")}${parsed.rest ? "(/[^?#]*)?" : "/*"}([?#].*)?$`;
}

const TOLERANT_BASE = API_BASE.split("/")
  .filter(Boolean)
  .map((part) => `/+${escapeRegex(part)}`)
  .join("");

function closedRule(row: ApiRow, host: string): Omit<DnrRule, "id"> {
  return {
    priority: PRIORITY.closed,
    action: { type: "block" },
    condition: {
      regexFilter: `^https://${escapeRegex(host)}${TOLERANT_BASE}${tolerantPath(row.template)}`,
      isUrlFilterCaseSensitive: false,
      // No methods named: every method, a read too.
      ...(row.methods.includes(ANY_METHOD) ? {} : { requestMethods: row.methods.map(method) }),
      resourceTypes: [...RESOURCE_TYPES],
    },
  };
}

function loginRule(row: ApiRow): Omit<DnrRule, "id"> {
  const parsed = parseTemplate(row.template);
  if (parsed.rest || parsed.segments.some((segment) => segment.kind !== "literal")) throw new Error(`a login operation is an exact path: ${row.template}`);
  return {
    priority: PRIORITY.login,
    action: { type: "allow" },
    condition: {
      regexFilter: `^https://${escapeRegex(API_HOST)}${escapeRegex(API_BASE)}${escapeRegex(row.template)}/?([?#].*)?$`,
      isUrlFilterCaseSensitive: true,
      requestMethods: row.methods.map(method),
      resourceTypes: [...RESOURCE_TYPES],
    },
  };
}

/** A write opened by its body: a script's POST and its exact path, on the
 *  real host — with any query or fragment, which the operator judges (the
 *  site's own goes with `ngsw-bypass=true`). No trailing slash: Fetch stops
 *  the path as it is, and nothing this rule opens may go unchecked. */
function checkedRule(row: CheckedRow): Omit<DnrRule, "id"> {
  const parsed = parseTemplate(row.template);
  if (parsed.rest || parsed.segments.some((segment) => segment.kind !== "literal")) throw new Error(`a write opened by its body is an exact path: ${row.template}`);
  return {
    priority: PRIORITY.checked,
    action: { type: "allow" },
    condition: {
      regexFilter: `^https://${escapeRegex(API_HOST)}${escapeRegex(API_BASE)}${escapeRegex(row.template)}([?#].*)?$`,
      isUrlFilterCaseSensitive: true,
      requestMethods: row.methods.map(method),
      // A script's request only: a form posted by a click, a frame or a
      // beacon carries no mark of the site's.
      resourceTypes: ["xmlhttprequest"],
    },
  };
}

/** One of Hub's publishing writes: a script's POST of its exact path with the
 *  engine's query, on the row's placeholder host — no other spelling, no
 *  escape in an id. */
function hubWriteRule(row: HubPublishRow): Omit<DnrRule, "id"> {
  const parsed = parseTemplate(row.template);
  if (parsed.rest || parsed.segments.some((segment) => segment.kind === "prefix")) throw new Error(`a publishing write is an exact path: ${row.template}`);
  const path = parsed.segments.map((segment) => (segment.kind === "literal" ? `/${escapeRegex(segment.text)}` : "/[A-Za-z0-9_-]+")).join("");
  return {
    priority: PRIORITY.hubWrite,
    action: { type: "allow" },
    condition: {
      regexFilter: `^https://${escapeRegex(`${row.host}${PLACEHOLDER_SUFFIX}`)}${escapeRegex(API_BASE)}${path}\\?${escapeRegex(HUB_WRITE_QUERY)}(#.*)?$`,
      isUrlFilterCaseSensitive: true,
      requestMethods: [method(row.method)],
      resourceTypes: ["xmlhttprequest"],
    },
  };
}

/** A capture row: a script's request by its method and exact path on the
 *  real host — one trailing slash and any query or fragment aside, no
 *  escape in it — as the operator's table reads it (operations.ts
 *  `captureRowOf`). */
function captureRule(row: CaptureRow): Omit<DnrRule, "id"> {
  const parsed = parseTemplate(row.template);
  if (parsed.rest || parsed.segments.some((segment) => segment.kind === "prefix")) throw new Error(`a capture row is an exact path: ${row.template}`);
  // An id holds no escape: no spelling of a path rides on one.
  const path = parsed.segments.map((segment) => (segment.kind === "literal" ? `/${escapeRegex(segment.text)}` : "/[^/?#%]+")).join("");
  return {
    priority: CAPTURE_PRIORITY.open,
    action: { type: "allow" },
    condition: {
      regexFilter: `^https://${escapeRegex(row.host)}${escapeRegex(API_BASE)}${path}/?([?#].*)?$`,
      isUrlFilterCaseSensitive: true,
      requestMethods: [method(row.method)],
      resourceTypes: ["xmlhttprequest"],
    },
  };
}

/** The publish capture's rules (levels 265 and 260): the stand's image only. */
function captureRules(): Array<Omit<DnrRule, "id">> {
  const rules: Array<Omit<DnrRule, "id">> = [];
  // 265: no part goes to a host of Fansly's own roles, in any spelling.
  const roles = CAPTURE_PUT_CLOSED_HOSTS.map((host) => (host.endsWith(`.${FANSLY_DOMAIN}`) ? host.slice(0, -FANSLY_DOMAIN.length - 1) : null));
  if (roles.some((label) => label === null || label.includes("."))) throw new Error("a role host of the capture is one label under fansly.com");
  const labels = roles.map((label) => escapeRegex(label!).replace("\\*", "[^./]*")).join("|");
  rules.push({
    priority: CAPTURE_PRIORITY.closed,
    action: { type: "block" },
    condition: { regexFilter: `${ANY_ORIGIN}(${labels})\\.${escapeRegex(FANSLY_DOMAIN)}${HOST_END}`, isUrlFilterCaseSensitive: false, requestMethods: [method(CAPTURE_PART_METHOD)], resourceTypes: [...RESOURCE_TYPES] },
  });
  // 260: the publishing requests; the upload host's preflights; a part.
  for (const row of PUBLISH_CAPTURE_ROWS) rules.push(captureRule(row));
  rules.push({
    priority: CAPTURE_PRIORITY.open,
    action: { type: "allow" },
    condition: { regexFilter: `^https://${escapeRegex(UPLOAD_HOST)}${escapeRegex(API_BASE)}(/[^?#]*)?([?#].*)?$`, isUrlFilterCaseSensitive: true, requestMethods: ["options"], resourceTypes: [...RESOURCE_TYPES] },
  });
  rules.push({
    priority: CAPTURE_PRIORITY.open,
    action: { type: "allow" },
    condition: { regexFilter: `^https://[a-z0-9-]+\\.${escapeRegex(FANSLY_DOMAIN)}/`, isUrlFilterCaseSensitive: true, requestMethods: [method(CAPTURE_PART_METHOD)], resourceTypes: ["xmlhttprequest"] },
  });
  return rules;
}

/** The rules, in their order: ids from 1. The publish capture's come last,
 *  when asked for (the stand's image only): the rules before them are a
 *  production image's, id for id. */
export function buildRules(options: RulesOptions = {}): DnrRule[] {
  const rules: Array<Omit<DnrRule, "id">> = [];
  const all = [...RESOURCE_TYPES];
  const block = (priority: number, regexFilter: string, more: Partial<DnrCondition> = {}): Omit<DnrRule, "id"> => ({
    priority,
    action: { type: "block" },
    condition: { regexFilter, isUrlFilterCaseSensitive: false, resourceTypes: all, ...more },
  });
  // 400: closed one by one, on the API host and on its placeholder.
  for (const row of CLOSED_ROWS) for (const host of API_HOSTS) rules.push(closedRule(row, host));
  // 350: an API path with an escape of a plain character or of a slash.
  for (const host of API_HOSTS) rules.push(block(PRIORITY.spelling, `^https://${escapeRegex(host)}/[^?#]*%(${PLAIN_ESCAPES})`));
  // 300: the login operations.
  for (const row of LOGIN_ROWS) rules.push(loginRule(row));
  // 275: the writes opened by their body, to the operator's check.
  for (const row of CHECKED_ROWS) rules.push(checkedRule(row));
  // 255: Hub's publishing writes, on their placeholders only; the
  // preflights under the upload API's placeholder (the API's are level 250's).
  // 256: no part to a role host's placeholder, in any spelling (one rule a
  // host: together they are over the expressions' budget).
  for (const label of PART_CLOSED_LABELS) rules.push(block(PRIORITY.hubPartRoles, `${ANY_ORIGIN}${label}\\.${escapeRegex(`${FANSLY_DOMAIN}${PLACEHOLDER_SUFFIX}`)}${HOST_END}`, { requestMethods: ["put"] }));
  for (const row of HUB_PUBLISH_ROWS) rules.push(hubWriteRule(row));
  rules.push({
    priority: PRIORITY.hubWrite,
    action: { type: "allow" },
    condition: { regexFilter: `^https://${escapeRegex(`${UPLOAD_HOST}${PLACEHOLDER_SUFFIX}`)}${escapeRegex(API_BASE)}(/[^?#]*)?([?#].*)?$`, isUrlFilterCaseSensitive: true, requestMethods: ["options"], resourceTypes: all },
  });
  // A part to a storage host under fansly.com, on its placeholder (a third
  // party's placeholder no rule closes: the operator decides it in Fetch).
  rules.push({
    priority: PRIORITY.hubWrite,
    action: { type: "allow" },
    condition: { regexFilter: `^https://[a-z0-9-]+\\.${escapeRegex(`${FANSLY_DOMAIN}${PLACEHOLDER_SUFFIX}`)}/.*$`, isUrlFilterCaseSensitive: true, requestMethods: ["put"], resourceTypes: ["xmlhttprequest"] },
  });
  // 250: API reads and preflights, on the API host and on its placeholder;
  // the site's socket.
  for (const host of API_HOSTS) {
    rules.push({
      priority: PRIORITY.open,
      action: { type: "allow" },
      condition: { regexFilter: `^https://${escapeRegex(host)}${escapeRegex(API_BASE)}(/[^?#]*)?([?#].*)?$`, isUrlFilterCaseSensitive: true, requestMethods: ["get", "options"], resourceTypes: all },
    });
  }
  rules.push({
    priority: PRIORITY.open,
    action: { type: "allow" },
    condition: { regexFilter: `^wss://${escapeRegex(SOCKET_HOST)}/([?#].*)?$`, isUrlFilterCaseSensitive: true, resourceTypes: ["websocket"] },
  });
  // 200: the rest of the API host; writes to Fansly; the closed hosts; the
  // rest of the socket host.
  rules.push(block(PRIORITY.general, `${ANY_ORIGIN}${escapeRegex(API_HOST)}(${escapeRegex(PLACEHOLDER_SUFFIX)})?${HOST_END}`));
  rules.push(block(PRIORITY.general, `${ANY_ORIGIN}([^/@]*\\.)?${escapeRegex(FANSLY_DOMAIN)}(${escapeRegex(PLACEHOLDER_SUFFIX)})?${HOST_END}`, { excludedRequestMethods: ["get", "head", "options"] }));
  for (const row of HOST_ROWS.filter((entry) => entry.cls === "closed")) rules.push(block(PRIORITY.general, `${ANY_ORIGIN}${escapeRegex(row.host)}(${escapeRegex(PLACEHOLDER_SUFFIX)})?${HOST_END}`));
  rules.push(block(PRIORITY.general, `${ANY_ORIGIN}${escapeRegex(SOCKET_HOST)}${HOST_END}`));
  // 150: the trackers a blocker cuts — a host and every name under it, or
  // a path of it in any case (as the operator's table reads it).
  for (const row of TRACKER_ROWS) {
    const host = `${WEB_ORIGIN}([^/@]*\\.)?${escapeRegex(row.host)}`;
    rules.push(block(PRIORITY.tracker, row.path === null ? `${host}${HOST_END}` : `${host}\\.?(:[0-9]+)?${escapeRegex(row.path)}`));
  }
  // 100: local and private addresses (the proxy refuses them too).
  rules.push(block(PRIORITY.local, `${WEB_ORIGIN}([^/@]*\\.)?(${LOCAL.names.map(escapeRegex).join("|")})${HOST_END}`));
  rules.push(block(PRIORITY.local, `${WEB_ORIGIN}[^./@:\\[\\]]+${HOST_END}`));
  // The special-purpose addresses (policy/special-addresses.ts), as few
  // rules as the expressions' budget allows.
  const literal = (texts: readonly string[], wrap: (alternatives: string) => string) => {
    let group: string[] = [];
    const flush = () => {
      if (group.length > 0) rules.push(block(PRIORITY.local, wrap(group.join("|"))));
      group = [];
    };
    for (const text of texts) {
      if (group.length > 0 && regexCost(wrap([...group, text].join("|")), false) > REGEX_BUDGET) flush();
      group.push(text);
    }
    flush();
  };
  literal(LOCAL.ipv4, (alternatives) => `${WEB_ORIGIN}(${alternatives})(:[0-9]+)?/`);
  literal(LOCAL.ipv6, (alternatives) => `${WEB_ORIGIN}\\[(${alternatives})\\](:[0-9]+)?/`);
  if (options.publishCapture === true) rules.push(...captureRules());
  return rules.map((rule, index) => {
    const cost = regexCost(rule.condition.regexFilter, rule.condition.isUrlFilterCaseSensitive);
    if (cost > REGEX_BUDGET) throw new Error(`rule ${index + 1}: its expression costs ${cost}, over the budget of ${REGEX_BUDGET} — Chrome would drop the rule: ${rule.condition.regexFilter}`);
    return { id: index + 1, ...rule };
  });
}

/** rules.json as the extension carries it. */
export function rulesJson(rules: readonly DnrRule[] = buildRules()): string {
  return `${JSON.stringify(rules, null, 2)}\n`;
}

// ── what an expression costs Chrome ────────────────────────────────────────

/** An estimate, from above, of the RE2 instructions of an expression in the
 *  subset the rules use — literals, `.`, classes, groups with `|`, `?*+`,
 *  `^$` — as Chrome compiles it (Latin-1, case folded unless sensitive):
 *  a literal or a one-range class is 1, a class of r ranges 2r−1, a
 *  repetition or an alternative 1 more, and the literal that follows a
 *  leading `^` is free (RE2 checks it apart). Throws on anything else. */
export function regexCost(source: string, caseSensitive: boolean): number {
  let at = 0;
  const fail = (what: string): never => {
    throw new Error(`regexCost: ${what} at ${at} in ${source}`);
  };

  function classCost(): number {
    const set = new Uint8Array(256);
    const negated = source[at] === "^";
    if (negated) at += 1;
    const one = (): number => {
      let char = source[at++];
      if (char === "\\") char = source[at++];
      if (char === undefined) return fail("an open class");
      return char.charCodeAt(0);
    };
    let any = false;
    while (source[at] !== "]") {
      if (at >= source.length) fail("an open class");
      const low = one();
      let high = low;
      if (source[at] === "-" && source[at + 1] !== "]") {
        at += 1;
        high = one();
      }
      if (high < low || high > 255) fail("a bad range");
      for (let code = low; code <= high; code++) {
        set[code] = 1;
        if (!caseSensitive) {
          const char = String.fromCharCode(code);
          set[char.toLowerCase().charCodeAt(0)] = 1;
          set[char.toUpperCase().charCodeAt(0)] = 1;
        }
      }
      any = true;
    }
    at += 1;
    if (!any) fail("an empty class");
    let ranges = 0;
    for (let code = 0; code < 256; code++) {
      const inSet = (set[code] === 1) !== negated;
      const before = code > 0 && (set[code - 1] === 1) !== negated;
      if (inSet && !before) ranges += 1;
    }
    return Math.max(1, 2 * ranges - 1);
  }

  /** One atom: its cost, and whether it is a plain literal character. */
  function atom(): { cost: number; literal: boolean } {
    const char = source[at++]!;
    switch (char) {
      case "(": {
        if (source[at] === "?") fail("a group with flags");
        const cost = alternation(false);
        if (source[at++] !== ")") fail("an open group");
        return { cost, literal: false };
      }
      case "[":
        return { cost: classCost(), literal: false };
      case ".":
        return { cost: 3, literal: false };
      case "^":
      case "$":
        return { cost: 1, literal: false };
      case "\\": {
        const escaped = source[at++];
        if (escaped === undefined || /[A-Za-z0-9]/.test(escaped)) fail("an escape that is not a literal");
        return { cost: 1, literal: true };
      }
      case "{":
      case "}":
      case "*":
      case "+":
      case "?":
      case ")":
      case "|":
        return fail(`an unexpected ${char}`);
      default:
        return { cost: 1, literal: true };
    }
  }

  function sequence(top: boolean): number {
    let cost = 0;
    /** In the literal that follows a leading `^`. */
    let prefix = false;
    let first = true;
    while (at < source.length && source[at] !== "|" && source[at] !== ")") {
      const start = source[at];
      const item = atom();
      const repeated = source[at] === "?" || source[at] === "*" || source[at] === "+";
      if (repeated) {
        at += 1;
        if (source[at] === "?" || source[at] === "*" || source[at] === "+" || source[at] === "{") fail("a repetition of a repetition");
      }
      if (source[at] === "{") fail("a counted repetition");
      if (top && first && start === "^" && !repeated) prefix = true;
      else if (prefix && item.literal && !repeated) {
        first = false;
        continue;
      } else prefix = false;
      first = false;
      cost += item.cost + (repeated ? 1 : 0);
    }
    return cost;
  }

  function alternation(top: boolean): number {
    let cost = sequence(top);
    while (source[at] === "|") {
      at += 1;
      cost += sequence(false) + 1;
    }
    return cost;
  }

  // A leading literal is free only when nothing is tried beside it.
  const cost = alternation(!topLevelAlternatives(source));
  if (at !== source.length) fail("an unexpected )");
  return cost + 2; // the match and the fail instructions
}

function topLevelAlternatives(source: string): boolean {
  let depth = 0;
  let inClass = false;
  for (let i = 0; i < source.length; i++) {
    const char = source[i];
    if (char === "\\") {
      i += 1;
      continue;
    }
    if (inClass) {
      if (char === "]") inClass = false;
      continue;
    }
    if (char === "[") inClass = true;
    else if (char === "(") depth += 1;
    else if (char === ")") depth -= 1;
    else if (char === "|" && depth === 0) return true;
  }
  return false;
}
