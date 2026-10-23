import {
  countPagePublicationDispatchesSince,
  getPublication,
  getPublicationRevision,
  insertPublicationDispatch,
  listDueFanslyPublications,
  listFanslyWriteCommandsOfDispatch,
  listSubmittingFanslyPublications,
  transitionPublication,
  type Database,
  type FanslyWriteCommandRecord,
  type FanslyWritePriority,
  type FanslyWriteStep,
  type PublicationDispatchMode,
  type PublicationDispatchRecord,
} from "@agency_hub_core/db";
import { isFanslyWriteSendable, type FanslyWireId } from "@agency_hub_core/fansly";
import {
  PUBLICATION_BATCH_GAP_MINUTES,
  PUBLICATION_BATCH_SIZE,
  PUBLICATION_POST_NOW_LEAD_MINUTES,
  PUBLICATION_SCHEDULE_HORIZON_DAYS,
  PUBLICATION_START_WINDOW_MINUTES,
  type AppConfig,
  type PublicationKind,
} from "@agency_hub_core/shared";

import type { AppContext } from "../bootstrap.ts";
import { FANSLY_WRITE_STEP_ROUTES } from "../sync/fansly/publish/commands.ts";
import { parseApprovedForm, type ApprovedForm } from "../sync/fansly/publish/derive.ts";
import { enqueueFanslyWriteCommand, FanslyWriteRefusedError } from "../sync/fansly/publish/enqueue.ts";
import { loadEffectiveConfig } from "./effective-config.ts";
import { verifyApprovedPublication } from "./publications.ts";
import { ensureQueueCreated, type QueueCreationClient } from "./sync-queue.ts";

// Wall posts on Fansly (docs/plans/2026-10-23-wall-posts, plan PR 9): every
// minute the worker turns approved Fansly publications into the page's write
// commands — posts into Fansly's own schedule up to 7 days ahead, five per
// page in a row and the next five 10 minutes later; a story at its time, never
// later than 30 minutes after it — and follows each one's chain to its status.
//
// A publication's create is ONE dispatch (`publication_dispatches`, platform
// fansly: the "once" of spec §8.1) and a chain of requests inside it, each a
// command of the page's engine (`fansly_write_commands`, PR 6) with its own
// single attempt: the account media its vault files become (with who sees
// them and the price in mills), a bundle for a paid post of several files or
// with a preview, then the post (`scheduledFor`, `expiresAt`, the walls frozen
// in the approval, `fypFlags`) or the story. A step is queued only once the
// one before it is answered — its request is derived from that answer (PR 6,
// `publish/derive.ts`) — so this job queues the next step each minute.
//
// The publication follows its commands exactly as OnlyFans follows its owner
// action: the post or story answered with its id → "scheduled" (a fresh read
// later says whether it went out); Fansly refused a step → "rejected"; the
// post's or story's own answer lost → "unknown" (never sent again, a person or
// a read decides, spec §8.2); a step before it lost or never sent → "missed":
// the post's request surely never left. A step a switch or a stop held back is
// queued again while its window lasts; the window passed → "missed".
//
// Nothing goes while a route is unverified (`FANSLY_VERIFIED_WRITE_ROUTES`,
// packages/fansly/src/wire/publish.ts, empty until the stand's session 0.2):
// such a publication stays approved, no dispatch is written. New files wait for
// PR 8 (a blocking finding on Fansly pages, `fansly_file_upload_unsupported`).

export const PUBLICATIONS_FANSLY_QUEUE = "publications.fansly";

const MINUTE_MS = 60_000;
const DAY_MS = 24 * 60 * MINUTE_MS;

export async function ensurePublicationsFanslyQueue(boss: QueueCreationClient, createdQueues?: Set<string>) {
  await ensureQueueCreated(boss, PUBLICATIONS_FANSLY_QUEUE, { policy: "exclusive" }, createdQueues);
}

export async function ensurePublicationsFanslySchedule(boss: QueueCreationClient) {
  if (!boss.schedule) return;
  await boss.schedule(PUBLICATIONS_FANSLY_QUEUE, "* * * * *", null, { tz: "UTC" });
}

// ---------------------------------------------------------------------------
// The chain and its windows (pure)
// ---------------------------------------------------------------------------

/**
 * The requests of a publication's create, in order (spec §5), for vault media:
 * the account media of its files, a bundle when a paid post has several files
 * or a preview, then the post or the story. A post without files is the post
 * alone. Null: a new file is among the media — the page's browser cannot
 * upload it yet (plan PR 8).
 */
export function fanslyCreateChain(form: Pick<ApprovedForm, "kind" | "media">): FanslyWriteStep[] | null {
  if (form.media.some((media) => media.source !== "vault" || media.mediaRef === null)) return null;
  const files = form.media.filter((media) => media.role === "media").length;
  const previews = form.media.filter((media) => media.role === "preview").length;
  if (form.kind === "story") return ["account_media", "story"];
  if (files === 0) return ["post"];
  if (form.kind === "paid_post" && (files > 1 || previews > 0)) return ["account_media", "account_media_bundle", "post"];
  return ["account_media", "post"];
}

export type FanslyDispatchPlan = { action: "send"; mode: PublicationDispatchMode } | { action: "wait" } | { action: "missed" };

/**
 * How a due publication goes out at `now` (as on OnlyFans, plan PR 4b): a story
 * at its time, within the start window; a post into Fansly's schedule, or
 * right now when its time is minutes away or just passed. Past the window it
 * is missed: it never goes out late.
 */
export function fanslyDispatchPlan(input: { kind: PublicationKind; publishAt: Date; now: Date }): FanslyDispatchPlan {
  const untilMs = input.publishAt.getTime() - input.now.getTime();
  if (-untilMs > PUBLICATION_START_WINDOW_MINUTES * MINUTE_MS) return { action: "missed" };
  if (input.kind === "story") return untilMs > 0 ? { action: "wait" } : { action: "send", mode: "story" };
  if (untilMs > PUBLICATION_SCHEDULE_HORIZON_DAYS * DAY_MS) return { action: "wait" };
  return { action: "send", mode: untilMs <= PUBLICATION_POST_NOW_LEAD_MINUTES * MINUTE_MS ? "now" : "scheduled" };
}

/**
 * The window every request of a create is sent in, and its priority (spec
 * §3.5, §8.3): a story's chain is urgent and ends 30 minutes after its time;
 * a post sent now ends there too; a post into Fansly's schedule carries its
 * time as `scheduledFor`, which must stay ahead — its chain ends a minute
 * before it.
 */
export function fanslyCommandWindow(mode: PublicationDispatchMode, publishAt: Date): { notAfter: Date; priority: FanslyWritePriority } {
  if (mode === "scheduled") return { notAfter: new Date(publishAt.getTime() - MINUTE_MS), priority: "background" };
  const notAfter = new Date(publishAt.getTime() + PUBLICATION_START_WINDOW_MINUTES * MINUTE_MS);
  return { notAfter, priority: mode === "story" ? "urgent" : "background" };
}

/** Refusals that say a switch or a stop held the request back, not the
 *  request itself: the step is queued again, while its window lasts, once the
 *  guard lets it (the enqueue refuses before writing anything until then). */
const SWITCH_REFUSAL = /^(publishing_off|page_publishing_off|transport_node|route_unverified|page_stopped:.*)$/;

/** A step refused this many times for anything else (its request derived
 *  wrong, the browser would not let it go) is given up: the post is missed. */
export const FANSLY_STEP_MAX_REFUSALS = 3;

export type FanslyCreateNext =
  /** Queue this step (the first, the one after an answered step, or again
   *  after a switch held it back). */
  | { kind: "enqueue"; step: FanslyWriteStep }
  /** A step is queued or on the wire. */
  | { kind: "in_flight" }
  | { kind: "settle"; to: "scheduled" | "rejected" | "unknown" | "missed"; reason: string | null; platformPostRef: string | null };

function answeredId(command: FanslyWriteCommandRecord): string | null {
  const value = command.step === "story" ? command.result?.storyId : command.result?.postId;
  return typeof value === "string" && value.length > 0 ? value : null;
}

/**
 * Where a create's chain stands, from its commands (every row of the dispatch,
 * refused ones too). One live row per step at most (the table's unique index).
 */
export function fanslyCreateNext(input: {
  chain: readonly FanslyWriteStep[];
  commands: readonly FanslyWriteCommandRecord[];
  now: Date;
  notAfter: Date;
}): FanslyCreateNext {
  for (const [index, step] of input.chain.entries()) {
    const last = index === input.chain.length - 1;
    const rows = input.commands.filter((command) => command.step === step && command.item === "");
    const live = rows.find((command) => command.state !== "refused");
    if (live !== undefined) {
      switch (live.state) {
        case "queued":
        case "sending":
          return { kind: "in_flight" };
        case "answered": {
          if (!last) continue;
          const ref = answeredId(live);
          // The apply answers a post or story only with its id: anything else
          // is no proof of what Fansly made of it.
          return ref === null
            ? { kind: "settle", to: "unknown", reason: `${step}:answer_without_id`, platformPostRef: null }
            : { kind: "settle", to: "scheduled", reason: null, platformPostRef: ref };
        }
        case "rejected":
          return { kind: "settle", to: "rejected", reason: `${step}:${live.stateReason ?? "rejected"}`, platformPostRef: null };
        case "unknown":
          // The post or story itself may have gone: a person or a read
          // decides. A step before it: the post was never sent.
          return last
            ? { kind: "settle", to: "unknown", reason: `${step}:${live.stateReason ?? "unknown"}`, platformPostRef: null }
            : { kind: "settle", to: "missed", reason: `not_sent:${step}_unknown:${live.stateReason ?? "unknown"}`, platformPostRef: null };
        case "refused":
          break;
      }
    }
    // Nothing of this step is queued or went: queue it, unless its window
    // passed or it keeps being refused.
    if (rows.some((command) => command.stateReason === "window_passed") || input.now.getTime() >= input.notAfter.getTime()) {
      return { kind: "settle", to: "missed", reason: "window_passed", platformPostRef: null };
    }
    const counted = rows.filter((command) => !SWITCH_REFUSAL.test(command.stateReason ?? ""));
    if (counted.length >= FANSLY_STEP_MAX_REFUSALS) {
      return { kind: "settle", to: "missed", reason: `not_sent:${step}:${counted.at(-1)?.stateReason ?? "refused"}`.slice(0, 300), platformPostRef: null };
    }
    return { kind: "enqueue", step };
  }
  return { kind: "in_flight" };
}

// ---------------------------------------------------------------------------
// The tick
// ---------------------------------------------------------------------------

export interface FanslyPublishingReport {
  sending: boolean;
  /** Creates begun this minute (a dispatch and its first request). */
  dispatched: number;
  /** Later steps queued this minute. */
  queued: number;
  settled: number;
  missed: number;
  returnedToDraft: number;
  /** Due publications left approved because a route of their chain is not
   *  verified (`FANSLY_VERIFIED_WRITE_ROUTES`): nothing was written. */
  routesUnverified: number;
  /** Creates the enqueue's guard refused before anything was written. */
  refused: number;
}

export interface FanslyPublishingOptions {
  now?: Date;
  /** Whether a route's contract is verified (default `isFanslyWriteSendable`,
   *  the one list); integration tests pass their own. */
  isSendable?: (spec: FanslyWireId) => boolean;
}

/** One minute's work: follow every create in flight (always), then begin the due ones (when the global switch is on). */
export async function runFanslyPublishingTick(app: AppContext, options: FanslyPublishingOptions = {}): Promise<FanslyPublishingReport> {
  const now = options.now ?? new Date();
  const isSendable = options.isSendable ?? isFanslyWriteSendable;
  const config = await loadEffectiveConfig(app.db, app.config);
  const sending = config.publishingEnabled === true;
  const report: FanslyPublishingReport = {
    sending, dispatched: 0, queued: 0, settled: 0, missed: 0, returnedToDraft: 0, routesUnverified: 0, refused: 0,
  };

  // One create of a page at a time, as a person makes posts one after another.
  const busyPages = new Set<number>();
  for (const item of await listSubmittingFanslyPublications(app.db)) {
    const state = await followCreate(app, item.publicationId, item.dispatch, { now, config, isSendable }, report);
    if (state === "in_flight") busyPages.add(item.pageId);
  }
  if (!sending) return report;

  const due = await listDueFanslyPublications(app.db, {
    now, postsUntil: new Date(now.getTime() + PUBLICATION_SCHEDULE_HORIZON_DAYS * DAY_MS),
  });
  for (const candidate of due) {
    if (busyPages.has(candidate.pageId)) continue;
    const plan = fanslyDispatchPlan({ kind: candidate.kind, publishAt: candidate.publishAt, now });
    if (plan.action === "wait") continue;
    if (plan.action === "missed") {
      if (await transitionPublication(app.db, {
        id: candidate.id, from: "approved", to: "missed", actor: { kind: "hub" }, reason: "window_passed",
      })) report.missed += 1;
      continue;
    }
    const recent = await countPagePublicationDispatchesSince(app.db, candidate.pageId, new Date(now.getTime() - PUBLICATION_BATCH_GAP_MINUTES * MINUTE_MS));
    if (recent >= PUBLICATION_BATCH_SIZE) {
      busyPages.add(candidate.pageId);
      continue;
    }
    const result = await beginCreate(app, candidate.id, plan.mode, { now, config, isSendable }, report);
    if (result === "dispatched") busyPages.add(candidate.pageId);
  }
  return report;
}

interface TickContext {
  now: Date;
  config: Pick<AppConfig, "publishingEnabled">;
  isSendable: (spec: FanslyWireId) => boolean;
}

class PublicationMovedError extends Error {}

/**
 * Begin one approved publication's create: what the person approved must
 * still be exactly what goes (spec §3.3); every route of its chain verified;
 * then, in one transaction, its dispatch, "submitting", and its first request
 * queued — or nothing at all.
 */
async function beginCreate(
  app: AppContext,
  publicationId: number,
  mode: PublicationDispatchMode,
  ctx: TickContext,
  report: FanslyPublishingReport,
): Promise<"dispatched" | "returned" | "unverified" | "refused" | "raced"> {
  const check = await verifyApprovedPublication(app.db, publicationId);
  if (!check.ok) {
    report.returnedToDraft += check.reason === "not_approved" ? 0 : 1;
    return "returned";
  }
  const record = check.record;
  const revisionId = record.approvedRevisionId as number;
  const revision = await getPublicationRevision(app.db, revisionId);
  const form = revision === null ? null : parseApprovedForm(revision.form);
  if (form === null) return "raced";
  const chain = fanslyCreateChain(form);
  if (chain === null) {
    // Approved before the finding existed: a new file cannot go up yet.
    if (await transitionPublication(app.db, {
      id: record.id, from: "approved", to: "draft", actor: { kind: "hub" }, clearApproval: true, reason: "fansly_file_upload_unsupported",
    })) report.returnedToDraft += 1;
    return "returned";
  }
  if (!chain.every((step) => ctx.isSendable(FANSLY_WRITE_STEP_ROUTES[step]))) {
    report.routesUnverified += 1;
    return "unverified";
  }
  const window = fanslyCommandWindow(mode, record.publishAt);
  if (ctx.now.getTime() >= window.notAfter.getTime()) return "raced";
  const outcome = await app.db.transaction(async (rawTx) => {
    const tx = rawTx as unknown as Database;
    const dispatch = await insertPublicationDispatch(tx, {
      publicationId: record.id, revisionId, kind: "create", platform: "fansly", ofapiActionIntentId: null, mode,
    });
    if (dispatch === null) return "raced" as const;
    if (!await transitionPublication(tx, { id: record.id, from: "approved", to: "submitting", actor: { kind: "hub" } })) {
      throw new PublicationMovedError();
    }
    await enqueueFanslyWriteCommand(tx, {
      dispatchId: dispatch.id, step: chain[0] as FanslyWriteStep, item: "", priority: window.priority,
      notBefore: ctx.now, notAfter: window.notAfter, config: ctx.config, now: ctx.now, isSendable: ctx.isSendable,
    });
    return "dispatched" as const;
  }).catch((error: unknown) => {
    // Cancelled or edited between the check and now, or the guard said no:
    // the transaction rolled back, nothing was written.
    if (error instanceof PublicationMovedError) return "raced" as const;
    if (error instanceof FanslyWriteRefusedError) return "refused" as const;
    throw error;
  });
  if (outcome === "dispatched") report.dispatched += 1;
  if (outcome === "refused") report.refused += 1;
  return outcome;
}

/** Follow one create in flight: queue its next step, or settle the publication from its commands. */
async function followCreate(
  app: AppContext,
  publicationId: number,
  dispatch: PublicationDispatchRecord,
  ctx: TickContext,
  report: FanslyPublishingReport,
): Promise<"in_flight" | "settled"> {
  const record = await getPublication(app.db, publicationId);
  if (record === null || record.status !== "submitting") return "settled";
  const [revision, commands] = await Promise.all([
    getPublicationRevision(app.db, dispatch.revisionId),
    listFanslyWriteCommandsOfDispatch(app.db, dispatch.id),
  ]);
  const form = revision === null ? null : parseApprovedForm(revision.form);
  const chain = form === null ? null : fanslyCreateChain(form);
  const window = fanslyCommandWindow(dispatch.mode, record.publishAt);
  const next: FanslyCreateNext = chain === null
    // Never dispatched so: a request that may have left is a person's to
    // decide; none did — nothing went.
    ? commands.some((command) => command.state !== "queued" && command.state !== "refused")
      ? { kind: "settle", to: "unknown", reason: "approval_form_unreadable", platformPostRef: null }
      : { kind: "settle", to: "missed", reason: "not_sent:approval_form_unreadable", platformPostRef: null }
    : fanslyCreateNext({ chain, commands, now: ctx.now, notAfter: window.notAfter });
  if (next.kind === "in_flight") return "in_flight";
  if (next.kind === "enqueue") {
    try {
      const queued = await enqueueFanslyWriteCommand(app.db, {
        dispatchId: dispatch.id, step: next.step, item: "", priority: window.priority,
        notBefore: ctx.now, notAfter: window.notAfter, config: ctx.config, now: ctx.now, isSendable: ctx.isSendable,
      });
      if (queued !== null) report.queued += 1;
      return "in_flight";
    } catch (error) {
      if (!(error instanceof FanslyWriteRefusedError)) throw error;
      // A switch is off or the page stopped: it waits inside its window.
      if (error.reason !== "window_passed") return "in_flight";
      return settle(app, record.id, { kind: "settle", to: "missed", reason: "window_passed", platformPostRef: null }, report);
    }
  }
  return settle(app, record.id, next, report);
}

async function settle(
  app: AppContext,
  publicationId: number,
  next: Extract<FanslyCreateNext, { kind: "settle" }>,
  report: FanslyPublishingReport,
): Promise<"settled"> {
  const moved = await transitionPublication(app.db, {
    id: publicationId, from: "submitting", to: next.to, actor: { kind: "hub" }, reason: next.reason,
    ...(next.platformPostRef === null ? {} : { platformPostRef: next.platformPostRef }),
  }).catch((error: unknown) => {
    // publications_page_platform_post_uidx: the id Fansly answered is already
    // another publication's. The publication waits for a person or a read.
    if ((error as { code?: string }).code !== "23505") throw error;
    return transitionPublication(app.db, {
      id: publicationId, from: "submitting", to: "unknown", actor: { kind: "hub" },
      reason: `answered_id_claimed:${next.platformPostRef ?? ""}`.slice(0, 300),
    });
  });
  if (moved) {
    report.settled += 1;
    if (next.to === "missed") report.missed += 1;
  }
  return "settled";
}
