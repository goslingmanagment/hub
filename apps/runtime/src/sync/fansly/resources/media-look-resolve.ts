import {
  failMediaLook,
  getMediaLook,
  markMediaLookResolved,
  markObservationParsed,
  mediaLookSpriteFailed,
  NEVER_CANONICALIZED_PARSE_VERSION,
  upsertDemand,
} from "@agency_hub_core/db";

import { cloudFrontExpiry } from "../../../services/ai-media-describe/fansly-source.ts";
import { publishedPostFile, vaultPageFile } from "../../../services/media-looks/answer-files.ts";
import { selectMediaLookSource } from "../../../services/media-looks/select.ts";
import type { OutcomeDecision } from "../../engine/errors.ts";
import {
  demandToUpsert,
  type ApplyInput,
  type ApplyResult,
  type OutcomeStep,
  type RequestPlan,
  type ResourceModule,
  type StepPlan,
} from "../../engine/resource.ts";
import { fanslyResourceSpec } from "../registry.ts";
import { isMediaLookImageUrl, lookIdOfSubject, MEDIA_LOOK_KEY } from "./media-look.ts";

// `media-look.resolve` (owner 2026-11-11): the read a media look of a PUBLISHED
// post or a VAULT file needs first — their signed locations are in no verbatim
// journal. ONE API read of the page, at its pace, as any read of the page:
//
// - a post: `GET /post?ids=<post>` (`posts.by_ids`, what the posts' engagement
//   walk reads daily); its files are the post's attachments, the answer's
//   account media beside them;
// - a vault file: `GET /media/vaultnew?albumId=<album>&before=<member + 1>`
//   (`vault.media`, what the vault walk reads), the page of the album that
//   starts at the file's own membership row — whether or not the file has an
//   offer.
//
// Its apply takes the file from the answer IN MEMORY (the journal's copy has
// its signing tokens stripped, sync/fansly/lib/cdn-tokens.ts), checks that it
// is the page's own, picks the image with the looks' one selector
// (services/media-looks/select.ts), names the file on the look and queues the
// look's image request (`media-look.fetch`) with the URL sealed in that work's
// secret — the only place it is ever written. Its result names the look and
// nothing of the URL. Read back from the journal (a restart before the apply)
// the answer has no signed location: the look fails `source_not_in_memory`,
// and nothing is read again.
//
// The read is journaled and never canonicalized (as the excluded-chat probe's):
// a lone page of an album is no walk, and a look is not the page's sync. Any
// answer but a success closes the work: a look gets one read, never a retry.

export const MEDIA_LOOK_RESOLVE_KEY = "media-look.resolve";

/** What the look's read is, as the work's (non-secret) parameters. */
export type MediaLookResolveParams =
  | { target: "post"; postRef: string; index: number; cover: boolean }
  | { target: "vault"; mediaRef: string; albumRef: string; before: string; cover: boolean };

const ID = /^[0-9]{1,24}$/;

export function parseMediaLookResolveParams(value: unknown): MediaLookResolveParams | null {
  const p = typeof value === "object" && value !== null ? value as Record<string, unknown> : {};
  const cover = p.cover === true;
  if (p.target === "post" && typeof p.postRef === "string" && ID.test(p.postRef)
    && typeof p.index === "number" && Number.isInteger(p.index) && p.index >= 0 && p.index <= 99) {
    return { target: "post", postRef: p.postRef, index: p.index, cover };
  }
  if (p.target === "vault" && typeof p.mediaRef === "string" && ID.test(p.mediaRef)
    && typeof p.albumRef === "string" && ID.test(p.albumRef) && typeof p.before === "string" && ID.test(p.before)) {
    return { target: "vault", mediaRef: p.mediaRef, albumRef: p.albumRef, before: p.before, cover };
  }
  return null;
}

/** The `before` cursor whose vault page starts at a membership row: its own id + 1. */
export function vaultPageCursorAt(memberRef: string): string {
  return (BigInt(memberRef) + 1n).toString();
}

function readOf(params: MediaLookResolveParams): RequestPlan {
  return params.target === "post"
    ? { spec: "posts.by_ids", params: { ids: [params.postRef] } }
    : { spec: "vault.media", params: { albumId: params.albumRef, before: params.before } };
}

/** The read's own account of an outcome: any answer but a success closes it —
 *  a look's read is never retried. The page's and the route's holds stand as
 *  decided (a 401 is the session's, a 429 the route's). */
export function mediaLookResolveOutcome(decision: OutcomeDecision, step: OutcomeStep): OutcomeDecision {
  if (decision.work.action === "apply") return decision;
  return {
    ...decision,
    work: {
      action: "close",
      closeReason: `resolve_failed:${decision.errorClass}`,
      result: { failure: `resolve_${decision.errorClass}`, httpStatus: step.httpStatus },
    },
  };
}

export const mediaLookResolveModule: ResourceModule = {
  async plan(work): Promise<StepPlan> {
    const params = parseMediaLookResolveParams(work.params);
    if (lookIdOfSubject(work.subject) === null || params === null) {
      return { kind: "done", reason: "bad_subject", result: { failure: "bad_subject" } };
    }
    return { kind: "request", request: readOf(params) };
  },

  async apply(tx, input: ApplyInput): Promise<ApplyResult> {
    // Journaled, never canonicalized: no events, no projection of a lone page.
    await markObservationParsed(tx, {
      observationId: input.observation.id,
      receivedAt: input.observation.receivedAt,
      parseVersion: NEVER_CANONICALIZED_PARSE_VERSION,
    });
    const closed = (result: Record<string, unknown>, closeReason: string): ApplyResult => ({
      work: { satisfiesRevision: true, close: "done", closeReason, result },
      followups: [],
      canonicalized: true,
      counters: { [closeReason.split(":", 1)[0]!]: 1 },
    });
    const lookId = lookIdOfSubject(input.work.subject);
    const params = parseMediaLookResolveParams(input.work.params);
    if (lookId === null || params === null) return closed({ failure: "bad_subject" }, "bad_subject");
    const look = await getMediaLook(tx, { pageId: input.pageId, lookId });
    if (look === null || look.status !== "resolving") return closed({ lookId, failure: "look_gone" }, "look_gone");
    // This very read was sent: the look's one request so far.
    const fail = async (failure: string): Promise<ApplyResult> => {
      await failMediaLook(tx, { pageId: input.pageId, lookId, failure, requestsSent: 1 });
      return closed({ lookId, failure }, `look_failed:${failure}`);
    };

    const found = params.target === "post"
      ? publishedPostFile(input.response, params.postRef, params.index)
      : vaultPageFile(input.response, params.mediaRef);
    if (!found.ok) return fail(found.reason === "post_not_in_answer" ? "post_not_in_read" : found.reason);
    // A fan's media is never looked at: only a file of the page's own account.
    if (input.ownRef === null || found.ownerAccountRef !== input.ownRef) return fail("foreign_media");
    const options = {
      cover: params.cover,
      spriteUnusable: await mediaLookSpriteFailed(tx, { pageId: input.pageId, mediaRef: found.mediaRef }),
    };
    const selection = selectMediaLookSource(found.media, options);
    if (!selection.ok) {
      // A still image is there, its signature is not: the journal's copy.
      const stripped = selectMediaLookSource(found.media, { ...options, allowUnsigned: true }).ok;
      return fail(stripped ? "source_not_in_memory" : selection.reason);
    }
    const url = new URL(selection.url);
    if (!isMediaLookImageUrl(url)) return fail("no_image_variant");
    const expiry = cloudFrontExpiry(selection.url);
    if (expiry !== null && expiry.getTime() <= input.now.getTime()) return fail("source_expired");
    if (input.secrets == null) return fail("secret_box_missing");
    const fetchSpec = fanslyResourceSpec(MEDIA_LOOK_KEY);
    const upsert = fetchSpec === null
      ? null
      : demandToUpsert({ resource: MEDIA_LOOK_KEY, subject: input.work.subject, demand: { reason: `apply:${MEDIA_LOOK_RESOLVE_KEY}` } }, fetchSpec, {
        pageId: input.pageId, now: input.now, page: input.page,
      });
    if (upsert === null) return fail("engine_disabled_for_page");

    const geometry = selection.variant === "sprite" ? selection.geometry : null;
    const named = await markMediaLookResolved(tx, {
      pageId: input.pageId,
      lookId,
      resolved: {
        mediaRef: found.mediaRef,
        mediaType: selection.mediaType,
        variant: selection.variant,
        coverage: selection.coverage,
        durationMs: selection.durationMs,
        frameIntervalMs: geometry === null ? null : Math.max(1, Math.round(geometry.intervalMs)),
        frameCount: geometry?.count ?? null,
        gridCols: geometry?.gridA ?? null,
        gridRows: geometry?.gridB ?? null,
        cellWidth: geometry?.cellWidth ?? null,
        cellHeight: geometry?.cellHeight ?? null,
      },
    });
    if (!named) return closed({ lookId, failure: "look_gone" }, "look_gone");
    // The look's image request, its URL sealed in the work's secret and nowhere else.
    const queued = await upsertDemand(tx, { ...upsert, secretParams: input.secrets.seal({ url: url.toString() }), createOnly: true });
    if (!queued.created) return fail("fetch_already_queued");
    return closed({ lookId, resolved: true, variant: selection.variant }, "look_resolved");
  },

  outcome: mediaLookResolveOutcome,
};
