import { sql } from "drizzle-orm";

import {
  excludePageDmConversationMessageSync,
  listFanslyFanPageIdentityBackfillTargets,
  listFanslyFansLookedUpSince,
  readFanslyAccountProbe,
  recordFanslyAccountProbe,
  type Database,
  type SyncWorkRow,
} from "@agency_hub_core/db";
import {
  FANSLY_ACCOUNT_LOOKUP_BATCH_SIZE,
  parseFanslyAccountsByIds,
  type FanslyAccount,
} from "@agency_hub_core/fansly";
import { FANSLY_DM_MESSAGE_SYNC_EXCLUDED_REASON_PARTNER_UNRESOLVABLE_FROM_ACCOUNT_LOOKUP } from "@agency_hub_core/shared";

import { FANSLY_ACCOUNT_LOOKUP_REUSE_MS, upsertHydratedFansForPageDetailed } from "../../../services/sync/fan-hydration.ts";
import type {
  ApplyInput,
  ApplyResult,
  DemandSignal,
  ReplayContext,
  ReplayObservation,
  ReplayVerdict,
  RequestPlan,
  ResourceModule,
  ShadowResult,
  StepPlan,
} from "../../engine/resource.ts";

// `fan-profiles.lookup`, `.probe`, `.alias-backfill` (plan §5, design §5.13):
// `GET /account?ids=<≤100>`, journaled as `account_lookup` (raw-only, CDN
// tokens stripped) exactly as the legacy hydration journals it.
//
// - lookup (planned walk): the profiles other applies asked for — a
//   subscriber, a follower served without its account. The asking apply
//   merges the fan ids into the walk row's `params.ids` (`DemandSignal.ids`);
//   each step reads the ids not looked up through this page within the day
//   (owner decision 2026-09-30, `page_fans.account_lookup_at`), ≤ 100 at a
//   time. The answer is stored with its lookup stamp in one transaction; an
//   id the answer omits is marked deleted (only for an answer the contract
//   accepted: a non-array is quarantined and marks nothing).
// - probe (planned trigger, subject = the DM partner id): "does this partner
//   still resolve?", answer reused for a day; `unresolved` excludes the
//   conversation the probe names from message sync. A `resolved` answer
//   clears an exclusion through the conversation list's own writer, which
//   reads the stored answer on its next read of the chat.
// - alias-backfill (planned goal, owner): every fan of the page in keyset
//   batches of 100 — the old CLI, now journaled, transactional and paced.

export const FAN_PROFILES_LOOKUP_KEY = "fan-profiles.lookup";

const BATCH = FANSLY_ACCOUNT_LOOKUP_BATCH_SIZE;

function stringIds(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((id): id is string => typeof id === "string" && id.length > 0);
}

function recordOf(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

/** The fan ids a batch work was asked for (`params.ids`). */
export function pendingLookupIds(work: Pick<SyncWorkRow, "params">): string[] {
  return [...new Set(stringIds(recordOf(work.params).ids))];
}

/** Split ids into the ones looked up through the page within the reuse day
 *  (`fresh`) and the rest (`due`), each in the order given. */
export async function partitionLookupIds(
  db: Database,
  input: { pageId: number; ids: readonly string[]; now: Date },
): Promise<{ fresh: string[]; due: string[] }> {
  const ids = [...new Set(input.ids.filter((id) => id.length > 0))];
  if (ids.length === 0) return { fresh: [], due: [] };
  const fresh = new Set(await listFanslyFansLookedUpSince(db, {
    platformAccountId: input.pageId,
    platformUserIds: ids,
    since: new Date(input.now.getTime() - FANSLY_ACCOUNT_LOOKUP_REUSE_MS),
  }));
  return { fresh: ids.filter((id) => fresh.has(id)), due: ids.filter((id) => !fresh.has(id)) };
}

/** The follow-up that asks the lookup walk for these fans' profiles. */
export function lookupFollowups(ids: readonly string[], reason: string): DemandSignal[] {
  const unique = [...new Set(ids)];
  return unique.length === 0 ? [] : [{ resource: FAN_PROFILES_LOOKUP_KEY, ids: unique, demand: { reason } }];
}

function lookupRequest(ids: readonly string[]): RequestPlan<"accounts.by_ids"> {
  return { spec: "accounts.by_ids", params: { ids: [...ids] } };
}

function requestedIds(request: RequestPlan): string[] {
  return stringIds(recordOf(request.params).ids);
}

/** Store one accepted `/account?ids=` answer: profiles, notes and aliases of
 *  the returned accounts, the omitted ids marked deleted, every asked id
 *  stamped as looked up — one transaction. */
async function storeLookupAnswer(
  tx: Database,
  input: { pageId: number; requested: readonly string[]; accounts: readonly FanslyAccount[]; now: Date },
) {
  const returned = new Set(input.accounts.map((account) => account.id));
  const fallbackIds = input.requested.filter((id) => !returned.has(id));
  const stored = await upsertHydratedFansForPageDetailed(tx, {
    platformAccountId: input.pageId,
    accounts: [...input.accounts],
    fallbackIds,
    lookup: { lookedUpAt: input.now, platformUserIds: [...input.requested] },
  });
  return {
    requested: input.requested.length,
    returned: input.accounts.length,
    fallback: fallbackIds.length,
    notesUpserted: stored.upsertedNoteCount,
    aliasesSet: stored.aliasesSet,
    aliasesCleared: stored.aliasesCleared,
  };
}

/** Replay of an `account_lookup` observation: the contract accepts it and
 *  every account it returned is a known fan. */
async function replayLookup(observation: ReplayObservation, ctx: ReplayContext): Promise<ReplayVerdict> {
  const parsed = parseFanslyAccountsByIds(observation.payload);
  if (!parsed.ok) return { kind: "mismatch", reason: "contract_refused", detail: { ...parsed.violation } };
  const ids = [...new Set(parsed.value.map((account) => account.id))];
  if (ids.length === 0) return { kind: "match", detail: { returned: 0 } };
  const result = await ctx.db.execute<{ platformUserId: string }>(sql`
    select f.platform_user_id as "platformUserId"
      from fans f
      join page_fans fp on fp.fan_id = f.id and fp.platform_account_id = ${ctx.pageId}
     where f.platform_user_id = any(${sql.param(ids)}::text[])
  `);
  const known = new Set(result.rows.map((row) => row.platformUserId));
  const missing = ids.filter((id) => !known.has(id));
  return missing.length === 0
    ? { kind: "match", detail: { returned: ids.length } }
    : { kind: "mismatch", reason: "fans_missing", detail: { missing: missing.length, examples: missing.slice(0, 5) } };
}

// ── lookup ──────────────────────────────────────────────────────────────────

interface LookupCursor {
  /** Shadow only: the keyset of the due ids already simulated. */
  shadowAfter?: string;
}

async function nextLookupBatch(
  work: SyncWorkRow,
  input: { db: Database; pageId: number; now: Date; after: string | null },
): Promise<string[]> {
  const { due } = await partitionLookupIds(input.db, { pageId: input.pageId, ids: pendingLookupIds(work), now: input.now });
  const after = input.after;
  return due.sort().filter((id) => after === null || id > after).slice(0, BATCH);
}

export const fanProfilesLookupModule: ResourceModule = {
  async plan(work, ctx): Promise<StepPlan> {
    const after = ctx.shadow ? (recordOf(work.cursor) as LookupCursor).shadowAfter ?? null : null;
    const batch = await nextLookupBatch(work, { db: ctx.db, pageId: ctx.pageId, now: ctx.now, after });
    if (batch.length === 0) return { kind: "done", cursor: {}, reason: "profiles_fresh" };
    return { kind: "request", request: lookupRequest(batch) };
  },

  async apply(tx, input: ApplyInput): Promise<ApplyResult> {
    const requested = requestedIds(input.request);
    const stored = await storeLookupAnswer(tx, {
      pageId: input.pageId,
      requested,
      accounts: input.parsed as FanslyAccount[],
      now: input.now,
    });
    // What is left after this answer's stamps (same transaction): the walk
    // goes on, or closes when nothing it was asked for is due.
    const left = await nextLookupBatch(input.work, { db: tx, pageId: input.pageId, now: input.now, after: null });
    return {
      work: left.length === 0
        ? { satisfiesRevision: true, close: "done", closeReason: "profiles_fresh", result: stored }
        : { satisfiesRevision: false, nextDueAt: input.now, result: stored },
      followups: [],
      counters: { profiles_returned: stored.returned, profiles_missing: stored.fallback },
    };
  },

  async shadow(work, request, ctx): Promise<ShadowResult> {
    const batch = requestedIds(request);
    const last = batch.at(-1) ?? null;
    const left = await nextLookupBatch(work, { db: ctx.db, pageId: ctx.pageId, now: ctx.now, after: last });
    return left.length === 0
      ? { work: { satisfiesRevision: true, close: "done", closeReason: "shadow", cursor: {} }, followups: [] }
      : {
        work: { satisfiesRevision: false, nextDueAt: ctx.now, cursor: (last === null ? {} : { shadowAfter: last }) satisfies LookupCursor },
        followups: [],
      };
  },

  replay: replayLookup,
};

// ── probe ───────────────────────────────────────────────────────────────────

export type FanslyAccountResolution = "resolved" | "unresolved" | "unknown";

/** The probe's verdict on one answer: `[]` is unresolved, the id present is
 *  resolved, anything else says nothing (legacy `probeFanslyAccountResolution`). */
export function probeResolution(accounts: readonly FanslyAccount[], partner: string): FanslyAccountResolution {
  if (accounts.length === 0) return "unresolved";
  return accounts.some((account) => account.id === partner) ? "resolved" : "unknown";
}

function probeConversationId(work: SyncWorkRow): number | null {
  const id = recordOf(work.params).conversationId;
  return typeof id === "number" && Number.isSafeInteger(id) && id > 0 ? id : null;
}

export const fanProfilesProbeModule: ResourceModule = {
  async plan(work, ctx): Promise<StepPlan> {
    const partner = work.subject;
    if (partner.length === 0) return { kind: "quarantine", reason: "probe_without_partner" };
    const previous = await readFanslyAccountProbe(ctx.db, { platformAccountId: ctx.pageId, platformUserId: partner });
    if (previous !== null && ctx.now.getTime() - previous.probedAt.getTime() < FANSLY_ACCOUNT_LOOKUP_REUSE_MS) {
      return {
        kind: "done",
        reason: "probe_reused",
        result: { resolution: previous.resolved ? "resolved" : "unresolved", probedAt: previous.probedAt.toISOString() },
      };
    }
    return { kind: "request", request: lookupRequest([partner]) };
  },

  async apply(tx, input: ApplyInput): Promise<ApplyResult> {
    const partner = input.work.subject;
    const resolution = probeResolution(input.parsed as FanslyAccount[], partner);
    // Only a definite answer holds for the day; "unknown" asks again next time.
    if (resolution !== "unknown") {
      await recordFanslyAccountProbe(tx, {
        platformAccountId: input.pageId,
        platformUserId: partner,
        probedAt: input.now,
        resolved: resolution === "resolved",
      });
    }
    const conversationId = probeConversationId(input.work);
    const excluded = resolution === "unresolved" && conversationId !== null
      ? await excludePageDmConversationMessageSync(tx, {
        conversationId,
        platformAccountId: input.pageId,
        partnerPlatformUserId: partner,
        reason: FANSLY_DM_MESSAGE_SYNC_EXCLUDED_REASON_PARTNER_UNRESOLVABLE_FROM_ACCOUNT_LOOKUP,
      })
      : false;
    return {
      work: { satisfiesRevision: true, close: "done", closeReason: `probe_${resolution}`, result: { resolution, excluded } },
      followups: [],
    };
  },

  async shadow(): Promise<ShadowResult> {
    return { work: { satisfiesRevision: true, close: "done", closeReason: "shadow" }, followups: [] };
  },

  replay: replayLookup,
};

// ── alias backfill ──────────────────────────────────────────────────────────

interface AliasBackfillCursor {
  /** The keyset: the last platform user id asked for. */
  after: string | null;
  batches: number;
  requested: number;
  returned: number;
  fallback: number;
  aliasesSet: number;
  aliasesCleared: number;
}

function aliasCursor(value: unknown): AliasBackfillCursor {
  const record = recordOf(value);
  const count = (key: string) => {
    const raw = record[key];
    return typeof raw === "number" && Number.isSafeInteger(raw) && raw >= 0 ? raw : 0;
  };
  return {
    after: typeof record.after === "string" && record.after.length > 0 ? record.after : null,
    batches: count("batches"),
    requested: count("requested"),
    returned: count("returned"),
    fallback: count("fallback"),
    aliasesSet: count("aliasesSet"),
    aliasesCleared: count("aliasesCleared"),
  };
}

export const fanProfilesAliasBackfillModule: ResourceModule = {
  async plan(work, ctx): Promise<StepPlan> {
    const cursor = aliasCursor(work.cursor);
    const targets = await listFanslyFanPageIdentityBackfillTargets(ctx.db, {
      platformAccountIds: [ctx.pageId],
      afterPlatformUserId: cursor.after,
      limit: BATCH,
    });
    if (targets.length === 0) return { kind: "done", cursor, reason: "alias_backfill_complete", result: cursor };
    return { kind: "request", request: lookupRequest(targets.map((target) => target.platformUserId)) };
  },

  async apply(tx, input: ApplyInput): Promise<ApplyResult> {
    const requested = requestedIds(input.request);
    const stored = await storeLookupAnswer(tx, {
      pageId: input.pageId,
      requested,
      accounts: input.parsed as FanslyAccount[],
      now: input.now,
    });
    const previous = aliasCursor(input.work.cursor);
    const cursor: AliasBackfillCursor = {
      after: requested.at(-1) ?? previous.after,
      batches: previous.batches + 1,
      requested: previous.requested + stored.requested,
      returned: previous.returned + stored.returned,
      fallback: previous.fallback + stored.fallback,
      aliasesSet: previous.aliasesSet + stored.aliasesSet,
      aliasesCleared: previous.aliasesCleared + stored.aliasesCleared,
    };
    // The next plan reads the next keyset batch, or closes the walk.
    return { work: { satisfiesRevision: false, nextDueAt: input.now, cursor }, followups: [] };
  },

  async shadow(work, request, ctx): Promise<ShadowResult> {
    const previous = aliasCursor(work.cursor);
    const requested = requestedIds(request);
    return {
      work: {
        satisfiesRevision: false,
        nextDueAt: ctx.now,
        cursor: { ...previous, after: requested.at(-1) ?? previous.after, batches: previous.batches + 1 },
      },
      followups: [],
    };
  },

  replay: replayLookup,
};
