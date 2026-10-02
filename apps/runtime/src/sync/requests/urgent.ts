import { sql } from "drizzle-orm";

import {
  getSyncPage,
  getSyncWork,
  SYNC_WORK_DONE_NOTIFY_CHANNEL,
  upsertDemand,
  type Database,
  type SyncWorkRow,
} from "@agency_hub_core/db";

import { PgWake } from "../engine/host-ports.ts";
import type { SyncLogger } from "../engine/commit.ts";
import { systemClock, type Clock, type Wake } from "../engine/ports.ts";
import { demandToUpsert } from "../engine/resource.ts";
import { fanslyResourceSpec, type ResourceSpec } from "../fansly/registry.ts";

// "Enqueue work and wait" (plan §3 «один отправитель», §15 step 2; design
// §7.3). The page actor is the only Fansly sender, so the API and the CLIs
// never call Fansly: they put work on the page's queue and wait for the
// actor's answer — up to 15–30 s, then "queued" with the work's status link.
//
// A page that is not `live` answers `not_live` before anything is written:
// the caller takes its legacy path. That includes a page with no `sync_pages`
// row yet (onboarded since the host started) and a page of another platform;
// only an id that names no page at all is refused (`no_page`). In step 2
// every page is `off` or `shadow`, so every call answers `not_live` (the
// engine cannot send before the step-3 switch, I17). Which keys a caller may
// enqueue is the registry's word: an entry with the `api` trigger
// (`account.verify`, `account.identity`, `media-download.fetch`); its class,
// coalescing and deadline come from the entry, as for any other demand.

/** How long a caller waits by default before it answers `queued`. */
export const URGENT_WAIT_DEFAULT_MS = 15_000;
/** The longest a caller may wait (plan §3: «до 15–30 с»). */
export const URGENT_WAIT_MAX_MS = 30_000;
/** The re-read period while waiting: a lost NOTIFY costs at most this. */
export const URGENT_POLL_MS = 250;
export const URGENT_WORK_DONE_APPLICATION_NAME = "fansly-sync-work-done";

/** The registry trigger that lets the API and the CLIs enqueue a key. */
const API_TRIGGER = "api";

export type EnqueueAndWaitResult =
  /** The actor served the demand (`satisfied`), or the work closed without
   *  serving it (`closeReason`: the chat or page went away, a mode change
   *  superseded it) — nothing further will happen to it either way. */
  | { state: "done"; workId: number; satisfied: boolean; result: unknown; closeReason: string | null }
  /** Still waiting (or quarantined) when the wait ended: follow `statusUrl`. */
  | { state: "queued"; workId: number; statusUrl: string }
  /** The page is not on the engine: use the legacy path. */
  | { state: "not_live" };

export type UrgentRefusal =
  | "not_api_resource" | "bad_subject" | "bad_wait" | "no_page" | "disabled_for_page" | "secret_busy";

export class UrgentWorkRefusedError extends Error {
  constructor(readonly reason: UrgentRefusal, message: string) {
    super(message);
    this.name = "UrgentWorkRefusedError";
  }
}

export interface UrgentContext {
  db: Database;
  /** The work-done wake (`createWorkDoneWake`); without it a wait re-reads
   *  the row every `URGENT_POLL_MS`. */
  workDone?: Wake | null;
  clock?: Clock;
}

export interface EnqueueAndWaitInput {
  pageId: number;
  /** A registry key with the `api` trigger. */
  resource: string;
  /** Default: page-level work (''). */
  subject?: string;
  /** Non-secret request parameters (stored when the row is created). */
  params?: unknown;
  /** Ciphertext of the page-credentials box (a candidate session or proxy for
   *  `account.identity`); nulled when the work closes. A work that carries one
   *  never merges into an open row of its key: that row checks another
   *  candidate, so the call is refused (`secret_busy`) instead. */
  secretParams?: string;
  /** Default 15 s, at most 30 s. */
  waitMs?: number;
  /** The demand reason journaled on the row (default `api`). */
  reason?: string;
  signal?: AbortSignal;
}

/** The status link of a queued work (owner route `syncPageWorkGet`). */
export function syncWorkStatusUrl(pageLabel: string, workId: number): string {
  return `/api/v1/sync/pages/${encodeURIComponent(pageLabel)}/work/${workId}`;
}

/** The registry entry a caller may enqueue, or the refusal. */
export function apiResourceSpec(resource: string): ResourceSpec {
  const spec = fanslyResourceSpec(resource);
  if (spec === null || !spec.triggers.includes(API_TRIGGER)) {
    throw new UrgentWorkRefusedError(
      "not_api_resource",
      `${resource} is not a Fansly Sync Engine resource the API may enqueue (registry trigger "${API_TRIGGER}")`,
    );
  }
  return spec;
}

type Enqueued =
  | { kind: "not_live" }
  | { kind: "queued"; workId: number; revision: number; pageLabel: string };

async function enqueue(db: Database, spec: ResourceSpec, input: EnqueueAndWaitInput): Promise<Enqueued> {
  return db.transaction(async (tx) => {
    const txDb = tx as unknown as Database;
    // The mode is read under a share lock, so a mode change (which updates the
    // row) cannot slip between this check and the work row.
    const locked = await txDb.execute<{ mode: string }>(sql`
      select mode from sync_pages where page_id = ${input.pageId} for share
    `);
    const mode = locked.rows[0]?.mode;
    if (mode === undefined) {
      // No engine row: a Fansly page onboarded since the host last started
      // (`ensureFanslySyncPages` gives it its row, mode `off`) or a page of
      // another platform. Either way the engine does not run it: not live.
      const known = await txDb.execute<{ id: string }>(sql`select id::text as id from pages where id = ${input.pageId}`);
      if (known.rows.length > 0) return { kind: "not_live" };
      throw new UrgentWorkRefusedError("no_page", `No page ${input.pageId}`);
    }
    if (mode !== "live") return { kind: "not_live" };
    const page = await getSyncPage(txDb, input.pageId);
    if (page === null) throw new UrgentWorkRefusedError("no_page", `No Fansly sync page ${input.pageId}`);
    const upsert = demandToUpsert(
      {
        resource: spec.key,
        ...(input.subject === undefined ? {} : { subject: input.subject }),
        ...(input.params === undefined ? {} : { params: input.params }),
        demand: { reason: input.reason ?? API_TRIGGER },
      },
      spec,
      { pageId: input.pageId, shadow: false, now: new Date(), page },
    );
    if (upsert === null) {
      throw new UrgentWorkRefusedError("disabled_for_page", `${spec.key} is switched off for ${page.pageLabel ?? input.pageId}`);
    }
    const secret = input.secretParams !== undefined;
    const result = await upsertDemand(txDb, {
      ...upsert,
      ...(secret ? { secretParams: input.secretParams, createOnly: true } : {}),
    });
    if (secret && !result.created) {
      throw new UrgentWorkRefusedError(
        "secret_busy",
        `${spec.key} is already queued for ${page.pageLabel ?? input.pageId} with other secret parameters (work ${result.id}); wait for it`,
      );
    }
    return {
      kind: "queued",
      workId: result.id,
      revision: result.demandRevision,
      pageLabel: page.pageLabel ?? String(input.pageId),
    };
  });
}

/** Whether the waiting is over for `row`, and with what. */
function settled(row: SyncWorkRow | null, workId: number, revision: number): EnqueueAndWaitResult | "wait" | "stuck" {
  if (row === null) {
    // Erased with its page's material: nothing will answer any more.
    return { state: "done", workId, satisfied: false, result: null, closeReason: "erased" };
  }
  if (row.appliedRevision >= revision) {
    return { state: "done", workId, satisfied: true, result: row.result ?? null, closeReason: row.closeReason };
  }
  if (row.closedAt !== null) {
    return { state: "done", workId, satisfied: false, result: row.result ?? null, closeReason: row.closeReason };
  }
  // Quarantined work waits for the owner (`sync work requeue`), not for a slot.
  return row.state === "quarantined" ? "stuck" : "wait";
}

/**
 * Put `resource` on the page's queue and wait for the actor to serve this
 * demand (`applied_revision ≥` the revision this call raised), up to
 * `waitMs`. Woken by `fansly_sync_work_done` (sent by `settleWork` at commit)
 * and re-reading the row every 250 ms, so a lost NOTIFY costs at most that.
 */
export async function enqueueAndWait(ctx: UrgentContext, input: EnqueueAndWaitInput): Promise<EnqueueAndWaitResult> {
  const spec = apiResourceSpec(input.resource);
  // Page-level work has the empty subject; any other names what it is about.
  const subject = input.subject ?? "";
  if ((spec.subject === "page") !== (subject === "")) {
    throw new UrgentWorkRefusedError(
      "bad_subject",
      spec.subject === "page"
        ? `${spec.key} is page-level work: it takes no subject`
        : `${spec.key} needs a subject (a ${spec.subject} id)`,
    );
  }
  const waitMs = input.waitMs ?? URGENT_WAIT_DEFAULT_MS;
  if (!Number.isFinite(waitMs) || waitMs <= 0 || waitMs > URGENT_WAIT_MAX_MS) {
    throw new UrgentWorkRefusedError("bad_wait", `waitMs must be in (0, ${URGENT_WAIT_MAX_MS}], received ${waitMs}`);
  }
  const enqueued = await enqueue(ctx.db, spec, input);
  if (enqueued.kind === "not_live") return { state: "not_live" };

  const clock = ctx.clock ?? systemClock;
  const queued: EnqueueAndWaitResult = {
    state: "queued",
    workId: enqueued.workId,
    statusUrl: syncWorkStatusUrl(enqueued.pageLabel, enqueued.workId),
  };
  const deadline = clock.monoNow() + waitMs;
  const signal = input.signal ?? new AbortController().signal;
  for (;;) {
    const verdict = settled(await getSyncWork(ctx.db, enqueued.workId), enqueued.workId, enqueued.revision);
    if (verdict === "stuck") return queued;
    if (verdict !== "wait") return verdict;
    const remaining = deadline - clock.monoNow();
    if (remaining <= 0 || signal.aborted) return queued;
    const slice = Math.min(URGENT_POLL_MS, remaining);
    if (ctx.workDone) {
      await ctx.workDone.wait(enqueued.workId, slice, signal);
    } else {
      await clock.sleep(slice, signal).catch(() => undefined);
    }
  }
}

/** The payload of `fansly_sync_work_done` is `<workId>:<appliedRevision>`. */
export function workIdOfDonePayload(payload: string): number | null {
  const workId = Number(payload.split(":", 1)[0]);
  return Number.isSafeInteger(workId) && workId > 0 ? workId : null;
}

/**
 * The work-done wake of a process that calls `enqueueAndWait` (the API, a CLI):
 * one dedicated LISTEN client on `fansly_sync_work_done`, keyed by work id.
 * A notification nobody waits for is dropped (every live settle is announced;
 * the waiter re-reads its row anyway). Start it once, close it at shutdown.
 */
export function createWorkDoneWake(input: { connectionString: string; logger: SyncLogger }): PgWake {
  return new PgWake({
    connectionString: input.connectionString,
    logger: input.logger,
    channel: SYNC_WORK_DONE_NOTIFY_CHANNEL,
    applicationName: URGENT_WORK_DONE_APPLICATION_NAME,
    keyOf: workIdOfDonePayload,
    keepUnclaimed: false,
  });
}
