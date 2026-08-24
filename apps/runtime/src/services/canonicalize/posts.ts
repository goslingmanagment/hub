// Creator-post canonicalization. Fansly's ordinary sync journals timeline and
// post-tip responses verbatim before this pure family turns them into hidden,
// projection-only events. OFAPI uses the same post draft seam after its own
// governed capture contract passes.

import { createHash } from "node:crypto";

import {
  asString,
  isRecord,
  type CanonicalEventDraft,
  type CanonicalizeRunContext,
  type CanonicalizableObservation,
} from "./types.ts";

export const POSTS_CANONICALIZER_VERSION = 7;

/**
 * The hashtag tokenizer's own version, stored beside every derived token.
 *
 * SEPARATE from the family version on purpose: a family bump re-parses the
 * journal, while this number answers "which grammar produced THESE tokens" for
 * a row already in the table. It participates in the post content hash, so
 * raising it mints a new material revision for every post — which is the point:
 * a re-derivation must be visible as a new head, not a silent overwrite.
 */
export const HASHTAG_PARSER_VERSION = 1;

/**
 * Hashtags on Fansly arrive ONLY as caption text (A8): zero structured tag
 * fields on all 60 post objects in the 2026-08-19 capture; tag ids exist only
 * in stats aggregation and the discovery feed. So this grammar is the whole
 * definition of "a hashtag on this platform", and it is deliberately WIDER than
 * `\w+`:
 *
 *   - Unicode letters, numbers and MARKS (`\p{L}\p{N}\p{M}`) — `#кисуля`,
 *     `#日本語` and a combining-mark spelling are all tags people type, and an
 *     ASCII-only class would silently drop every non-Latin caption;
 *   - `_`, which `\w` covers and the Unicode classes do not;
 *   - ONE optional trailing `+`, defensively. Fansly's own discovery UI shows
 *     tags in that shape, and a caption that ends a tag with `+` should not
 *     lose the character. **`#teen+` does NOT appear in the HAR** and nothing
 *     here may be read as a claim that it was observed (A8).
 *
 * The `#` is not part of the stored token.
 */
const HASHTAG_PATTERN = /#([\p{L}\p{N}\p{M}_]+\+?)/gu;

export interface DerivedHashtags {
  raw: string[];
  normalized: string[];
  parserVersion: number;
}

/**
 * Derive the caption's tags: raw token exactly as written, plus its
 * NFKC-lowercased form.
 *
 * NFKC before lowercasing, not after: the compatibility fold is what makes a
 * full-width `＃ＦＩＴ` and an ASCII `#fit` the same tag, and folding after
 * lowercasing leaves the two apart. De-duplicated BY NORMALIZED FORM with the
 * first raw spelling kept — a caption that writes `#Viral #viral` names one
 * tag twice, not two tags — which also keeps the two arrays the same length,
 * the pairing the table's CHECK constraint enforces.
 */
export function deriveHashtags(text: string): DerivedHashtags {
  const raw: string[] = [];
  const normalized: string[] = [];
  const seen = new Set<string>();
  for (const match of text.matchAll(HASHTAG_PATTERN)) {
    const token = match[1];
    if (token === undefined) continue;
    const folded = token.normalize("NFKC").toLowerCase();
    if (seen.has(folded)) continue;
    seen.add(folded);
    raw.push(token);
    normalized.push(folded);
  }
  return { raw, normalized, parserVersion: HASHTAG_PARSER_VERSION };
}

/** The attachments' id-relations, and NOTHING else. The three keys are an
 *  ALLOWLIST rather than a redaction: a delivery URL cannot reach a serving
 *  column through a key nobody copies, whatever the platform starts embedding
 *  in `attachments[]` tomorrow. */
export interface CanonicalPostAttachmentRef {
  pos: number | null;
  contentType: number | null;
  contentId: string | null;
}

export const POSTS_CANONICALIZED_KINDS: ReadonlySet<string> = new Set([
  "posts",
  "post_tips",
]);

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
  /** Fansly-native mills. Optional means the capture lane has no such fact
   * (OFAPI); null means Fansly did not provide the field in this response. */
  tipAmountMills?: number | null;
  attachmentTipAmountMills?: number | null;
  postTipTotalMills?: number | null;
  /** Fansly true/false when attachments were supplied; null when that evidence
   * is absent or the platform does not capture it. */
  tipGoalLinked?: boolean | null;
  tipGoalRef?: string | null;
  tipGoalLabel?: string | null;
  tipGoalTargetMills?: number | null;
  tipGoalCurrentMills?: number | null;
  tipGoalAmountsHidden?: boolean | null;
  // ── WP-F6 (v6): the engagement/thread/placement material ───────────────────
  // Every one of these is OPTIONAL in the type (the OFAPI post seam supplies
  // none of them) and NULLABLE in the value (Fansly served the key and it was
  // empty, or did not serve it). Absent is null, never 0 — `replyCount` was
  // absent on 6 of 15 live timeline posts and present on the other 9.
  likeCount?: number | null;
  mediaLikeCount?: number | null;
  replyCount?: number | null;
  fypFlags?: number | null;
  expiresAt?: Date | null;
  inReplyToRef?: string | null;
  inReplyToRootRef?: string | null;
  wallRefs?: string[] | null;
  accountMentionRefs?: string[] | null;
  attachmentRefs?: CanonicalPostAttachmentRef[] | null;
}

export type PostTipGoalAttribution = "goal" | "direct" | "unknown";

export interface CanonicalPostTipMaterial {
  observationId: number;
  tipId: string;
  postId: string;
  senderPlatformUserId: string;
  amountMills: number;
  occurredAt: Date;
  observedAt: Date;
  receiverTransactionRef: string | null;
  senderTransactionRef: string | null;
  tipGoalRef: string | null;
  /** Goal evidence is independent of a nullable ref: flat live responses name
   * the post exactly but cannot prove whether the tip funded its linked goal. */
  tipGoalAttribution: PostTipGoalAttribution;
  /** Provider-verbatim Fansly tip message. Empty text remains an empty string;
   * only an absent/null provider field becomes null. */
  tipMessageText: string | null;
}

type NormalizedPostMoney = {
  tipAmountMills: number | null;
  attachmentTipAmountMills: number | null;
  postTipTotalMills: number | null;
  tipGoalLinked: boolean | null;
  tipGoalRef: string | null;
  tipGoalLabel: string | null;
  tipGoalTargetMills: number | null;
  tipGoalCurrentMills: number | null;
  tipGoalAmountsHidden: boolean | null;
};

function normalizedPostMoney(input: CanonicalPostMaterial): NormalizedPostMoney {
  return {
    tipAmountMills: input.tipAmountMills ?? null,
    attachmentTipAmountMills: input.attachmentTipAmountMills ?? null,
    postTipTotalMills: input.postTipTotalMills ?? null,
    tipGoalLinked: input.tipGoalLinked ?? null,
    tipGoalRef: input.tipGoalRef ?? null,
    tipGoalLabel: input.tipGoalLabel ?? null,
    tipGoalTargetMills: input.tipGoalTargetMills ?? null,
    tipGoalCurrentMills: input.tipGoalCurrentMills ?? null,
    tipGoalAmountsHidden: input.tipGoalAmountsHidden ?? null,
  };
}

type NormalizedPostEngagement = {
  likeCount: number | null;
  mediaLikeCount: number | null;
  replyCount: number | null;
  fypFlags: number | null;
  expiresAt: string | null;
  inReplyToRef: string | null;
  inReplyToRootRef: string | null;
  wallRefs: string[] | null;
  accountMentionRefs: string[] | null;
  attachmentRefs: CanonicalPostAttachmentRef[] | null;
  hashtags: string[];
  hashtagsNormalized: string[];
  hashtagParserVersion: number;
};

/** WP-F6's half of the material, normalized once so the hash, the event data
 *  and the projector all read the same shape. Hashtags are DERIVED here rather
 *  than passed in: they are a pure function of `textPlain`, and deriving them at
 *  the one seam every post draft passes through is what makes the OFAPI post
 *  path get them too the day its captions carry tags. */
function normalizedPostEngagement(input: CanonicalPostMaterial): NormalizedPostEngagement {
  const hashtags = deriveHashtags(input.textPlain);
  return {
    likeCount: input.likeCount ?? null,
    mediaLikeCount: input.mediaLikeCount ?? null,
    replyCount: input.replyCount ?? null,
    fypFlags: input.fypFlags ?? null,
    expiresAt: input.expiresAt?.toISOString() ?? null,
    inReplyToRef: input.inReplyToRef ?? null,
    inReplyToRootRef: input.inReplyToRootRef ?? null,
    wallRefs: input.wallRefs ?? null,
    accountMentionRefs: input.accountMentionRefs ?? null,
    attachmentRefs: input.attachmentRefs ?? null,
    hashtags: hashtags.raw,
    hashtagsNormalized: hashtags.normalized,
    hashtagParserVersion: hashtags.parserVersion,
  };
}

function postContentHash(input: CanonicalPostMaterial): string {
  const money = normalizedPostMoney(input);
  const engagement = normalizedPostEngagement(input);
  // Fixed-position v3 material tuple: deterministic without depending on
  // object key order. All monetization fields participate, so a money-only
  // change creates a new immutable event and advances the current head — and
  // from v3 so does every engagement counter, which is the whole point of the
  // refresh lane: a like count that moved is a NEW material revision and a new
  // head, not an in-place edit of the row that recorded the old one.
  //
  // The hashtag PARSER VERSION participates too, so a grammar change re-mints
  // every post rather than silently rewriting tokens under the old lineage.
  return createHash("sha256")
    .update(JSON.stringify([
      "post-material-v3",
      input.textPlain,
      input.publishedAt.toISOString(),
      input.attachmentCount,
      money.tipAmountMills,
      money.attachmentTipAmountMills,
      money.postTipTotalMills,
      money.tipGoalLinked,
      money.tipGoalRef,
      money.tipGoalLabel,
      money.tipGoalTargetMills,
      money.tipGoalCurrentMills,
      money.tipGoalAmountsHidden,
      engagement.likeCount,
      engagement.mediaLikeCount,
      engagement.replyCount,
      engagement.fypFlags,
      engagement.expiresAt,
      engagement.inReplyToRef,
      engagement.inReplyToRootRef,
      engagement.wallRefs,
      engagement.accountMentionRefs,
      engagement.attachmentRefs,
      engagement.hashtags,
      engagement.hashtagsNormalized,
      engagement.hashtagParserVersion,
    ]))
    .digest("hex");
}

/** Shared provider-material to canonical event seam. OFAPI's governed capture
 * parser calls this only after strict response acceptance; Fansly's pull family
 * below calls it after its own shape gate. */
export function buildPostObservedDraft(input: CanonicalPostMaterial): CanonicalEventDraft {
  const contentHash = postContentHash(input);
  const money = normalizedPostMoney(input);
  const engagement = normalizedPostEngagement(input);
  return {
    type: "post.observed",
    // PROVIDER-DATED, and deliberately so — the §3.2b exception this family has
    // always been. The post's own publication instant IS this event's
    // occurred_at, which is why the driver's [2024-01-01, now+2mo] clamp can
    // fire here (and why the v6 drain across history is covered by §3.2c(ii)'s
    // target-month census). The projected row still dates from
    // `data.publishedAt`, never from `event.occurredAt`.
    occurredAt: input.publishedAt,
    postRef: input.postId,
    data: {
      platform: input.platform,
      textPlain: input.textPlain,
      publishedAt: input.publishedAt.toISOString(),
      observedAt: input.observedAt.toISOString(),
      attachmentCount: input.attachmentCount,
      ...money,
      ...engagement,
      contentHash,
    },
    schemaVersion: 3,
    // Account-scoped, source-observation idempotency: one parser retry is
    // stable; later captures are distinct sightings; corrected v3 material
    // from an old raw observation does not collide with the v1/v2 event.
    dedupKey: `post:v3:${input.platform}:${input.postId}:${contentHash}:obs:${input.observationId}`,
  };
}

function postTipContentHash(input: CanonicalPostTipMaterial): string {
  return createHash("sha256")
    .update(JSON.stringify([
      "post-tip-material-v3",
      input.senderPlatformUserId,
      input.amountMills,
      input.occurredAt.toISOString(),
      input.receiverTransactionRef,
      input.senderTransactionRef,
      input.tipGoalRef,
      input.tipGoalAttribution,
      input.tipMessageText,
    ]))
    .digest("hex");
}

export function buildPostTipObservedDraft(
  input: CanonicalPostTipMaterial,
): CanonicalEventDraft {
  if ((input.tipGoalAttribution === "goal") !== (input.tipGoalRef !== null)) {
    throw new Error("post tip goal attribution is incoherent with tipGoalRef");
  }
  const contentHash = postTipContentHash(input);
  return {
    type: "post.tip_observed",
    occurredAt: input.occurredAt,
    fanIdentityRef: input.senderPlatformUserId,
    transactionRef: input.receiverTransactionRef,
    postRef: input.postId,
    data: {
      platform: "fansly",
      tipId: input.tipId,
      senderPlatformUserId: input.senderPlatformUserId,
      amountMills: input.amountMills,
      occurredAt: input.occurredAt.toISOString(),
      observedAt: input.observedAt.toISOString(),
      receiverTransactionRef: input.receiverTransactionRef,
      senderTransactionRef: input.senderTransactionRef,
      tipGoalRef: input.tipGoalRef,
      tipGoalAttribution: input.tipGoalAttribution,
      tipMessageText: input.tipMessageText,
      contentHash,
    },
    schemaVersion: 3,
    dedupKey: `post-tip:v3:fansly:${input.tipId}:${input.postId}:${contentHash}:obs:${input.observationId}`,
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

type NullableField<T> = { valid: true; value: T | null } | { valid: false };

function nullableNonnegativeSafeInteger(value: unknown): NullableField<number> {
  if (value === undefined || value === null) {
    return { valid: true, value: null };
  }
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0
    ? { valid: true, value }
    : { valid: false };
}

function nullableNonemptyString(value: unknown): NullableField<string> {
  if (value === undefined || value === null) {
    return { valid: true, value: null };
  }
  return typeof value === "string" && value.length > 0
    ? { valid: true, value }
    : { valid: false };
}

function nullableVerbatimString(value: unknown): NullableField<string> {
  if (value === undefined || value === null) {
    return { valid: true, value: null };
  }
  return typeof value === "string"
    ? { valid: true, value }
    : { valid: false };
}

function nullableHideAmounts(value: unknown): NullableField<boolean> {
  if (value === undefined || value === null) {
    return { valid: true, value: null };
  }
  if (value === true || value === 1) return { valid: true, value: true };
  if (value === false || value === 0) return { valid: true, value: false };
  return { valid: false };
}

type ParsedGoal = {
  ref: string;
  label: string | null;
  targetMills: number | null;
  currentMills: number | null;
  amountsHidden: boolean | null;
};

function parseTipGoals(payload: Record<string, unknown>): Map<string, ParsedGoal> | null {
  if (payload.tipGoals === undefined || payload.tipGoals === null) {
    return new Map();
  }
  if (!Array.isArray(payload.tipGoals)) return null;

  const goals = new Map<string, ParsedGoal>();
  for (const raw of payload.tipGoals) {
    if (!isRecord(raw)) return null;
    const ref = asString(raw.id);
    const label = nullableVerbatimString(raw.label);
    const target = nullableNonnegativeSafeInteger(raw.goalAmount);
    const current = nullableNonnegativeSafeInteger(raw.currentAmount);
    const hidden = nullableHideAmounts(raw.hideAmounts);
    if (
      ref === null || goals.has(ref) || !label.valid || !target.valid
      || !current.valid || !hidden.valid
    ) {
      return null;
    }
    goals.set(ref, {
      ref,
      label: label.value,
      targetMills: target.value,
      currentMills: current.value,
      amountsHidden: hidden.value,
    });
  }
  return goals;
}

type ParsedFanslyPost = {
  postId: string;
  textPlain: string;
  publishedAt: Date;
  attachmentCount: number;
  money: NormalizedPostMoney;
  engagement: ParsedFanslyPostEngagement;
};

type ParsedFanslyPostEngagement = {
  likeCount: number | null;
  mediaLikeCount: number | null;
  replyCount: number | null;
  fypFlags: number | null;
  expiresAt: Date | null;
  inReplyToRef: string | null;
  inReplyToRootRef: string | null;
  wallRefs: string[] | null;
  accountMentionRefs: string[] | null;
  attachmentRefs: CanonicalPostAttachmentRef[] | null;
};

/** A ref list: absent/null means the response did not carry the field, `[]`
 *  means it carried it empty. `/timelinenew` does not serve `wallIds` at all
 *  while `GET /post?ids=` serves it as `[]` — two different facts, and
 *  collapsing them would let the batch read's "no walls" be manufactured from
 *  the timeline's silence. */
function nullableRefList(value: unknown): NullableField<string[]> {
  if (value === undefined || value === null) {
    return { valid: true, value: null };
  }
  if (!Array.isArray(value)) return { valid: false };
  const refs: string[] = [];
  for (const item of value) {
    const ref = asString(item);
    if (ref === null) return { valid: false };
    if (!refs.includes(ref)) refs.push(ref);
  }
  return { valid: true, value: refs };
}

/** `accountMentions[]` rows normally include `{start, end, handle, accountId}`,
 *  but retained production pages also contain the provider's legitimate
 *  `{start, end, handle}` form. Only the ACCOUNT REF is kept: offsets belong to
 *  the verbatim caption (which the journal holds) and a handle is a mutable
 *  display name. If any structurally valid mention omits `accountId`, the whole
 *  ref field is unknown (`null`) rather than a partial list or a fabricated
 *  empty list. */
function nullableAccountMentionRefs(value: unknown): NullableField<string[]> {
  if (value === undefined || value === null) {
    return { valid: true, value: null };
  }
  if (!Array.isArray(value)) return { valid: false };
  const refs: string[] = [];
  let refsComplete = true;
  for (const item of value) {
    if (!isRecord(item)) return { valid: false };
    const ref = asString(item.accountId);
    if (ref === null) {
      // The only id-less shape admitted here is the one verified in retained
      // production observations. Validating its caption coordinates and handle
      // keeps a genuinely drifted object replayable instead of blessing every
      // object that happens not to contain `accountId`.
      const start = item.start;
      const end = item.end;
      if (
        item.accountId !== undefined
        || typeof start !== "number"
        || !Number.isSafeInteger(start)
        || start < 0
        || typeof end !== "number"
        || !Number.isSafeInteger(end)
        || end < start
        || typeof item.handle !== "string"
        || item.handle.length === 0
      ) {
        return { valid: false };
      }
      refsComplete = false;
      continue;
    }
    if (!refs.includes(ref)) refs.push(ref);
  }
  return { valid: true, value: refsComplete ? refs : null };
}

/** The attachments' id-relations. Built from an ALLOWLIST of three keys, so a
 *  `location`, `variants[]` or any future URL-bearing key the platform adds to
 *  `attachments[]` cannot reach a serving column — it stays in the raw journal,
 *  read by nothing. `postId` is dropped as redundant with the row's own key. */
function attachmentRefsFrom(
  attachments: readonly Record<string, unknown>[],
): CanonicalPostAttachmentRef[] {
  return attachments.map((attachment) => ({
    pos: typeof attachment.pos === "number" && Number.isSafeInteger(attachment.pos)
      ? attachment.pos
      : null,
    contentType:
      typeof attachment.contentType === "number" && Number.isSafeInteger(attachment.contentType)
        ? attachment.contentType
        : null,
    contentId: asString(attachment.contentId),
  }));
}

export type PostsObservationParseRejectionCode =
  | "platform_not_fansly"
  | "kind_not_supported"
  | "payload_not_object"
  | "posts_not_array"
  | "tip_goals_invalid"
  | "post_not_object"
  | "post_id_invalid"
  | "created_at_invalid"
  | "content_invalid"
  | "attachments_invalid"
  | "attachment_not_object"
  | "goal_attachment_ref_invalid"
  | "multiple_goal_attachments"
  | "tip_amount_invalid"
  | "attachment_tip_amount_invalid"
  | "post_tip_total_overflow"
  | "like_count_invalid"
  | "media_like_count_invalid"
  | "reply_count_invalid"
  | "fyp_flags_invalid"
  | "in_reply_to_invalid"
  | "in_reply_to_root_invalid"
  | "wall_ids_invalid"
  | "account_mentions_invalid"
  | "expires_at_invalid"
  | "post_tips_not_array";

export type PostsObservationParseRejection = {
  code: PostsObservationParseRejectionCode;
  /** Index in payload.posts. No provider content is exposed. */
  itemIndex?: number;
};

type ParsedFanslyPostsPayloadResult =
  | { accepted: true; posts: ParsedFanslyPost[] }
  | { accepted: false; rejection: PostsObservationParseRejection };

function rejectPostsPayload(
  code: PostsObservationParseRejectionCode,
  itemIndex?: number,
): ParsedFanslyPostsPayloadResult {
  return {
    accepted: false,
    rejection: {
      code,
      ...(itemIndex === undefined ? {} : { itemIndex }),
    },
  };
}

function parseFanslyPostsPayloadDetailed(payload: unknown): ParsedFanslyPostsPayloadResult {
  if (!isRecord(payload)) return rejectPostsPayload("payload_not_object");
  if (!Array.isArray(payload.posts)) return rejectPostsPayload("posts_not_array");
  const goals = parseTipGoals(payload);
  if (goals === null) return rejectPostsPayload("tip_goals_invalid");

  const parsed: ParsedFanslyPost[] = [];
  for (const [itemIndex, rawPost] of payload.posts.entries()) {
    if (!isRecord(rawPost)) return rejectPostsPayload("post_not_object", itemIndex);
    const post = rawPost;
    const postId = asString(post.id);
    const publishedAt = fanslyPublishedAt(post.createdAt);
    if (postId === null) return rejectPostsPayload("post_id_invalid", itemIndex);
    if (publishedAt === null) return rejectPostsPayload("created_at_invalid", itemIndex);
    if (post.content != null && typeof post.content !== "string") {
      return rejectPostsPayload("content_invalid", itemIndex);
    }
    if (post.attachments != null && !Array.isArray(post.attachments)) {
      return rejectPostsPayload("attachments_invalid", itemIndex);
    }

    const attachmentsProvided = Array.isArray(post.attachments);
    const attachments = attachmentsProvided ? post.attachments as unknown[] : [];
    if (!attachments.every(isRecord)) {
      return rejectPostsPayload("attachment_not_object", itemIndex);
    }
    const goalRefs = new Set<string>();
    let attachmentTypesComplete = true;
    for (const attachment of attachments) {
      if (typeof attachment.contentType !== "number" || !Number.isSafeInteger(attachment.contentType)) {
        attachmentTypesComplete = false;
        continue;
      }
      if (attachment.contentType !== 7100) continue;
      const goalRef = asString(attachment.contentId);
      if (goalRef === null) {
        return rejectPostsPayload("goal_attachment_ref_invalid", itemIndex);
      }
      goalRefs.add(goalRef);
    }
    // Fansly currently exposes one goal attachment per post. Refuse ambiguity
    // instead of silently choosing one; the raw page remains replayable.
    if (goalRefs.size > 1) {
      return rejectPostsPayload("multiple_goal_attachments", itemIndex);
    }

    const tipAmount = nullableNonnegativeSafeInteger(post.tipAmount);
    const attachmentTipAmount = nullableNonnegativeSafeInteger(post.attachmentTipAmount);
    if (!tipAmount.valid) return rejectPostsPayload("tip_amount_invalid", itemIndex);
    if (!attachmentTipAmount.valid) {
      return rejectPostsPayload("attachment_tip_amount_invalid", itemIndex);
    }
    const hasPostTipTotal = tipAmount.value !== null || attachmentTipAmount.value !== null;
    const postTipTotalMills = hasPostTipTotal
      ? (tipAmount.value ?? 0) + (attachmentTipAmount.value ?? 0)
      : null;
    if (postTipTotalMills !== null && !Number.isSafeInteger(postTipTotalMills)) {
      return rejectPostsPayload("post_tip_total_overflow", itemIndex);
    }

    // ── WP-F6 (v6) engagement/thread/placement fields ─────────────────────
    // Each one refuses the WHOLE page on a shape it cannot read, which is the
    // house law: a drifted response stays UNSTAMPED and replayable rather than
    // being half-parsed into a serving table.
    const likeCount = nullableNonnegativeSafeInteger(post.likeCount);
    const mediaLikeCount = nullableNonnegativeSafeInteger(post.mediaLikeCount);
    const replyCount = nullableNonnegativeSafeInteger(post.replyCount);
    const fypFlags = nullableNonnegativeSafeInteger(post.fypFlags);
    const inReplyToRef = nullableNonemptyString(post.inReplyTo);
    const inReplyToRootRef = nullableNonemptyString(post.inReplyToRoot);
    const wallRefs = nullableRefList(post.wallIds);
    const accountMentionRefs = nullableAccountMentionRefs(post.accountMentions);
    // `expiresAt` shares `createdAt`'s encoding (seconds in every observed
    // response); an explicit null is "this post does not expire".
    const expiresAt = post.expiresAt === undefined || post.expiresAt === null
      ? null
      : fanslyPublishedAt(post.expiresAt);
    if (!likeCount.valid) return rejectPostsPayload("like_count_invalid", itemIndex);
    if (!mediaLikeCount.valid) {
      return rejectPostsPayload("media_like_count_invalid", itemIndex);
    }
    if (!replyCount.valid) return rejectPostsPayload("reply_count_invalid", itemIndex);
    if (!fypFlags.valid) return rejectPostsPayload("fyp_flags_invalid", itemIndex);
    if (!inReplyToRef.valid) return rejectPostsPayload("in_reply_to_invalid", itemIndex);
    if (!inReplyToRootRef.valid) {
      return rejectPostsPayload("in_reply_to_root_invalid", itemIndex);
    }
    if (!wallRefs.valid) return rejectPostsPayload("wall_ids_invalid", itemIndex);
    if (!accountMentionRefs.valid) {
      return rejectPostsPayload("account_mentions_invalid", itemIndex);
    }
    if (post.expiresAt !== undefined && post.expiresAt !== null && expiresAt === null) {
      return rejectPostsPayload("expires_at_invalid", itemIndex);
    }

    const tipGoalRef = [...goalRefs][0] ?? null;
    const goal = tipGoalRef === null ? null : goals.get(tipGoalRef) ?? null;
    parsed.push({
      postId,
      textPlain: typeof post.content === "string" ? post.content : "",
      publishedAt,
      attachmentCount: attachments.length,
      engagement: {
        likeCount: likeCount.value,
        mediaLikeCount: mediaLikeCount.value,
        replyCount: replyCount.value,
        fypFlags: fypFlags.value,
        expiresAt,
        inReplyToRef: inReplyToRef.value,
        inReplyToRootRef: inReplyToRootRef.value,
        wallRefs: wallRefs.value,
        accountMentionRefs: accountMentionRefs.value,
        // An ABSENT `attachments` field cannot prove the post has no
        // attachments — the same distinction `tipGoalLinked` already makes.
        attachmentRefs: attachmentsProvided ? attachmentRefsFrom(attachments) : null,
      },
      money: {
        tipAmountMills: tipAmount.value,
        attachmentTipAmountMills: attachmentTipAmount.value,
        postTipTotalMills,
        // A missing/null attachments field cannot prove that the post has no
        // goal. Preserve that as unknown; an explicit empty array proves false.
        tipGoalLinked: !attachmentsProvided
          ? null
          : tipGoalRef !== null
            ? true
            : attachmentTypesComplete
              ? false
              : null,
        tipGoalRef,
        tipGoalLabel: goal?.label ?? null,
        tipGoalTargetMills: goal?.targetMills ?? null,
        tipGoalCurrentMills: goal?.currentMills ?? null,
        tipGoalAmountsHidden: goal?.amountsHidden ?? null,
      },
    });
  }
  return { accepted: true, posts: parsed };
}

function parseFanslyPostsPayload(payload: unknown): ParsedFanslyPost[] | null {
  const result = parseFanslyPostsPayloadDetailed(payload);
  return result.accepted ? result.posts : null;
}

type ParsedFanslyTip = Omit<CanonicalPostTipMaterial, "observationId" | "observedAt">;

type FanslyPostTipRejectionReason =
  | "not_object"
  | "invalid_core_fields"
  | "invalid_targets"
  | "post_target_count"
  | "goal_target_count"
  | "goal_reference_mismatch"
  | "post_reference_mismatch"
  | "receiver_mismatch";

type FanslyPostTipRejection = {
  index: number;
  reason: FanslyPostTipRejectionReason;
};

type ParsedFanslyPostTipsPayload = {
  tips: ParsedFanslyTip[];
  rejected: FanslyPostTipRejection[];
};

function parseFanslyPostTip(
  tip: unknown,
  expectedReceiverId?: string | null,
): { tip: ParsedFanslyTip } | { reason: FanslyPostTipRejectionReason } {
  if (!isRecord(tip)) return { reason: "not_object" };
  const tipId = asString(tip.id);
  const senderPlatformUserId = asString(tip.senderId);
  const receiverPlatformUserId = nullableNonemptyString(tip.receiverId);
  const amount = nullableNonnegativeSafeInteger(tip.amount);
  const occurredAt = fanslyPublishedAt(tip.createdAt);
  const receiverTransactionRef = nullableNonemptyString(tip.receiverTransactionId);
  const senderTransactionRef = nullableNonemptyString(tip.senderTransactionId);
  const providerTipGoalRef = nullableNonemptyString(tip.tipGoalId);
  const tipMessageText = nullableVerbatimString(tip.message);
  if (
    tipId === null || senderPlatformUserId === null || !receiverPlatformUserId.valid
    || !amount.valid || amount.value === null
    || occurredAt === null || !receiverTransactionRef.valid
    || !senderTransactionRef.valid || !providerTipGoalRef.valid
    || !tipMessageText.valid
  ) {
    return { reason: "invalid_core_fields" };
  }
  // Canonicalization normally receives the page's native Fansly account ref.
  // Refuse a response item scoped to another receiver (or missing its receiver)
  // instead of projecting it under the account that happened to make the HTTP
  // request. Tests/pure callers without catalog context retain shape-only
  // behavior; the sync-time request-target guard is the other boundary.
  if (
    expectedReceiverId !== undefined && expectedReceiverId !== null
    && receiverPlatformUserId.value !== expectedReceiverId
  ) {
    return { reason: "receiver_mismatch" };
  }

  const flatPostRef = nullableNonemptyString(tip.targetId);
  if (!flatPostRef.valid) return { reason: "invalid_targets" };
  if (tip.targets === undefined) {
    if (flatPostRef.value === null) return { reason: "post_target_count" };
    // A top-level goal id cannot turn the flat shape into exact goal evidence;
    // retain the same corroboration rule as nested targets and fail closed.
    if (providerTipGoalRef.value !== null) {
      return { reason: "goal_reference_mismatch" };
    }
    return {
      tip: {
        tipId,
        postId: flatPostRef.value,
        senderPlatformUserId,
        amountMills: amount.value,
        occurredAt,
        receiverTransactionRef: receiverTransactionRef.value,
        senderTransactionRef: senderTransactionRef.value,
        tipGoalRef: null,
        tipGoalAttribution: "unknown",
        tipMessageText: tipMessageText.value,
      },
    };
  }
  if (!Array.isArray(tip.targets)) return { reason: "invalid_targets" };

  let postTargetCount = 0;
  let postId: string | null = null;
  let goalTargetCount = 0;
  let goalTargetRef: string | null = null;
  for (const target of tip.targets) {
    if (!isRecord(target)) return { reason: "invalid_targets" };
    if (target.type === 1000) {
      const postRef = asString(target.id);
      if (postRef === null) return { reason: "invalid_targets" };
      postTargetCount += 1;
      postId = postRef;
    } else if (target.type === 7100) {
      const goalRef = asString(target.id);
      if (goalRef === null) return { reason: "invalid_targets" };
      goalTargetCount += 1;
      goalTargetRef = goalRef;
    }
  }
  if (postTargetCount !== 1 || postId === null) {
    return { reason: "post_target_count" };
  }
  if (flatPostRef.value !== null && flatPostRef.value !== postId) {
    return { reason: "post_reference_mismatch" };
  }
  if (goalTargetCount > 1) {
    return { reason: "goal_target_count" };
  }
  // Some provider versions also emit tipGoalId. It may corroborate the
  // target but may never substitute for one or contradict it.
  if (
    providerTipGoalRef.value !== null
    && providerTipGoalRef.value !== goalTargetRef
  ) {
    return { reason: "goal_reference_mismatch" };
  }
  return {
    tip: {
      tipId,
      postId,
      senderPlatformUserId,
      amountMills: amount.value,
      occurredAt,
      receiverTransactionRef: receiverTransactionRef.value,
      senderTransactionRef: senderTransactionRef.value,
      tipGoalRef: goalTargetRef,
      tipGoalAttribution: goalTargetRef === null ? "direct" : "goal",
      tipMessageText: tipMessageText.value,
    },
  };
}

function parseFanslyPostTipsPayload(
  payload: unknown,
  expectedReceiverId?: string | null,
): ParsedFanslyPostTipsPayload | null {
  if (!Array.isArray(payload)) return null;
  const tips: ParsedFanslyTip[] = [];
  const rejected: FanslyPostTipRejection[] = [];
  for (const [index, item] of payload.entries()) {
    const result = parseFanslyPostTip(item, expectedReceiverId);
    if ("tip" in result) {
      tips.push(result.tip);
    } else {
      rejected.push({ index, reason: result.reason });
    }
  }
  return { tips, rejected };
}

function buildPostTipParseRejectedDraft(
  observation: CanonicalizableObservation,
  rejected: readonly FanslyPostTipRejection[],
): CanonicalEventDraft {
  const contentHash = createHash("sha256")
    .update(JSON.stringify(["post-tip-parse-rejected-v1", rejected]))
    .digest("hex");
  return {
    type: "post.tip_parse_rejected",
    occurredAt: observation.receivedAt,
    data: {
      platform: "fansly",
      parserVersion: POSTS_CANONICALIZER_VERSION,
      rejectedItemCount: rejected.length,
      rejectedItems: rejected,
      contentHash,
    },
    schemaVersion: 1,
    dedupKey: [
      "post-tip-parse-rejected:v1:fansly",
      `obs:${observation.id}`,
      `parser:${POSTS_CANONICALIZER_VERSION}`,
      contentHash,
    ].join(":"),
  };
}

/** A drifted response stays UNSTAMPED for a future parser. Empty timeline and
 * tip arrays are valid; every present monetary scalar must be a non-negative
 * safe integer in Fansly-native mills. */
export function canParsePostsObservation(observation: CanonicalizableObservation): boolean {
  if (observation.platform !== "fansly") return false;
  if (observation.kind === "posts") {
    return parseFanslyPostsPayloadDetailed(observation.payload).accepted;
  }
  if (observation.kind === "post_tips") {
    // Recognizing the array envelope is enough to isolate item-level drift:
    // valid tips still canonicalize, while rejected item indexes/reasons are
    // recorded as replayable parse debt. A non-array response remains wholly
    // unparsed for a future family version.
    return Array.isArray(observation.payload);
  }
  return false;
}

/** Fixed-code explanation for the first predicate that refused an observation.
 * The driver exposes this beside the observation id; no provider text or raw
 * field value leaves the journal. */
export function diagnosePostsObservationRejection(
  observation: CanonicalizableObservation,
): PostsObservationParseRejection | null {
  if (observation.platform !== "fansly") {
    return { code: "platform_not_fansly" };
  }
  if (observation.kind === "posts") {
    const result = parseFanslyPostsPayloadDetailed(observation.payload);
    return result.accepted ? null : result.rejection;
  }
  if (observation.kind === "post_tips") {
    return Array.isArray(observation.payload) ? null : { code: "post_tips_not_array" };
  }
  return { code: "kind_not_supported" };
}

export function canonicalizePostsObservation(
  observation: CanonicalizableObservation,
  context?: CanonicalizeRunContext,
): CanonicalEventDraft[] {
  if (observation.platform !== "fansly") return [];

  if (observation.kind === "posts") {
    const posts = parseFanslyPostsPayload(observation.payload);
    if (posts === null) return [];
    return posts.map((post) => buildPostObservedDraft({
      platform: "fansly",
      observationId: observation.id,
      postId: post.postId,
      // Agent reads promise provider-verbatim post text. Keep HTML, entities,
      // whitespace and line endings exactly as captured.
      textPlain: post.textPlain,
      publishedAt: post.publishedAt,
      observedAt: observation.receivedAt,
      attachmentCount: post.attachmentCount,
      ...post.money,
      ...post.engagement,
    }));
  }

  if (observation.kind === "post_tips") {
    const expectedReceiverId = observation.accountId === null
      ? null
      : context?.nativeAccountRefByAccountId.get(observation.accountId);
    const parsed = parseFanslyPostTipsPayload(observation.payload, expectedReceiverId);
    if (parsed === null) return [];
    const drafts = parsed.tips.map((tip) => buildPostTipObservedDraft({
      ...tip,
      observationId: observation.id,
      observedAt: observation.receivedAt,
    }));
    if (parsed.rejected.length > 0) {
      drafts.push(buildPostTipParseRejectedDraft(observation, parsed.rejected));
    }
    return drafts;
  }

  return [];
}
