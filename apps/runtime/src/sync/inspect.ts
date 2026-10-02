import {
  confirmSyncOwnersStopped,
  countSendsSince,
  getWorkForStatus,
  latestClosedWorkForKey,
  listSendsForPaceAudit,
  listSyncPages,
  setPagePause,
  setRegistryOverride,
  setSyncPageMode,
  type Database,
  type SetSyncPageModeResult,
  type SyncPageMode,
  type SyncPageRow,
  type SyncWorkRow,
} from "@agency_hub_core/db";
import type { AppConfig } from "@agency_hub_core/shared";

import { loadEffectiveConfig } from "../services/effective-config.ts";
import type { EngineRegistry } from "./engine/resource.ts";
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
// registry overrides and the ownership confirmation. The CLI calls these; the
// owner routes (S2-12) will call the same functions.

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

/** The page status (design §3.9) from the database. */
export async function readSyncPageStatus(
  db: Database,
  rawConfig: AppConfig,
  page: SyncPageRow,
  now: Date = page.dbNow,
): Promise<PageStatus> {
  const shadow = statusJournalIsShadow(page);
  const settingMs = (await loadEffectiveConfig(db, rawConfig)).fanslyDefaultDelayMs;
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
  work: { id: number; resource: string; subject: string; class: string; state: string; dueAt: Date; demandRevision: number; appliedRevision: number; attempts: number; lastErrorClass: string | null; closeReason: string | null };
  /** Null for closed work: it waits for nothing. */
  waiting: WorkExplanation | null;
}

/** "Why is this waiting" (`sync why`): every open row of the key, or the
 *  newest closed one when none is open. */
export async function explainSyncWork(
  db: Database,
  rawConfig: AppConfig,
  page: SyncPageRow,
  input: { resource: string; subject?: string },
  now: Date = page.dbNow,
): Promise<WorkWhy[]> {
  const shadow = statusJournalIsShadow(page);
  const settingMs = (await loadEffectiveConfig(db, rawConfig)).fanslyDefaultDelayMs;
  let rows = await getWorkForStatus(db, {
    pageId: page.pageId,
    shadow,
    resource: input.resource,
    ...(input.subject === undefined ? {} : { subject: input.subject }),
    states: ["open", "running", "quarantined"],
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
  const runtime = {
    slotOpensAt: estimateSlotOpensAt({ lastSendAt: page.lastSendAt, lastCompletedAt: page.lastCompletedAt, settingMs }),
  };
  return rows.map((work) => ({
    work: {
      id: work.id,
      resource: work.resource,
      subject: work.subject,
      class: work.class,
      state: work.state,
      dueAt: work.dueAt,
      demandRevision: work.demandRevision,
      appliedRevision: work.appliedRevision,
      attempts: work.attemptsCount,
      lastErrorClass: work.lastErrorClass,
      closeReason: work.closeReason,
    },
    waiting: explainWork(statusWork(work), statusPage(page), runtime, now),
  }));
}

export class SyncOwnerLeverError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SyncOwnerLeverError";
  }
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

/** `sync page override`: a page's period of one registry key, switching it
 *  off, or clearing the override. An owner-protected key (owner decision №6)
 *  needs `ownerApproved`. */
export async function changeSyncRegistryOverride(
  db: Database,
  registry: EngineRegistry,
  input: {
    pageLabel: string;
    resource: string;
    override: { everyMs: number } | { enabled: false } | null;
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
  if (input.override !== null && "everyMs" in input.override && spec.kind !== "poll") {
    throw new SyncOwnerLeverError(`${input.resource} is not a poll: it has no period`);
  }
  const page = await findSyncPageByLabel(db, input.pageLabel);
  return setRegistryOverride(db, { pageId: page.pageId, key: input.resource, override: input.override });
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
