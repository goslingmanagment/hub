import { consumeSyncMediaHandoff, latestClosedWorkForKey, type Database } from "@agency_hub_core/db";
import type { AppConfig } from "@agency_hub_core/shared";

import type { Clock, Wake } from "../../sync/engine/ports.ts";
import {
  MEDIA_DOWNLOAD_KEY,
  mediaDownloadSubject,
  type MediaDownloadResultJson,
} from "../../sync/fansly/resources/media-download.ts";
import { encryptSyncWorkSecret } from "../../sync/requests/secret-params.ts";
import { enqueueAndWait, UrgentWorkRefusedError } from "../../sync/requests/urgent.ts";
import { isFanslyCdnUrl, type MediaDownloadFailure, type MediaDownloadResult } from "../egress/media-download.ts";

// The describer's CDN download on a page the Fansly Sync Engine owns (design
// S3-04 item 7; owner decision №17). The engine is the page's only sender, so
// the worker never downloads a Fansly file of a live page itself: it asks the
// page's actor (`media-download.fetch`, the signed URL sealed in the work's
// secret parameters) and waits up to 30 s. The actor's apply leaves the bytes
// in the transient handoff buffer; this side reads them and deletes the row in
// the same statement. A wait that runs out answers `timeout` (the sweep tries
// the row again later), and that retry first looks for a download of the same
// description closed in the last hour — its bytes, with no new request.
// Nothing here logs or keeps the URL.

/** How long the describer waits for the actor (the wrapper's longest wait). */
export const ENGINE_DOWNLOAD_WAIT_MS = 30_000;
/** A download closed this recently is the answer of a retry (no new request). */
export const ENGINE_DOWNLOAD_REUSE_MS = 60 * 60_000;

export interface EngineDownloadContext {
  db: Database;
  config: Pick<AppConfig, "encryptionKey" | "encryptionKeyVersion">;
  /** The work-done wake (none in the worker: the wait re-reads every 250 ms). */
  workDone?: Wake | null;
  clock?: Clock;
  waitMs?: number;
  /** Which URLs may be enqueued. Default: a Fansly media CDN URL (the engine
   *  downloads nothing else). TESTS ONLY pass another (a loopback origin). */
  urlAllowed?: (url: URL) => boolean;
}

const RESULT_FAILURES: ReadonlySet<string> = new Set<MediaDownloadFailure>([
  "host_not_allowed", "redirect_not_allowed", "too_many_redirects", "http_status", "too_large", "timeout", "transport",
]);

function failed(reason: MediaDownloadFailure, httpStatus: number | null = null): MediaDownloadResult {
  return { ok: false, reason, httpStatus };
}

/**
 * The download's answer from a closed work's result: the bytes of its handoff
 * row (consumed now), or its failure. Null when the result names bytes nobody
 * holds any more (consumed or expired) — or no answer at all.
 */
async function answerOf(
  ctx: EngineDownloadContext,
  input: { pageId: number; descriptionId: number },
  result: unknown,
): Promise<MediaDownloadResult | null> {
  const record = typeof result === "object" && result !== null ? result as Partial<Record<string, unknown>> : {};
  if (typeof record.handoffId === "number") {
    const consumed = await consumeSyncMediaHandoff(ctx.db, {
      pageId: input.pageId,
      descriptionId: input.descriptionId,
      handoffId: record.handoffId,
    });
    return consumed === null ? null : { ok: true, bytes: consumed.bytes, contentType: consumed.contentType };
  }
  if (typeof record.failure === "string") {
    const httpStatus = typeof record.httpStatus === "number" ? record.httpStatus : null;
    // A failure of the engine's own (the description erased meanwhile, an
    // unreadable secret) is the describer's transient one: it tries again.
    return RESULT_FAILURES.has(record.failure)
      ? failed(record.failure as MediaDownloadFailure, httpStatus)
      : failed("transport", httpStatus);
  }
  return null;
}

/**
 * Download one chat file of a live page through its actor. `send_guard` when
 * the page is not live any more (the caller looks again later, as for a closed
 * page) or the key is switched off for it; `timeout` when the actor did not
 * answer within the wait, or another download of the same description is
 * already queued.
 */
export async function downloadThroughSyncEngine(
  ctx: EngineDownloadContext,
  input: { url: string; pageId: number; descriptionId: number },
): Promise<MediaDownloadResult> {
  let url: URL;
  try {
    url = new URL(input.url);
  } catch {
    return failed("host_not_allowed");
  }
  // The engine downloads Fansly media only; nothing else is ever enqueued.
  if (!(ctx.urlAllowed ?? isFanslyCdnUrl)(url)) return failed("host_not_allowed");
  const subject = mediaDownloadSubject(input.descriptionId);
  const now = (ctx.clock?.wallNow() ?? new Date()).getTime();
  const recent = await latestClosedWorkForKey(ctx.db, {
    pageId: input.pageId,
    shadow: false,
    resource: MEDIA_DOWNLOAD_KEY,
    subject,
    closedAfter: new Date(now - ENGINE_DOWNLOAD_REUSE_MS),
  });
  if (recent !== null && typeof (recent.result as { handoffId?: unknown } | null)?.handoffId === "number") {
    const reused = await answerOf(ctx, input, recent.result as MediaDownloadResultJson);
    if (reused !== null) return reused;
  }
  let waited;
  try {
    waited = await enqueueAndWait(
      { db: ctx.db, ...(ctx.workDone === undefined ? {} : { workDone: ctx.workDone }), ...(ctx.clock === undefined ? {} : { clock: ctx.clock }) },
      {
        pageId: input.pageId,
        resource: MEDIA_DOWNLOAD_KEY,
        subject,
        secretParams: encryptSyncWorkSecret(ctx.config, { url: url.toString() }),
        waitMs: ctx.waitMs ?? ENGINE_DOWNLOAD_WAIT_MS,
        reason: "ai_describe",
      },
    );
  } catch (error) {
    if (error instanceof UrgentWorkRefusedError) {
      // Another download of this description is queued: its answer is the
      // next retry's (the reuse above). A key switched off for the page is a
      // closed page for the describer.
      return error.reason === "secret_busy" ? failed("timeout") : failed("send_guard");
    }
    throw error;
  }
  switch (waited.state) {
    case "not_live":
      return failed("send_guard");
    case "queued":
      return failed("timeout");
    case "done":
      return (await answerOf(ctx, input, waited.result)) ?? failed("timeout");
  }
}
