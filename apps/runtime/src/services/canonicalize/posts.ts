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

export const POSTS_CANONICALIZER_VERSION = 5;
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

function postContentHash(input: CanonicalPostMaterial): string {
  const money = normalizedPostMoney(input);
  // Fixed-position v2 material tuple: deterministic without depending on
  // object key order. All monetization fields participate, so a money-only
  // change creates a new immutable event and advances the current head.
  return createHash("sha256")
    .update(JSON.stringify([
      "post-material-v2",
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
    ]))
    .digest("hex");
}

/** Shared provider-material to canonical event seam. OFAPI's governed capture
 * parser calls this only after strict response acceptance; Fansly's pull family
 * below calls it after its own shape gate. */
export function buildPostObservedDraft(input: CanonicalPostMaterial): CanonicalEventDraft {
  const contentHash = postContentHash(input);
  const money = normalizedPostMoney(input);
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
      ...money,
      contentHash,
    },
    schemaVersion: 2,
    // Account-scoped, source-observation idempotency: one parser retry is
    // stable; later captures are distinct sightings; corrected v2 material
    // from an old raw observation does not collide with the v1 event.
    dedupKey: `post:v2:${input.platform}:${input.postId}:${contentHash}:obs:${input.observationId}`,
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
};

function parseFanslyPostsPayload(payload: unknown): ParsedFanslyPost[] | null {
  if (!isRecord(payload) || !Array.isArray(payload.posts)) return null;
  const goals = parseTipGoals(payload);
  if (goals === null) return null;

  const parsed: ParsedFanslyPost[] = [];
  for (const post of payload.posts) {
    if (!isRecord(post)) return null;
    const postId = asString(post.id);
    const publishedAt = fanslyPublishedAt(post.createdAt);
    if (
      postId === null || publishedAt === null
      || (post.content != null && typeof post.content !== "string")
      || (post.attachments != null && !Array.isArray(post.attachments))
    ) {
      return null;
    }

    const attachmentsProvided = Array.isArray(post.attachments);
    const attachments = attachmentsProvided ? post.attachments as unknown[] : [];
    if (!attachments.every(isRecord)) return null;
    const goalRefs = new Set<string>();
    let attachmentTypesComplete = true;
    for (const attachment of attachments) {
      if (typeof attachment.contentType !== "number" || !Number.isSafeInteger(attachment.contentType)) {
        attachmentTypesComplete = false;
        continue;
      }
      if (attachment.contentType !== 7100) continue;
      const goalRef = asString(attachment.contentId);
      if (goalRef === null) return null;
      goalRefs.add(goalRef);
    }
    // Fansly currently exposes one goal attachment per post. Refuse ambiguity
    // instead of silently choosing one; the raw page remains replayable.
    if (goalRefs.size > 1) return null;

    const tipAmount = nullableNonnegativeSafeInteger(post.tipAmount);
    const attachmentTipAmount = nullableNonnegativeSafeInteger(post.attachmentTipAmount);
    if (!tipAmount.valid || !attachmentTipAmount.valid) return null;
    const hasPostTipTotal = tipAmount.value !== null || attachmentTipAmount.value !== null;
    const postTipTotalMills = hasPostTipTotal
      ? (tipAmount.value ?? 0) + (attachmentTipAmount.value ?? 0)
      : null;
    if (postTipTotalMills !== null && !Number.isSafeInteger(postTipTotalMills)) {
      return null;
    }

    const tipGoalRef = [...goalRefs][0] ?? null;
    const goal = tipGoalRef === null ? null : goals.get(tipGoalRef) ?? null;
    parsed.push({
      postId,
      textPlain: typeof post.content === "string" ? post.content : "",
      publishedAt,
      attachmentCount: attachments.length,
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
  return parsed;
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
    return parseFanslyPostsPayload(observation.payload) !== null;
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
