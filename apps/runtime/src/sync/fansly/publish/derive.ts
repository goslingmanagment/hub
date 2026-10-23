import type { FanslyWriteCommandRecord, FanslyWriteFileFacts, FanslyWriteStep } from "@agency_hub_core/db";
import {
  describeFanslyWrite,
  type FanslyPublishAttachment,
  type FanslyPublishAudience,
  type FanslyWireId,
  type FanslyWireParams,
} from "@agency_hub_core/fansly";

import type { RequestPlan } from "../../engine/resource.ts";
import { FANSLY_WRITE_STEP_ROUTES } from "./commands.ts";

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
// The bodies are the FBuddy map's until the stand's capture (session 0.2)
// confirms them; how a paid post with several files and a preview is made
// (account media, then a bundle) is the stand's to confirm as well.

/** A scheduled post is withdrawn no later than this before its time (spec §6, §8.2). */
export const FANSLY_WITHDRAW_LEAD_MS = 15 * 60_000;

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
  /** Mills (1000 = $1); a paid post's only. */
  priceMills: number | null;
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
    media,
  };
}

/** Who sees the publication's files, as the approval says (spec §5). */
export function approvedAudience(form: ApprovedForm): FanslyPublishAudience | null {
  switch (form.kind) {
    case "fyp_post":
    case "story":
      return form.priceMills === null ? { kind: "everyone" } : null;
    case "subscriber_post":
      return form.priceMills === null ? { kind: "subscribers", tierIds: [...form.tierRefs].sort() } : null;
    case "paid_post":
      return form.priceMills === null ? null : { kind: "price", priceMills: form.priceMills };
  }
}

function itemOf(media: Pick<ApprovedFormMedia, "role" | "position">): string {
  return `${media.role}:${media.position}`;
}

export interface WriteDeriveInput {
  command: Pick<FanslyWriteCommandRecord, "id" | "step" | "item" | "dispatchId" | "publicationId">;
  dispatch: { kind: "create" | "withdraw"; mode: string; revisionId: number };
  /** The approved form of the dispatch's revision. */
  form: ApprovedForm;
  /** The publication now: a withdraw takes its post. */
  publication: { status: string; platformPostRef: string | null };
  /** The uploaded files the form names, as they are now. */
  files: ReadonlyMap<number, FanslyWriteFileFacts>;
  /** Every command of the dispatch: the earlier steps' recorded results. */
  commands: readonly FanslyWriteCommandRecord[];
  now: Date;
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

/**
 * The Fansly media id of one file of the form: a vault file's own ref, or the
 * media an upload of exactly this file (its sha256, under this dispatch)
 * became. Null: not known yet.
 */
function mediaIdOf(media: ApprovedFormMedia, commands: readonly FanslyWriteCommandRecord[], from: number[]): string | null {
  if (media.source === "vault") return media.mediaRef;
  const created = answered(commands, "upload_create", itemOf(media));
  const completed = answered(commands, "upload_complete", itemOf(media));
  if (created === null || completed === null) return null;
  // The upload must be of the approved bytes.
  const uploaded = (created.request as { facts?: { fileSha256?: unknown } } | null)?.facts?.fileSha256;
  if (media.fileSha256 === null || uploaded !== media.fileSha256) refuse("upload_of_other_bytes");
  const mediaId = resultString(completed, "mediaId");
  if (mediaId === null) return null;
  from.push(created.id, completed.id);
  return mediaId;
}

function build(input: WriteDeriveInput): Built<FanslyWireId> {
  const { command, form, commands } = input;
  const from: number[] = [];
  const create = input.dispatch.kind === "create";
  if (create !== (command.step !== "post_cancel")) refuse("step_not_of_dispatch");
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
    case "upload_complete": {
      const media = form.media.find((candidate) => itemOf(candidate) === command.item);
      if (media === undefined || media.source !== "file") refuse("item_not_a_file");
      const created = answered(commands, "upload_create", command.item);
      if (created === null) refuse("upload_not_created");
      const uploaded = (created.request as { facts?: { fileSha256?: unknown } } | null)?.facts?.fileSha256;
      if (uploaded !== media.fileSha256) refuse("upload_of_other_bytes");
      const uploadId = resultString(created, "uploadId");
      const partSize = created.result?.partSize;
      const uploadType = created.result?.uploadType;
      // The parts' ETags are recorded by the upload of the bytes (PR 8).
      const parts = created.result?.uploadedParts;
      if (uploadId === null || typeof partSize !== "number" || typeof uploadType !== "number") refuse("upload_result_incomplete");
      if (!Array.isArray(parts) || parts.length === 0) refuse("upload_parts_not_recorded");
      from.push(created.id);
      return {
        spec: "publish.upload_complete",
        params: { uploadId, uploadType, partSize, parts: parts as Array<{ index: number; eTag: string }> },
        ...(media.fileSha256 === null ? {} : { fileSha256: media.fileSha256 }),
        from,
      };
    }
    case "account_media": {
      if (command.item !== "") refuse("item_not_of_step");
      const audience = approvedAudience(form);
      if (audience === null) refuse("audience_not_in_approval");
      const files = mediaOf(form, "media");
      if (files.length === 0) refuse("no_media");
      if (form.kind === "story" && files.length !== 1) refuse("story_not_one_file");
      const mediaIds = files.map((media) => mediaIdOf(media, commands, from) ?? refuse("media_not_ready"));
      return { spec: "publish.account_media", params: { mediaIds, audience }, from };
    }
    case "account_media_bundle": {
      if (command.item !== "") refuse("item_not_of_step");
      if (form.kind !== "paid_post") refuse("bundle_not_paid");
      const audience = approvedAudience(form);
      if (audience === null || audience.kind !== "price") refuse("price_not_in_approval");
      const accountMedia = answered(commands, "account_media");
      if (accountMedia === null) refuse("account_media_missing");
      const ids = accountMedia.result?.accountMediaIds;
      if (!Array.isArray(ids) || ids.length !== mediaOf(form, "media").length || !ids.every((id) => typeof id === "string")) {
        refuse("account_media_incomplete");
      }
      from.push(accountMedia.id);
      const preview = mediaOf(form, "preview")[0];
      const previewMediaId = preview === undefined ? null : mediaIdOf(preview, commands, from) ?? refuse("preview_not_ready");
      return { spec: "publish.account_media_bundle", params: { accountMediaIds: ids as string[], audience, previewMediaId }, from };
    }
    case "post": {
      if (command.item !== "") refuse("item_not_of_step");
      if (form.kind === "story") refuse("story_is_no_post");
      const files = mediaOf(form, "media");
      const previews = mediaOf(form, "preview");
      let attachments: FanslyPublishAttachment[] = [];
      const bundle = answered(commands, "account_media_bundle");
      if (bundle !== null) {
        const bundleId = resultString(bundle, "bundleId") ?? refuse("bundle_incomplete");
        attachments = [{ contentId: bundleId, contentType: 2, pos: 0 }];
        from.push(bundle.id);
      } else if (files.length > 0) {
        // A paid post of several files or with a preview goes as one bundle.
        if (form.kind === "paid_post" && (files.length > 1 || previews.length > 0)) refuse("bundle_missing");
        const accountMedia = answered(commands, "account_media") ?? refuse("account_media_missing");
        const ids = accountMedia.result?.accountMediaIds;
        if (!Array.isArray(ids) || ids.length !== files.length || !ids.every((id) => typeof id === "string")) refuse("account_media_incomplete");
        attachments = (ids as string[]).map((contentId, pos) => ({ contentId, contentType: 1 as const, pos }));
        from.push(accountMedia.id);
      } else if (form.kind === "paid_post") {
        refuse("paid_post_without_media");
      }
      if (form.wallRefs.length === 0) refuse("walls_missing");
      const scheduledForMs = input.dispatch.mode === "now" ? 0 : form.publishAtMs;
      return {
        spec: "publish.post",
        params: {
          content: form.text,
          attachments,
          scheduledForMs,
          expiresAtMs: form.expiresAtMs ?? 0,
          wallIds: [...form.wallRefs].sort(),
          fyp: form.kind === "fyp_post",
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
      return { spec: "publish.post_cancel", params: { postId }, from };
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
    const approved = approvedAudience(input.form);
    if (approved === null || JSON.stringify(audience) !== JSON.stringify(approved)) return { ok: false, reason: "audience_not_approved" };
  }
  let write: ReturnType<typeof describeFanslyWrite>;
  try {
    write = describeFanslyWrite(built.spec, built.params as never);
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
