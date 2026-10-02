import {
  cancelLiveWorkForRollback,
  getSyncPage,
  handFanslySendGuardBackToLegacy,
  setPagePause,
  setSyncPageMode,
  setSyncRequestsEnabledAt,
  type SyncPageRow,
  type SyncSwitchCapability,
} from "@agency_hub_core/db";

import { activePageHold } from "../engine/errors.ts";
import { findSyncPageByLabel } from "../inspect.ts";
import { settleEngineManagedHydration } from "../requests/legacy-hydration.ts";
import {
  readLatestSwitchAudit,
  readRollbackStartedFrom,
  recordRollbackAudit,
  SYNC_ROLLBACK_AUDIT_EVENT,
  type SyncRollbackStep,
} from "./audit.ts";
import { SWITCH_EXIT, SwitchRefusedError, type SwitchContext } from "./context.ts";

// `pnpm cli sync rollback --page P [--with-auth-hold]` (design step 3 §3.5
// item 7, runbook §6.5): gives a page back to the legacy engine, which
// continues from its own marks (J5). Resumable: the step is derived from the
// mode, the guard owner and the page's newest rollback audit row; every step
// writes `admin.sync_rollback`.
//
//   0 an auth/identity hold in force on a live page refuses (exit 5) unless
//     the owner said `--with-auth-hold`, before anything moves: the page stays
//     live, where the owner's renewal runs its identity check under the hold
//     (a page in `handover` runs no actor and refuses every credentials route).
//   1 mode `handover`: the host stops the live actor and its socket
//     gracefully, writes the safe release and keeps lock 58215 (legacy stays
//     fenced). A page already in `handover` starts at 2.
//   2 wait ≤ 60 s for the safe release of the current generation, or a stop
//     confirmation newer than its acquisition (`sync ownership
//     confirm-stopped`) — never assumed (J4); exit 3 otherwise.
//   3 the guard back to the legacy engine: `last_completed_at` moved past the
//     engine's last send and the end of an engine 429/list/network hold,
//     `next_u = 0.2` (J2, G20). An auth/identity hold that came in while the
//     actor stopped refuses too (exit 5): nothing was handed back, so a page
//     this rollback took from `live` goes back to `live` (the renewal needs
//     it); one that was in `handover` before stays there for
//     `--with-auth-hold`.
//   4 the live work closed (`rolled_back`) but the history works, which wait
//     `paused` (the requests pause, `rolled_back`), requests closed; the
//     wrapper's hydration rows settled — to the state their ended request
//     mirrors, else `expired` (`rolled_back`) — so the legacy hydration lane
//     owns the page cleanly.
//   5 mode `off` (`legacy_imported_at` cleared) and the legacy engine asked to
//     run every stream (`requestPageSync(all, recovery)`); the WS supervisor
//     takes the socket back within 10 s, the host unlocks 58215.

export interface SyncRollbackInput {
  pageLabel: string;
  withAuthHold: boolean;
  capabilityFor(pageId: number): SyncSwitchCapability;
}

export interface SyncRollbackOutcome {
  exitCode: number;
  step: SyncRollbackStep | "nothing";
  page: string;
}

const CHANGED_BY = (ctx: SwitchContext) => `cli:sync rollback:${ctx.actor}`;

/** The engine's last owner of the page is stopped: its own safe release, a
 *  stop confirmation newer than its acquisition, or no owner ever. */
export function engineOwnerStopped(page: Pick<SyncPageRow, "owner">): boolean {
  const owner = page.owner;
  if (owner.generation === 0n) return true;
  if (owner.releasedAt !== null && owner.releaseGeneration === owner.generation) return true;
  return owner.stopConfirmedAt !== null && owner.acquiredAt !== null && owner.stopConfirmedAt.getTime() > owner.acquiredAt.getTime();
}

/** The engine's auth/identity hold in force on the page (its own rule: one
 *  of credentials older than the verified ones is lifted), or null. */
function authHoldInForce(page: SyncPageRow): string | null {
  const hold = activePageHold(page, page.dbNow);
  return hold !== null && (hold.kind === "auth" || hold.kind === "identity_mismatch") ? hold.kind : null;
}

const RENEW_HINT = "renew the credentials through the engine (a credentials or proxy update, or `page verify`: the identity "
  + "check runs under the hold), then run this command again; or rerun with --with-auth-hold on the owner's word";

export async function runSyncRollback(ctx: SwitchContext, input: SyncRollbackInput): Promise<SyncRollbackOutcome> {
  const { db } = ctx;
  const page = await findSyncPageByLabel(db, input.pageLabel);
  const label = page.pageLabel ?? String(page.pageId);
  const latest = await readLatestSwitchAudit(db, page.pageId);
  const rollbackRow = latest?.eventType === SYNC_ROLLBACK_AUDIT_EVENT ? latest : null;
  const audit = (step: SyncRollbackStep, detail: Record<string, unknown> = {}) =>
    recordRollbackAudit(db, { pageId: page.pageId, step, actor: ctx.actor, detail });

  if (page.mode === "shadow") {
    throw new SwitchRefusedError(`${label} is shadow: the legacy engine owns it already (nothing to roll back)`);
  }
  if (page.mode === "off") {
    if (rollbackRow !== null && rollbackRow.stage === "5_off") {
      // Interrupted after the mode change: only the legacy request is left.
      await ctx.requestLegacyRecovery(label);
      await audit("done");
      ctx.print(`5 ${label}: the legacy engine is asked to run every stream (recovery)`);
      return { exitCode: SWITCH_EXIT.done, step: "done", page: label };
    }
    ctx.print(`${label} is off: nothing to roll back`);
    return { exitCode: SWITCH_EXIT.done, step: "nothing", page: label };
  }

  // 0. Under an auth/identity hold the page stays live (nothing moves, no
  // row): only there can the owner renew the credentials.
  const heldLive = page.mode === "live" && !input.withAuthHold ? authHoldInForce(page) : null;
  if (heldLive !== null) {
    ctx.print(`${label}: an ${heldLive} hold is in force — ${RENEW_HINT}; the page stays live`);
    return { exitCode: SWITCH_EXIT.authHold, step: "auth_hold", page: label };
  }

  const capability = input.capabilityFor(page.pageId);
  if (rollbackRow === null || rollbackRow.stage === "done") {
    await audit("start", { from: page.mode, withAuthHold: input.withAuthHold });
  }

  // 1. Stop the live actor (legacy stays fenced: handover is engine-owned).
  if (page.mode === "live") {
    const moved = await setSyncPageMode(db, {
      pageId: page.pageId,
      to: "handover",
      expectFrom: "live",
      changedBy: CHANGED_BY(ctx),
      capability,
    });
    if (moved.kind === "refused") throw new SwitchRefusedError(`${label}: live → handover refused (${moved.reason})`);
    await audit("1_handover", { generation: page.owner.generation.toString() });
    ctx.print(`1 ${label}: mode handover — the live actor stops and releases`);
  }

  // 2. The safe release of the current generation, or a stop confirmation.
  const deadline = Date.now() + ctx.timing.releaseTimeoutMs;
  let current = await getSyncPage(db, page.pageId);
  for (;;) {
    if (current === null) throw new Error(`${label}: the page row is gone`);
    if (current.mode !== "handover") throw new SwitchRefusedError(`${label} left handover (now ${current.mode}) during the rollback`);
    if (engineOwnerStopped(current)) break;
    if (Date.now() >= deadline) {
      await audit("waiting_stop", { generation: current.owner.generation.toString(), host: current.owner.host });
      ctx.print(`2 ${label}: generation ${current.owner.generation} on ${current.owner.host ?? "?"} neither released the page nor is `
        + "confirmed stopped; if the sync process is dead run `sync ownership confirm-stopped --running-hosts … "
        + `--page ${label}\`, then this command again (the page stays in handover, nothing is sent)`);
      return { exitCode: SWITCH_EXIT.waitsForStop, step: "waiting_stop", page: label };
    }
    await ctx.sleep(ctx.timing.ownerRetryMs);
    current = await getSyncPage(db, page.pageId);
  }
  const released = current.owner.releasedAt !== null && current.owner.releaseGeneration === current.owner.generation;
  await audit("2_released", {
    generation: current.owner.generation.toString(),
    evidence: current.owner.generation === 0n ? "never_owned" : released ? "safe_release" : "stop_confirmed",
  });
  ctx.print(`2 ${label}: generation ${current.owner.generation} ${released ? "released safely" : "confirmed stopped"}`);

  // 3. The guard back to the legacy engine (with the engine's hold floor).
  const handed = await handFanslySendGuardBackToLegacy(db, { pageId: page.pageId, allowAuthHold: input.withAuthHold });
  if (handed.kind === "auth_hold") {
    // The hold came in while the live actor stopped (or the page was in
    // handover already). Nothing was handed back: a page this rollback took
    // from live goes back to live, where the renewal can run.
    const fromLive = page.mode === "live" || (await readRollbackStartedFrom(db, page.pageId)) === "live";
    if (fromLive && current.legacyImportedAt !== null) {
      const back = await setSyncPageMode(db, {
        pageId: page.pageId,
        to: "live",
        expectFrom: "handover",
        changedBy: CHANGED_BY(ctx),
        capability,
      });
      if (back.kind === "refused") throw new SwitchRefusedError(`${label}: handover → live refused (${back.reason})`);
      await audit("auth_hold", { holdKind: handed.holdKind, mode: "live" });
      ctx.print(`3 ${label}: an ${handed.holdKind} hold came in while the live actor stopped; nothing was handed back and `
        + `the page is live again — ${RENEW_HINT}`);
      return { exitCode: SWITCH_EXIT.authHold, step: "auth_hold", page: label };
    }
    await audit("auth_hold", { holdKind: handed.holdKind, mode: "handover" });
    ctx.print(`3 ${label}: an ${handed.holdKind} hold is in force on a page that was in handover before this rollback; `
      + "handover runs no identity check and refuses every credentials route, so rerun with --with-auth-hold on the "
      + "owner's word (the legacy engine then meets the failing session and blocks its own streams); the page stays in "
      + "handover, nothing is sent");
    return { exitCode: SWITCH_EXIT.authHold, step: "auth_hold", page: label };
  }
  if (handed.kind === "not_released") {
    await audit("waiting_stop", { guard: "not_released", mode: handed.mode });
    ctx.print(`3 ${label}: the guard cannot go back yet (mode ${handed.mode ?? "?"}): run this command again`);
    return { exitCode: SWITCH_EXIT.waitsForStop, step: "waiting_stop", page: label };
  }
  await audit("3_guard_handed", { legacyFloor: handed.lastCompletedAt.toISOString() });
  ctx.print(`3 ${label}: send guard handed back; the first legacy request waits ≥ 1.2 × S after ${handed.lastCompletedAt.toISOString()}`);

  // 4. Live work closed, history works paused, requests closed; the
  // wrapper's hydration rows leave `dispatching` (the legacy lane owns the
  // page's hydration again).
  const cancelled = await cancelLiveWorkForRollback(db, { pageId: page.pageId, closeReason: "rolled_back" });
  await setPagePause(db, { pageId: page.pageId, requests: true, note: "rolled_back" });
  await setSyncRequestsEnabledAt(db, { pageId: page.pageId, at: null, capability });
  const wrapped = await settleEngineManagedHydration({ db, rawConfig: ctx.rawConfig }, { pageId: page.pageId, rolledBack: true });
  await audit("4_work_closed", { cancelledWork: cancelled, hydrationSettled: wrapped.settled, hydrationExpired: wrapped.expired });
  ctx.print(`4 ${label}: ${cancelled} live work row(s) cancelled; open history requests wait (paused)`
    + (wrapped.settled + wrapped.expired > 0
      ? `; ${wrapped.settled + wrapped.expired} wrapped hydration request(s) settled (${wrapped.expired} expired: rolled_back)`
      : ""));

  // 5. Off: the legacy predicate opens; the legacy engine runs every stream.
  const moved = await setSyncPageMode(db, {
    pageId: page.pageId,
    to: "off",
    expectFrom: "handover",
    changedBy: CHANGED_BY(ctx),
    capability,
  });
  if (moved.kind === "refused") throw new SwitchRefusedError(`${label}: handover → off refused (${moved.reason})`);
  await audit("5_off");
  await ctx.requestLegacyRecovery(label);
  await audit("done");
  ctx.print(`5 ${label}: mode off; the legacy engine is asked to run every stream (recovery); its socket returns within 10 s`);
  return { exitCode: SWITCH_EXIT.done, step: "done", page: label };
}
