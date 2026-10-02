import { sql } from "drizzle-orm";

import type { Database } from "@agency_hub_core/db";

import { familyForObservation } from "../../../services/canonicalize/index.ts";
import { contentHash } from "../../../services/canonicalize/sync-pull.ts";
import type { CanonicalEventDraft } from "../../../services/canonicalize/types.ts";
import { buildCanonicalDrafts } from "../../../services/canonicalize-drafts.ts";
import type { ReplayContext, ReplayObservation, ReplayVerdict } from "../../engine/resource.ts";
import { readFanslyPageFacts } from "./page-facts.ts";

// Replay of a journaled observation whose whole effect is its canonical events
// (the capture-only content lanes: notifications, posts, post tips, replies,
// catalog, stats — design §5.14–§5.19, the shadow report's B5): the
// observation through its canonicalizer family (the pure seam the engine's
// apply and the minutely driver share), and every draft's dedup key looked up
// among the page's stored events. A match means legacy stored exactly what the
// engine's apply would have appended for the same body. Read-only.
//
// Two key changes reached legacy's journal without a canonicalizer version
// bump, so the observations legacy canonicalized before them still carry the
// old key while today's family drafts the new one. Each is a named rule, and
// a key is accepted under it only when the old key is stored, was minted by
// the old code at this look or an earlier one, and this observation was
// canonicalized by the old code. Nothing else is excused: every other missing
// key stays `events_missing`, and a match through a rule names it (`via`).
//
// - `pre_281_content_keyed_rows`: #281 (b8cebac5) moved the catalog, comment
//   and payout-method row events from one key per distinct content
//   (`<p>:v1:<rest>`) to one key per look (`<p>:v2:<rest>:obs:<id>`). Before
//   it an unchanged row deduped against the key of an earlier look, so legacy
//   wrote no event for this look — the per-look sighting #281 itself added.
//   The content is stored either way; the same content hash proves it.
// - `pre_122_media_duration_trunc`: #122 (31ead004) moved the media plane's
//   `durationMs` (the metadata's seconds in milliseconds) from truncated to
//   rounded inside the unversioned `media:v1` content hash. For seconds ≥ 0
//   the truncated value is the rounded one or one less, so a missing key's
//   only other legacy spelling is the same material with `durationMs − 1`.
//
// Known limit: a pre-#281 A→B→A revert of a row deduped against the first A
// and lost the revert; the rule accepts the stored A. Production had none in
// the catalog kinds of the 2026-10-02 B5 window (every deduped row's latest
// earlier event carried the same hash).

/** At most this many missing keys are named in a mismatch. */
const EXAMPLES = 5;

/** The row events #281 re-keyed per look; capture 1 the prefix, 2 the rest
 *  of the old key, 3 the observation. */
const PER_LOOK_REKEYED_281 = /^(album|tier|tierplan|giftcode|automation|wall|comment|payoutmethod):v2:(.+):obs:(\d+)$/;

/** Rule name: the row keys #281 moved per look. */
export const PRE_281_CONTENT_KEYED_ROWS = "pre_281_content_keyed_rows";
/** Production: the last content-keyed row event was written 2026-09-28T17:11:06Z,
 *  the last catalog roster by the pre-#281 code at 17:12:36Z, the first per-look
 *  row key at 2026-09-29T00:06:40Z (the lanes were idle between). An event
 *  written before this instant was written by the pre-#281 code. */
export const PRE_281_WRITTEN_BEFORE = new Date("2026-09-28T17:12:37Z");

/** Rule name: the media durations #122 rounded. */
export const PRE_122_MEDIA_DURATION_TRUNC = "pre_122_media_duration_trunc";
/** Production: the last truncated `media:v1` write was 2026-09-03T12:32:19Z
 *  (a DM sidecar), the first rounded one 13:47:21Z; the stats lane's last
 *  pre-#122 observation was received at 05:02:22Z. An observation received,
 *  or an event written, before this instant is the pre-#122 code's. */
export const PRE_122_WRITTEN_BEFORE = new Date("2026-09-03T12:32:20Z");

/** The key the pre-#281 code minted for the same row content, for a per-look
 *  row key of this very observation; null for any other key. */
export function contentKeyedLegacyKey(key: string, observationId: number): string | null {
  const match = PER_LOOK_REKEYED_281.exec(key);
  if (match === null || match[3] !== String(observationId)) return null;
  return `${match[1]}:v1:${match[2]}`;
}

/** The key the pre-#122 code minted for this media draft when its rounded
 *  duration was not the truncated one (`durationMs − 1`); null for any other
 *  draft (bundles, no duration, not `media:v1`). */
export function truncatedDurationLegacyKey(draft: CanonicalEventDraft): string | null {
  if (draft.type !== "media.observed" || !draft.dedupKey.startsWith("media:v1:")) return null;
  const { contentHash: hash, ...material } = draft.data;
  if (typeof hash !== "string" || material.subject !== "media" || "occurredAtClamped" in material) return null;
  const durationMs = material.durationMs;
  if (typeof durationMs !== "number" || !Number.isSafeInteger(durationMs) || durationMs <= 0) return null;
  if (!draft.dedupKey.endsWith(`:${hash}`)) return null;
  return `${draft.dedupKey.slice(0, -hash.length)}${contentHash({ ...material, durationMs: durationMs - 1 })}`;
}

interface StoredKeyEvent {
  observationId: number;
  createdAt: Date;
}

/** The stored event of each of these keys on the page. */
async function storedKeyEvents(db: Database, pageId: number, keys: readonly string[]): Promise<Map<string, StoredKeyEvent>> {
  if (keys.length === 0) return new Map();
  const result = await db.execute<{ dedupKey: string; observationId: string | number; createdAt: Date | string }>(sql`
    select k.dedup_key as "dedupKey", e.observation_id as "observationId", e.created_at as "createdAt"
      from domain_event_keys k
      join domain_events e on e.id = k.event_id and e.occurred_at = k.occurred_at
     where k.account_id = ${pageId}
       and k.dedup_key = any(${sql.param([...keys])}::text[])
  `);
  return new Map(result.rows.map((row) => [row.dedupKey, {
    observationId: Number(row.observationId),
    createdAt: row.createdAt instanceof Date ? row.createdAt : new Date(row.createdAt),
  }] as const));
}

interface LegacyKeyVerdict {
  /** Missing keys accepted under each rule. */
  explained: Record<string, number>;
  unexplained: string[];
}

/** The missing keys of one observation through the two legacy key rules. */
async function explainLegacyKeys(
  observation: ReplayObservation,
  ctx: ReplayContext,
  input: { drafts: readonly CanonicalEventDraft[]; missing: readonly string[]; present: ReadonlySet<string> },
): Promise<LegacyKeyVerdict> {
  const draftByKey = new Map(input.drafts.map((draft) => [draft.dedupKey, draft] as const));
  const candidates = new Map<string, { rule: string; legacyKey: string; writtenBefore: Date }>();
  for (const key of input.missing) {
    const rowKey = contentKeyedLegacyKey(key, observation.id);
    if (rowKey !== null) {
      candidates.set(key, { rule: PRE_281_CONTENT_KEYED_ROWS, legacyKey: rowKey, writtenBefore: PRE_281_WRITTEN_BEFORE });
      continue;
    }
    const draft = draftByKey.get(key);
    const mediaKey = draft === undefined || observation.receivedAt.getTime() >= PRE_122_WRITTEN_BEFORE.getTime()
      ? null
      : truncatedDurationLegacyKey(draft);
    if (mediaKey !== null) {
      candidates.set(key, { rule: PRE_122_MEDIA_DURATION_TRUNC, legacyKey: mediaKey, writtenBefore: PRE_122_WRITTEN_BEFORE });
    }
  }
  if (candidates.size === 0) return { explained: {}, unexplained: [...input.missing] };

  // #281: the observation was canonicalized by the pre-#281 code — it minted
  // events of its own (its per-look roster), every one before the cutover,
  // and none of its per-look row keys is stored (some stored and some not is
  // a loss under today's code, never the old scheme).
  const rowRule = [...candidates.values()].some((candidate) => candidate.rule === PRE_281_CONTENT_KEYED_ROWS);
  const ownProbe = rowRule ? [...input.present] : [];
  const stored = await storedKeyEvents(ctx.db, ctx.pageId, [...new Set([
    ...[...candidates.values()].map((candidate) => candidate.legacyKey),
    ...ownProbe,
  ])]);
  let rowsByOldCode = false;
  if (rowRule) {
    const own = ownProbe.flatMap((key) => {
      const event = stored.get(key);
      return event !== undefined && event.observationId === observation.id ? [event] : [];
    });
    rowsByOldCode = own.length > 0
      && own.every((event) => event.createdAt.getTime() < PRE_281_WRITTEN_BEFORE.getTime())
      && !ownProbe.some((key) => contentKeyedLegacyKey(key, observation.id) !== null);
  }

  const explained: Record<string, number> = {};
  const unexplained: string[] = [];
  for (const key of input.missing) {
    const candidate = candidates.get(key);
    const event = candidate === undefined ? undefined : stored.get(candidate.legacyKey);
    const accepted = candidate !== undefined && event !== undefined
      && (candidate.rule !== PRE_281_CONTENT_KEYED_ROWS || rowsByOldCode)
      // The same content, minted by the old code at this look or an earlier one.
      && event.observationId <= observation.id
      && event.createdAt.getTime() < candidate.writtenBefore.getTime();
    if (accepted) explained[candidate.rule] = (explained[candidate.rule] ?? 0) + 1;
    else unexplained.push(key);
  }
  return { explained, unexplained };
}

export async function replayByCanonicalDrafts(observation: ReplayObservation, ctx: ReplayContext): Promise<ReplayVerdict> {
  const family = familyForObservation({ source: "pull", kind: observation.kind, platform: "fansly" });
  if (family === null) return { kind: "not_replayable", reason: "no_canonicalizer_family" };
  const facts = await readFanslyPageFacts(ctx.db, ctx.pageId);
  const outcome = buildCanonicalDrafts(family, {
    id: observation.id,
    source: "pull",
    producer: "fansly-sync:replay",
    platform: "fansly",
    accountId: ctx.pageId,
    kind: observation.kind,
    payload: observation.payload,
    observedAt: null,
    receivedAt: observation.receivedAt,
  }, {
    nativeAccountRefByAccountId: new Map([[ctx.pageId, facts?.externalId ?? null]]),
    now: new Date(),
  });
  if (outcome.kind === "rejected") {
    return { kind: "mismatch", reason: "family_rejected", detail: { code: outcome.rejection.code ?? "unclassified" } };
  }
  const keys = [...new Set(outcome.drafts.map((draft) => draft.dedupKey))];
  if (keys.length === 0) return { kind: "match", detail: { drafts: 0 } };
  const stored = await ctx.db.execute<{ dedupKey: string }>(sql`
    select k.dedup_key as "dedupKey"
      from domain_event_keys k
     where k.account_id = ${ctx.pageId}
       and k.dedup_key = any(${sql.param(keys)}::text[])
  `);
  const present = new Set(stored.rows.map((row) => row.dedupKey));
  const missing = keys.filter((key) => !present.has(key));
  if (missing.length === 0) return { kind: "match", detail: { drafts: keys.length } };
  const legacy = await explainLegacyKeys(observation, ctx, { drafts: outcome.drafts, missing, present });
  const rules = Object.keys(legacy.explained).sort();
  if (legacy.unexplained.length === 0) {
    return { kind: "match", detail: { drafts: keys.length, legacyKeys: legacy.explained }, via: rules };
  }
  return {
    kind: "mismatch",
    reason: "events_missing",
    detail: {
      drafts: keys.length,
      missing: legacy.unexplained.length,
      examples: legacy.unexplained.slice(0, EXAMPLES),
      ...(rules.length === 0 ? {} : { legacyKeys: legacy.explained }),
    },
  };
}
