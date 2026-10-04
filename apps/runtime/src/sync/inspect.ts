import {
  bumpPagePolls,
  confirmSyncOwnersStopped,
  countSendsSince,
  getSyncAttemptSummaries,
  getSyncWork,
  getWorkForStatus,
  insertAuditEvent,
  latestClosedWorkForKey,
  listSendsForPaceAudit,
  listSyncPages,
  readRouteJournal,
  readSyncPageWsStatus,
  requeueQuarantinedWork,
  setPagePause,
  setRegistryOverride,
  setSyncPageMode,
  upsertDemand,
  type Database,
  type RequeuedSyncWork,
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
import { SYNC_DECODE_DEBT_WINDOW_MS } from "./engine/alerts.ts";
import { demandToUpsert, registryOverrideProblem, type EngineRegistry } from "./engine/resource.ts";
import {
  parseRouteState,
  routeAdmissionView,
  routeJournalLookbackMs,
  RouteClocks,
  routeStatusView,
} from "./engine/route-policy.ts";
import { FANSLY_RESOURCE_SPECS, fanslyResourceSpec, type ResourceSpec } from "./fansly/registry.ts";
import { probeRequestOf, type ProbeParams } from "./fansly/resources/probe.ts";
import { pageRequestProgress } from "./requests/history.ts";
import {
  buildPageStatus,
  estimateSlotOpensAt,
  explainWork,
  type PageStatus,
  type RouteAdmissionView,
  type RouteStatusView,
  type StatusPage,
  type StatusWork,
  type WorkExplanation,
} from "./engine/status.ts";

// The owner's view and levers of the engine (design §3.9, §7.6): page status,
// "why is this waiting", the mode lever (shadow → off only, I17), pauses,
// registry overrides, "sync now" and the ownership confirmation. The owner CLI,
// the owner routes (`modules/sync-engine`) and the agent plane's status and
// "why" (`modules/agent-read/handlers-sync.ts`) call these same functions.

const HOUR_MS = 3_600_000;
const DAY_MS = 24 * HOUR_MS;

/** The mode `sync page mode` moves a page to: `off`, from `shadow` — a mode
 *  no actor runs since step 4 (S4-23). No lever reaches `shadow`, `handover`
 *  or `live` (I17): a page is born live at onboarding. */
export const OWNER_PAGE_MODES = ["off"] as const satisfies readonly SyncPageMode[];

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

/** Whether an actor ever runs the page: `off` and `shadow` (a mode nothing
 *  runs since step 4 S4-23) have none, so a lever that only moves work has
 *  nothing to move there. */
function runsNoActor(page: Pick<SyncPageRow, "mode">): boolean {
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
    holdSince: page.holdSince,
    holdDetail: page.holdDetail,
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
    http: fanslyResourceSpec(work.resource)?.http !== false,
  };
}

/** The page's route clocks as the actor would read them now: its attempt
 *  journal and the legacy send log. */
async function readPageRoutes(
  db: Database,
  page: SyncPageRow,
  now: Date,
): Promise<{ status: RouteStatusView; admission: RouteAdmissionView }> {
  const read = parseRouteState(page.routeState);
  let clocks: RouteClocks | null = null;
  if (read.ok) {
    const sends = await readRouteJournal(db, { pageId: page.pageId, withinMs: routeJournalLookbackMs(read.state) });
    clocks = new RouteClocks({ sends, state: read.state });
  }
  const stateError = read.ok ? null : read.diagnostic;
  return {
    status: routeStatusView(clocks, stateError, now),
    admission: routeAdmissionView(clocks, stateError, FANSLY_RESOURCE_SPECS, now),
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
  const settingMs = settingMsRead ?? await readPauseSettingMs(db, rawConfig);
  const works = await getWorkForStatus(db, {
    pageId: page.pageId,
    states: ["open", "running", "quarantined"],
    limit: 1_000,
  });
  const lastHour = await countSendsSince(db, { pageId: page.pageId, since: new Date(now.getTime() - HOUR_MS) });
  const hourSends = await listSendsForPaceAudit(db, { pageId: page.pageId, since: new Date(now.getTime() - HOUR_MS) });
  const daySends = await listSendsForPaceAudit(db, { pageId: page.pageId, since: new Date(now.getTime() - DAY_MS) });
  const gaps = hourSends.map((send) => send.gapMs).filter((gap): gap is number => gap !== null);
  // The socket is the engine's to report only on a page it owns; history
  // requests exist only there too (the intake refuses every other page).
  const owned = !runsNoActor(page);
  const requests = owned ? await pageRequestProgress({ db, rawConfig }, page.pageId) : [];
  const ws = owned ? await readSyncPageWsStatus(db, { pageId: page.pageId, decodeWindowMs: SYNC_DECODE_DEBT_WINDOW_MS }) : null;
  const routes = await readPageRoutes(db, page, now);
  return buildPageStatus({
    pageLabel: page.pageLabel,
    page: { ...statusPage(page), lastSendAt: page.lastSendAt },
    settingMs,
    now,
    runtime: {
      slotOpensAt: estimateSlotOpensAt({ lastSendAt: page.lastSendAt, lastCompletedAt: page.lastCompletedAt, settingMs }),
      routes: routes.admission,
    },
    routes: routes.status,
    works: works.map(statusWork),
    sends: {
      lastHour,
      minGapLastHourMs: gaps.length === 0 ? null : Math.min(...gaps),
      violationsLastDay: daySends.filter((send) => send.gapMs !== null && send.gapMs < send.settingMs).length,
    },
    requests,
    ws: ws === null
      ? null
      : {
        connected: ws.connected,
        since: ws.since?.toISOString() ?? null,
        gapSince: ws.gapSince?.toISOString() ?? null,
        decodeDebt: ws.decodeDebt,
      },
  });
}

export interface WorkWhy {
  work: {
    id: number;
    resource: string;
    subject: string;
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
    routes: (await readPageRoutes(db, page, now)).admission,
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
  const settingMs = await readPauseSettingMs(db, rawConfig);
  let rows = await getWorkForStatus(db, {
    pageId: page.pageId,
    resource: input.resource,
    ...(input.subject === undefined ? {} : { subject: input.subject }),
    states: ["open", "running", "quarantined"],
    ...(input.limit === undefined ? {} : { limit: input.limit }),
  });
  if (rows.length === 0 && input.subject !== undefined) {
    const closed = await latestClosedWorkForKey(db, { pageId: page.pageId, resource: input.resource, subject: input.subject });
    rows = closed === null ? [] : [closed];
  }
  return workWhys(db, page, rows, settingMs, now);
}

/** A page's work rows, newest first (owner route `syncPageWork`), each with
 *  why it waits. */
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
    ...(input.resource === undefined ? {} : { resource: input.resource }),
    ...(input.subject === undefined ? {} : { subject: input.subject }),
    ...(input.state === undefined ? {} : { states: [input.state] }),
    limit: input.limit,
    offset: input.offset,
  });
  return workWhys(db, page, rows, settingMs, now);
}

/** One work row of a page and why it waits; null when the id names no row
 *  of this page — the status link of a queued "enqueue and wait" call
 *  (design §7.3). */
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

/** A lever that needs a running actor, asked of a page no actor runs (`off`,
 *  or left in `shadow`). */
export class SyncPageOffError extends SyncOwnerLeverError {
  constructor(label: string, mode: SyncPageMode, lever: string) {
    super(`${label} is ${mode}: no actor runs it, so ${lever} has nothing to move`);
    this.name = "SyncPageOffError";
  }
}

/**
 * "Sync now" (design §7.3; owner route `syncPageRefresh`): the page's poll
 * rows — or those of the given resource files — become due now. A page no
 * actor runs (`off`, `shadow`) has none to serve them and is refused.
 */
export async function refreshSyncPage(
  db: Database,
  page: Pick<SyncPageRow, "pageId" | "pageLabel" | "mode">,
  files?: readonly string[],
): Promise<{ bumped: number }> {
  if (runsNoActor(page)) throw new SyncPageOffError(page.pageLabel ?? String(page.pageId), page.mode, "sync now");
  return { bumped: await bumpPagePolls(db, { pageId: page.pageId, ...(files === undefined ? {} : { files }) }) };
}

/** `sync page mode`: only `shadow → off`. Any other target is refused before
 *  the database is touched (I17). */
export async function changeSyncPageModeByOwner(
  db: Database,
  input: { pageLabel: string; to: string; changedBy: string },
): Promise<SetSyncPageModeResult> {
  if (!(OWNER_PAGE_MODES as readonly string[]).includes(input.to)) {
    throw new SyncOwnerLeverError(
      `sync page mode only takes a page left in shadow to off (asked: ${input.to}); `
      + "no lever reaches shadow, handover or live — a page is born live at onboarding",
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

/** The owner's requeue of quarantined work in the audit log. */
export const SYNC_WORK_REQUEUE_AUDIT_EVENT = "admin.sync_work_requeue";
/** The owner's own demand for a registry key in the audit log. */
export const SYNC_WORK_ENQUEUE_AUDIT_EVENT = "admin.sync_work_enqueue";

/**
 * `sync work requeue` (design step 3 §3.2 item 5): take quarantined work of a
 * page out of quarantine — the given rows, or every quarantined row of the
 * page (of one key with `resources`). A row whose last attempt holds a
 * captured answer re-applies it from the journal (no request, plan §9); the
 * rest open due now. Given rows are all-or-nothing — one that is not a
 * quarantined row of the page refuses the whole requeue. The requeue and its
 * audit row commit together; the actor wakes at commit.
 */
export async function requeueSyncWork(
  db: Database,
  input: {
    pageLabel: string;
    workIds?: readonly number[];
    resources?: readonly string[];
    actor: string;
    note?: string | null;
  },
): Promise<RequeuedSyncWork[]> {
  if ((input.workIds === undefined || input.workIds.length === 0) && input.resources === undefined) {
    throw new SyncOwnerLeverError("say what to requeue: --work <id> or --quarantined [--resource <key>]");
  }
  const page = await findSyncPageByLabel(db, input.pageLabel);
  const workIds = input.workIds === undefined || input.workIds.length === 0 ? null : [...new Set(input.workIds)];
  return db.transaction(async (tx) => {
    const txDb = tx as unknown as Database;
    const requeued = await requeueQuarantinedWork(txDb, {
      pageId: page.pageId,
      ...(workIds === null ? {} : { workIds }),
      ...(input.resources === undefined || input.resources.length === 0 ? {} : { resources: input.resources }),
    });
    if (workIds !== null) {
      const taken = new Set(requeued.map((row) => row.id));
      const refused = workIds.filter((id) => !taken.has(id));
      if (refused.length > 0) {
        // Rolls the transaction back: nothing requeued, nothing audited.
        throw new SyncOwnerLeverError(
          `not a quarantined row of ${input.pageLabel}: work ${refused.join(", ")}; nothing requeued`,
        );
      }
    }
    await insertAuditEvent(txDb, {
      platformAccountId: page.pageId,
      source: "cli",
      eventType: SYNC_WORK_REQUEUE_AUDIT_EVENT,
      metadata: {
        actor: input.actor,
        pageLabel: input.pageLabel,
        asked: { workIds: input.workIds ?? null, resources: input.resources ?? null },
        requeued: requeued.map((row) => ({ id: row.id, resource: row.resource, reapplyAttemptId: row.reapplyAttemptId })),
        ...(input.note === undefined || input.note === null ? {} : { note: input.note }),
      },
    });
    return requeued;
  });
}

/** The registry keys `sync work enqueue` takes: every key the owner may
 *  start (`owner` trigger) except those with a lever of their own — the
 *  probes (`sync probe`, `sync excluded probe`) and the credential checks
 *  (the account routes). */
const OWNER_ENQUEUE_EXCLUDED_KEYS: ReadonlySet<string> = new Set([
  "probe.manual",
  "probe.excluded-chat",
  "account.verify",
  "account.identity",
]);

export function ownerEnqueueKeys(specs: readonly ResourceSpec[] = FANSLY_RESOURCE_SPECS): string[] {
  return specs
    .filter((spec) => spec.triggers.includes("owner") && !OWNER_ENQUEUE_EXCLUDED_KEYS.has(spec.key))
    .map((spec) => spec.key)
    .sort();
}

/**
 * `sync work enqueue` (design step 3 §3.2 item 5): the owner's own demand for
 * one registry key of a live page (a backfill, a fresh follower walk, an
 * alias backfill) — the owner levers of the legacy streams that had one.
 * Demand reason `owner` (the follower walk's daily floor yields to it);
 * audited with the demand in one transaction. Only a `live` page: no actor
 * runs any other.
 */
export async function enqueueOwnerSyncWork(
  db: Database,
  registry: EngineRegistry,
  input: {
    pageLabel: string;
    resource: string;
    subject?: string;
    params?: Record<string, unknown>;
    actor: string;
    note?: string | null;
  },
): Promise<{ workId: number; demandRevision: number; created: boolean }> {
  const allowed = ownerEnqueueKeys();
  if (!allowed.includes(input.resource)) {
    throw new SyncOwnerLeverError(`sync work enqueue takes one of ${allowed.join(", ")} (asked: ${input.resource})`);
  }
  const spec = registry.spec(input.resource);
  if (spec === null) throw new SyncOwnerLeverError(`No registry entry ${input.resource}`);
  // One open row per (key, subject): a page-level key given a subject would
  // start a second, parallel walk of the same key.
  const subjectKind = FANSLY_RESOURCE_SPECS.find((candidate) => candidate.key === input.resource)?.subject ?? "page";
  const subject = input.subject ?? "";
  if (subjectKind === "page" && subject !== "") {
    throw new SyncOwnerLeverError(`${input.resource} is the page's own work: it takes no --subject (asked: ${subject})`);
  }
  if (subjectKind !== "page" && subject === "") {
    throw new SyncOwnerLeverError(`${input.resource} runs per ${subjectKind}: name one with --subject`);
  }
  const page = await findSyncPageByLabel(db, input.pageLabel);
  if (page.mode !== "live") {
    throw new SyncOwnerLeverError(
      `${input.pageLabel} is ${page.mode}: owner work is enqueued only on a live page (the engine sends nothing on it otherwise)`,
    );
  }
  const upsert = demandToUpsert(
    {
      resource: input.resource,
      ...(subject === "" ? {} : { subject }),
      ...(input.params === undefined ? {} : { params: input.params }),
      demand: { reason: "owner" },
    },
    spec,
    { pageId: page.pageId, now: new Date(), page },
  );
  if (upsert === null) throw new SyncOwnerLeverError(`${input.resource} is switched off on ${input.pageLabel} (sync page override)`);
  return db.transaction(async (tx) => {
    const txDb = tx as unknown as Database;
    const result = await upsertDemand(txDb, upsert);
    await insertAuditEvent(txDb, {
      platformAccountId: page.pageId,
      source: "cli",
      eventType: SYNC_WORK_ENQUEUE_AUDIT_EVENT,
      metadata: {
        actor: input.actor,
        pageLabel: input.pageLabel,
        resource: input.resource,
        subject,
        params: input.params ?? null,
        workId: result.id,
        created: result.created,
        ...(input.note === undefined || input.note === null ? {} : { note: input.note }),
      },
    });
    return { workId: result.id, demandRevision: result.demandRevision, created: result.created };
  });
}

/** The registry key of the owner's one-off read. */
export const PROBE_KEY = "probe.manual";

/**
 * `sync probe` (design §5.22): queue one admitted read of a wire route for a
 * page an actor runs. The route and its parameters are checked before
 * anything is written; one probe of a page is open at a time.
 */
export async function requestSyncProbe(
  db: Database,
  registry: EngineRegistry,
  input: { pageLabel: string; operation: string; params: Record<string, unknown>; requestedBy: string },
): Promise<{ workId: number }> {
  const params: ProbeParams = { operation: input.operation as ProbeParams["operation"], params: input.params, requestedBy: input.requestedBy };
  const probe = probeRequestOf(params);
  if ("refused" in probe) throw new SyncOwnerLeverError(`sync probe refused (${probe.refused}): ${input.operation} ${JSON.stringify(input.params)}`);
  const spec = registry.spec(PROBE_KEY);
  if (spec === null) throw new SyncOwnerLeverError(`No registry entry ${PROBE_KEY}`);
  const page = await findSyncPageByLabel(db, input.pageLabel);
  if (runsNoActor(page)) throw new SyncOwnerLeverError(`${input.pageLabel} is ${page.mode}: no actor runs it`);
  const upsert = demandToUpsert(
    { resource: PROBE_KEY, params, demand: { reason: "owner_probe" } },
    spec,
    { pageId: page.pageId, now: new Date(), page },
  );
  if (upsert === null) throw new SyncOwnerLeverError(`${PROBE_KEY} does not run on ${input.pageLabel} (switched off for the page)`);
  const result = await upsertDemand(db, upsert);
  if (!result.created) {
    throw new SyncOwnerLeverError(`${input.pageLabel} already has a probe queued (work ${result.id}); wait for it (sync why --resource ${PROBE_KEY})`);
  }
  return { workId: result.id };
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
