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
  readMediaLookSource,
  type MediaLookRecord,
} from "@agency_hub_core/db";

import type { AppContext } from "../../bootstrap.ts";
import { MEDIA_LOOK_KEY, isMediaLookImageUrl, mediaLookSubject } from "../../sync/fansly/resources/media-look.ts";
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
// signed URL is read from the newest schedule read, sealed into the work's
// secret, and nothing an agent receives carries a URL, a location or a
// variant list.
//
// The caps, before any work is queued (one transaction under a per-page
// advisory lock, `createMediaLookGuarded`): one look in flight per page (409
// `media_look_in_flight`) and `MEDIA_LOOK_DAILY_LIMIT_PER_PAGE` looks that
// sent a request per UTC day (429 `media_look_daily_limit`; 0 = looks off,
// 503 `media_look_off`). A fresh ready look of the same file and variant is
// answered `cached` and costs nothing, unless the caller asks `fresh`.
//
// A look gets one request (plus its redirects) and is never retried: a failed
// look is the caller's to ask again, and it counts against the cap when a
// request left. When the engine has not answered within the wait (≈ 20 s) the
// look is `queued`; whoever reads it next (its GET, the page's next look)
// finishes it.
//
// This slice finds the signed location in the newest read of the page's Fansly
// schedule: posts in the platform's schedule (by Hub or by hand) and Hub
// publications in status `scheduled`. A published post or a vault file needs
// a fresh read — the next slice's second source.

/** How long a look waits for the page's engine before it answers `queued`. */
export const MEDIA_LOOK_WAIT_MS = 20_000;
/** The default daily limit per page (`MEDIA_LOOK_DAILY_LIMIT_PER_PAGE`). */
export const MEDIA_LOOK_DAILY_LIMIT_DEFAULT = 40;
/** A signed location this close to its expiry is not worth the request. */
const EXPIRY_MARGIN_MS = 120_000;
/** A look in flight with no work this long after it was written lost its enqueue. */
const WORK_MISSING_AFTER_MS = 60_000;

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

/**
 * Finish a look whose engine work has answered: cut its bytes into frames, or
 * close it with the failure the work closed with. A look still in flight is
 * returned as it is. Safe to call from two places at once: only one of them
 * finishes it.
 */
export async function settleMediaLook(app: MediaLookApp, look: MediaLookRecord, now = new Date()): Promise<MediaLookRecord> {
  if (look.status !== "queued" && look.status !== "fetched") return look;
  const work = await mediaLookWorkFacts(app.db, { pageId: look.pageId, resource: MEDIA_LOOK_KEY, subject: mediaLookSubject(look.id) });
  if (work === null) {
    if (now.getTime() - look.createdAt.getTime() < WORK_MISSING_AFTER_MS) return look;
    await failMediaLook(app.db, { pageId: look.pageId, lookId: look.id, failure: "work_missing", requestsSent: 0 });
    return (await getMediaLook(app.db, { pageId: look.pageId, lookId: look.id })) ?? look;
  }
  if (!work.closed) return look;
  // Read after the work: its apply and its close commit together.
  const fresh = await getMediaLook(app.db, { pageId: look.pageId, lookId: look.id });
  if (fresh === null || (fresh.status !== "queued" && fresh.status !== "fetched")) return fresh ?? look;
  const fail = async (failure: string) => {
    await failMediaLook(app.db, { pageId: fresh.pageId, lookId: fresh.id, failure, requestsSent: work.requestsSent });
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
          requestsSent: work.requestsSent,
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
    target: { publicationId: look.publicationId, postRef: look.postRef, index: look.attachmentIndex },
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

/**
 * Look at a file of a post in the page's Fansly schedule. Refusals before
 * anything is written or sent throw a `MediaLookError` with a closed code;
 * a publication or look of another page is `notFound()` (the plane's static
 * 404). The answer is the look as the agent reads it.
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
  const effective = await loadEffectiveConfig(app.db, app.config);
  const limit = dailyLimitOf(effective);
  await assertLookablePage(app, page);
  if (limit === 0) throw new MediaLookError("Media looks are off (MEDIA_LOOK_DAILY_LIMIT_PER_PAGE is 0): ask the owner", 503, "media_look_off");

  // The post: a Hub publication in the platform's schedule, or a post ref.
  let postRef: string;
  let publicationId: number | null = null;
  if (body.publicationId !== undefined) {
    const publication = await getPublication(app.db, body.publicationId);
    if (publication === null || publication.pageId !== page.id) throw input.notFound();
    if (publication.status !== "scheduled") {
      throw conflict("media_look_not_scheduled", `Publication ${publication.id} is ${publication.status}: only a post in the platform's schedule is looked at for now`);
    }
    if (publication.platformPostRef === null) {
      throw conflict("media_look_not_in_schedule", `Publication ${publication.id} names no platform post`);
    }
    postRef = publication.platformPostRef;
    publicationId = publication.id;
  } else {
    postRef = body.postRef!;
  }

  // The file, from the newest read of the page's schedule.
  const facts = await readFanslyPageFacts(app.db, page.id);
  if (facts?.externalId == null) throw conflict("media_look_page_identity_unknown", "Hub does not know the page's own Fansly account yet");
  const observationId = await newestScheduleObservationId(app.db, page.id);
  if (observationId === null) throw conflict("media_look_no_schedule_read", "Hub has no recent read of the page's schedule");
  const resolved = findScheduledPostMedia(await loadScheduleRead(app, observationId), postRef, body.index);
  if (!resolved.ok) {
    const messages = {
      not_in_schedule: `Post ${postRef} is not waiting in the page's schedule as Hub last read it`,
      attachment_not_found: `Post ${postRef} has no file at index ${body.index}`,
      media_not_in_read: `The schedule read does not carry post ${postRef}'s file at index ${body.index}`,
    } as const;
    throw conflict(`media_look_${resolved.reason}`, messages[resolved.reason]);
  }
  // A fan's media is never looked at: only a file of the page's own account.
  if (resolved.ownerAccountRef !== facts.externalId) {
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
  if (expiry !== null && expiry.getTime() - EXPIRY_MARGIN_MS <= now.getTime()) {
    throw conflict("media_look_source_expired", "The schedule read's signed location has expired: wait for the next read of the schedule");
  }

  // A fresh look of the same file and variant: no request.
  if (!body.fresh) {
    const cached = await findFreshMediaLook(app.db, { pageId: page.id, mediaRef: resolved.mediaRef, variant: selection.variant });
    if (cached !== null) return { look: cached, cached: true, wire: await mediaLookWire(app, cached, { frames: body.frames, cached: true, limit }) };
  }

  // The page's looks the engine has answered since are finished first, so a done one does not count as in flight.
  await dropExpiredMediaLookSources(app.db);
  for (const pending of await listUnsettledMediaLooks(app.db, page.id)) await settleMediaLook(app, pending, now);

  const geometry = selection.variant === "sprite" ? selection.geometry : null;
  const created = await createMediaLookGuarded(app.db, {
    pageId: page.id,
    agentKeyId: input.agentKeyId,
    publicationId,
    postRef,
    attachmentIndex: body.index,
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
    dailyLimit: limit,
  });
  if (created.kind === "in_flight") {
    throw conflict("media_look_in_flight", `Look ${created.lookId} of this page is still in flight (one at a time per page): read it, then ask again`);
  }
  if (created.kind === "daily_limit") {
    throw new MediaLookError(`The page's looks today reached the limit (${created.usedToday} of ${limit}, UTC day)`, 429, "media_look_daily_limit");
  }

  // One request through the page's engine, at its pace. The URL is sealed
  // into the work's secret and is nowhere else.
  const look = created.look;
  const { enqueueAndWait, UrgentWorkRefusedError } = await import("../../sync/requests/urgent.ts");
  try {
    const waited = await enqueueAndWait({ db: app.db }, {
      pageId: page.id,
      resource: MEDIA_LOOK_KEY,
      subject: mediaLookSubject(look.id),
      secretParams: encryptSyncWorkSecret(app.config, { url: url.toString() }),
      waitMs: input.waitMs ?? MEDIA_LOOK_WAIT_MS,
      reason: "media_look",
    });
    if (waited.state === "not_live" || waited.state === "switching") {
      await failMediaLook(app.db, { pageId: page.id, lookId: look.id, failure: "engine_not_live", requestsSent: 0 });
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
