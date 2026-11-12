import type {
  AgentVaultAlbumQuoteResponse,
  PublicationAlbumRun,
  PublicationWire,
} from "@agency_hub_core/contracts";
import {
  findPageVaultAlbumRefs,
  getFanslyWriteFileFacts,
  getOnlyfansVaultAlbumRun,
  getOnlyfansVaultListWalk,
  getPagePublishingSettings,
  isPageVaultAlbum,
  listOnlyfansVaultLists,
  listPublicationPages,
  requestOnlyfansVaultListWalk,
  type OnlyfansVaultAlbumFile,
  type OnlyfansVaultAlbumRun,
  type OnlyfansVaultListRow,
} from "@agency_hub_core/db";

import { millsFromCreditsAt, millsToDollarsNumber } from "@agency_hub_core/shared";

import type { AppContext } from "../bootstrap.ts";
import type { ApprovedFormMedia } from "../sync/fansly/publish/derive.ts";
import { loadEffectiveConfig } from "./effective-config.ts";
import { BadRequestError } from "./errors.ts";
import {
  buildVaultAlbumFiles,
  onlyfansVaultAccountFacts,
  onlyfansVaultAlbumAdmission,
  onlyfansVaultAlbumPrice,
  onlyfansVaultExpectedOrder,
  onlyfansVaultReusable,
  vaultKeyAllows,
  vaultLinkMaxBytes,
  type VaultAlbumFileFacts,
} from "./publications-onlyfans-vault.ts";
import { onlyfansVaultSwitchesHold } from "./publications-onlyfans-vault-hold.ts";

// An OnlyFans vault album's price before «да» and its run on the card (8-docs
// 2026-11-12-of-vault-album, PR 5). Nothing here prices anything itself: the
// files, their credits, the sum, the order and the admission are the
// executor's own functions (publications-onlyfans-vault.ts), so the price an
// agent names before «да» is the price the executor keeps with the run.

/** What Hub knows of a page's albums is fresh this long; older (or never), the quote asks for a walk. */
export const VAULT_ALBUM_LISTS_FRESH_MS = 60 * 60_000;
/** Similar titles offered at most. */
export const VAULT_ALBUM_SIMILAR_MAX = 5;

/** A title's letters: case, spaces and emoji aside («SEXTING белый халат 🤍» ~ «sexting белыйхалат»). */
export function vaultAlbumTitleKey(title: string): string {
  return title.normalize("NFKC").toLowerCase().replace(/\s|\p{Extended_Pictographic}|\p{Emoji_Modifier}|‍|︎|️/gu, "");
}

/** The page's albums alike `title` but not it (the same letters), up to five, by name. */
export function similarVaultAlbums(title: string, lists: readonly OnlyfansVaultListRow[]): OnlyfansVaultListRow[] {
  const key = vaultAlbumTitleKey(title);
  if (key === "") return [];
  return lists
    .filter((list) => list.type === "custom" && list.missingSince === null && list.name !== title && vaultAlbumTitleKey(list.name) === key)
    .slice(0, VAULT_ALBUM_SIMILAR_MAX);
}

/** Dollars of `credits` at `centsPer1000`, to the cent (display only). */
export function vaultAlbumUsd(credits: number, centsPer1000: number): number {
  return millsToDollarsNumber(millsFromCreditsAt(credits, centsPer1000));
}

/**
 * The order the album will show the files in, by file position, top first —
 * the executor's own expected order for the files as if every one to upload
 * went up; null when that is the folder's (files too big to go are left out:
 * added by hand later, they land on top).
 */
export function vaultAlbumQuoteOrder(files: readonly OnlyfansVaultAlbumFile[]): number[] | null {
  const asIfUploaded = files.map((file): OnlyfansVaultAlbumFile => (file.state !== "pending"
    ? file
    : file.mediaRef !== null
      ? { ...file, state: "reused" }
      : { ...file, state: "uploaded", mediaRef: "1" }));
  const expected = onlyfansVaultExpectedOrder(asIfUploaded).map((entry) => files.find((file) => file.item === entry.item)!.position);
  const folder = files.filter((file) => file.state !== "too_big").map((file) => file.position);
  return expected.length === folder.length && expected.every((position, index) => position === folder[index]) ? null : expected;
}

export interface VaultAlbumQuoteInput {
  title: string;
  albumRef?: string | null | undefined;
  files: ReadonlyArray<{ sha256: string; byteSize: number; name: string }>;
}

/** The price of the files as an album of `pageId` would take them: the executor's files and price. */
export async function vaultAlbumQuoteFiles(
  app: AppContext,
  pageId: number,
  files: VaultAlbumQuoteInput["files"],
  linkMaxBytes?: number,
): Promise<OnlyfansVaultAlbumFile[]> {
  const media: ApprovedFormMedia[] = files.map((file, position) => ({
    role: "media", position, source: "file", mediaRef: null, fileId: position + 1, fileSha256: file.sha256, attachment: 0, name: file.name,
  }));
  const facts = new Map<number, VaultAlbumFileFacts>(files.map((file, position) => [position + 1, { byteSize: file.byteSize, mimeType: null, originalName: file.name }]));
  return buildVaultAlbumFiles({ media }, facts, await onlyfansVaultReusable(app.db, pageId, files.map((file) => file.sha256)), { linkMaxBytes: linkMaxBytes ?? await vaultLinkMaxBytes(app) });
}

/**
 * The quote (POST /api/v1/agent/pages/:pageLabel/vault-album-quote). Sends
 * nothing to the platform. On OnlyFans, what Hub knows of the page's albums
 * older than an hour (or never walked) asks the minutely job for a walk as
 * `actorUserId`; a later call sees it. On Fansly: the album by the existing
 * lookup, a price of zero.
 */
export async function quoteVaultAlbum(app: AppContext, input: {
  page: { id: number; platform: string };
  body: VaultAlbumQuoteInput;
  actorUserId: number;
  now?: Date;
}): Promise<AgentVaultAlbumQuoteResponse> {
  const now = input.now ?? new Date();
  const { page, body } = input;
  const title = body.title.trim();
  const named = body.albumRef ?? null;
  const config = await loadEffectiveConfig(app.db, app.config);
  const settings = await getPagePublishingSettings(app.db, page.id);
  const pageEnabled = settings.enabled && settings.autostoppedAt === null;

  if (page.platform !== "onlyfans") {
    const album = await findAlbum(app, page.id, title, named);
    const hold = config.publishingEnabled !== true ? "publishing_off" : !pageEnabled ? "page_publishing_off" : null;
    return {
      platform: page.platform as AgentVaultAlbumQuoteResponse["platform"],
      album: { kind: album === null ? "new" : "found", albumRef: album, mediaCount: null, similar: [], knownAt: null, walkRequested: false },
      files: body.files.map((file, position) => ({ position, name: file.name, byteSize: file.byteSize, credits: 0, onPage: false, tooBig: false })),
      expectedOrder: null,
      credits: 0,
      usd: 0,
      account: null,
      linkMaxBytes: null,
      sending: { on: hold === null, why: hold },
    };
  }

  // What Hub knows of the page's albums, and a walk when it is old.
  const [lists, walk] = await Promise.all([listOnlyfansVaultLists(app.db, page.id), getOnlyfansVaultListWalk(app.db, page.id)]);
  const knownAt = walk?.completedAt ?? null;
  const stale = knownAt === null || now.getTime() - knownAt.getTime() > VAULT_ALBUM_LISTS_FRESH_MS;
  if (stale && walk?.requestedAt == null) await requestOnlyfansVaultListWalk(app.db, { pageId: page.id, userId: input.actorUserId });
  const custom = lists.filter((list) => list.type === "custom" && list.missingSince === null);
  const album = await findAlbum(app, page.id, title, named);
  const similar = album === null ? similarVaultAlbums(title, custom) : [];

  const linkMaxBytes = await vaultLinkMaxBytes(app);
  const files = await vaultAlbumQuoteFiles(app, page.id, body.files, linkMaxBytes);
  const credits = onlyfansVaultAlbumPrice(files);
  const centsPer1000 = Math.max(1, config.onlyfansCreditCentsPer1000 ?? 149);
  const account = await onlyfansVaultAccountFacts(app, config, now);
  const admission = onlyfansVaultAlbumAdmission({
    now, publishAt: now, heldBefore: null, switchesHold: onlyfansVaultSwitchesHold(config), pageEnabled,
    keyAllowsVault: await vaultKeyAllows(app), priceCredits: credits, dailyCredits: account.dailyCredits,
    spentToday: account.spentToday, runningCredits: account.runningCredits, balance: account.balance, reserve: account.reserve,
  });
  return {
    platform: "onlyfans",
    album: {
      kind: album !== null ? "found" : similar.length > 0 ? "similar" : "new",
      albumRef: album,
      mediaCount: album === null ? null : lists.find((list) => list.listRef === album)?.mediaCount ?? null,
      similar: similar.map((list) => ({ albumRef: list.listRef, title: list.name, mediaCount: list.mediaCount })),
      knownAt: knownAt?.toISOString() ?? null,
      walkRequested: stale,
    },
    files: files.map((file) => ({
      position: file.position, name: file.name, byteSize: file.bytes, credits: file.credits,
      onPage: file.state === "pending" && file.mediaRef !== null, tooBig: file.state === "too_big",
    })),
    expectedOrder: vaultAlbumQuoteOrder(files),
    credits,
    usd: vaultAlbumUsd(credits, centsPer1000),
    account: accountWire(account, centsPer1000),
    linkMaxBytes,
    sending: admission.kind === "go" ? { on: true, why: null } : { on: false, why: admission.reason },
  };
}

/** The album the draft would go into: the one named (it must be the page's), else the one with this exact title, else null. */
async function findAlbum(app: AppContext, pageId: number, title: string, named: string | null): Promise<string | null> {
  if (named !== null) {
    if (!await isPageVaultAlbum(app.db, pageId, named)) {
      throw new BadRequestError(`vault album ${named} is not an album of this page Hub knows (its album listing, or a publication of the page)`);
    }
    return named;
  }
  const found = [...new Set(await findPageVaultAlbumRefs(app.db, pageId, title))];
  if (found.length > 1) throw new BadRequestError(`the page has ${found.length} vault albums titled "${title}": rename all but one first`);
  return found[0] ?? null;
}

function accountWire(account: Awaited<ReturnType<typeof onlyfansVaultAccountFacts>>, centsPer1000: number) {
  return {
    dailyCredits: account.dailyCredits,
    spentToday: account.spentToday,
    left: Math.max(0, account.dailyCredits - account.spentToday - account.runningCredits),
    balance: account.balance,
    centsPer1000,
  };
}

// ---------------------------------------------------------------------------
// The card: `albumRun` of an OnlyFans album
// ---------------------------------------------------------------------------

/** A run's files counted by outcome, for the card. `settled`: a file still pending was not tried. */
export function albumRunWire(input: {
  step: OnlyfansVaultAlbumRun["step"] | null;
  files: readonly OnlyfansVaultAlbumFile[];
  estimateCredits: number;
  spentCredits: number;
  stopReason: string | null;
  account: PublicationAlbumRun["account"];
  linkMaxBytes: number;
}): PublicationAlbumRun {
  const count = (...states: OnlyfansVaultAlbumFile["state"][]) => input.files.filter((file) => states.includes(file.state)).length;
  const settled = input.step === "done";
  return {
    step: input.step,
    files: input.files.length,
    done: count("uploaded"),
    reused: count("reused", "in_album"),
    refused: count("failed"),
    unknown: count("unknown"),
    notTried: count("not_tried") + (settled ? count("pending") : 0),
    tooBig: count("too_big"),
    currentFile: input.files.find((file) => file.state === "uploading")?.name ?? null,
    estimateCredits: input.estimateCredits,
    spentCredits: input.spentCredits,
    stopReason: input.stopReason,
    fileList: input.files.map((file) => ({ name: file.name, bytes: file.bytes, state: file.state, credits: file.credits })),
    account: input.account,
    linkMaxBytes: input.linkMaxBytes,
  };
}

/**
 * The publications with `albumRun` filled for OnlyFans albums: the run as it
 * stands once the executor admitted it; before (or one that never started),
 * the files and price as the executor would take them now, and — for a
 * draft or an approved one — the albums' account, so the approval window
 * shows what is left of the day.
 */
export async function withOnlyfansAlbumRuns<T extends PublicationWire>(app: AppContext, publications: T[], now = new Date()): Promise<T[]> {
  const albums = publications.filter((publication) => publication.platform === "onlyfans" && publication.kind === "vault_album");
  if (albums.length === 0) return publications;
  const pages = new Map((await listPublicationPages(app.db)).map((page) => [page.label, page.id]));
  const config = await loadEffectiveConfig(app.db, app.config);
  const centsPer1000 = Math.max(1, config.onlyfansCreditCentsPer1000 ?? 149);
  const linkMaxBytes = await vaultLinkMaxBytes(app);
  let account: PublicationAlbumRun["account"] | undefined;
  const runs = new Map<number, PublicationAlbumRun>();
  for (const publication of albums) {
    const pageId = pages.get(publication.pageLabel);
    if (pageId === undefined) continue;
    const run = await getOnlyfansVaultAlbumRun(app.db, publication.id);
    const beforeOut = publication.status === "draft" || publication.status === "approved";
    if (beforeOut && account === undefined) account = accountWire(await onlyfansVaultAccountFacts(app, config, now), centsPer1000);
    if (run !== null && run.revisionId === publication.approvedRevisionId) {
      runs.set(publication.id, albumRunWire({
        step: run.step, files: run.files, estimateCredits: run.priceCredits, spentCredits: run.spentCredits,
        stopReason: run.stopReason, account: null, linkMaxBytes,
      }));
      continue;
    }
    const files = await publicationAlbumFiles(app, pageId, publication.media, linkMaxBytes);
    runs.set(publication.id, albumRunWire({
      step: null, files, estimateCredits: onlyfansVaultAlbumPrice(files), spentCredits: 0, stopReason: null,
      account: beforeOut ? account ?? null : null, linkMaxBytes,
    }));
  }
  return publications.map((publication) => (runs.has(publication.id) ? { ...publication, albumRun: runs.get(publication.id)! } : publication));
}

/** A publication's album files as the executor would take them now (its media, the files' bytes in Hub). */
async function publicationAlbumFiles(app: AppContext, pageId: number, media: PublicationWire["media"], linkMaxBytes: number): Promise<OnlyfansVaultAlbumFile[]> {
  const fileIds = media.flatMap((item) => (item.source === "file" && item.fileId !== null ? [item.fileId] : []));
  const facts = new Map((await getFanslyWriteFileFacts(app.db, fileIds)).map((file) => [file.id, file]));
  const form: ApprovedFormMedia[] = media.map((item) => ({
    role: item.role, position: item.position, source: item.source, mediaRef: item.mediaRef, fileId: item.fileId,
    fileSha256: item.fileId === null ? null : facts.get(item.fileId)?.contentSha256 ?? null, attachment: item.attachment, name: item.name,
  }));
  const shas = form.flatMap((item) => (item.fileSha256 === null ? [] : [item.fileSha256]));
  return buildVaultAlbumFiles({ media: form }, facts, await onlyfansVaultReusable(app.db, pageId, shas), { linkMaxBytes });
}
