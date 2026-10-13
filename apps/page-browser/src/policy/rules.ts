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
//   250 allow  API reads and their preflights (GET, OPTIONS under /api/v1),
//              and the site's socket (wss://wsv3.fansly.com/)
//   200 block  everything else on the API host; any write to Fansly's other
//              hosts; the closed hosts; anything else on the socket host
//   100 block  local and private addresses
//
// Level 250 is the spec's level 3 made exact: "what is not in the map among
// API paths is closed" (spec §2) — a HEAD, a path outside /api/v1, another
// port or scheme — the way the operator's table decides it. Hub's requests
// start from a placeholder host (`<host>.pb-hold.invalid`, hub-requests/
// page.ts) the operator turns into the real one before they go: the rules
// see the placeholder, so every API and Fansly rule covers it too — but not
// the login, which Hub never sends.
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
// Chrome compiles each expression under a small memory limit and silently
// drops a rule whose expression is over it (measured on Chrome 155: about
// 112 instructions of RE2; a literal right after `^` is free). `regexCost`
// estimates an expression from above, `buildRules` refuses one over
// `REGEX_BUDGET` — so the image does not build with a rule Chrome would
// drop — and the stand asks Chrome itself (stand/rules-check.mjs).

import { ANY_METHOD, API_BASE, API_HOST, CLOSED_ROWS, FANSLY_DOMAIN, HOST_ROWS, LOCAL, LOGIN_ROWS, parseTemplate, PLAIN_ESCAPES, SOCKET_HOST, type ApiRow } from "./operations.ts";
import { PLACEHOLDER_SUFFIX } from "../hub-requests/page.ts";

export const PRIORITY = { closed: 400, spelling: 350, login: 300, open: 250, general: 200, local: 100 } as const;

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

/** The rules, in their order: ids from 1. */
export function buildRules(): DnrRule[] {
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
  for (const row of HOST_ROWS.filter((entry) => entry.cls === "closed")) rules.push(block(PRIORITY.general, `${ANY_ORIGIN}${escapeRegex(row.host)}${HOST_END}`));
  rules.push(block(PRIORITY.general, `${ANY_ORIGIN}${escapeRegex(SOCKET_HOST)}${HOST_END}`));
  // 100: local and private addresses (the proxy refuses them too).
  rules.push(block(PRIORITY.local, `${WEB_ORIGIN}([^/@]*\\.)?(${LOCAL.names.map(escapeRegex).join("|")})${HOST_END}`));
  rules.push(block(PRIORITY.local, `${WEB_ORIGIN}[^./@:\\[\\]]+${HOST_END}`));
  for (const range of LOCAL.ipv4) rules.push(block(PRIORITY.local, `${WEB_ORIGIN}${range}\\.[0-9.]*(:[0-9]+)?/`));
  rules.push(block(PRIORITY.local, `${WEB_ORIGIN}\\[(${LOCAL.ipv6Exact.map(escapeRegex).join("|")}|(${LOCAL.ipv6Prefixes.map(escapeRegex).join("|")})[^\\]]*)\\](:[0-9]+)?/`));
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
