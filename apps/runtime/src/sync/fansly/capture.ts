// The Fansly Sync Engine's journal body (design §3.11): what one served
// response becomes before it is committed to `observations` (tx 2,
// capture-before-parse).
//
// The engine journals in `observations` only — no `sync_raw_payloads` row —
// and its observation must be byte-for-byte the body the legacy lane journals
// for the same response, because the canonicalizer families, replay, the agent
// scrub and the AI describer read observations by kind and expect exactly that
// shape. So this file invents no transform: it applies, in the legacy order,
// the existing pure ones (services/sync/shared.ts persistRawPayload and the
// lanes that call it):
//
//   1. the lane's [A20] trim for the kinds that have one (follower and
//      conversation captures, notification / catalog / reply `accounts[]`);
//   2. the `post_replies` observation envelope `{walk:{postId, before},
//      response}` — the post id lives in the request PATH, and an empty reply
//      page could not otherwise say which post it is about;
//   3. the CDN signing-token strip for the kinds it names (never `dm_messages`
//      or `purchase_history*`: the AI describer downloads from those URLs);
//   4. the lone-surrogate replacement json/jsonb need.
//
// The served object is never mutated (each step copies on write), so the apply
// keeps using it — follower presence needs the untrimmed body (design §5.12).

import { createHash } from "node:crypto";

import { FANSLY_MAPPER_VERSION } from "@agency_hub_core/fansly";

import type { CaptureCodec } from "../engine/commit.ts";

import { FANSLY_CATALOG_CANONICALIZED_KINDS } from "../../services/canonicalize/fansly-catalog.ts";
import { FANSLY_PAYOUTS_CANONICALIZED_KINDS } from "../../services/canonicalize/fansly-payouts.ts";
import { FANSLY_STATS_CANONICALIZED_KINDS } from "../../services/canonicalize/fansly-stats.ts";
import {
  FANSLY_CDN_TOKENS_STRIPPED_MAPPER_SUFFIX,
  fanslyCdnTokenStripApplies,
  stripFanslySignedCdnTokens,
} from "../../services/sync/fansly-cdn-tokens.ts";
import { FANSLY_STATS_MAPPER_VERSION } from "../../services/sync/fansly-stats.ts";
import {
  JOURNAL_LONE_SURROGATES_REPLACED_MAPPER_SUFFIX,
  replaceJournalLoneSurrogates,
} from "../../services/sync/journal-lone-surrogates.ts";
import {
  captureFanslyFollowerPayload,
  captureFanslyMessagingGroupsPayload,
  FANSLY_CATALOG_CAPTURE_MAPPER_VERSION,
  FANSLY_FOLLOWERS_CAPTURE_MAPPER_VERSION,
  FANSLY_GROUPS_CAPTURE_MAPPER_VERSION,
  FANSLY_NOTIFICATIONS_CAPTURE_MAPPER_VERSION,
  FANSLY_PAYOUTS_CAPTURE_MAPPER_VERSION,
  FANSLY_POST_REPLIES_CAPTURE_MAPPER_VERSION,
  trimFanslyCatalogPayload,
  trimFanslyNotificationsPayload,
  trimFanslyPostRepliesPayload,
} from "../../services/sync/shared.ts";

/** The part of a wire spec this needs: the observation kind it journals
 *  under (`FanslyWireSpec.kind`). */
export interface FanslyJournalSpec {
  readonly kind: string;
}

export interface FanslyServedResponse {
  /** The envelope's `response` (or the wire layer's empty marker). Never
   *  mutated. An absent body is journaled as JSON null, as legacy does. */
  response: unknown;
  /**
   * The wire contract's verdict on `response`. Only `false` matters, and only
   * for the kinds whose legacy lane journals a refused body apart: followers
   * and conversations in the nested `{contractAccepted: false, responseShape,
   * captured}` form, so replay cannot mistake the trim's fallback arrays for a
   * valid empty page; the raw-wrapped kinds as `{contractAccepted: false, raw}`.
   */
  contractAccepted?: boolean;
  /** `post_replies` only (required there): the walk the request served. */
  walk?: { postId: string; before: string | null };
}

export interface FanslyJournalBody {
  /** The observation payload. */
  payload: unknown;
  /** sha256 of `JSON.stringify(payload)` — the observation's payload_hash,
   *  computed exactly as the legacy capture computes it. */
  payloadHash: Buffer;
  /** The capture-shape version legacy stamps on the raw row of the same
   *  response, suffixes included. Observations carry no mapper field; the
   *  engine reports it with the attempt. */
  mapperVersion: string;
  /** Unpaired UTF-16 surrogates replaced by U+FFFD in `payload`. */
  loneSurrogatesReplaced: number;
}

const CATALOG_KINDS: ReadonlySet<string> = new Set(FANSLY_CATALOG_CANONICALIZED_KINDS);
const PAYOUT_KINDS: ReadonlySet<string> = new Set(FANSLY_PAYOUTS_CANONICALIZED_KINDS);
const STATS_KINDS: ReadonlySet<string> = new Set(FANSLY_STATS_CANONICALIZED_KINDS);
/** Kinds journaled verbatim whose refused body the legacy lane wraps as
 *  `{contractAccepted: false, raw}` (subscribers: executor-handlers.ts
 *  `fanslySubscribersChunk`; group detail: the conversation sweep's
 *  `/group/:id` read). A resource that journals another such kind adds it here
 *  with its port. */
const RAW_WRAPPED_REFUSAL_KINDS: ReadonlySet<string> = new Set(["subscribers", "group_detail"]);

/** Step 1 (+ the mapper version that goes with it): the lane's own trim. */
function trimForKind(kind: string, served: FanslyServedResponse): { body: unknown; mapperVersion: string } {
  const response = served.response;
  if (kind === "followers") {
    return {
      body: captureFanslyFollowerPayload(response, served.contractAccepted),
      mapperVersion: FANSLY_FOLLOWERS_CAPTURE_MAPPER_VERSION,
    };
  }
  if (kind === "dm_conversations") {
    return {
      body: captureFanslyMessagingGroupsPayload(response, served.contractAccepted),
      mapperVersion: FANSLY_GROUPS_CAPTURE_MAPPER_VERSION,
    };
  }
  if (served.contractAccepted === false && RAW_WRAPPED_REFUSAL_KINDS.has(kind)) {
    return { body: { contractAccepted: false, raw: response }, mapperVersion: FANSLY_MAPPER_VERSION };
  }
  if (kind === "notifications") {
    return { body: trimFanslyNotificationsPayload(response), mapperVersion: FANSLY_NOTIFICATIONS_CAPTURE_MAPPER_VERSION };
  }
  if (kind === "post_replies") {
    return { body: trimFanslyPostRepliesPayload(response), mapperVersion: FANSLY_POST_REPLIES_CAPTURE_MAPPER_VERSION };
  }
  if (CATALOG_KINDS.has(kind)) {
    return { body: trimFanslyCatalogPayload(response), mapperVersion: FANSLY_CATALOG_CAPTURE_MAPPER_VERSION };
  }
  if (PAYOUT_KINDS.has(kind)) {
    return { body: response, mapperVersion: FANSLY_PAYOUTS_CAPTURE_MAPPER_VERSION };
  }
  if (STATS_KINDS.has(kind)) {
    return { body: response, mapperVersion: FANSLY_STATS_MAPPER_VERSION };
  }
  return { body: response, mapperVersion: FANSLY_MAPPER_VERSION };
}

/** The observation payload (and its hash) for one served Fansly response. */
export function prepareJournalBody(spec: FanslyJournalSpec, served: FanslyServedResponse): FanslyJournalBody {
  const trimmed = trimForKind(spec.kind, served);
  let mapperVersion = trimmed.mapperVersion;
  let body = trimmed.body;
  if (spec.kind === "post_replies") {
    if (served.walk === undefined) {
      throw new Error("A post_replies journal body needs the walk (postId, before) it served");
    }
    body = { walk: { postId: served.walk.postId, before: served.walk.before }, response: body };
  }
  // Legacy journals an absent body as JSON null (so it hashes deterministically).
  body ??= null;
  if (fanslyCdnTokenStripApplies("fansly", spec.kind)) {
    body = stripFanslySignedCdnTokens(body);
    mapperVersion = `${mapperVersion}${FANSLY_CDN_TOKENS_STRIPPED_MAPPER_SUFFIX}`;
  }
  const surrogates = replaceJournalLoneSurrogates(body);
  if (surrogates.replaced > 0) {
    mapperVersion = `${mapperVersion}${JOURNAL_LONE_SURROGATES_REPLACED_MAPPER_SUFFIX}`;
  }
  const payload = surrogates.value;
  return {
    payload,
    payloadHash: createHash("sha256").update(JSON.stringify(payload)).digest(),
    mapperVersion,
    loneSurrogatesReplaced: surrogates.replaced,
  };
}

/**
 * The Fansly journal of the engine's capture (tx 2): every served response
 * becomes exactly the body the legacy lane journals for it, by its kind. The
 * reply walk's position comes from the request (`post.replies` names the
 * post in its path).
 */
export const fanslyCaptureCodec: CaptureCodec = {
  prepare({ kind, response, contractAccepted, request }) {
    const params = request.params as { postId?: unknown; before?: unknown };
    const walk = request.spec === "post.replies" && typeof params.postId === "string"
      ? { postId: params.postId, before: typeof params.before === "string" ? params.before : null }
      : undefined;
    return prepareJournalBody({ kind }, { response, contractAccepted, ...(walk === undefined ? {} : { walk }) }).payload;
  },
};
