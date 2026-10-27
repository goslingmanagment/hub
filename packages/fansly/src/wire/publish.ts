import { createHash } from "node:crypto";

import type {
  FanslyContractResult,
  FanslyPublishAttachment,
  FanslyPublishAudience,
  FanslyPublishMedia,
  FanslyReplyLock,
  FanslyStorageReceipt,
  FanslyWireHost,
  FanslyWireMethod,
  FanslyWireParams,
  FanslyWireSpecFor,
} from "./types.ts";

// The publishing routes of a page (docs/plans/2026-10-23-wall-posts, PR 6):
// what Hub sends to put a post on a wall — an upload begun and completed on
// the upload API (mediav2), account media or a bundle of them with their
// audience and price, the post or the story, a scheduled post taken off
// the schedule, and a published post deleted from the wall. Each one is a POST with a JSON body built of parameters Hub
// decides; the engine records the request's fingerprint on its command before
// the send (`fanslyWriteFingerprint`), and the page's browser lets go only a
// request that matches it (PR 7).
//
// The paths and bodies are the site's own, as the contract captured them live
// on the test model (docs/plans/2026-10-23-wall-posts/fansly-publish-contract.md,
// 2026-10-24): §3 account media and bundles with who sees them and the price,
// §4 the post, §5 the cancel and the delete, §7 the story, §13 a vault album
// created and filled; and the page's user lists Hub keeps (2026-10-28: a list
// created, accounts added to it and removed). A route is sent only once it is
// listed in `FANSLY_VERIFIED_WRITE_ROUTES` (the one place); the upload's
// routes join it with the upload (plan PR 8). The answers are journaled whole
// before anything reads them (`publish_*` kinds).

/** A vault album's title at most, in characters (Hub's own bound; the site's
 *  form sets none we saw). */
export const FANSLY_VAULT_ALBUM_TITLE_MAX = 120;

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
 *  `withdraw` — a scheduled post taken off the schedule, or a published post
 *  deleted from the wall (what Hub put on the platform taken back: allowed
 *  while publishing is off); `create` — everything else. */
export type FanslyWritePermission = "create" | "withdraw";

export function fanslyWritePermission(id: string): FanslyWritePermission {
  return id === "publish.post_cancel" || id === "publish.post_delete" ? "withdraw" : "create";
}

/** The routes of an upload's bytes and its processing (wall posts PR 8): a
 *  part's PUT to the storage and the upload's status read on mediav2. Only a
 *  page's browser of protocol minor 9 takes them (it says `uploads` at
 *  hello); both are the `create` permission's. */
export function isFanslyUploadBytesRoute(id: string): id is FanslyUploadWireId {
  return id === "publish.upload_part" || id === "publish.upload_status";
}

/** The flags of a permission entry (the contract §3): 4 — the subscribers
 *  (of every tier, or of the tier its metadata names), 1 — whoever pays its
 *  price. Everyone: no entry at all. */
export const FANSLY_PERMISSION_FLAGS = { subscribers: 4, price: 1 } as const;

/** The flags of a reply permission entry (the contract §12.4): 2 — the
 *  model's followers, 4 — her subscribers. */
export const FANSLY_REPLY_FLAGS = { followers: 2, subscribers: 4 } as const;

/** `fypFlags` of a post (the contract §6): 0 — to the FYP when it qualifies
 *  (the default), 2 — the same when the text carries "#fyp" (the site computes
 *  it from the text; it matters when the feed is closed), 4 — "Do not promote
 *  this Post". Hub sets it on every post: the site's choice of 4 outlives the
 *  post it was made for. */
export const FANSLY_FYP_FLAGS = { fyp: 0, fypTag: 2, notFyp: 4 } as const;

/** A post's `fypFlags`, as the site computes them (the contract §6). */
export function fanslyFypFlags(fyp: boolean, content: string): number {
  if (!fyp) return FANSLY_FYP_FLAGS.notFyp;
  return /#fyp/i.test(content) ? FANSLY_FYP_FLAGS.fypTag : FANSLY_FYP_FLAGS.fyp;
}

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

/** A subscription condition's metadata: the tier's id and name, both empty for every tier. */
function tierMetadata(tier: { id: string; name: string }): string {
  return JSON.stringify({ subscriptionTierId: tier.id, subscriptionTierName: tier.name, before: 0, after: 0 });
}

/** A subscription entry: the tier in its metadata (a JSON text inside a JSON
 *  text, keyed by the flag). */
function subscribersEntry(tier: { id: string; name: string }): Record<string, unknown> {
  return { type: 0, flags: FANSLY_PERMISSION_FLAGS.subscribers, metadata: JSON.stringify({ [FANSLY_PERMISSION_FLAGS.subscribers]: tierMetadata(tier) }) };
}

/** A price entry: the price in mills in the entry and in its metadata. With a
 *  tier, the subscription is a condition of the same entry — subscribed AND
 *  the price (`flags` 5, the contract §12.3), each under its own key. */
function priceEntry(priceMills: number, subscribedTo: { id: string; name: string } | null = null): Record<string, unknown> {
  const price = positive("audience.priceMills", priceMills);
  const priceMetadata = JSON.stringify({ price });
  if (subscribedTo === null) {
    return { type: 0, flags: FANSLY_PERMISSION_FLAGS.price, metadata: JSON.stringify({ [FANSLY_PERMISSION_FLAGS.price]: priceMetadata }), price };
  }
  const metadata = JSON.stringify({ [FANSLY_PERMISSION_FLAGS.price]: priceMetadata, [FANSLY_PERMISSION_FLAGS.subscribers]: tierMetadata(subscribedTo) });
  return { type: 0, flags: FANSLY_PERMISSION_FLAGS.price | FANSLY_PERMISSION_FLAGS.subscribers, metadata, price };
}

/** The tiers of an audience, checked: each named once, with its name. */
function audienceTiers(tiers: ReadonlyArray<{ id: string; name: string }>): Array<{ id: string; name: string }> {
  const ids = tiers.map((tier, index) => nonBlank(`audience.tiers[${index}].id`, tier.id));
  if (new Set(ids).size !== ids.length) throw new RangeError("Fansly publishing parameter audience.tiers names a tier twice");
  return tiers.map((tier, index) => ({ id: tier.id, name: nonBlank(`audience.tiers[${index}].name`, tier.name) }));
}

/**
 * The permissions of an attachment for one audience, as the site writes them
 * (the contract §3). Each entry is one way in, Fansly's "OR": everyone — `[]`;
 * the subscribers of every tier — `[{flags: 4}]`, or that entry with an empty
 * tier when a price entry follows (the site's advanced form); of some tiers —
 * an entry per tier; a price — its entry, after the subscribers' when they
 * see it free; a price only subscribers pay — subscribed AND the price in one
 * entry, per tier or once with an empty tier (§12.3). The price lives here
 * only: the top-level `permissionFlags` and `price` of a media or a bundle
 * stay 0.
 */
export function fanslyPublishPermissions(audience: FanslyPublishAudience): { permissionFlags: Array<Record<string, unknown>> } {
  switch (audience.kind) {
    case "everyone":
      return { permissionFlags: [] };
    case "subscribers": {
      const tiers = audienceTiers(audience.tiers).map(subscribersEntry);
      if (audience.priceMills === null) {
        return { permissionFlags: tiers.length === 0 ? [{ flags: FANSLY_PERMISSION_FLAGS.subscribers }] : tiers };
      }
      const subscribers = tiers.length === 0 ? [subscribersEntry({ id: "", name: "" })] : tiers;
      return { permissionFlags: [...subscribers, priceEntry(audience.priceMills)] };
    }
    case "price": {
      if (audience.subscribers === null) return { permissionFlags: [priceEntry(audience.priceMills)] };
      const tiers = audienceTiers(audience.subscribers);
      const subscribedTo = tiers.length === 0 ? [{ id: "", name: "" }] : tiers;
      return { permissionFlags: subscribedTo.map((tier) => priceEntry(audience.priceMills, tier)) };
    }
  }
}

/** Who may reply to a post, as the site's permission editor writes it (the
 *  contract §12.4): an entry each, any of them — the followers (`flags` 2, no
 *  metadata) or the subscribers of every tier (`flags` 4, an empty tier id);
 *  none, everyone. */
export function fanslyReplyPermissions(lock: readonly FanslyReplyLock[]): Array<Record<string, unknown>> {
  if (!Array.isArray(lock)) throw new RangeError("Fansly publishing parameter replyLock must be a list");
  if (new Set(lock).size !== lock.length) throw new RangeError("Fansly publishing parameter replyLock names one twice");
  return lock.map((who) => {
    switch (who) {
      case "followers":
        return { type: 0, flags: FANSLY_REPLY_FLAGS.followers, price: 0, metadata: null };
      case "subscribers":
        return {
          type: 0, flags: FANSLY_REPLY_FLAGS.subscribers, price: 0,
          metadata: JSON.stringify({ [FANSLY_REPLY_FLAGS.subscribers]: JSON.stringify({ subscriptionTierId: "" }) }),
        };
      default:
        throw new RangeError(`Fansly publishing parameter replyLock takes followers or subscribers (got ${String(who)})`);
    }
  });
}

function mediaModels(values: readonly FanslyPublishMedia[]): Array<{ mediaId: string; previewId: string | null }> {
  if (!Array.isArray(values) || values.length === 0) throw new RangeError("Fansly publishing parameter media takes at least one file");
  return values.map((value, index) => ({
    mediaId: nonBlank(`media[${index}].mediaId`, value.mediaId),
    previewId: value.previewId === null ? null : nonBlank(`media[${index}].previewId`, value.previewId),
  }));
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
  | "publish.post_cancel"
  | "publish.post_delete"
  | "publish.vault_album_create"
  | "publish.vault_album_media"
  | "lists.create"
  | "lists.add"
  | "lists.remove";

/** An upload's bytes and its processing (wall posts PR 8). */
export type FanslyUploadWireId = "publish.upload_part" | "publish.upload_status";

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
export const FANSLY_VERIFIED_WRITE_ROUTES: readonly (FanslyPublishWireId | FanslyUploadWireId)[] = [
  // The contract (2026-10-24): §3, §4 (a scheduled post — an immediate one,
  // `scheduledFor: 0`, is not captured: `FANSLY_PUBLISH_FACTS_VERIFIED.
  // immediatePost`), §5, §7. The upload's routes join with the upload (plan
  // PR 8).
  "publish.account_media",
  "publish.account_media_bundle",
  "publish.post",
  "publish.story",
  "publish.post_cancel",
  // The contract §5: a published post deleted (`POST /post/<id>/delete`, no
  // body → `{success: true, response: null}`; `GET /post?ids=<id>` lists
  // nothing after it). Captured live 2026-10-24 on the test model.
  "publish.post_delete",
  // The contract §2: the upload — its create, its parts to S3, its
  // completion and the read of its processing (wall posts PR 8).
  "publish.upload_create",
  "publish.upload_part",
  "publish.upload_complete",
  "publish.upload_status",
  // The contract §13 (2026-10-26, the test model): a vault album created
  // (`{id: null, title, description: "", accountId: null, type: 0}` → the album
  // with its `id`) and media added to it in one request (`{albumId,
  // mediaIds}` → one album entry per media). Captured from the site's own
  // "Create Vault Album" and "Upload to Vault" inside an album.
  "publish.vault_album_create",
  "publish.vault_album_media",
  // The page's user lists (fan set lists, 2026-10-28, the test model's own
  // session): `POST /lists` `{label, description: ""}` (the site's create
  // modal) → `{accountId, type: 1, label, id}`; `POST /lists/items/add`
  // `{listItems: [{id, listId, type: 1}]}` → one `{id, listId, type,
  // metadata}` per account, a member already there answered again (no
  // duplicate); `POST /lists/items/remove` `{listId, listItemIds}` → the ids
  // sent, members or not. Each read back through `/lists/itemsnew`.
  "lists.create",
  "lists.add",
  "lists.remove",
];

/** Accounts one add or remove of a list's members names at most (Hub's own
 *  batch: 50 adds are ~3.3 KB of body, well inside one DATA frame). */
export const FANSLY_LIST_WRITE_BATCH_MAX = 50;

/** A list's label at most, in characters (Hub's own bound). */
export const FANSLY_LIST_LABEL_MAX = 60;

/** The site's form inputs of an upload's create, as the contract captured
 *  them (§2): Hub repeats them as they are. */
export const FANSLY_UPLOAD_FORM_INPUTS: ReadonlyArray<{ type: number; value: string }> = [
  { type: 1001, value: "false" },
  { type: 1002, value: "false" },
  { type: 1003, value: "" },
  { type: 1004, value: "" },
  { type: 1005, value: '""' },
];

/** An upload's `status` (the contract §2): 2 created and taking its parts, 3
 *  completed, 4–5 processing, 6 done — then its `mediaId` and `media` are
 *  there. */
export const FANSLY_UPLOAD_STATUS = { created: 2, completed: 3, done: 6 } as const;

/** What Hub reads out of Fansly's answers about its own posts (wall posts PR 9). */
export interface FanslyPublishFacts {
  /** `GET /post/scheduled` lists every scheduled post of the account — no
   *  page, no cap: a post absent from it is not in the schedule. */
  scheduleListWhole: boolean;
  /** A scheduled post keeps its id when it goes out: `GET /post?ids=` not
   *  showing it then says it is not on the wall. */
  scheduledPostKeepsId: boolean;
  /** `GET /mediastoriesnew?accountId=` (the contract §7) lists the account's
   *  stories: the story Hub posted, found there by its id, is out. Its absence
   *  proves nothing (the list's own shape is not captured). */
  storyListRead: boolean;
  /** A post sent now (`scheduledFor: 0`) goes out at once (the contract §10:
   *  not captured). False: a post goes only into Fansly's schedule, well
   *  ahead of its time. */
  immediatePost: boolean;
}

/**
 * What the contract proves of Fansly's answers (2026-10-24), beside the routes
 * it verifies. Each fact false keeps Hub safe — an absence proves nothing, so
 * a check ends "unknown", never "did not go out"; a withdrawal is never
 * confirmed by a read, so no replacement is ever allowed; no post goes now.
 * Not captured: whether the schedule's list is the whole schedule, whether a
 * scheduled post keeps its id when it goes out, an immediate post (§9–§10).
 */
export const FANSLY_PUBLISH_FACTS_VERIFIED: Readonly<FanslyPublishFacts> = {
  scheduleListWhole: false,
  scheduledPostKeepsId: false,
  storyListRead: true,
  immediatePost: false,
};

/** The status of an entry of `GET /post/scheduled` (the contract §5): 1 —
 *  waiting to go out, 3 — taken off the schedule. */
export const FANSLY_SCHEDULED_STATUS = { waiting: 1, cancelled: 3 } as const;

function writeContract(id: FanslyPublishWireId | FanslyUploadWireId): "verified" | "unverified" {
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
    // The contract §2: the site's form inputs as captured — the same for a
    // photo, a video, a preview and a story; their meaning is not seen. A
    // file for the vault alone goes as "Upload to Vault" sends it: no form
    // (`uploadFormData: null`, §13).
    body: (p) => ({
      fileSize: positive("fileSize", p.fileSize),
      mimeType: nonBlank("mimeType", p.mimeType),
      fileName: nonBlank("fileName", p.fileName),
      uploadFormData: p.vault === true ? null : { formInputs: FANSLY_UPLOAD_FORM_INPUTS.map((input) => ({ ...input })) },
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
      // The contract §2: the parts' ETags, `status: 0`, `waitForComplete: 0`.
      return {
        id: nonBlank("uploadId", p.uploadId),
        type: positive("uploadType", p.uploadType),
        partSize: positive("partSize", p.partSize),
        status: 0,
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
    // The contract §3: an array of one model per file (the site sends one).
    body: (p) => {
      const permissions = fanslyPublishPermissions(p.audience);
      return mediaModels(p.media).map((model) => ({ ...model, permissionFlags: 0, price: 0, whitelist: [], permissions, tags: [] }));
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
    // The contract §3: the files' models (each with its own preview), who
    // sees the bundle and its price in its permissions alone.
    body: (p) => ({
      previewId: null,
      permissionFlags: 0,
      price: 0,
      accountMediaModels: mediaModels(p.media).map((model) => ({ ...model, permissionFlags: 0, price: 0, whitelist: [] })),
      whitelist: [],
      permissions: fanslyPublishPermissions(p.audience),
      tags: [],
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
      // The contract §4, in the site's order.
      return {
        content: p.content,
        fypFlags: fanslyFypFlags(p.fyp, p.content),
        inReplyTo: null,
        quotedPostId: null,
        attachments: attachments(p.attachments),
        scheduledFor,
        expiresAt,
        postReplyPermissionFlags: fanslyReplyPermissions(p.replyLock),
        // Pinned on walls by `pinWallIds` alone; `pinned` stays 0 (§12.7).
        pinned: 0,
        wallIds: ids("wallIds", p.wallIds),
        pinWallIds: p.pinWallIds.map((id, index) => nonBlank(`pinWallIds[${index}]`, id)),
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
    // The contract §5: an empty body.
    body: () => undefined,
    parse: journalFirst,
  },
  "publish.post_delete": {
    id: "publish.post_delete",
    credentials: "session",
    kind: "publish_post_delete",
    host: "api",
    method: "POST",
    writeContract: writeContract("publish.post_delete"),
    endpointTemplate: "/post/:postId/delete",
    legacyOperation: null,
    // The id of the post on the wall: a scheduled post that went out took a
    // new one (the contract §5), the one the check found it under.
    path: (p) => `/post/${encodeURIComponent(nonBlank("postId", p.postId))}/delete`,
    query: noQuery,
    // The contract §5: no body at all.
    body: () => undefined,
    parse: journalFirst,
  },
  "publish.vault_album_create": {
    id: "publish.vault_album_create",
    credentials: "session",
    kind: "publish_vault_album_create",
    host: "api",
    method: "POST",
    writeContract: writeContract("publish.vault_album_create"),
    endpointTemplate: "/vault/albums",
    legacyOperation: null,
    path: () => "/vault/albums",
    query: noQuery,
    // The contract §13: the site's "Create Vault Album", an empty description.
    body: (p) => {
      const title = nonBlank("title", p.title);
      if (title.length > FANSLY_VAULT_ALBUM_TITLE_MAX) throw new RangeError(`Fansly publishing parameter title is over ${FANSLY_VAULT_ALBUM_TITLE_MAX} characters`);
      return { id: null, title, description: "", accountId: null, type: 0 };
    },
    parse: journalFirst,
  },
  "publish.vault_album_media": {
    id: "publish.vault_album_media",
    credentials: "session",
    kind: "publish_vault_album_media",
    host: "api",
    method: "POST",
    writeContract: writeContract("publish.vault_album_media"),
    endpointTemplate: "/vault/albums/media",
    legacyOperation: null,
    path: () => "/vault/albums/media",
    query: noQuery,
    // The contract §13: the album and its media in the order they are added —
    // the album shows the last added first; a media it holds already moves to
    // the top, never twice.
    body: (p) => {
      const mediaIds = ids("mediaIds", p.mediaIds);
      if (new Set(mediaIds).size !== mediaIds.length) throw new RangeError("Fansly publishing parameter mediaIds names a media twice");
      return { albumId: nonBlank("albumId", p.albumId), mediaIds };
    },
    parse: journalFirst,
  },
  // The page's user lists (fan set lists, 2026-10-28): the bodies the
  // site's own list screens send (`ListsApiService`).
  "lists.create": {
    id: "lists.create",
    credentials: "session",
    kind: "lists_create",
    host: "api",
    method: "POST",
    writeContract: writeContract("lists.create"),
    endpointTemplate: "/lists",
    legacyOperation: null,
    path: () => "/lists",
    query: noQuery,
    // The create modal's model: the label and an empty description.
    body: (p) => {
      const label = nonBlank("label", p.label);
      if (label !== label.trim() || label.length > FANSLY_LIST_LABEL_MAX) throw new RangeError(`Fansly publishing parameter label is padded or over ${FANSLY_LIST_LABEL_MAX} characters`);
      return { label, description: "" };
    },
    parse: journalFirst,
  },
  "lists.add": {
    id: "lists.add",
    credentials: "session",
    kind: "lists_add",
    host: "api",
    method: "POST",
    writeContract: writeContract("lists.add"),
    endpointTemplate: "/lists/items/add",
    legacyOperation: null,
    path: () => "/lists/items/add",
    query: noQuery,
    // `addToList(items)`: one item per account, `type` 1 (an account).
    body: (p) => {
      const list = listId(p.listId);
      return { listItems: listAccountIds(p.accountIds).map((id) => ({ id, listId: list, type: 1 })) };
    },
    parse: journalFirst,
  },
  "lists.remove": {
    id: "lists.remove",
    credentials: "session",
    kind: "lists_remove",
    host: "api",
    method: "POST",
    writeContract: writeContract("lists.remove"),
    endpointTemplate: "/lists/items/remove",
    legacyOperation: null,
    path: () => "/lists/items/remove",
    query: noQuery,
    // `removeFromList(listId, ids)`.
    body: (p) => ({ listId: listId(p.listId), listItemIds: listAccountIds(p.accountIds) }),
    parse: journalFirst,
  },
};

/** Fansly account ids of one list write: 1 to FANSLY_LIST_WRITE_BATCH_MAX
 *  ids of digits, none twice. */
function listAccountIds(values: readonly string[]): string[] {
  const accountIds = ids("accountIds", values);
  if (accountIds.length > FANSLY_LIST_WRITE_BATCH_MAX) throw new RangeError(`Fansly publishing parameter accountIds names over ${FANSLY_LIST_WRITE_BATCH_MAX} accounts`);
  if (accountIds.some((id) => !/^\d{1,30}$/.test(id))) throw new RangeError("Fansly publishing parameter accountIds takes account ids (digits)");
  if (new Set(accountIds).size !== accountIds.length) throw new RangeError("Fansly publishing parameter accountIds names an account twice");
  return accountIds;
}

function listId(value: string): string {
  const id = nonBlank("listId", value);
  if (!/^\d{1,30}$/.test(id)) throw new RangeError("Fansly publishing parameter listId takes a list id (digits)");
  return id;
}

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

// ── an upload's bytes and its processing (wall posts PR 8) ─────────────────
//
// As the contract captured them (§2): the create's answer is `id, type,
// partSize (20 MiB), status 2, parts[index, uploadUrl]` — each `uploadUrl` a
// signed S3 address (`fansly-upload.s3.eu-central-1.amazonaws.com/<account>/
// <upload>`, 24 h), never journaled with its signature; each part a PUT of its
// slice there, whose answer carries the part's ETag; the completion's answer
// `status 3, mediaId null`; then `GET /media/upload/{id}` on mediav2 until
// `status 6` brings the `mediaId` (a photo in 2–6 s, a 45 MB video in ~20 s).
// The same bytes uploaded again give a new upload id and the same media id. A
// part is sent once: one that failed is the upload that failed.

/** The version of a part's fingerprint (the page's browser says it at hello,
 *  protocol minor 9, and computes the same: hub-requests/write.ts). */
export const FANSLY_PART_FINGERPRINT_VERSION = "fansly-part.v1";

/** A part's bytes, at most: what one request carries through the engine's
 *  link to the page's browser and into Chrome (a larger part size in a
 *  create's answer refuses the upload — the stand shows Fansly's). */
export const FANSLY_UPLOAD_PART_MAX_BYTES = 64 * 1024 * 1024;

/** A storage host as a part may go to: HTTPS, its own name in lower case, no
 *  port or user — never one of Fansly's hosts with a role of their own (the
 *  API, the upload API, the sockets, the CDN, metrics, the site): a third
 *  party's, or a name directly under fansly.com that has no role (the page's
 *  browser decides the same, policy/operations.ts `hubPartHostOf`). */
export function isFanslyStorageHost(host: string): boolean {
  if (host !== host.toLowerCase() || !/^[a-z0-9.-]+$/.test(host) || host.startsWith(".") || host.endsWith(".") || host.includes("..")) return false;
  if (/^[0-9.]+$/.test(host) || !host.includes(".")) return false;
  // Nothing local or special-use (the page's browser refuses those too).
  const tld = host.split(".").at(-1)!;
  if (["invalid", "test", "example", "onion", "alt", "localhost", "local", "internal", "arpa"].includes(tld)) return false;
  if (host === "fansly.com") return false;
  if (host.endsWith(".fansly.com")) {
    const label = host.slice(0, -".fansly.com".length);
    if (label.includes(".")) return false;
    return !["apiv3", "wsv3", "chatws", "metrics", "mediav2", "www"].includes(label) && !/^cdn/.test(label);
  }
  return true;
}

function storageHost(value: string): string {
  if (!isFanslyStorageHost(value)) throw new RangeError(`Fansly publishing parameter host is not a storage host (${value})`);
  return value;
}

function storagePath(value: string): string {
  if (typeof value !== "string" || !value.startsWith("/") || value.includes("?") || value.includes("#") || /[\s\0]/.test(value)) {
    throw new RangeError("Fansly publishing parameter path must be a URL path without query or fragment");
  }
  return value;
}

function sha256Hex(name: string, value: string): string {
  if (typeof value !== "string" || !/^[0-9a-f]{64}$/.test(value)) throw new RangeError(`Fansly publishing parameter ${name} must be a sha256 hex`);
  return value;
}

/** A storage's receipt of a part: its status and its ETag (a 2xx without one
 *  is no receipt the upload's completion can carry). */
function storageReceipt(response: unknown): FanslyContractResult<FanslyStorageReceipt> {
  const value = response as Partial<FanslyStorageReceipt> | null;
  if (typeof value !== "object" || value === null || typeof value.status !== "number") {
    return { ok: false, violation: { field: "status", detail: "a storage's receipt carries its status" } };
  }
  const eTag = typeof value.eTag === "string" && value.eTag.trim() !== "" ? value.eTag : null;
  return { ok: true, value: { status: value.status, eTag } };
}

function noApiPath(id: string, why: string): never {
  throw new RangeError(`Fansly wire route ${id} is not an API route: ${why}`);
}

export const FANSLY_UPLOAD_WIRE_SPECS: { readonly [I in FanslyUploadWireId]: FanslyWireSpecFor<I> } = {
  "publish.upload_part": {
    id: "publish.upload_part",
    credentials: "session",
    kind: null,
    host: "storage",
    capture: "receipt",
    method: "PUT",
    writeContract: writeContract("publish.upload_part"),
    endpointTemplate: "<the part's signed storage URL>",
    legacyOperation: null,
    path: () => noApiPath("publish.upload_part", "its URL is the upload's, sealed on its create's command"),
    query: () => noApiPath("publish.upload_part", "its URL is the upload's, sealed on its create's command"),
    parse: storageReceipt,
  },
  "publish.upload_status": {
    id: "publish.upload_status",
    credentials: "session",
    kind: "publish_upload_status",
    host: "upload",
    writeContract: writeContract("publish.upload_status"),
    endpointTemplate: "/media/upload/:uploadId",
    legacyOperation: null,
    path: (p) => `/media/upload/${encodeURIComponent(nonBlank("uploadId", p.uploadId))}`,
    query: noQuery,
    parse: journalFirst,
  },
};

/**
 * A part's fingerprint (wall posts PR 8): sha256 hex of the version, the
 * method, the host's class (`storage`), the storage host, the path (never the
 * query: it carries the URL's signature) and the part's sha256, one per line.
 * Recorded on the part's command before the send; the page's browser computes
 * the same of the bytes it is handed and the URL it releases, and lets the
 * part go only on a match.
 */
export function fanslyPartFingerprint(input: { host: string; path: string; partSha256: string }): string {
  const lines = [FANSLY_PART_FINGERPRINT_VERSION, "PUT", "storage", input.host, input.path, input.partSha256];
  return createHash("sha256").update(lines.join("\n"), "utf8").digest("hex");
}

/** What a part sends, as its command records it before the send: the
 *  method, the host's class, `//<host><path>` (no query), no body text (the
 *  bytes go by reference: their sha256 is in the fingerprint) and the
 *  fingerprint. Throws on a parameter no part may carry. */
export function describeFanslyPart(params: FanslyWireParams<"publish.upload_part">): {
  method: "PUT";
  host: "storage";
  pathAndQuery: string;
  body: string;
  fingerprint: string;
} {
  positive("uploadCommandId", params.uploadCommandId);
  nonNegative("partIndex", params.partIndex);
  positive("fileId", params.fileId);
  nonNegative("byteOffset", params.byteOffset);
  const length = positive("byteLength", params.byteLength);
  if (length > FANSLY_UPLOAD_PART_MAX_BYTES) throw new RangeError(`Fansly publishing parameter byteLength is over ${FANSLY_UPLOAD_PART_MAX_BYTES}`);
  const host = storageHost(params.host);
  const path = storagePath(params.path);
  const partSha256 = sha256Hex("partSha256", params.partSha256);
  return { method: "PUT", host: "storage", pathAndQuery: `//${host}${path}`, body: "", fingerprint: fanslyPartFingerprint({ host, path, partSha256 }) };
}
