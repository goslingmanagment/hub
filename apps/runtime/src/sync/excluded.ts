import { sql } from "drizzle-orm";

import {
  getSyncWorkRows,
  insertAuditEvent,
  isLiftableDmExclusion,
  liftSyncDmExclusion,
  listSyncAttemptsOfWorks,
  sampleExcludedDmThreads,
  SYNC_LIFTABLE_DM_EXCLUSIONS,
  unliftSyncDmExclusion,
  upsertDemand,
  type Database,
  type SyncAttemptRow,
  type SyncWorkRow,
  type SyncWorkState,
} from "@agency_hub_core/db";
import {
  FANSLY_DM_MESSAGE_SYNC_EXCLUDED_REASON_PARTNER_MISSING_FROM_AGGREGATION_ACCOUNTS,
  type FanslyDmMessageSyncExcludedReason,
} from "@agency_hub_core/shared";

import { demandToUpsert, type EngineRegistry } from "./engine/resource.ts";
import {
  EXCLUDED_CHAT_PROBE_KEY,
  type ExcludedChatProbeParams,
} from "./fansly/resources/probe.ts";
import { findSyncPageByLabel, SyncOwnerLeverError } from "./inspect.ts";

// Owner decision №8 (plan §9а, step-3 design S3-06): the chats the legacy
// engine excluded from message sync, probed on a live page and — on the
// owner's word, after a positive probe — lifted per page.
//
//   sync excluded probe  --page P [--sample 20] [--reason R]  one `probe.excluded-chat` per sampled chat
//   sync excluded report --page P [--reason R] [--record]     the verdicts; `--record` keeps them as an audit row
//   sync excluded lift   --page P --reason R --evidence-page L
//   sync excluded unlift --page P --reason R
//
// The probe is an ordinary planned read of the page's actor (I1); the report
// reads the work rows and attempts of the newest probe request; `--record`
// stores the summary as `admin.sync_dm_exclusion_probe`, which survives the
// telemetry retention and container recreates and is the evidence a lift (of
// this page or a later one) names. A lift needs a live page and a recorded
// probe with ≥ 10 probed chats, ≥ 80 % of them served and no page-level error
// (E2); it clears the reason from the page's bound threads and keeps it off
// them in the engine's conversation list. `unlift` only takes it off the
// page's list: the next list pass assigns it again.

/** The owner's probe request (the sample and its work rows). */
export const SYNC_DM_EXCLUSION_PROBE_REQUEST_AUDIT_EVENT = "admin.sync_dm_exclusion_probe_request";
/** A recorded probe verdict: the evidence a lift names. */
export const SYNC_DM_EXCLUSION_PROBE_AUDIT_EVENT = "admin.sync_dm_exclusion_probe";
export const SYNC_DM_EXCLUSION_LIFT_AUDIT_EVENT = "admin.sync_dm_exclusion_lift";
export const SYNC_DM_EXCLUSION_UNLIFT_AUDIT_EVENT = "admin.sync_dm_exclusion_unlift";

export const EXCLUDED_PROBE_DEFAULT_REASON: FanslyDmMessageSyncExcludedReason =
  FANSLY_DM_MESSAGE_SYNC_EXCLUDED_REASON_PARTNER_MISSING_FROM_AGGREGATION_ACCOUNTS;
export const EXCLUDED_PROBE_DEFAULT_SAMPLE = 20;
export const EXCLUDED_PROBE_MAX_SAMPLE = 200;
/** E2: a lift needs at least this many probed chats … */
export const LIFT_MIN_PROBED = 10;
/** … at least this share of them served (80 %) … */
export const LIFT_MIN_SERVED_PERCENT = 80;
/** … and no page-level error among the probes' attempts. */
export const PAGE_LEVEL_ERROR_CLASSES: ReadonlySet<string> = new Set(["auth", "identity_mismatch", "rate_limit", "network"]);

export function parseExclusionReason(value: string): FanslyDmMessageSyncExcludedReason {
  if (!isLiftableDmExclusion(value)) {
    throw new SyncOwnerLeverError(`not a DM exclusion reason: ${value} (one of ${SYNC_LIFTABLE_DM_EXCLUSIONS.join(", ")})`);
  }
  return value;
}

// ── probe ───────────────────────────────────────────────────────────────────

export interface ExcludedProbeRequest {
  pageId: number;
  pageLabel: string;
  reason: FanslyDmMessageSyncExcludedReason;
  requestAuditId: number;
  chats: Array<{ chat: string; workId: number; created: boolean }>;
}

/**
 * `sync excluded probe`: one `probe.excluded-chat` work per sampled chat of a
 * live page (its bound, visible chats excluded for `reason`, the most
 * recently active first) and the request's audit row, in one transaction.
 * A chat with an open probe merges into it.
 */
export async function requestExcludedChatProbes(
  db: Database,
  registry: EngineRegistry,
  input: { pageLabel: string; reason: FanslyDmMessageSyncExcludedReason; sample: number; actor: string },
): Promise<ExcludedProbeRequest> {
  if (!Number.isSafeInteger(input.sample) || input.sample < 1 || input.sample > EXCLUDED_PROBE_MAX_SAMPLE) {
    throw new SyncOwnerLeverError(`--sample is between 1 and ${EXCLUDED_PROBE_MAX_SAMPLE} (asked: ${input.sample})`);
  }
  const spec = registry.spec(EXCLUDED_CHAT_PROBE_KEY);
  if (spec === null) throw new SyncOwnerLeverError(`No registry entry ${EXCLUDED_CHAT_PROBE_KEY}`);
  const page = await findSyncPageByLabel(db, input.pageLabel);
  if (page.mode !== "live") {
    throw new SyncOwnerLeverError(
      `${input.pageLabel} is ${page.mode}: excluded chats are probed only on a live page (the engine sends nothing on it otherwise)`,
    );
  }
  const sample = await sampleExcludedDmThreads(db, { pageId: page.pageId, reason: input.reason, limit: input.sample });
  if (sample.length === 0) {
    throw new SyncOwnerLeverError(`${input.pageLabel} has no bound, visible chat excluded as ${input.reason}`);
  }
  const params: ExcludedChatProbeParams = { reason: input.reason, requestedBy: input.actor };
  return db.transaction(async (tx) => {
    const txDb = tx as unknown as Database;
    const chats: ExcludedProbeRequest["chats"] = [];
    for (const thread of sample) {
      const upsert = demandToUpsert(
        { resource: EXCLUDED_CHAT_PROBE_KEY, subject: thread.platformConversationId, params, demand: { reason: "owner_probe" } },
        spec,
        { pageId: page.pageId, shadow: false, now: new Date(), page },
      );
      if (upsert === null) {
        throw new SyncOwnerLeverError(`${EXCLUDED_CHAT_PROBE_KEY} is switched off on ${input.pageLabel} (sync page override)`);
      }
      const result = await upsertDemand(txDb, upsert);
      chats.push({ chat: thread.platformConversationId, workId: result.id, created: result.created });
    }
    const audit = await insertAuditEvent(txDb, {
      platformAccountId: page.pageId,
      source: "cli",
      eventType: SYNC_DM_EXCLUSION_PROBE_REQUEST_AUDIT_EVENT,
      metadata: {
        actor: input.actor,
        pageLabel: input.pageLabel,
        reason: input.reason,
        sample: input.sample,
        chats: chats.map((chat) => chat.chat),
        workIds: chats.map((chat) => chat.workId),
      },
    });
    return { pageId: page.pageId, pageLabel: input.pageLabel, reason: input.reason, requestAuditId: Number(audit!.id), chats };
  });
}

// ── report ──────────────────────────────────────────────────────────────────

export type ExcludedProbeVerdict = "served" | "not_served" | "pending" | "no_answer";

export interface ExcludedProbeChat {
  chat: string;
  workId: number;
  state: SyncWorkState;
  verdict: ExcludedProbeVerdict;
  closeReason: string | null;
  httpStatus: number | null;
  errorClass: string | null;
  messages: number | null;
  newestCreatedAt: string | null;
  liveIdsSeen: number | null;
  observationId: number | null;
  attemptIds: number[];
  /** Attempts of this probe with a page-level error (401/403 of the session, 429, network). */
  pageErrors: number;
}

export interface ExcludedProbeSummary {
  reason: FanslyDmMessageSyncExcludedReason;
  probed: number;
  served: number;
  notServed: number;
  pending: number;
  /** Closed without the probe's answer (cancelled, quarantined). */
  unanswered: number;
  pageErrors: number;
  workIds: number[];
}

export interface ExcludedProbeReport {
  pageId: number;
  pageLabel: string;
  requestAuditId: number;
  requestedAt: string;
  summary: ExcludedProbeSummary;
  /** Why this verdict cannot lift the exclusion (E2); null: it can. */
  liftRefusal: string | null;
  chats: ExcludedProbeChat[];
}

interface AuditRow {
  id: number;
  createdAt: Date;
  metadata: Record<string, unknown>;
}

async function latestAudit(
  db: Database,
  input: { pageId: number; eventType: string; reason?: string },
): Promise<AuditRow | null> {
  const result = await db.execute<{ id: string; createdAt: Date | string; metadata: Record<string, unknown> | null }>(sql`
    select a.id::text as id, a.created_at as "createdAt", a.metadata
      from audit_events a
     where a.platform_account_id = ${input.pageId}
       and a.event_type = ${input.eventType}
       ${input.reason === undefined ? sql`` : sql`and a.metadata ->> 'reason' = ${input.reason}`}
     order by a.id desc
     limit 1
  `);
  const row = result.rows[0];
  if (row === undefined) return null;
  return {
    id: Number(row.id),
    createdAt: row.createdAt instanceof Date ? row.createdAt : new Date(row.createdAt),
    metadata: row.metadata ?? {},
  };
}

function recordOf(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function numberOrNull(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function idList(value: unknown): number[] {
  return Array.isArray(value) ? value.filter((id): id is number => typeof id === "number" && Number.isSafeInteger(id) && id > 0) : [];
}

/** One probe work's verdict from its row and attempts. */
export function judgeExcludedProbe(work: SyncWorkRow, attempts: readonly SyncAttemptRow[]): ExcludedProbeChat {
  const result = recordOf(work.result);
  const last = attempts.at(-1) ?? null;
  let verdict: ExcludedProbeVerdict;
  if (work.state === "open" || work.state === "running") verdict = "pending";
  else if (work.state === "done" && result.served === true) verdict = "served";
  else if (work.state === "done" && result.served === false) verdict = "not_served";
  else verdict = "no_answer";
  return {
    chat: work.subject,
    workId: work.id,
    state: work.state,
    verdict,
    closeReason: work.closeReason,
    httpStatus: numberOrNull(result.httpStatus) ?? last?.httpStatus ?? null,
    errorClass: typeof result.errorClass === "string" ? result.errorClass : last?.errorClass ?? null,
    messages: numberOrNull(result.messages),
    newestCreatedAt: typeof result.newestCreatedAt === "string" ? result.newestCreatedAt : null,
    liveIdsSeen: numberOrNull(result.liveIdsSeen),
    observationId: numberOrNull(result.observationId) ?? last?.observationId ?? null,
    attemptIds: attempts.map((attempt) => attempt.id),
    pageErrors: attempts.filter((attempt) => attempt.errorClass !== null && PAGE_LEVEL_ERROR_CLASSES.has(attempt.errorClass)).length,
  };
}

export function summarizeExcludedProbes(
  reason: FanslyDmMessageSyncExcludedReason,
  chats: readonly ExcludedProbeChat[],
): ExcludedProbeSummary {
  const count = (verdict: ExcludedProbeVerdict) => chats.filter((chat) => chat.verdict === verdict).length;
  return {
    reason,
    probed: chats.length,
    served: count("served"),
    notServed: count("not_served"),
    pending: count("pending"),
    unanswered: count("no_answer"),
    pageErrors: chats.reduce((sum, chat) => sum + chat.pageErrors, 0),
    workIds: chats.map((chat) => chat.workId),
  };
}

/** E2: why a probe summary cannot lift its reason, or null when it can. */
export function liftRefusalOf(summary: Pick<ExcludedProbeSummary, "probed" | "served" | "pageErrors">): string | null {
  if (summary.probed < LIFT_MIN_PROBED) {
    return `${summary.probed} chats probed; a lift needs at least ${LIFT_MIN_PROBED}`;
  }
  if (summary.pageErrors > 0) {
    return `${summary.pageErrors} page-level error(s) during the probe; a lift needs none`;
  }
  if (summary.served * 100 < summary.probed * LIFT_MIN_SERVED_PERCENT) {
    return `${summary.served} of ${summary.probed} chats served; a lift needs at least ${LIFT_MIN_SERVED_PERCENT} %`;
  }
  return null;
}

/**
 * `sync excluded report`: the verdicts of the page's newest probe request (of
 * `reason`, when given) — served, not served, pending — with the evidence ids
 * (work, attempts, observation).
 */
export async function readExcludedProbeReport(
  db: Database,
  input: { pageLabel: string; reason?: FanslyDmMessageSyncExcludedReason },
): Promise<ExcludedProbeReport> {
  const page = await findSyncPageByLabel(db, input.pageLabel);
  const request = await latestAudit(db, {
    pageId: page.pageId,
    eventType: SYNC_DM_EXCLUSION_PROBE_REQUEST_AUDIT_EVENT,
    ...(input.reason === undefined ? {} : { reason: input.reason }),
  });
  if (request === null) {
    throw new SyncOwnerLeverError(
      `${input.pageLabel} has no excluded-chat probe${input.reason === undefined ? "" : ` of ${input.reason}`}: run sync excluded probe first`,
    );
  }
  const reason = parseExclusionReason(String(request.metadata.reason ?? ""));
  const workIds = idList(request.metadata.workIds);
  const works = await getSyncWorkRows(db, workIds);
  const attempts = await listSyncAttemptsOfWorks(db, { pageId: page.pageId, workIds });
  const chats = workIds.flatMap((workId) => {
    const work = works.get(workId);
    return work === undefined ? [] : [judgeExcludedProbe(work, attempts.filter((attempt) => attempt.workId === workId))];
  });
  const summary = summarizeExcludedProbes(reason, chats);
  return {
    pageId: page.pageId,
    pageLabel: input.pageLabel,
    requestAuditId: request.id,
    requestedAt: request.createdAt.toISOString(),
    summary,
    liftRefusal: liftRefusalOf(summary),
    chats,
  };
}

/** `sync excluded report --record`: the summary as the page's evidence. */
export async function recordExcludedProbeReport(
  db: Database,
  report: ExcludedProbeReport,
  actor: string,
): Promise<number> {
  const audit = await insertAuditEvent(db, {
    platformAccountId: report.pageId,
    source: "cli",
    eventType: SYNC_DM_EXCLUSION_PROBE_AUDIT_EVENT,
    metadata: {
      actor,
      pageLabel: report.pageLabel,
      requestAuditId: report.requestAuditId,
      ...report.summary,
      chats: report.chats.map((chat) => ({
        chat: chat.chat,
        workId: chat.workId,
        verdict: chat.verdict,
        httpStatus: chat.httpStatus,
        observationId: chat.observationId,
        pageErrors: chat.pageErrors,
      })),
    },
  });
  return Number(audit!.id);
}

// ── lift / unlift ───────────────────────────────────────────────────────────

export interface ExcludedLiftResult {
  pageLabel: string;
  reason: FanslyDmMessageSyncExcludedReason;
  evidence: { pageLabel: string; auditId: number; probed: number; served: number; pageErrors: number };
  added: boolean;
  lifted: string[];
  threadsLifted: number;
  unboundKept: number;
}

/**
 * `sync excluded lift` (E2): on a live page, with the newest recorded probe of
 * `evidencePageLabel` for `reason` showing ≥ 10 probed chats, ≥ 80 % served
 * and no page-level error — the page's list gains the reason, its bound
 * threads lose it, and the lift is audited, in one transaction.
 */
export async function liftExcludedChats(
  db: Database,
  input: { pageLabel: string; reason: FanslyDmMessageSyncExcludedReason; evidencePageLabel: string; actor: string },
): Promise<ExcludedLiftResult> {
  const page = await findSyncPageByLabel(db, input.pageLabel);
  if (page.mode !== "live") {
    throw new SyncOwnerLeverError(`${input.pageLabel} is ${page.mode}: an exclusion is lifted only on a live page`);
  }
  const evidencePage = await findSyncPageByLabel(db, input.evidencePageLabel);
  const evidence = await latestAudit(db, { pageId: evidencePage.pageId, eventType: SYNC_DM_EXCLUSION_PROBE_AUDIT_EVENT, reason: input.reason });
  if (evidence === null) {
    throw new SyncOwnerLeverError(
      `${input.evidencePageLabel} has no recorded probe of ${input.reason}: sync excluded report --page ${input.evidencePageLabel} --record`,
    );
  }
  const summary = {
    probed: numberOrNull(evidence.metadata.probed) ?? 0,
    served: numberOrNull(evidence.metadata.served) ?? 0,
    pageErrors: numberOrNull(evidence.metadata.pageErrors) ?? 0,
  };
  const refusal = liftRefusalOf(summary);
  if (refusal !== null) {
    throw new SyncOwnerLeverError(
      `the recorded probe of ${input.evidencePageLabel} (audit ${evidence.id}) does not lift ${input.reason}: ${refusal}`,
    );
  }
  return db.transaction(async (tx) => {
    const txDb = tx as unknown as Database;
    const lifted = await liftSyncDmExclusion(txDb, { pageId: page.pageId, reason: input.reason });
    if (lifted.kind === "not_live") {
      throw new SyncOwnerLeverError(`${input.pageLabel} is ${lifted.mode ?? "gone"}: an exclusion is lifted only on a live page`);
    }
    const evidenceRef = { pageLabel: input.evidencePageLabel, auditId: evidence.id, ...summary };
    await insertAuditEvent(txDb, {
      platformAccountId: page.pageId,
      source: "cli",
      eventType: SYNC_DM_EXCLUSION_LIFT_AUDIT_EVENT,
      metadata: {
        actor: input.actor,
        pageLabel: input.pageLabel,
        reason: input.reason,
        evidence: evidenceRef,
        added: lifted.added,
        lifted: lifted.lifted,
        threadsLifted: lifted.threadsLifted,
        unboundKept: lifted.unboundKept,
      },
    });
    return {
      pageLabel: input.pageLabel,
      reason: input.reason,
      evidence: evidenceRef,
      added: lifted.added,
      lifted: lifted.lifted,
      threadsLifted: lifted.threadsLifted,
      unboundKept: lifted.unboundKept,
    };
  });
}

/** `sync excluded unlift`: the reason off the page's list (any mode), audited;
 *  the next conversation list pass assigns it again. */
export async function unliftExcludedChats(
  db: Database,
  input: { pageLabel: string; reason: FanslyDmMessageSyncExcludedReason; actor: string },
): Promise<{ pageLabel: string; reason: FanslyDmMessageSyncExcludedReason; removed: boolean; lifted: string[] }> {
  const page = await findSyncPageByLabel(db, input.pageLabel);
  return db.transaction(async (tx) => {
    const txDb = tx as unknown as Database;
    const result = await unliftSyncDmExclusion(txDb, { pageId: page.pageId, reason: input.reason });
    if (result === null) throw new SyncOwnerLeverError(`${input.pageLabel} has no sync_pages row`);
    await insertAuditEvent(txDb, {
      platformAccountId: page.pageId,
      source: "cli",
      eventType: SYNC_DM_EXCLUSION_UNLIFT_AUDIT_EVENT,
      metadata: {
        actor: input.actor,
        pageLabel: input.pageLabel,
        reason: input.reason,
        removed: result.removed,
        lifted: result.lifted,
        mode: result.mode,
      },
    });
    return { pageLabel: input.pageLabel, reason: input.reason, removed: result.removed, lifted: result.lifted };
  });
}
