import { sql } from "drizzle-orm";

import type { Database } from "../../client.ts";
import {
  FANSLY_SEND_GUARD_RESTART_U,
  type FanslySendGuardOwnerEngine,
  type FanslySendHolderIdentity,
} from "../fansly-send-guard.ts";
import { mirrorSyncHoldsToLegacyColumns } from "./holds-legacy.ts";
import {
  normalizeSyncHoldRows,
  SYNC_PAGE_HOLD_KEY,
  SYNC_PAGE_HOLD_KINDS,
  SYNC_RESOURCE_HOLD_KIND,
  syncHoldsOfPageSql,
  type SyncHoldRow,
  type SyncPageHoldKind,
} from "./holds.ts";
import {
  generationParam,
  jsonParam,
  textArrayParam,
  toBigInt,
  toDate,
  toNumber,
  toRequiredDate,
  untilParam,
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
// Mode: `off ↔ shadow` is the owner's ordinary lever (`setSyncPageMode`). The
// one way to `live` is a page's birth: onboarding creates a new Fansly page's
// row live in the transaction that creates the page (`createLiveSyncPage`,
// step 4 S4-05). Nothing moves a page to `handover` or out of `live`: the
// step-3 switch and its rollback, with the capability that opened those
// transitions, are gone (step 4 S4-21). `handover` stays a value the CHECK
// admits and every reader still treats as "neither engine sends". Pinned by
// tests/sync-engine-repositories.test.ts (I17).

export const SYNC_PAGE_MODES = ["off", "shadow", "handover", "live"] as const;
export type SyncPageMode = (typeof SYNC_PAGE_MODES)[number];

/** Session advisory lock namespace of page ownership: (58215, pageId). */
export const SYNC_PAGE_OWNERSHIP_LOCK_NAMESPACE = 58_215;

/** The step-1 guard row's owner on the engine's side (0229). */
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
  /** The page's hold set (`sync_holds`): its own holds, its routes' and its
   *  resource files'. The engine's hold evaluator reads it
   *  (`apps/runtime/src/sync/engine/admission.ts`); nothing reads the old
   *  hold columns of the row. */
  holds: SyncHoldRow[];
  networkFailureStreak: number;
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
  /** Owner decision №8 (0235): DM exclusion reasons the engine no longer
   *  applies on this page (`sync excluded lift`). */
  liftedDmExclusions: string[];
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
  holds: Parameters<typeof normalizeSyncHoldRows>[0];
  networkFailureStreak: number;
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
  liftedDmExclusions: string[] | null;
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
  ${syncHoldsOfPageSql} as "holds",
  sp.network_failure_streak as "networkFailureStreak",
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
  sp.lifted_dm_exclusions as "liftedDmExclusions",
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
    holds: normalizeSyncHoldRows(row.holds),
    networkFailureStreak: Number(row.networkFailureStreak),
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
    liftedDmExclusions: row.liftedDmExclusions ?? [],
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

/** The transitions the owner makes (`sync page mode`): the only ones there
 *  are (I17). */
const OWNER_TRANSITIONS: ReadonlySet<string> = new Set(["off>shadow", "shadow>off"]);

export type SetSyncPageModeResult =
  | { kind: "changed"; from: SyncPageMode; to: SyncPageMode; modeChangedAt: Date }
  | { kind: "unchanged"; mode: SyncPageMode }
  | {
    kind: "refused";
    from: SyncPageMode | null;
    to: SyncPageMode;
    reason: "no_page" | "expected_mode_mismatch" | "transition_not_allowed";
  };

/**
 * Move a page between `off` and `shadow`, the only transitions there are
 * (I17): a page reaches `live` by `createLiveSyncPage` alone and never leaves
 * it, and nothing reaches `handover`. `expectFrom` makes the change
 * conditional on the current mode. Neither mode runs a live loop, so
 * `legacy_imported_at` (J3) is null after the change.
 */
export async function setSyncPageMode(
  db: Database,
  input: {
    pageId: number;
    to: SyncPageMode;
    changedBy: string;
    expectFrom?: SyncPageMode;
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
    if (!OWNER_TRANSITIONS.has(`${from}>${input.to}`)) {
      return { kind: "refused", from, to: input.to, reason: "transition_not_allowed" };
    }
    const updated = await tx.execute<{ modeChangedAt: Date | string }>(sql`
      update sync_pages
         set mode = ${input.to},
             mode_changed_at = clock_timestamp(),
             mode_changed_by = ${input.changedBy},
             legacy_imported_at = null,
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

// ── engine ownership (step 3) ────────────────────────────────────────────────
//
// The Fansly Sync Engine owns a page in `live` — and in `handover`, a mode
// nothing reaches since step 4 (S4-21) and no engine sends in. The legacy
// page-sync executor never reads these rows: it serves the platforms its
// registry declares (OnlyFans, `apps/runtime/src/sync/onlyfans/boundary.ts`)
// and its queries are scoped to them (`PageSyncPlatformScope`), so no fence
// on this table stands between it and a Fansly page any more. The step-1
// guard row (`owner_engine`, 0229) stays the catch-all at the wire.

/** The modes in which the Fansly Sync Engine owns a page. */
export const ENGINE_OWNED_SYNC_PAGE_MODES = ["handover", "live"] as const satisfies readonly SyncPageMode[];
export type EngineOwnedSyncPageMode = (typeof ENGINE_OWNED_SYNC_PAGE_MODES)[number];

function isEngineOwnedMode(mode: SyncPageMode | null): mode is EngineOwnedSyncPageMode {
  return mode !== null && (ENGINE_OWNED_SYNC_PAGE_MODES as readonly string[]).includes(mode);
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

// ── a new page, straight to live (step 4, S4-05) ─────────────────────────────

/** Why `createLiveSyncPage` refused a page: not a Fansly page, an engine row
 *  or a guard row it already has, or a footprint of the legacy engine — its
 *  stream states, its cursors, a request it journaled. */
export const LIVE_SYNC_PAGE_REFUSALS = [
  "no_fansly_page",
  "sync_page_exists",
  "send_guard_exists",
  "legacy_sync_states",
  "legacy_sync_cursors",
  "legacy_send_log",
] as const;
export type LiveSyncPageRefusal = (typeof LIVE_SYNC_PAGE_REFUSALS)[number];

/** A page `createLiveSyncPage` will not make live; nothing was written. */
export class LiveSyncPageRefusedError extends Error {
  readonly pageId: number;
  readonly reasons: readonly LiveSyncPageRefusal[];

  constructor(pageId: number, reasons: readonly LiveSyncPageRefusal[]) {
    super(`Fansly page ${pageId} cannot be created live on the Fansly Sync Engine (${reasons.join(", ")})`);
    this.name = "LiveSyncPageRefusedError";
    this.pageId = pageId;
    this.reasons = reasons;
  }
}

/**
 * Onboarding's way to `live` (step 4 S4-05, I17): run in the transaction that
 * creates the page, its credentials and its proxy, after the identity check
 * of exactly that session and proxy. The page is born the engine's — it is
 * never `off`, never the legacy engine's, and has nothing to import:
 *
 * - its `sync_pages` row in `live`, the legacy import stamped (there is no
 *   legacy state: J3 holds trivially), history requests open, the identity
 *   the check proved (`identity_account_id`, `identity_checked_at` = the
 *   check's send instant) and the digest of the stored credentials it proved
 *   as the engine's trusted one (`credentials_generation`, G1);
 * - its step-1 guard row owned by the engine (0229) and seeded as 0225 seeds
 *   one: the host's takeover floor (`paceFloorFromDb`, I5) puts the first send
 *   ≥ 1.2 × S after the page is acquired.
 *
 * Refused, writing nothing, for a page that is not a Fansly page or that has
 * an engine row, a guard row or any legacy footprint (`page_sync_states`,
 * `page_sync_cursors`, a `fansly_send_log` row of the page): such a page has
 * a past this capability does not import, and since step 4 (S4-21) nothing
 * else takes a page live.
 */
export async function createLiveSyncPage(
  tx: Database,
  input: {
    pageId: number;
    /** Who onboarded the page (`mode_changed_by`). */
    by: string;
    identityAccountId: string;
    identityCheckedAt: Date;
    credentialsGeneration: string;
  },
): Promise<void> {
  if (input.by.trim().length === 0) throw new Error("createLiveSyncPage needs who onboards the page (by)");
  if (input.identityAccountId.length === 0) throw new Error("An identity account id is non-empty");
  if (!/^[0-9a-f]{64}$/.test(input.credentialsGeneration)) {
    throw new Error("A credentials generation is a sha256 hex digest");
  }
  const found = await tx.execute<{
    syncPage: boolean;
    sendGuard: boolean;
    syncStates: boolean;
    syncCursors: boolean;
    sendLog: boolean;
  }>(sql`
    select exists (select 1 from sync_pages sp where sp.page_id = p.id) as "syncPage",
           exists (select 1 from fansly_page_send_guards g where g.page_id = p.id) as "sendGuard",
           exists (select 1 from page_sync_states st where st.page_id = p.id) as "syncStates",
           exists (select 1 from page_sync_cursors c where c.page_id = p.id) as "syncCursors",
           exists (select 1 from fansly_send_log l where l.page_id = p.id) as "sendLog"
      from pages p
     where p.id = ${input.pageId}
       and p.platform = 'fansly'
     for no key update of p
  `);
  const footprint = found.rows[0];
  if (footprint === undefined) throw new LiveSyncPageRefusedError(input.pageId, ["no_fansly_page"]);
  const reasons: LiveSyncPageRefusal[] = [];
  if (footprint.syncPage) reasons.push("sync_page_exists");
  if (footprint.sendGuard) reasons.push("send_guard_exists");
  if (footprint.syncStates) reasons.push("legacy_sync_states");
  if (footprint.syncCursors) reasons.push("legacy_sync_cursors");
  if (footprint.sendLog) reasons.push("legacy_send_log");
  if (reasons.length > 0) throw new LiveSyncPageRefusedError(input.pageId, reasons);

  const row = await tx.execute(sql`
    insert into sync_pages (
      page_id, mode, mode_changed_at, mode_changed_by, legacy_imported_at, requests_enabled_at,
      identity_account_id, identity_checked_at, credentials_generation
    ) values (
      ${input.pageId}, 'live', clock_timestamp(), ${input.by}, clock_timestamp(), clock_timestamp(),
      ${input.identityAccountId}, ${input.identityCheckedAt}::timestamptz, ${input.credentialsGeneration}
    )
    on conflict (page_id) do nothing
  `);
  if ((row.rowCount ?? 0) === 0) throw new LiveSyncPageRefusedError(input.pageId, ["sync_page_exists"]);
  const guard = await tx.execute(sql`
    insert into fansly_page_send_guards (page_id, last_completed_at, next_u, owner_engine, engine_switched_at, updated_at)
    values (${input.pageId}, clock_timestamp(), ${FANSLY_SEND_GUARD_RESTART_U}, ${SYNC_ENGINE_GUARD_OWNER},
            clock_timestamp(), clock_timestamp())
    on conflict (page_id) do nothing
  `);
  if ((guard.rowCount ?? 0) === 0) throw new LiveSyncPageRefusedError(input.pageId, ["send_guard_exists"]);
}

/**
 * The session and proxy rows of a page's stored-credentials digest
 * (`readFanslyPageGeneration`), locked for a save the engine will trust (step
 * 3b ruling 5: the candidate save is a CAS on the exact verified
 * session+proxy pair): no other writer changes either half until the save
 * commits. The engine row first — the lock order of every actor transaction —
 * so an apply that writes the page between them never waits in a cycle with
 * the save; the page row itself is not locked (the WS capture holds it FOR
 * SHARE before the session rows; the trusted digest is read at the save's end
 * either way).
 */
export async function lockFanslyCredentialsForSave(db: Database, pageId: number): Promise<void> {
  await db.execute(sql`select sp.page_id from sync_pages sp where sp.page_id = ${pageId} for no key update`);
  await db.execute(sql`select c.platform_account_id from page_credentials c where c.platform_account_id = ${pageId} for update`);
  await db.execute(sql`select e.id from egress_endpoints e where e.platform_account_id = ${pageId} for update`);
}

/**
 * The engine trusts the page's stored credentials (`credentials_generation`,
 * G1): written by the credentials and proxy flows in the transaction that
 * stored the pair an identity check proved to be this page's account
 * (`lockFanslyCredentialsForSave` first). `verifiedAt` is when that check was
 * sent: `identity_checked_at` keeps the newest proof's send instant, so an
 * older answer applied late never overwrites it (`recordSyncPageIdentityProof`).
 * Trusting a digest lifts no hold: a credentials hold clears only by the
 * apply of a proof sent after its latest refusal — the verify of the new
 * digest, which runs under the hold (A3). Not an actor write (no generation
 * fence); wakes the page's actor.
 */
export async function trustSyncPageCredentials(
  db: Database,
  input: { pageId: number; generation: string; accountId: string; verifiedAt: Date },
): Promise<boolean> {
  if (!/^[0-9a-f]{64}$/.test(input.generation)) {
    throw new Error("A credentials generation is a sha256 hex digest");
  }
  if (input.accountId.length === 0) throw new Error("An identity account id is non-empty");
  const result = await db.execute(sql`
    update sync_pages
       set credentials_generation = ${input.generation},
           identity_account_id = ${input.accountId},
           identity_checked_at = greatest(identity_checked_at, ${input.verifiedAt}::timestamptz),
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
 * The fence of a hold write: the page row FOR NO KEY UPDATE — the lock every
 * actor transaction starts with (`lockOwnedPage`), taken again here so a
 * writer outside one (the owner's `sync route raise`, a test) orders itself
 * with them, the page row before its hold rows — and, with `generation`, the
 * generation that owns it (`OwnershipLostError` otherwise).
 */
async function lockPageForHoldWrite(tx: Database, pageId: number, generation: bigint | undefined): Promise<void> {
  const result = await tx.execute<{ generation: string }>(sql`
    select owner_generation::text as generation from sync_pages where page_id = ${pageId} for no key update
  `);
  const found = result.rows[0];
  if (generation !== undefined) {
    const current = found === undefined ? null : BigInt(found.generation);
    if (current !== generation) throw new OwnershipLostError(pageId, generation, current);
  } else if (found === undefined) {
    throw new Error(`Fansly sync page ${pageId} has no sync_pages row: nothing to hold`);
  }
}

/**
 * One write of a page's hold set: the fence, the rows, then — for the
 * rollback's sake, until the next release takes the mirror away — the old
 * hold columns rewritten from the rows (`mirrorSyncHoldsToLegacyColumns`),
 * all in one transaction (a savepoint inside the caller's), so the two never
 * part. The rows are the page's state: nothing reads the columns back,
 * neither here nor when the page's ownership is acquired — the image before
 * this one keeps the two sides equal itself, so the way back from a rollback
 * to it finds the rows current.
 */
async function writeHoldSet<T>(
  db: Database,
  input: { pageId: number; generation?: bigint },
  write: (tx: Database) => Promise<T>,
): Promise<T> {
  return db.transaction(async (raw) => {
    const tx = raw as unknown as Database;
    await lockPageForHoldWrite(tx, input.pageId, input.generation);
    const written = await write(tx);
    await mirrorSyncHoldsToLegacyColumns(tx, input.pageId);
    return written;
  });
}

/**
 * Hold the whole page (§9): every request of the page waits until `until`
 * (`'infinity'` for auth / identity holds, which only an identity proof sent
 * after their latest refusal clears — the shared page-hold core decides).
 * A page holds one credentials hold (a refusal of the other kind replaces the
 * row) and, beside it, one network hold. `since` keeps the start of the
 * episode: a credentials refusal over a credentials hold, a network hold
 * retaken while it is in force. With `generation`, fenced like every actor
 * write.
 */
export async function setPageHold(
  db: Database,
  input: {
    pageId: number;
    generation?: bigint;
    kind: SyncPageHoldKind;
    until: Date | "infinity";
    detail?: Record<string, unknown>;
  },
): Promise<void> {
  if (!(SYNC_PAGE_HOLD_KINDS as readonly string[]).includes(input.kind)) {
    throw new Error(`Unknown Fansly sync page hold kind: ${String(input.kind)}`);
  }
  const until = untilParam(input.until);
  const detail = jsonParam(input.detail ?? {});
  // The rows this hold continues: its own, or — a credentials hold — the
  // page's credentials hold whatever its kind.
  const family = input.kind === "network" ? [input.kind] : SYNC_PAGE_HOLD_KINDS.filter((kind) => kind !== "network");
  await writeHoldSet(db, input, async (tx) => {
    const updated = await tx.execute(sql`
      update sync_holds
         set kind = ${input.kind},
             until = ${until},
             since = case when until > clock_timestamp() then since else clock_timestamp() end,
             detail = ${detail},
             revision = revision + 1,
             updated_at = clock_timestamp()
       where page_id = ${input.pageId}
         and scope = 'page'
         and key = ${SYNC_PAGE_HOLD_KEY}
         and kind = any(${textArrayParam(family)})
    `);
    if ((updated.rowCount ?? 0) > 0) return;
    await tx.execute(sql`
      insert into sync_holds (page_id, scope, key, kind, until, detail)
      values (${input.pageId}, 'page', ${SYNC_PAGE_HOLD_KEY}, ${input.kind}, ${until}, ${detail})
    `);
  });
}

/** Lift the page's holds of `kinds` (an identity proof lifts the credentials
 *  hold and leaves a network hold standing; an answer lifts what has ended). */
export async function clearPageHold(
  db: Database,
  input: { pageId: number; generation?: bigint; kinds: readonly SyncPageHoldKind[] },
): Promise<void> {
  await writeHoldSet(db, input, async (tx) => {
    await tx.execute(sql`
      delete from sync_holds
       where page_id = ${input.pageId}
         and scope = 'page'
         and key = ${SYNC_PAGE_HOLD_KEY}
         and kind = any(${textArrayParam(input.kinds)})
    `);
  });
}

/**
 * An identity proof (design §5.1, step 3b ruling 5): an applied `/account/me`
 * answer of the page's own account — `identity_account_id`, and — G1 — the
 * digest of the stored credentials that request carried
 * (`credentials_generation`: the engine has now verified them), written in
 * the apply's own transaction. `identity_checked_at` is the proof's send
 * instant; a proof sent before the newest recorded one (an answer applied
 * late) writes nothing. True: recorded. Fenced like every actor write.
 */
export async function recordSyncPageIdentityProof(
  db: Database,
  input: { pageId: number; generation: bigint; accountId: string; credentialsGeneration: string | null; sentAt: Date },
): Promise<boolean> {
  if (input.accountId.length === 0) throw new Error("An identity account id is non-empty");
  const newer = sql`(identity_checked_at is null or identity_checked_at <= ${input.sentAt}::timestamptz)`;
  const result = await db.execute<{ recorded: boolean }>(sql`
    update sync_pages
       set identity_account_id = case when ${newer} then ${input.accountId} else identity_account_id end,
           credentials_generation = case when ${newer}
                                         then coalesce(${input.credentialsGeneration}::text, credentials_generation)
                                         else credentials_generation end,
           identity_checked_at = case when ${newer} then ${input.sentAt}::timestamptz else identity_checked_at end,
           updated_at = clock_timestamp()
     where page_id = ${input.pageId}
       ${ownedPageFilter(input.generation)}
    returning identity_checked_at = ${input.sentAt}::timestamptz as recorded
  `);
  await assertOwnedWrite(db, input.pageId, input.generation, result.rowCount);
  return result.rows[0]?.recorded === true;
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
 * The §9 resource breaker of one resource file (`sync_holds`, scope
 * `resource`): held until `until` on ladder step `step`; `hold: null` lifts
 * it. `since` carries over while the row stays.
 */
export async function setResourceHold(
  db: Database,
  input: {
    pageId: number;
    generation?: bigint;
    file: string;
    hold: { until: Date; step: number } | null;
  },
): Promise<void> {
  if (!SYNC_RESOURCE_FILE_PATTERN.test(input.file)) {
    throw new Error(`Not a resource file: ${input.file}`);
  }
  const { hold } = input;
  await writeHoldSet(db, input, async (tx) => {
    if (hold === null) {
      await tx.execute(sql`
        delete from sync_holds
         where page_id = ${input.pageId} and scope = 'resource' and key = ${input.file} and kind = ${SYNC_RESOURCE_HOLD_KIND}
      `);
      return;
    }
    await tx.execute(sql`
      insert into sync_holds (page_id, scope, key, kind, until, ladder_step)
      values (${input.pageId}, 'resource', ${input.file}, ${SYNC_RESOURCE_HOLD_KIND}, ${hold.until}::timestamptz, ${hold.step}::int)
      on conflict (page_id, scope, key, kind) do update
        set until = excluded.until,
            ladder_step = excluded.ladder_step,
            revision = sync_holds.revision + 1,
            updated_at = clock_timestamp()
    `);
  });
}

/** One route of a page as the route-hold code writes it
 *  (`apps/runtime/src/sync/engine/route-holds.ts`); the writer stamps its
 *  revision. */
export interface SyncRouteStateEntryWrite {
  holdUntil: Date | null;
  ladderStep: number;
  effectivePerMin: number | null;
  policyVersion: string | null;
  last429AttemptId: number | null;
  last429At: Date | null;
}

export type WriteSyncRouteStateResult =
  | { kind: "written"; revision: number }
  /** The route's revision is not `expectRevision` (a newer 429 or raise):
   *  nothing was written. */
  | { kind: "stale" };

/**
 * Write one route of a page's hold set — its two rows have no other writer:
 * `route_budget`, the route's durable state (the ladder step of its next 429,
 * its slowdown and newest 429, its revision), and `route_hold`, the end of
 * the hold a 429 (or a 5xx's `Retry-After`) put on it (no row without one).
 * A compare-and-set on the state's revision (`expectRevision`: 0 for a route
 * without one): it is written with `expectRevision + 1`. With `generation`,
 * fenced like every actor write (a lost generation throws
 * `OwnershipLostError`); without it (the owner's `sync route raise`) the
 * revision alone orders the writers.
 */
export async function writeSyncRouteState(
  db: Database,
  input: {
    pageId: number;
    generation?: bigint;
    route: string;
    expectRevision: number;
    entry: SyncRouteStateEntryWrite;
  },
): Promise<WriteSyncRouteStateResult> {
  if (!Number.isSafeInteger(input.expectRevision) || input.expectRevision < 0) {
    throw new Error(`A route state revision is a count (got ${input.expectRevision})`);
  }
  if (input.route.length === 0) throw new Error("A route state names its route");
  const revision = input.expectRevision + 1;
  const { entry } = input;
  const state = {
    effectivePerMin: entry.effectivePerMin,
    policyVersion: entry.policyVersion,
    last429AttemptId: entry.last429AttemptId,
    last429At: entry.last429At?.toISOString() ?? null,
  };
  return writeHoldSet(db, input, async (tx): Promise<WriteSyncRouteStateResult> => {
    const route = sql`page_id = ${input.pageId} and scope = 'route' and key = ${input.route}`;
    const current = await tx.execute<{ revision: string }>(sql`
      select revision::text as revision from sync_holds where ${route} and kind = 'route_budget'
    `);
    if (Number(current.rows[0]?.revision ?? 0) !== input.expectRevision) return { kind: "stale" };
    await tx.execute(sql`
      insert into sync_holds (page_id, scope, key, kind, ladder_step, detail, revision)
      values (${input.pageId}, 'route', ${input.route}, 'route_budget', ${entry.ladderStep}::int, ${jsonParam(state)}, ${revision})
      on conflict (page_id, scope, key, kind) do update
        set ladder_step = excluded.ladder_step,
            detail = excluded.detail,
            revision = excluded.revision,
            updated_at = clock_timestamp()
    `);
    if (entry.holdUntil === null) {
      await tx.execute(sql`delete from sync_holds where ${route} and kind = 'route_hold'`);
    } else {
      await tx.execute(sql`
        insert into sync_holds (page_id, scope, key, kind, until)
        values (${input.pageId}, 'route', ${input.route}, 'route_hold', ${entry.holdUntil}::timestamptz)
        on conflict (page_id, scope, key, kind) do update
          set until = excluded.until,
              since = case when sync_holds.until > clock_timestamp() then sync_holds.since else clock_timestamp() end,
              revision = sync_holds.revision + 1,
              updated_at = clock_timestamp()
         where sync_holds.until is distinct from excluded.until
      `);
    }
    return { kind: "written", revision };
  });
}

/**
 * Owner decision №8 (0235): add `reason` to a LIVE page's lifted DM
 * exclusions (idempotent), locking the page row as the actor's commits do
 * (`for no key update`) — it waits for an apply of the page's actor in
 * flight, so the next list apply reads the new list. Null:
 * the page is not live (nothing written). The caller clears the reason from
 * the page's threads in the same transaction (`liftSyncDmExclusion`).
 */
export async function addSyncPageLiftedDmExclusion(
  db: Database,
  input: { pageId: number; reason: string },
): Promise<{ lifted: string[]; added: boolean } | null> {
  const result = await db.execute<{ lifted: string[] | null; added: boolean }>(sql`
    with before as (
      select sp.page_id, sp.lifted_dm_exclusions as lifted
        from sync_pages sp
       where sp.page_id = ${input.pageId} and sp.mode = 'live'
       for no key update
    )
    update sync_pages sp
       set lifted_dm_exclusions = case
             when ${input.reason}::text = any(before.lifted) then before.lifted
             else array_append(before.lifted, ${input.reason}::text) end,
           updated_at = clock_timestamp()
      from before
     where sp.page_id = before.page_id
    returning sp.lifted_dm_exclusions as lifted, not (${input.reason}::text = any(before.lifted)) as added
  `);
  const row = result.rows[0];
  return row === undefined ? null : { lifted: row.lifted ?? [], added: row.added === true };
}

/** Take `reason` off a page's lifted DM exclusions, in any mode. Null: no
 *  row for the page. */
export async function removeSyncPageLiftedDmExclusion(
  db: Database,
  input: { pageId: number; reason: string },
): Promise<{ lifted: string[]; removed: boolean; mode: SyncPageMode } | null> {
  const result = await db.execute<{ lifted: string[] | null; removed: boolean; mode: SyncPageMode }>(sql`
    with before as (
      select sp.page_id, sp.lifted_dm_exclusions as lifted
        from sync_pages sp
       where sp.page_id = ${input.pageId}
       for no key update
    )
    update sync_pages sp
       set lifted_dm_exclusions = array_remove(before.lifted, ${input.reason}::text),
           updated_at = clock_timestamp()
      from before
     where sp.page_id = before.page_id
    returning sp.lifted_dm_exclusions as lifted, (${input.reason}::text = any(before.lifted)) as removed, sp.mode
  `);
  const row = result.rows[0];
  return row === undefined ? null : { lifted: row.lifted ?? [], removed: row.removed === true, mode: row.mode };
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
