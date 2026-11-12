import {
  latestResourceAdmissionAt,
  listFanslyAccountRecheckDue,
  listFanslyFanPageIdentityBackfillTargets,
  listFanslyFansLookedUpSince,
  readFanslyAccountProbe,
  recordFanslyAccountProbe,
  type Database,
  type FanslyAccountRecheckReason,
  type SyncWorkRow,
} from "@agency_hub_core/db";
import {
  FANSLY_ACCOUNT_LOOKUP_BATCH_SIZE,
  type FanslyAccount,
} from "@agency_hub_core/fansly";

import { FANSLY_ACCOUNT_LOOKUP_REUSE_MS, upsertHydratedFansForPageDetailed } from "../lib/fan-hydration.ts";
import type {
  ApplyInput,
  ApplyResult,
  DemandSignal,
  RequestPlan,
  ResourceModule,
  StepPlan,
} from "../../engine/resource.ts";
import { recordOf } from "../lib/values.ts";

// `fan-profiles.lookup`, `.probe`, `.alias-backfill` (plan §5, design §5.13):
// `GET /account?ids=<≤100>`, journaled as `account_lookup` (raw-only, CDN
// tokens stripped) exactly as the legacy hydration journals it.
//
// - lookup (planned walk): the profiles other applies asked for — a
//   subscriber, a follower served without its account. The asking apply
//   merges the fan ids into the walk row's `params.ids` (`DemandSignal.ids`);
//   each step reads the ids not looked up through this page within the day
//   (owner decision 2026-09-30, `page_fans.account_lookup_at`), ≤ 100 at a
//   time. The answer is stored with its lookup stamp in one transaction, and
//   every asked id gets the page's own answer, returned or omitted
//   (`page_fans.account_probe_*`, which the probe reuses for a day). An
//   omitted id marks nothing on the shared fan row: a fan who blocked the
//   page is omitted too (arena "vanished chat" D2; all of it only for an answer the contract
//   accepted: a non-array is quarantined and marks nothing).
// - probe (planned trigger, subject = the DM partner id): "does this partner
//   still resolve for the page?", answer stored and reused for a day. It
//   excludes no chat: a lookup miss is the page's own evidence (the fan
//   blocked the page, or a transient miss), and a chat Fansly stops serving
//   is the chat-unavailability episode's (arena "vanished chat" §6). No apply
//   asks for it any more; a row an older image left open still runs.
// - alias-backfill (planned goal, owner): every fan of the page in keyset
//   batches of 100 — the old CLI, now journaled, transactional and paced.
// - recheck (standing walk of the page, 0374): the page's answer kept fresh
//   for the fans whose answer matters, whoever names them. Each pass derives
//   the due ids from the database (`listFanslyAccountRecheckDue`: a chatter's
//   browser that disagreed with the page's answer, the partners of the page's
//   open chat-unavailability episodes, the paying fans whose answer is over 72
//   hours old) and asks up to 100 of them, at most one request a page in 5
//   minutes; a pass with nothing due asks nothing. Its own due rule is the
//   freshness: it takes no part in the lookup walk's day of reuse.
//
// Every answer is dated when it ARRIVED (the observation's journal instant),
// however late it is applied, and never replaces a newer answer of the page
// (`page_fans.account_probe_*`, the writers' guard).

export const FAN_PROFILES_LOOKUP_KEY = "fan-profiles.lookup";

const BATCH = FANSLY_ACCOUNT_LOOKUP_BATCH_SIZE;

function stringIds(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((id): id is string => typeof id === "string" && id.length > 0);
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
 *  the returned accounts, every asked id stamped as looked up with the page's
 *  own answer (returned or omitted) — one transaction. An omitted id marks
 *  nothing on the shared fan row (arena "vanished chat" D2). `answeredAt` is
 *  when the answer arrived (`ApplyInput.observation.receivedAt`), not when it
 *  is applied: a late apply never dates it fresher, and a link holding a
 *  newer answer keeps it. */
async function storeLookupAnswer(
  tx: Database,
  input: { pageId: number; requested: readonly string[]; accounts: readonly FanslyAccount[]; answeredAt: Date },
) {
  const stored = await upsertHydratedFansForPageDetailed(tx, {
    platformAccountId: input.pageId,
    accounts: [...input.accounts],
    lookup: { lookedUpAt: input.answeredAt, platformUserIds: [...input.requested] },
  });
  return {
    requested: input.requested.length,
    returned: input.accounts.length,
    fallback: stored.missedCount,
    notesUpserted: stored.upsertedNoteCount,
    aliasesSet: stored.aliasesSet,
    aliasesCleared: stored.aliasesCleared,
  };
}

// ── lookup ──────────────────────────────────────────────────────────────────

async function nextLookupBatch(
  work: SyncWorkRow,
  input: { db: Database; pageId: number; now: Date },
): Promise<string[]> {
  const { due } = await partitionLookupIds(input.db, { pageId: input.pageId, ids: pendingLookupIds(work), now: input.now });
  return due.sort().slice(0, BATCH);
}

export const fanProfilesLookupModule: ResourceModule = {
  async plan(work, ctx): Promise<StepPlan> {
    const batch = await nextLookupBatch(work, { db: ctx.db, pageId: ctx.pageId, now: ctx.now });
    if (batch.length === 0) return { kind: "done", cursor: {}, reason: "profiles_fresh" };
    return { kind: "request", request: lookupRequest(batch) };
  },

  async apply(tx, input: ApplyInput): Promise<ApplyResult> {
    const requested = requestedIds(input.request);
    const stored = await storeLookupAnswer(tx, {
      pageId: input.pageId,
      requested,
      accounts: input.parsed as FanslyAccount[],
      answeredAt: input.observation.receivedAt,
    });
    // What is left after this answer's stamps (same transaction): the walk
    // goes on, or closes when nothing it was asked for is due.
    const left = await nextLookupBatch(input.work, { db: tx, pageId: input.pageId, now: input.now });
    return {
      work: left.length === 0
        ? { satisfiesRevision: true, close: "done", closeReason: "profiles_fresh", result: stored }
        : { satisfiesRevision: false, nextDueAt: input.now, result: stored },
      followups: [],
      counters: { profiles_returned: stored.returned, profiles_missing: stored.fallback },
    };
  },
};

// ── probe ───────────────────────────────────────────────────────────────────

export type FanslyAccountResolution = "resolved" | "unresolved" | "unknown";

/** The probe's verdict on one answer: `[]` is unresolved, the id present is
 *  resolved, anything else says nothing (as the legacy DM partner probe judged
 *  it before step 4 removed it, S4-14). */
export function probeResolution(accounts: readonly FanslyAccount[], partner: string): FanslyAccountResolution {
  if (accounts.length === 0) return "unresolved";
  return accounts.some((account) => account.id === partner) ? "resolved" : "unknown";
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
        probedAt: input.observation.receivedAt,
        resolved: resolution === "resolved",
      });
    }
    // The answer is the page's fact about the partner; the chat a row of an
    // older image names (`params.conversationId`) stays read like any other.
    return {
      work: { satisfiesRevision: true, close: "done", closeReason: `probe_${resolution}`, result: { resolution } },
      followups: [],
    };
  },
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
      answeredAt: input.observation.receivedAt,
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
};

// ── recheck ─────────────────────────────────────────────────────────────────

export const FAN_PROFILES_RECHECK_KEY = "fan-profiles.recheck";

/** At most one request of the re-check a page in this long; also how long a
 *  pass with nothing due rests. */
export const FAN_PROFILES_RECHECK_EVERY_MS = 5 * 60_000;

/** What one re-check request asked, by reason (`RequestPlan.step`). */
type RecheckStep = Partial<Record<FanslyAccountRecheckReason, number>>;

function recheckStepOf(value: unknown): RecheckStep {
  const record = recordOf(value);
  const step: RecheckStep = {};
  for (const reason of ["client_signal", "episode_partner", "payer"] as const) {
    const count = record[reason];
    if (typeof count === "number" && Number.isSafeInteger(count) && count > 0) step[reason] = count;
  }
  return step;
}

export const fanProfilesRecheckModule: ResourceModule = {
  async plan(_work, ctx): Promise<StepPlan> {
    const rest = new Date(ctx.now.getTime() + FAN_PROFILES_RECHECK_EVERY_MS);
    // Its own pace, from the journal: whatever became of the last request.
    const last = await latestResourceAdmissionAt(ctx.db, {
      pageId: ctx.pageId,
      resource: FAN_PROFILES_RECHECK_KEY,
      since: new Date(ctx.now.getTime() - FAN_PROFILES_RECHECK_EVERY_MS),
    });
    if (last !== null) {
      return { kind: "wait", reason: "not_due", until: new Date(last.getTime() + FAN_PROFILES_RECHECK_EVERY_MS) };
    }
    const due = await listFanslyAccountRecheckDue(ctx.db, { pageId: ctx.pageId, now: ctx.now, limit: BATCH });
    if (due.length === 0) return { kind: "wait", reason: "not_due", until: rest };
    const step: RecheckStep = {};
    for (const candidate of due) step[candidate.reason] = (step[candidate.reason] ?? 0) + 1;
    return { kind: "request", request: { ...lookupRequest(due.map((candidate) => candidate.platformUserId)), step } };
  },

  async apply(tx, input: ApplyInput): Promise<ApplyResult> {
    const requested = requestedIds(input.request);
    const stored = await storeLookupAnswer(tx, {
      pageId: input.pageId,
      requested,
      accounts: input.parsed as FanslyAccount[],
      answeredAt: input.observation.receivedAt,
    });
    const result = { ...stored, asked: recheckStepOf(input.request.step) };
    // The walk row stays: its next pass, a request's pace later, reads what is
    // due then (a reason that arrived during this one included).
    return {
      work: {
        satisfiesRevision: true,
        nextDueAt: new Date(input.now.getTime() + FAN_PROFILES_RECHECK_EVERY_MS),
        cursor: { last: { answeredAt: input.observation.receivedAt.toISOString(), ...result } },
        result,
      },
      followups: [],
      counters: { profiles_returned: stored.returned, profiles_missing: stored.fallback },
    };
  },
};
