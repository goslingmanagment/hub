import {
  getSyncAttempt,
  getSyncWork,
  listUnfinishedAttempts,
  lockOwnedPage,
  OwnershipLostError,
  settleAttemptWithoutCapture,
  SYNC_SEND_WINDOW_MS,
  type Database,
  type SyncAttemptRow,
} from "@agency_hub_core/db";
import { FANSLY_WIRE_IDS, fanslyWireSpec, type FanslyWireId, type FanslyWireOutcome } from "@agency_hub_core/fansly";

import type { FanslyRoute } from "../fansly/routes.ts";
import {
  apply,
  capture,
  credentialsGenerationOfAttempt,
  errorName,
  isAnswerInMemory,
  journalHeldAnswer,
  requestOfAttempt,
  settleNotSent,
  SyncCrashFault,
  type AdmissionRecord,
  type CaptureSend,
  type CommitDeps,
} from "./commit.ts";
import { classifyWireOutcome } from "./errors.ts";
import type { HeldAnswer, HeldOutcomeSource, HeldRequestOutcome } from "./ports.ts";
import type { WorkClass } from "./scheduler.ts";
import { commitSiteEnd } from "./site-slot.ts";

// The outcomes a sender outside the process keeps until the engine commits
// them (Project Browser, plan §3.2 «Приём буфера и восстановление», §4.2
// step 7, §4.9; spec §6.1 `recover`; stage 3 PR 13): a page's operator keeps
// every outcome of a request — a Hub request's `result`, a site request's
// `siteDone`, a site socket's `wsDone` — in its buffer until `resultAck`.
//
// At the actor's start (`reconcileHeldOutcomes`), BEFORE its recovery closes
// the attempts left unfinished as `unknown` (`recoverUnfinished`), the sender
// is asked about them (`recover`), and each is settled by what it says:
// - its outcome, resent: committed as the attempt's own — the capture (tx 2,
//   the journal's key `fansly-sync:<page>:attempt:<id>` already there makes a
//   repeat harmless), then the apply (tx 3); a CDN hop's bytes reach the
//   describer's handoff in that apply (`sync_media_handoff`) — a reply the
//   journal does not keep is asked about too when its capture committed but
//   its apply did not (a lost COMMIT acknowledgement, PR 12): recovery would
//   otherwise skip it. A site request's or socket's end settles its attempt
//   by the site path's rules (a 429 holds its route; a 401/403 holds nothing
//   here — whether it was the manual login's is not known any more);
// - `not_sent`: the sender's record shows it never left — closed as not sent
//   (`aborted_before_send`, `not_sent:held`);
// - `unknown` (or the sender not reachable within `HELD_RECOVER_WAIT_MS`):
//   left to the recovery, `unknown` as it always was.
//
// Between steps (`takeLateHeldOutcomes`), the outcomes the sender delivered
// that no request waits for: after a restart (the operator delivers every
// outcome it keeps to each new connection), an answer of another session
// than the request's, a reply whose apply a lost COMMIT acknowledgement left
// undone. Its attempt settled already, an answer is never applied in its
// place — it is kept as a fact (`<kind>:late`, `<kind>:foreign_session`,
// `journalHeldAnswer`), a CDN hop still waiting for its apply gets its bytes,
// and the rest is acknowledged.
//
// Taking an outcome is never a permission to send anything again: nothing
// here prepares, admits or sends a request. A read the engine still needs
// is a new attempt of its own work, by its own rules.

/** How long the actor's start waits for the sender (below the watchdog's
 *  stall bound, 120 s): not reachable by then, the attempts are `unknown`. */
export const HELD_RECOVER_WAIT_MS = 10_000;

/** How one held outcome was taken (tests, metrics). */
export interface HeldTaken {
  attemptId: number;
  how: "captured" | "not_sent" | "site_end" | "applied" | "journaled" | "acknowledged" | "unknown" | "left";
}

function isUnfinished(attempt: SyncAttemptRow): boolean {
  return attempt.outcome === "admitted" || attempt.outcome === "sent";
}

/** A reply the journal does not keep whose capture committed and whose
 *  apply did not. */
function awaitsInMemoryApply(attempt: SyncAttemptRow): boolean {
  return isAnswerInMemory(attempt.operation) && (attempt.applyState === "captured" || attempt.applyState === "deferred");
}

/**
 * At the actor's start, before `recoverUnfinished`: ask the sender about the
 * attempts left unfinished, and settle each by its answer. Never throws for
 * an answer it cannot take (it is left to the recovery); an ownership loss
 * and a test's crash do throw.
 */
export async function reconcileHeldOutcomes(
  d: CommitDeps,
  held: HeldOutcomeSource,
  waitMs: number = HELD_RECOVER_WAIT_MS,
): Promise<HeldTaken[]> {
  const unfinished = await listUnfinishedAttempts(d.db, { pageId: d.pageId, phase: "any", limit: 10_000 });
  const asked = unfinished.filter((attempt) => isUnfinished(attempt) || awaitsInMemoryApply(attempt));
  if (asked.length === 0) return [];
  const answers = await held.recover(asked.map((attempt) => attempt.id), waitMs);
  if (answers === null) {
    d.metrics.increment("sync_held_recover_unreachable", { pageId: d.pageId });
    d.logger.warn({ pageId: d.pageId, attempts: asked.length },
      "Fansly sync: the page's browser could not be asked about its unfinished attempts; they are unknown");
    return [];
  }
  const taken: HeldTaken[] = [];
  for (const attempt of asked) {
    const answer = answers.get(attempt.id);
    if (answer !== undefined) taken.push(await takeOne(d, held, answer, attempt));
  }
  if (taken.length > 0) {
    d.logger.info({ pageId: d.pageId, taken: taken.map((one) => `${one.attemptId}:${one.how}`) },
      "Fansly sync: the unfinished attempts were settled by what the page's browser kept");
  }
  return taken;
}

/** Between steps: the outcomes the sender delivered that nothing waited for. */
export async function takeLateHeldOutcomes(d: CommitDeps, held: HeldOutcomeSource): Promise<HeldTaken[]> {
  const taken: HeldTaken[] = [];
  for (const answer of held.takeLate()) {
    let attempt: SyncAttemptRow | null;
    try {
      attempt = await getSyncAttempt(d.db, answer.attemptId);
    } catch (error) {
      // Left with the sender: it delivers the outcome again.
      d.logger.warn({ pageId: d.pageId, attemptId: answer.attemptId, err: errorName(error) }, "Fansly sync: a held outcome's attempt does not read; left");
      continue;
    }
    taken.push(await takeOne(d, held, answer, attempt));
  }
  return taken;
}

async function takeOne(d: CommitDeps, held: HeldOutcomeSource, answer: HeldAnswer, attempt: SyncAttemptRow | null): Promise<HeldTaken> {
  const attemptId = answer.attemptId;
  try {
    const how = await take(d, held, answer, attempt);
    d.metrics.increment("sync_held_outcomes", { pageId: d.pageId, how });
    return { attemptId, how };
  } catch (error) {
    if (error instanceof SyncCrashFault || error instanceof OwnershipLostError) throw error;
    d.metrics.increment("sync_held_outcomes", { pageId: d.pageId, how: "failed" });
    d.logger.warn({ pageId: d.pageId, attemptId, err: errorName(error) }, "Fansly sync: a held outcome could not be taken; it stays with the page's browser");
    return { attemptId, how: "left" };
  }
}

async function take(d: CommitDeps, held: HeldOutcomeSource, answer: HeldAnswer, attempt: SyncAttemptRow | null): Promise<HeldTaken["how"]> {
  if (attempt === null || attempt.pageId !== d.pageId) {
    // Not an attempt of this page: nothing will ever claim it.
    if (answer.kind === "request" || answer.kind === "site") held.acknowledge(answer.attemptId);
    return "acknowledged";
  }
  switch (answer.kind) {
    case "unknown":
      if (answer.held === true) {
        // An outcome that says nothing tells: the attempt is `unknown` (as
        // the recovery would close it), and the sender may drop it.
        if (isUnfinished(attempt)) await settleHeldUnknown(d, attempt);
        held.acknowledge(attempt.id);
      }
      return "unknown";
    case "not_sent":
      if (isUnfinished(attempt)) await settleHeldNotSent(d, attempt);
      return "not_sent";
    case "site":
      if (isUnfinished(attempt)) {
        const sent = answer.end.kind === "response" || (answer.end.kind === "transport_error" && answer.end.sent);
        await commitSiteEnd(d, {
          attemptId: attempt.id,
          send: heldSend(attempt, sent, answer.sentWall),
          end: answer.end,
          // Whether it was the manual login's is not known any more: its
          // 401/403 holds nothing, a 429 holds its route.
          classified: { route: attempt.operation as FanslyRoute, exempt: true },
        });
      }
      held.acknowledge(attempt.id);
      return "site_end";
    case "request": {
      if (!(FANSLY_WIRE_IDS as readonly string[]).includes(attempt.operation)) {
        // Not an engine request's attempt (a site request's): no result of
        // it is the engine's to take.
        held.acknowledge(attempt.id);
        return "acknowledged";
      }
      const resolved = await answer.resolve(attempt);
      return isUnfinished(attempt) ? captureHeld(d, held, attempt, resolved) : lateHeld(d, held, attempt, resolved);
    }
  }
}

/** The send facts of a held outcome: the instant the sender reported, else
 *  the latest the request can have left (its send deadline, never later
 *  than now) — a safe bound for the pause's audit, as the takeover floor
 *  takes an unfinished attempt. */
function heldSend(attempt: SyncAttemptRow, sent: boolean, reported: Date | null): CaptureSend {
  const bound = new Date(Math.min(Date.now(), attempt.admittedAt.getTime() + SYNC_SEND_WINDOW_MS));
  return {
    sent,
    sentWall: sent ? reported ?? attempt.sentAt ?? bound : null,
    sendMark: sent ? (reported !== null ? "transport_reported" : "completion_fallback") : null,
    sendMonoOffsetMs: null,
    gapPrevMs: null,
    durationMs: null,
    pauseMs: attempt.pauseMs,
    settingMs: attempt.settingMs,
  };
}

async function settleHeldUnknown(d: CommitDeps, attempt: SyncAttemptRow): Promise<void> {
  await d.db.transaction(async (raw) => {
    const tx = raw as unknown as Database;
    await lockOwnedPage(tx, { pageId: d.pageId, generation: d.generation, lock: "no_key_update" });
    await settleAttemptWithoutCapture(tx, { attemptId: attempt.id, outcome: "unknown", errorClass: "held:fate_unknown" });
  });
}

async function settleHeldNotSent(d: CommitDeps, attempt: SyncAttemptRow): Promise<void> {
  await d.db.transaction(async (raw) => {
    const tx = raw as unknown as Database;
    await lockOwnedPage(tx, { pageId: d.pageId, generation: d.generation, lock: "no_key_update" });
    // Its work, running, opens again with the recovery right after.
    await settleAttemptWithoutCapture(tx, { attemptId: attempt.id, outcome: "aborted_before_send", errorClass: "not_sent:held" });
  });
}

/** An attempt still unfinished takes its own outcome: the capture, then the
 *  apply, as the actor would have — and the sender's copy goes once what it
 *  carried is committed. */
async function captureHeld(d: CommitDeps, held: HeldOutcomeSource, attempt: SyncAttemptRow, resolved: HeldRequestOutcome): Promise<HeldTaken["how"]> {
  const outcome = resolved.outcome;
  const spec = d.registry.spec(attempt.resource);
  const work = attempt.workId === null ? null : await getSyncWork(d.db, attempt.workId);
  if (spec === null || work === null) {
    // Nothing to settle it against: the recovery closes it `unknown`; the
    // answer is kept as a fact.
    await keepAnswer(d, attempt, resolved);
    held.acknowledge(attempt.id);
    return "journaled";
  }
  const admission: AdmissionRecord = {
    attemptId: attempt.id,
    admittedAt: attempt.admittedAt,
    demandRevision: attempt.demandRevision ?? work.demandRevision,
    demand: work.demand,
    work,
    workClass: attempt.class as WorkClass,
    spec,
    request: requestOfAttempt(attempt),
    credentialsGeneration: credentialsGenerationOfAttempt(attempt),
  };
  if (outcome.kind === "aborted_before_send") {
    await settleNotSent(d, admission, outcome);
    held.acknowledge(attempt.id);
    return "not_sent";
  }
  const module = await d.registry.module(attempt.resource);
  const sent = outcome.kind === "response" || outcome.sent;
  const captured = await capture(d, admission, heldSend(attempt, sent, resolved.sentWall), outcome, module);
  if (captured.applyNow) await apply(d, { attemptId: attempt.id, operation: attempt.operation }, captured.inMemory);
  // Another session's answer is never this request's: kept as a fact.
  if (!resolved.sameSession) await keepAnswer(d, attempt, resolved);
  if (!isAnswerInMemory(attempt.operation) || await answerCommitted(d, attempt.id)) held.acknowledge(attempt.id);
  return "captured";
}

/** An attempt settled already: its answer is never applied in its place. A
 *  CDN hop whose apply is still due gets its bytes; any other answer is kept
 *  as a fact unless the attempt has it; then the sender may drop it. */
async function lateHeld(d: CommitDeps, held: HeldOutcomeSource, attempt: SyncAttemptRow, resolved: HeldRequestOutcome): Promise<HeldTaken["how"]> {
  const outcome = resolved.outcome;
  if (awaitsInMemoryApply(attempt) && resolved.sameSession && resolved.whole && outcome.kind === "response") {
    const inMemory = inMemoryAnswerOf(d, attempt, outcome);
    if (inMemory !== null) await apply(d, { attemptId: attempt.id, operation: attempt.operation }, inMemory);
    if (!(await answerCommitted(d, attempt.id))) return "left";
    held.acknowledge(attempt.id);
    return "applied";
  }
  const kept = attempt.outcome === "response" && resolved.sameSession ? false : await keepAnswer(d, attempt, resolved);
  held.acknowledge(attempt.id);
  return kept ? "journaled" : "acknowledged";
}

/** The answer of a held outcome as a fact (`journalHeldAnswer`). */
function keepAnswer(d: CommitDeps, attempt: SyncAttemptRow, resolved: HeldRequestOutcome): Promise<boolean> {
  return journalHeldAnswer(d, attempt, resolved.outcome, resolved.sameSession ? "late" : "foreign_session");
}

/** A reply the journal does not keep, as its apply takes it from memory. */
function inMemoryAnswerOf(
  d: CommitDeps,
  attempt: SyncAttemptRow,
  outcome: Extract<FanslyWireOutcome, { kind: "response" }>,
): { response: unknown; parsed: unknown } | null {
  const request = requestOfAttempt(attempt);
  const spec = d.registry.spec(attempt.resource);
  const classified = classifyWireOutcome(outcome, fanslyWireSpec(attempt.operation as FanslyWireId), request.params as never, {
    now: d.clock.wallNow(),
    ...(spec?.terminalStatuses === undefined ? {} : { terminalStatuses: spec.terminalStatuses }),
    ...(spec?.subjectScopedAuthStatuses === undefined ? {} : { subjectScopedAuthStatuses: spec.subjectScopedAuthStatuses }),
  });
  if (classified.errorClass !== "ok" || classified.read?.kind !== "accepted") return null;
  return { response: classified.read.response, parsed: classified.read.value };
}

/** What an answer carried is committed: its attempt settled, and applied —
 *  or nothing of it was to apply (as the actor proves it, PR 12). */
async function answerCommitted(d: CommitDeps, attemptId: number): Promise<boolean> {
  const attempt = await getSyncAttempt(d.db, attemptId);
  if (attempt === null || isUnfinished(attempt)) return false;
  return attempt.applyState === "applied" || attempt.applyState === "none";
}
