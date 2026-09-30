import { Buffer } from "node:buffer";
import { createHash, randomUUID } from "node:crypto";

import {
  type Database,
  getPageSyncExecutionContext,
  insertObservation,
  insertRawPayload,
  insertSyncRunEvent,
  nextPageSyncObservationSeq,
  recordSyncHttpAttemptResponseBodyBytes,
  updatePageMetadata,
} from "@agency_hub_core/db";
import { FANSLY_MAPPER_VERSION } from "@agency_hub_core/fansly";
import { type HttpRequestObserver, millsFromInteger } from "@agency_hub_core/shared";

import type { AppContext } from "../../bootstrap.ts";
import {
  type ResolvedFanslyPageContext,
  type ResolvedPageContext,
} from "../page-context.ts";
import { buildFanslyMetadata } from "../fansly.ts";
import { noteCaptureCasRefVanished, putCaptureCasPayloads } from "../capture-cas-dual-write.ts";
import type { NormalizedSyncError } from "./errors.ts";
import { SyncPayloadPersistenceError } from "./errors.ts";
import {
  FANSLY_CDN_TOKENS_STRIPPED_MAPPER_SUFFIX,
  fanslyCdnTokenStripApplies,
  stripFanslySignedCdnTokens,
} from "./fansly-cdn-tokens.ts";
import {
  JOURNAL_LONE_SURROGATES_REPLACED_MAPPER_SUFFIX,
  JOURNAL_LONE_SURROGATES_REPLACED_NOTE_CODE,
  replaceJournalLoneSurrogates,
} from "./journal-lone-surrogates.ts";
import type { SyncRunTelemetry } from "./observability.ts";
import { createSyncRateLimitWaiter } from "./rate-limiter.ts";

// Legacy mapper tag for OnlyFans failed-payload rows (kept byte-identical to
// the retired packages/onlyfans export so recorded rows stay comparable).
const ONLYMONSTER_MAPPER_VERSION = "onlymonster-phase3-v1";

export const DAY_MS = 24 * 60 * 60 * 1000;
// Stage 1 retention stand-down: raw payloads are captured business facts and
// nothing deletes sync_raw_payloads on a schedule (the nightly purge was
// removed; tests/retention-deleters.test.ts pins that). `retain_until` is an
// inert envelope stamp kept far-future; the only deleter is the
// owner-initiated erasure.
const RAW_RETENTION_DAYS = 36500;
const DM_RAW_RETENTION_DAYS = 36500;

export function retentionDate(now = new Date()) {
  return new Date(now.getTime() + RAW_RETENTION_DAYS * DAY_MS);
}

export function dmRetentionDate(now = new Date()) {
  return new Date(now.getTime() + DM_RAW_RETENTION_DAYS * DAY_MS);
}

export function normalizeFanslyTimestamp(value: number) {
  const ms = value >= 1_000_000_000_000 ? value : value * 1000;
  return new Date(ms);
}

export function normalizeDmTipAmountCents(
  platform: ResolvedPageContext["platform"],
  totalTipAmount: number | null | undefined,
) {
  if (typeof totalTipAmount !== "number" || !Number.isFinite(totalTipAmount) || totalTipAmount <= 0) {
    return 0;
  }

  // Fansly live DM payloads emit tip totals in mills; the stored field and API contract are cents.
  const normalizedAmount = platform === "fansly"
    ? totalTipAmount / 10
    : totalTipAmount;

  return Math.max(0, Math.round(normalizedAmount));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function asNullableString(value: unknown) {
  return typeof value === "string" ? value : null;
}

function asNullableNumber(value: unknown) {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

export type RawPayloadInsertInput = Parameters<typeof insertRawPayload>[1];

export async function persistRawPayload(
  db: Database,
  served: RawPayloadInsertInput,
  options?: {
    action?: string;
    /** Producer platform for the observation (Stage 7); callers know theirs. */
    platform?: "fansly" | "onlyfans";
    /** Optional contextual observation envelope. The raw table still stores
     * `responsePayload` verbatim (bar the CDN-token strip below); this is
     * reserved for a quarantined response that a future parser needs request
     * context to replay safely. */
    observationPayload?: unknown;
  },
) {
  // G5 slice 1 (§7 step 1): ONE capture instant for this response, fixed before
  // anything is written, so the raw envelope and its observation can never land
  // in different content-addressed months across a UTC boundary. The observation
  // keeps deriving its own received_at as before — this instant addresses the
  // payload object, it does not restamp the journal.
  const captureInstant = new Date();
  // Owner decision 2026-09-29 (./fansly-cdn-tokens.ts): for the named Fansly
  // kinds the one-off CDN signing tokens leave BOTH bodies here, before the
  // catalog write and the payload hash, so the catalog object, the inline raw
  // row and the inline observation all hold the same stripped body and the
  // parity job compares like with like. The served object is never mutated —
  // the lane keeps parsing it after this returns.
  const stripCdnTokens = fanslyCdnTokenStripApplies(options?.platform, served.endpoint);
  const stripped: RawPayloadInsertInput = stripCdnTokens
    ? {
      ...served,
      responsePayload: stripFanslySignedCdnTokens(served.responsePayload),
      mapperVersion: `${served.mapperVersion}${FANSLY_CDN_TOKENS_STRIPPED_MAPPER_SUFFIX}`,
    }
    : served;
  let observedPayload: unknown = options !== undefined
      && Object.hasOwn(options, "observationPayload")
    ? options.observationPayload ?? null
    : served.responsePayload ?? null;
  if (stripCdnTokens) {
    // The ordinary path journals the very object the raw row stores; keep it
    // ONE object so the catalog write below still does a single put.
    observedPayload = observedPayload === served.responsePayload
      ? stripped.responsePayload ?? null
      : stripFanslySignedCdnTokens(observedPayload);
  }
  // Production 2026-09-30 (./journal-lone-surrogates.ts): json/jsonb refuse an
  // unpaired UTF-16 surrogate, so a vendor body holding one is journaled with
  // each replaced by U+FFFD, in both bodies and the catalog object alike. A
  // body without one is the same object, with no copy and no marker; the
  // served object is never mutated.
  const rawSurrogates = replaceJournalLoneSurrogates(stripped.responsePayload);
  const observedSurrogates = observedPayload === stripped.responsePayload
    ? rawSurrogates
    : replaceJournalLoneSurrogates(observedPayload);
  observedPayload = observedSurrogates.value;
  const input: RawPayloadInsertInput = rawSurrogates.replaced === 0
    ? stripped
    : {
      ...stripped,
      responsePayload: rawSurrogates.value,
      mapperVersion: `${stripped.mapperVersion}${JOURNAL_LONE_SURROGATES_REPLACED_MAPPER_SUFFIX}`,
    };
  // Content-addressed copy FIRST, in its own transaction, and it can never
  // throw: on any failure it returns null references and the two inline writes
  // below proceed byte-identically to the pre-slice code. Default-off; a page
  // outside the canary does no work here at all. See capture-cas-dual-write.ts
  // for why this is not folded into the inline transactions.
  const casRefs = await putCaptureCasPayloads(db, {
    pageId: input.platformAccountId,
    captureInstant,
    responsePayload: input.responsePayload,
    observationPayload: observedPayload,
  });

  // G5 slice 3c-1: the inline bodies are skipped ONLY when the catalog write
  // above actually stored them (`pointerOnly` is set on the success return of
  // putCaptureCasPayloads and nowhere else) AND the page is in the pointer-only
  // canary. Every other outcome — canary off, page outside either list, codec
  // refusal, dead connection — leaves this false and both inserts below behave
  // byte-identically to the pre-slice code. The repositories re-check the
  // reference themselves, so the worst a bug here can cost is a duplicated body,
  // never a missing one.
  //
  // DECISION #222 made that re-check load-bearing rather than defensive: each
  // insert proves its reference is still ALIVE under a row lock it holds until
  // it commits, and an object an erasure took in the meantime is dropped in
  // favour of the inline body. So `omitInlinePayload` is a REQUEST here and a
  // decision there, which is why the counter below is fed from the receipts
  // rather than from anything this function knows.
  const omitInlinePayload = casRefs.pointerOnly;

  let rawPayload;
  try {
    rawPayload = await insertRawPayload(db, {
      ...input,
      payloadRef: casRefs.raw,
      omitInlinePayload,
    });
  } catch (error) {
    throw new SyncPayloadPersistenceError({
      endpoint: input.endpoint,
      action: options?.action ?? `inserting ${input.endpoint} raw payload`,
      cause: error,
    });
  }

  // Stage 7 producer 2: every fetched page is also an observation. As loud as
  // the raw insert — a failed capture fails the chunk (which retries); never a
  // silent drop. The idempotency key is unique per fetch by construction
  // (page:stream:run:requestSeq.fetchN — the fetch counter lives on the
  // executor context, so multi-page walks journal every page; continuation
  // chunks share requestSeq and restart fetchN, so an in-context caller MUST
  // pass syncRunId or its key repeats across chunks); outside the
  // page-executor context a UUID takes its place — retries then produce extra
  // observations with distinct keys, which the Stage 7 reconciliation expects.
  const context = getPageSyncExecutionContext();
  const stream = context?.stream ?? null;
  const platform = options?.platform ?? null;
  // WP-F1: the observation id is returned to the caller so a capture that
  // discovers a FLOOR can point `capture_coverage.proof_observation_id` at the
  // exact journaled response that proves it. An empty window is the evidence,
  // and evidence with no address is a claim.
  let journalledObservationId!: number | null;
  // `observedPayload` is hoisted above the CAS write — normalized there so an
  // adapter (or test stub) handing back undefined still hashes and journals
  // deterministically as JSON null, and so the catalog stores exactly the value
  // this insert stores inline. The hash below is taken from that OBJECT, never
  // from the column, so a pointer-only row carries the same payload_hash it
  // would have carried with its body inline — which is why 0128 leaves
  // payload_hash NOT NULL.
  if (rawPayload.payloadRefVanished) {
    noteCaptureCasRefVanished();
  }

  try {
    const journalled = await insertObservation(db, {
      source: "pull",
      producer: `sync:${platform ?? "unknown"}:${stream ?? input.endpoint}`,
      platform,
      accountId: input.platformAccountId,
      kind: input.endpoint,
      payload: observedPayload,
      payloadHash: createHash("sha256").update(JSON.stringify(observedPayload)).digest(),
      idempotencyKey: [
        input.platformAccountId,
        stream ?? input.endpoint,
        input.syncRunId ?? "norun",
        nextPageSyncObservationSeq() ?? randomUUID(),
      ].join(":"),
      payloadRef: casRefs.observation,
      omitInlinePayload,
    });
    journalledObservationId = journalled.observationId;
    if (journalled.payloadRefVanished) {
      noteCaptureCasRefVanished();
    }
  } catch (error) {
    throw new SyncPayloadPersistenceError({
      endpoint: input.endpoint,
      action: `inserting ${input.endpoint} observation`,
      cause: error,
    });
  }

  // An info note on the run, never an anomaly: the capture succeeded, and the
  // mapper suffix on the raw row stays the durable marker for a capture that
  // ran outside one. Like the measurement below, it can never fail a capture.
  const replacedSurrogates = rawSurrogates.replaced + observedSurrogates.replaced;
  if (replacedSurrogates > 0 && input.syncRunId != null && stream !== null && platform) {
    try {
      await insertSyncRunEvent(db, {
        syncRunId: input.syncRunId,
        platformAccountId: input.platformAccountId,
        provider: platform,
        stream,
        eventType: "note",
        severity: "info",
        message: "Unpaired UTF-16 surrogates in the response were journaled as U+FFFD",
        details: {
          code: JOURNAL_LONE_SURROGATES_REPLACED_NOTE_CODE,
          endpoint: input.endpoint,
          rawPayloadId: rawPayload.id,
          observationId: journalledObservationId,
          rawPayloadReplacements: rawSurrogates.replaced,
          observationReplacements: observedSurrogates.replaced,
        },
      });
    } catch {
      // A missing note is worth strictly less than the capture it describes.
    }
  }

  // [E2] measurement, F0(a). Byte length of the payload OBJECT this capture
  // journaled — the real disk-trend input for the widened Fansly capture. It
  // is instrumentation and NOTHING else: no ceiling, no deferral, no config
  // key ([A20] deleted all three), and a failure here can never fail a capture.
  if (input.syncRunId != null && stream !== null) {
    try {
      await recordSyncHttpAttemptResponseBodyBytes(db, {
        syncRunId: input.syncRunId,
        platformAccountId: input.platformAccountId,
        stream,
        responseBodyBytes: Buffer.byteLength(
          JSON.stringify(input.responsePayload ?? null),
          "utf8",
        ),
      });
    } catch {
      // Measurement only — a missing sample is worth strictly less than the
      // capture it would have failed.
    }
  }

  return { ...rawPayload, observationId: journalledObservationId };
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
      // from its identity hash (canonicalize/fansly-replay.ts), so nothing
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
 * (sync/fansly-dm-messages.ts persists `page.raw` untrimmed). A head that
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

/** Fansly-only since Stage 18: the OnlyMonster metadata refresh is retired
 * (OnlyFans page identity is static post-onboarding; counts ride the OFAPI
 * audience sweep). */
export async function refreshPageMetadata(
  app: AppContext,
  pageContext: ResolvedFanslyPageContext,
  syncType?: "light" | "followers",
  telemetry?: SyncRunTelemetry,
  requestObserver?: HttpRequestObserver | null,
) {
  const rateLimitWaiter = createSyncRateLimitWaiter(app, {
    egressKey: pageContext.egressKey,
  });

  {
    const accountMe = await app.adapter.getAccountMe({
      session: pageContext.session,
      proxy: pageContext.proxy,
      egressKey: pageContext.egressKey,
      requestObserver: requestObserver ?? telemetry?.getRequestObserver() ?? null,
      rateLimitWaiter,
    });
    await persistRawPayload(app.db, {
      platformAccountId: pageContext.page.id,
      // The run id keeps the observation key unique per chunk: continuation
      // chunks of one request share requestSeq and restart the fetch counter,
      // so without it followers_reconcile's terminal account_me collided with
      // the sweep-start one and was silently dropped by the key claim.
      syncRunId: telemetry?.metadata.runId ?? null,
      endpoint: "account_me",
      requestParams: {},
      responsePayload: accountMe.raw,
      mapperVersion: FANSLY_MAPPER_VERSION,
      payloadKind: "mapping_critical",
      retainUntil: retentionDate(),
    }, {
      action: "inserting account_me raw payload",
      platform: "fansly",
    });

    await updatePageMetadata(app.db, pageContext.page.id, {
      platformAccountIdValue: accountMe.parsed.account.id,
      username: accountMe.parsed.account.username,
      displayName: accountMe.parsed.account.displayName,
      followerCount: accountMe.parsed.account.followCount,
      // This write always advances last_verified_at, which the stated-empty
      // subscribers rule reads as the counter's freshness. A counter missing
      // from the response is cleared, not skipped (Drizzle drops undefined),
      // so the last 0 cannot keep looking fresh.
      subscriberCount: typeof accountMe.parsed.account.subscriberCount === "number"
        ? accountMe.parsed.account.subscriberCount
        : null,
      earningsBalanceMills: millsFromInteger(accountMe.parsed.account.earningsWallet?.balance ?? 0),
      metadata: buildFanslyMetadata(accountMe.parsed.account, pageContext.page.metadata),
      ...(syncType ? { syncType } : {}),
    });

    return accountMe;
  }
}

export async function persistFailedSyncPayload(
  app: Pick<AppContext, "db" | "logger">,
  input: {
    platformAccountId: number;
    syncRunId: number;
    endpoint: string;
    platform: "fansly" | "onlyfans";
    failure: NormalizedSyncError;
  },
) {
  try {
    await insertRawPayload(app.db, {
      platformAccountId: input.platformAccountId,
      syncRunId: input.syncRunId,
      endpoint: input.endpoint,
      requestParams: {},
      responsePayload: { error: input.failure.error },
      mapperVersion: input.platform === "fansly"
        ? FANSLY_MAPPER_VERSION
        : ONLYMONSTER_MAPPER_VERSION,
      payloadKind: "failed",
      errorMessage: input.failure.summary,
      retainUntil: retentionDate(),
    });
    // Stage 7 producer 2: failed fetches are pull facts too. Best-effort like
    // the raw insert above — this path already runs inside error handling.
    const failedPayload = { error: input.failure.error, summary: input.failure.summary };
    await insertObservation(app.db, {
      source: "pull",
      producer: `sync:${input.platform}:${getPageSyncExecutionContext()?.stream ?? input.endpoint}`,
      platform: input.platform,
      accountId: input.platformAccountId,
      kind: `${input.endpoint}:failed`,
      payload: failedPayload,
      payloadHash: createHash("sha256").update(JSON.stringify(failedPayload)).digest(),
      idempotencyKey: [
        input.platformAccountId,
        `${input.endpoint}:failed`,
        input.syncRunId,
        nextPageSyncObservationSeq() ?? randomUUID(),
      ].join(":"),
    });
  } catch (error) {
    app.logger.warn(
      {
        syncRunId: input.syncRunId,
        platformAccountId: input.platformAccountId,
        endpoint: input.endpoint,
        err: error,
      },
      "Failed to persist failed sync payload; continuing",
    );
  }
}
