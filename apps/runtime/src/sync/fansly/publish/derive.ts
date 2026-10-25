import type { FanslyWriteCommandRecord, FanslyWriteFileFacts, FanslyWriteStep } from "@agency_hub_core/db";
import {
  buildFanslyWireTarget,
  describeFanslyWrite,
  FANSLY_PUBLISH_FACTS_VERIFIED,
  FANSLY_WIRE_BASE_PATH,
  fanslyWriteFingerprint,
  type FanslyPublishAttachment,
  type FanslyPublishAudience,
  type FanslyPublishMedia,
  type FanslyReplyLock,
  type FanslyWireId,
  type FanslyWireParams,
} from "@agency_hub_core/fansly";

import type { RequestPlan } from "../../engine/resource.ts";
import { fanslyDispatchKindOfStep, FANSLY_WRITE_STEP_ROUTES } from "./commands.ts";

// Every Fansly write request is DERIVED, never stored as given (spec §5, plan
// PR 6): from the approved form of the publication (the frozen revision a
// person approved, `publication_revisions.form`) and the recorded results of
// the dispatch's earlier steps (the upload's id, the media, the account media,
// the bundle). Nothing a caller passes becomes a body. Each derivation checks
// what it takes against the approval — the file's bytes (its sha256), the
// price in mills, who sees it — and returns the request with its fingerprint
// (method, host, path with query, the body's sha256), which the admission
// records on the command before the send.
//
// The bodies are the site's, as the contract captured them
// (docs/plans/2026-10-23-wall-posts/fansly-publish-contract.md): one file
// becomes account media, several a bundle (the site makes one whenever a post
// has more than one file), each file with its own preview; who sees it and
// the price in the permissions; the post's walls as the site picks them.

/** A scheduled post is withdrawn no later than this before its time (spec §6, §8.2). */
export const FANSLY_WITHDRAW_LEAD_MS = 15 * 60_000;

/** A post goes into Fansly's schedule no later than this before its time: a
 *  post sent now (`scheduledFor: 0`) is not captured (the contract §10), so a
 *  post whose time is closer than this is not sent at all — never "now". */
export const FANSLY_SCHEDULE_LEAD_MS = 5 * 60_000;

/** One file of the approved form. */
export interface ApprovedFormMedia {
  role: "media" | "preview";
  position: number;
  source: "vault" | "file";
  mediaRef: string | null;
  fileId: number | null;
  fileSha256: string | null;
}

/** The approved form (`publicationApprovalForm`, v1), as a write reads it. */
export interface ApprovedForm {
  publicationId: number;
  kind: "fyp_post" | "subscriber_post" | "paid_post" | "story";
  text: string;
  publishAtMs: number;
  expiresAtMs: number | null;
  wallRefs: string[];
  tierRefs: string[];
  /** Mills (1000 = $1); a paid post's, or what others pay for a subscriber post. */
  priceMills: number | null;
  /** The walls it is pinned on (0317; absent from older forms: none). */
  pinWallRefs: string[];
  /** Who may reply, any of them (0317; absent: everyone). */
  replyLock: FanslyReplyLock[];
  /** A paid post only subscribers buy (0317; absent: anyone buys it). */
  subscribersOnly: boolean;
  media: ApprovedFormMedia[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function strings(value: unknown): string[] | null {
  return Array.isArray(value) && value.every((item) => typeof item === "string") ? value as string[] : null;
}

/** The revision's form, or null when it is not a v1 form this reads whole. */
export function parseApprovedForm(form: unknown): ApprovedForm | null {
  if (!isRecord(form) || form.v !== 1) return null;
  const kind = form.kind;
  if (kind !== "fyp_post" && kind !== "subscriber_post" && kind !== "paid_post" && kind !== "story") return null;
  const publishAtMs = typeof form.publishAt === "string" ? Date.parse(form.publishAt) : Number.NaN;
  const expiresAtMs = form.expiresAt === null ? null : typeof form.expiresAt === "string" ? Date.parse(form.expiresAt) : Number.NaN;
  const walls = strings(form.wallRefs);
  const tiers = strings(form.tierRefs);
  const price = form.priceMills === null ? null : typeof form.priceMills === "string" && /^[1-9][0-9]*$/.test(form.priceMills) ? Number(form.priceMills) : Number.NaN;
  if (!Number.isFinite(publishAtMs) || (expiresAtMs !== null && !Number.isFinite(expiresAtMs)) || walls === null || tiers === null) return null;
  if (price !== null && !Number.isSafeInteger(price)) return null;
  // The options added after v1 (0317): absent when not set.
  const pins = form.pinWallRefs === undefined ? [] : strings(form.pinWallRefs);
  const lock = form.replyLock === undefined ? [] : strings(form.replyLock);
  if (pins === null || lock === null || !lock.every((who) => who === "followers" || who === "subscribers")) return null;
  if (form.subscribersOnly !== undefined && form.subscribersOnly !== true) return null;
  if (typeof form.text !== "string" || typeof form.publicationId !== "number" || !Array.isArray(form.media)) return null;
  const media: ApprovedFormMedia[] = [];
  for (const raw of form.media) {
    if (!isRecord(raw) || (raw.role !== "media" && raw.role !== "preview") || (raw.source !== "vault" && raw.source !== "file")) return null;
    if (typeof raw.position !== "number" || !Number.isSafeInteger(raw.position)) return null;
    media.push({
      role: raw.role,
      position: raw.position,
      source: raw.source,
      mediaRef: typeof raw.mediaRef === "string" ? raw.mediaRef : null,
      fileId: typeof raw.fileId === "number" ? raw.fileId : null,
      fileSha256: typeof raw.fileSha256 === "string" ? raw.fileSha256 : null,
    });
  }
  return {
    publicationId: form.publicationId,
    kind,
    text: form.text,
    publishAtMs,
    expiresAtMs,
    wallRefs: walls,
    tierRefs: tiers,
    priceMills: price,
    pinWallRefs: pins,
    replyLock: lock as FanslyReplyLock[],
    subscribersOnly: form.subscribersOnly === true,
    media,
  };
}

/** What a write reads of its page beside the approval (the contract §3–§4). */
export interface FanslyPageFacts {
  /** The page's mandatory "Posts" wall (`mainWall`): every post is saved to
   *  it by the server; the site names it only when no other wall is chosen. */
  mainWallRefs: readonly string[];
  /** The names of the page's subscription tiers, by their ids: a post for
   *  one tier carries its name as the site does. */
  tierNames: ReadonlyMap<string, string>;
}

export type AudienceOfApproval = { ok: true; audience: FanslyPublishAudience } | { ok: false; reason: string };

/**
 * Who sees the publication's files, as the approval says (spec §5, the
 * contract §3): a FYP post everyone; a story the subscribers (the site's
 * default for a story); a subscriber post the subscribers of every tier, or
 * of each tier named (with its name), and with a price whoever else pays it;
 * a paid post whoever pays its price — or, for subscribers only, the
 * subscribers of every tier or of the tiers named who pay it.
 */
export function approvedAudience(form: ApprovedForm, page: Pick<FanslyPageFacts, "tierNames">): AudienceOfApproval {
  const refused = (reason: string): AudienceOfApproval => ({ ok: false, reason });
  const tiersOf = (): Array<{ id: string; name: string }> | null => {
    const tiers: Array<{ id: string; name: string }> = [];
    for (const id of [...new Set(form.tierRefs)].sort()) {
      const name = page.tierNames.get(id);
      if (name === undefined || name.trim() === "") return null;
      tiers.push({ id, name });
    }
    return tiers;
  };
  if (form.subscribersOnly && form.kind !== "paid_post") return refused("audience_not_in_approval");
  switch (form.kind) {
    case "fyp_post":
      return form.priceMills === null && form.tierRefs.length === 0 ? { ok: true, audience: { kind: "everyone" } } : refused("audience_not_in_approval");
    case "story":
      return form.priceMills === null && form.tierRefs.length === 0
        ? { ok: true, audience: { kind: "subscribers", tiers: [], priceMills: null } }
        : refused("audience_not_in_approval");
    case "subscriber_post": {
      const tiers = tiersOf();
      return tiers === null ? refused("tier_name_unknown") : { ok: true, audience: { kind: "subscribers", tiers, priceMills: form.priceMills } };
    }
    case "paid_post": {
      if (form.priceMills === null) return refused("price_not_in_approval");
      if (!form.subscribersOnly) {
        return form.tierRefs.length > 0 ? refused("audience_not_in_approval") : { ok: true, audience: { kind: "price", priceMills: form.priceMills, subscribers: null } };
      }
      const tiers = tiersOf();
      return tiers === null ? refused("tier_name_unknown") : { ok: true, audience: { kind: "price", priceMills: form.priceMills, subscribers: tiers } };
    }
  }
}

/** The walls a post names, as the site picks them (the contract §4): the
 *  walls chosen but the mandatory "Posts" wall — the server saves every post
 *  there itself — or, with none other chosen, that main wall. */
export function postWallIds(wallRefs: readonly string[], page: Pick<FanslyPageFacts, "mainWallRefs">): string[] | null {
  const chosen = [...new Set(wallRefs)].filter((ref) => !page.mainWallRefs.includes(ref)).sort();
  if (chosen.length > 0) return chosen;
  const main = wallRefs.find((ref) => page.mainWallRefs.includes(ref)) ?? page.mainWallRefs[0];
  return main === undefined ? null : [main];
}

function itemOf(media: Pick<ApprovedFormMedia, "role" | "position">): string {
  return `${media.role}:${media.position}`;
}

export interface WriteDeriveInput {
  command: Pick<FanslyWriteCommandRecord, "id" | "step" | "item" | "dispatchId" | "publicationId" | "createdAt">;
  dispatch: { kind: "create" | "withdraw" | "delete"; mode: string; revisionId: number };
  /** The approved form of the dispatch's revision. */
  form: ApprovedForm;
  /** The publication now: a withdraw and a delete take its post. */
  publication: { status: string; platformPostRef: string | null };
  /** The uploaded files the form names, as they are now. */
  files: ReadonlyMap<number, FanslyWriteFileFacts>;
  /** The page's walls and tiers as Hub holds them now. */
  page: FanslyPageFacts;
  /** Every command of the dispatch: the earlier steps' recorded results. */
  commands: readonly FanslyWriteCommandRecord[];
  now: Date;
  /** The page's latest read of its schedule (a withdraw's): when its request
   *  was admitted, and the posts still scheduled in it. */
  schedule?: FanslyScheduleFacts | null;
  /** An upload part's bytes as read from the file on disk (wall posts PR 8):
   *  the range `fanslyPartRange` names, and their sha256. */
  partBytes?: { fileId: number; byteOffset: number; byteLength: number; sha256: string } | null;
}

/** What a command's request is, as its admission records it: a write's
 *  method, host, path, body and fingerprint (`describeFanslyWrite`) — or, for
 *  an upload's status read (wall posts PR 8), a command too, its GET's
 *  request line with an empty body and the fingerprint of that. */
export function describeFanslyCommandRequest(spec: FanslyWireId, params: unknown): { method: string; host: string; pathAndQuery: string; body: string; fingerprint: string } {
  if (spec === "publish.upload_status") {
    const { pathname, search } = buildFanslyWireTarget(spec, params as never);
    const pathAndQuery = `${FANSLY_WIRE_BASE_PATH}${pathname}${search}`;
    return { method: "GET", host: "upload", pathAndQuery, body: "", fingerprint: fanslyWriteFingerprint({ method: "GET", host: "upload", pathAndQuery, body: "" }) };
  }
  return describeFanslyWrite(spec, params as never);
}

/** `media:0/part:3` → its file's item and the part's index (`kind` part or
 *  poll); null: not such an item. */
export function subItemOf(item: string, kind: "part" | "poll"): { base: string; index: number } | null {
  const match = new RegExp(`^((?:media|preview):[0-9]+)/${kind}:([0-9]+)$`).exec(item);
  return match === null ? null : { base: match[1]!, index: Number(match[2]) };
}

/** The bytes of one part of an upload (wall posts PR 8): its file and range —
 *  `index × partSize` up to `partSize` bytes, the last part the rest — from
 *  the approval and the create's answer. A refusal names why. */
export function fanslyPartRange(input: Pick<WriteDeriveInput, "command" | "form" | "files" | "commands">): { ok: true; fileId: number; byteOffset: number; byteLength: number } | { ok: false; reason: string } {
  try {
    const { file, partSize, index } = partOf(input);
    const byteOffset = index * partSize;
    return { ok: true, fileId: file.id, byteOffset, byteLength: Math.min(partSize, (file.byteSize as number) - byteOffset) };
  } catch (error) {
    if (error instanceof Refused) return { ok: false, reason: error.reason };
    throw error;
  }
}

/** The approved file, the create of its upload and its part of a part's
 *  command: every part of the file covered by the create's parts. */
function partOf(input: Pick<WriteDeriveInput, "command" | "form" | "files" | "commands">) {
  const sub = subItemOf(input.command.item, "part") ?? refuse("item_not_a_part");
  const { media, file } = approvedFile(input.form, input.files, sub.base);
  const created = createdUpload(input.commands, media, sub.base);
  const partSize = created.result?.partSize;
  const partCount = created.result?.partCount;
  if (typeof partSize !== "number" || typeof partCount !== "number" || partSize <= 0) refuse("upload_result_incomplete");
  if (partCount !== Math.ceil((file.byteSize as number) / partSize)) refuse("parts_do_not_cover_file");
  if (sub.index >= partCount) refuse("part_not_in_upload");
  const parts = created.result?.parts;
  const target = Array.isArray(parts) ? parts.find((part) => (part as { index?: unknown }).index === sub.index) as { host?: unknown; path?: unknown } | undefined : undefined;
  if (target === undefined || typeof target.host !== "string" || typeof target.path !== "string") refuse("part_not_in_upload");
  return { media, file, created, partSize, index: sub.index, host: target.host as string, path: target.path as string };
}

/** The approved file of an item, its bytes still the approved ones. */
function approvedFile(form: ApprovedForm, files: ReadonlyMap<number, FanslyWriteFileFacts>, item: string): { media: ApprovedFormMedia; file: FanslyWriteFileFacts } {
  const media = form.media.find((candidate) => itemOf(candidate) === item);
  if (media === undefined) refuse("item_not_in_approval");
  if (media.source !== "file" || media.fileId === null || media.fileSha256 === null) refuse("item_not_a_file");
  const file = files.get(media.fileId) ?? refuse("file_missing");
  if (file.contentSha256 !== media.fileSha256) refuse("file_changed");
  if (file.byteSize === null || file.byteSize <= 0 || file.mimeType === null) refuse("file_facts_missing");
  if (file.bytesDeletedAt !== null) refuse("file_bytes_deleted");
  return { media, file };
}

/** The answered create of an item's upload, of the approved bytes. */
function createdUpload(commands: readonly FanslyWriteCommandRecord[], media: ApprovedFormMedia, item: string): FanslyWriteCommandRecord {
  const created = answered(commands, "upload_create", item) ?? refuse("upload_not_created");
  const uploaded = (created.request as { facts?: { fileSha256?: unknown } } | null)?.facts?.fileSha256;
  if (media.fileSha256 === null || uploaded !== media.fileSha256) refuse("upload_of_other_bytes");
  return created;
}

/** A file's type as the site writes it when the create's answer gives none
 *  (the contract §2: 1 a photo, 2 a video). */
function uploadTypeOf(mimeType: string | null): number | null {
  if (mimeType?.startsWith("image/") === true) return 1;
  if (mimeType?.startsWith("video/") === true) return 2;
  return null;
}

/** What a withdrawal reads of the page's schedule (plan PR 9). */
export interface FanslyScheduleFacts {
  readAtMs: number;
  postIds: readonly string[];
}

/** What a derived request was made of, kept with it (the attempt's
 *  `request.step`, the command's `request.facts`). */
export interface WriteDerivedFacts {
  commandId: number;
  dispatchId: number;
  revisionId: number;
  step: FanslyWriteStep;
  item: string;
  /** The uploaded file's sha256 an upload was checked against. */
  fileSha256?: string;
  /** The earlier commands whose results the request is made of. */
  from: number[];
  /** The request's fingerprint (method, host, path with query, body). */
  fingerprint: string;
}

export type WriteDerivation =
  | {
    ok: true;
    request: RequestPlan;
    write: { method: string; host: string; pathAndQuery: string; body: string; fingerprint: string };
    facts: WriteDerivedFacts;
  }
  | { ok: false; reason: string };

type Built<I extends FanslyWireId> = { spec: I; params: FanslyWireParams<I>; fileSha256?: string; from: number[] };

class Refused extends Error {
  constructor(readonly reason: string) {
    super(reason);
  }
}

function refuse(reason: string): never {
  throw new Refused(reason);
}

/** The answered command of `step` for `item`, or null. */
function answered(commands: readonly FanslyWriteCommandRecord[], step: FanslyWriteStep, item = ""): FanslyWriteCommandRecord | null {
  return commands.find((command) => command.step === step && command.item === item && command.state === "answered") ?? null;
}

function resultString(command: FanslyWriteCommandRecord, key: string): string | null {
  const value = command.result?.[key];
  return typeof value === "string" && value.length > 0 ? value : null;
}

function mediaOf(form: ApprovedForm, role: "media" | "preview"): ApprovedFormMedia[] {
  return form.media.filter((media) => media.role === role).sort((a, b) => a.position - b.position);
}

/** The files of an attachment in their order, each with its own preview —
 *  the preview of the same position (the contract §3: a preview is a file's
 *  own, its media's `previewId`). A preview without its file is refused. */
function fileModels(form: ApprovedForm, commands: readonly FanslyWriteCommandRecord[], from: number[]): FanslyPublishMedia[] {
  const files = mediaOf(form, "media");
  const previews = mediaOf(form, "preview");
  if (previews.some((preview) => !files.some((file) => file.position === preview.position))) refuse("preview_without_its_file");
  return files.map((file) => {
    const preview = previews.find((candidate) => candidate.position === file.position);
    return {
      mediaId: mediaIdOf(file, commands, from) ?? refuse("media_not_ready"),
      previewId: preview === undefined ? null : mediaIdOf(preview, commands, from) ?? refuse("preview_not_ready"),
    };
  });
}

function audienceOf(input: WriteDeriveInput): FanslyPublishAudience {
  const approved = approvedAudience(input.form, input.page);
  return approved.ok ? approved.audience : refuse(approved.reason);
}

/**
 * The Fansly media id of one file of the form: a vault file's own ref, or the
 * media an upload of exactly this file (its sha256, under this dispatch)
 * became. Null: not known yet.
 */
function mediaIdOf(media: ApprovedFormMedia, commands: readonly FanslyWriteCommandRecord[], from: number[]): string | null {
  if (media.source === "vault") return media.mediaRef;
  const item = itemOf(media);
  const created = answered(commands, "upload_create", item);
  if (created === null) return null;
  // The upload must be of the approved bytes.
  const uploaded = (created.request as { facts?: { fileSha256?: unknown } } | null)?.facts?.fileSha256;
  if (media.fileSha256 === null || uploaded !== media.fileSha256) refuse("upload_of_other_bytes");
  // The media is the one a read of the upload found done (the contract §2:
  // `status 6` brings the `mediaId`; the completion answers it null).
  const done = commands.find((command) => command.step === "upload_status" && subItemOf(command.item, "poll")?.base === item
    && command.state === "answered" && command.result?.done === true && resultString(command, "mediaId") !== null);
  if (done === undefined) return null;
  from.push(created.id, done.id);
  return resultString(done, "mediaId");
}

function build(input: WriteDeriveInput): Built<FanslyWireId> {
  const { command, form, commands } = input;
  const from: number[] = [];
  if (fanslyDispatchKindOfStep(command.step) !== input.dispatch.kind) refuse("step_not_of_dispatch");
  switch (command.step) {
    case "upload_create": {
      const media = form.media.find((candidate) => itemOf(candidate) === command.item);
      if (media === undefined) refuse("item_not_in_approval");
      if (media.source !== "file" || media.fileId === null || media.fileSha256 === null) refuse("item_not_a_file");
      const file = input.files.get(media.fileId);
      if (file === undefined) refuse("file_missing");
      // The bytes are the ones the person approved.
      if (file.contentSha256 !== media.fileSha256) refuse("file_changed");
      if (file.byteSize === null || file.byteSize <= 0 || file.mimeType === null) refuse("file_facts_missing");
      if (file.bytesDeletedAt !== null) refuse("file_bytes_deleted");
      const fileName = file.originalName !== null && file.originalName.trim() !== "" ? file.originalName : file.contentSha256.slice(0, 16);
      return { spec: "publish.upload_create", params: { fileSize: file.byteSize, mimeType: file.mimeType, fileName }, fileSha256: file.contentSha256, from };
    }
    case "upload_part": {
      // One part of the approved bytes (wall posts PR 8), in order: its
      // range of the file, its storage host and path as the create named
      // them, and the sha256 of the bytes read from disk for that range.
      const part = partOf(input);
      const byteOffset = part.index * part.partSize;
      const byteLength = Math.min(part.partSize, (part.file.byteSize as number) - byteOffset);
      const bytes = input.partBytes ?? refuse("part_bytes_unread");
      if (bytes.fileId !== part.file.id || bytes.byteOffset !== byteOffset || bytes.byteLength !== byteLength) refuse("part_bytes_of_another_range");
      from.push(part.created.id);
      return {
        spec: "publish.upload_part",
        params: { uploadCommandId: part.created.id, partIndex: part.index, host: part.host, path: part.path, fileId: part.file.id, byteOffset, byteLength, partSha256: bytes.sha256 },
        fileSha256: part.file.contentSha256,
        from,
      };
    }
    case "upload_complete": {
      // The parts' ETags, each from its part's own answered command.
      const { media, file } = approvedFile(form, input.files, command.item);
      const created = createdUpload(commands, media, command.item);
      const uploadId = resultString(created, "uploadId");
      const partSize = created.result?.partSize;
      const partCount = created.result?.partCount;
      const uploadType = typeof created.result?.uploadType === "number" ? created.result.uploadType as number : uploadTypeOf(file.mimeType);
      if (uploadId === null || typeof partSize !== "number" || typeof partCount !== "number" || uploadType === null) refuse("upload_result_incomplete");
      const parts: Array<{ index: number; eTag: string }> = [];
      for (let index = 0; index < partCount; index += 1) {
        const part = answered(commands, "upload_part", `${command.item}/part:${index}`) ?? refuse("upload_parts_not_recorded");
        parts.push({ index, eTag: resultString(part, "eTag") ?? refuse("upload_parts_not_recorded") });
        from.push(part.id);
      }
      from.push(created.id);
      return { spec: "publish.upload_complete", params: { uploadId, uploadType, partSize, parts }, fileSha256: file.contentSha256, from };
    }
    case "upload_status": {
      // A read of the upload by its id: after its completion went (answered,
      // or its answer lost — the read reconciles it, the contract §2).
      const sub = subItemOf(command.item, "poll") ?? refuse("item_not_a_poll");
      const { media, file } = approvedFile(form, input.files, sub.base);
      const created = createdUpload(commands, media, sub.base);
      const completion = commands.find((candidate) => candidate.step === "upload_complete" && candidate.item === sub.base && (candidate.state === "answered" || candidate.state === "unknown"));
      if (completion === undefined) refuse("upload_not_completed");
      const uploadId = resultString(created, "uploadId") ?? refuse("upload_result_incomplete");
      from.push(created.id, completion.id);
      return { spec: "publish.upload_status", params: { uploadId }, fileSha256: file.contentSha256, from };
    }
    case "account_media": {
      // One file (the contract §3: several make a bundle instead).
      if (command.item !== "") refuse("item_not_of_step");
      const audience = audienceOf(input);
      const files = mediaOf(form, "media");
      if (files.length === 0) refuse("no_media");
      if (files.length !== 1) refuse(form.kind === "story" ? "story_not_one_file" : "several_files_are_a_bundle");
      return { spec: "publish.account_media", params: { media: fileModels(form, commands, from), audience }, from };
    }
    case "account_media_bundle": {
      // Several files of one post, for one audience (the contract §3).
      if (command.item !== "") refuse("item_not_of_step");
      if (form.kind === "story") refuse("story_not_one_file");
      const audience = audienceOf(input);
      if (mediaOf(form, "media").length < 2) refuse("bundle_of_one_file");
      return { spec: "publish.account_media_bundle", params: { media: fileModels(form, commands, from), audience }, from };
    }
    case "post": {
      if (command.item !== "") refuse("item_not_of_step");
      if (form.kind === "story") refuse("story_is_no_post");
      const files = mediaOf(form, "media");
      let attachments: FanslyPublishAttachment[] = [];
      if (files.length > 1) {
        // Several files go as one bundle (the contract §3).
        const bundle = answered(commands, "account_media_bundle") ?? refuse("bundle_missing");
        const bundleId = resultString(bundle, "bundleId") ?? refuse("bundle_incomplete");
        attachments = [{ contentId: bundleId, contentType: 2, pos: 0 }];
        from.push(bundle.id);
      } else if (files.length === 1) {
        const accountMedia = answered(commands, "account_media") ?? refuse("account_media_missing");
        const ids = accountMedia.result?.accountMediaIds;
        if (!Array.isArray(ids) || ids.length !== 1 || typeof ids[0] !== "string") refuse("account_media_incomplete");
        attachments = [{ contentId: ids[0] as string, contentType: 1, pos: 0 }];
        from.push(accountMedia.id);
      } else if (form.kind === "paid_post") {
        refuse("paid_post_without_media");
      }
      const wallIds = postWallIds(form.wallRefs, input.page) ?? refuse("walls_missing");
      // Only into Fansly's schedule, well ahead of its time: a post sent now
      // is not captured (the contract §10).
      if (input.dispatch.mode === "now" && !FANSLY_PUBLISH_FACTS_VERIFIED.immediatePost) refuse("immediate_post_unverified");
      const scheduledForMs = input.dispatch.mode === "now" ? 0 : form.publishAtMs;
      if (scheduledForMs !== 0 && scheduledForMs - input.now.getTime() < FANSLY_SCHEDULE_LEAD_MS) refuse("too_close_to_schedule");
      return {
        spec: "publish.post",
        params: {
          content: form.text,
          attachments,
          scheduledForMs,
          expiresAtMs: form.expiresAtMs ?? 0,
          wallIds,
          fyp: form.kind === "fyp_post",
          pinWallIds: form.pinWallRefs,
          replyLock: form.replyLock,
        },
        from,
      };
    }
    case "story": {
      if (command.item !== "") refuse("item_not_of_step");
      if (form.kind !== "story") refuse("not_a_story");
      const accountMedia = answered(commands, "account_media") ?? refuse("account_media_missing");
      const ids = accountMedia.result?.accountMediaIds;
      if (!Array.isArray(ids) || ids.length !== 1 || typeof ids[0] !== "string") refuse("account_media_incomplete");
      from.push(accountMedia.id);
      return { spec: "publish.story", params: { contentId: ids[0] as string, contentType: 1 }, from };
    }
    case "post_cancel": {
      if (command.item !== "") refuse("item_not_of_step");
      if (input.publication.status !== "scheduled") refuse("not_scheduled");
      const postId = input.publication.platformPostRef ?? refuse("no_platform_post");
      // Only well before its time: a cancel next to the publication could
      // meet a post that already went out (spec §8.2).
      if (form.publishAtMs - input.now.getTime() < FANSLY_WITHDRAW_LEAD_MS) refuse("too_close_to_publish");
      // And only after a fresh read of the page's schedule — asked for after
      // the withdrawal was — still shows it (spec §6, §8.2).
      const schedule = input.schedule ?? refuse("schedule_not_read");
      if (schedule.readAtMs <= command.createdAt.getTime()) refuse("schedule_not_fresh");
      if (!schedule.postIds.includes(postId)) refuse("not_in_schedule");
      return { spec: "publish.post_cancel", params: { postId }, from };
    }
    case "post_delete": {
      // The owner's deletion of a post Hub published (0305): only a post out
      // on the wall, under the id it is there with — the publication's after
      // "published" (a scheduled post that went out took a new id, the
      // contract §5: the check recorded the one it found it under). A story
      // is not deleted by this route.
      if (command.item !== "") refuse("item_not_of_step");
      if (form.kind === "story") refuse("story_is_no_post");
      if (input.publication.status !== "published") refuse("not_published");
      const postId = input.publication.platformPostRef ?? refuse("no_platform_post");
      return { spec: "publish.post_delete", params: { postId }, from };
    }
  }
}

/**
 * The request of one command, derived from the approval and the dispatch's
 * recorded results, with the checks that tie it to the approval: the route of
 * its step, the file's bytes, the price and who sees it. A refusal names why;
 * nothing is sent then.
 */
export function deriveFanslyWrite(input: WriteDeriveInput): WriteDerivation {
  if (input.form.publicationId !== input.command.publicationId) return { ok: false, reason: "approval_of_other_publication" };
  let built: Built<FanslyWireId>;
  try {
    built = build(input);
  } catch (error) {
    if (error instanceof Refused) return { ok: false, reason: error.reason };
    throw error;
  }
  if (built.spec !== FANSLY_WRITE_STEP_ROUTES[input.command.step]) return { ok: false, reason: "route_not_of_step" };
  // The price and the audience the body carries are the approval's — checked
  // on what goes, not on what was meant.
  const audience = (built.params as { audience?: FanslyPublishAudience }).audience;
  if (audience !== undefined) {
    const approved = approvedAudience(input.form, input.page);
    if (!approved.ok || JSON.stringify(audience) !== JSON.stringify(approved.audience)) return { ok: false, reason: "audience_not_approved" };
  }
  let write: ReturnType<typeof describeFanslyCommandRequest>;
  try {
    write = describeFanslyCommandRequest(built.spec, built.params);
  } catch (error) {
    // A parameter no request may carry: never sent.
    return { ok: false, reason: `body_invalid:${error instanceof Error ? error.message : String(error)}`.slice(0, 200) };
  }
  const facts: WriteDerivedFacts = {
    commandId: input.command.id,
    dispatchId: input.command.dispatchId,
    revisionId: input.dispatch.revisionId,
    step: input.command.step,
    item: input.command.item,
    ...(built.fileSha256 === undefined ? {} : { fileSha256: built.fileSha256 }),
    from: [...new Set(built.from)].sort((a, b) => a - b),
    fingerprint: write.fingerprint,
  };
  return { ok: true, request: { spec: built.spec, params: built.params, step: facts }, write, facts };
}
