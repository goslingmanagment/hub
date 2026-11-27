import type { AgentVaultAlbumRenameResponse } from "@agency_hub_core/contracts";
import {
  getFanslyWriteCommand,
  listFanslyAlbumEditCommands,
  listPageFanslyVaultAlbums,
  type FanslyWriteCommandRecord,
  type PageFanslyVaultAlbum,
} from "@agency_hub_core/db";
import { isFanslyWriteSendable, type FanslyWireId } from "@agency_hub_core/fansly";

import type { AppContext } from "../bootstrap.ts";
import { enqueueFanslyAlbumEditCommand, FanslyWriteRefusedError } from "../sync/fansly/publish/enqueue.ts";
import { loadEffectiveConfig } from "./effective-config.ts";

// An agent renames a Fansly vault album of its page (0451): the album's own
// title, not a card's name. Albums are invisible to fans and a rename is taken
// back by another, so there is no approval; it is a platform write all the
// same:
//
// - the album only among the page's albums Hub knows (`listPageFanslyVaultAlbums`:
//   the listing's, with the title a rename Fansly confirmed since gave them,
//   and the ones Hub's publications made), by its exact title now or its id;
//   refused when the title names none or several, the new title is its title
//   already or another album's of the page;
// - ONE `album_edit` command on the page's engine, under a create's switches,
//   one attempt, never sent again: an unknown end waits for a person or a
//   listing that shows the album's title, and the same rename asked again
//   answers from it;
// - the description goes as Hub knew it (Fansly clears one the request leaves
//   out); the new title is Hub's copy once Fansly's answer names it, until a
//   later listing of the page's albums speaks.

const MINUTE_MS = 60_000;
/** A rename goes within this long of the ask, or not at all (not_sent: ask again). */
export const VAULT_ALBUM_RENAME_SEND_WINDOW_MS = 30 * MINUTE_MS;

/** What a person checks when the outcome is unknown. */
export const VAULT_ALBUM_RENAME_CHECK =
  "Hub does not know whether Fansly renamed the album: a person opens the page's vault on Fansly and looks at the"
  + " album's title. Hub never sends this rename again; its copy follows the next listing of the page's albums.";

/** The characters a platform's album title may carry at its edges (as `findPageVaultAlbumRefs` trims them). */
const TITLE_EDGES = /^[ \t\n\r\u00a0]+|[ \t\n\r\u00a0]+$/g;

export function albumTitleCore(title: string | null): string {
  return (title ?? "").replace(TITLE_EDGES, "");
}

export type VaultAlbumRenameResult = AgentVaultAlbumRenameResponse;

export interface VaultAlbumRenamePage {
  id: number;
  pageLabel: string;
}

export type AlbumAsked = { albumRef: string } | { title: string };

/** The album a rename names, among the page's albums Hub knows. */
export function findRenameAlbum(
  albums: readonly PageFanslyVaultAlbum[],
  asked: AlbumAsked,
): { ok: true; album: PageFanslyVaultAlbum } | { ok: false; reason: string; albums: PageFanslyVaultAlbum[] | null } {
  if ("albumRef" in asked) {
    const album = albums.find((candidate) => candidate.albumRef === asked.albumRef);
    return album === undefined ? { ok: false, reason: "album_not_found", albums: null } : { ok: true, album };
  }
  const title = albumTitleCore(asked.title);
  const named = albums.filter((candidate) => albumTitleCore(candidate.title) === title);
  if (named.length === 0) return { ok: false, reason: "album_not_found", albums: null };
  if (named.length > 1) return { ok: false, reason: "album_title_ambiguous", albums: named };
  return { ok: true, album: named[0]! };
}

export type RenameDecision =
  /** Hub holds this very rename: answered from it, nothing sent. */
  | { kind: "repeat"; command: FanslyWriteCommandRecord }
  | { kind: "refused"; reason: string }
  | { kind: "go" };

/**
 * Whether the album may be renamed to `title` now: its commands newest first
 * (`listFanslyAlbumEditCommands`), the page's albums for a title another
 * already holds.
 */
export function decideVaultAlbumRename(input: {
  album: PageFanslyVaultAlbum;
  albums: readonly PageFanslyVaultAlbum[];
  commands: readonly FanslyWriteCommandRecord[];
  title: string;
}): RenameDecision {
  const { album, title } = input;
  const latest = input.commands.find((command) => command.state !== "refused") ?? null;
  const sameTitle = latest?.albumEdit?.title === title;
  if (latest !== null && (latest.state === "queued" || latest.state === "sending")) {
    return sameTitle ? { kind: "repeat", command: latest } : { kind: "refused", reason: "rename_in_progress" };
  }
  // An unknown end Hub has not listed the album since: its title is not known, nothing goes beside it.
  if (latest !== null && latest.state === "unknown"
    && (album.lastObservedAt === null || (latest.settledAt ?? latest.createdAt).getTime() >= album.lastObservedAt.getTime())) {
    return sameTitle ? { kind: "repeat", command: latest } : { kind: "refused", reason: "previous_rename_unknown" };
  }
  if (albumTitleCore(album.title) === title) {
    return latest !== null && latest.state === "answered" && sameTitle ? { kind: "repeat", command: latest } : { kind: "refused", reason: "title_unchanged" };
  }
  if (input.albums.some((other) => other.albumRef !== album.albumRef && albumTitleCore(other.title) === title)) {
    return { kind: "refused", reason: "title_taken" };
  }
  return { kind: "go" };
}

function commandWire(command: FanslyWriteCommandRecord) {
  return {
    state: command.state, stateReason: command.stateReason,
    createdAt: command.createdAt.toISOString(), settledAt: command.settledAt?.toISOString() ?? null,
  };
}

/** Where a rename's command stands, as its outcome. */
export function renameStanding(command: Pick<FanslyWriteCommandRecord, "state" | "stateReason">): Pick<VaultAlbumRenameResult, "outcome" | "reason" | "check"> {
  switch (command.state) {
    case "queued":
    case "sending":
      return { outcome: "accepted", reason: `command_${command.state}`, check: null };
    case "answered":
      return { outcome: "renamed", reason: null, check: null };
    case "rejected":
      return { outcome: "rejected", reason: command.stateReason, check: null };
    case "refused":
      return { outcome: "not_sent", reason: command.stateReason, check: null };
    case "unknown":
      return { outcome: "unknown", reason: command.stateReason, check: VAULT_ALBUM_RENAME_CHECK };
  }
}

function fromCommand(page: VaultAlbumRenamePage, command: FanslyWriteCommandRecord, fromTitle: string | null, repeat: boolean): VaultAlbumRenameResult {
  return {
    pageLabel: page.pageLabel,
    albumRef: command.albumEdit?.albumRef ?? null,
    fromTitle,
    title: command.albumEdit?.title ?? "",
    ...renameStanding(command),
    repeat,
    commandId: command.id,
    command: commandWire(command),
    albums: null,
  };
}

/**
 * Rename a Fansly vault album of the page (`asked`: its exact title now or its
 * id) to `title`, already trimmed. Refused before anything is queued unless
 * the album is one Hub knows, named once, the title is new to the page's
 * albums, and every switch of a create is on.
 */
export async function renameVaultAlbum(app: AppContext, input: {
  page: VaultAlbumRenamePage;
  asked: AlbumAsked;
  title: string;
  now?: Date;
  /** Default `isFanslyWriteSendable`; integration tests pass their own. */
  isSendable?: (spec: FanslyWireId) => boolean;
}): Promise<VaultAlbumRenameResult> {
  const { page, title } = input;
  const now = input.now ?? new Date();
  const isSendable = input.isSendable ?? isFanslyWriteSendable;
  const refused = (reason: string, fields: Partial<VaultAlbumRenameResult> = {}): VaultAlbumRenameResult => ({
    pageLabel: page.pageLabel, albumRef: null, fromTitle: null, title,
    outcome: "refused", reason, repeat: false, commandId: null, command: null, albums: null, check: null,
    ...fields,
  });

  const albums = await listPageFanslyVaultAlbums(app.db, page.id);
  const found = findRenameAlbum(albums, input.asked);
  if (!found.ok) {
    return refused(found.reason, { albums: found.albums?.map((album) => ({ albumRef: album.albumRef, title: album.title })) ?? null });
  }
  const { album } = found;
  const known = { albumRef: album.albumRef, fromTitle: album.title };
  const commands = await listFanslyAlbumEditCommands(app.db, { pageId: page.id, albumRef: album.albumRef, limit: 10 });
  const decision = decideVaultAlbumRename({ album, albums, commands, title });
  if (decision.kind === "repeat") return fromCommand(page, decision.command, album.title, true);
  if (decision.kind === "refused") return refused(decision.reason, known);
  if (!isSendable("publish.vault_album_edit")) return refused("route_unverified", known);

  const config = await loadEffectiveConfig(app.db, app.config);
  let queued: FanslyWriteCommandRecord | null;
  try {
    queued = await enqueueFanslyAlbumEditCommand(app.db, {
      pageId: page.id,
      edit: { albumRef: album.albumRef, title, description: album.description ?? "" },
      notBefore: now, notAfter: new Date(now.getTime() + VAULT_ALBUM_RENAME_SEND_WINDOW_MS),
      config, now, isSendable,
    });
  } catch (error) {
    // A switch said no before anything was written (publishing off, the page stopped, no engine).
    if (error instanceof FanslyWriteRefusedError) return refused(error.reason, known);
    throw error;
  }
  if (queued === null) {
    // Another ask queued one for this album a moment ago: that one is the command.
    const [latest] = await listFanslyAlbumEditCommands(app.db, { pageId: page.id, albumRef: album.albumRef, limit: 1 });
    return latest === undefined || latest.albumEdit?.title !== title
      ? refused("rename_in_progress", known)
      : fromCommand(page, latest, album.title, true);
  }
  return fromCommand(page, queued, album.title, false);
}

/** A rename by its command's id, on this page; null: no rename of that id there. */
export async function vaultAlbumRenameById(app: AppContext, input: { page: VaultAlbumRenamePage; commandId: number }): Promise<VaultAlbumRenameResult | null> {
  const command = await getFanslyWriteCommand(app.db, input.commandId);
  if (command === null || command.pageId !== input.page.id || command.step !== "album_edit") return null;
  return fromCommand(input.page, command, null, true);
}
