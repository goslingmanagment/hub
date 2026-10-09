import { FanslyCredentialsRefusedError } from "../errors.ts";
import { buildFanslyAnonymousRequestHeaders } from "../request-headers.ts";
import type { FanslyAccount } from "../types.ts";
import { parseFanslyAccountsByIds } from "./contracts.ts";
import type { FanslyWireReadSpec, FanslyWireRequest } from "./types.ts";

// The session-less side of the wire layer (arena "vanished chat" R5, plan §7,
// owner decision Р1): the routes a request WITHOUT any session may take, and
// the one builder that makes such a request. The public account reader asks
// Fansly whether an account exists the way a logged-out browser does — no
// authorization, no session or client id, no client check, no cookie — so its
// answer is nobody's page's: a fan who blocked a page is still found here.
//
// The two sides never mix (`FanslyWireCredentials`):
//   - every spec here is `credentials: "none"`, and none of them is in
//     `FANSLY_WIRE_SPECS` — no page's actor, plan or probe can name one;
//   - `buildFanslyPublicWireRequest` takes no session and no cookie (its input
//     has no field for either) and refuses, before it builds anything, a spec
//     that is not `credentials: "none"` and an input that carries a session or
//     cookies anyway;
//   - `buildFanslyWireRequest` (the page's builder) refuses these specs.
// Who sends such a request, through which egress and how often is the public
// reader's business (apps/runtime/src/sync/fansly/public-lookup.ts); this file
// only says what the request looks like and what its answer must contain.

/** The session-less routes, by wire id. */
export interface FanslyPublicWireParamsById {
  /** `GET /account?ids=` without a session: the accounts that exist. */
  "accounts.public_by_ids": { ids: readonly string[] };
}

export interface FanslyPublicWireResultById {
  "accounts.public_by_ids": FanslyAccount[];
}

export type FanslyPublicWireId = keyof FanslyPublicWireParamsById;

/** The observation kind the public reader journals its raw answer under —
 *  page-less (`account_id` null): the fan erasure reaches it by kind
 *  (services/erasure/index.ts `PAGELESS_FAN_OBSERVATION_KINDS`). */
export const FANSLY_PUBLIC_ACCOUNT_LOOKUP_KIND = "account_lookup_public";

/** Ids per session-less lookup: the size of every `?ids=` batch the app
 *  sends (`FANSLY_ACCOUNT_LOOKUP_BATCH_SIZE`). */
export const FANSLY_PUBLIC_ACCOUNT_LOOKUP_MAX_IDS = 100;

export interface FanslyPublicWireSpec<P, R> extends FanslyWireReadSpec<P, R> {
  readonly id: FanslyPublicWireId;
  /** Nothing of any session is on the request. */
  readonly credentials: "none";
  readonly host: "api";
  /** The page-less observation kind its raw answer is journaled under. */
  readonly kind: typeof FANSLY_PUBLIC_ACCOUNT_LOOKUP_KIND;
  readonly endpointTemplate: string;
  /** `fansly_send_log.operation` of the request. */
  readonly legacyOperation: string;
  path(params: P): string;
  /** The query after `ngsw-bypass=true`, in the order the app sends it. */
  query(params: P): Readonly<Record<string, string>>;
}

export type FanslyPublicWireSpecFor<I extends FanslyPublicWireId> =
  FanslyPublicWireSpec<FanslyPublicWireParamsById[I], FanslyPublicWireResultById[I]> & { readonly id: I };

const FANSLY_ID = /^[0-9]{1,30}$/;

/** The `ids` of a session-less lookup: 1–100 distinct Fansly account ids
 *  (digits). Anything else is a caller bug, refused before a request exists. */
function publicIdList(ids: readonly string[]): string {
  if (ids.length === 0 || ids.length > FANSLY_PUBLIC_ACCOUNT_LOOKUP_MAX_IDS) {
    throw new RangeError(
      `A session-less account lookup takes 1–${FANSLY_PUBLIC_ACCOUNT_LOOKUP_MAX_IDS} ids (got ${ids.length})`,
    );
  }
  ids.forEach((id, index) => {
    if (typeof id !== "string" || !FANSLY_ID.test(id)) {
      throw new RangeError(`A session-less account lookup takes Fansly account ids (ids[${index}] is not one)`);
    }
  });
  if (new Set(ids).size !== ids.length) {
    throw new RangeError("A session-less account lookup asks for each id once");
  }
  return ids.join(",");
}

export const FANSLY_PUBLIC_WIRE_SPECS: { readonly [I in FanslyPublicWireId]: FanslyPublicWireSpecFor<I> } = {
  "accounts.public_by_ids": {
    id: "accounts.public_by_ids",
    credentials: "none",
    kind: FANSLY_PUBLIC_ACCOUNT_LOOKUP_KIND,
    host: "api",
    endpointTemplate: "/account",
    legacyOperation: "account_lookup_public",
    path: () => "/account",
    query: (p) => ({ ids: publicIdList(p.ids) }),
    // The same contract as a page's lookup: an array of accounts, each with
    // its id. An id the answer omits is not found; the reader checks that
    // every returned id was asked for.
    parse: (response) => parseFanslyAccountsByIds(response),
  },
};

export function fanslyPublicWireSpec<I extends FanslyPublicWireId>(id: I): FanslyPublicWireSpecFor<I> {
  return FANSLY_PUBLIC_WIRE_SPECS[id];
}

/** A session-less request, ready to send (`sendFanslyWireRequest`). */
export interface FanslyPublicWireRequest extends Pick<FanslyWireRequest, "url" | "headers" | "timeoutMs"> {
  spec: FanslyPublicWireId;
  credentials: "none";
}

/** What the public builder takes: no session, no cookie — there is no field
 *  for either. */
export interface FanslyPublicWireRequestInput {
  baseUrl: string;
  timeoutMs: number;
}

/** Input keys that would carry a session or a cookie onto the request. */
const SESSION_INPUT_KEYS = ["session", "cookie", "cookies", "authorization", "headers"] as const;

/**
 * One session-less request: `ngsw-bypass=true` first, then the spec's query,
 * with the captured browser's headers and nothing of a session
 * (`buildFanslyAnonymousRequestHeaders`). Refuses — throwing
 * `FanslyCredentialsRefusedError` before anything is built, so nothing can be
 * journaled or sent — a spec that is not `credentials: "none"` (a page's
 * route passed here by a cast) and an input that carries a session, a cookie
 * or headers of its own.
 */
export function buildFanslyPublicWireRequest<I extends FanslyPublicWireId>(
  spec: FanslyPublicWireSpecFor<I>,
  params: FanslyPublicWireParamsById[I],
  input: FanslyPublicWireRequestInput,
): FanslyPublicWireRequest {
  const candidate = spec as { id?: unknown; credentials?: unknown; host?: unknown };
  const specId = typeof candidate.id === "string" ? candidate.id : "(no id)";
  if (candidate.credentials !== "none") {
    throw new FanslyCredentialsRefusedError("public", specId, "the spec is not session-less (credentials: none)");
  }
  if (!Object.hasOwn(FANSLY_PUBLIC_WIRE_SPECS, specId) || FANSLY_PUBLIC_WIRE_SPECS[specId as FanslyPublicWireId] !== spec) {
    throw new FanslyCredentialsRefusedError("public", specId, "not a route of FANSLY_PUBLIC_WIRE_SPECS");
  }
  if (candidate.host !== "api") {
    throw new FanslyCredentialsRefusedError("public", specId, "a session-less request goes to the API host only");
  }
  const carried = SESSION_INPUT_KEYS.filter((key) => Object.hasOwn(input, key));
  if (carried.length > 0) {
    throw new FanslyCredentialsRefusedError("public", specId, `the input carries ${carried.join(", ")}`);
  }
  if (!Number.isSafeInteger(input.timeoutMs) || input.timeoutMs <= 0) {
    throw new RangeError(`Fansly wire request timeout must be a positive integer (got ${input.timeoutMs})`);
  }
  const query = new URLSearchParams({ "ngsw-bypass": "true" });
  for (const [key, value] of Object.entries(spec.query(params))) {
    query.set(key, value);
  }
  return {
    spec: spec.id,
    credentials: "none",
    url: `${input.baseUrl}${spec.path(params)}?${query.toString()}`,
    headers: buildFanslyAnonymousRequestHeaders(),
    timeoutMs: input.timeoutMs,
  };
}
