import type { AgentMediaLookCreateBody, MediaLook, MediaLookCoverage, MediaLookFramesMode } from "@agency_hub_core/contracts";
import {
  completeMediaLook,
  countMediaLooksToday,
  createMediaLookGuarded,
  dropExpiredMediaLookSources,
  failMediaLook,
  findFreshMediaLook,
  getMediaLook,
  getPublication,
  isFanslyPageEngineOwned,
  listMediaLookFrames,
  listUnsettledMediaLooks,
  mediaLookSpriteFailed,
  mediaLookWorkFacts,
  pagePostFileRefs,
  pageVaultFile,
  readMediaLookSource,
  type MediaLookRecord,
  type MediaLookVariant,
  type NewMediaLook,
} from "@agency_hub_core/db";

import type { AppContext } from "../../bootstrap.ts";
import { MEDIA_LOOK_KEY, isMediaLookImageUrl, mediaLookSubject } from "../../sync/fansly/resources/media-look.ts";
import {
  MEDIA_LOOK_RESOLVE_KEY,
  vaultPageCursorAt,
  type MediaLookResolveParams,
} from "../../sync/fansly/resources/media-look-resolve.ts";
import { readFanslyPageFacts } from "../../sync/fansly/lib/page-facts.ts";
import { encryptSyncWorkSecret } from "../../sync/requests/secret-params.ts";
import { cloudFrontExpiry } from "../ai-media-describe/fansly-source.ts";
import { loadEffectiveConfig } from "../effective-config.ts";
import { AppError } from "../errors.ts";
import { cutMediaLookFrames, type MediaLookCutPlan } from "./cut.ts";
import { findScheduledPostMedia, loadScheduleRead, newestScheduleObservationId } from "./schedule-source.ts";
import { selectMediaLookSource } from "./select.ts";

// Media looks (owner 2026-11-11): an agent key with look:media sees frames
// (≤ 512 px) of a file of its page's posts — Hub pulls ONE image through the
// page's own session at its pace (`media-look.fetch`), cuts it here, in the
// API process, and keeps the frames 7 days. Never the file, never a link: the
// signed URL lives only sealed in the image work's secret, and nothing an
// agent receives carries a URL, a location or a variant list.
//
// The caps, before any work is queued (one transaction under a per-page
// advisory lock, `createMediaLookGuarded`): one look in flight per page (409
// `media_look_in_flight`) and `MEDIA_LOOK_DAILY_LIMIT_PER_PAGE` looks that
// sent a request per UTC day (429 `media_look_daily_limit`; 0 = looks off,
// 503 `media_look_off`). A fresh ready look of the same file and variant is
// answered `cached` and costs nothing, unless the caller asks `fresh`.
//
// Where the signed location comes from:
// - a post waiting in the platform's schedule (by Hub or by hand; a Hub
//   publication in status `scheduled`): the newest read of the page's
//   schedule, journaled verbatim — ONE request, the image;
// - a published post Hub has among the page's own posts (a Hub publication in
//   status `published`), or a file of the page's own vault: the page's engine
//   reads the post or the file's vault page first (`media-look.resolve`), and
//   its apply queues the image request with the URL sealed — TWO requests,
//   still ONE look against the cap (`requests_sent` says how many left).
//
// A look's requests are never retried: a failed look is the caller's to ask
// again, and it counts against the cap when a request left. When the engine
// has not answered within the wait (≈ 20 s, both requests together) the look
// is `queued`; whoever reads it next (its GET, the page's next look) finishes
// it.

/** How long a look waits for the page's engine before it answers `queued`. */
export const MEDIA_LOOK_WAIT_MS = 20_000;
/** The default daily limit per page (`MEDIA_LOOK_DAILY_LIMIT_PER_PAGE`). */
export const MEDIA_LOOK_DAILY_LIMIT_DEFAULT = 40;
/** A signed location this close to its expiry is not worth the request. */
const EXPIRY_MARGIN_MS = 120_000;
/** A look in flight with no work this long after it was written lost its enqueue. */
const WORK_MISSING_AFTER_MS = 60_000;
/** How often a look waiting for its image's work reads the work again. */
const WORK_POLL_MS = 250;
const IN_FLIGHT: ReadonlySet<MediaLookRecord["status"]> = new Set(["resolving", "queued", "fetched"]);

/** A refusal before anything was written or sent, with its closed code. */
export class MediaLookError extends AppError {
  constructor(message: string, statusCode: number, code: string) {
    super(message, statusCode, code);
    this.name = "MediaLookError";
  }
}

const conflict = (code: string, message: string) => new MediaLookError(message, 409, code);

export interface MediaLookPage {
  id: number;
  pageLabel: string;
  platform: string;
}

export type MediaLookApp = Pick<AppContext, "db" | "config" | "logger">;

export interface MediaLookAnswer {
  wire: MediaLook;
  look: MediaLookRecord;
}

const COVERAGE_NOTES: Record<MediaLookCoverage, (look: MediaLookRecord) => string> = {
  per_second: (look) => `A sample, not the video: one frame per second (${look.frameCount ?? 0} frames). What happens between two`
    + " frames is not seen: \"not visible in the frames\" is not \"checked\".",
  sampled: (look) => `A sample, not the video: one frame every ${((look.frameIntervalMs ?? 0) / 1000).toFixed(1)} s`
    + ` (${look.frameCount ?? 0} frames). What happens between two frames is not seen: "not visible in the frames" is`
    + " not \"checked\".",
  cover_only: () => "The video's cover only: one picture the platform chose. The video itself is not seen.",
  whole_image: () => "The whole photo, downscaled to at most 512 px.",
  first_frame: () => "The first frame of an animated image only; the rest of it is not seen.",
};

function dailyLimitOf(config: { mediaLookDailyLimitPerPage?: number }): number {
  const value = config.mediaLookDailyLimitPerPage;
  return typeof value === "number" && Number.isInteger(value) && value >= 0 ? value : MEDIA_LOOK_DAILY_LIMIT_DEFAULT;
}

/** The plan a look's bytes are cut by. */
function cutPlanOf(look: MediaLookRecord): MediaLookCutPlan | null {
  if (look.variant !== "sprite") return { kind: "still" };
  if (look.gridCols === null || look.gridRows === null || look.cellWidth === null || look.cellHeight === null
    || look.frameCount === null || look.frameIntervalMs === null) {
    return null;
  }
  return {
    kind: "sprite",
    gridA: look.gridCols,
    gridB: look.gridRows,
    cellWidth: look.cellWidth,
    cellHeight: look.cellHeight,
    count: look.frameCount,
    intervalMs: look.frameIntervalMs,
  };
}

/** A closed fetch's failure, as a look's closed code. */
export function mediaLookFetchFailure(result: unknown, closeReason: string | null): string {
  const record = typeof result === "object" && result !== null ? result as Record<string, unknown> : {};
  const failure = typeof record.failure === "string" && /^[a-z_]{1,40}$/.test(record.failure) ? record.failure : null;
  if (failure === "http_status" && typeof record.httpStatus === "number") return `fetch_http_${record.httpStatus}`;
  if (failure !== null) return `fetch_${failure}`;
  const reason = (closeReason ?? "").toLowerCase().replace(/[^a-z0-9_]/g, "_").slice(0, 40);
  return reason === "" ? "fetch_not_answered" : `fetch_closed_${reason}`;
}

/** A closed read's failure (it closed without naming the file), as a look's closed code. */
export function mediaLookResolveFailure(result: unknown, closeReason: string | null): string {
  const record = typeof result === "object" && result !== null ? result as Record<string, unknown> : {};
  if (typeof record.failure === "string" && /^[a-z0-9_]{1,60}$/.test(record.failure)) {
    return record.failure.startsWith("resolve_") ? record.failure : `resolve_${record.failure}`;
  }
  const reason = (closeReason ?? "").toLowerCase().replace(/[^a-z0-9_]/g, "_").slice(0, 40);
  return reason === "" ? "resolve_not_answered" : `resolve_closed_${reason}`;
}

/**
 * Finish a look whose engine work has answered: its read (a published post's,
 * a vault file's) named the file and queued the image, or closed without it;
 * its image's bytes are cut into frames, or the look closes with the failure
 * the work closed with. A look still in flight is returned as it is. Safe to
 * call from two places at once: only one of them finishes it. `requests_sent`
 * is every request of the look's works that may have left.
 */
export async function settleMediaLook(app: MediaLookApp, look: MediaLookRecord, now = new Date()): Promise<MediaLookRecord> {
  if (!IN_FLIGHT.has(look.status)) return look;
  const subject = mediaLookSubject(look.id);
  const reread = async () => (await getMediaLook(app.db, { pageId: look.pageId, lookId: look.id })) ?? look;
  const resolve = look.sourceKind === "schedule_read"
    ? null
    : await mediaLookWorkFacts(app.db, { pageId: look.pageId, resource: MEDIA_LOOK_RESOLVE_KEY, subject });
  const readSent = resolve?.requestsSent ?? 0;

  if (look.status === "resolving") {
    if (resolve === null) {
      if (now.getTime() - look.createdAt.getTime() < WORK_MISSING_AFTER_MS) return look;
      await failMediaLook(app.db, { pageId: look.pageId, lookId: look.id, failure: "work_missing", requestsSent: 0 });
      return reread();
    }
    if (!resolve.closed) return look;
    // Read after the work: its apply and its close commit together.
    const fresh = await reread();
    if (fresh.status !== "resolving") return IN_FLIGHT.has(fresh.status) ? settleMediaLook(app, fresh, now) : fresh;
    // The read closed without naming the file (it did not answer, or its apply could not run).
    await failMediaLook(app.db, {
      pageId: look.pageId, lookId: look.id, failure: mediaLookResolveFailure(resolve.result, resolve.closeReason), requestsSent: readSent,
    });
    return reread();
  }

  const work = await mediaLookWorkFacts(app.db, { pageId: look.pageId, resource: MEDIA_LOOK_KEY, subject });
  if (work === null) {
    if (now.getTime() - look.createdAt.getTime() < WORK_MISSING_AFTER_MS) return look;
    await failMediaLook(app.db, { pageId: look.pageId, lookId: look.id, failure: "work_missing", requestsSent: readSent });
    return reread();
  }
  if (!work.closed) return look;
  const sent = readSent + work.requestsSent;
  // Read after the work: its apply and its close commit together.
  const fresh = await getMediaLook(app.db, { pageId: look.pageId, lookId: look.id });
  if (fresh === null || (fresh.status !== "queued" && fresh.status !== "fetched")) return fresh ?? look;
  const fail = async (failure: string) => {
    await failMediaLook(app.db, { pageId: fresh.pageId, lookId: fresh.id, failure, requestsSent: sent });
  };
  if (fresh.status === "queued") {
    await fail(mediaLookFetchFailure(work.result, work.closeReason));
  } else {
    const source = await readMediaLookSource(app.db, { lookId: fresh.id });
    const plan = cutPlanOf(fresh);
    if (source === null) {
      await fail("source_expired");
    } else if (plan === null) {
      await fail("geometry_missing");
    } else {
      const cut = await cutMediaLookFrames(source.bytes, plan);
      if (!cut.ok) {
        await fail(cut.reason);
      } else {
        await completeMediaLook(app.db, {
          pageId: fresh.pageId,
          lookId: fresh.id,
          requestsSent: sent,
          cut: { coverage: fresh.coverage ?? "whole_image", gridCols: cut.gridCols, gridRows: cut.gridRows, frames: cut.frames },
        });
      }
    }
  }
  return (await getMediaLook(app.db, { pageId: fresh.pageId, lookId: fresh.id })) ?? fresh;
}

/** A look as the agent reads it: no URL, no location, no variant list. */
export async function mediaLookWire(
  app: MediaLookApp,
  look: MediaLookRecord,
  input: { frames: MediaLookFramesMode; cached: boolean; limit: number },
): Promise<MediaLook> {
  const frames = look.status === "ready"
    ? await listMediaLookFrames(app.db, { lookId: look.id, withJpeg: input.frames === "inline" })
    : [];
  const status = look.status === "ready" ? "ready" : look.status === "failed" || look.status === "expired" ? "failed" : "queued";
  const failure = look.status === "expired" ? "frames_expired" : status === "failed" ? look.failure ?? "failed" : null;
  const coverage = status === "queued" || status === "ready" ? look.coverage : null;
  return {
    lookId: look.id,
    status,
    failure,
    target: { publicationId: look.publicationId, postRef: look.postRef, index: look.attachmentIndex, mediaRef: look.mediaRef },
    source: look.sourceKind,
    requestsSent: look.requestsSent,
    media: { type: look.mediaType, durationMs: look.durationMs },
    coverage,
    frameIntervalMs: coverage === "per_second" || coverage === "sampled" ? look.frameIntervalMs : null,
    coverageNote: coverage === null ? null : COVERAGE_NOTES[coverage](look),
    frames: frames.map((frame) => ({
      index: frame.frameIndex,
      atMs: frame.atMs,
      width: frame.width,
      height: frame.height,
      ...(frame.jpeg === null ? {} : { jpegBase64: frame.jpeg.toString("base64") }),
    })),
    cached: input.cached,
    budget: { usedToday: await countMediaLooksToday(app.db, look.pageId), limit: input.limit },
  };
}

/** The page answers looks: a Fansly page whose engine runs it. */
async function assertLookablePage(app: MediaLookApp, page: MediaLookPage): Promise<void> {
  if (page.platform !== "fansly") {
    throw conflict("media_look_fansly_only", `Media looks are Fansly only: ${page.pageLabel} is a ${page.platform} page`);
  }
  const ownership = await isFanslyPageEngineOwned(app.db, page.id);
  if (ownership.mode !== "live") {
    throw conflict("media_look_engine_not_live", `The page's engine does not run ${page.pageLabel} now (${ownership.mode ?? "none"}): nothing can be fetched`);
  }
}

/** What a look is, decided before anything is written: the image from the
 *  schedule's read, or a read of the post or the vault page first. */
type LookPlan =
  | { kind: "schedule"; url: URL; fields: Omit<NewMediaLook, "pageId" | "agentKeyId"> }
  | {
    kind: "read";
    params: MediaLookResolveParams;
    /** The file, when Hub already knows which it is (the cached look's key). */
    knownMediaRef: string | null;
    fields: Omit<NewMediaLook, "pageId" | "agentKeyId">;
  };

const NOTHING_RESOLVED = {
  mediaType: null, variant: null, coverage: null, durationMs: null, frameIntervalMs: null, frameCount: null,
  gridCols: null, gridRows: null, cellWidth: null, cellHeight: null, sourceObservationId: null,
} as const;

/** A post waiting in the schedule's newest read: the image straight from it. */
async function schedulePlan(
  app: MediaLookApp,
  input: { page: MediaLookPage; ownAccountRef: string; postRef: string; publicationId: number | null; body: AgentMediaLookCreateBody; now: Date },
): Promise<LookPlan | "not_in_schedule"> {
  const { page, postRef, body } = input;
  const observationId = await newestScheduleObservationId(app.db, page.id);
  if (observationId === null) return "not_in_schedule";
  const resolved = findScheduledPostMedia(await loadScheduleRead(app, observationId), postRef, body.index);
  if (!resolved.ok) {
    if (resolved.reason === "not_in_schedule") return "not_in_schedule";
    const messages = {
      attachment_not_found: `Post ${postRef} has no file at index ${body.index}`,
      media_not_in_read: `The schedule read does not carry post ${postRef}'s file at index ${body.index}`,
    } as const;
    throw conflict(`media_look_${resolved.reason}`, messages[resolved.reason]);
  }
  // A fan's media is never looked at: only a file of the page's own account.
  if (resolved.ownerAccountRef !== input.ownAccountRef) {
    throw conflict("media_look_foreign_media", `The file at index ${body.index} of post ${postRef} is not the page's own`);
  }
  const selection = selectMediaLookSource(resolved.media, {
    cover: body.cover,
    spriteUnusable: await mediaLookSpriteFailed(app.db, { pageId: page.id, mediaRef: resolved.mediaRef }),
  });
  if (!selection.ok) {
    throw conflict(`media_look_${selection.reason}`, selection.reason === "unsupported_media"
      ? "The file is neither a video nor an image"
      : "The file has no still image Hub may fetch");
  }
  const url = new URL(selection.url);
  if (!isMediaLookImageUrl(url)) throw conflict("media_look_no_image_variant", "The file has no still image Hub may fetch");
  const expiry = cloudFrontExpiry(selection.url);
  if (expiry !== null && expiry.getTime() - EXPIRY_MARGIN_MS <= input.now.getTime()) {
    throw conflict("media_look_source_expired", "The schedule read's signed location has expired: wait for the next read of the schedule");
  }
  const geometry = selection.variant === "sprite" ? selection.geometry : null;
  return {
    kind: "schedule",
    url,
    fields: {
      status: "queued",
      sourceKind: "schedule_read",
      publicationId: input.publicationId,
      postRef,
      attachmentIndex: body.index,
      vaultAlbumRef: null,
      mediaRef: resolved.mediaRef,
      mediaType: selection.mediaType,
      variant: selection.variant,
      sourceObservationId: observationId,
      coverage: selection.coverage,
      durationMs: selection.durationMs,
      frameIntervalMs: geometry === null ? null : Math.max(1, Math.round(geometry.intervalMs)),
      frameCount: geometry?.count ?? null,
      gridCols: geometry?.gridA ?? null,
      gridRows: geometry?.gridB ?? null,
      cellWidth: geometry?.cellWidth ?? null,
      cellHeight: geometry?.cellHeight ?? null,
    },
  };
}

/** What the look is of: the schedule's read when the post waits there, else a read by the page's engine. */
async function planLook(
  app: MediaLookApp,
  input: { page: MediaLookPage; ownAccountRef: string; body: AgentMediaLookCreateBody; notFound: () => Error; now: Date },
): Promise<LookPlan> {
  const { page, body } = input;
  if (body.mediaRef !== undefined) {
    // A file of the page's own vault: its vault page, from the file's own membership row.
    const file = await pageVaultFile(app.db, { pageId: page.id, mediaRef: body.mediaRef, ownAccountRef: input.ownAccountRef });
    if (file === "not_own") {
      throw conflict("media_look_media_not_seen", `Hub has no file ${body.mediaRef} of the page's own account in its media`);
    }
    if (file === "not_in_vault") {
      throw conflict("media_look_not_in_vault", `File ${body.mediaRef} is in no album of the page's vault as Hub last walked it: look at it through a post`);
    }
    return {
      kind: "read",
      knownMediaRef: body.mediaRef,
      params: { target: "vault", mediaRef: body.mediaRef, albumRef: file.albumRef, before: vaultPageCursorAt(file.memberRef), cover: body.cover },
      fields: {
        ...NOTHING_RESOLVED, status: "resolving", sourceKind: "vault_read", publicationId: null, postRef: null,
        attachmentIndex: null, vaultAlbumRef: file.albumRef, mediaRef: body.mediaRef,
      },
    };
  }

  // A post: a Hub publication's, or a post ref.
  let postRef: string;
  let publicationId: number | null = null;
  let published = false;
  if (body.publicationId !== undefined) {
    const publication = await getPublication(app.db, body.publicationId);
    if (publication === null || publication.pageId !== page.id) throw input.notFound();
    if (publication.status !== "scheduled" && publication.status !== "published") {
      throw conflict("media_look_publication_status", `Publication ${publication.id} is ${publication.status}: only a scheduled or a published post is looked at`);
    }
    if (publication.platformPostRef === null) {
      throw conflict("media_look_post_not_seen", `Publication ${publication.id} names no platform post`);
    }
    postRef = publication.platformPostRef;
    publicationId = publication.id;
    published = publication.status === "published";
  } else {
    postRef = body.postRef!;
  }
  if (!published) {
    const fromSchedule = await schedulePlan(app, { page, ownAccountRef: input.ownAccountRef, postRef, publicationId, body, now: input.now });
    if (fromSchedule !== "not_in_schedule") return fromSchedule;
    if (publicationId !== null) {
      throw conflict("media_look_not_in_schedule", `Publication ${publicationId}'s post ${postRef} is not waiting in the page's schedule as Hub last read it`);
    }
  }
  // A published post: only one Hub has among this page's own posts (a Hub publication's is the page's by its own record).
  const files = await pagePostFileRefs(app.db, { pageId: page.id, postRef });
  if (files === null && publicationId === null) {
    throw conflict("media_look_post_not_seen", `Hub has not seen post ${postRef} among the page's own posts, in its schedule or on its wall`);
  }
  return {
    kind: "read",
    knownMediaRef: files?.[body.index] ?? null,
    params: { target: "post", postRef, index: body.index, cover: body.cover },
    fields: {
      ...NOTHING_RESOLVED, status: "resolving", sourceKind: "post_read", publicationId, postRef,
      attachmentIndex: body.index, vaultAlbumRef: null, mediaRef: null,
    },
  };
}

/** A fresh ready look of the file: what the asked variant may be answered with. */
async function cachedLookOf(app: MediaLookApp, input: { pageId: number; mediaRef: string; cover: boolean }): Promise<MediaLookRecord | null> {
  const variants: MediaLookVariant[] = input.cover
    ? ["cover"]
    : await mediaLookSpriteFailed(app.db, input) ? ["cover", "image"] : ["sprite", "image"];
  for (const variant of variants) {
    const cached = await findFreshMediaLook(app.db, { pageId: input.pageId, mediaRef: input.mediaRef, variant });
    if (cached !== null) return cached;
  }
  return null;
}

/** Wait until the look's image work closed, or the deadline. */
async function waitForImage(app: MediaLookApp, look: MediaLookRecord, deadlineMs: number): Promise<void> {
  for (;;) {
    const work = await mediaLookWorkFacts(app.db, { pageId: look.pageId, resource: MEDIA_LOOK_KEY, subject: mediaLookSubject(look.id) });
    const remaining = deadlineMs - Date.now();
    if (work?.closed === true || remaining <= 0) return;
    await new Promise((resolve) => setTimeout(resolve, Math.min(WORK_POLL_MS, remaining)));
  }
}

/**
 * Look at a file of the page: a post in its Fansly schedule, a published post
 * of its own, or a file of its own vault. Refusals before anything is written
 * or sent throw a `MediaLookError` with a closed code; a publication or look of
 * another page is `notFound()` (the plane's static 404). The answer is the look
 * as the agent reads it.
 */
export async function createMediaLook(
  app: MediaLookApp,
  input: {
    page: MediaLookPage;
    agentKeyId: number;
    body: AgentMediaLookCreateBody;
    notFound: () => Error;
    waitMs?: number;
    now?: Date;
  },
): Promise<MediaLookAnswer & { cached: boolean }> {
  const { page, body } = input;
  const now = input.now ?? new Date();
  const waitMs = input.waitMs ?? MEDIA_LOOK_WAIT_MS;
  const deadlineMs = Date.now() + waitMs;
  const effective = await loadEffectiveConfig(app.db, app.config);
  const limit = dailyLimitOf(effective);
  await assertLookablePage(app, page);
  if (limit === 0) throw new MediaLookError("Media looks are off (MEDIA_LOOK_DAILY_LIMIT_PER_PAGE is 0): ask the owner", 503, "media_look_off");
  const facts = await readFanslyPageFacts(app.db, page.id);
  if (facts?.externalId == null) throw conflict("media_look_page_identity_unknown", "Hub does not know the page's own Fansly account yet");

  const plan = await planLook(app, { page, ownAccountRef: facts.externalId, body, notFound: input.notFound, now });

  // A fresh look of the same file: no request.
  if (!body.fresh) {
    const mediaRef = plan.kind === "schedule" ? plan.fields.mediaRef : plan.knownMediaRef;
    const cached = mediaRef === null
      ? null
      : plan.kind === "schedule"
        ? await findFreshMediaLook(app.db, { pageId: page.id, mediaRef, variant: plan.fields.variant! })
        : await cachedLookOf(app, { pageId: page.id, mediaRef, cover: body.cover });
    if (cached !== null) return { look: cached, cached: true, wire: await mediaLookWire(app, cached, { frames: body.frames, cached: true, limit }) };
  }

  // The page's looks the engine has answered since are finished first, so a done one does not count as in flight.
  await dropExpiredMediaLookSources(app.db);
  for (const pending of await listUnsettledMediaLooks(app.db, page.id)) await settleMediaLook(app, pending, now);

  const created = await createMediaLookGuarded(app.db, { pageId: page.id, agentKeyId: input.agentKeyId, ...plan.fields, dailyLimit: limit });
  if (created.kind === "in_flight") {
    throw conflict("media_look_in_flight", `Look ${created.lookId} of this page is still in flight (one at a time per page): read it, then ask again`);
  }
  if (created.kind === "daily_limit") {
    throw new MediaLookError(`The page's looks today reached the limit (${created.usedToday} of ${limit}, UTC day)`, 429, "media_look_daily_limit");
  }

  // Through the page's engine, at its pace: the image (its URL sealed into the
  // work's secret and nowhere else), or the read whose apply queues it.
  const look = created.look;
  const { enqueueAndWait, UrgentWorkRefusedError } = await import("../../sync/requests/urgent.ts");
  try {
    const waited = await enqueueAndWait({ db: app.db }, {
      pageId: page.id,
      resource: plan.kind === "schedule" ? MEDIA_LOOK_KEY : MEDIA_LOOK_RESOLVE_KEY,
      subject: mediaLookSubject(look.id),
      ...(plan.kind === "schedule"
        ? { secretParams: encryptSyncWorkSecret(app.config, { url: plan.url.toString() }) }
        : { params: plan.params }),
      waitMs,
      reason: "media_look",
    });
    if (waited.state === "not_live" || waited.state === "switching") {
      await failMediaLook(app.db, { pageId: page.id, lookId: look.id, failure: "engine_not_live", requestsSent: 0 });
    } else if (plan.kind === "read" && waited.state === "done") {
      // The read answered within the wait: the image goes next, in what is left of it.
      await waitForImage(app, look, deadlineMs);
    }
  } catch (error) {
    if (!(error instanceof UrgentWorkRefusedError)) throw error;
    await failMediaLook(app.db, { pageId: page.id, lookId: look.id, failure: `engine_${error.reason}`, requestsSent: 0 });
  }
  const current = (await getMediaLook(app.db, { pageId: page.id, lookId: look.id })) ?? look;
  const settled = await settleMediaLook(app, current);
  return { look: settled, cached: false, wire: await mediaLookWire(app, settled, { frames: body.frames, cached: false, limit }) };
}

/** A look of the page by its id, finished now when its engine work has answered. */
export async function readMediaLook(
  app: MediaLookApp,
  input: { page: MediaLookPage; lookId: number; frames: MediaLookFramesMode; notFound: () => Error },
): Promise<MediaLookAnswer> {
  const look = await getMediaLook(app.db, { pageId: input.page.id, lookId: input.lookId });
  if (look === null) throw input.notFound();
  await dropExpiredMediaLookSources(app.db);
  const settled = await settleMediaLook(app, look);
  const limit = dailyLimitOf(await loadEffectiveConfig(app.db, app.config));
  return { look: settled, wire: await mediaLookWire(app, settled, { frames: input.frames, cached: false, limit }) };
}
