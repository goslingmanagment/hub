// The reason a vault album ends with, on either platform (Fansly 0347/0352,
// OnlyFans 8-docs 2026-11-12-of-vault-album): its files by their names, in
// groups an agent reports from. One builder, so both platforms read the same.

/** What a failure's reason says, short: `upload_part_unknown`, `upload_create:fansly_http_400`. */
function shortWhy(reason: string): string {
  return reason.replace(/^not_sent:/, "").split(":").slice(0, 2).join(":");
}

/** The most an album's reason says: every file of a 300-file album by its name
 *  fits (audit, 2026-11-03: the agent reports from it what did not land). */
export const VAULT_ALBUM_REASON_MAX = 20_000;

export interface VaultAlbumReasonInput {
  /** Files refused for themselves (OnlyFans/OnlyFansAPI or Fansly said no, or nothing left), with why. */
  failures: ReadonlyArray<{ item: string; why: string }>;
  /** A file's name by its item. */
  names: ReadonlyMap<string, string>;
  /** The album's files. */
  members: number;
  /** Files whose upload may have gone (an answer lost, still processing): never sent again by Hub itself. */
  unknown?: ReadonlyArray<{ item: string; why: string }>;
  /** Files over what the uploader takes: added by hand. */
  tooBig?: readonly string[];
  /** Files the uploads stopped before, and why they stopped. */
  notTried?: readonly string[];
  stopped?: string | null;
  /** Items of cards left with another name (Fansly). */
  notRenamed?: readonly string[];
  /** Items (or media ids) the album does not hold. */
  missing?: readonly string[];
  /** Items the album holds but not ready (processing or with an error). */
  notReady?: readonly string[];
  /** The first file not where the approval puts it: its place from the top (1 first) and the file due there. */
  misplaced?: { position: number; item: string } | null;
  /** Why the album was not read back. */
  unread?: string | null;
}

/** Null: nothing to say — every file is where the approval put it. */
export function vaultAlbumReason(input: VaultAlbumReasonInput): string | null {
  const name = (item: string) => input.names.get(item) ?? item;
  const named = (items: ReadonlyArray<{ item: string; why: string }>) => items.map((entry) => `${name(entry.item)}=${shortWhy(entry.why)}`).join(",");
  const parts: string[] = [];
  if (input.failures.length > 0) parts.push(`files_failed:${input.failures.length}/${input.members}:${named(input.failures)}`);
  const unknown = input.unknown ?? [];
  if (unknown.length > 0) parts.push(`files_unknown:${unknown.length}/${input.members}:${named(unknown)}`);
  const tooBig = input.tooBig ?? [];
  if (tooBig.length > 0) parts.push(`files_too_big:${tooBig.length}:${tooBig.map(name).join(",")}`);
  const notTried = input.notTried ?? [];
  if (notTried.length > 0) parts.push(`files_not_tried:${notTried.length}:${input.stopped ?? "stopped"}:${notTried.map(name).join(",")}`);
  if (input.unread != null) parts.push(`album_not_read:${input.unread}`);
  const missing = input.missing ?? [];
  if (missing.length > 0) parts.push(`files_missing:${missing.length}:${missing.map(name).join(",")}`);
  const notReady = input.notReady ?? [];
  if (notReady.length > 0) parts.push(`files_not_ready:${notReady.length}:${notReady.map(name).join(",")}`);
  if (input.misplaced != null) parts.push(`order_differs:${input.misplaced.position}:${name(input.misplaced.item)}`);
  const notRenamed = input.notRenamed ?? [];
  if (notRenamed.length > 0) parts.push(`cards_not_renamed:${notRenamed.length}:${notRenamed.map(name).join(",")}`);
  if (parts.length === 0) return null;
  const reason = parts.join(";");
  return reason.length > VAULT_ALBUM_REASON_MAX ? `${reason.slice(0, VAULT_ALBUM_REASON_MAX - 1)}…` : reason;
}
