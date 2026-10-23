import type { DnrRule } from "../../apps/page-browser/src/policy/rules.ts";

// Chrome's declarativeNetRequest for the rules extension's rules, as far as
// they use it (apps/page-browser/src/policy/rules.ts): regexFilter with its
// case flag, request methods and resource types; the rule of the highest
// priority decides, and at equal priority allow goes before
// block. Chrome matches a URL in its canonical form — an authority always
// ends at a slash — which `new URL` gives too. The stand holds this model to
// the real Chrome (apps/page-browser/stand/rules-check.mjs).

export interface DnrRequest {
  method: string;
  url: string;
  /** DNR's resource type; a script's request by default. */
  type?: string;
}

const METHODS = new Set(["connect", "delete", "get", "head", "options", "patch", "post", "put"]);

export function dnrMatches(rule: DnrRule, request: DnrRequest): boolean {
  const { condition } = rule;
  const url = new URL(request.url);
  const type = request.type ?? "xmlhttprequest";
  if (!condition.resourceTypes.includes(type)) return false;
  const lower = request.method.toLowerCase();
  const method = METHODS.has(lower) ? lower : "other";
  if (condition.requestMethods && !(condition.requestMethods as string[]).includes(method)) return false;
  if (condition.excludedRequestMethods && (condition.excludedRequestMethods as string[]).includes(method)) return false;
  return new RegExp(condition.regexFilter, condition.isUrlFilterCaseSensitive ? "" : "i").test(url.href);
}

/** The rule that decides a request, or null when none matches. */
export function dnrRule(rules: readonly DnrRule[], request: DnrRequest): DnrRule | null {
  let top: DnrRule | null = null;
  for (const rule of rules) {
    if (!dnrMatches(rule, request)) continue;
    if (top === null || rule.priority > top.priority || (rule.priority === top.priority && rule.action.type === "allow" && top.action.type === "block")) top = rule;
  }
  return top;
}

/** Whether the extension cancels the request. */
export function dnrBlocks(rules: readonly DnrRule[], request: DnrRequest): boolean {
  return dnrRule(rules, request)?.action.type === "block";
}

/** Chrome's match of a Fetch `urlPattern` (the operator's FETCH_PATTERNS):
 *  `*` any run of characters, `?` any one, `\` takes the next literally —
 *  against the URL without its fragment, which Fetch never matches (seen on
 *  Chrome 155: `…/ack` stops `…/ack#x`, a pattern `…/ack#*` stops nothing). */
export function fetchPatternMatches(pattern: string, url: string): boolean {
  let source = "^";
  for (let i = 0; i < pattern.length; i++) {
    const char = pattern[i]!;
    if (char === "\\" && i + 1 < pattern.length) source += pattern[++i]!.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    else if (char === "*") source += "[\\s\\S]*";
    else if (char === "?") source += "[\\s\\S]";
    else source += char.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  }
  return new RegExp(`${source}$`).test(new URL(url).href.split("#", 1)[0]!);
}
