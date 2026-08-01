// Creator-post canonicalization. Fansly's ordinary sync journals the provider
// page verbatim as source=pull/kind=posts; this pure family turns each material
// head into a content-hashed post.observed event. The shared draft builder is
// also the one seam governed OFAPI capture materialization uses after its
// response passes the OFAPI contract parser.

import { createHash } from "node:crypto";

import {
  asString,
  isRecord,
  type CanonicalEventDraft,
  type CanonicalizableObservation,
} from "./types.ts";

export const POSTS_CANONICALIZER_VERSION = 1;
export const POSTS_CANONICALIZED_KINDS: ReadonlySet<string> = new Set(["posts"]);

export interface CanonicalPostMaterial {
  platform: "fansly" | "onlyfans";
  /** Stable raw-observation lineage. Retries of one capture dedupe; a later
   * capture advances the projection's last_observed_at even when unchanged. */
  observationId: number;
  postId: string;
  textPlain: string;
  publishedAt: Date;
  observedAt: Date;
  attachmentCount: number;
}

function postContentHash(input: CanonicalPostMaterial): string {
  // Fixed-position material tuple: deterministic without depending on object
  // key order. The raw payload remains verbatim in observations; this hash is
  // only the current projection's material-version identity.
  return createHash("sha256")
    .update(JSON.stringify([
      input.textPlain,
      input.publishedAt.toISOString(),
      input.attachmentCount,
    ]))
    .digest("hex");
}

/** Shared provider-material to canonical event seam. OFAPI's governed
 * capture parser calls this only after strict response acceptance; Fansly's
 * pull family below calls it after its own shape gate. */
export function buildPostObservedDraft(input: CanonicalPostMaterial): CanonicalEventDraft {
  const contentHash = postContentHash(input);
  return {
    type: "post.observed",
    occurredAt: input.publishedAt,
    postRef: input.postId,
    data: {
      platform: input.platform,
      textPlain: input.textPlain,
      publishedAt: input.publishedAt.toISOString(),
      observedAt: input.observedAt.toISOString(),
      attachmentCount: input.attachmentCount,
      contentHash,
    },
    schemaVersion: 1,
    // Account-scoped, source-observation idempotency: one parser retry is
    // stable; a later page is a distinct sighting; and a future parser that
    // corrects material from the SAME raw observation can append its new
    // content hash rather than colliding with the old canonical version.
    dedupKey: `post:${input.platform}:${input.postId}:${contentHash}:obs:${input.observationId}`,
  };
}

function fanslyPublishedAt(value: unknown): Date | null {
  if (typeof value === "number" && Number.isFinite(value) && value > 0) {
    const parsed = new Date(value >= 1_000_000_000_000 ? value : value * 1000);
    return Number.isNaN(parsed.getTime()) ? null : parsed;
  }
  if (typeof value === "string" && value.length > 0) {
    const parsed = new Date(value);
    return Number.isNaN(parsed.getTime()) ? null : parsed;
  }
  return null;
}

/** A drifted page stays UNSTAMPED for a future parser. Empty pages are valid;
 * every present item must expose an id and valid publication timestamp.
 * Missing/null content is an honest media-only post; a wrong non-null type is
 * drift and keeps the observation replayable. */
export function canParsePostsObservation(observation: CanonicalizableObservation): boolean {
  if (observation.platform !== "fansly" || !isRecord(observation.payload)) {
    return false;
  }
  const posts = observation.payload.posts;
  return Array.isArray(posts) && posts.every((post) => (
    isRecord(post)
    && asString(post.id) !== null
    && (post.content == null || typeof post.content === "string")
    && fanslyPublishedAt(post.createdAt) !== null
  ));
}

export function canonicalizePostsObservation(
  observation: CanonicalizableObservation,
): CanonicalEventDraft[] {
  if (!canParsePostsObservation(observation) || !isRecord(observation.payload)) {
    return [];
  }

  return (observation.payload.posts as Array<Record<string, unknown>>).map((post) => {
    const postId = asString(post.id)!;
    return buildPostObservedDraft({
      platform: "fansly",
      observationId: observation.id,
      postId,
      // Agent reads promise provider-verbatim post text. Keep HTML, entities,
      // whitespace and line endings exactly as captured; only a missing/null
      // media-only caption maps to the honest empty string.
      textPlain: typeof post.content === "string" ? post.content : "",
      publishedAt: fanslyPublishedAt(post.createdAt)!,
      observedAt: observation.receivedAt,
      attachmentCount: Array.isArray(post.attachments) ? post.attachments.length : 0,
    });
  });
}
