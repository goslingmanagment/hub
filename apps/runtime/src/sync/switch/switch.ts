import {
  cancelLiveWorkForRollback,
  expireAgentHydrationRequest,
  getFanslySendGuard,
  getSyncPage,
  handFanslySendGuardBackToLegacy,
  handFanslySendGuardToEngine,
  listOpenLegacyHydrationRequestsForPage,
  setPagePause,
  setSyncPageMode,
  setSyncRequestsEnabledAt,
  type SyncPageRow,
  type SyncSwitchCapability,
} from "@agency_hub_core/db";

import { rebuildPageChains } from "../fansly/lib/chain-rebuild.ts";
import type { EngineRegistry } from "../engine/resource.ts";
import { findSyncPageByLabel } from "../inspect.ts";
import { submitHistoryRequest } from "../requests/history.ts";
import { historyIntakeOfLegacyHydration } from "../requests/legacy-hydration.ts";
import {
  anyPageWasLive,
  isUnfinishedRollback,
  readLatestSwitchAudit,
  recordRedLinesAcceptance,
  recordSwitchAudit,
  SYNC_SWITCH_AUDIT_EVENT,
  SYNC_SWITCH_RED_LINES_AUDIT_EVENT,
  type SwitchAuditRow,
} from "./audit.ts";
import { SWITCH_EXIT, SwitchRefusedError, wholeSeconds, type SwitchContext } from "./context.ts";
import { importLegacyState } from "./import.ts";
import { failingStopCheck, legacyStopped, readLegacyStopEvidence } from "./legacy-stop.ts";
import { checkSwitchPreconditions, redLinesLine, type RedLinesAcceptance } from "./preconditions.ts";

// `pnpm cli sync switch --page P --shadow-report <path>` (design step 3 §3.5
// item 7, runbook §6.2): moves one page from the shadow engine to the live
// one. Idempotent and resumable: where it stands is derived from the database
// (mode, guard owner, `legacy_imported_at`, `requests_enabled_at`) and the
// page's newest switch/rollback audit row, never from memory (J4).
//
//   A  mode `handover` (the legacy engine is fenced, S3-01; the shadow actor
//      releases) and the step-1 guard row handed to the engine once no legacy
//      request is in flight (J1, J2). Timeout ⇒ back to `shadow` (nothing was
//      handed), exit 2.
//   B  the legacy engine confirmed stopped (`readLegacyStopEvidence`, J3).
//      Timeout ⇒ the guard handed back, the work the post-ack hook raised
//      cancelled, `shadow`, exit 2.
//   R  the final incremental chain rebuild from the journal (§8.2).
//   I  the legacy import (`importLegacyState`), `legacy_imported_at` last.
//   C  mode `live`: the host takes a new owner generation (its first send
//      ≥ 1.2 × S after the legacy completion, `paceFloorFromDb`); then the
//      page's history requests open (+1 h on the first page ever switched).
//   H  once requests are open: the page's open hydration requests become
//      history requests (`switch_migration`), their legacy rows `expired`.

export interface SyncSwitchInput {
  pageLabel: string;
  shadowReportPath: string | null;
  /** The owner's judgement of the report's red lines (step 3b ruling 12):
   *  a report that is not accepted passes on it alone, audited. */
  acceptRedLines?: RedLinesAcceptance | null;
  dryRun: boolean;
  registry: EngineRegistry;
  /** The switch capability for the page (issued by the CLI only, I17). */
  capabilityFor(pageId: number): SyncSwitchCapability;
}

export interface SyncSwitchOutcome {
  exitCode: number;
  /** The last phase reached (or the dry run's verdict). */
  phase: string;
  page: string;
}

const CHANGED_BY = (ctx: SwitchContext) => `cli:sync switch:${ctx.actor}`;

/** Where a switch of this page stands, from the database and its audit trail. */
type Resume =
  | { at: "A" }
  | { at: "A_guard" }
  | { at: "B" }
  | { at: "C" }
  | { at: "C_live"; generationAtC: bigint | null }
  | { at: "revert"; cause: string };

function deriveResume(page: SyncPageRow, guardEngine: boolean, latest: SwitchAuditRow | null): Resume {
  const switchRow = latest?.eventType === SYNC_SWITCH_AUDIT_EVENT ? latest : null;
  if (page.mode === "shadow") return { at: "A" };
  if (page.mode === "handover") {
    if (switchRow === null) {
      throw new SwitchRefusedError(
        `${page.pageLabel ?? page.pageId} is in handover but not by a switch (newest audit row: ${latest?.eventType ?? "none"}); `
        + "finish it with `sync rollback`",
      );
    }
    if (switchRow.stage === "reverting") return { at: "revert", cause: String(switchRow.metadata.cause ?? "resumed") };
    if (!guardEngine) return { at: "A_guard" };
    return page.legacyImportedAt === null ? { at: "B" } : { at: "C" };
  }
  if (page.mode === "live") {
    if (switchRow === null) {
      throw new SwitchRefusedError(`${page.pageLabel ?? page.pageId} is live but its newest audit row is not a switch row`);
    }
    const recorded = switchRow.metadata.generationAtC;
    const generationAtC = typeof recorded === "string" && /^\d+$/.test(recorded) ? BigInt(recorded) : null;
    return { at: "C_live", generationAtC };
  }
  throw new SwitchRefusedError(`${page.pageLabel ?? page.pageId} is ${page.mode}: put it in shadow first (sync page mode --to shadow)`);
}

async function guardHandedToEngine(ctx: SwitchContext, pageId: number): Promise<boolean> {
  const guard = await getFanslySendGuard(ctx.db, pageId);
  return guard?.ownerEngine === "fansly_sync_engine";
}

/** `sync switch`: run (or resume) the switch of one page. */
export async function runSyncSwitch(ctx: SwitchContext, input: SyncSwitchInput): Promise<SyncSwitchOutcome> {
  const { db } = ctx;
  let page = await findSyncPageByLabel(db, input.pageLabel);
  const label = page.pageLabel ?? String(page.pageId);
  const latest = await readLatestSwitchAudit(db, page.pageId);
  if (isUnfinishedRollback(latest) && (page.mode === "handover" || page.mode === "live")) {
    throw new SwitchRefusedError(
      `${label}: a rollback stopped at step ${latest!.stage}; a switch never resumes it (J4) — finish it with \`sync rollback --page ${label}\``,
    );
  }
  const resume = deriveResume(page, await guardHandedToEngine(ctx, page.pageId), latest);
  const preconditions = { page, shadowReportPath: input.shadowReportPath, acceptRedLines: input.acceptRedLines ?? null };
  if (resume.at !== "A" && preconditions.acceptRedLines !== null) {
    ctx.print(`${label}: --accept-red-lines unused — the switch resumes at ${resume.at}, past its preconditions`);
  }

  if (input.dryRun) {
    if (resume.at !== "A") {
      ctx.print(`${label}: ${page.mode}; a switch would resume at ${resume.at}`);
      return { exitCode: SWITCH_EXIT.done, phase: `dry_run:${resume.at}`, page: label };
    }
    const verdict = await checkSwitchPreconditions(ctx, preconditions);
    for (const check of verdict.checks) ctx.print(`${check.ok ? "ok  " : "FAIL"} ${check.name}: ${check.detail}`);
    if (verdict.redLines !== null) {
      ctx.print(`RED LINES ${label}: ${redLinesLine(verdict.redLines)} — the switch would record ${SYNC_SWITCH_RED_LINES_AUDIT_EVENT}`);
    }
    ctx.print(verdict.ok ? `${label}: every precondition holds` : `${label}: the switch would be refused`);
    return { exitCode: verdict.ok ? SWITCH_EXIT.done : 1, phase: "dry_run", page: label };
  }

  const capability = input.capabilityFor(page.pageId);
  switch (resume.at) {
    case "revert":
      return revertToShadow(ctx, page, capability, resume.cause);
    case "A": {
      const verdict = await checkSwitchPreconditions(ctx, preconditions);
      if (!verdict.ok) {
        for (const check of verdict.checks.filter((entry) => !entry.ok)) ctx.print(`FAIL ${check.name}: ${check.detail}`);
        throw new SwitchRefusedError(`${label}: the switch is refused (preconditions)`, verdict.checks);
      }
      if (verdict.redLines !== null) {
        // The owner's judgement of the report (step 3b ruling 12), on record
        // before anything changes.
        await recordRedLinesAcceptance(db, { pageId: page.pageId, page: label, actor: ctx.actor, redLines: verdict.redLines });
        ctx.print(`RED LINES ${label}: ${redLinesLine(verdict.redLines)} — recorded as ${SYNC_SWITCH_RED_LINES_AUDIT_EVENT}`);
      }
      await recordSwitchAudit(db, { pageId: page.pageId, phase: "start", actor: ctx.actor, detail: { checks: verdict.checks } });
      const moved = await setSyncPageMode(db, {
        pageId: page.pageId,
        to: "handover",
        expectFrom: "shadow",
        changedBy: CHANGED_BY(ctx),
        capability,
      });
      if (moved.kind === "refused") throw new SwitchRefusedError(`${label}: shadow → handover refused (${moved.reason})`);
      await recordSwitchAudit(db, { pageId: page.pageId, phase: "A_handover", actor: ctx.actor });
      ctx.print(`A ${label}: mode handover — the legacy engine is fenced`);
    }
    // fallthrough
    case "A_guard": {
      const handed = await handGuardToEngine(ctx, page, capability);
      if (handed !== null) return handed;
    }
    // fallthrough
    case "B": {
      const stopped = await confirmLegacyStopped(ctx, page, capability);
      if (stopped !== null) return stopped;
      await rebuildFinalChains(ctx, page, capability);
      const report = await importLegacyState(ctx, { pageId: page.pageId, registry: input.registry, capability });
      await recordSwitchAudit(db, { pageId: page.pageId, phase: "I_imported", actor: ctx.actor, detail: { report } });
      ctx.print(`I ${label}: legacy state imported — ${JSON.stringify({
        modules: report.modules.length,
        breakers: report.breakers,
        breakersOnOpenWork: report.breakersOnOpenWork,
        demands: report.demands,
        unconfirmedOverlayChats: report.unconfirmedOverlayChats,
        holds: report.holds,
        threadsMarkedUnverified: report.threadsMarkedUnverified,
      })}`);
    }
    // fallthrough
    case "C": {
      page = (await getSyncPage(db, page.pageId)) ?? page;
      const generationAtC = page.owner.generation;
      const moved = await setSyncPageMode(db, {
        pageId: page.pageId,
        to: "live",
        expectFrom: "handover",
        changedBy: CHANGED_BY(ctx),
        capability,
      });
      if (moved.kind === "refused") throw new SwitchRefusedError(`${label}: handover → live refused (${moved.reason})`);
      await recordSwitchAudit(db, {
        pageId: page.pageId,
        phase: "C_live",
        actor: ctx.actor,
        detail: { generationAtC: generationAtC.toString(), modeChangedAt: moved.kind === "changed" ? moved.modeChangedAt.toISOString() : null },
      });
      ctx.print(`C ${label}: mode live (T0 ${moved.kind === "changed" ? moved.modeChangedAt.toISOString() : "?"})`);
      return finishLive(ctx, page.pageId, label, capability, generationAtC);
    }
    case "C_live":
      return finishLive(ctx, page.pageId, label, capability, resume.generationAtC);
  }
}

/** Phase A's guard flip: every `guardRetryMs` until handed, at most
 *  `guardTimeoutMs`; a timeout reverts to shadow (nothing was handed). */
async function handGuardToEngine(
  ctx: SwitchContext,
  page: SyncPageRow,
  capability: SyncSwitchCapability,
): Promise<SyncSwitchOutcome | null> {
  const label = page.pageLabel ?? String(page.pageId);
  const deadline = Date.now() + ctx.timing.guardTimeoutMs;
  let last: string;
  for (;;) {
    const flipped = await handFanslySendGuardToEngine(ctx.db, { pageId: page.pageId });
    if (flipped.kind === "handed" || flipped.kind === "already") {
      await recordSwitchAudit(ctx.db, {
        pageId: page.pageId,
        phase: "A_guard_handed",
        actor: ctx.actor,
        detail: { legacyLastCompletedAt: flipped.lastCompletedAt.toISOString() },
      });
      ctx.print(`A ${label}: send guard handed to the engine (legacy completed ${flipped.lastCompletedAt.toISOString()})`);
      return null;
    }
    last = flipped.kind === "closed"
      ? `the guard is closed (${flipped.reason}): fansly-send-guard confirm-terminated`
      : `a legacy request holds the guard (${flipped.holder === null ? "just released" : `${flipped.holder.source ?? "?"} on ${flipped.holder.host ?? "?"} pid ${flipped.holder.pid ?? "?"}`})`;
    if (Date.now() >= deadline) break;
    await ctx.sleep(ctx.timing.guardRetryMs);
  }
  ctx.print(`A ${label}: the guard was not handed within ${wholeSeconds(ctx.timing.guardTimeoutMs)} s — ${last} (fansly-send-guard status)`);
  // Nothing was handed (the hand-back below is a no-op): back to shadow at once.
  return revertToShadow(ctx, page, capability, `A: ${last}`);
}

/**
 * Back to shadow after A or B timed out (or a revert that was interrupted):
 * the guard back to the legacy engine (a no-op when it never left), the live
 * work the post-ack hook raised during `handover` cancelled, mode `shadow`.
 * The guard needs the shadow owner's safe release (or a stop confirmation);
 * without it the page stays in `handover` — nothing is sent — and the owner
 * is asked for `sync ownership confirm-stopped` (exit 3).
 */
async function revertToShadow(
  ctx: SwitchContext,
  page: SyncPageRow,
  capability: SyncSwitchCapability,
  cause: string,
): Promise<SyncSwitchOutcome> {
  const label = page.pageLabel ?? String(page.pageId);
  const latest = await readLatestSwitchAudit(ctx.db, page.pageId);
  if (latest?.eventType !== SYNC_SWITCH_AUDIT_EVENT || latest.stage !== "reverting") {
    await recordSwitchAudit(ctx.db, { pageId: page.pageId, phase: "reverting", actor: ctx.actor, detail: { cause } });
  }
  // The engine never sent for this page (it never was live): an auth hold of
  // the shadow journal carries nothing.
  const handed = await handFanslySendGuardBackToLegacy(ctx.db, { pageId: page.pageId, allowAuthHold: true });
  if (handed.kind === "not_released") {
    ctx.print(`${label}: the shadow owner has not released the page and is not confirmed stopped; `
      + "run `sync ownership confirm-stopped --running-hosts …`, then this command again (the page stays in handover, nothing is sent)");
    return { exitCode: SWITCH_EXIT.waitsForStop, phase: "reverting", page: label };
  }
  const cancelled = await cancelLiveWorkForRollback(ctx.db, { pageId: page.pageId, closeReason: "switch_reverted" });
  const moved = await setSyncPageMode(ctx.db, {
    pageId: page.pageId,
    to: "shadow",
    expectFrom: "handover",
    changedBy: CHANGED_BY(ctx),
    capability,
  });
  if (moved.kind === "refused" && moved.reason !== "expected_mode_mismatch") {
    throw new SwitchRefusedError(`${label}: handover → shadow refused (${moved.reason})`);
  }
  await recordSwitchAudit(ctx.db, { pageId: page.pageId, phase: "reverted", actor: ctx.actor, detail: { cause, cancelledWork: cancelled } });
  ctx.print(`${label}: switch reverted to shadow (${cause}); the legacy engine runs the page again`);
  return { exitCode: SWITCH_EXIT.reverted, phase: "reverted", page: label };
}

/** Phase B: the legacy stop evidence every `stopRetryMs`, at most
 *  `stopTimeoutMs`; a timeout reverts. Then the B audit row. */
async function confirmLegacyStopped(
  ctx: SwitchContext,
  page: SyncPageRow,
  capability: SyncSwitchCapability,
): Promise<SyncSwitchOutcome | null> {
  const label = page.pageLabel ?? String(page.pageId);
  const deadline = Date.now() + ctx.timing.stopTimeoutMs;
  for (;;) {
    const evidence = await readLegacyStopEvidence(ctx.db, page.pageId);
    if (legacyStopped(evidence)) {
      await recordSwitchAudit(ctx.db, { pageId: page.pageId, phase: "B_stopped", actor: ctx.actor, detail: { evidence } });
      ctx.print(`B ${label}: the legacy engine is stopped${evidence.openWsConnections > 0 ? ` (${evidence.openWsConnections} open legacy connection row(s) without a lock holder)` : ""}`);
      return null;
    }
    if (Date.now() >= deadline) {
      const failing = failingStopCheck(evidence) ?? "unknown";
      ctx.print(`B ${label}: the legacy engine did not stop within ${wholeSeconds(ctx.timing.stopTimeoutMs)} s (${failing})`);
      return revertToShadow(ctx, page, capability, `B: ${failing}`);
    }
    await ctx.sleep(ctx.timing.stopRetryMs);
  }
}

/** Phase R: the switch's own incremental rebuild of the page's chains from
 *  the journal (the last legacy reads), in `handover`. */
async function rebuildFinalChains(ctx: SwitchContext, page: SyncPageRow, capability: SyncSwitchCapability): Promise<void> {
  const label = page.pageLabel ?? String(page.pageId);
  const report = await rebuildPageChains({ db: ctx.db, logger: ctx.logger }, {
    pageId: page.pageId,
    write: true,
    full: false,
    handoverCapability: capability,
    batchRows: 500,
    sleepMs: 0,
    maxDurationMs: null,
    // The switch checked the window at its start; the incremental pass is short.
    forceWindow: true,
    audit: { source: "cli", actorUserId: null },
  });
  if (!report.scan.completed) {
    throw new Error(`${label}: the final chain rebuild stopped (${report.scan.stoppedBy ?? "?"}); run the switch again`);
  }
  await recordSwitchAudit(ctx.db, {
    pageId: page.pageId,
    phase: "R_rebuilt",
    actor: ctx.actor,
    detail: { throughRawId: report.scan.throughRawId, rowsScanned: report.scan.rowsScanned, written: report.threads.written },
  });
  ctx.print(`R ${label}: final chain rebuild through raw ${report.scan.throughRawId} (${report.threads.written} threads written)`);
}

/**
 * Phase C after the mode change, and H: wait for a new owner generation with
 * a fresh heartbeat; open the page's history requests; clear a pause a
 * rollback left; convert the open hydration requests once requests are open.
 */
async function finishLive(
  ctx: SwitchContext,
  pageId: number,
  label: string,
  capability: SyncSwitchCapability,
  generationAtC: bigint | null,
): Promise<SyncSwitchOutcome> {
  const { db } = ctx;
  const deadline = Date.now() + ctx.timing.ownerTimeoutMs;
  let page = await getSyncPage(db, pageId);
  for (;;) {
    if (page === null) throw new Error(`${label}: the page row is gone`);
    if (page.mode !== "live") throw new SwitchRefusedError(`${label} left live (now ${page.mode}) while the switch waited for its owner`);
    if (liveOwnerRunning(page, generationAtC)) break;
    if (Date.now() >= deadline) {
      ctx.print(`C ${label}: no live owner within ${wholeSeconds(ctx.timing.ownerTimeoutMs)} s — the page is live with the guard handed `
        + "and nothing is sent; read `sync page status`, then fix it or `sync rollback`");
      return { exitCode: SWITCH_EXIT.noLiveOwner, phase: "C_live", page: label };
    }
    await ctx.sleep(ctx.timing.ownerRetryMs);
    page = await getSyncPage(db, pageId);
  }
  const latest = await readLatestSwitchAudit(db, pageId);
  if (latest?.stage === "C_live") {
    await recordSwitchAudit(db, { pageId, phase: "C_owner", actor: ctx.actor, detail: { generation: page.owner.generation.toString() } });
  }
  ctx.print(`C ${label}: live owner generation ${page.owner.generation} on ${page.owner.host ?? "?"}`);

  if (page.requestsEnabledAt === null) {
    const first = !(await anyPageWasLive(db, { exceptPageId: pageId }));
    const at = new Date(page.dbNow.getTime() + (first ? ctx.timing.firstPageRequestsDelayMs : 0));
    if (!(await setSyncRequestsEnabledAt(db, { pageId, at, capability }))) {
      throw new SwitchRefusedError(`${label}: the page left live before its requests opened`);
    }
    await recordSwitchAudit(db, { pageId, phase: "C_requests", actor: ctx.actor, detail: { requestsEnabledAt: at.toISOString(), firstPage: first } });
    ctx.print(`C ${label}: history requests open at ${at.toISOString()}${first ? " (first switched page: +1 h)" : ""}`);
    page = (await getSyncPage(db, pageId)) ?? page;
  }
  if (page.pausedRequests && page.pauseNote === "rolled_back") {
    // A rollback paused the page's requests; the page is live again.
    await setPagePause(db, { pageId, requests: false, note: null });
    ctx.print(`C ${label}: the requests pause a rollback left is cleared`);
  }

  const opened = page.requestsEnabledAt !== null && page.requestsEnabledAt.getTime() <= page.dbNow.getTime();
  if (opened) {
    await convertOpenHydration(ctx, pageId, label);
  } else {
    ctx.print(`H ${label}: hydration requests are converted once requests open — run \`sync switch --page ${label} --open-requests\` then`);
  }
  await recordSwitchAudit(db, { pageId, phase: "done", actor: ctx.actor });
  printChecklist(ctx, label, page);
  return { exitCode: SWITCH_EXIT.done, phase: "done", page: label };
}

/** A new owner generation (past the one at C) running with a fresh heartbeat. */
function liveOwnerRunning(page: SyncPageRow, generationAtC: bigint | null): boolean {
  const owner = page.owner;
  if (generationAtC !== null && owner.generation <= generationAtC) return false;
  if (owner.heartbeatAt === null) return false;
  if (owner.releasedAt !== null && owner.releaseGeneration === owner.generation) return false;
  return page.dbNow.getTime() - owner.heartbeatAt.getTime() <= 30_000;
}

/** `sync switch --open-requests` (the first page, at or after its requests
 *  opened): phase H alone. */
export async function runSyncSwitchOpenRequests(ctx: SwitchContext, input: { pageLabel: string }): Promise<SyncSwitchOutcome> {
  const page = await findSyncPageByLabel(ctx.db, input.pageLabel);
  const label = page.pageLabel ?? String(page.pageId);
  if (page.mode !== "live") throw new SwitchRefusedError(`${label} is ${page.mode}, not live`);
  if (page.requestsEnabledAt === null || page.requestsEnabledAt.getTime() > page.dbNow.getTime()) {
    throw new SwitchRefusedError(`${label}: history requests open at ${page.requestsEnabledAt?.toISOString() ?? "(not set)"}`);
  }
  const converted = await convertOpenHydration(ctx, page.pageId, label);
  return { exitCode: SWITCH_EXIT.done, phase: `H_converted:${converted}`, page: label };
}

/** Phase H: every open hydration request of the page becomes a history
 *  request (`switch_migration`, the row's boundary), its legacy row
 *  `expired` with the history ref. Idempotent by the ref's uuid. */
async function convertOpenHydration(ctx: SwitchContext, pageId: number, label: string): Promise<number> {
  const rows = await listOpenLegacyHydrationRequestsForPage(ctx.db, pageId);
  let converted = 0;
  const skipped: string[] = [];
  for (const row of rows) {
    if (row.state === "dispatching") {
      // A legacy run in flight (none since A fenced the dispatcher): its
      // executor settles it; it is never converted under it.
      skipped.push(row.requestRef);
      continue;
    }
    const result = await submitHistoryRequest(
      { db: ctx.db, rawConfig: ctx.rawConfig },
      historyIntakeOfLegacyHydration(row, { kind: "switch_migration" }, `converted from hydration request ${row.requestRef}`),
      { audit: { source: "cli" } },
    );
    const expired = await expireAgentHydrationRequest(ctx.db, {
      id: row.id,
      fromState: row.state as "requested" | "approved",
      actor: "executor",
      cause: "converted_to_history_request",
      detail: { ref: result.request.ref },
    });
    if (expired === "applied") converted += 1;
  }
  await recordSwitchAudit(ctx.db, { pageId, phase: "H_converted", actor: ctx.actor, detail: { converted, skippedDispatching: skipped } });
  ctx.print(`H ${label}: ${converted} hydration request(s) converted to history requests${skipped.length > 0 ? `; ${skipped.length} dispatching left to their executor` : ""}`);
  return converted;
}

function printChecklist(ctx: SwitchContext, label: string, page: SyncPageRow): void {
  ctx.print(`Post-switch checklist for ${label} (runbook §6.2):`);
  ctx.print(`  S3 now: sync page status --page ${label}; sync switch check --page ${label} --since ${page.modeChangedAt.toISOString()} (interim: a fail shows at once); sync alerts status --page ${label}`);
  ctx.print("  S4 within the hour: 1 deploy + 2 sync recreates + 1 kill -9, ≥ 10 min apart (owner decision №16)");
  ctx.print(`  S5 at ${page.requestsEnabledAt?.toISOString() ?? "the requests opening"}: the 20-fan control request`);
  ctx.print(`  S7 after T* + 1 h: the verdict — sync switch check --page ${label} [--page <each page switched with it> …] --since <the first of their T0s; this page's: ${page.modeChangedAt.toISOString()}>`);
}
