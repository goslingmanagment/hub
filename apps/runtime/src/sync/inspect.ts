import {
  bumpPagePolls,
  confirmSyncOwnersStopped,
  countSendsSince,
  getSyncAttemptSummaries,
  getSyncWork,
  getWorkForStatus,
  latestClosedWorkForKey,
  listSendsForPaceAudit,
  listSyncPages,
  setPagePause,
  setRegistryOverride,
  setSyncPageMode,
  upsertDemand,
  type Database,
  type SetSyncPageModeResult,
  type SyncAttemptSummary,
  type SyncEngineWorkClass,
  type SyncPageMode,
  type SyncPageRow,
  type SyncRegistryOverride,
  type SyncWorkKind,
  type SyncWorkRow,
  type SyncWorkState,
} from "@agency_hub_core/db";
import type { AppConfig } from "@agency_hub_core/shared";

import { loadEffectiveConfig } from "../services/effective-config.ts";
import { demandToUpsert, registryOverrideProblem, type EngineRegistry } from "./engine/resource.ts";
import { probeRequestOf, type ProbeParams } from "./fansly/resources/probe.ts";
import { pageRequestProgress } from "./requests/history.ts";
import {
  buildPageStatus,
  estimateSlotOpensAt,
  explainWork,
  type PageStatus,
  type StatusPage,
  type StatusWork,
  type WorkExplanation,
} from "./engine/status.ts";

// The owner's view and levers of the engine (design §3.9, §7.6): page status,
// "why is this waiting", the mode lever (off ↔ shadow only, I17), pauses,
// registry overrides, "sync now" and the ownership confirmation. The owner CLI,
// the owner routes (`modules/sync-engine`) and the agent plane's status and
// "why" (`modules/agent-read/handlers-sync.ts`) call these same functions.

const HOUR_MS = 3_600_000;
const DAY_MS = 24 * HOUR_MS;

/** The modes `sync page mode` moves a page between. `handover` and `live` are
 *  reachable only through the step-3 switch (`sync switch`, I17). */
export const OWNER_PAGE_MODES = ["off", "shadow"] as const satisfies readonly SyncPageMode[];

export class SyncPageNotFoundError extends Error {
  constructor(label: string) {
    super(`No Fansly sync page "${label}" (sync_pages has no row for that label)`);
    this.name = "SyncPageNotFoundError";
  }
}

export async function findSyncPageByLabel(db: Database, label: string): Promise<SyncPageRow> {
  const page = (await listSyncPages(db)).find((row) => row.pageLabel === label);
  if (page === undefined) throw new SyncPageNotFoundError(label);
  return page;
}

/** Which journal a page's status reads: live work once the page is in
 *  `handover`/`live`, shadow work otherwise. */
export function statusJournalIsShadow(page: Pick<SyncPageRow, "mode">): boolean {
  return page.mode === "off" || page.mode === "shadow";
}

function statusPage(page: SyncPageRow): StatusPage {
  return {
    mode: page.mode,
    pausedAll: page.pausedAll,
    pausedRequests: page.pausedRequests,
    pausedResources: page.pausedResources,
    holdKind: page.holdKind,
    holdUntil: page.holdUntil,
    holdDetail: page.holdDetail,
    credentialsGeneration: page.credentialsGeneration,
    resourceHolds: page.resourceHolds,
    owner: page.owner,
  };
}

function statusWork(work: SyncWorkRow): StatusWork {
  return {
    id: work.id,
    resource: work.resource,
    subject: work.subject,
    class: work.class,
    state: work.state,
    dueAt: work.dueAt,
    breakerUntil: work.breakerUntil,
    blockedByVendorAt: work.blockedByVendorAt,
    waitingReason: work.waitingReason,
    waitingUntil: work.waitingUntil,
  };
}

/** S as the actor reads it (the live owner key, I4). */
export async function readPauseSettingMs(db: Database, rawConfig: AppConfig): Promise<number> {
  return (await loadEffectiveConfig(db, rawConfig)).fanslyDefaultDelayMs;
}

/** The status of several pages, S read once (`sync page status`, the owner
 *  and agent status routes). */
export async function readSyncPageStatuses(
  db: Database,
  rawConfig: AppConfig,
  pages: readonly SyncPageRow[],
): Promise<PageStatus[]> {
  if (pages.length === 0) return [];
  const settingMs = await readPauseSettingMs(db, rawConfig);
  const statuses: PageStatus[] = [];
  for (const page of pages) statuses.push(await readSyncPageStatus(db, rawConfig, page, page.dbNow, settingMs));
  return statuses;
}

/** The page status (design §3.9) from the database. */
export async function readSyncPageStatus(
  db: Database,
  rawConfig: AppConfig,
  page: SyncPageRow,
  now: Date = page.dbNow,
  settingMsRead?: number,
): Promise<PageStatus> {
  const shadow = statusJournalIsShadow(page);
  const settingMs = settingMsRead ?? await readPauseSettingMs(db, rawConfig);
  const works = await getWorkForStatus(db, {
    pageId: page.pageId,
    shadow,
    states: ["open", "running", "quarantined"],
    limit: 1_000,
  });
  const lastHour = await countSendsSince(db, { pageId: page.pageId, since: new Date(now.getTime() - HOUR_MS), shadow });
  const hourSends = await listSendsForPaceAudit(db, { pageId: page.pageId, since: new Date(now.getTime() - HOUR_MS), shadow });
  const daySends = await listSendsForPaceAudit(db, { pageId: page.pageId, since: new Date(now.getTime() - DAY_MS), shadow });
  const gaps = hourSends.map((send) => send.gapMs).filter((gap): gap is number => gap !== null);
  // History requests exist only on live pages (the intake refuses others).
  const requests = shadow ? [] : await pageRequestProgress({ db, rawConfig }, page.pageId);
  const status = buildPageStatus({
    pageLabel: page.pageLabel,
    page: { ...statusPage(page), holdSince: page.holdSince, lastSendAt: page.lastSendAt },
    settingMs,
    now,
    runtime: {
      slotOpensAt: estimateSlotOpensAt({ lastSendAt: page.lastSendAt, lastCompletedAt: page.lastCompletedAt, settingMs }),
    },
    works: works.map(statusWork),
    sends: {
      lastHour,
      minGapLastHourMs: gaps.length === 0 ? null : Math.min(...gaps),
      violationsLastDay: daySends.filter((send) => send.gapMs !== null && send.gapMs < send.settingMs).length,
    },
    requests,
  });
  return shadow
    ? { ...status, shadow: { attemptsLastHour: lastHour.urgent + lastHour.requests + lastHour.planned, demandVsEstimate: null } }
    : status;
}

export interface WorkWhy {
  work: {
    id: number;
    resource: string;
    subject: string;
    /** The shadow journal: simulated work, nothing was sent. */
    shadow: boolean;
    kind: SyncWorkKind;
    class: SyncEngineWorkClass;
    state: SyncWorkState;
    dueAt: Date;
    demandRevision: number;
    appliedRevision: number;
    attempts: number;
    failureCount: number;
    breakerUntil: Date | null;
    blockedByVendorAt: Date | null;
    lastErrorClass: string | null;
    lastAttempt: SyncAttemptSummary | null;
    closedAt: Date | null;
    closeReason: string | null;
    result: unknown;
  };
  /** Null for closed work: it waits for nothing. */
  waiting: WorkExplanation | null;
}

/** Why each of `rows` (one page's) waits, with each row's last attempt. */
async function workWhys(
  db: Database,
  page: SyncPageRow,
  rows: readonly SyncWorkRow[],
  settingMs: number,
  now: Date,
): Promise<WorkWhy[]> {
  const runtime = {
    slotOpensAt: estimateSlotOpensAt({ lastSendAt: page.lastSendAt, lastCompletedAt: page.lastCompletedAt, settingMs }),
  };
  const attempts = await getSyncAttemptSummaries(
    db,
    rows.map((row) => row.lastAttemptId).filter((id): id is number => id !== null),
  );
  return rows.map((work) => ({
    work: {
      id: work.id,
      resource: work.resource,
      subject: work.subject,
      shadow: work.shadow,
      kind: work.kind,
      class: work.class,
      state: work.state,
      dueAt: work.dueAt,
      demandRevision: work.demandRevision,
      appliedRevision: work.appliedRevision,
      attempts: work.attemptsCount,
      failureCount: work.failureCount,
      breakerUntil: work.breakerUntil,
      blockedByVendorAt: work.blockedByVendorAt,
      lastErrorClass: work.lastErrorClass,
      lastAttempt: work.lastAttemptId === null ? null : attempts.get(work.lastAttemptId) ?? null,
      closedAt: work.closedAt,
      closeReason: work.closeReason,
      // What a finished step left (a probe's outcome, a walk's receipt).
      result: work.result,
    },
    waiting: explainWork(statusWork(work), statusPage(page), runtime, now),
  }));
}

/** "Why is this waiting" (`sync why`): every open row of the key, or the
 *  newest closed one when none is open. */
export async function explainSyncWork(
  db: Database,
  rawConfig: AppConfig,
  page: SyncPageRow,
  input: { resource: string; subject?: string; limit?: number },
  now: Date = page.dbNow,
): Promise<WorkWhy[]> {
  const shadow = statusJournalIsShadow(page);
  const settingMs = await readPauseSettingMs(db, rawConfig);
  let rows = await getWorkForStatus(db, {
    pageId: page.pageId,
    shadow,
    resource: input.resource,
    ...(input.subject === undefined ? {} : { subject: input.subject }),
    states: ["open", "running", "quarantined"],
    ...(input.limit === undefined ? {} : { limit: input.limit }),
  });
  if (rows.length === 0 && input.subject !== undefined) {
    const closed = await latestClosedWorkForKey(db, {
      pageId: page.pageId,
      shadow,
      resource: input.resource,
      subject: input.subject,
    });
    rows = closed === null ? [] : [closed];
  }
  return workWhys(db, page, rows, settingMs, now);
}

/** A page's work rows in the journal it runs, newest first (owner route
 *  `syncPageWork`), each with why it waits. */
export async function listSyncPageWork(
  db: Database,
  rawConfig: AppConfig,
  page: SyncPageRow,
  input: { resource?: string; subject?: string; state?: SyncWorkState; limit: number; offset: number },
  now: Date = page.dbNow,
): Promise<WorkWhy[]> {
  const settingMs = await readPauseSettingMs(db, rawConfig);
  const rows = await getWorkForStatus(db, {
    pageId: page.pageId,
    shadow: statusJournalIsShadow(page),
    ...(input.resource === undefined ? {} : { resource: input.resource }),
    ...(input.subject === undefined ? {} : { subject: input.subject }),
    ...(input.state === undefined ? {} : { states: [input.state] }),
    limit: input.limit,
    offset: input.offset,
  });
  return workWhys(db, page, rows, settingMs, now);
}

/** One work row of a page (either journal) and why it waits; null when the
 *  id names no row of this page — the status link of a queued "enqueue and
 *  wait" call (design §7.3). */
export async function getSyncPageWork(
  db: Database,
  rawConfig: AppConfig,
  page: SyncPageRow,
  workId: number,
  now: Date = page.dbNow,
): Promise<WorkWhy | null> {
  const row = await getSyncWork(db, workId);
  if (row === null || row.pageId !== page.pageId) return null;
  const [why] = await workWhys(db, page, [row], await readPauseSettingMs(db, rawConfig), now);
  return why ?? null;
}

export class SyncOwnerLeverError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SyncOwnerLeverError";
  }
}

/** A lever that needs a running actor, asked of a page that is `off`. */
export class SyncPageOffError extends SyncOwnerLeverError {
  constructor(label: string, lever: string) {
    super(`${label} is off: no actor runs it, so ${lever} has nothing to move (sync page mode --to shadow first)`);
    this.name = "SyncPageOffError";
  }
}

/**
 * "Sync now" (design §7.3; owner route `syncPageRefresh`): the page's poll
 * rows — or those of the given resource files — become due now, in the journal
 * the page runs (shadow polls on an `off`/`shadow` page are simulated: nothing
 * is sent). An `off` page has no actor to serve them and is refused.
 */
export async function refreshSyncPage(
  db: Database,
  page: Pick<SyncPageRow, "pageId" | "pageLabel" | "mode">,
  files?: readonly string[],
): Promise<{ bumped: number; shadow: boolean }> {
  if (page.mode === "off") throw new SyncPageOffError(page.pageLabel ?? String(page.pageId), "sync now");
  const shadow = statusJournalIsShadow(page);
  const bumped = await bumpPagePolls(db, {
    pageId: page.pageId,
    shadow,
    ...(files === undefined ? {} : { files }),
  });
  return { bumped, shadow };
}

/** `sync page mode`: only `off ↔ shadow`. A target outside those two is
 *  refused before the database is touched (I17). */
export async function changeSyncPageModeByOwner(
  db: Database,
  input: { pageLabel: string; to: string; changedBy: string },
): Promise<SetSyncPageModeResult> {
  if (!(OWNER_PAGE_MODES as readonly string[]).includes(input.to)) {
    throw new SyncOwnerLeverError(
      `sync page mode moves a page only between off and shadow (asked: ${input.to}); `
      + "handover and live are reachable only through the step-3 switch",
    );
  }
  const page = await findSyncPageByLabel(db, input.pageLabel);
  return setSyncPageMode(db, { pageId: page.pageId, to: input.to as SyncPageMode, changedBy: input.changedBy });
}

/** `sync page pause|resume`: the owner's pauses (§10). Resources are added to
 *  (pause) or removed from (resume) the paused set. */
export async function changeSyncPagePause(
  db: Database,
  registry: EngineRegistry,
  input: {
    pageLabel: string;
    action: "pause" | "resume";
    all?: boolean;
    requests?: boolean;
    resources?: readonly string[];
    note?: string | null;
  },
): Promise<SyncPageRow> {
  const resources = input.resources ?? [];
  if (input.all !== true && input.requests !== true && resources.length === 0) {
    throw new SyncOwnerLeverError("say what to pause or resume: --all, --requests or --resource <key>");
  }
  for (const key of resources) {
    if (registry.spec(key) === null && input.action === "pause") {
      throw new SyncOwnerLeverError(`No registry entry ${key}`);
    }
  }
  const page = await findSyncPageByLabel(db, input.pageLabel);
  const paused = new Set(page.pausedResources);
  for (const key of resources) {
    if (input.action === "pause") paused.add(key);
    else paused.delete(key);
  }
  const flag = input.action === "pause";
  const updated = await setPagePause(db, {
    pageId: page.pageId,
    ...(input.all === true ? { all: flag } : {}),
    ...(input.requests === true ? { requests: flag } : {}),
    ...(resources.length > 0 ? { resources: [...paused] } : {}),
    ...(input.note === undefined ? {} : { note: input.note }),
  });
  if (updated === null) throw new SyncPageNotFoundError(input.pageLabel);
  return updated;
}

/** `sync page override`: a page's period of one registry key (a poll's
 *  period; the vault walk's incremental and full periods; the media-stats
 *  walk's age tiers), switching it off, or clearing the override. An
 *  owner-protected key (owner decision №6) needs `ownerApproved`. */
export async function changeSyncRegistryOverride(
  db: Database,
  registry: EngineRegistry,
  input: {
    pageLabel: string;
    resource: string;
    override: SyncRegistryOverride | null;
    ownerApproved: boolean;
  },
): Promise<boolean> {
  const spec = registry.spec(input.resource);
  if (spec === null) throw new SyncOwnerLeverError(`No registry entry ${input.resource}`);
  if (spec.ownerProtected === true && input.override !== null && !input.ownerApproved) {
    throw new SyncOwnerLeverError(
      `${input.resource} follows owner decision №6 (economical frequencies): changing it needs --owner-approved`,
    );
  }
  const problem = input.override === null ? null : registryOverrideProblem(spec, input.override);
  if (problem !== null) throw new SyncOwnerLeverError(`${input.resource}: ${problem}`);
  const page = await findSyncPageByLabel(db, input.pageLabel);
  return setRegistryOverride(db, { pageId: page.pageId, key: input.resource, override: input.override });
}

/** The registry key of the owner's one-off read. */
export const PROBE_KEY = "probe.manual";

/**
 * `sync probe` (design §5.22): queue one admitted read of a wire route for a
 * page, in the journal the page runs (shadow work on an `off`/`shadow` page —
 * simulated, nothing is sent — live work on a switched page). The route and
 * its parameters are checked before anything is written; one probe of a page
 * is open at a time.
 */
export async function requestSyncProbe(
  db: Database,
  registry: EngineRegistry,
  input: { pageLabel: string; operation: string; params: Record<string, unknown>; requestedBy: string },
): Promise<{ workId: number; shadow: boolean }> {
  const params: ProbeParams = { operation: input.operation as ProbeParams["operation"], params: input.params, requestedBy: input.requestedBy };
  const probe = probeRequestOf(params);
  if ("refused" in probe) throw new SyncOwnerLeverError(`sync probe refused (${probe.refused}): ${input.operation} ${JSON.stringify(input.params)}`);
  const spec = registry.spec(PROBE_KEY);
  if (spec === null) throw new SyncOwnerLeverError(`No registry entry ${PROBE_KEY}`);
  const page = await findSyncPageByLabel(db, input.pageLabel);
  if (page.mode === "off") {
    throw new SyncOwnerLeverError(`${input.pageLabel} is off: no actor runs it (sync page mode --to shadow first)`);
  }
  const shadow = statusJournalIsShadow(page);
  const upsert = demandToUpsert(
    { resource: PROBE_KEY, params, demand: { reason: "owner_probe" } },
    spec,
    { pageId: page.pageId, shadow, now: new Date(), page },
  );
  if (upsert === null) throw new SyncOwnerLeverError(`${PROBE_KEY} does not run on ${input.pageLabel} (switched off for the page)`);
  const result = await upsertDemand(db, upsert);
  if (!result.created) {
    throw new SyncOwnerLeverError(`${input.pageLabel} already has a probe queued (work ${result.id}); wait for it (sync why --resource ${PROBE_KEY})`);
  }
  return { workId: result.id, shadow };
}

/** `sync ownership confirm-stopped` (rule (e)): owners whose host is not among
 *  the running containers are confirmed stopped. */
export async function confirmStoppedSyncOwners(
  db: Database,
  input: {
    runningHosts: readonly string[];
    ownHost: string;
    confirmedBy: string;
    dryRun: boolean;
    pageLabel?: string;
    acquiredBefore?: Date | null;
  },
) {
  const pageIds = input.pageLabel === undefined ? undefined : [(await findSyncPageByLabel(db, input.pageLabel)).pageId];
  return confirmSyncOwnersStopped(db, {
    runningHosts: input.runningHosts,
    ownHost: input.ownHost,
    confirmedBy: input.confirmedBy,
    dryRun: input.dryRun,
    acquiredBefore: input.acquiredBefore ?? null,
    ...(pageIds === undefined ? {} : { pageIds }),
  });
}
