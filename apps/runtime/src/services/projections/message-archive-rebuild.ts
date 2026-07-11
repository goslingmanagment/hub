// W10 (decision #134): the message-archive SHADOW rebuild — the sanctioned
// replacement for the lossy delete+replay rebuild. Staged machinery:
//   R0 preflight  — per-account census + detached-partition census
//   R1 build      — legacy-seed LIFT + event replay from seq 0 + backfill
//                   re-run, all into message_archive_shadow, behind a HARD
//                   detached-partition gate
//   R2 verify     — set-difference fidelity proof (shadow ⊇ old) + material
//                   comparison; nonzero missing rows fails
//   R3 switch     — one-transaction atomic rename + watermark force-reset
// The build spec rejected in-place rebuild and hash-equality-as-proof
// (docs/fastreply-freshness-build-spec.md); operational ritual lives in
// docs/runbooks/message-archive-rebuild.md.

import {
  MESSAGE_ARCHIVE_REBUILD_LOCK_KEY,
  MESSAGE_ARCHIVE_SHADOW_PROJECTION,
  backfillArchiveFromDmMessageArchive,
  backfillArchiveFromHotTable,
  clearMessageArchiveShadowAccount,
  applyMessageEventsToArchive,
  countArchiveCoverageGaps,
  getArchiveRebuildAccountCensus,
  getArchiveShadowVerifyCounts,
  getPageTransactionsWriterInfo,
  liftLegacySeedRowsToShadow,
  listArchiveAccounts,
  listArchiveShadowDiffSample,
  listArchiveShadowMissingSample,
  listDetachedPartitionsHoldingAccount,
  listDomainEventPartitionCensus,
  listEventAccounts,
  listEventsSince,
  setProjectionWatermark,
  switchMessageArchiveShadowTables,
  type ArchiveRebuildAccountCensus,
  type ArchiveShadowDiffRow,
  type ArchiveShadowVerifyCounts,
  type Database,
  type DetachedDomainEventPartition,
} from "@agency_hub_core/db";
import { normalizeDmMessageText } from "@agency_hub_core/shared";
import { sql } from "drizzle-orm";

import type { AppContext } from "../../bootstrap.ts";
import { MESSAGE_EVENT_TYPES } from "./message-archive.ts";

const EVENT_PAGE_SIZE = 500;

/** Rebuild scope: accounts with events ∪ accounts with archive rows —
 * legacy seeds can exist for accounts the event ledger never saw. */
async function listRebuildAccounts(db: Database, accountId?: number | null) {
  if (accountId != null) {
    return [accountId];
  }
  const merged = new Set<number>([
    ...(await listEventAccounts(db)),
    ...(await listArchiveAccounts(db)),
  ]);
  return [...merged].sort((a, b) => a - b);
}

// ── R0: preflight ──────────────────────────────────────────────────────────

export interface ArchiveRebuildPreflightResult {
  accounts: Array<ArchiveRebuildAccountCensus & {
    platform: string | null;
    detachedPartitionsHoldingEvents: Array<{ schema: string; name: string; rows: number }>;
  }>;
  partitions: {
    attached: string[];
    detached: DetachedDomainEventPartition[];
  };
}

export async function runArchiveRebuildPreflight(
  app: Pick<AppContext, "db" | "logger">,
  input?: { accountId?: number | null },
): Promise<ArchiveRebuildPreflightResult> {
  const partitions = await listDomainEventPartitionCensus(app.db);
  const accounts = await listRebuildAccounts(app.db, input?.accountId);
  const results: ArchiveRebuildPreflightResult["accounts"] = [];
  for (const accountId of accounts) {
    const census = await getArchiveRebuildAccountCensus(app.db, accountId);
    const page = await getPageTransactionsWriterInfo(app.db, accountId);
    const detached = await listDetachedPartitionsHoldingAccount(app.db, accountId);
    results.push({
      ...census,
      platform: page?.platform ?? null,
      detachedPartitionsHoldingEvents: detached,
    });
  }
  return { accounts: results, partitions };
}

// ── R1: shadow build ───────────────────────────────────────────────────────

export interface ShadowBuildAccountResult {
  accountId: number;
  platform: string | null;
  lifted: number;
  eventsSeen: number;
  inserted: number;
  tombstoned: number;
  archiveBatches: number;
  hotBatches: number;
  /** The replay's high seq — becomes the live watermark at switch. */
  highSeq: number;
  /** True when the page no longer resolves a platform: legacy seeds are
   * still lifted, the replay is skipped (matching the live sweep, which
   * parks such accounts — their events project nowhere today either). */
  replaySkipped: boolean;
}

export interface ShadowBuildResult {
  accounts: number;
  results: ShadowBuildAccountResult[];
}

class DetachedPartitionGateError extends Error {
  constructor(accountId: number, holding: Array<{ schema: string; name: string; rows: number }>) {
    super(
      `shadow build HARD-REFUSED for account ${accountId}: detached domain_events partition(s) hold `
        + `${holding.map((p) => `${p.schema}.${p.name} (${p.rows} rows)`).join(", ")} — the replay `
        + "cannot see their seqs and would silently drop them. Re-attach via the Stage 28.3 "
        + "restore path (tiering:restore-drill) first.",
    );
    this.name = "DetachedPartitionGateError";
  }
}

/**
 * Builds one account's slice of message_archive_shadow inside ONE
 * transaction (restartable: re-runs clear the account scope first). Order is
 * deliberate: LIFT before replay so the lifted legacy rows keep exactly the
 * precedence they have in the live table (the replay's conflict arm only
 * hydrates content_pending stubs). The detached-partition gate runs at START
 * and again at END — a tiering detach committing mid-build aborts the whole
 * account transaction instead of shipping a silently short replay.
 */
async function buildShadowForAccount(
  app: Pick<AppContext, "db" | "logger">,
  accountId: number,
): Promise<ShadowBuildAccountResult> {
  return app.db.transaction(async (tx) => {
    const db = tx as unknown as Database;
    await db.execute(sql`select pg_advisory_xact_lock(${MESSAGE_ARCHIVE_REBUILD_LOCK_KEY})`);

    const gateAtStart = await listDetachedPartitionsHoldingAccount(db, accountId);
    if (gateAtStart.length > 0) {
      throw new DetachedPartitionGateError(accountId, gateAtStart);
    }

    await clearMessageArchiveShadowAccount(db, accountId);
    const lifted = await liftLegacySeedRowsToShadow(db, { accountId });

    const page = await getPageTransactionsWriterInfo(db, accountId);
    const platform = page?.platform ?? null;
    let eventsSeen = 0;
    let inserted = 0;
    let tombstoned = 0;
    let watermark = 0;
    let replayed = false;
    if (platform !== null) {
      replayed = true;
      for (;;) {
        const events = await listEventsSince(db, {
          accountId,
          afterSeq: watermark,
          limit: EVENT_PAGE_SIZE,
        });
        if (events.length === 0) {
          break;
        }
        eventsSeen += events.length;
        const messageEvents = events
          .filter((event) => MESSAGE_EVENT_TYPES.has(event.type))
          .map((event) => ({
            id: event.id,
            accountSeq: event.accountSeq,
            type: event.type,
            occurredAt: event.occurredAt,
            fanIdentityRef: event.fanIdentityRef,
            conversationRef: event.conversationRef,
            messageRef: event.messageRef,
            data: event.data,
          }));
        const applied = await applyMessageEventsToArchive(db, {
          accountId,
          platform,
          events: messageEvents,
          targetTable: "message_archive_shadow",
        });
        inserted += applied.inserted;
        tombstoned += applied.tombstoned;
        watermark = events[events.length - 1]!.accountSeq;
        if (events.length < EVENT_PAGE_SIZE) {
          break;
        }
      }
    }

    // Backfill re-run, account-scoped, into the shadow. Same idempotent
    // writers as Stage 10 — they only insert new keys or hydrate stubs, so
    // lifted rows and replayed content stay untouched.
    let archiveBatches = 0;
    let afterId: number | null = 0;
    while (afterId !== null) {
      const step: { lastId: number | null } = await backfillArchiveFromDmMessageArchive(db, {
        afterId,
        accountId,
        targetTable: "message_archive_shadow",
      });
      afterId = step.lastId;
      if (afterId !== null) {
        archiveBatches += 1;
      }
    }
    let hotBatches = 0;
    afterId = 0;
    while (afterId !== null) {
      const step: { lastId: number | null } = await backfillArchiveFromHotTable(db, {
        afterId,
        accountId,
        targetTable: "message_archive_shadow",
      });
      afterId = step.lastId;
      if (afterId !== null) {
        hotBatches += 1;
      }
    }

    const gateAtEnd = await listDetachedPartitionsHoldingAccount(db, accountId);
    if (gateAtEnd.length > 0) {
      throw new DetachedPartitionGateError(accountId, gateAtEnd);
    }

    await setProjectionWatermark(db, MESSAGE_ARCHIVE_SHADOW_PROJECTION, accountId, watermark);

    return {
      accountId,
      platform,
      lifted,
      eventsSeen,
      inserted,
      tombstoned,
      archiveBatches,
      hotBatches,
      highSeq: watermark,
      replaySkipped: !replayed,
    };
  });
}

export async function buildMessageArchiveShadow(
  app: Pick<AppContext, "db" | "logger">,
  input?: { accountId?: number | null },
): Promise<ShadowBuildResult> {
  const accounts = await listRebuildAccounts(app.db, input?.accountId);
  const results: ShadowBuildAccountResult[] = [];
  for (const accountId of accounts) {
    const result = await buildShadowForAccount(app, accountId);
    app.logger.info({ ...result }, "Message-archive shadow build: account complete");
    results.push(result);
  }
  return { accounts: results.length, results };
}

// ── R2: fidelity proof ─────────────────────────────────────────────────────

export interface ShadowVerifyResult extends ArchiveShadowVerifyCounts {
  /** The proof: zero old rows without a shadow counterpart. */
  ok: boolean;
  missingSample: Awaited<ReturnType<typeof listArchiveShadowMissingSample>>;
  /** Material diffs, each annotated: healedHtml=true means the old text is
   * the shadow text before HTML stripping — the EXPECTED A51 healing, not a
   * fidelity loss. */
  diffSample: Array<ArchiveShadowDiffRow & { healedHtml: boolean }>;
  /** Stage 28 prune-gate question asked of the SHADOW: conversations whose
   * hot messages it does not fully cover (informational pre-switch). */
  shadowCoverageGaps: number;
}

export async function verifyMessageArchiveShadow(
  app: Pick<AppContext, "db" | "logger">,
  input?: { accountId?: number | null; sampleLimit?: number },
): Promise<ShadowVerifyResult> {
  const sampleLimit = input?.sampleLimit ?? 20;
  const accountId = input?.accountId ?? null;
  const counts = await getArchiveShadowVerifyCounts(app.db, { accountId });
  const missingSample = counts.missing > 0
    ? await listArchiveShadowMissingSample(app.db, { accountId, limit: sampleLimit })
    : [];
  const rawDiffs = await listArchiveShadowDiffSample(app.db, {
    accountId,
    limit: sampleLimit,
  });
  const diffSample = rawDiffs.map((diff) => ({
    ...diff,
    healedHtml: diff.old.textPlain !== diff.shadow.textPlain
      && normalizeDmMessageText(diff.old.textPlain) === diff.shadow.textPlain,
  }));
  const shadowCoverageGaps = await countArchiveCoverageGaps(app.db, "message_archive_shadow");
  return {
    ...counts,
    ok: counts.missing === 0,
    missingSample,
    diffSample,
    shadowCoverageGaps,
  };
}

// ── R3: atomic switch ──────────────────────────────────────────────────────

export interface ShadowSwitchPlan {
  missing: number;
  oldRows: number;
  shadowRows: number;
  wouldSwitch: boolean;
}

/** Dry-run half of the switch: the same refusal question, no writes. */
export async function planMessageArchiveShadowSwitch(
  app: Pick<AppContext, "db" | "logger">,
): Promise<ShadowSwitchPlan> {
  const counts = await getArchiveShadowVerifyCounts(app.db, {});
  return {
    missing: counts.missing,
    oldRows: counts.oldRows,
    shadowRows: counts.shadowRows,
    wouldSwitch: counts.missing === 0,
  };
}

export async function switchMessageArchiveShadow(
  app: Pick<AppContext, "db" | "logger">,
): Promise<Awaited<ReturnType<typeof switchMessageArchiveShadowTables>>> {
  const result = await switchMessageArchiveShadowTables(app.db);
  app.logger.info({ ...result }, "Message-archive shadow switch complete");
  return result;
}
