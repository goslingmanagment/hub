import { sql, type SQL } from "drizzle-orm";

import type { Database } from "../../client.ts";
import type { FanslySendGuardOwnerEngine, FanslySendHolderIdentity } from "../fansly-send-guard.ts";
import {
  generationParam,
  jsonParam,
  textArrayParam,
  toBigInt,
  toDate,
  toNumber,
  toRequiredDate,
} from "./values.ts";

// Fansly Sync Engine (plan §8, §11; design §2.2, §3.6, §3.7, §11): the per-page
// row of the new engine. Statements are timed by the DATABASE clock
// (`clock_timestamp()`), like the step-1 send guard.
//
// Ownership: a page has at most one owner generation at a time. An actor
// writes only under its generation (`lockOwnedPage`, I7); a new owner is
// admitted only after the previous one is CONFIRMED stopped
// (`acquireSyncPageOwnership`, I6) — a lost database session alone is never
// such a confirmation.
//
// Mode: `off ↔ shadow` is the owner's ordinary lever. `handover` and `live`
// are reachable only with the switch capability of the step-3 switch CLI; no
// step-2 build can issue it (I17, pinned by tests/sync-engine-repositories.test.ts).

export const SYNC_PAGE_MODES = ["off", "shadow", "handover", "live"] as const;
export type SyncPageMode = (typeof SYNC_PAGE_MODES)[number];

export const SYNC_PAGE_HOLD_KINDS = ["rate_limit", "auth", "identity_mismatch", "network"] as const;
export type SyncPageHoldKind = (typeof SYNC_PAGE_HOLD_KINDS)[number];

/** Session advisory lock namespace of page ownership: (58215, pageId). */
export const SYNC_PAGE_OWNERSHIP_LOCK_NAMESPACE = 58_215;

/** The step-1 guard row's owner once the switch flipped it (0229). */
export const SYNC_ENGINE_GUARD_OWNER = "fansly_sync_engine" satisfies FanslySendGuardOwnerEngine;

/** A registry key `<file>.<variant>` (= sync_work.resource). */
export const SYNC_RESOURCE_KEY_PATTERN = /^[a-z][a-z0-9-]*\.[a-z][a-z0-9-]*$/;
/** A resource file (the part of a key before the dot). */
export const SYNC_RESOURCE_FILE_PATTERN = /^[a-z][a-z0-9-]*$/;

export interface SyncPageRow {
  pageId: number;
  pageLabel: string | null;
  mode: SyncPageMode;
  modeChangedAt: Date;
  modeChangedBy: string;
  requestsEnabledAt: Date | null;
  legacyImportedAt: Date | null;
  registryOverrides: Record<string, unknown>;
  pausedAll: boolean;
  pausedRequests: boolean;
  pausedResources: string[];
  pauseNote: string | null;
  holdKind: SyncPageHoldKind | null;
  holdUntil: Date | null;
  holdSince: Date | null;
  holdStep: number;
  holdDetail: Record<string, unknown>;
  networkFailureStreak: number;
  resourceHolds: Record<string, SyncResourceHold>;
  identityAccountId: string | null;
  identityCheckedAt: Date | null;
  credentialsGeneration: string | null;
  owner: SyncPageOwnerRecord;
  cyclePos: number;
  plannedRr: Record<string, string>;
  lastAdmittedAt: Date | null;
  lastSendAt: Date | null;
  lastSendAttemptId: number | null;
  lastCompletedAt: Date | null;
  wsRouterCursor: number;
  createdAt: Date;
  updatedAt: Date;
  dbNow: Date;
}

/** The owner columns of a page: the current generation and who holds it. */
export interface SyncPageOwnerRecord {
  generation: bigint;
  instance: string | null;
  host: string | null;
  pid: number | null;
  pidStart: string | null;
  pidNs: string | null;
  bootId: string | null;
  acquiredAt: Date | null;
  heartbeatAt: Date | null;
  releasedAt: Date | null;
  releaseGeneration: bigint | null;
  stopConfirmedAt: Date | null;
  stopConfirmedBy: string | null;
}

/** `resource_holds[<file>]`: the §9 resource breaker of one resource file
 *  (no `kind`), or the conversation list's own 429 hold (`kind:
 *  'rate_limit_list'`, owner decision 2026-10-02) in the `dm-conversations`
 *  entry. */
export interface SyncResourceHold {
  until: string;
  step: number;
  since: string;
  kind?: "rate_limit_list";
  /** The newest list 429 (the list ladder's reset clock). */
  lastRateLimitAt?: string;
}

type PageSqlRow = {
  pageId: string;
  pageLabel: string | null;
  mode: SyncPageMode;
  modeChangedAt: Date | string;
  modeChangedBy: string;
  requestsEnabledAt: Date | string | null;
  legacyImportedAt: Date | string | null;
  registryOverrides: Record<string, unknown> | null;
  pausedAll: boolean;
  pausedRequests: boolean;
  pausedResources: string[] | null;
  pauseNote: string | null;
  holdKind: SyncPageHoldKind | null;
  holdUntil: Date | string | null;
  holdSince: Date | string | null;
  holdStep: number;
  holdDetail: Record<string, unknown> | null;
  networkFailureStreak: number;
  resourceHolds: Record<string, SyncResourceHold> | null;
  identityAccountId: string | null;
  identityCheckedAt: Date | string | null;
  credentialsGeneration: string | null;
  ownerGeneration: string;
  ownerInstance: string | null;
  ownerHost: string | null;
  ownerPid: number | null;
  ownerPidStart: string | null;
  ownerPidNs: string | null;
  ownerBootId: string | null;
  ownerAcquiredAt: Date | string | null;
  ownerHeartbeatAt: Date | string | null;
  ownerReleasedAt: Date | string | null;
  ownerReleaseGeneration: string | null;
  ownerStopConfirmedAt: Date | string | null;
  ownerStopConfirmedBy: string | null;
  cyclePos: number;
  plannedRr: Record<string, string> | null;
  lastAdmittedAt: Date | string | null;
  lastSendAt: Date | string | null;
  lastSendAttemptId: string | null;
  lastCompletedAt: Date | string | null;
  wsRouterCursor: string;
  createdAt: Date | string;
  updatedAt: Date | string;
  dbNow: Date | string;
};

const pageColumns = sql`
  sp.page_id::text as "pageId",
  p.label as "pageLabel",
  sp.mode,
  sp.mode_changed_at as "modeChangedAt",
  sp.mode_changed_by as "modeChangedBy",
  sp.requests_enabled_at as "requestsEnabledAt",
  sp.legacy_imported_at as "legacyImportedAt",
  sp.registry_overrides as "registryOverrides",
  sp.paused_all as "pausedAll",
  sp.paused_requests as "pausedRequests",
  sp.paused_resources as "pausedResources",
  sp.pause_note as "pauseNote",
  sp.hold_kind as "holdKind",
  sp.hold_until as "holdUntil",
  sp.hold_since as "holdSince",
  sp.hold_step as "holdStep",
  sp.hold_detail as "holdDetail",
  sp.network_failure_streak as "networkFailureStreak",
  sp.resource_holds as "resourceHolds",
  sp.identity_account_id as "identityAccountId",
  sp.identity_checked_at as "identityCheckedAt",
  sp.credentials_generation as "credentialsGeneration",
  sp.owner_generation::text as "ownerGeneration",
  sp.owner_instance::text as "ownerInstance",
  sp.owner_host as "ownerHost",
  sp.owner_pid as "ownerPid",
  sp.owner_pid_start as "ownerPidStart",
  sp.owner_pid_ns as "ownerPidNs",
  sp.owner_boot_id as "ownerBootId",
  sp.owner_acquired_at as "ownerAcquiredAt",
  sp.owner_heartbeat_at as "ownerHeartbeatAt",
  sp.owner_released_at as "ownerReleasedAt",
  sp.owner_release_generation::text as "ownerReleaseGeneration",
  sp.owner_stop_confirmed_at as "ownerStopConfirmedAt",
  sp.owner_stop_confirmed_by as "ownerStopConfirmedBy",
  sp.cycle_pos as "cyclePos",
  sp.planned_rr as "plannedRr",
  sp.last_admitted_at as "lastAdmittedAt",
  sp.last_send_at as "lastSendAt",
  sp.last_send_attempt_id::text as "lastSendAttemptId",
  sp.last_completed_at as "lastCompletedAt",
  sp.ws_router_cursor::text as "wsRouterCursor",
  sp.created_at as "createdAt",
  sp.updated_at as "updatedAt",
  clock_timestamp() as "dbNow"
`;

function ownerRecord(row: PageSqlRow): SyncPageOwnerRecord {
  return {
    generation: BigInt(row.ownerGeneration),
    instance: row.ownerInstance,
    host: row.ownerHost,
    pid: toNumber(row.ownerPid),
    pidStart: row.ownerPidStart,
    pidNs: row.ownerPidNs,
    bootId: row.ownerBootId,
    acquiredAt: toDate(row.ownerAcquiredAt),
    heartbeatAt: toDate(row.ownerHeartbeatAt),
    releasedAt: toDate(row.ownerReleasedAt),
    releaseGeneration: toBigInt(row.ownerReleaseGeneration),
    stopConfirmedAt: toDate(row.ownerStopConfirmedAt),
    stopConfirmedBy: row.ownerStopConfirmedBy,
  };
}

function normalizePageRow(row: PageSqlRow): SyncPageRow {
  return {
    pageId: Number(row.pageId),
    pageLabel: row.pageLabel,
    mode: row.mode,
    modeChangedAt: toRequiredDate(row.modeChangedAt),
    modeChangedBy: row.modeChangedBy,
    requestsEnabledAt: toDate(row.requestsEnabledAt),
    legacyImportedAt: toDate(row.legacyImportedAt),
    registryOverrides: row.registryOverrides ?? {},
    pausedAll: row.pausedAll === true,
    pausedRequests: row.pausedRequests === true,
    pausedResources: row.pausedResources ?? [],
    pauseNote: row.pauseNote,
    holdKind: row.holdKind,
    holdUntil: toDate(row.holdUntil),
    holdSince: toDate(row.holdSince),
    holdStep: Number(row.holdStep),
    holdDetail: row.holdDetail ?? {},
    networkFailureStreak: Number(row.networkFailureStreak),
    resourceHolds: row.resourceHolds ?? {},
    identityAccountId: row.identityAccountId,
    identityCheckedAt: toDate(row.identityCheckedAt),
    credentialsGeneration: row.credentialsGeneration,
    owner: ownerRecord(row),
    cyclePos: Number(row.cyclePos),
    plannedRr: row.plannedRr ?? {},
    lastAdmittedAt: toDate(row.lastAdmittedAt),
    lastSendAt: toDate(row.lastSendAt),
    lastSendAttemptId: toNumber(row.lastSendAttemptId),
    lastCompletedAt: toDate(row.lastCompletedAt),
    wsRouterCursor: Number(row.wsRouterCursor),
    createdAt: toRequiredDate(row.createdAt),
    updatedAt: toRequiredDate(row.updatedAt),
    dbNow: toRequiredDate(row.dbNow),
  };
}

// ── errors ────────────────────────────────────────────────────────────────────

/** A write of an actor whose generation no longer owns the page (I7). */
export class OwnershipLostError extends Error {
  readonly pageId: number;
  readonly generation: bigint;
  readonly currentGeneration: bigint | null;

  constructor(pageId: number, generation: bigint, currentGeneration: bigint | null) {
    super(
      `Fansly sync page ${pageId}: generation ${generation} no longer owns the page `
        + `(current: ${currentGeneration === null ? "no sync_pages row" : currentGeneration})`,
    );
    this.name = "OwnershipLostError";
    this.pageId = pageId;
    this.generation = generation;
    this.currentGeneration = currentGeneration;
  }
}

export type LiveGateClosedReason = "mode" | "guard_owner_engine";

/** A live admission without its gates: the page is not `live`, or the step-1
 *  guard row is not owned by the engine (I17). Nothing is admitted. */
export class LiveGateClosedError extends Error {
  readonly pageId: number;
  readonly reason: LiveGateClosedReason;
  readonly mode: SyncPageMode;
  readonly ownerEngine: string | null;

  constructor(pageId: number, reason: LiveGateClosedReason, mode: SyncPageMode, ownerEngine: string | null) {
    super(
      reason === "mode"
        ? `Fansly sync page ${pageId}: a live admission needs mode 'live' (is '${mode}')`
        : `Fansly sync page ${pageId}: a live admission needs the send guard owned by `
          + `'${SYNC_ENGINE_GUARD_OWNER}' (is ${ownerEngine === null ? "unset" : `'${ownerEngine}'`})`,
    );
    this.name = "LiveGateClosedError";
    this.pageId = pageId;
    this.reason = reason;
    this.mode = mode;
    this.ownerEngine = ownerEngine;
  }
}

// ── rows ──────────────────────────────────────────────────────────────────────

/**
 * Give a Fansly page its row (mode `off`) if it has none; never touches a row
 * that exists. A page of another platform gets none. Returns whether the row
 * was created.
 */
export async function ensureSyncPage(
  db: Database,
  input: { pageId: number; createdBy?: string },
): Promise<{ created: boolean }> {
  const result = await db.execute(sql`
    insert into sync_pages (page_id, mode, mode_changed_by)
    select p.id, 'off', ${input.createdBy ?? "ensure"}
      from pages p
     where p.id = ${input.pageId} and p.platform = 'fansly'
    on conflict (page_id) do nothing
  `);
  return { created: (result.rowCount ?? 0) > 0 };
}

/** Give every Fansly page its row (mode `off`) — the host at start, so a page
 *  onboarded after 0228 is listed too. Returns how many rows were created. */
export async function ensureFanslySyncPages(db: Database, input: { createdBy?: string } = {}): Promise<number> {
  const result = await db.execute(sql`
    insert into sync_pages (page_id, mode, mode_changed_by)
    select p.id, 'off', ${input.createdBy ?? "ensure"}
      from pages p
     where p.platform = 'fansly'
     order by p.id
    on conflict (page_id) do nothing
  `);
  return result.rowCount ?? 0;
}

export async function getSyncPage(db: Database, pageId: number): Promise<SyncPageRow | null> {
  const result = await db.execute<PageSqlRow>(sql`
    select ${pageColumns}
      from sync_pages sp
      left join pages p on p.id = sp.page_id
     where sp.page_id = ${pageId}
  `);
  const row = result.rows[0];
  return row ? normalizePageRow(row) : null;
}

/** Every page row (the host's mode loop and `sync status`), optionally only
 *  the given modes. */
export async function listSyncPages(
  db: Database,
  options: { modes?: readonly SyncPageMode[] } = {},
): Promise<SyncPageRow[]> {
  const modeFilter = options.modes === undefined
    ? sql``
    : sql`where sp.mode = any(${textArrayParam(options.modes)})`;
  const result = await db.execute<PageSqlRow>(sql`
    select ${pageColumns}
      from sync_pages sp
      left join pages p on p.id = sp.page_id
     ${modeFilter}
     order by p.label nulls last, sp.page_id
  `);
  return result.rows.map(normalizePageRow);
}

// ── mode ──────────────────────────────────────────────────────────────────────

/**
 * The switch CLI's capability (design §11.1): the only key to `handover` and
 * `live`. A capability is valid only as the very object this module issued
 * (a structurally equal literal is refused) and only for its page.
 * `issueSyncSwitchCapability` has exactly one sanctioned caller outside tests
 * — the step-3 switch/rollback CLI — pinned by
 * tests/sync-engine-repositories.test.ts; in step 2 nothing issues one.
 */
export interface SyncSwitchCapability {
  readonly kind: "sync_switch";
  readonly pageId: number;
  readonly purpose: string;
}

const issuedSwitchCapabilities = new WeakSet<object>();

export function issueSyncSwitchCapability(input: { pageId: number; purpose: string }): SyncSwitchCapability {
  const capability: SyncSwitchCapability = Object.freeze({
    kind: "sync_switch" as const,
    pageId: input.pageId,
    purpose: input.purpose,
  });
  issuedSwitchCapabilities.add(capability);
  return capability;
}

function holdsSwitchCapability(capability: SyncSwitchCapability | undefined, pageId: number): boolean {
  return capability !== undefined && issuedSwitchCapabilities.has(capability) && capability.pageId === pageId;
}

/** Whether `capability` is a switch capability this module issued for
 *  `pageId` (the switch's own final chain rebuild runs in `handover`, §8.2). */
export function holdsSyncSwitchCapability(capability: SyncSwitchCapability | undefined, pageId: number): boolean {
  return holdsSwitchCapability(capability, pageId);
}

/** Transitions the owner makes without a capability (`sync page mode`). */
const OWNER_TRANSITIONS: ReadonlySet<string> = new Set(["off>shadow", "shadow>off"]);

/** Transitions of the switch (§11.1) and the rollback (§11.2). */
const SWITCH_TRANSITIONS: ReadonlySet<string> = new Set([
  "shadow>handover", // A: fence the legacy engine
  "handover>live", // C: take over
  "handover>shadow", // B timed out: back to shadow
  "live>handover", // rollback 1: stop the live actor, legacy stays fenced
  "handover>off", // rollback 4: legacy owns the page again
]);

export type SetSyncPageModeResult =
  | { kind: "changed"; from: SyncPageMode; to: SyncPageMode; modeChangedAt: Date }
  | { kind: "unchanged"; mode: SyncPageMode }
  | {
    kind: "refused";
    from: SyncPageMode | null;
    to: SyncPageMode;
    reason: "no_page" | "expected_mode_mismatch" | "capability_required" | "transition_not_allowed";
  };

/**
 * Move a page between modes. Without the switch capability only `off ↔ shadow`
 * is possible, and only from those modes (I17); every other change needs the
 * capability issued for this page and must be a transition of the switch or the
 * rollback. `expectFrom` makes the change conditional on the current mode.
 * Leaving to `off` or `shadow` clears `legacy_imported_at` (the legacy cursors
 * are the truth again, §11.2; an import made before an aborted switch is
 * never reused by a later one, step-3 §3.5 item 9).
 */
export async function setSyncPageMode(
  db: Database,
  input: {
    pageId: number;
    to: SyncPageMode;
    changedBy: string;
    expectFrom?: SyncPageMode;
    capability?: SyncSwitchCapability;
  },
): Promise<SetSyncPageModeResult> {
  if (!(SYNC_PAGE_MODES as readonly string[]).includes(input.to)) {
    throw new Error(`Unknown Fansly sync page mode: ${String(input.to)}`);
  }
  if (input.changedBy.trim().length === 0) {
    throw new Error("setSyncPageMode needs who changes the mode (changedBy)");
  }
  return db.transaction(async (tx): Promise<SetSyncPageModeResult> => {
    const current = await tx.execute<{ mode: SyncPageMode }>(sql`
      select mode from sync_pages where page_id = ${input.pageId} for no key update
    `);
    const from = current.rows[0]?.mode ?? null;
    if (from === null) return { kind: "refused", from, to: input.to, reason: "no_page" };
    if (input.expectFrom !== undefined && input.expectFrom !== from) {
      return { kind: "refused", from, to: input.to, reason: "expected_mode_mismatch" };
    }
    if (from === input.to) return { kind: "unchanged", mode: from };
    const transition = `${from}>${input.to}`;
    if (!OWNER_TRANSITIONS.has(transition)) {
      if (!SWITCH_TRANSITIONS.has(transition)) {
        return { kind: "refused", from, to: input.to, reason: "transition_not_allowed" };
      }
      if (!holdsSwitchCapability(input.capability, input.pageId)) {
        return { kind: "refused", from, to: input.to, reason: "capability_required" };
      }
    }
    const updated = await tx.execute<{ modeChangedAt: Date | string }>(sql`
      update sync_pages
         set mode = ${input.to},
             mode_changed_at = clock_timestamp(),
             mode_changed_by = ${input.changedBy},
             legacy_imported_at = case when ${input.to} in ('off', 'shadow') then null else legacy_imported_at end,
             updated_at = clock_timestamp()
       where page_id = ${input.pageId}
      returning mode_changed_at as "modeChangedAt"
    `);
    return {
      kind: "changed",
      from,
      to: input.to,
      modeChangedAt: toRequiredDate(updated.rows[0]!.modeChangedAt),
    };
  });
}

// ── legacy fences (step 3) ────────────────────────────────────────────────────
//
// Step-3 design §3.1 (S3-01): while the Fansly Sync Engine owns a page —
// `handover` (the switch fences the legacy engine before the engine's first
// send) or `live` — no legacy component even tries to send for it. The legacy
// schedulers carry `legacyOwnsFanslyPageSql` next to their other gates and the
// legacy processes ask `isFanslyPageEngineOwned` /
// `listEngineOwnedFanslyPages`; the step-1 guard row (`owner_engine`, 0229)
// stays the catch-all at the wire. `off` and `shadow` fence nothing (J8). A
// page without a `sync_pages` row (OnlyFans, a Fansly page onboarded after the
// host last listed its pages) is legacy-owned by construction. Every check is
// evaluated per query, so leaving to `off` restores the legacy engine with no
// other action.

/** The modes in which the Fansly Sync Engine owns a page. */
export const ENGINE_OWNED_SYNC_PAGE_MODES = ["handover", "live"] as const satisfies readonly SyncPageMode[];
export type EngineOwnedSyncPageMode = (typeof ENGINE_OWNED_SYNC_PAGE_MODES)[number];

function isEngineOwnedMode(mode: SyncPageMode | null): mode is EngineOwnedSyncPageMode {
  return mode !== null && (ENGINE_OWNED_SYNC_PAGE_MODES as readonly string[]).includes(mode);
}

/** True while the Fansly Sync Engine owns the page (handover or live).
 *  `pageIdColumn` is a qualified column or a bound value; the subquery's own
 *  alias cannot shadow a caller's. */
export function engineOwnsFanslyPageSql(pageIdColumn: SQL): SQL {
  return sql`exists (
    select 1 from sync_pages engine_owned_page
     where engine_owned_page.page_id = ${pageIdColumn}
       and engine_owned_page.mode in ('handover', 'live')
  )`;
}

/** True unless the Fansly Sync Engine owns the page: the gate of every legacy
 *  scheduler query (OnlyFans pages and pages without a row pass). */
export function legacyOwnsFanslyPageSql(pageIdColumn: SQL): SQL {
  return sql`not ${engineOwnsFanslyPageSql(pageIdColumn)}`;
}

/** The pages the engine owns now, for the legacy processes' page lists. */
export async function listEngineOwnedFanslyPages(
  db: Database,
): Promise<Array<{ pageId: number; label: string; mode: EngineOwnedSyncPageMode }>> {
  const result = await db.execute<{ pageId: string | number; label: string; mode: EngineOwnedSyncPageMode }>(sql`
    select sp.page_id as "pageId", p.label, sp.mode
      from sync_pages sp
      join pages p on p.id = sp.page_id
     where sp.mode in ('handover', 'live')
     order by sp.page_id
  `);
  return result.rows.map((row) => ({ pageId: Number(row.pageId), label: row.label, mode: row.mode }));
}

/** Whether the engine owns this page now, and the page's mode (null without a
 *  `sync_pages` row). */
export async function isFanslyPageEngineOwned(
  db: Database,
  pageId: number,
): Promise<{ owned: boolean; mode: SyncPageMode | null }> {
  const result = await db.execute<{ mode: SyncPageMode }>(sql`
    select mode from sync_pages where page_id = ${pageId}
  `);
  const mode = result.rows[0]?.mode ?? null;
  return { owned: isEngineOwnedMode(mode), mode };
}

// ── the step-3 switch (design step 3 §3.5) ────────────────────────────────────

/**
 * The legacy import is complete (switch phase I, step 7): the host's live loop
 * starts only with it (J3). Written only in `handover`, with the switch
 * capability. False: the page is not in `handover`.
 */
export async function markSyncPageLegacyImported(
  db: Database,
  input: { pageId: number; capability: SyncSwitchCapability },
): Promise<boolean> {
  if (!holdsSwitchCapability(input.capability, input.pageId)) {
    throw new Error(`markSyncPageLegacyImported needs the switch capability of page ${input.pageId}`);
  }
  const result = await db.execute(sql`
    update sync_pages
       set legacy_imported_at = clock_timestamp(),
           updated_at = clock_timestamp()
     where page_id = ${input.pageId}
       and mode = 'handover'
  `);
  return (result.rowCount ?? 0) > 0;
}

/**
 * When the page's history requests open (`requests_enabled_at`, switch phase
 * C): one hour after the first switch, at once on later pages; null closes
 * them again (rollback step 4). Opening needs the switch capability and a
 * page in `live`; closing works in any mode. False: the page is not live (or
 * has no row).
 */
export async function setSyncRequestsEnabledAt(
  db: Database,
  input: { pageId: number; at: Date | null; capability: SyncSwitchCapability },
): Promise<boolean> {
  if (!holdsSwitchCapability(input.capability, input.pageId)) {
    throw new Error(`setSyncRequestsEnabledAt needs the switch capability of page ${input.pageId}`);
  }
  const result = input.at === null
    ? await db.execute(sql`
      update sync_pages
         set requests_enabled_at = null,
             updated_at = clock_timestamp()
       where page_id = ${input.pageId}
    `)
    : await db.execute(sql`
      update sync_pages
         set requests_enabled_at = ${input.at}::timestamptz,
             updated_at = clock_timestamp()
       where page_id = ${input.pageId}
         and mode = 'live'
    `);
  if ((result.rowCount ?? 0) === 0) return false;
  await db.execute(sql`select pg_notify('fansly_sync_work', ${String(input.pageId)})`);
  return true;
}

/**
 * The digest of the page's stored credentials the engine trusts
 * (`sync_pages.credentials_generation`, G1): written by the credentials and
 * proxy flows right after they stored what an identity check proved to be
 * this page's account (step-3 §3.5 item 6). A different trusted digest lifts
 * an auth/identity hold taken under another one (`activePageHold`). Not an
 * actor write (no generation fence); wakes the page's actor.
 */
export async function setSyncCredentialsGeneration(
  db: Database,
  input: { pageId: number; generation: string },
): Promise<boolean> {
  if (!/^[0-9a-f]{64}$/.test(input.generation)) {
    throw new Error("A credentials generation is a sha256 hex digest");
  }
  const result = await db.execute(sql`
    update sync_pages
       set credentials_generation = ${input.generation},
           updated_at = clock_timestamp()
     where page_id = ${input.pageId}
  `);
  if ((result.rowCount ?? 0) === 0) return false;
  await db.execute(sql`select pg_notify('fansly_sync_work', ${String(input.pageId)})`);
  return true;
}

// ── ownership ─────────────────────────────────────────────────────────────────

export interface LockedSyncPage {
  mode: SyncPageMode;
  /** `fansly_page_send_guards.owner_engine` (0229); null without a guard row,
   *  which closes the live gate like a `legacy` owner does. */
  ownerEngine: string | null;
}

/**
 * The generation fence every actor transaction starts with (I7): lock the
 * page row (`share` for an apply, `no_key_update` for an admission or a
 * capture) and refuse a foreign generation with `OwnershipLostError`. With
 * `live`, also the live gate (I17): the mode must be `live` and the step-1
 * guard row owned by the engine, else `LiveGateClosedError`.
 */
export async function lockOwnedPage(
  tx: Database,
  input: { pageId: number; generation: bigint; lock: "share" | "no_key_update"; live?: boolean },
): Promise<LockedSyncPage> {
  const lockClause = input.lock === "share" ? sql`for share of sp` : sql`for no key update of sp`;
  const result = await tx.execute<{ mode: SyncPageMode; ownerGeneration: string; ownerEngine: string | null }>(sql`
    select sp.mode,
           sp.owner_generation::text as "ownerGeneration",
           g.owner_engine as "ownerEngine"
      from sync_pages sp
      left join fansly_page_send_guards g on g.page_id = sp.page_id
     where sp.page_id = ${input.pageId}
     ${lockClause}
  `);
  const row = result.rows[0];
  if (!row) throw new OwnershipLostError(input.pageId, input.generation, null);
  const current = BigInt(row.ownerGeneration);
  if (current !== input.generation) throw new OwnershipLostError(input.pageId, input.generation, current);
  if (input.live === true) {
    if (row.mode !== "live") throw new LiveGateClosedError(input.pageId, "mode", row.mode, row.ownerEngine);
    if (row.ownerEngine !== SYNC_ENGINE_GUARD_OWNER) {
      throw new LiveGateClosedError(input.pageId, "guard_owner_engine", row.mode, row.ownerEngine);
    }
  }
  return { mode: row.mode, ownerEngine: row.ownerEngine };
}

/** How the previous owner was confirmed stopped (design §3.6 rules (a)–(e)). */
export type SyncOwnerStopEvidence =
  /** (a) the page was never owned. */
  | "never_owned"
  /** (b) the owner wrote its safe release after its last completion. */
  | "safe_release"
  /** (e) a deploy or an operator confirmed the owner's container is gone. */
  | "stop_confirmed"
  /** (c)/(d) an OS-level proof judged by the acquiring host. */
  | `os:${string}`;

export type AcquireSyncPageOwnershipResult =
  | { kind: "acquired"; generation: bigint; evidence: SyncOwnerStopEvidence; previous: SyncPageOwnerRecord }
  /** The previous owner is not confirmed stopped: nothing was written. */
  | { kind: "unconfirmed"; previous: SyncPageOwnerRecord }
  | { kind: "no_page" };

/**
 * Take the next owner generation of a page — the database half of the host's
 * acquire (design §3.6), run after the caller holds the session advisory lock
 * `(SYNC_PAGE_OWNERSHIP_LOCK_NAMESPACE, pageId)`. Under the row lock the
 * previous owner must be confirmed stopped by one of:
 *   (a) generation 0 (never owned);
 *   (b) a safe release of the current generation;
 *   (e) an operator/deploy confirmation newer than the current acquisition;
 *   (c)/(d) `judgePreviousOwner` — the caller's OS-level proof from its own
 *       host (the step-1 `judgeFanslySendHolderTermination`, which never
 *       judges this very process); null = no proof.
 * A lost database session alone is never a confirmation. On success the new
 * generation and this process's identity are written; the caller then computes
 * the takeover floor (`paceFloorFromDb`, I5).
 */
export async function acquireSyncPageOwnership(
  db: Database,
  input: {
    pageId: number;
    owner: FanslySendHolderIdentity;
    judgePreviousOwner?: (previous: SyncPageOwnerRecord) => string | null | Promise<string | null>;
  },
): Promise<AcquireSyncPageOwnershipResult> {
  return db.transaction(async (tx): Promise<AcquireSyncPageOwnershipResult> => {
    const locked = await tx.execute<PageSqlRow & { stopConfirmedAfterAcquire: boolean }>(sql`
      select ${pageColumns},
             coalesce(sp.owner_stop_confirmed_at > sp.owner_acquired_at,
                      sp.owner_stop_confirmed_at is not null) as "stopConfirmedAfterAcquire"
        from sync_pages sp
        left join pages p on p.id = sp.page_id
       where sp.page_id = ${input.pageId}
         for no key update of sp
    `);
    const row = locked.rows[0];
    if (!row) return { kind: "no_page" };
    const previous = ownerRecord(row);

    let evidence: SyncOwnerStopEvidence | null = null;
    if (previous.generation === 0n) {
      evidence = "never_owned";
    } else if (previous.releasedAt !== null && previous.releaseGeneration === previous.generation) {
      evidence = "safe_release";
    } else if (row.stopConfirmedAfterAcquire === true) {
      evidence = "stop_confirmed";
    } else if (input.judgePreviousOwner !== undefined) {
      const proof = await input.judgePreviousOwner(previous);
      if (proof !== null && proof.length > 0) evidence = `os:${proof}`;
    }
    if (evidence === null) return { kind: "unconfirmed", previous };

    const owner = input.owner;
    const updated = await tx.execute<{ generation: string }>(sql`
      update sync_pages
         set owner_generation = owner_generation + 1,
             owner_instance = ${owner.instance}::uuid,
             owner_host = ${owner.host},
             owner_pid = ${owner.pid},
             owner_pid_start = ${owner.pidStart},
             owner_pid_ns = ${owner.pidNs},
             owner_boot_id = ${owner.bootId},
             owner_acquired_at = clock_timestamp(),
             owner_heartbeat_at = clock_timestamp(),
             owner_released_at = null,
             owner_release_generation = null,
             updated_at = clock_timestamp()
       where page_id = ${input.pageId}
      returning owner_generation::text as generation
    `);
    return {
      kind: "acquired",
      generation: BigInt(updated.rows[0]!.generation),
      evidence,
      previous,
    };
  });
}

/** The owner's liveness mark (every 10 s). False: the generation no longer
 *  owns the page, or it released it already. */
export async function heartbeatSyncPageOwner(
  db: Database,
  input: { pageId: number; generation: bigint },
): Promise<boolean> {
  const result = await db.execute(sql`
    update sync_pages
       set owner_heartbeat_at = clock_timestamp()
     where page_id = ${input.pageId}
       and owner_generation = ${generationParam(input.generation)}
       and (owner_released_at is null or owner_release_generation is distinct from owner_generation)
  `);
  return (result.rowCount ?? 0) > 0;
}

/**
 * The safe release (rule (b)): written by the owner once nothing of its
 * generation is in flight — after SIGTERM, a mode change or the loss of its lock
 * session. The first release instant is kept. False: another generation owns
 * the page.
 */
export async function writeSafeRelease(
  db: Database,
  input: { pageId: number; generation: bigint },
): Promise<boolean> {
  const result = await db.execute(sql`
    update sync_pages
       set owner_released_at = case
             when owner_release_generation is not distinct from owner_generation
               then coalesce(owner_released_at, clock_timestamp())
             else clock_timestamp()
           end,
           owner_release_generation = owner_generation,
           updated_at = clock_timestamp()
     where page_id = ${input.pageId}
       and owner_generation = ${generationParam(input.generation)}
  `);
  return (result.rowCount ?? 0) > 0;
}

export interface ConfirmedSyncOwnerStop {
  pageId: number;
  pageLabel: string | null;
  generation: bigint;
  ownerHost: string | null;
  confirmed: boolean;
}

/**
 * Rule (e), `sync ownership confirm-stopped --running-hosts h1,h2`: a Docker-
 * level confirmation that every owner whose host is not among the hostnames of
 * the running containers (nor this process's own host) is gone with its
 * container. Owners that released safely need nothing and are skipped.
 * `dryRun` reports without writing.
 */
export async function confirmSyncOwnersStopped(
  db: Database,
  input: {
    runningHosts: readonly string[];
    ownHost: string;
    confirmedBy: string;
    dryRun: boolean;
    pageIds?: readonly number[];
    /** Only owners that acquired the page before this instant: the instant
     *  taken right before the running hostnames were listed, so an owner that
     *  started after the listing is never taken for a gone one. */
    acquiredBefore?: Date | null;
  },
): Promise<ConfirmedSyncOwnerStop[]> {
  const running = [...new Set([...input.runningHosts, input.ownHost].map((host) => host.trim()).filter(Boolean))];
  if (running.length < 2) {
    throw new Error("confirm-stopped needs the hostnames of the running containers (--running-hosts)");
  }
  if (input.confirmedBy.trim().length === 0) {
    throw new Error("confirm-stopped needs who confirms (confirmedBy)");
  }
  const pageFilter = input.pageIds === undefined
    ? sql``
    : sql`and sp.page_id = any(${sql.param(input.pageIds.map(String))}::bigint[])`;
  const acquiredFilter = input.acquiredBefore === undefined || input.acquiredBefore === null
    ? sql``
    : sql`and sp.owner_acquired_at < ${input.acquiredBefore}::timestamptz`;
  const candidates = sql`
    select sp.page_id
      from sync_pages sp
     where sp.owner_generation > 0
       and sp.owner_host is not null
       and not (sp.owner_host = any(${textArrayParam(running)}))
       and (sp.owner_released_at is null or sp.owner_release_generation is distinct from sp.owner_generation)
       and (sp.owner_stop_confirmed_at is null or sp.owner_acquired_at is null
            or sp.owner_stop_confirmed_at <= sp.owner_acquired_at)
       ${pageFilter}
       ${acquiredFilter}
  `;
  const result = input.dryRun
    ? await db.execute<{ pageId: string; pageLabel: string | null; generation: string; ownerHost: string | null }>(sql`
      select sp.page_id::text as "pageId", p.label as "pageLabel", sp.owner_generation::text as generation,
             sp.owner_host as "ownerHost"
        from sync_pages sp left join pages p on p.id = sp.page_id
       where sp.page_id in (${candidates})
       order by sp.page_id
    `)
    : await db.execute<{ pageId: string; pageLabel: string | null; generation: string; ownerHost: string | null }>(sql`
      with confirmed as (
        update sync_pages sp
           set owner_stop_confirmed_at = clock_timestamp(),
               owner_stop_confirmed_by = ${input.confirmedBy},
               updated_at = clock_timestamp()
         where sp.page_id in (${candidates})
        returning sp.page_id, sp.owner_generation, sp.owner_host
      )
      select c.page_id::text as "pageId", p.label as "pageLabel", c.owner_generation::text as generation,
             c.owner_host as "ownerHost"
        from confirmed c left join pages p on p.id = c.page_id
       order by c.page_id
    `);
  return result.rows.map((row) => ({
    pageId: Number(row.pageId),
    pageLabel: row.pageLabel,
    generation: BigInt(row.generation),
    ownerHost: row.ownerHost,
    confirmed: !input.dryRun,
  }));
}

// ── holds, pauses, overrides (§9, §10, §4.2) ─────────────────────────────────

function ownedPageFilter(generation: bigint | undefined) {
  return generation === undefined ? sql`` : sql`and owner_generation = ${generationParam(generation)}`;
}

async function assertOwnedWrite(
  db: Database,
  pageId: number,
  generation: bigint | undefined,
  rowCount: number | null | undefined,
): Promise<void> {
  if ((rowCount ?? 0) > 0) return;
  const current = await db.execute<{ generation: string }>(sql`
    select owner_generation::text as generation from sync_pages where page_id = ${pageId}
  `);
  const found = current.rows[0];
  throw new OwnershipLostError(pageId, generation ?? -1n, found ? BigInt(found.generation) : null);
}

/**
 * Hold the whole page (§9): every request of the page waits until `until`
 * (`'infinity'` for auth / identity holds, lifted by a new credentials
 * generation or the owner). `hold_since` keeps the start of an ongoing hold of
 * the same kind. With `generation`, fenced like every actor write.
 */
export async function setPageHold(
  db: Database,
  input: {
    pageId: number;
    generation?: bigint;
    kind: SyncPageHoldKind;
    until: Date | "infinity";
    step: number;
    detail?: Record<string, unknown>;
  },
): Promise<void> {
  if (!(SYNC_PAGE_HOLD_KINDS as readonly string[]).includes(input.kind)) {
    throw new Error(`Unknown Fansly sync page hold kind: ${String(input.kind)}`);
  }
  const until = input.until === "infinity" ? sql`'infinity'::timestamptz` : sql`${input.until}::timestamptz`;
  const result = await db.execute(sql`
    update sync_pages
       set hold_kind = ${input.kind},
           hold_until = ${until},
           hold_since = case when hold_kind = ${input.kind} and hold_until > clock_timestamp()
                             then coalesce(hold_since, clock_timestamp()) else clock_timestamp() end,
           hold_step = ${input.step},
           hold_detail = ${jsonParam(input.detail ?? {})},
           updated_at = clock_timestamp()
     where page_id = ${input.pageId}
       ${ownedPageFilter(input.generation)}
  `);
  await assertOwnedWrite(db, input.pageId, input.generation, result.rowCount);
}

/** Lift the page hold (the ladder step stays for the §9 decay rule). */
export async function clearPageHold(
  db: Database,
  input: { pageId: number; generation?: bigint; resetStep?: boolean },
): Promise<void> {
  const result = await db.execute(sql`
    update sync_pages
       set hold_kind = null,
           hold_until = null,
           hold_since = null,
           hold_step = case when ${input.resetStep === true} then 0 else hold_step end,
           hold_detail = '{}'::jsonb,
           updated_at = clock_timestamp()
     where page_id = ${input.pageId}
       ${ownedPageFilter(input.generation)}
  `);
  await assertOwnedWrite(db, input.pageId, input.generation, result.rowCount);
}

/**
 * The account the page's credentials answer for (`/account/me`, design §5.1):
 * `identity_account_id` and the instant it was read, and — G1 — the digest of
 * the stored credentials that request carried (`credentials_generation`: the
 * engine has now verified them). Written by the `account` resource's live
 * apply, fenced like every actor write.
 */
export async function recordSyncPageIdentity(
  db: Database,
  input: { pageId: number; generation: bigint; accountId: string; credentialsGeneration?: string | null },
): Promise<void> {
  if (input.accountId.length === 0) throw new Error("An identity account id is non-empty");
  const credentials = input.credentialsGeneration ?? null;
  const result = await db.execute(sql`
    update sync_pages
       set identity_account_id = ${input.accountId},
           identity_checked_at = clock_timestamp(),
           credentials_generation = coalesce(${credentials}::text, credentials_generation),
           updated_at = clock_timestamp()
     where page_id = ${input.pageId}
       ${ownedPageFilter(input.generation)}
  `);
  await assertOwnedWrite(db, input.pageId, input.generation, result.rowCount);
}

/** The consecutive network-failure count of §9 (3 ⇒ a `network` hold). */
export async function setNetworkFailureStreak(
  db: Database,
  input: { pageId: number; generation: bigint; streak: number },
): Promise<void> {
  const result = await db.execute(sql`
    update sync_pages
       set network_failure_streak = ${Math.max(0, Math.min(32_767, Math.trunc(input.streak)))},
           updated_at = clock_timestamp()
     where page_id = ${input.pageId}
       ${ownedPageFilter(input.generation)}
  `);
  await assertOwnedWrite(db, input.pageId, input.generation, result.rowCount);
}

/**
 * The §9 resource breaker of one resource file: `resource_holds[file] =
 * {until, step, since}`, or — with `kind: 'rate_limit_list'` — the list's own
 * 429 hold, which also keeps the instant of its newest 429; `hold: null` lifts
 * it. `since` carries over while the entry keeps its kind.
 */
export async function setResourceHold(
  db: Database,
  input: {
    pageId: number;
    generation?: bigint;
    file: string;
    hold: { until: Date; step: number; kind?: "rate_limit_list"; lastRateLimitAt?: Date } | null;
  },
): Promise<void> {
  if (!SYNC_RESOURCE_FILE_PATTERN.test(input.file)) {
    throw new Error(`Not a resource file: ${input.file}`);
  }
  const kind = input.hold?.kind ?? null;
  const value = input.hold === null
    ? sql`resource_holds - ${input.file}::text`
    : sql`jsonb_set(resource_holds, array[${input.file}::text], jsonb_strip_nulls(jsonb_build_object(
        'until', to_jsonb(${input.hold.until}::timestamptz),
        'step', ${input.hold.step}::int,
        'since', case when (resource_holds -> ${input.file}::text ->> 'kind') is not distinct from ${kind}::text
                      then coalesce(resource_holds -> ${input.file}::text -> 'since', to_jsonb(clock_timestamp()))
                      else to_jsonb(clock_timestamp()) end,
        'kind', ${kind}::text,
        'lastRateLimitAt', to_jsonb(${input.hold.lastRateLimitAt ?? null}::timestamptz))))`;
  const result = await db.execute(sql`
    update sync_pages
       set resource_holds = ${value},
           updated_at = clock_timestamp()
     where page_id = ${input.pageId}
       ${ownedPageFilter(input.generation)}
  `);
  await assertOwnedWrite(db, input.pageId, input.generation, result.rowCount);
}

/**
 * The owner's pauses (§10 "пауза ресурса / заявок / всей страницы"). Fields
 * left undefined keep their value; `resources` replaces the paused set. Wakes
 * the page's actor.
 */
export async function setPagePause(
  db: Database,
  input: {
    pageId: number;
    all?: boolean;
    requests?: boolean;
    resources?: readonly string[];
    note?: string | null;
  },
): Promise<SyncPageRow | null> {
  for (const resource of input.resources ?? []) {
    if (!SYNC_RESOURCE_KEY_PATTERN.test(resource)) throw new Error(`Not a resource key: ${resource}`);
  }
  const resources = input.resources === undefined ? null : [...new Set(input.resources)].sort();
  const result = await db.execute(sql`
    update sync_pages
       set paused_all = coalesce(${input.all ?? null}::boolean, paused_all),
           paused_requests = coalesce(${input.requests ?? null}::boolean, paused_requests),
           paused_resources = coalesce(${resources === null ? null : sql.param(resources)}::text[], paused_resources),
           pause_note = case when ${input.note !== undefined} then ${input.note ?? null}::text else pause_note end,
           updated_at = clock_timestamp()
     where page_id = ${input.pageId}
  `);
  if ((result.rowCount ?? 0) === 0) return null;
  await db.execute(sql`select pg_notify('fansly_sync_work', ${String(input.pageId)})`);
  return getSyncPage(db, input.pageId);
}

/**
 * Add keys to (`add`) and take keys out of (`remove`) a page's paused set in
 * one statement — the set's other keys are kept whatever another lever wrote
 * meanwhile (`setPagePause({resources})` REPLACES the set). A key in both
 * lists ends paused. Null: no row for the page.
 */
export async function adjustPausedResources(
  db: Database,
  input: { pageId: number; add?: readonly string[]; remove?: readonly string[]; note?: string | null },
): Promise<SyncPageRow | null> {
  const add = [...new Set(input.add ?? [])].sort();
  const remove = [...new Set(input.remove ?? [])].sort();
  for (const resource of [...add, ...remove]) {
    if (!SYNC_RESOURCE_KEY_PATTERN.test(resource)) throw new Error(`Not a resource key: ${resource}`);
  }
  const result = await db.execute(sql`
    update sync_pages
       set paused_resources = array(
             select distinct k
               from unnest(paused_resources || ${textArrayParam(add)}) as k
              where not (k = any(${textArrayParam(remove)})) or k = any(${textArrayParam(add)})
              order by k),
           pause_note = case when ${input.note !== undefined} then ${input.note ?? null}::text else pause_note end,
           updated_at = clock_timestamp()
     where page_id = ${input.pageId}
  `);
  if ((result.rowCount ?? 0) === 0) return null;
  await db.execute(sql`select pg_notify('fansly_sync_work', ${String(input.pageId)})`);
  return getSyncPage(db, input.pageId);
}

/** One age tier of a tiered walk's override: items up to `maxAgeDays` old
 *  (null: every older item) are due again `everyMs` after a visit. */
export interface SyncRegistryTierOverride {
  maxAgeDays: number | null;
  everyMs: number;
}

/**
 * `sync_pages.registry_overrides[key]` (design §4.2): a poll's period, or the
 * periods of a goal re-evaluated on a cadence (`everyMs` its incremental
 * re-check, `fullEveryMs` its full sweep; at least one), a tiered walk's age
 * tiers, or the key switched off for the page. Which key takes which shape is
 * the owner CLI's check against the registry.
 */
export type SyncRegistryOverride =
  | { everyMs: number; fullEveryMs?: number }
  | { fullEveryMs: number }
  | { tiers: readonly SyncRegistryTierOverride[] }
  | { enabled: false };

function assertPositiveMs(name: string, value: unknown): void {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`${name} must be a positive integer, received ${String(value)}`);
  }
}

function assertRegistryOverride(override: SyncRegistryOverride): void {
  if ("enabled" in override) return;
  if ("tiers" in override) {
    if (!Array.isArray(override.tiers) || override.tiers.length === 0) throw new Error("tiers must be a non-empty list");
    for (const tier of override.tiers) {
      assertPositiveMs("tiers[].everyMs", tier.everyMs);
      if (tier.maxAgeDays !== null) assertPositiveMs("tiers[].maxAgeDays", tier.maxAgeDays);
    }
    return;
  }
  if ("everyMs" in override) assertPositiveMs("everyMs", override.everyMs);
  if (override.fullEveryMs !== undefined) assertPositiveMs("fullEveryMs", override.fullEveryMs);
}

/** `registry_overrides[key]` for a page (§4.2); null removes the override.
 *  Owner-protected keys and the shape a key takes are the CLI's check. */
export async function setRegistryOverride(
  db: Database,
  input: { pageId: number; key: string; override: SyncRegistryOverride | null },
): Promise<boolean> {
  if (!SYNC_RESOURCE_KEY_PATTERN.test(input.key)) throw new Error(`Not a resource key: ${input.key}`);
  if (input.override !== null) assertRegistryOverride(input.override);
  const value = input.override === null
    ? sql`registry_overrides - ${input.key}::text`
    : sql`jsonb_set(registry_overrides, array[${input.key}::text], ${jsonParam(input.override)})`;
  const result = await db.execute(sql`
    update sync_pages
       set registry_overrides = ${value},
           updated_at = clock_timestamp()
     where page_id = ${input.pageId}
  `);
  if ((result.rowCount ?? 0) === 0) return false;
  await db.execute(sql`select pg_notify('fansly_sync_work', ${String(input.pageId)})`);
  return true;
}

/** The shadow WS feed's cursor (§3.12): only ever forward, under the
 *  generation of the page's shadow actor. */
export async function advanceWsRouterCursor(
  db: Database,
  input: { pageId: number; generation: bigint; cursor: number },
): Promise<void> {
  const result = await db.execute(sql`
    update sync_pages
       set ws_router_cursor = greatest(ws_router_cursor, ${input.cursor}::bigint),
           updated_at = clock_timestamp()
     where page_id = ${input.pageId}
       ${ownedPageFilter(input.generation)}
  `);
  await assertOwnedWrite(db, input.pageId, input.generation, result.rowCount);
}
