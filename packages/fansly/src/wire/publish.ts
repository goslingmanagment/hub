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
// not the site itself. Every spec here is `writeContract: "unverified"` and
// the engine sends none of them (`isFanslyWriteSendable`) until the stand's
// capture of the site's own requests (session 0.2,
// docs/plans/2026-10-23-wall-posts/fansly-publish-contract.md) confirms or
// corrects each one; the PR that does so flips it to `verified`. The answers
// are journaled whole before anything reads them (`publish_*` kinds).

/** The upload API: mediav2's base, as the site calls it (spec §5). */
export const FANSLY_UPLOAD_BASE_URL = "https://mediav2.fansly.com/api/v1";

/** The path both APIs' routes are under (`fanslyBaseUrl` and the upload
 *  API's): the start of the path a write's fingerprint covers. */
export const FANSLY_WIRE_BASE_PATH = "/api/v1";

/** The version of the fingerprint's form: a change of the form is a new
 *  version, never a silent change of what a fingerprint means. */
export const FANSLY_WRITE_FINGERPRINT_VERSION = "fansly-write.v1";

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

type PublishId =
  | "publish.upload_create"
  | "publish.upload_complete"
  | "publish.account_media"
  | "publish.account_media_bundle"
  | "publish.post"
  | "publish.story"
  | "publish.post_cancel";

export const FANSLY_PUBLISH_WIRE_SPECS: { readonly [I in PublishId]: FanslyWireSpecFor<I> } = {
  "publish.upload_create": {
    id: "publish.upload_create",
    credentials: "session",
    kind: "publish_upload_create",
    host: "upload",
    method: "POST",
    writeContract: "unverified",
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
    writeContract: "unverified",
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
    writeContract: "unverified",
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
    writeContract: "unverified",
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
    writeContract: "unverified",
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
    writeContract: "unverified",
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
    writeContract: "unverified",
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
