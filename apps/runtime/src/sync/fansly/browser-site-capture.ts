import { createHash } from "node:crypto";

import { fanslyWireSpec, readFanslyWireResponse, type FanslyWireId } from "@agency_hub_core/fansly";

import type { BufferEvent } from "../../services/egress/page-browser-protocol.ts";
import { prepareJournalBody } from "./capture.ts";
import { stripFanslySignedCdnTokens } from "./lib/cdn-tokens.ts";
import { replaceJournalUnstorableText } from "./lib/journal-lone-surrogates.ts";
import { FANSLY_API_BASE_PATH } from "./route-match.ts";
import { FANSLY_ROUTES, isFanslyRoute } from "./routes.ts";

// The answers to a page's own site requests, from its operator's buffer into
// `observations` (Project Browser, plan §3.2 «Ответы на собственные
// API-запросы сайта», §4.3; stage 3 PR 13). What the site got is a captured
// fact: it is journaled before anything parses it, idempotently, and nothing
// in the engine parses it yet (the requirement is to keep the fact).
//
// - Source `browser_site` (0274), producer `fansly-site:<route>`, key
//   `fansly-site:<page>:<buffer id>:<number>`: an event delivered again finds
//   its row (`insertObservation`).
// - A route of the engine's registry is journaled under the kind the
//   engine's own answer takes, its body through the same codec
//   (`fansly/capture.ts`: the trims by kind, the CDN tokens stripped, unpaired
//   surrogates replaced); a body the codec cannot take for the site's request
//   (a reply walk whose post the path does not name) and every other route —
//   `site.other`, a legacy-only endpoint — goes under `fansly.site.<route>`,
//   its body as it is (parsed when it is JSON) but for the CDN's signing
//   tokens, stripped as the codec strips them, with the request line and the
//   status.
// - Not the server's confirmed word (the browser's cache, the site's service
//   worker): `<kind>:unconfirmed`, as the engine's own (PR 12). Not a 2xx with
//   the route's answer: `<kind>:failed`. Either is the only copy (the
//   operator drops its own once this commits): kept complete — the route's
//   answer through the codec, else the whole text — never cut. A body the
//   operator could not take whole (`complete: false`) is no fact: a mark
//   `<kind>:incomplete` without it, so the hole is seen in Hub.
// - The login operations' answers and any write's carry secrets: never
//   written (the operator keeps none of them either). Nor are the answers of
//   the secret reads (`SECRET_SITE_READS`), whole or not: no row, so no mark
//   of a hole and no backfill either.

/** A site response as the operator's buffer keeps it. */
export type SiteResponseEvent = Extract<BufferEvent, { kind: "site.response" }>;

/** The routes whose answers are never written. */
const SECRET_ROUTES: ReadonlySet<string> = new Set(["auth.login", "auth.twofa"]);

/**
 * The site's reads whose answers carry the page's secrets (the PB audit of
 * 2026-10-22, P2-3): its managers' session tokens, its sign-ins' addresses,
 * its identity verification, its 2FA and login settings, an e-mail change, a
 * payout method's details, its tax forms, its stream key. Never written,
 * whatever the operator sent. The operator's map keeps none of their answers
 * (`SECRET_READ_ROWS`, apps/page-browser/src/policy/operations.ts: no body
 * read, no `site.response`); this is the belt for an operator from before
 * that list, which keeps them as `site.other`. The engine never loads the
 * page-browser app, so the list is its mirror, not an import:
 * tests/page-browser-operations.test.ts holds the two equal.
 *
 * Templates from `/api/v1` in the map's grammar: literal segments, `:name`
 * for exactly one, a last `**` for any further (none included). A path is
 * read the map's tolerant way: any case, an escape of a plain character
 * decoded, slashes run together.
 */
export const SECRET_SITE_READS: readonly string[] = [
  "/management/**",
  "/sessions/**",
  "/session/**",
  "/idv/**",
  "/twofa/**",
  "/login/**",
  "/account/emailchange/**",
  "/payments/payoutmethods/:methodId/**",
  "/payouts/documentation/**",
  "/streaming/channel/**",
];

const API_BASE_PARTS = FANSLY_API_BASE_PATH.split("/").filter((part) => part !== "");

const SECRET_TEMPLATES = SECRET_SITE_READS.map((template) => {
  const parts = template.slice(1).split("/");
  const rest = parts.at(-1) === "**";
  if (rest) parts.pop();
  // null: a parameter, any one segment.
  return { segments: parts.map((part) => (/^(:[A-Za-z_]\w*|\{[A-Za-z_]\w*\})$/.test(part) ? null : part.toLowerCase())), rest };
});

/** Whether a site request's path (`/api/v1/…`, its query aside) is a secret
 *  read (`SECRET_SITE_READS`). */
export function isSecretSiteRead(path: string): boolean {
  const decoded = path.split("?", 1)[0]!.replace(/%([0-9a-f]{2})/gi, (escape, hex: string) => {
    const char = String.fromCharCode(parseInt(hex, 16));
    return /[A-Za-z0-9\-._~/]/.test(char) ? char : escape;
  });
  const parts = decoded.split("/").filter((part) => part !== "").map((part) => part.toLowerCase());
  if (!API_BASE_PARTS.every((part, i) => parts[i] === part)) return false;
  const api = parts.slice(API_BASE_PARTS.length);
  return SECRET_TEMPLATES.some(({ segments, rest }) =>
    (rest ? api.length >= segments.length : api.length === segments.length)
    && segments.every((literal, i) => literal === null || literal === api[i]));
}

export interface SiteResponseObservation {
  source: "browser_site";
  producer: string;
  kind: string;
  payload: unknown;
  payloadHash: Buffer;
  idempotencyKey: string;
  /** How the answer was journaled (metrics, tests). */
  as: "route" | "site" | "failed" | "unconfirmed" | "incomplete";
}

/** The observation key of a site response (plan §3.2). */
export function siteResponseKey(pageId: number, bufferId: string, seq: number): string {
  return `fansly-site:${pageId}:${bufferId}:${seq}`;
}

/** The observation key of a site response of a profile no page has yet (its
 *  onboarding, PR 16): the buffer id is the volume's own, so no page's key is
 *  ever the same. */
export function profileSiteResponseKey(profileId: string, bufferId: string, seq: number): string {
  return `fansly-site:profile:${profileId}:${bufferId}:${seq}`;
}

/** The API path of a site request (from `/api/v1`). */
function apiPathOf(path: string): string {
  const bare = path.split("?", 1)[0]!;
  return bare.startsWith(`${FANSLY_API_BASE_PATH}/`) ? bare.slice(FANSLY_API_BASE_PATH.length) : bare;
}

/** The request's parameters as the route's template and its query name them
 *  (`{postId}` of `/post/{postId}/replies`, `?before=`): the codec's walk of
 *  a reply page needs them. */
function paramsOf(template: string, path: string, query: string): Record<string, string | null> {
  const params: Record<string, string | null> = {};
  const names = template.split("/");
  const values = apiPathOf(path).split("/");
  if (names.length === values.length) {
    for (let i = 0; i < names.length; i++) {
      const name = /^\{([A-Za-z_][A-Za-z0-9_]*)\}$/.exec(names[i]!)?.[1] ?? /^:([A-Za-z_][A-Za-z0-9_]*)$/.exec(names[i]!)?.[1];
      if (name !== undefined) params[name] = decodeURIComponent(values[i]!);
    }
  }
  for (const [key, value] of new URLSearchParams(query.startsWith("?") ? query.slice(1) : query)) params[key] ??= value;
  // A walk's position: absent is the first page.
  params.before ??= null;
  return params;
}

function bodyValue(text: string): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return text;
  }
}

function hashOf(payload: unknown): Buffer {
  return createHash("sha256").update(JSON.stringify(payload ?? null)).digest();
}

function lineOf(event: SiteResponseEvent) {
  return { method: event.method, path: event.path, query: event.query, status: event.status, source: event.source };
}

/** An answer's whole text, nothing cut: its only copy. */
function wholeOf(event: SiteResponseEvent, text: string, disposition: string): Record<string, unknown> {
  return replaceJournalUnstorableText({
    ...lineOf(event),
    contentType: event.headers["content-type"] ?? null,
    retryAfter: event.headers["retry-after"] ?? null,
    bodyText: text,
    disposition,
  }).value as Record<string, unknown>;
}

/**
 * The observation of one site response; null: never written (a login
 * operation, a write, a secret read). `body` is the body the event names,
 * whole and checked (null only when the operator could not take it:
 * `complete: false`).
 */
export function siteResponseObservation(input: {
  pageId: number;
  bufferId: string;
  event: SiteResponseEvent;
  body: Buffer | null;
  /** A profile no page has yet (PR 16): keyed by the profile, not a page. */
  profileId?: string;
}): SiteResponseObservation | null {
  const { event } = input;
  if (SECRET_ROUTES.has(event.route) || event.method.toUpperCase() !== "GET" || isSecretSiteRead(event.path)) return null;
  const routeSpec = isFanslyRoute(event.route) ? FANSLY_ROUTES.get(event.route) ?? null : null;
  const wireId: FanslyWireId | null = routeSpec?.wire ?? null;
  const wire = wireId === null ? null : fanslyWireSpec(wireId);
  const journaled = wire !== null && wire.host === "api" && wire.capture === undefined && wire.kind !== null ? wire.kind : null;
  const siteKind = `fansly.site.${event.route}`;
  const base = {
    source: "browser_site" as const,
    producer: `fansly-site:${event.route}`,
    idempotencyKey: input.profileId === undefined
      ? siteResponseKey(input.pageId, input.bufferId, event.seq)
      : profileSiteResponseKey(input.profileId, input.bufferId, event.seq),
  };
  const make = (kind: string, payload: unknown, as: SiteResponseObservation["as"]): SiteResponseObservation => ({
    ...base,
    kind,
    payload,
    payloadHash: hashOf(payload),
    as,
  });
  if (!event.complete || input.body === null) {
    return make(`${journaled ?? siteKind}:incomplete`, { ...lineOf(event), disposition: "incomplete_not_captured" }, "incomplete");
  }
  const text = new TextDecoder("utf-8").decode(input.body);
  if (journaled !== null && wire !== null && routeSpec !== null) {
    const unconfirmed = event.source === "cache_unconfirmed" || event.source === "service_worker";
    const params = paramsOf(routeSpec.template, event.path, event.query);
    try {
      const read = readFanslyWireResponse(wire as never, params as never, { status: event.status, headers: event.headers, bodyText: text });
      if (read.kind === "accepted" || read.kind === "contract_violation") {
        const journal = prepareJournalBody({ kind: journaled }, {
          response: read.response,
          contractAccepted: read.kind === "accepted",
          ...(wireId === "post.replies" && typeof params.postId === "string" ? { walk: { postId: params.postId, before: params.before ?? null } } : {}),
        });
        if (unconfirmed) {
          // Kept complete, through the codec, never as the route's answer.
          return make(`${journaled}:unconfirmed`, { ...lineOf(event), disposition: "rejected_not_applied", answer: journal.payload }, "unconfirmed");
        }
        return { ...base, kind: journaled, payload: journal.payload, payloadHash: journal.payloadHash, as: "route" };
      }
      if (unconfirmed) return make(`${journaled}:unconfirmed`, wholeOf(event, text, "rejected_not_applied"), "unconfirmed");
      return make(`${journaled}:failed`, wholeOf(event, text, "not_the_routes_answer"), "failed");
    } catch {
      // The codec cannot take it for this request (a reply page whose post
      // the path does not name): kept as the site's, as it is.
    }
  }
  // The CDN's signing tokens come off as the codec takes them off Hub's own
  // reads (lib/cdn-tokens.ts, owner decision 2026-09-29): by position only
  // (`locations[]`), nothing else rewritten, before the text is made
  // storable. Its allowlist names the engine's kinds; a site body is none of
  // them, and none is read for its URLs (the media describer reads the
  // engine's DM and purchase pages by id; nothing parses `fansly.site.*`).
  // As for every observation, no mapper field says so: a stripped body holds
  // no `Key-Pair-Id`, which is the same statement.
  const payload = replaceJournalUnstorableText({
    ...lineOf(event),
    contentType: event.headers["content-type"] ?? null,
    body: stripFanslySignedCdnTokens(bodyValue(text)),
  }).value;
  return make(siteKind, payload, "site");
}
