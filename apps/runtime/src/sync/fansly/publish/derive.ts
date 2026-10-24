import type { FanslyWriteCommandRecord, FanslyWriteFileFacts, FanslyWriteStep } from "@agency_hub_core/db";
import {
  describeFanslyWrite,
  FANSLY_PUBLISH_FACTS_VERIFIED,
  type FanslyPublishAttachment,
  type FanslyPublishAudience,
  type FanslyPublishMedia,
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
 * of the one tier named (with its name); a paid post whoever pays its price.
 * Several tiers are not captured: refused.
 */
export function approvedAudience(form: ApprovedForm, page: Pick<FanslyPageFacts, "tierNames">): AudienceOfApproval {
  const refused = (reason: string): AudienceOfApproval => ({ ok: false, reason });
  switch (form.kind) {
    case "fyp_post":
      return form.priceMills === null ? { ok: true, audience: { kind: "everyone" } } : refused("audience_not_in_approval");
    case "story":
      return form.priceMills === null ? { ok: true, audience: { kind: "subscribers", tier: null } } : refused("audience_not_in_approval");
    case "subscriber_post": {
      if (form.priceMills !== null) return refused("audience_not_in_approval");
      if (form.tierRefs.length === 0) return { ok: true, audience: { kind: "subscribers", tier: null } };
      if (form.tierRefs.length > 1) return refused("several_tiers_unverified");
      const id = form.tierRefs[0]!;
      const name = page.tierNames.get(id);
      return name === undefined || name.trim() === "" ? refused("tier_name_unknown") : { ok: true, audience: { kind: "subscribers", tier: { id, name } } };
    }
    case "paid_post":
      return form.priceMills === null ? refused("price_not_in_approval") : { ok: true, audience: { kind: "price", priceMills: form.priceMills } };
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
  dispatch: { kind: "create" | "withdraw"; mode: string; revisionId: number };
  /** The approved form of the dispatch's revision. */
  form: ApprovedForm;
  /** The publication now: a withdraw takes its post. */
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
