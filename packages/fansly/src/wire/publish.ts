import { createHash } from "node:crypto";

import type {
  FanslyContractResult,
  FanslyPublishAttachment,
  FanslyPublishAudience,
  FanslyWireHost,
  FanslyWireMethod,
  FanslyWireSpecFor,
} from "./types.ts";

// The publishing routes of a page (docs/plans/2026-10-23-wall-posts, PR 6):
// what Hub sends to put a post on a wall — an upload begun and completed on
// the upload API (mediav2), account media or a bundle of them with their
// audience and price, the post or the story, and a scheduled post taken off
// the schedule. Each one is a POST with a JSON body built of parameters Hub
// decides; the engine records the request's fingerprint on its command before
// the send (`fanslyWriteFingerprint`), and the page's browser lets go only a
// request that matches it (PR 7).
//
// UNVERIFIED: paths and bodies follow the FBuddy map
// (docs/plans/project-browser/fbuddy/02-operations-and-media.md, 2026-09-28),
// not the site itself. Every spec here is `unverified` and the engine sends
// none of them (`isFanslyWriteSendable`) until the stand's capture of the
// site's own requests (session 0.2,
// docs/plans/2026-10-23-wall-posts/fansly-publish-contract.md) confirms or
// corrects each one; the PR that does so lists it in
// `FANSLY_VERIFIED_WRITE_ROUTES` (the one place). The answers
// are journaled whole before anything reads them (`publish_*` kinds).

/** The upload API: mediav2's base, as the site calls it (spec §5). */
export const FANSLY_UPLOAD_BASE_URL = "https://mediav2.fansly.com/api/v1";

/** The path both APIs' routes are under (`fanslyBaseUrl` and the upload
 *  API's): the start of the path a write's fingerprint covers. */
export const FANSLY_WIRE_BASE_PATH = "/api/v1";

/** The version of the fingerprint's form: a change of the form is a new
 *  version, never a silent change of what a fingerprint means. The page's
 *  browser computes the same (apps/page-browser/src/hub-requests/write.ts)
 *  and says this version at hello (wall posts PR 7). */
export const FANSLY_WRITE_FINGERPRINT_VERSION = "fansly-write.v1";

/** A write's body, at most (bytes of its UTF-8): the page's browser lets an
 *  API request's body go in one HTTP/2 DATA frame only (its gate,
 *  apps/page-browser/src/egress/gate.ts `MAX_BODY_BYTES`). A larger one is
 *  refused before it is admitted. */
export const FANSLY_WRITE_BODY_MAX_BYTES = 16 * 1024 - 9;

/** Which of the page's two permissions a write needs (spec §8.4, plan PR 7):
 *  `withdraw` — a scheduled post taken off the schedule (allowed while
 *  publishing is off); `create` — everything else. */
export type FanslyWritePermission = "create" | "withdraw";

export function fanslyWritePermission(id: string): FanslyWritePermission {
  return id === "publish.post_cancel" ? "withdraw" : "create";
}

/**
 * UNVERIFIED (FBuddy map: the permission entries are Price, Follow,
 * SubscriptionTier and List, a price in mills): the entry types an audience
 * is written with. Their codes are the stand's to confirm (spec §12).
 */
export const FANSLY_PERMISSION_TYPE_UNVERIFIED = { subscriptionTier: 1, price: 2 } as const;

/** UNVERIFIED (spec §5, §12): `fypFlags` of a FYP post and of any other. The
 *  site's bundle of 2026-10-08 writes 2 for a "#fyp" text instead; the stand
 *  decides. */
export const FANSLY_FYP_FLAGS_UNVERIFIED = { fyp: 0, notFyp: 4 } as const;

function nonBlank(name: string, value: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new RangeError(`Fansly publishing parameter ${name} must be nonblank`);
  }
  return value;
}

function positive(name: string, value: number): number {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new RangeError(`Fansly publishing parameter ${name} must be a positive integer (got ${value})`);
  }
  return value;
}

function nonNegative(name: string, value: number): number {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new RangeError(`Fansly publishing parameter ${name} must be a non-negative integer (got ${value})`);
  }
  return value;
}

/** Epoch milliseconds, or 0 for "none" (now, never expires). */
function instant(name: string, value: number): number {
  return nonNegative(name, value);
}

function ids(name: string, values: readonly string[]): string[] {
  if (!Array.isArray(values) || values.length === 0) {
    throw new RangeError(`Fansly publishing parameter ${name} takes at least one id`);
  }
  return values.map((value, index) => nonBlank(`${name}[${index}]`, value));
}

/** The permissions of an attachment for one audience (UNVERIFIED encoding). */
export function fanslyPublishPermissions(audience: FanslyPublishAudience): Record<string, unknown> {
  const entry = (type: number, price: number, metadata: string) => ({
    type, flags: 0, price, metadata, validAfter: null, validBefore: null,
  });
  switch (audience.kind) {
    case "everyone":
      return { permissionFlags: [], accountPermissionFlags: { flags: 0, metadata: "" } };
    case "subscribers": {
      const tiers = audience.tierIds.map((tierId, index) => nonBlank(`audience.tierIds[${index}]`, tierId));
      return {
        permissionFlags: [entry(FANSLY_PERMISSION_TYPE_UNVERIFIED.subscriptionTier, 0, JSON.stringify({ subscriptionTierIds: tiers }))],
        accountPermissionFlags: { flags: 0, metadata: "" },
      };
    }
    case "price":
      return {
        permissionFlags: [entry(FANSLY_PERMISSION_TYPE_UNVERIFIED.price, positive("audience.priceMills", audience.priceMills), "")],
        accountPermissionFlags: { flags: 0, metadata: "" },
      };
  }
}

function attachments(values: readonly FanslyPublishAttachment[]): FanslyPublishAttachment[] {
  if (!Array.isArray(values)) throw new RangeError("Fansly publishing parameter attachments must be an array");
  return values.map((item, index) => {
    if (item.contentType !== 1 && item.contentType !== 2) {
      throw new RangeError(`Fansly publishing parameter attachments[${index}].contentType must be 1 or 2`);
    }
    return {
      contentId: nonBlank(`attachments[${index}].contentId`, item.contentId),
      contentType: item.contentType,
      pos: nonNegative(`attachments[${index}].pos`, item.pos),
    };
  });
}

/** A write's answer is journaled before anything reads it; the command's
 *  apply takes the ids it needs from it (`publish/answers.ts`). */
function journalFirst(response: unknown): FanslyContractResult<unknown> {
  return { ok: true, value: response };
}

const noQuery = () => ({});

export type FanslyPublishWireId =
  | "publish.upload_create"
  | "publish.upload_complete"
  | "publish.account_media"
  | "publish.account_media_bundle"
  | "publish.post"
  | "publish.story"
  | "publish.post_cancel";

/**
 * THE switch of Hub's writes to Fansly (wall posts, plan PR 9): the publishing
 * routes whose path, method, body and answer the stand's capture of the
 * site's own requests confirmed (session 0.2,
 * docs/plans/2026-10-23-wall-posts/fansly-publish-contract.md). A route not
 * listed is `unverified`, and nothing can queue or send it
 * (`isFanslyWriteSendable`: the producer, the enqueue, the engine's plan and
 * its admission all ask). Listing a route says its body is the site's — the
 * `permissionFlags` entries and their codes for `account_media` and the
 * bundle, `fypFlags` for the post, the cancel's body — so the PR that lists
 * one fixes those encodings above in the same change. Empty until then.
 */
export const FANSLY_VERIFIED_WRITE_ROUTES: readonly FanslyPublishWireId[] = [];

/** What Hub reads out of Fansly's answers about its own posts (wall posts PR 9). */
export interface FanslyPublishFacts {
  /** `GET /post/scheduled` lists every scheduled post of the account — no
   *  page, no cap: a post absent from it is not in the schedule. */
  scheduleListWhole: boolean;
  /** A scheduled post keeps its id when it goes out: `GET /post?ids=` not
   *  showing it then says it is not on the wall. */
  scheduledPostKeepsId: boolean;
  /** `/account/me`'s `mediaStoryState` (FBuddy's account schema:
   *  `hasActiveStories`, `storyCount`, `updatedAt`) shows the story Hub just
   *  posted. No other story read is known before the stand. */
  storyStateRead: boolean;
}

/**
 * The stand's word on Fansly's answers (session 0.2), beside the routes it
 * verifies: the same PR flips these. Each fact false keeps Hub safe — an
 * absence proves nothing, so a check ends "unknown", never "did not go out";
 * a withdrawal is never confirmed by a read, so no replacement is ever
 * allowed; a story is never "out" by a read. All false until then.
 */
export const FANSLY_PUBLISH_FACTS_VERIFIED: Readonly<FanslyPublishFacts> = {
  scheduleListWhole: false,
  scheduledPostKeepsId: false,
  storyStateRead: false,
};

/** UNVERIFIED (FBuddy counts the entries of this status as scheduled): the
 *  status of a post still in Fansly's schedule. */
export const FANSLY_SCHEDULED_STATUS_ACTIVE_UNVERIFIED = 1;

function writeContract(id: FanslyPublishWireId): "verified" | "unverified" {
  return FANSLY_VERIFIED_WRITE_ROUTES.includes(id) ? "verified" : "unverified";
}

export const FANSLY_PUBLISH_WIRE_SPECS: { readonly [I in FanslyPublishWireId]: FanslyWireSpecFor<I> } = {
  "publish.upload_create": {
    id: "publish.upload_create",
    credentials: "session",
    kind: "publish_upload_create",
    host: "upload",
    method: "POST",
    writeContract: writeContract("publish.upload_create"),
    endpointTemplate: "/media/upload/create",
    legacyOperation: null,
    path: () => "/media/upload/create",
    query: noQuery,
    body: (p) => ({
      fileSize: positive("fileSize", p.fileSize),
      mimeType: nonBlank("mimeType", p.mimeType),
      fileName: nonBlank("fileName", p.fileName),
    }),
    parse: journalFirst,
  },
  "publish.upload_complete": {
    id: "publish.upload_complete",
    credentials: "session",
    kind: "publish_upload_complete",
    host: "upload",
    method: "POST",
    writeContract: writeContract("publish.upload_complete"),
    endpointTemplate: "/media/upload/complete",
    legacyOperation: null,
    path: () => "/media/upload/complete",
    query: noQuery,
    body: (p) => {
      if (!Array.isArray(p.parts) || p.parts.length === 0) throw new RangeError("Fansly publishing parameter parts takes at least one part");
      return {
        id: nonBlank("uploadId", p.uploadId),
        type: p.uploadType,
        partSize: positive("partSize", p.partSize),
        parts: p.parts.map((part, index) => ({
          index: nonNegative(`parts[${index}].index`, part.index),
          eTag: nonBlank(`parts[${index}].eTag`, part.eTag),
        })),
        waitForComplete: 0,
      };
    },
    parse: journalFirst,
  },
  "publish.account_media": {
    id: "publish.account_media",
    credentials: "session",
    kind: "publish_account_media",
    host: "api",
    method: "POST",
    writeContract: writeContract("publish.account_media"),
    endpointTemplate: "/account/media",
    legacyOperation: null,
    path: () => "/account/media",
    query: noQuery,
    body: (p) => {
      const permissions = fanslyPublishPermissions(p.audience);
      return ids("mediaIds", p.mediaIds).map((mediaId) => ({ mediaId, permissions }));
    },
    parse: journalFirst,
  },
  "publish.account_media_bundle": {
    id: "publish.account_media_bundle",
    credentials: "session",
    kind: "publish_account_media_bundle",
    host: "api",
    method: "POST",
    writeContract: writeContract("publish.account_media_bundle"),
    endpointTemplate: "/account/media/bundle",
    legacyOperation: null,
    path: () => "/account/media/bundle",
    query: noQuery,
    body: (p) => ({
      accountMediaIds: ids("accountMediaIds", p.accountMediaIds),
      permissions: fanslyPublishPermissions(p.audience),
      previewId: p.previewMediaId === null ? null : nonBlank("previewMediaId", p.previewMediaId),
    }),
    parse: journalFirst,
  },
  "publish.post": {
    id: "publish.post",
    credentials: "session",
    kind: "publish_post",
    host: "api",
    method: "POST",
    writeContract: writeContract("publish.post"),
    endpointTemplate: "/post",
    legacyOperation: null,
    path: () => "/post",
    query: noQuery,
    body: (p) => {
      if (typeof p.content !== "string") throw new RangeError("Fansly publishing parameter content must be text");
      const scheduledFor = instant("scheduledForMs", p.scheduledForMs);
      const expiresAt = instant("expiresAtMs", p.expiresAtMs);
      if (expiresAt !== 0 && expiresAt <= scheduledFor) throw new RangeError("Fansly publishing parameter expiresAtMs must be after scheduledForMs");
      return {
        content: p.content,
        fypFlags: p.fyp ? FANSLY_FYP_FLAGS_UNVERIFIED.fyp : FANSLY_FYP_FLAGS_UNVERIFIED.notFyp,
        attachments: attachments(p.attachments),
        scheduledFor,
        expiresAt,
        wallIds: ids("wallIds", p.wallIds),
        postReplyPermissionFlags: [],
      };
    },
    parse: journalFirst,
  },
  "publish.story": {
    id: "publish.story",
    credentials: "session",
    kind: "publish_story",
    host: "api",
    method: "POST",
    writeContract: writeContract("publish.story"),
    endpointTemplate: "/mediastories",
    legacyOperation: null,
    path: () => "/mediastories",
    query: noQuery,
    body: (p) => {
      if (p.contentType !== 1 && p.contentType !== 2) throw new RangeError("Fansly publishing parameter contentType must be 1 or 2");
      return { contentType: p.contentType, contentId: nonBlank("contentId", p.contentId) };
    },
    parse: journalFirst,
  },
  "publish.post_cancel": {
    id: "publish.post_cancel",
    credentials: "session",
    kind: "publish_post_cancel",
    host: "api",
    method: "POST",
    writeContract: writeContract("publish.post_cancel"),
    endpointTemplate: "/post/scheduled/:postId/cancel",
    legacyOperation: null,
    path: (p) => `/post/scheduled/${encodeURIComponent(nonBlank("postId", p.postId))}/cancel`,
    query: noQuery,
    body: () => ({}),
    parse: journalFirst,
  },
};

/** The parts of a write request its fingerprint covers. */
export interface FanslyWriteFingerprintInput {
  method: FanslyWireMethod;
  /** The host's class (`api`, `upload`), never its name: the page's browser
   *  sends Hub's requests on a service address (PR 7). */
  host: FanslyWireHost;
  /** The path and the query as sent (`/api/v1/post?ngsw-bypass=true` without
   *  the origin). */
  pathAndQuery: string;
  /** The body's exact bytes (JSON text). */
  body: string;
}

/**
 * A write request's fingerprint (spec §5, plan PR 6): sha256 hex of the
 * version, the method, the host's class, the path with its query and the
 * sha256 of the body's bytes, one per line. Recorded on the command before
 * the send; the page's browser computes the same of the request it is asked
 * to let go and lets it go only on a match (PR 7).
 */
export function fanslyWriteFingerprint(input: FanslyWriteFingerprintInput): string {
  const bodySha256 = createHash("sha256").update(input.body, "utf8").digest("hex");
  const lines = [FANSLY_WRITE_FINGERPRINT_VERSION, input.method, input.host, input.pathAndQuery, bodySha256];
  return createHash("sha256").update(lines.join("\n"), "utf8").digest("hex");
}
