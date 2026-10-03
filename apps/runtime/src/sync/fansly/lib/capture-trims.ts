import { FANSLY_MAPPER_VERSION } from "@agency_hub_core/fansly";

// What a Fansly capture journals for the kinds that are not journaled
// verbatim, and the capture-shape version each of them stamps. Shared by the
// Fansly Sync Engine's journal body (../capture.ts) and the legacy lanes; the
// versions keep their values, because replay and the observation kinds read
// them.

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function asNullableString(value: unknown) {
  return typeof value === "string" ? value : null;
}

function asNullableNumber(value: unknown) {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

/**
 * [A20] The ONE named allowlist of `aggregationData.accounts[]` fields that
 * may reach the journal from the Fansly follower and conversation lanes.
 *
 * It is an allowlist, not a removal: the owner ruled (2026-08-20) that the
 * capture is field-SELECTIVE. The 14 fields added to the original four change
 * on the order of months, so the ~11:1 content-address dedup collapse measured
 * on production survives the widening — that collapse is the entire reason the
 * byte-ceiling mechanism could be deleted with this ruling.
 *
 * Widening this list is a deliberate edit with a written reason, exactly like
 * the platform-branch budget. `tests/fansly-capture-allowlist.test.ts` fails
 * when a field outside it reaches the journal for these two endpoints.
 */
export const FANSLY_FAN_ACCOUNT_CAPTURE_ALLOWLIST = [
  "id",
  "username",
  "displayName",
  "createdAt",
  "followsYou",
  "following",
  "subscriber",
  "subscriberSubscription",
  "subscriberAutoRenew",
  "notes",
  "containingLists",
  "profileAccess",
  "profileAccessFlags",
  "profileFlags",
  "permissions",
  "statusId",
  "flags",
  "userFlags",
] as const;

/**
 * [A20] The fields the owner ruled NOT needed — named here so the rejection is
 * as legible as the acceptance. Every one of them changes on nearly every
 * response (last-seen minute, audience/like/content counters, live flag), so
 * capturing them would make every body unique and destroy the dedup collapse.
 * `lastSeenAt` was contested and rejected explicitly: if it is ever wanted it
 * must arrive as its own "fan was online at T" fact, never inside these bodies.
 */
export const FANSLY_FAN_ACCOUNT_NEVER_CAPTURED = [
  "lastSeenAt",
  "followCount",
  "subscriberCount",
  "postLikes",
  "accountMediaLikes",
  "timelineStats",
  "streaming",
  "version",
] as const;

/**
 * Per-endpoint capture-shape versions. Replay tooling must be able to tell a
 * pre-[A20] 4-field row from a widened 18-field one, and the shared
 * `FANSLY_MAPPER_VERSION` cannot say it: every Fansly writer reads that one
 * constant, so bumping it would re-label unrelated captures (rejected
 * explicitly). The suffix rides only the two lanes whose capture shape changed.
 */
export const FANSLY_FOLLOWERS_CAPTURE_MAPPER_VERSION =
  `${FANSLY_MAPPER_VERSION}+followers-capture-v2`;
export const FANSLY_GROUPS_CAPTURE_MAPPER_VERSION =
  `${FANSLY_MAPPER_VERSION}+groups-capture-v2`;
/** WP-F2's lane is NEW, so it has no pre-[A20] shape to distinguish itself
 *  from — but it stamps its own version anyway, for the same reason the two
 *  lanes above do: the shared constant is read by every Fansly writer, so a
 *  future widening of THIS endpoint's allowlist must be legible without
 *  re-labelling unrelated captures. */
export const FANSLY_NOTIFICATIONS_CAPTURE_MAPPER_VERSION =
  `${FANSLY_MAPPER_VERSION}+notifications-capture-v1`;
/** WP-F3's catalog lane, same reasoning as WP-F2's. */
export const FANSLY_CATALOG_CAPTURE_MAPPER_VERSION =
  `${FANSLY_MAPPER_VERSION}+catalog-capture-v1`;
/** WP-F5's replies walk, same reasoning again. */
export const FANSLY_POST_REPLIES_CAPTURE_MAPPER_VERSION =
  `${FANSLY_MAPPER_VERSION}+post-replies-capture-v1`;
/** WP-F7's payouts lane, same reasoning again. */
export const FANSLY_PAYOUTS_CAPTURE_MAPPER_VERSION =
  `${FANSLY_MAPPER_VERSION}+payouts-capture-v1`;

/** Shared by both lanes: pick the allowlisted fields VERBATIM (objects and
 *  arrays keep their served shape), in allowlist order so an unchanged profile
 *  hashes identically even if the platform reorders its keys. A row without a
 *  usable `id` is dropped — `id` is the flatMap key every consumer joins on. */
function trimFanslyAggregatedAccounts(accounts: unknown) {
  if (!Array.isArray(accounts)) {
    return [];
  }
  return accounts.flatMap((item) => {
    if (!isRecord(item)) {
      return [];
    }
    const id = asNullableString(item.id);
    if (!id) {
      return [];
    }
    const kept: Record<string, unknown> = { id };
    for (const field of FANSLY_FAN_ACCOUNT_CAPTURE_ALLOWLIST) {
      if (field === "id" || !Object.hasOwn(item, field)) {
        continue;
      }
      kept[field] = item[field];
    }
    return [kept];
  });
}

/**
 * [A20] on the WP-F2 notification lane, and this response is the sharpest case
 * of the hazard yet: `/notifications` embeds an `accounts[]` sidecar of FULL
 * account records — 23 keys in the 2026-08-19 capture, including `lastSeenAt`,
 * `followCount`, `subscriberCount`, `postLikes`, `accountMediaLikes`,
 * `timelineStats` and `streaming`. `lastSeenAt` moves every minute; journaling
 * it makes every body unique and destroys the content-address dedup collapse
 * the whole disk budget rests on.
 *
 * SO: `accounts[]` — and ONLY `accounts[]` — goes through the 18-field
 * allowlist. `notifications`, `tips`, `accountMedia`, `accountMediaBundles`,
 * `subscriptions`, `subscriptionHistory` and every key the platform starts
 * serving tomorrow pass through UNTOUCHED, because DP 7 says journal verbatim
 * and [A20] narrowed exactly one array, not the response.
 *
 * A payload with no `accounts` key comes back byte-identical — the trim adds
 * nothing that was not served.
 */
export function trimFanslyNotificationsPayload(raw: unknown) {
  if (!isRecord(raw) || !Object.hasOwn(raw, "accounts")) {
    return raw;
  }
  return { ...raw, accounts: trimFanslyAggregatedAccounts(raw.accounts) };
}

/**
 * [A20] on the WP-F3 catalog lane.
 *
 * NONE of the six catalog responses carried an `accounts[]` sidecar in the
 * 2026-08-19 capture — and the trim runs anyway, on BOTH the shapes Fansly uses
 * for it (`accounts` at the top level, and `aggregationData.accounts`). That is
 * deliberate. A27's standing caveat is that one response is one example:
 * optional sidecars are invisible in a single sample, `/post` and
 * `/notifications` both serve `accounts[]` from the same envelope family, and
 * the day this lane's `/account/media?ids=` starts returning one, `lastSeenAt`
 * would enter the journal on a DAILY sweep and quietly cost the dedup collapse
 * the disk budget rests on. A no-op guard is cheaper than that discovery.
 *
 * Everything else passes through UNTOUCHED — `albums`, `albumMedia`, `media`
 * (with its signed `location`/`variants`, journal-only), `accountMedia`,
 * `albumContent`, `plans`, `promos` and every key the platform starts serving
 * tomorrow. DP 7 says journal verbatim; [A20] narrowed exactly one array.
 *
 * A payload with neither shape comes back BYTE-IDENTICAL — the trim adds
 * nothing that was not served.
 */
export function trimFanslyCatalogPayload(raw: unknown) {
  if (!isRecord(raw)) {
    return raw;
  }
  const hasTopLevel = Object.hasOwn(raw, "accounts");
  const aggregation = isRecord(raw.aggregationData) ? raw.aggregationData : null;
  const hasNested = aggregation !== null && Object.hasOwn(aggregation, "accounts");
  if (!hasTopLevel && !hasNested) {
    return raw;
  }
  return {
    ...raw,
    ...(hasTopLevel ? { accounts: trimFanslyAggregatedAccounts(raw.accounts) } : {}),
    ...(hasNested && aggregation !== null
      ? {
        aggregationData: {
          ...aggregation,
          accounts: trimFanslyAggregatedAccounts(aggregation.accounts),
        },
      }
      : {}),
  };
}

/**
 * [A20] on the WP-F5 replies walk.
 *
 * WP-F9's shape probe read a `/post/{id}/replies` response and found the
 * embedded `accounts[]` entry is a FULL account record — `lastSeenAt`, `notes`,
 * `containingLists`, `subscriberSubscription`, `statusId`, `followCount`,
 * `subscriberCount`, and an `avatar` carrying signed CDN locations.
 * `lastSeenAt` changes every minute; journaling it would make every body unique
 * and destroy the content-address dedup collapse the whole disk budget rests
 * on. On a lane that re-reads a back-catalogue of thousands of posts, that is
 * the difference between an archive that costs kilobytes a day and one that
 * grows without bound.
 *
 * So `accounts[]` — and ONLY `accounts[]` — goes through the 18-field
 * allowlist. `posts` (the replies themselves, bodies and all), `aggregatedPosts`,
 * `accountMedia`, `accountMediaBundles`, `tips`, `tipGoals`, `stories`, `polls`
 * and every key the platform starts serving tomorrow pass through UNTOUCHED:
 * DP 7 says journal verbatim and [A20] narrowed exactly one array.
 *
 * A payload with no `accounts` key — which is 2 of the 5 captured responses, and
 * the reason the author-hydration fallback is mandatory — comes back
 * BYTE-IDENTICAL. So does the adapter's `{__empty: true}` marker.
 */
export function trimFanslyPostRepliesPayload(raw: unknown) {
  if (!isRecord(raw) || !Object.hasOwn(raw, "accounts")) {
    return raw;
  }
  return { ...raw, accounts: trimFanslyAggregatedAccounts(raw.accounts) };
}

export function trimFanslyFollowerPayload(raw: unknown) {
  const payload = isRecord(raw) ? raw : {};
  const followers = Array.isArray(payload.followers)
    ? payload.followers.flatMap((item) => {
      if (!isRecord(item)) {
        return [];
      }

      const id = asNullableString(item.id);
      const followerId = asNullableString(item.followerId);
      if (!id || !followerId) {
        return [];
      }

      // [A20]: lastSeenAt is NOT captured — on the relation row either. It
      // moves every minute, and the replay canonicalizer already excludes it
      // from its identity hash (services/canonicalize/fansly-replay.ts), so nothing
      // downstream loses a fact by its absence.
      return [{
        id,
        followerId,
      }];
    })
    : [];
  const aggregationData = isRecord(payload.aggregationData) ? payload.aggregationData : {};
  const accounts = trimFanslyAggregatedAccounts(aggregationData.accounts);

  return {
    followers,
    aggregationData: {
      accounts,
    },
  };
}

export function captureFanslyFollowerPayload(raw: unknown, contractAccepted: boolean | undefined) {
  const captured = trimFanslyFollowerPayload(raw);
  const payload = isRecord(raw) ? raw : {};
  const aggregationData = isRecord(payload.aggregationData) ? payload.aggregationData : {};
  if (contractAccepted === false || !isRecord(raw) || !Array.isArray(payload.followers)) {
    const shape = (value: unknown) => value === null ? "null" : Array.isArray(value) ? "array" : typeof value;
    // Keep the established account/relation allowlist even on a rejected body.
    // Nest it so replay cannot mistake the trimmed fallback arrays for a valid
    // empty page; field types retain the malformed-shape evidence without text.
    return {
      contractAccepted: false,
      responseShape: {
        response: shape(raw),
        followers: shape(payload.followers),
        aggregationData: shape(payload.aggregationData),
        accounts: shape(aggregationData.accounts),
      },
      captured,
    };
  }
  return captured;
}

function redactFanslyMessageLike(raw: unknown) {
  if (!isRecord(raw)) {
    return null;
  }

  const id = asNullableString(raw.id);
  const senderId = asNullableString(raw.senderId);
  const groupId = asNullableString(raw.groupId);
  const correlationId = asNullableString(raw.correlationId);
  const inReplyTo = asNullableString(raw.inReplyTo);
  const inReplyToRoot = asNullableString(raw.inReplyToRoot);
  const createdAt = asNullableNumber(raw.createdAt);
  const type = asNullableNumber(raw.type);
  const dataVersion = asNullableNumber(raw.dataVersion);
  const totalTipAmount = asNullableNumber(raw.totalTipAmount);

  return {
    id,
    type,
    dataVersion,
    groupId,
    senderId,
    correlationId,
    inReplyTo,
    inReplyToRoot,
    createdAt,
    attachments: [],
    embeds: [],
    interactions: [],
    likes: [],
    totalTipAmount,
  };
}

/**
 * [A18], verified against the live capture 2026-08-19/20: for `data[]` — the
 * conversation rows — this function is an IDENTITY REWRITE. Fansly serves
 * exactly nine fields per row and all nine are kept; there is no `lastMessage`
 * object on a conversation row, so no preview text, attachment or tip is lost
 * there and never was. `tests/fansly-capture-allowlist.test.ts` pins that with
 * a byte-identity assertion on a verbatim-shaped fixture, so the mistaken
 * belief cannot be re-invented.
 *
 * The real loss was `aggregationData.accounts[]` (4 of ~25 fields kept), and
 * [A20] repairs it as the named allowlist above.
 *
 * `aggregationData.groups[].lastMessage` KEEPS its redaction deliberately: it
 * is 3.7 % of the payload delta and, for every head the DM stream reads, a
 * duplicate of material the verbatim `dm_messages` journal already holds
 * (every `/message` read journals its body untrimmed). A head that
 * stream never fetches (a mass-DM copy, say) is held only by the WS frame
 * journal. Either way the agent-read scrub justification in
 * modules/agent-read/observation-scrub.ts stays true.
 *
 * The trim drops a row, group or account without its id and nulls a mistyped
 * scalar. The adapter refuses the first case (contractAccepted false) and
 * captureFanslyMessagingGroupsPayload marks that capture; the second is
 * accepted as-is, the same scope as the follower capture.
 */
export function trimFanslyMessagingGroupsPayload(raw: unknown) {
  const payload = isRecord(raw) ? raw : {};
  const data = Array.isArray(payload.data)
    ? payload.data.flatMap((item) => {
      if (!isRecord(item)) {
        return [];
      }

      const groupId = asNullableString(item.groupId);
      if (!groupId) {
        return [];
      }

      return [{
        account_id: asNullableString(item.account_id),
        groupId,
        partnerAccountId: asNullableString(item.partnerAccountId),
        partnerUsername: asNullableString(item.partnerUsername),
        flags: asNullableNumber(item.flags),
        unreadCount: asNullableNumber(item.unreadCount),
        subscriptionTierId: asNullableString(item.subscriptionTierId),
        lastMessageId: asNullableString(item.lastMessageId),
        lastUnreadMessageId: asNullableString(item.lastUnreadMessageId),
      }];
    })
    : [];
  const aggregationData = isRecord(payload.aggregationData) ? payload.aggregationData : {};
  const accounts = trimFanslyAggregatedAccounts(aggregationData.accounts);
  const groups = Array.isArray(aggregationData.groups)
    ? aggregationData.groups.flatMap((item) => {
      if (!isRecord(item)) {
        return [];
      }

      const id = asNullableString(item.id);
      if (!id) {
        return [];
      }

      return [{
        id,
        type: asNullableNumber(item.type),
        groupFlags: asNullableNumber(item.groupFlags),
        createdBy: asNullableString(item.createdBy),
        users: Array.isArray(item.users)
          ? item.users.flatMap((user) => {
            if (!isRecord(user)) {
              return [];
            }

            const userId = asNullableString(user.userId);
            const groupId = asNullableString(user.groupId);
            const type = asNullableNumber(user.type);
            const permissionFlags = asNullableNumber(user.permissionFlags);
            if (!userId || !groupId || type === null || permissionFlags === null) {
              return [];
            }

            return [{
              groupId,
              userId,
              type,
              permissionFlags,
            }];
          })
          : [],
        lastMessage: redactFanslyMessageLike(item.lastMessage),
      }];
    })
    : [];

  return {
    data,
    aggregationData: {
      total: asNullableNumber(aggregationData.total),
      accounts,
      groups,
    },
  };
}

/** The dm_conversations journal body. An accepted page is the trim, byte for
 * byte. A page the adapter refused (and the lane then refuses) keeps the same
 * allowlist and lastMessage redaction, nested so replay cannot mistake the
 * trim's fallback arrays for a valid page; type names and raw lengths keep the
 * drift evidence without any text. */
export function captureFanslyMessagingGroupsPayload(raw: unknown, contractAccepted: boolean | undefined) {
  const captured = trimFanslyMessagingGroupsPayload(raw);
  if (contractAccepted !== false) {
    return captured;
  }
  const payload = isRecord(raw) ? raw : {};
  const aggregationData = isRecord(payload.aggregationData) ? payload.aggregationData : {};
  const shape = (value: unknown) => value === null ? "null" : Array.isArray(value) ? "array" : typeof value;
  const length = (value: unknown) => Array.isArray(value) ? value.length : null;
  return {
    contractAccepted: false as const,
    responseShape: {
      response: shape(raw),
      data: shape(payload.data),
      aggregationData: shape(payload.aggregationData),
      total: shape(aggregationData.total),
      groups: shape(aggregationData.groups),
      accounts: shape(aggregationData.accounts),
      dataLength: length(payload.data),
      groupsLength: length(aggregationData.groups),
      accountsLength: length(aggregationData.accounts),
    },
    captured,
  };
}
