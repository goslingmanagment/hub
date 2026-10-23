import { createHash } from "node:crypto";

import type {
  PublicationContentBody,
  PublicationDetail,
  PublicationFinding,
  PublicationWire,
} from "@agency_hub_core/contracts";
import {
  findPageMediaRefs,
  getPagePublishingSettings,
  getPublication,
  getPublicationFiles,
  getPublicationPageFacts,
  getPublicationRevision,
  insertPublication,
  insertPublicationRevision,
  listPagePublishingSettings,
  listPublicationPageTiers,
  listPublicationPageWalls,
  listPublications,
  listPublicationStatusEvents,
  lockPublicationPages,
  readPublicationDayVolume,
  readPublicationMediaHistory,
  setPublicationFindings,
  transitionPublication,
  updatePublicationContent,
  upsertPagePublishingSettings,
  type Database,
  type PagePublishingSettingsRecord,
  type PublicationActor,
  type PublicationContent,
  type PublicationDayVolume,
  type PublicationFileFacts,
  type PublicationMediaHistory,
  type PublicationMediaItem,
  type PublicationPageFacts,
  type PublicationRecord,
  type PublicationWallFacts,
} from "@agency_hub_core/db";
import {
  canTransitionPublication,
  millsFromInteger,
  millsToNumber,
  ONLYFANS_PAID_POSTS_ENABLED,
  PUBLICATION_PLATFORM_KINDS,
  PUBLICATION_VOLUME_USUAL_FLOOR_PER_DAY,
  PUBLICATION_VOLUME_WARNING_FACTOR,
  type PublicationStatus,
} from "@agency_hub_core/shared";

import { AppError, BadRequestError, NotFoundError } from "./errors.ts";
import { canonicalJson } from "./signed-cursor.ts";

// Publications: wall posts through Hub (docs/plans/2026-10-23-wall-posts).
// Agents and people draft, a person approves, Hub publishes (spec §2.5).
//
// Three rules this file holds:
// 1. A draft is checked on every save and again at approval (spec §8.1); a
//    blocking finding makes it unapprovable. The checks read facts in the
//    caller's transaction, so an approval sees the approvals made before it in
//    the same batch.
// 2. Approval freezes the whole publication — page, platform account, OnlyFans
//    binding generation, model, text, media (an uploaded file by its sha256),
//    price, times — into an immutable revision with a sha256 fingerprint
//    (spec §3.3). `verifyApprovedPublication` rebuilds it before any send; a
//    difference returns the publication to draft.
// 3. Approvals of one page run one at a time (an advisory lock per page), so
//    two approvals of the same file cannot both pass (spec §8.1 "Повтор").
//
// Nothing here talks to a platform.

const DAY_MS = 24 * 60 * 60 * 1000;

/** 409 with the machine code the screen and the agent branch on:
 * publication_version_conflict | publication_not_editable | publication_not_unknown | idempotency_mismatch. */
export class PublicationConflictError extends AppError {
  constructor(message: string, code: string) {
    super(message, 409, code);
  }
}

// ---------------------------------------------------------------------------
// The draft's shape (400) and its checks (findings)
// ---------------------------------------------------------------------------

/** Facts a draft is normalized against: the page, its walls and the uploaded files it names. */
export interface PublicationDraftContext {
  page: PublicationPageFacts;
  walls: readonly PublicationWallFacts[];
  files: ReadonlyMap<number, PublicationFileFacts>;
}

function mediaItems(role: "media" | "preview", input: PublicationContentBody["media"]): PublicationMediaItem[] {
  return input.map((item, position) => item.source === "vault"
    ? { role, position, source: "vault", platformMediaRef: item.mediaRef, fileId: null }
    : { role, position, source: "file", platformMediaRef: null, fileId: item.fileId });
}

function mediaKey(item: Pick<PublicationMediaItem, "source" | "platformMediaRef" | "fileId">): string {
  return item.source === "vault" ? `vault:${item.platformMediaRef}` : `file:${item.fileId}`;
}

/**
 * The body as a publication of this page, or a 400 for a shape the platform
 * cannot take. What depends on the page's data (its media, walls, tiers, the
 * price range, the history) is a finding instead, so a draft can be saved and
 * fixed later.
 */
export function normalizePublicationDraft(body: PublicationContentBody, context: PublicationDraftContext): PublicationContent {
  const { page } = context;
  const platformKinds: readonly string[] = PUBLICATION_PLATFORM_KINDS[page.platform as keyof typeof PUBLICATION_PLATFORM_KINDS] ?? [];
  if (!platformKinds.includes(body.kind)) {
    throw new BadRequestError(`${page.platform} pages cannot publish ${body.kind}`);
  }
  const publishAt = new Date(body.publishAt);
  const expiresAt = body.expiresAt === null ? null : new Date(body.expiresAt);
  if (expiresAt !== null && expiresAt.getTime() <= publishAt.getTime()) {
    throw new BadRequestError("expiresAt must be after publishAt");
  }
  const media = mediaItems("media", body.media);
  const previews = mediaItems("preview", body.previews);
  const isStory = body.kind === "story";
  const isPaid = body.kind === "paid_post";
  if (isStory && (media.length !== 1 || previews.length > 0)) {
    throw new BadRequestError("a story is exactly one file and has no previews");
  }
  if (isStory && (expiresAt !== null || body.wallRefs.length > 0 || body.tierRefs.length > 0)) {
    throw new BadRequestError("a story has no expiry, walls or tiers of its own");
  }
  if (!isPaid && (previews.length > 0 || body.priceMills !== null)) {
    throw new BadRequestError("previews and a price belong to a paid post only");
  }
  if (isPaid && (media.length === 0 || body.priceMills === null)) {
    throw new BadRequestError("a paid post needs at least one file and a price");
  }
  if (!isStory && media.length === 0 && body.text.trim() === "") {
    throw new BadRequestError("a post needs text or a file");
  }
  if (page.platform !== "fansly" && (body.wallRefs.length > 0 || body.tierRefs.length > 0)) {
    throw new BadRequestError("walls and tiers exist on Fansly only");
  }
  if (body.kind !== "subscriber_post" && body.tierRefs.length > 0) {
    throw new BadRequestError("tiers narrow a subscriber post only");
  }
  const keys = media.map(mediaKey);
  if (new Set(keys).size !== keys.length) {
    throw new BadRequestError("the same file is attached twice");
  }
  for (const item of [...media, ...previews]) {
    if (item.source === "file" && !context.files.has(item.fileId ?? 0)) {
      throw new BadRequestError(`file ${item.fileId} does not exist`);
    }
  }
  // An empty wall list on a Fansly post is the page's default wall, resolved
  // now so the approval freezes it.
  const wallRefs = page.platform === "fansly" && !isStory && body.wallRefs.length === 0
    ? context.walls.filter((wall) => wall.defaultWall).map((wall) => wall.wallRef)
    : [...body.wallRefs];
  return {
    kind: body.kind,
    text: body.text,
    publishAt,
    expiresAt,
    wallRefs: [...new Set(wallRefs)].sort(),
    tierRefs: [...new Set(body.tierRefs)].sort(),
    priceMills: body.priceMills === null ? null : millsFromInteger(body.priceMills),
    repost: body.repost,
    media: [...media, ...previews],
  };
}

/** Everything the draft checks read; pure input so the rules are testable without a database. */
export interface PublicationCheckFacts {
  now: Date;
  page: PublicationPageFacts;
  settings: PagePublishingSettingsRecord;
  files: ReadonlyMap<number, PublicationFileFacts>;
  /** Vault refs Hub collected as this page's own media. */
  pageMediaRefs: ReadonlySet<string>;
  walls: readonly PublicationWallFacts[];
  tierRefs: readonly string[];
  history: readonly PublicationMediaHistory[];
  volume: PublicationDayVolume;
}

function finding(code: PublicationFinding["code"], severity: PublicationFinding["severity"], extra: Partial<PublicationFinding> = {}): PublicationFinding {
  return { code, severity, mediaKey: null, at: null, postRef: null, publicationId: null, detail: {}, ...extra };
}

/** spec §8.1 on one publication. Blocking findings make it unapprovable. */
export function evaluatePublicationFindings(content: PublicationContent, facts: PublicationCheckFacts): PublicationFinding[] {
  const out: PublicationFinding[] = [];
  const { page, settings } = facts;
  if (content.publishAt.getTime() <= facts.now.getTime()) {
    out.push(finding("publish_time_past", "blocking", { at: content.publishAt.toISOString() }));
  }
  for (const item of content.media) {
    if (item.source === "file") {
      const file = facts.files.get(item.fileId ?? 0);
      if (file && file.modelId !== page.modelId) {
        out.push(finding("file_of_another_model", "blocking", {
          mediaKey: mediaKey(item), detail: { fileModelId: file.modelId, pageModelId: page.modelId },
        }));
      }
    } else if (!facts.pageMediaRefs.has(item.platformMediaRef ?? "")) {
      out.push(finding("media_not_on_page", "blocking", { mediaKey: mediaKey(item) }));
    }
  }
  const thresholdMs = settings.repostThresholdDays * DAY_MS;
  const publishMs = content.publishAt.getTime();
  for (const entry of facts.history) {
    const close: Array<{ at: Date; postRef: string | null; publicationId: number | null }> = [];
    if (entry.lastPostedAt && Math.abs(publishMs - entry.lastPostedAt.getTime()) < thresholdMs) {
      close.push({ at: entry.lastPostedAt, postRef: entry.lastPostRef, publicationId: null });
    }
    if (entry.nearestPublicationAt && Math.abs(publishMs - entry.nearestPublicationAt.getTime()) < thresholdMs) {
      close.push({ at: entry.nearestPublicationAt, postRef: null, publicationId: entry.nearestPublicationId });
    }
    const nearest = close.sort((a, b) => Math.abs(publishMs - a.at.getTime()) - Math.abs(publishMs - b.at.getTime()))[0];
    if (nearest) {
      out.push(finding("repost_within_threshold", content.repost ? "warning" : "blocking", {
        mediaKey: entry.key, at: nearest.at.toISOString(), postRef: nearest.postRef, publicationId: nearest.publicationId,
        detail: { thresholdDays: settings.repostThresholdDays },
      }));
    } else if (entry.lastPostedAt) {
      out.push(finding("posted_before", "info", {
        mediaKey: entry.key, at: entry.lastPostedAt.toISOString(), postRef: entry.lastPostRef,
      }));
    }
  }
  if (content.kind === "paid_post" && content.priceMills !== null) {
    if (page.platform === "onlyfans" && !ONLYFANS_PAID_POSTS_ENABLED) {
      out.push(finding("paid_post_off_on_onlyfans", "blocking"));
    }
    if (settings.paidPriceMinMills === null || settings.paidPriceMaxMills === null) {
      out.push(finding("price_range_not_set", "blocking"));
    } else if (content.priceMills < settings.paidPriceMinMills || content.priceMills > settings.paidPriceMaxMills) {
      out.push(finding("price_out_of_range", "blocking", {
        detail: {
          priceMills: millsToNumber(content.priceMills),
          minMills: millsToNumber(settings.paidPriceMinMills),
          maxMills: millsToNumber(settings.paidPriceMaxMills),
        },
      }));
    }
  }
  if (content.kind !== "story") {
    const dayCount = facts.volume.dayCount + 1;
    const usual = Math.max(PUBLICATION_VOLUME_USUAL_FLOOR_PER_DAY, facts.volume.usualPerDay);
    const day = content.publishAt.toISOString().slice(0, 10);
    if (settings.dailyLimit !== null && dayCount > settings.dailyLimit) {
      out.push(finding("daily_limit_exceeded", "blocking", { at: day, detail: { dayCount, dailyLimit: settings.dailyLimit } }));
    }
    if (dayCount >= PUBLICATION_VOLUME_WARNING_FACTOR * usual) {
      out.push(finding("volume_high", "warning", {
        at: day, detail: { dayCount, usualPerDay: Math.round(facts.volume.usualPerDay * 10) / 10 },
      }));
    }
  }
  if (page.platform === "fansly" && content.kind !== "story") {
    const walls = new Set(facts.walls.map((wall) => wall.wallRef));
    if (content.wallRefs.length === 0) {
      out.push(finding("wall_default_unknown", "blocking"));
    }
    for (const wallRef of content.wallRefs) {
      if (!walls.has(wallRef)) out.push(finding("wall_not_on_page", "blocking", { detail: { wallRef } }));
    }
    const tiers = new Set(facts.tierRefs);
    for (const tierRef of content.tierRefs) {
      if (!tiers.has(tierRef)) out.push(finding("tier_not_on_page", "blocking", { detail: { tierRef } }));
    }
  }
  return out;
}

export function isBlocked(findings: readonly unknown[]): boolean {
  return findings.some((item) => (item as { severity?: string }).severity === "blocking");
}

async function readDraftContext(db: Database, pageId: number, body: PublicationContentBody): Promise<PublicationDraftContext> {
  const page = await getPublicationPageFacts(db, pageId);
  if (!page || page.status !== "active") throw new NotFoundError("Page not found");
  const fileIds = [...body.media, ...body.previews].flatMap((item) => item.source === "file" ? [item.fileId] : []);
  const [walls, files] = await Promise.all([
    page.platform === "fansly" ? listPublicationPageWalls(db, pageId) : Promise.resolve([]),
    getPublicationFiles(db, fileIds),
  ]);
  return { page, walls, files: new Map(files.map((file) => [file.id, file])) };
}

/** Read the facts and run the checks for `content` on `page`, in the caller's transaction. */
export async function checkPublication(db: Database, input: {
  page: PublicationPageFacts;
  publicationId: number | null;
  content: PublicationContent;
  now: Date;
}): Promise<PublicationFinding[]> {
  const { page, content } = input;
  const mediaOnly = content.media.filter((item) => item.role === "media");
  const vaultRefs = content.media.flatMap((item) => item.source === "vault" && item.platformMediaRef ? [item.platformMediaRef] : []);
  const fileIds = content.media.flatMap((item) => item.source === "file" && item.fileId !== null ? [item.fileId] : []);
  const [settings, files, pageMediaRefs, walls, tierRefs, history, volume] = await Promise.all([
    getPagePublishingSettings(db, page.id),
    getPublicationFiles(db, fileIds),
    findPageMediaRefs(db, page.id, vaultRefs),
    page.platform === "fansly" ? listPublicationPageWalls(db, page.id) : Promise.resolve([]),
    page.platform === "fansly" ? listPublicationPageTiers(db, page.id) : Promise.resolve([]),
    readPublicationMediaHistory(db, {
      pageId: page.id,
      platform: page.platform,
      excludePublicationId: input.publicationId,
      publishAt: content.publishAt,
      vaultRefs: mediaOnly.flatMap((item) => item.source === "vault" && item.platformMediaRef ? [item.platformMediaRef] : []),
      fileIds: mediaOnly.flatMap((item) => item.source === "file" && item.fileId !== null ? [item.fileId] : []),
    }),
    readPublicationDayVolume(db, { pageId: page.id, excludePublicationId: input.publicationId, publishAt: content.publishAt, now: input.now }),
  ]);
  return evaluatePublicationFindings(content, {
    now: input.now,
    page,
    settings,
    files: new Map(files.map((file) => [file.id, file])),
    pageMediaRefs,
    walls,
    tierRefs,
    history,
    volume,
  });
}

// ---------------------------------------------------------------------------
// The approved form
// ---------------------------------------------------------------------------

/**
 * The canonical form of what a person approves (spec §3.3): the publication's
 * content, each uploaded file by its sha256, and the page as it is now —
 * platform account, OnlyFans account and binding generation, model. One value
 * has one byte form (canonicalJson), so the fingerprint is the approval.
 */
export function publicationApprovalForm(input: {
  publicationId: number;
  content: PublicationContent;
  page: PublicationPageFacts;
  files: ReadonlyMap<number, PublicationFileFacts>;
}): { form: Record<string, unknown>; fingerprint: string } {
  const { content, page } = input;
  const form = {
    v: 1,
    publicationId: input.publicationId,
    page: {
      id: page.id,
      platform: page.platform,
      platformAccountRef: page.platformAccountRef,
      ofapiAccountRef: page.ofapiAccountRef,
      ofapiBindingGeneration: page.ofapiBindingGeneration,
      modelId: page.modelId,
    },
    kind: content.kind,
    text: content.text,
    publishAt: content.publishAt.toISOString(),
    expiresAt: content.expiresAt?.toISOString() ?? null,
    wallRefs: [...content.wallRefs].sort(),
    tierRefs: [...content.tierRefs].sort(),
    // Mills as a decimal string: one byte form whatever the integer type.
    priceMills: content.priceMills === null ? null : content.priceMills.toString(),
    repost: content.repost,
    media: content.media.map((item) => ({
      role: item.role,
      position: item.position,
      source: item.source,
      mediaRef: item.platformMediaRef,
      fileId: item.fileId,
      fileSha256: item.fileId === null ? null : input.files.get(item.fileId)?.contentSha256 ?? null,
    })),
  };
  return { form, fingerprint: createHash("sha256").update(canonicalJson(form)).digest("hex") };
}

function contentOf(record: PublicationRecord): PublicationContent {
  return {
    kind: record.kind,
    text: record.text,
    publishAt: record.publishAt,
    expiresAt: record.expiresAt,
    wallRefs: record.wallRefs,
    tierRefs: record.tierRefs,
    priceMills: record.priceMills,
    repost: record.repost,
    media: record.media,
  };
}

async function filesOf(db: Database, content: PublicationContent) {
  const ids = content.media.flatMap((item) => item.fileId === null ? [] : [item.fileId]);
  return new Map((await getPublicationFiles(db, ids)).map((file) => [file.id, file]));
}

// ---------------------------------------------------------------------------
// Wire
// ---------------------------------------------------------------------------

export function toPublicationWire(record: PublicationRecord): PublicationWire {
  return {
    id: record.id,
    pageLabel: record.pageLabel,
    platform: record.platform as PublicationWire["platform"],
    kind: record.kind,
    status: record.status,
    version: record.version,
    text: record.text,
    publishAt: record.publishAt.toISOString(),
    expiresAt: record.expiresAt?.toISOString() ?? null,
    wallRefs: record.wallRefs,
    tierRefs: record.tierRefs,
    priceMills: record.priceMills === null ? null : millsToNumber(record.priceMills),
    repost: record.repost,
    media: record.media.map((item) => ({
      role: item.role, position: item.position, source: item.source, mediaRef: item.platformMediaRef, fileId: item.fileId,
    })),
    findings: record.findings as PublicationFinding[],
    blocked: isBlocked(record.findings),
    author: { kind: record.authorKind, userId: record.authorUserId, agentKeyId: record.authorAgentKeyId },
    approvedRevisionId: record.approvedRevisionId,
    platformPostRef: record.platformPostRef,
    statusReason: record.statusReason,
    previousPublicationId: record.previousPublicationId,
    createdAt: record.createdAt.toISOString(),
    updatedAt: record.updatedAt.toISOString(),
    statusChangedAt: record.statusChangedAt.toISOString(),
  };
}

async function mustGet(db: Database, id: number): Promise<PublicationRecord> {
  const record = await getPublication(db, id);
  if (!record) throw new NotFoundError("Publication not found");
  return record;
}

// ---------------------------------------------------------------------------
// Use cases
// ---------------------------------------------------------------------------

export type PublicationAuthor = { kind: "human"; userId: number } | { kind: "agent"; agentKeyId: number };

/** A new draft, checked at once. An agent's replay with the same key and body answers the first draft. */
export async function createPublicationDraft(db: Database, input: {
  pageId: number;
  body: PublicationContentBody;
  author: PublicationAuthor;
  idempotencyKey: string | null;
  now?: Date;
}): Promise<PublicationWire> {
  const now = input.now ?? new Date();
  const context = await readDraftContext(db, input.pageId, input.body);
  const content = normalizePublicationDraft(input.body, context);
  const findings = await checkPublication(db, { page: context.page, publicationId: null, content, now });
  const { created, id } = await insertPublication(db, {
    ...content,
    pageId: input.pageId,
    author: input.author,
    idempotencyKey: input.idempotencyKey,
    findings,
  });
  const record = await mustGet(db, id);
  if (!created) {
    // The same key with a different draft is a different request; answering it
    // with the first draft would be a silent substitution.
    const same = record.pageId === input.pageId
      && canonicalJson(publicationApprovalForm({ publicationId: id, content: contentOf(record), page: context.page, files: context.files }).form)
        === canonicalJson(publicationApprovalForm({ publicationId: id, content, page: context.page, files: context.files }).form);
    if (!same) {
      throw new PublicationConflictError("idempotencyKey was used for a different draft", "idempotency_mismatch");
    }
  }
  return toPublicationWire(record);
}

/**
 * Edit a draft or an approved publication. An approved one returns to draft
 * (spec §3.3) and has to be approved again. `agentKeyId` limits an agent to the
 * drafts it wrote.
 */
export async function updatePublicationDraft(db: Database, input: {
  id: number;
  version: number;
  body: PublicationContentBody;
  actor: PublicationActor;
  onlyAuthorAgentKeyId?: number;
  allowedPageIds?: readonly number[];
  now?: Date;
}): Promise<PublicationWire> {
  const now = input.now ?? new Date();
  const current = await mustGet(db, input.id);
  if (input.allowedPageIds && !input.allowedPageIds.includes(current.pageId)) throw new NotFoundError("Publication not found");
  if (input.onlyAuthorAgentKeyId !== undefined && current.authorAgentKeyId !== input.onlyAuthorAgentKeyId) {
    throw new PublicationConflictError("an agent edits only the drafts it wrote", "publication_not_editable");
  }
  if (current.status !== "draft" && current.status !== "approved") {
    throw new PublicationConflictError(`a ${current.status} publication cannot be edited`, "publication_not_editable");
  }
  if (current.status === "approved" && !canTransitionPublication("approved", "draft", input.actor.kind)) {
    throw new PublicationConflictError("this actor cannot return an approved publication to draft", "publication_not_editable");
  }
  const context = await readDraftContext(db, current.pageId, input.body);
  const content = normalizePublicationDraft(input.body, context);
  const findings = await checkPublication(db, { page: context.page, publicationId: current.id, content, now });
  const updated = await updatePublicationContent(db, {
    id: current.id, expectedVersion: input.version, content, findings, actor: input.actor,
  });
  if (!updated) {
    const latest = await mustGet(db, input.id);
    if (latest.status !== "draft" && latest.status !== "approved") {
      throw new PublicationConflictError(`a ${latest.status} publication cannot be edited`, "publication_not_editable");
    }
    throw new PublicationConflictError(`publication is at version ${latest.version}`, "publication_version_conflict");
  }
  return toPublicationWire(await mustGet(db, input.id));
}

export interface PublicationApproveResult {
  id: number;
  outcome: "approved" | "refused";
  reason: string | null;
  publication: PublicationWire | null;
}

/**
 * Approve drafts in the given order, all in one transaction with every page
 * involved locked (spec §8.1): each is checked again against the publications
 * approved before it — in earlier batches or earlier in this one — and refused
 * on a blocking finding, a newer version than the person saw, or a status that
 * is not a draft. A refusal does not undo the others.
 */
export async function approvePublications(db: Database, input: {
  items: ReadonlyArray<{ id: number; version: number }>;
  userId: number;
  now?: Date;
}): Promise<PublicationApproveResult[]> {
  const now = input.now ?? new Date();
  return db.transaction(async (rawTx) => {
    const tx = rawTx as unknown as Database;
    const heads = await listPublicationHeads(tx, input.items.map((item) => item.id));
    await lockPublicationPages(tx, [...heads.values()]);
    const results: PublicationApproveResult[] = [];
    for (const item of input.items) {
      const record = await getPublication(tx, item.id, { forUpdate: true });
      if (!record) {
        results.push({ id: item.id, outcome: "refused", reason: "not_found", publication: null });
        continue;
      }
      if (record.status !== "draft") {
        results.push({ id: item.id, outcome: "refused", reason: `status_${record.status}`, publication: toPublicationWire(record) });
        continue;
      }
      if (record.version !== item.version) {
        results.push({ id: item.id, outcome: "refused", reason: "version_conflict", publication: toPublicationWire(record) });
        continue;
      }
      const page = await getPublicationPageFacts(tx, record.pageId);
      if (!page || page.status !== "active") {
        results.push({ id: item.id, outcome: "refused", reason: "page_inactive", publication: toPublicationWire(record) });
        continue;
      }
      const content = contentOf(record);
      const findings = await checkPublication(tx, { page, publicationId: record.id, content, now });
      if (isBlocked(findings)) {
        await setPublicationFindings(tx, record.id, findings);
        results.push({ id: item.id, outcome: "refused", reason: "blocking_findings", publication: toPublicationWire({ ...record, findings }) });
        continue;
      }
      const files = await filesOf(tx, content);
      const { form, fingerprint } = publicationApprovalForm({ publicationId: record.id, content, page, files });
      const revisionId = await insertPublicationRevision(tx, {
        publicationId: record.id,
        fingerprint,
        form,
        pageId: page.id,
        platformAccountRef: page.platformAccountRef,
        ofapiAccountRef: page.ofapiAccountRef,
        ofapiBindingGeneration: page.ofapiBindingGeneration,
        modelId: page.modelId,
        approvedByUserId: input.userId,
      });
      await transitionPublication(tx, {
        id: record.id, from: "draft", to: "approved", actor: { kind: "human", userId: input.userId },
        approvedRevisionId: revisionId, findings,
      });
      results.push({ id: item.id, outcome: "approved", reason: null, publication: toPublicationWire(await mustGet(tx, record.id)) });
    }
    return results;
  });
}

async function listPublicationHeads(db: Database, ids: readonly number[]): Promise<Map<number, number>> {
  const out = new Map<number, number>();
  for (const id of new Set(ids)) {
    const record = await getPublication(db, id);
    if (record) out.set(id, record.pageId);
  }
  return out;
}

/** Cancel before Hub sends it: a draft or an approved publication. */
export async function cancelPublication(db: Database, input: { id: number; userId: number }): Promise<PublicationWire> {
  const record = await mustGet(db, input.id);
  if (!canTransitionPublication(record.status, "cancelled", "human")) {
    throw new PublicationConflictError(`a ${record.status} publication cannot be cancelled`, "publication_not_editable");
  }
  const moved = await transitionPublication(db, {
    id: record.id, from: record.status, to: "cancelled", actor: { kind: "human", userId: input.userId }, reason: "cancelled",
  });
  if (!moved) throw new PublicationConflictError("the publication changed; reload it", "publication_version_conflict");
  return toPublicationWire(await mustGet(db, input.id));
}

/**
 * The person's answer to "unknown" (spec §8.2). "It went out" claims the
 * platform post. "It did not" closes it as not_published and drafts a new
 * publication linked to it; the new one is approved again like any draft.
 */
export async function resolveUnknownPublication(db: Database, input: {
  id: number;
  userId: number;
  answer: { outcome: "went_out"; state: "scheduled" | "published"; platformPostRef: string } | { outcome: "did_not_go_out" };
}): Promise<{ publication: PublicationWire; replacement: PublicationWire | null }> {
  return db.transaction(async (rawTx) => {
    const tx = rawTx as unknown as Database;
    const record = await getPublication(tx, input.id, { forUpdate: true });
    if (!record) throw new NotFoundError("Publication not found");
    if (record.status !== "unknown") {
      throw new PublicationConflictError(`the publication is ${record.status}, not unknown`, "publication_not_unknown");
    }
    const actor = { kind: "human" as const, userId: input.userId };
    if (input.answer.outcome === "went_out") {
      await transitionPublication(tx, {
        id: record.id, from: "unknown", to: input.answer.state, actor,
        reason: "answered_went_out", platformPostRef: input.answer.platformPostRef,
      });
      return { publication: toPublicationWire(await mustGet(tx, record.id)), replacement: null };
    }
    await transitionPublication(tx, { id: record.id, from: "unknown", to: "not_published", actor, reason: "answered_did_not_go_out" });
    const { id } = await insertPublication(tx, {
      ...contentOf(record),
      pageId: record.pageId,
      author: { kind: "human", userId: input.userId },
      idempotencyKey: null,
      findings: record.findings,
      previousPublicationId: record.id,
    });
    return {
      publication: toPublicationWire(await mustGet(tx, record.id)),
      replacement: toPublicationWire(await mustGet(tx, id)),
    };
  });
}

/** One publication with its findings re-checked (drafts only), its journal and its approval. */
export async function getPublicationDetail(db: Database, id: number, options: { allowedPageIds?: readonly number[]; now?: Date } = {}): Promise<PublicationDetail> {
  let record = await mustGet(db, id);
  if (options.allowedPageIds && !options.allowedPageIds.includes(record.pageId)) throw new NotFoundError("Publication not found");
  if (record.status === "draft") {
    const page = await getPublicationPageFacts(db, record.pageId);
    if (page) {
      const findings = await checkPublication(db, { page, publicationId: record.id, content: contentOf(record), now: options.now ?? new Date() });
      await setPublicationFindings(db, record.id, findings);
      record = { ...record, findings };
    }
  }
  const [events, revision] = await Promise.all([
    listPublicationStatusEvents(db, record.id),
    record.approvedRevisionId === null ? Promise.resolve(null) : getPublicationRevision(db, record.approvedRevisionId),
  ]);
  return {
    ...toPublicationWire(record),
    events: events.map((event) => ({
      fromStatus: event.fromStatus,
      toStatus: event.toStatus,
      actorKind: event.actorKind,
      actorUserId: event.actorUserId,
      actorAgentKeyId: event.actorAgentKeyId,
      reason: event.reason,
      at: event.at.toISOString(),
    })),
    revision: revision === null ? null : {
      id: revision.id,
      fingerprint: revision.fingerprint,
      approvedByUserId: revision.approvedByUserId,
      approvedAt: revision.approvedAt.toISOString(),
    },
  };
}

export async function listPublicationsWire(db: Database, filter: {
  pageIds: readonly number[] | null;
  status?: PublicationStatus | undefined;
  from?: string | undefined;
  to?: string | undefined;
  limit: number;
}): Promise<PublicationWire[]> {
  const records = await listPublications(db, {
    pageIds: filter.pageIds,
    statuses: filter.status ? [filter.status] : null,
    from: filter.from ? new Date(filter.from) : null,
    to: filter.to ? new Date(filter.to) : null,
    limit: filter.limit,
  });
  return records.map(toPublicationWire);
}

// ---------------------------------------------------------------------------
// Before a send
// ---------------------------------------------------------------------------

export type PublicationApprovalCheck =
  | { ok: true; record: PublicationRecord; fingerprint: string }
  | { ok: false; reason: "not_approved" | "account_changed" | "content_changed" };

/**
 * Every sender calls this right before it acts on an approved publication
 * (spec §3.3): the publication, the page's account, binding generation and
 * model, and the uploaded files' bytes must still be exactly what the person
 * approved. Anything else returns the publication to draft, by Hub, with the
 * reason — a person approves it again.
 */
export async function verifyApprovedPublication(db: Database, id: number): Promise<PublicationApprovalCheck> {
  const record = await getPublication(db, id);
  if (!record || record.status !== "approved" || record.approvedRevisionId === null) return { ok: false, reason: "not_approved" };
  const [revision, page] = await Promise.all([
    getPublicationRevision(db, record.approvedRevisionId),
    getPublicationPageFacts(db, record.pageId),
  ]);
  if (!revision || !page) return { ok: false, reason: "not_approved" };
  const content = contentOf(record);
  const { fingerprint } = publicationApprovalForm({ publicationId: record.id, content, page, files: await filesOf(db, content) });
  if (fingerprint === revision.fingerprint) return { ok: true, record, fingerprint };
  const accountChanged = page.id !== revision.pageId
    || page.platformAccountRef !== revision.platformAccountRef
    || page.ofapiAccountRef !== revision.ofapiAccountRef
    || page.ofapiBindingGeneration !== revision.ofapiBindingGeneration
    || page.modelId !== revision.modelId
    || page.status !== "active";
  const reason = accountChanged ? "account_changed" : "content_changed";
  await transitionPublication(db, {
    id: record.id, from: "approved", to: "draft", actor: { kind: "hub" }, reason, clearApproval: true,
  });
  return { ok: false, reason };
}

// ---------------------------------------------------------------------------
// Settings
// ---------------------------------------------------------------------------

export function toPublicationSettingsWire(page: { label: string; platform: string }, settings: PagePublishingSettingsRecord) {
  return {
    pageLabel: page.label,
    platform: page.platform as PublicationWire["platform"],
    enabled: settings.enabled,
    autostopReason: settings.autostopReason,
    autostoppedAt: settings.autostoppedAt?.toISOString() ?? null,
    paidPriceMinMills: settings.paidPriceMinMills === null ? null : millsToNumber(settings.paidPriceMinMills),
    paidPriceMaxMills: settings.paidPriceMaxMills === null ? null : millsToNumber(settings.paidPriceMaxMills),
    repostThresholdDays: settings.repostThresholdDays,
    dailyLimit: settings.dailyLimit,
    updatedAt: settings.updatedAt?.toISOString() ?? null,
  };
}

export async function listPublicationSettings(db: Database, pages: ReadonlyArray<{ id: number; label: string; platform: string }>) {
  const settings = await listPagePublishingSettings(db, pages.map((page) => page.id));
  return pages.map((page, index) => toPublicationSettingsWire(page, settings[index] as PagePublishingSettingsRecord));
}

export async function updatePublicationSettings(db: Database, input: {
  page: { id: number; label: string; platform: string };
  body: { enabled: boolean; paidPriceMinMills: number | null; paidPriceMaxMills: number | null; repostThresholdDays: number; dailyLimit: number | null };
  userId: number;
}) {
  const settings = await upsertPagePublishingSettings(db, {
    pageId: input.page.id,
    enabled: input.body.enabled,
    paidPriceMinMills: input.body.paidPriceMinMills === null ? null : millsFromInteger(input.body.paidPriceMinMills),
    paidPriceMaxMills: input.body.paidPriceMaxMills === null ? null : millsFromInteger(input.body.paidPriceMaxMills),
    repostThresholdDays: input.body.repostThresholdDays,
    dailyLimit: input.body.dailyLimit,
    updatedByUserId: input.userId,
  });
  return toPublicationSettingsWire(input.page, settings);
}
